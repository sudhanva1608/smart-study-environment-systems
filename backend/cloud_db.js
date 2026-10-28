const { createClient } = require('@supabase/supabase-js');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { DEFAULT_SETTINGS, validateReading } = require('./anomaly');
const { canMatchForecast, absoluteErrors, sensorMessageKey } = require('./forecast_matching');

const db = new Database(path.join(__dirname, 'sses.db'));
db.pragma('busy_timeout = 5000');
db.pragma('journal_mode = WAL');
db.exec("CREATE TABLE IF NOT EXISTS anomaly_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, sensor TEXT NOT NULL, observed_value REAL NOT NULL, baseline REAL NOT NULL, reason TEXT NOT NULL, severity TEXT NOT NULL, action TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', acknowledged_at TEXT, resolved_at TEXT); CREATE INDEX IF NOT EXISTS idx_alerts_status_created ON anomaly_alerts(status, created_at DESC); CREATE TABLE IF NOT EXISTS sensor_settings (id INTEGER PRIMARY KEY CHECK(id=1), values_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS forecasts (id INTEGER PRIMARY KEY AUTOINCREMENT, source_reading_at TEXT NOT NULL UNIQUE, generated_at TEXT NOT NULL, target_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', model_status TEXT NOT NULL, reason TEXT, values_json TEXT NOT NULL, methods_json TEXT NOT NULL, metrics_json TEXT NOT NULL, actual_json TEXT, errors_json TEXT, matched_at TEXT); CREATE INDEX IF NOT EXISTS idx_forecasts_status_target ON forecasts(status, target_at DESC); CREATE TABLE IF NOT EXISTS processed_sensor_messages (message_key TEXT PRIMARY KEY, received_at TEXT NOT NULL);");

const cachePath = path.join(__dirname, 'cloud_readings_cache.json');
let cache = [];
if (fs.existsSync(cachePath)) {
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { cache = []; }
}
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  const url = process.env.SUPABASE_URL.trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
  supabase = createClient(url, process.env.SUPABASE_ANON_KEY);
  console.log('[CloudDB] Supabase sync configured; SQLite remains the local source.');
} else console.log('[CloudDB] Using existing local SQLite database.');

const insert = db.prepare('INSERT INTO readings (temperature, humidity, light, air_quality, status, light_label, recorded_at) VALUES (@temperature, @humidity, @light, @air_quality, @status, @light_label, @recorded_at)');
const claimSensorMessage = db.prepare('INSERT OR IGNORE INTO processed_sensor_messages(message_key,received_at) VALUES(?,?)');
const hasRecord = db.prepare('SELECT 1 FROM readings WHERE recorded_at=? AND temperature=? AND humidity=? AND light=? AND air_quality=? LIMIT 1');
function recordOf(r) {
  return {
    temperature: Number(r.temperature), humidity: Number(r.humidity), light: Number(r.light),
    air_quality: Number(r.airQuality ?? r.air_quality), status: r.status || 'Ideal',
    light_label: r.lightLabel || r.light_label || 'Uncalibrated ADC',
    recorded_at: r.recorded_at || new Date().toISOString()
  };
}
// The original app wrote its latest readings to the capped JSON cache. Import any
// cache records missing from SQLite so its newer real history is not hidden.
const importCachedReadings = db.transaction(() => {
  let imported = 0;
  for (const cached of cache) {
    try {
      const record = recordOf(cached);
      if (!validateReading({ ...record, airQuality: record.air_quality }).valid) continue;
      if (!hasRecord.get(record.recorded_at, record.temperature, record.humidity, record.light, record.air_quality)) {
        insert.run(record);
        imported += 1;
      }
    } catch { /* skip malformed legacy cache rows */ }
  }
  return imported;
});
const importedReadings = importCachedReadings();
if (importedReadings) console.log('[CloudDB] Imported ' + importedReadings + ' valid cached readings into SQLite history.');

async function saveReading(reading) {
  const record = recordOf(reading);
  if (!validateReading({ ...record, airQuality: record.air_quality }).valid) throw new Error('Invalid sensor reading');
  const messageKey = sensorMessageKey(reading.deviceId, reading.deviceTimestamp);
  if (messageKey) {
    const inserted = db.transaction(() => {
      db.prepare("DELETE FROM processed_sensor_messages WHERE julianday(received_at) < julianday('now','-10 minutes')").run();
      if (!claimSensorMessage.run(messageKey, new Date().toISOString()).changes) return false;
      insert.run(record);
      return true;
    })();
    if (!inserted) return { duplicate: true };
  } else insert.run(record);
  cache.push(record);
  if (cache.length > 1000) cache = cache.slice(-1000);
  try { fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2)); }
  catch (err) { console.warn('[CloudDB] JSON cache write failed:', err.message); }
  if (supabase) {
    try {
      const { error } = await supabase.from('readings').insert([record]);
      if (error && !global._supabaseWarnCount) { global._supabaseWarnCount = 1; console.warn('[CloudDB] Supabase sync failed; SQLite is current:', error.message); }
    } catch (err) {
      if (!global._supabaseWarnCount) { global._supabaseWarnCount = 1; console.warn('[CloudDB] Supabase sync failed; SQLite is current:', err.message); }
    }
  }
  return record;
}
function mapRow(row) { return { ...row, airQuality: row.air_quality, lightLabel: row.light_label, timestamp: row.recorded_at }; }
async function getRecentReadings(limit = 60) {
  const n = Math.max(1, Math.min(2000, Math.floor(Number(limit) || 60)));
  return db.prepare('SELECT * FROM readings ORDER BY recorded_at DESC, id DESC LIMIT ?').all(n).reverse().map(mapRow);
}
function rangeValues(from, to) {
  const a = from ? new Date(from) : new Date(0);
  const b = to ? new Date(to) : new Date();
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()) || a > b) {
    const err = new Error('Invalid time range'); err.status = 400; throw err;
  }
  return [a.toISOString(), b.toISOString()];
}
function getReadings(from, to, limit = 2000) {
  const n = Math.max(1, Math.min(20000, Math.floor(Number(limit) || 2000)));
  if (!from && !to) return db.prepare('SELECT * FROM readings ORDER BY recorded_at DESC, id DESC LIMIT ?').all(n).reverse().map(mapRow);
  const [a, b] = rangeValues(from, to);
  return db.prepare('SELECT * FROM readings WHERE recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at, id LIMIT ?').all(a, b, n).map(mapRow);
}
function median(values) {
  if (!values.length) return null;
  const x = [...values].sort((a, b) => a - b), m = Math.floor(x.length / 2);
  return x.length % 2 ? x[m] : (x[m - 1] + x[m]) / 2;
}
function statsRows(rows) {
  const result = { reading_count: rows.length, statusDistribution: [] };
  for (const [field, key] of [['temperature','temp'],['humidity','hum'],['light','light'],['air_quality','aq']]) {
    const vals = rows.map(r => Number(r[field])).filter(Number.isFinite);
    result[key + '_min'] = vals.length ? Math.min(...vals) : null;
    result[key + '_max'] = vals.length ? Math.max(...vals) : null;
    result[key + '_avg'] = vals.length ? Math.round(vals.reduce((s,v)=>s+v,0)/vals.length*10)/10 : null;
    result[key + '_median'] = median(vals);
  }
  const counts = {};
  rows.forEach(r => { counts[r.status] = (counts[r.status] || 0) + 1; });
  result.statusDistribution = Object.entries(counts).map(([status,n]) => ({ status, n }));
  return result;
}
function getStats(from, to) {
  const today = new Date(); today.setHours(0,0,0,0);
  const [a,b] = rangeValues(from || today, to || new Date());
  const rows = db.prepare('SELECT * FROM readings WHERE recorded_at >= ? AND recorded_at <= ? ORDER BY recorded_at LIMIT 20000').all(a,b);
  return statsRows(rows);
}
function getTodayStats() { return getStats(); }
function getAllReadings(from, to) { return getReadings(from, to, 20000); }
async function getExportInfo(from, to) {
  const rows = getReadings(from, to, 20000);
  return { count: rows.length, earliest: rows[0]?.timestamp || null, latest: rows.at(-1)?.timestamp || null };
}
function getSettings() {
  const row = db.prepare('SELECT values_json FROM sensor_settings WHERE id=1').get();
  let saved = {};
  try { saved = row ? JSON.parse(row.values_json) : {}; }
  catch { saved = {}; }
  const settings = {
    ...DEFAULT_SETTINGS,
    ...saved,
    ranges: { ...DEFAULT_SETTINGS.ranges, ...(saved.ranges || {}) }
  };
  // Replace the former built-in MQ135 band while preserving other saved ranges.
  if ([1, 700].includes(settings.ranges.airQuality?.min) && settings.ranges.airQuality?.max === 1300) {
    settings.ranges.airQuality = DEFAULT_SETTINGS.ranges.airQuality;
    db.prepare('INSERT INTO sensor_settings(id,values_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET values_json=excluded.values_json').run(JSON.stringify(settings));
  }
  return settings;
}
function saveSettings(value) {
  db.prepare('INSERT INTO sensor_settings(id,values_json) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET values_json=excluded.values_json').run(JSON.stringify(value));
  return getSettings();
}
function createAlert(a) {
  const result = db.prepare("INSERT INTO anomaly_alerts(created_at,sensor,observed_value,baseline,reason,severity,action,status) VALUES(@created_at,@sensor,@observed_value,@baseline,@reason,@severity,@action,'active')").run(a);
  return db.prepare('SELECT * FROM anomaly_alerts WHERE id=?').get(result.lastInsertRowid);
}
function listAlerts(status='all', limit=100) {
  const n = Math.max(1, Math.min(500, Number(limit) || 100));
  if (status === 'active') return db.prepare("SELECT * FROM anomaly_alerts WHERE status IN ('active','acknowledged') ORDER BY created_at DESC LIMIT ?").all(n);
  if (status === 'resolved') return db.prepare("SELECT * FROM anomaly_alerts WHERE status='resolved' ORDER BY created_at DESC LIMIT ?").all(n);
  return db.prepare('SELECT * FROM anomaly_alerts ORDER BY created_at DESC LIMIT ?').all(n);
}
function getActiveAlerts() { return db.prepare("SELECT * FROM anomaly_alerts WHERE status IN ('active','acknowledged')").all(); }
function getLastAlertTime(sensor) { return db.prepare('SELECT created_at FROM anomaly_alerts WHERE sensor=? ORDER BY created_at DESC LIMIT 1').get(sensor)?.created_at || null; }
function acknowledgeAlert(id) {
  const r = db.prepare("UPDATE anomaly_alerts SET status='acknowledged',acknowledged_at=? WHERE id=? AND status='active'").run(new Date().toISOString(), id);
  return r.changes ? db.prepare('SELECT * FROM anomaly_alerts WHERE id=?').get(id) : null;
}
function resolveAlert(id) { db.prepare("UPDATE anomaly_alerts SET status='resolved',resolved_at=? WHERE id=? AND status IN ('active','acknowledged')").run(new Date().toISOString(), id); }

const saveForecastStatement = db.prepare(`INSERT INTO forecasts
  (source_reading_at, generated_at, target_at, status, model_status, reason, values_json, methods_json, metrics_json)
  VALUES (@source_reading_at, @generated_at, @target_at, 'pending', @model_status, @reason, @values_json, @methods_json, @metrics_json)
  ON CONFLICT(source_reading_at) DO NOTHING`);
function saveForecast(forecast) {
  if (!forecast?.source_reading_at || !forecast?.generated_at || !forecast?.target_at || !forecast?.values) return false;
  const info = saveForecastStatement.run({
    source_reading_at: forecast.source_reading_at, generated_at: forecast.generated_at,
    target_at: forecast.target_at, model_status: forecast.status || 'baseline_fallback', reason: forecast.reason || null,
    values_json: JSON.stringify(forecast.values), methods_json: JSON.stringify(forecast.methods || {}),
    metrics_json: JSON.stringify(forecast.evaluation || {})
  });
  db.exec('DELETE FROM forecasts WHERE id NOT IN (SELECT id FROM forecasts ORDER BY id DESC LIMIT 2000)');
  return info.changes > 0;
}
function mapForecast(row, includeEvaluation = false) {
  if (!row) return null;
  const parse = value => { try { return value ? JSON.parse(value) : null; } catch { return null; } };
  return { id: row.id, source_reading_at: row.source_reading_at, generated_at: row.generated_at,
    target_at: row.target_at, status: row.status, model_status: row.model_status, reason: row.reason,
    values: parse(row.values_json), methods: parse(row.methods_json),
    evaluation: includeEvaluation ? parse(row.metrics_json) : null,
    actual: parse(row.actual_json), errors: parse(row.errors_json), matched_at: row.matched_at };
}
function getForecastHistory(limit = 100) {
  const n = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const staleBefore = new Date(Date.now() - 30000).toISOString();
  db.prepare("UPDATE forecasts SET status='expired' WHERE status='pending' AND target_at < ?").run(staleBefore);
  const rows = db.prepare('SELECT * FROM forecasts ORDER BY generated_at DESC, id DESC LIMIT ?').all(n).reverse();
  return rows.map((row, index) => mapForecast(row, index === rows.length - 1));
}
function matchForecasts(reading) {
  const actualAt = reading.recorded_at || reading.timestamp;
  const earliestTarget = new Date(new Date(actualAt).getTime() - 30000).toISOString();
  const matches = db.prepare("SELECT id, target_at, values_json FROM forecasts WHERE status='pending' AND target_at <= ? AND target_at >= ? ORDER BY target_at")
    .all(actualAt, earliestTarget);
  for (const forecast of matches) {
    if (!canMatchForecast(forecast.target_at, actualAt)) continue;
    const predicted = JSON.parse(forecast.values_json);
    const actual = { temperature: Number(reading.temperature), humidity: Number(reading.humidity),
      light: Number(reading.light), airQuality: Number(reading.airQuality ?? reading.air_quality) };
    const errors = absoluteErrors(predicted, actual);
    db.prepare("UPDATE forecasts SET status='matched', actual_json=?, errors_json=?, matched_at=? WHERE id=? AND status='pending'")
      .run(JSON.stringify(actual), JSON.stringify(errors), actualAt, forecast.id);
  }
  return matches.length;
}

module.exports = { saveReading, getRecentReadings, getTodayStats, getAllReadings, getExportInfo, getReadings, getStats, getSettings, saveSettings, createAlert, listAlerts, getActiveAlerts, getLastAlertTime, acknowledgeAlert, resolveAlert, saveForecast, getForecastHistory, matchForecasts };
