const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.APIFOOTBALL_KEY;
const API_URL = "https://v3.football.api-sports.io";

app.use(express.json());

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

async function football(endpoint, params = {}) {
  if (!API_KEY) throw new Error("Falta configurar APIFOOTBALL_KEY en Render");

  const url = new URL(API_URL + endpoint);
  Object.entries(params).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  const response = await fetch(url, {
    headers: { "x-apisports-key": API_KEY }
  });

  if (!response.ok) {
    throw new Error("API-Football respondió con error: " + response.status);
  }

  const data = await response.json();

  if (data.errors && Object.keys(data.errors).length) {
    throw new Error(JSON.stringify(data.errors));
  }

  return data.response || [];
}

async function buscarEquipo(nombre) {
  const resultados = await football("/teams", { search: nombre });

  if (!resultados.length) {
    throw new Error("No encontré el equipo: " + nombre);
  }

  const exacto = resultados.find(
    item => item.team.name.toLowerCase() === nombre.toLowerCase()
  );

  return exacto || resultados[0];
}

async function ultimosPartidos(id) {
  const partidos = await football("/fixtures", {
    team: id,
    last: 5
  });

  return partidos.filter(p =>
    ["FT", "AET", "PEN"].includes(p.fixture.status.short)
  );
}

function calcularEstadisticas(partidos, idEquipo) {
  let golesFavor = 0;
  let golesContra = 0;
  let victorias = 0;
  let empates = 0;
  let derrotas = 0;

  partidos.forEach(p => {
    const esLocal = p.teams.home.id === idEquipo;
    const favor = esLocal ? p.goals.home : p.goals.away;
    const contra = esLocal ? p.goals.away : p.goals.home;

    if (favor === null || contra === null) return;

    golesFavor += favor;
    golesContra += contra;

    if (favor > contra) victorias++;
    else if (favor === contra) empates++;
    else derrotas++;
  });

  const total = partidos.length || 1;

  return {
    partidos: partidos.length,
    victorias,
    empates,
    derrotas,
    promedioGolesFavor: Number((golesFavor / total).toFixed(2)),
    promedioGolesContra: Number((golesContra / total).toFixed(2)),
    promedioTotalGoles: Number(((golesFavor + golesContra) / total).toFixed(2))
  };
}

function poisson(lambda, goles) {
  let factorial = 1;
  for (let i = 1; i <= goles; i++) factorial *= i;
  return Math.exp(-lambda) * Math.pow(lambda, goles) / factorial;
}

function probabilidades(local, visitante) {
  const x = Math.max(0.2, local.promedioGolesFavor * 0.65 +
    visitante.promedioGolesContra * 0.35);
  const y = Math.max(0.2, visitante.promedioGolesFavor * 0.65 +
    local.promedioGolesContra * 0.35);

  let ganaLocal = 0, empate = 0, ganaVisitante = 0;
  let ambosMarcan = 0, mas25 = 0;

  for (let i = 0; i <= 7; i++) {
    for (let j = 0; j <= 7; j++) {
      const prob = poisson(x, i) * poisson(y, j);

      if (i > j) ganaLocal += prob;
      else if (i === j) empate += prob;
      else ganaVisitante += prob;

      if (i > 0 && j > 0) ambosMarcan += prob;
      if (i + j >= 3) mas25 += prob;
    }
  }

  const porcentaje = n => Math.round(n * 100);

  return {
    local: porcentaje(ganaLocal),
    empate: porcentaje(empate),
    visitante: porcentaje(ganaVisitante),
    ambosMarcan: porcentaje(ambosMarcan),
    masDe25Goles: porcentaje(mas25),
    dobleOportunidadLocal: porcentaje(ganaLocal + empate),
    dobleOportunidadVisitante: porcentaje(ganaVisitante + empate)
  };
}

app.get("/", (req, res) => {
  res.json({ message: "URRU PREDICTIONS - Servidor funcionando" });
});

app.get("/api/live", async (req, res) => {
  try {
    const partidos = await football("/fixtures", { live: "all" });

    res.json({
      total: partidos.length,
      partidos: partidos.map(p => ({
        id: p.fixture.id,
        minuto: p.fixture.status.elapsed,
        estado: p.fixture.status.long,
        local: p.teams.home.name,
        golesLocal: p.goals.home,
        visitante: p.teams.away.name,
        golesVisitante: p.goals.away,
        liga: p.league.name
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/analyze", async (req, res) => {
  try {
    const { home, away } = req.body;

    if (!home || !away) {
      return res.status(400).json({
        error: "Escribe el nombre de los dos equipos."
      });
    }

    const [equipoLocal, equipoVisitante] = await Promise.all([
      buscarEquipo(home),
      buscarEquipo(away)
    ]);

    const [partidosLocal, partidosVisitante] = await Promise.all([
      ultimosPartidos(equipoLocal.team.id),
      ultimosPartidos(equipoVisitante.team.id)
    ]);

    if (!partidosLocal.length || !partidosVisitante.length) {
      return res.status(404).json({
        error: "No hay suficientes partidos recientes para analizar estos equipos."
      });
    }

    const estadisticasLocal = calcularEstadisticas(
      partidosLocal, equipoLocal.team.id
    );

    const estadisticasVisitante = calcularEstadisticas(
      partidosVisitante, equipoVisitante.team.id
    );

    const estimacion = probabilidades(
      estadisticasLocal, estadisticasVisitante
    );

    res.json({
      local: equipoLocal.team.name,
      visitante: equipoVisitante.team.name,
      estadisticas: {
        local: estadisticasLocal,
        visitante: estadisticasVisitante
      },
      probabilidades: estimacion,
      partidosRecientes: {
        local: partidosLocal,
        visitante: partidosVisitante
      },
      aviso: "Estimaciones estadísticas basadas en los últimos partidos disponibles. No garantizan resultados."
    });

  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log("URRU PREDICTIONS funcionando en el puerto " + PORT);
});
