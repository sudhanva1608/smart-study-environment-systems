const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(cors());
app.use(express.json());

// ─── Request Logger (debug all incoming requests) ──────────
app.use((req, res, next) => {
  const body = req.method === 'POST' ? JSON.stringify(req.body) : '';
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${body ? '← ' + body : ''}`);
  next();
});

// ─── Database Setup ───────────────────────────────────────
const db = new Database(path.join(__dirname, 'sses.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS readings (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    temperature REAL    NOT NULL,
    humidity    REAL    NOT NULL,
    light       INTEGER NOT NULL,
    air_quality INTEGER NOT NULL,
    status      TEXT    NOT NULL,
    light_label TEXT    NOT NULL,
    recorded_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS idx_recorded_at ON readings(recorded_at);
`);

const insertReading = db.prepare(`
  INSERT INTO readings (temperature, humidity, light, air_quality, status, light_label, recorded_at)
  VALUES (@temperature, @humidity, @light, @air_quality, @status, @light_label, @recorded_at)
`);

// ─── In-memory latest + rolling chart history ─────────────
let latestData = null;
const MAX_CHART = 60;
const chartHistory = {
  temperature: [], humidity: [], light: [], airQuality: [],
};

// ─── Seed from DB on startup ──────────────────────────────
(function seedFromDB() {
  // Load the last MAX_CHART readings in chronological order
  const rows = db.prepare(
    'SELECT * FROM readings ORDER BY recorded_at DESC LIMIT ?'
  ).all(MAX_CHART).reverse();

  if (!rows.length) return;

  for (const r of rows) {
    const tick = { time: fmtTime(r.recorded_at) };
    chartHistory.temperature.push({ ...tick, value: r.temperature });
    chartHistory.humidity.push({    ...tick, value: r.humidity    });
    chartHistory.light.push({       ...tick, value: r.light       });
    chartHistory.airQuality.push({  ...tick, value: r.air_quality });
  }

  // Seed latestData from the most recent row
  const last = rows[rows.length - 1];
  latestData = {
    temperature: last.temperature,
    humidity:    last.humidity,
    light:       last.light,
    airQuality:  last.air_quality,
    status:      last.status,
    lightLabel:  last.light_label,
    timestamp:   last.recorded_at,
  };

  console.log(`[Seed] Loaded ${rows.length} readings into chart history from DB.`);
  console.log(`[Seed] Latest: Temp=${latestData.temperature}°C Hum=${latestData.humidity}% Status=${latestData.status}`);
})()

// ─── Helpers ──────────────────────────────────────────────
function determineStatus({ temperature, humidity, airQuality }) {
  if (temperature >= 20 && temperature <= 28 && humidity >= 40 && humidity <= 65 && airQuality < 350)
    return 'Ideal';
  if ((temperature > 28 && temperature <= 32) || (humidity > 65 && humidity <= 75) || (airQuality >= 350 && airQuality < 500))
    return 'Moderate';
  return 'Poor';
}

function getLightLabel(value) {
  if (value < 1000) return 'Bright';
  if (value < 2500) return 'Normal';
  if (value < 3500) return 'Dim';
  return 'Dark';
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── POST /api/sensor-data  (ESP32 → Backend) ────────────
app.post('/api/sensor-data', (req, res) => {
  const { temperature, humidity, light, airQuality } = req.body;

  if ([temperature, humidity, light, airQuality].some(v => v === undefined)) {
    return res.status(400).json({ error: 'Missing sensor fields' });
  }

  const timestamp = new Date().toISOString();
  const status     = req.body.status || determineStatus({ temperature, humidity, airQuality });
  const lightLabel = getLightLabel(light);

  // Persist to DB
  insertReading.run({ temperature, humidity, light, air_quality: airQuality, status, light_label: lightLabel, recorded_at: timestamp });

  latestData = { temperature, humidity, light, airQuality, status, lightLabel, timestamp };

  // Rolling chart history
  const tick = { time: fmtTime(timestamp) };
  chartHistory.temperature.push({ ...tick, value: temperature });
  chartHistory.humidity.push({ ...tick, value: humidity });
  chartHistory.light.push({ ...tick, value: light });
  chartHistory.airQuality.push({ ...tick, value: airQuality });
  for (const k of Object.keys(chartHistory)) {
    if (chartHistory[k].length > MAX_CHART) chartHistory[k].shift();
  }

  // Build today's stats fresh from DB
  const stats = getTodayStats();

  io.emit('sensor-update', { ...latestData, history: chartHistory, stats });

  console.log(`[${timestamp}] Temp:${temperature}°C Hum:${humidity}% Light:${light} AQ:${airQuality} → ${status}`);
  res.json({ success: true, status });
});

// ─── GET /api/sensor-data  (Latest snapshot) ─────────────
app.get('/api/sensor-data', (req, res) => {
  if (!latestData) return res.status(404).json({ error: 'No data received yet' });
  res.json({ ...latestData, history: chartHistory, stats: getTodayStats() });
});

// ─── GET /api/history  (Paginated DB history) ─────────────
app.get('/api/history', (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit)  || 100, 1000);
  const offset = parseInt(req.query.offset) || 0;
  const from   = req.query.from;  // ISO date string
  const to     = req.query.to;

  let query = 'SELECT * FROM readings';
  const params = [];

  if (from || to) {
    const clauses = [];
    if (from) { clauses.push('recorded_at >= ?'); params.push(from); }
    if (to)   { clauses.push('recorded_at <= ?'); params.push(to); }
    query += ' WHERE ' + clauses.join(' AND ');
  }

  query += ' ORDER BY recorded_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const rows  = db.prepare(query).all(...params);
  const total = db.prepare('SELECT COUNT(*) as n FROM readings').get().n;

  res.json({ total, limit, offset, rows });
});

// ─── GET /api/stats  (Aggregated stats) ──────────────────
app.get('/api/stats', (req, res) => {
  res.json(getTodayStats());
});

// ─── GET /api/export  (CSV download) ──────────────────────
app.get('/api/export', (req, res) => {
  const from = req.query.from;
  const to   = req.query.to;

  let query = 'SELECT * FROM readings';
  const params = [];

  if (from || to) {
    const clauses = [];
    if (from) { clauses.push('recorded_at >= ?'); params.push(from); }
    if (to)   { clauses.push('recorded_at <= ?'); params.push(to); }
    query += ' WHERE ' + clauses.join(' AND ');
  }
  query += ' ORDER BY recorded_at ASC';

  const rows = db.prepare(query).all(...params);

  const header = 'id,timestamp,temperature_C,humidity_%,light_ADC,air_quality_ADC,status,light_label\n';
  const csv    = rows.map(r =>
    `${r.id},${r.recorded_at},${r.temperature},${r.humidity},${r.light},${r.air_quality},${r.status},${r.light_label}`
  ).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="sses_readings.csv"');
  res.send(header + csv);
});

// ─── GET /api/health ──────────────────────────────────────
app.get('/api/health', (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as n FROM readings').get().n;
  res.json({ status: 'online', uptime: process.uptime(), totalReadings: count });
});

// ─── Stats helper ─────────────────────────────────────────
function getTodayStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const iso = todayStart.toISOString();

  const row = db.prepare(`
    SELECT
      ROUND(MIN(temperature),1)  AS temp_min,
      ROUND(MAX(temperature),1)  AS temp_max,
      ROUND(AVG(temperature),1)  AS temp_avg,
      ROUND(MIN(humidity),1)     AS hum_min,
      ROUND(MAX(humidity),1)     AS hum_max,
      ROUND(AVG(humidity),1)     AS hum_avg,
      MIN(light)                 AS light_min,
      MAX(light)                 AS light_max,
      ROUND(AVG(light))          AS light_avg,
      MIN(air_quality)           AS aq_min,
      MAX(air_quality)           AS aq_max,
      ROUND(AVG(air_quality))    AS aq_avg,
      COUNT(*)                   AS reading_count
    FROM readings
    WHERE recorded_at >= ?
  `).get(iso);

  // Status distribution today
  const dist = db.prepare(`
    SELECT status, COUNT(*) as n FROM readings WHERE recorded_at >= ? GROUP BY status
  `).all(iso);

  return { ...row, statusDistribution: dist, date: iso };
}

// ─── Socket.io ────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);
  if (latestData) {
    socket.emit('sensor-update', { ...latestData, history: chartHistory, stats: getTodayStats() });
  }
  socket.on('disconnect', () => console.log(`[Socket] Disconnected: ${socket.id}`));
});

// ─── Start ────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use!`);
    console.error(`   Run this to fix it: npx kill-port ${PORT}`);
    console.error(`   Or in PowerShell:   Stop-Process -Id (Get-NetTCPConnection -LocalPort ${PORT}).OwningProcess -Force\n`);
    process.exit(1);
  } else {
    throw err;
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const count = db.prepare('SELECT COUNT(*) as n FROM readings').get().n;
  console.log(`\n🚀 SSES Backend on port ${PORT}`);
  console.log(`   DB: ${count} readings loaded from sses.db`);
  console.log(`   ESP32 endpoint → http://<PC_IP>:${PORT}/api/sensor-data`);
  console.log(`   All incoming requests are logged above.\n`);
});
