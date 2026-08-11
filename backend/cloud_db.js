const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Local cache store for offline / dev fallback
const localStorePath = path.join(__dirname, 'cloud_readings_cache.json');
let inMemoryReadings = [];

// Load cached readings if available
if (fs.existsSync(localStorePath)) {
  try {
    const raw = fs.readFileSync(localStorePath, 'utf8');
    inMemoryReadings = JSON.parse(raw);
    console.log(`[CloudDB] Loaded ${inMemoryReadings.length} cached readings from local storage.`);
  } catch (err) {
    console.warn('[CloudDB] Failed to load local cache file, starting fresh.');
  }
}

// Supabase client instance (if configured)
let supabase = null;
if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
  supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
  console.log('[CloudDB] ☁️ Connected to Cloud Supabase DB instance.');
} else {
  console.log('[CloudDB] ℹ️ Supabase credentials not set — running in Cloud Buffer & Cache Mode.');
}

function saveLocalCache() {
  try {
    // Keep last 1000 readings locally
    if (inMemoryReadings.length > 1000) {
      inMemoryReadings = inMemoryReadings.slice(-1000);
    }
    fs.writeFileSync(localStorePath, JSON.stringify(inMemoryReadings, null, 2));
  } catch (err) {
    console.error('[CloudDB] Error persisting local cache:', err.message);
  }
}

/**
 * Save a new reading to Cloud DB and local cache
 */
async function saveReading(reading) {
  const record = {
    temperature: Number(reading.temperature),
    humidity: Number(reading.humidity),
    light: Number(reading.light),
    air_quality: Number(reading.airQuality || reading.air_quality),
    status: reading.status || 'Ideal',
    light_label: reading.lightLabel || 'Normal',
    recorded_at: reading.recorded_at || new Date().toISOString()
  };

  // Add to in-memory store
  inMemoryReadings.push(record);
  saveLocalCache();

  // If Supabase is active, push asynchronously to cloud
  if (supabase) {
    try {
      const { data, error } = await supabase.from('readings').insert([record]);
      if (error) {
        console.warn('[CloudDB] Supabase insert warning:', error.message);
      } else {
        console.log('[CloudDB] ☁️ Reading synced to Cloud Supabase DB.');
      }
    } catch (err) {
      console.error('[CloudDB] Cloud sync exception:', err.message);
    }
  }

  return record;
}

/**
 * Get recent readings for history and charts
 */
async function getRecentReadings(limit = 60) {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('readings')
        .select('*')
        .order('recorded_at', { ascending: false })
        .limit(limit);

      if (!error && data) {
        return data.reverse();
      }
    } catch (err) {
      console.warn('[CloudDB] Cloud fetch failed, using local store:', err.message);
    }
  }

  return inMemoryReadings.slice(-limit);
}

/**
 * Calculate stats for today
 */
function getTodayStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayReadings = inMemoryReadings.filter(r => new Date(r.recorded_at) >= todayStart);
  if (todayReadings.length === 0) {
    return {
      temp_min: null, temp_max: null, temp_avg: null,
      hum_min: null, hum_max: null, hum_avg: null,
      light_min: null, light_max: null, light_avg: null,
      aq_min: null, aq_max: null, aq_avg: null,
      reading_count: 0,
      statusDistribution: []
    };
  }

  const temps = todayReadings.map(r => r.temperature);
  const hums = todayReadings.map(r => r.humidity);
  const lights = todayReadings.map(r => r.light);
  const aqs = todayReadings.map(r => r.air_quality);

  const statusCounts = {};
  todayReadings.forEach(r => {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  });

  const statusDistribution = Object.keys(statusCounts).map(s => ({
    status: s,
    n: statusCounts[s]
  }));

  const avg = arr => Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10;

  return {
    temp_min: Math.min(...temps),
    temp_max: Math.max(...temps),
    temp_avg: avg(temps),
    hum_min: Math.min(...hums),
    hum_max: Math.max(...hums),
    hum_avg: avg(hums),
    light_min: Math.min(...lights),
    light_max: Math.max(...lights),
    light_avg: Math.round(avg(lights)),
    aq_min: Math.min(...aqs),
    aq_max: Math.max(...aqs),
    aq_avg: Math.round(avg(aqs)),
    reading_count: todayReadings.length,
    statusDistribution
  };
}

/**
 * Get ALL readings (for CSV export)
 */
async function getAllReadings() {
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('readings')
        .select('*')
        .order('recorded_at', { ascending: true });
      if (!error && data) return data;
    } catch (err) {
      console.warn('[CloudDB] Cloud fetch failed, using local store:', err.message);
    }
  }
  // Map local cache fields to match export format
  return inMemoryReadings.map(r => ({
    timestamp: r.recorded_at,
    temperature: r.temperature,
    humidity: r.humidity,
    light: r.light,
    airQuality: r.air_quality,
    status: r.status
  }));
}

module.exports = {
  saveReading,
  getRecentReadings,
  getTodayStats,
  getAllReadings
};
