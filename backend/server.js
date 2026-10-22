require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');

const cloudDb = require('./cloud_db');
const { initMQTT } = require('./mqtt_client');
const { createDetector, validateReading, validateSettings, getRecommendations, getEnvironmentStatus } = require('./anomaly');
const forecastClient = require('./forecast_client');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(cors());
app.use(express.json());

// ─── Request Logger ───────────────────────────────────────
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ─── State Management ─────────────────────────────────────
let latestData = null;
let latestRecommendations = [];
let lastInvalidData = null;
let activeSettings = cloudDb.getSettings();
let detector = null;
const MAX_CHART = 60;
const chartHistory = {
  temperature: [], humidity: [], light: [], airQuality: [],
};

// Seed initial history from Cloud DB cache on startup
const ready = (async function seedHistory() {
  const rows = await cloudDb.getRecentReadings(MAX_CHART);
  const storedAlerts = cloudDb.getActiveAlerts();
  detector = createDetector({
    settings: activeSettings,
    initialReadings: rows || [],
    activeAlerts: storedAlerts,
    getLastAlertTime: sensor => cloudDb.getLastAlertTime(sensor),
    createAlert: alert => cloudDb.createAlert(alert),
    resolveAlert: id => cloudDb.resolveAlert(id)
  });
  if (!rows || rows.length === 0) return;

  for (const r of rows) {
    const tick = { time: fmtTime(r.recorded_at), timestamp: r.recorded_at };
    chartHistory.temperature.push({ ...tick, value: r.temperature });
    chartHistory.humidity.push({ ...tick, value: r.humidity });
    chartHistory.light.push({ ...tick, value: r.light });
    chartHistory.airQuality.push({ ...tick, value: r.air_quality ?? r.airQuality });
  }

  const last = rows[rows.length - 1];
  latestData = {
    temperature: last.temperature,
    humidity: last.humidity,
    light: last.light,
    airQuality: last.air_quality ?? last.airQuality,
    status: last.status,
    lightLabel: getLightLabel(last.light),
    timestamp: last.recorded_at,
  };
  console.log(`[Backend Seed] Loaded ${rows.length} readings from Cloud DB cache.`);
  latestRecommendations = getRecommendations({
    temperature: latestData.temperature, humidity: latestData.humidity,
    light: latestData.light, airQuality: latestData.airQuality
  }, activeSettings);
})();

// ─── Helpers ──────────────────────────────────────────────
function determineStatus(reading) {
  return getEnvironmentStatus(reading, activeSettings.ranges);
}

function getLightLabel(value) {
  return 'Raw ADC (direction unverified)';
}

function forecastEvaluationForUi(evaluation) {
  if (!evaluation) return null;
  const targets = {};
  for (const [sensor, result] of Object.entries(evaluation.targets || {})) {
    targets[sensor] = {
      status: result.status, usable_examples: result.usable_examples,
      training_examples: result.training_examples, test_examples: result.test_examples,
      training_period: result.training_period, training_target_period: result.training_target_period,
      evaluation_period: result.evaluation_period, persistence: result.persistence,
      candidates: result.candidates, selected_candidate: result.selected_candidate,
      selected_metrics: result.selected_metrics, operational_model: result.operational_model,
      reason: result.reason
    };
  }
  return { status: evaluation.status, algorithm: evaluation.algorithm,
    horizon_seconds: evaluation.horizon_seconds, target_tolerance_seconds: evaluation.target_tolerance_seconds,
    sampling_stride_seconds: evaluation.sampling_stride_seconds, valid_readings: evaluation.valid_readings,
    usable_examples: evaluation.usable_examples, training_cutoff: evaluation.training_cutoff,
    trained_at: evaluation.trained_at, targets };
}

function fmtTime(iso) {
  const d = new Date(iso || Date.now());
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

// ─── Process Incoming Telemetry ────────────────────────────
async function handleTelemetryUpdate(telemetry) {
  const checked = validateReading(telemetry);
  if (!checked.valid) {
    lastInvalidData = { at: new Date().toISOString(), kind: 'invalid', reason: checked.reason };
    io.emit('data-warning', lastInvalidData);
    return { success: false, reason: checked.reason };
  }
  const { temperature, humidity, light, airQuality } = checked.value;

  const timestamp = new Date().toISOString();
  // Firmware versions may send a stale hard-coded status. Recalculate it from
  // validated readings and the active preferred ranges instead.
  const status = determineStatus({ temperature, humidity, light, airQuality });
  const lightLabel = getLightLabel(light);

  const newReading = {
    temperature: Number(temperature),
    humidity: Number(humidity),
    light: Number(light),
    airQuality: Number(airQuality),
    deviceId: typeof telemetry.deviceId === 'string' ? telemetry.deviceId : null,
    deviceTimestamp: telemetry.timestamp ?? null,
    status,
    lightLabel,
    recorded_at: timestamp
  };

  // Persist validated data before exposing it as the latest stored reading.
  try {
    const saved = await cloudDb.saveReading(newReading);
    if (saved?.duplicate) return { success: true, duplicate: true };
  } catch (err) {
    lastInvalidData = { at: new Date().toISOString(), kind: 'storage', reason: 'A valid reading could not be saved locally.' };
    io.emit('data-warning', lastInvalidData);
    throw err;
  }
  try { cloudDb.matchForecasts(newReading); }
  catch (err) { console.warn('[Forecast] Could not match reading to saved forecasts:', err.message); }
  if (!detector) detector = createDetector({ settings: activeSettings });
  let detection;
  try {
    detection = await detector.process(newReading);
  } catch (err) {
    lastInvalidData = { at: new Date().toISOString(), kind: 'storage', reason: 'The reading was saved, but alert processing could not be completed.' };
    io.emit('data-warning', lastInvalidData);
    throw err;
  }
  lastInvalidData = null;
  latestRecommendations = detection.recommendations;
  latestData = { ...newReading, timestamp };

  // Update rolling history
  const tick = { time: fmtTime(timestamp), timestamp };
  chartHistory.temperature.push({ ...tick, value: Number(temperature) });
  chartHistory.humidity.push({ ...tick, value: Number(humidity) });
  chartHistory.light.push({ ...tick, value: Number(light) });
  chartHistory.airQuality.push({ ...tick, value: Number(airQuality) });

  for (const k of Object.keys(chartHistory)) {
    if (chartHistory[k].length > MAX_CHART) chartHistory[k].shift();
  }

  const stats = cloudDb.getTodayStats();
  const mqttStatus = mqttClient.getStatus();
  const alerts = cloudDb.listAlerts('all', 100);

  // Broadcast to Socket.IO clients
  io.emit('sensor-update', {
    ...latestData,
    history: chartHistory,
    stats,
    recommendations: latestRecommendations,
    alerts,
    lastInvalidData,
    mqttStatus
  });

  console.log(`[Telemetry Sync] Temp:${temperature}°C Hum:${humidity}% AQ:${airQuality} → Status:${status}`);
  return { success: true, status };
}

// ─── Initialize MQTT Client ────────────────────────────────
const mqttClient = process.env.SSES_DISABLE_MQTT === '1' ? {
  getStatus: () => ({ connected: false, disabled: true, topic: null }),
  publishActuatorCommand: () => false
} : initMQTT((data) => {
  ready.then(() => handleTelemetryUpdate(data)).catch(err => console.error('[Telemetry] Processing failed:', err.message));
}, (status) => {
  io.emit('mqtt-status', status);
  if (status.connected) {
    // Re-send stored preference bands after each broker reconnect so the board
    // LED rules and dashboard use the same thresholds.
    setTimeout(() => mqttClient.publishActuatorCommand({ sensorRanges: activeSettings.ranges }), 0);
  }
});

// ─── REST Endpoints ────────────────────────────────────────

// HTTP POST (backward compatibility for legacy HTTP devices)
app.post('/api/sensor-data', async (req, res) => {
  try {
    const result = await ready.then(() => handleTelemetryUpdate(req.body));
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error('[Telemetry] Save failed:', err.message);
    res.status(500).json({ error: 'Could not save sensor reading.' });
  }
});

// GET snapshot
app.get('/api/sensor-data', async (req, res) => {
  await ready;
  if (!latestData) return res.status(404).json({ error: 'No valid sensor data received yet', mqttStatus: mqttClient.getStatus(), lastInvalidData });
  const stats = cloudDb.getTodayStats();
  res.json({
    ...latestData,
    history: chartHistory,
    stats,
    recommendations: latestRecommendations,
    alerts: cloudDb.listAlerts('all', 100),
    lastInvalidData,
    mqttStatus: mqttClient.getStatus()
  });
});

// Actuator control endpoint
app.post('/api/actuators/leds', (req, res) => {
  const { color } = req.body; // 'green', 'yellow', 'red'
  if (!['green', 'yellow', 'red', 'off'].includes(color)) {
    return res.status(400).json({ error: 'Invalid LED color option' });
  }
  mqttClient.publishActuatorCommand({ ledOverride: color });
  res.json({ success: true, colorOverride: color });
});

// Backward-compatible endpoint for clients that used the old prediction route.
app.get('/api/predict', async (req, res) => {
  await ready;
  if (!latestData) return res.status(404).json({ error: 'No valid sensor readings are available.' });
  res.json({ success: true, method: 'validated rules', recommendations: latestRecommendations });
});

app.get('/api/history', async (req, res) => {
  try {
    const useRecent = req.query.all === '1' || (!req.query.from && !req.query.to);
    const readings = useRecent
      ? await cloudDb.getRecentReadings(req.query.limit)
      : cloudDb.getReadings(req.query.from, req.query.to, req.query.limit);
    const stats = useRecent && readings.length
      ? cloudDb.getStats(readings[0].timestamp, readings[readings.length - 1].timestamp)
      : cloudDb.getStats(req.query.from, req.query.to);
    res.json({ readings, stats });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

let forecastInProgress = null;
app.get('/api/forecast', async (req, res) => {
  try {
    await ready;
    const readings = await cloudDb.getRecentReadings(2000);
    const latestReading = readings.at(-1);
    let forecasts = cloudDb.getForecastHistory(100);
    let forecast = latestReading && forecasts.find(item => item.source_reading_at === latestReading.timestamp);

    if (!forecast && latestReading && Date.now() - new Date(latestReading.timestamp).getTime() <= 60000) {
      if (!forecastInProgress) {
        forecastInProgress = (async () => {
          try {
            return await forecastClient.predict(readings);
          } catch (error) {
            const sourceTime = new Date(latestReading.timestamp).getTime();
            return {
              status: 'baseline_fallback',
              reason: 'The local model worker is unavailable; using the latest actual reading as a persistence baseline.',
              source_reading_at: latestReading.timestamp,
              target_at: new Date(sourceTime + 300000).toISOString(),
              generated_at: new Date().toISOString(),
              horizon_seconds: 300,
              values: { temperature: latestReading.temperature, humidity: latestReading.humidity,
                light: latestReading.light, airQuality: latestReading.airQuality ?? latestReading.air_quality },
              methods: { temperature: 'persistence', humidity: 'persistence', light: 'persistence', airQuality: 'persistence' },
              evaluation: {},
              reason_detail: error.message
            };
          }
        })();
      }
      const result = await forecastInProgress;
      forecastInProgress = null;
      if (result?.target_at && result?.values && ['model', 'baseline_fallback'].includes(result.status)) {
        cloudDb.saveForecast({ ...result, source_reading_at: result.source_reading_at || latestReading.timestamp });
      }
      forecasts = cloudDb.getForecastHistory(100);
      forecast = forecasts.find(item => item.source_reading_at === latestReading.timestamp);
    }

    const currentAge = latestReading ? Date.now() - new Date(latestReading.timestamp).getTime() : Infinity;
    const status = currentAge > 60000 ? 'stale' : (forecast?.model_status || 'unavailable');
    const evaluation = forecastEvaluationForUi(forecast?.evaluation || forecasts.at(-1)?.evaluation);
    const historyForUi = forecasts.slice(-60).map(({ evaluation: _evaluation, ...item }) => item);
    res.json({ status, latest: forecast ? { ...forecast, evaluation: null } : null, forecasts: historyForUi,
      readings: readings.slice(-240), latestReadingAt: latestReading?.timestamp || null,
      evaluation,
      reason: !latestReading ? 'No real sensor readings are stored yet.' : currentAge > 60000 ? 'The latest sensor reading is older than 60 seconds.' : forecast ? null : 'Recent history is not yet sufficient for a five-minute model forecast.' });
  } catch (err) {
    console.error('[Forecast] Could not generate local forecast:', err.message);
    res.status(500).json({ status: 'unavailable', error: 'Forecast generation failed; the sensor dashboard is unaffected.' });
  }
});

app.get('/api/stats', (req, res) => {
  try { res.json(cloudDb.getStats(req.query.from, req.query.to)); }
  catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

app.get('/api/alerts', (req, res) => {
  res.json(cloudDb.listAlerts(req.query.status || 'all', req.query.limit));
});

app.post('/api/alerts/:id/acknowledge', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid alert id.' });
  const alert = cloudDb.acknowledgeAlert(id);
  if (!alert) return res.status(404).json({ error: 'Active alert not found.' });
  io.emit('alerts-update', cloudDb.listAlerts('all', 100));
  res.json(alert);
});

app.get('/api/settings', (req, res) => res.json(cloudDb.getSettings()));
app.put('/api/settings', (req, res) => {
  const checked = validateSettings(req.body);
  if (checked.error) return res.status(400).json({ error: checked.error });
  const saved = cloudDb.saveSettings(checked.value);
  if (detector) {
    Object.assign(activeSettings, saved);
    activeSettings.ranges = saved.ranges;
  } else activeSettings = saved;
  mqttClient.publishActuatorCommand({ sensorRanges: activeSettings.ranges });
  res.json(activeSettings);
});

// Helpers for timezone-aware CSV export
function formatToLocalTime(date, tz) {
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(d);

    const map = {};
    parts.forEach(p => map[p.type] = p.value);
    return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
  } catch (e) {
    return new Date(date).toISOString();
  }
}

function formatFilenameTime(date, tz) {
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return '';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz || 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(d);

    const map = {};
    parts.forEach(p => map[p.type] = p.value);
    return `${map.year}-${map.month}-${map.day}_${map.hour}-${map.minute}`;
  } catch (e) {
    return new Date(date).toISOString().replace(/[:.]/g, '-').slice(0, 16);
  }
}

// GET export CSV (supports stipulated time range via ?from=&to= or ?start=&end=)
app.get('/api/export', async (req, res) => {
  try {
    const {
      start, end, from, to,
      tz = 'Asia/Kolkata'
    } = req.query;
    const fromTime = start || from;
    const toTime = end || to;

    const readings = await cloudDb.getAllReadings(fromTime, toTime);

    if (!readings || readings.length === 0) {
      if (fromTime || toTime) {
        return res.status(404).json({
          error: 'No sensor readings found for the specified stipulated time range.'
        });
      }

      // If no stored readings and no filter, export current session's chartHistory
      const rows = [];
      const times = chartHistory.temperature || [];
      times.forEach((t, i) => {
        rows.push({
          timestamp: t.timestamp || t.time,
          temperature: t.value,
          humidity: (chartHistory.humidity[i] || {}).value || '',
          light: (chartHistory.light[i] || {}).value || '',
          airQuality: (chartHistory.airQuality[i] || {}).value || '',
          status: ''
        });
      });

      if (rows.length === 0) {
        return res.status(404).json({ error: 'No data available to export yet.' });
      }

      const header = 'Timestamp,Temperature (°C),Humidity (%),Light (ADC),Air Quality (ADC),Status\n';
      const csv = header + rows.map(r =>
        `"${r.timestamp}",${r.temperature},${r.humidity},${r.light},${r.airQuality},"${r.status}"`
      ).join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="sses_readings_${Date.now()}.csv"`);
      return res.send(csv);
    }

    // Determine descriptive filename based on stipulated time window in user's local timezone
    let filename = `sses_readings_${Date.now()}.csv`;
    if (fromTime && toTime) {
      filename = `sses_readings_${formatFilenameTime(fromTime, tz)}_to_${formatFilenameTime(toTime, tz)}.csv`;
    } else if (fromTime) {
      filename = `sses_readings_from_${formatFilenameTime(fromTime, tz)}.csv`;
    } else if (toTime) {
      filename = `sses_readings_until_${formatFilenameTime(toTime, tz)}.csv`;
    }

    // Build CSV from stored readings
    const header = 'Timestamp,Temperature (°C),Humidity (%),Light (ADC),Air Quality (ADC),Status\n';
    const csv = header + readings.map(r => {
      const ts = r.timestamp || r.recorded_at || r.created_at || '';
      const aq = r.airQuality != null ? r.airQuality : (r.air_quality != null ? r.air_quality : '');
      return `"${ts}",${r.temperature ?? ''},${r.humidity ?? ''},${r.light ?? ''},${aq},"${r.status ?? ''}"`;
    }).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(csv);
  } catch (err) {
    console.error('[Export] CSV export error:', err.message);
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

// GET export count preview for stipulated time range
app.get('/api/export/count', async (req, res) => {
  try {
    const { start, end, from, to } = req.query;
    const fromTime = start || from;
    const toTime = end || to;

    const info = await cloudDb.getExportInfo(fromTime, toTime);
    res.json(info);
  } catch (err) {
    console.error('[Export] Count error:', err.message);
    res.status(500).json({ error: 'Failed to count readings: ' + err.message });
  }
});


// GET health check
app.get('/api/health', (req, res) => {
  const stats = cloudDb.getTodayStats();
  res.json({
    status: 'online',
    uptime: process.uptime(),
    totalReadings: stats.reading_count,
    mqtt: mqttClient.getStatus()
  });
});

// ─── Socket.IO Connection ─────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] Client Connected: ${socket.id}`);
  if (latestData) {
    socket.emit('sensor-update', {
      ...latestData,
      history: chartHistory,
      stats: cloudDb.getTodayStats(),
      recommendations: latestRecommendations,
      alerts: cloudDb.listAlerts('all', 100),
      lastInvalidData,
      mqttStatus: mqttClient.getStatus()
    });
  }
  socket.on('disconnect', () => console.log(`[Socket] Client Disconnected: ${socket.id}`));
});

// ─── Start Server ─────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use!`);
    process.exit(1);
  } else {
    throw err;
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀 SSES Environment Monitoring backend listening on port ${PORT}`);
  console.log(`   MQTT Topic Sub: sses/sensors/telemetry`);
  console.log(`   History: local SQLite + optional Supabase sync`);
  console.log(`   Anomaly detection: rolling median and MAD\n`);
});
