import { memo, useEffect, useMemo, useState, useRef } from 'react';
import { io } from 'socket.io-client';
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid
} from 'recharts';
import MqttStatusBadge from './components/MqttStatusBadge';
import MLPredictionCard from './components/MLPredictionCard';
import ForecastPanel from './components/ForecastPanel';
import { getForecastModels } from './forecastModels';
import ForecastChart from './components/ForecastChart';
import ExportModal from './components/ExportModal';
import { prepareChartPoints } from './chartData';
import './index.css';

const BACKEND_URL = '';
const DEFAULT_RANGES = {
  temperature: { min: 24, max: 30 }, humidity: { min: 60, max: 75 },
  airQuality: { min: 0, max: 1300 }, light: { min: 2000, max: 2500 }
};

function clamp(val, min, max) { return Math.min(Math.max(val, min), max); }

function summarizeSeries(points = []) {
  const values = points.map(point => Number(point.value)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  const middle = Math.floor(values.length / 2);
  return {
    min: values[0], max: values.at(-1),
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2
  };
}

function formatHistoryTime(timestamp, range) {
  const date = new Date(timestamp);
  const options = ['24h', '7d', '30d', 'stored'].includes(range)
    ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' };
  return date.toLocaleString('en-IN', options);
}

function getStatusClass(status) {
  if (!status) return 'no-data';
  const s = status.toLowerCase();
  if (s === 'ideal') return 'ideal';
  if (s === 'moderate') return 'moderate';
  return 'poor';
}

function getRangePill(value, range, neutralLabel) {
  if (value == null) return { cls: 'pill-neutral', label: neutralLabel };
  return value >= range.min && value <= range.max
    ? { cls: 'pill-good', label: neutralLabel }
    : { cls: 'pill-warn', label: 'CHECK RANGE' };
}

function getAirQualityCondition(value, range) {
  if (value == null) return { cls: 'pill-neutral', label: 'NO DATA' };
  if (value >= range.min && value <= range.max) return { cls: 'pill-good', label: 'NORMAL' };
  const margin = Math.max((range.max - range.min) * 0.5, 1);
  const poor = value < range.min - margin || value > range.max + margin;
  return poor
    ? { cls: 'pill-bad', label: 'POOR' }
    : { cls: 'pill-warn', label: 'MODERATE' };
}

function getEnvironmentStatus(reading, ranges) {
  const outside = ['temperature', 'humidity', 'light', 'airQuality'].filter(sensor =>
    reading[sensor] < ranges[sensor].min || reading[sensor] > ranges[sensor].max
  );
  if (!outside.length) return 'Ideal';
  const farOutside = outside.some(sensor => {
    const { min, max } = ranges[sensor];
    const margin = Math.max((max - min) * 0.5, 1);
    return reading[sensor] < min - margin || reading[sensor] > max + margin;
  });
  return farOutside ? 'Poor' : 'Moderate';
}

const HISTORY_RANGES = [
  ['live', 'Live session (60 readings)'], ['1h', 'Last hour'], ['6h', 'Last 6 hours'],
  ['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days'],
  ['stored', 'Latest stored readings (up to 2,000)']
];

function HistoryRangePicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const pickerRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = event => { if (!pickerRef.current?.contains(event.target)) setOpen(false); };
    const closeEscape = event => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeEscape);
    };
  }, [open]);
  const selected = HISTORY_RANGES.find(([key]) => key === value) || HISTORY_RANGES[0];
  return (
    <div className={`history-picker ${open ? 'is-open' : ''}`} ref={pickerRef}>
      <button id="history-range" type="button" className="history-picker-trigger" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(current => !current)}>
        <span>{selected[1]}</span><span className="history-picker-chevron" aria-hidden="true">⌄</span>
      </button>
      {open && <div className="history-picker-menu" role="listbox" aria-label="Chart time range">
        {HISTORY_RANGES.map(([key, label]) => (
          <button type="button" role="option" aria-selected={value === key} key={key} className={`history-picker-option ${value === key ? 'selected' : ''}`} onClick={() => { onChange(key); setOpen(false); }}>
            <span>{label}</span>{value === key && <span className="history-picker-check" aria-hidden="true">✓</span>}
          </button>
        ))}
      </div>}
    </div>
  );
}

const CustomTooltip = ({ active, payload, label, unit }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="custom-tooltip">
      <div style={{ color: 'var(--text-secondary)', marginBottom: 4, fontSize: 10 }}>{label}</div>
      <div style={{ color: payload[0]?.color }}>
        {payload[0]?.value != null ? Number(payload[0].value).toFixed(1) : '—'} {unit}
      </div>
    </div>
  );
};

const SensorCard = ({ type, icon, label, value, unit, min, max, barPercent, pill }) => {
  const [flash, setFlash] = useState(false);
  const prev = useRef(null);
  useEffect(() => {
    if (prev.current !== null && prev.current !== value) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 450);
      return () => clearTimeout(t);
    }
    prev.current = value;
  }, [value]);

  const display = value != null
    ? (typeof value === 'number' ? value.toFixed(value > 99 ? 0 : 1) : value)
    : '—';

  return (
    <div className={`sensor-card ${type} fade-in`}>
      <div className="card-header">
        <div className="card-icon-wrap">{icon}</div>
        <div style={{ textAlign: 'right' }}>
          <div className="card-label">{label}</div>
          {pill && <span className={`card-status-pill ${pill.cls}`}>{pill.label}</span>}
        </div>
      </div>
      <div className="card-value-block">
        <div className={`card-value ${flash ? 'value-update' : ''}`}>{display}</div>
        <div className="card-unit">{unit}</div>
      </div>
      <div className="card-bar-track">
        <div className="card-bar-fill" style={{ width: `${barPercent}%` }} />
      </div>
      <div className="card-range"><span>{min}</span><span>{max}</span></div>
    </div>
  );
};

const MiniChart = memo(function MiniChart({ data, color, title, unit, gradId, yDomain, yTicks, lineOnly = false }) {
  const chartData = useMemo(() => prepareChartPoints(data), [data]);
  const values = chartData.map(point => point.value);
  const low = values.length ? Math.min(...values) : 0;
  const high = values.length ? Math.max(...values) : 1;
  const pad = Math.max((high - low) * 0.12, lineOnly ? 1 : 0.5);
  const resolvedDomain = yDomain || (values.length ? [Math.max(0, low - pad), high + pad] : undefined);
  const Chart = lineOnly ? LineChart : AreaChart;

  return (
    <div className="chart-card">
      <div className="chart-title">
        <div className="chart-title-dot" style={{ background: color }} />
        {title}
      </div>
      {chartData.length < 2 ? (
        <div className="empty-alerts">Need at least two valid readings to draw a trend ({chartData.length} available).</div>
      ) : (
        <ResponsiveContainer width="100%" height={150}>
          <Chart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
            {!lineOnly && <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.3} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>}
            <CartesianGrid strokeDasharray="3 3" stroke="#1a1a2e" />
            <XAxis dataKey="time" tick={{ fill:'var(--text-secondary)', fontSize:9, fontFamily:'Share Tech Mono' }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={28} />
            <YAxis
              tick={{ fill:'var(--text-secondary)', fontSize:9, fontFamily:'Share Tech Mono' }}
              tickLine={false}
              axisLine={false}
              width={42}
              {...(resolvedDomain ? { domain: resolvedDomain } : {})}
              {...(yTicks ? { ticks: yTicks } : {})}
            />
            <Tooltip content={<CustomTooltip unit={unit} />} />
            {lineOnly
              ? <Line type="linear" dataKey="value" stroke={color} strokeWidth={2} dot={false} connectNulls activeDot={{ r:4, fill:color, stroke:'var(--bg-primary)', strokeWidth:2 }} isAnimationActive animationDuration={450} animationEasing="ease-out" />
              : <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} fill={`url(#${gradId})`} dot={false} connectNulls activeDot={{ r:4, fill:color, stroke:'var(--bg-primary)', strokeWidth:2 }} />}
          </Chart>
        </ResponsiveContainer>
      )}
    </div>
  );
});

export default function App() {
  const [data, setData] = useState(null);
  const [history, setHistory] = useState({ temperature: [], humidity: [], light: [], airQuality: [] });
  const [stats, setStats] = useState(null);
  const [recommendations, setRecommendations] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [settings, setSettings] = useState(null);
  const [settingsError, setSettingsError] = useState('');
  const [rangeStats, setRangeStats] = useState(null);
  const [historyRange, setHistoryRange] = useState('live');
  const [lastInvalidData, setLastInvalidData] = useState(null);
  const [clockNow, setClockNow] = useState(0);
  const [mqttStatus, setMqttStatus] = useState(null);
  const [connected, setConnected] = useState(false);
  const [hasData, setHasData] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [activeTab, setActiveTab] = useState('live');
  const [isExportModalOpen, setIsExportModalOpen] = useState(false);
  const [forecastData, setForecastData] = useState(null);
  const [forecastError, setForecastError] = useState('');

  const socketRef = useRef(null);

  useEffect(() => {
    const socket = io(BACKEND_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('sensor-update', ({ history: hist, stats: s, recommendations: recs, alerts: alertList, lastInvalidData: invalid, mqttStatus: mq, ...sensor }) => {
      setData(sensor);
      if (historyRange === 'live' && hist) setHistory(hist);
      else if (sensor.timestamp) {
        const maxAge = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000 }[historyRange];
        const timestamp = sensor.timestamp;
        const point = { timestamp, time: formatHistoryTime(timestamp, historyRange) };
        const values = { temperature: sensor.temperature, humidity: sensor.humidity, light: sensor.light, airQuality: sensor.airQuality };
        setHistory(current => {
          if (maxAge && Date.now() - new Date(timestamp).getTime() > maxAge) return current;
          const next = { ...current };
          for (const [key, value] of Object.entries(values)) {
            if (value !== null && value !== undefined && Number.isFinite(Number(value))) next[key] = [...(current[key] || []), { ...point, value: Number(value) }].slice(-2000);
          }
          return next;
        });
      }
      if (s) setStats(s);
      if (recs) setRecommendations(recs);
      if (alertList) setAlerts(alertList);
      setLastInvalidData(invalid || null);
      if (mq) setMqttStatus(mq);
      setHasData(true);
      setLastUpdated(sensor.timestamp ? new Date(sensor.timestamp) : new Date());
    });
    socket.on('data-warning', warning => setLastInvalidData(warning));
    socket.on('alerts-update', alertList => setAlerts(alertList));
    socket.on('mqtt-status', status => setMqttStatus(status));

    fetch(`${BACKEND_URL}/api/sensor-data`)
      .then(async r => {
        const payload = await r.json().catch(() => null);
        if (!r.ok) {
          if (payload?.lastInvalidData) setLastInvalidData(payload.lastInvalidData);
          if (payload?.mqttStatus) setMqttStatus(payload.mqttStatus);
          return null;
        }
        return payload;
      })
      .then(payload => {
        if (!payload) return;
        const { history: hist, stats: s, recommendations: recs, alerts: alertList, lastInvalidData: invalid, mqttStatus: mq, ...sensor } = payload;
        setData(sensor);
        if (historyRange === 'live' && hist) setHistory(hist);
        if (s) setStats(s);
        if (recs) setRecommendations(recs);
        if (alertList) setAlerts(alertList);
        setLastInvalidData(invalid || null);
        if (mq) setMqttStatus(mq);
        setHasData(true);
        setLastUpdated(sensor.timestamp ? new Date(sensor.timestamp) : new Date());
      })
      .catch(() => {});

    return () => socket.disconnect();
  }, [historyRange]);

  useEffect(() => {
    if (historyRange === 'live') {
      // Live mode is fed by the socket's rolling window; don't overwrite it
      // with a slower historical HTTP request.
      return undefined;
    }
    let url = `${BACKEND_URL}/api/history?limit=2000`;
    if (historyRange === 'stored') url += '&all=1';
    else {
      const durations = { '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
      url += `&from=${encodeURIComponent(new Date(Date.now() - durations[historyRange]).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`;
    }
    fetch(url).then(r => r.ok ? r.json() : Promise.reject(new Error('History request failed')))
      .then(({ readings = [], stats: summary }) => {
        const metrics = { temperature: [], humidity: [], light: [], airQuality: [] };
        readings.forEach(row => {
          const timestamp = row.timestamp || row.recorded_at;
          const time = formatHistoryTime(timestamp, historyRange);
          for (const [key, value] of Object.entries({ temperature: row.temperature, humidity: row.humidity, light: row.light, airQuality: row.airQuality ?? row.air_quality })) {
            if (value !== null && value !== undefined && Number.isFinite(Number(value))) metrics[key].push({ time, timestamp, value: Number(value) });
          }
        });
        setHistory(metrics);
        setRangeStats(summary || null);
      }).catch(error => console.error('Could not load stored history:', error.message));
  }, [historyRange]);

  useEffect(() => {
    fetch(`${BACKEND_URL}/api/settings`).then(r => {
      if (!r.ok) throw new Error(`Monitoring settings endpoint returned ${r.status}.`);
      return r.json();
    }).then(value => { setSettings(value); setSettingsError(''); }).catch(error => {
      setSettingsError(`${error.message} Restart the project backend to enable saved monitoring settings, alerts and recommendations.`);
    });
    const timer = setInterval(() => setClockNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;
    const refreshForecast = async () => {
      try {
        const response = await fetch(`${BACKEND_URL}/api/forecast`);
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Forecast API is unavailable.');
        if (active) { setForecastData(body); setForecastError(''); }
      } catch (error) {
        if (active) setForecastError(`Could not load the local forecast: ${error.message}`);
      }
    };
    refreshForecast();
    const timer = setInterval(refreshForecast, 60000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  const handleActuatorLed = (color) => {
    fetch(`${BACKEND_URL}/api/actuators/leds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color })
    }).catch(err => console.error('Failed to trigger remote LED:', err));
  };

  const handleExport = () => {
    setIsExportModalOpen(true);
  };

  const handleAcknowledge = async id => {
    const response = await fetch(`${BACKEND_URL}/api/alerts/${id}/acknowledge`, { method: 'POST' });
    if (!response.ok) {
      console.error('Could not acknowledge alert.');
      return;
    }
    const updated = await response.json();
    setAlerts(current => current.map(alert => alert.id === updated.id ? updated : alert));
  };

  const handleSaveSettings = async nextSettings => {
    const response = await fetch(`${BACKEND_URL}/api/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(nextSettings)
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Could not save settings.');
    setSettings(body);
    return body;
  };

  const preferredRanges = settings?.ranges ? {
    ...DEFAULT_RANGES,
    ...settings.ranges,
    airQuality: [1, 700].includes(settings.ranges.airQuality?.min) && settings.ranges.airQuality?.max === 1300
      ? DEFAULT_RANGES.airQuality : (settings.ranges.airQuality || DEFAULT_RANGES.airQuality),
    // Treat the previous app default as a legacy setting after the LDR band
    // was corrected to the user's specified 2000–2500 ADC range.
    light: settings.ranges.light?.min === 2500 && settings.ranges.light?.max === 3600
      ? DEFAULT_RANGES.light : (settings.ranges.light || DEFAULT_RANGES.light)
  } : DEFAULT_RANGES;
  const calculatedStatus = data ? getEnvironmentStatus(data, preferredRanges) : null;
  const statusClass = data ? getStatusClass(calculatedStatus) : 'no-data';
  const statusMeta = {
    ideal:    { icon:'✦', text:'All validated sensor readings are within the configured preferred ranges' },
    moderate: { icon:'◈', text:'One or more readings are slightly outside preferred ranges' },
    poor:     { icon:'◉', text:'One or more readings are well outside preferred ranges; this is not a safety determination' },
    'no-data':{ icon:'◌', text:'Awaiting sensor data from ESP32...' },
  };
  const sm = statusMeta[statusClass];

  const tempPill  = data ? getRangePill(data.temperature, preferredRanges.temperature, 'IN RANGE') : null;
  const humPill   = data ? getRangePill(data.humidity, preferredRanges.humidity, 'IN RANGE') : null;
  const airAdc = data?.airQuality ?? null;
  const airPill   = getAirQualityCondition(airAdc, preferredRanges.airQuality);
  const lightPill = data ? getRangePill(data.light, preferredRanges.light, 'NORMAL') : null;

  const tempBar  = data ? clamp(((data.temperature - 0) / 50) * 100, 0, 100) : 0;
  const humBar   = data ? clamp(data.humidity, 0, 100) : 0;
  const airBar   = airAdc == null ? 0 : clamp(((airAdc - preferredRanges.airQuality.min) / (preferredRanges.airQuality.max - preferredRanges.airQuality.min)) * 100, 0, 100);
  const airAdcStats = useMemo(() => summarizeSeries(history.airQuality), [history.airQuality]);
  const chartStats = useMemo(() => ({
    temp: summarizeSeries(history.temperature),
    hum: summarizeSeries(history.humidity),
    light: summarizeSeries(history.light)
  }), [history]);
  const visibleRangeStats = historyRange === 'live' ? null : rangeStats;
  const lightBar = data ? clamp((data.light / 4095) * 100, 0, 100) : 0;

  const connState = connected ? (hasData ? 'connected' : 'waiting') : 'disconnected';
  const connLabel = connected ? (hasData ? 'BACKEND CONNECTED' : 'WAITING FOR SENSOR') : 'BACKEND DISCONNECTED';

  return (
    <>
      <div className="scanlines" />
      <div className="app-wrapper">

        {/* ── Header ── */}
        <header className="header">
          <div className="header-brand">
            <div className="header-logo">📡</div>
            <div className="header-title">
              SMART STUDY ENV. SENSING
              <span>Study Environment Monitoring &amp; Recommendations</span>
            </div>
          </div>
          <div className="header-right">
            {lastUpdated && (
              <div className="last-updated">
                UPDATED {new Date(lastUpdated).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', second:'2-digit' })}
              </div>
            )}
            <button className="export-btn" onClick={handleExport} title="Download readings as CSV for stipulated time">
              ⬇ Export CSV
            </button>
            <div className={`connection-badge ${connState}`}>
              <div className={`pulse-dot ${connected ? (hasData ? 'active' : 'waiting') : 'inactive'}`} />
              {connLabel}
            </div>
          </div>
        </header>

        {/* ── MQTT Status Banner ── */}
        <MqttStatusBadge mqttStatus={mqttStatus} stats={stats} forecastData={forecastData} />
        {data && clockNow - new Date(data.timestamp || lastUpdated).getTime() > 15000 && (
          <div className="data-warning">Latest sensor reading is stale (over 15 seconds old). Check the ESP32 and MQTT connection.</div>
        )}
        {lastInvalidData && (
          <div className="data-warning">
            {lastInvalidData.kind === 'storage' ? 'Data processing warning' : 'Invalid sensor payload ignored'} at {new Date(lastInvalidData.at).toLocaleTimeString()}: {lastInvalidData.reason}
          </div>
        )}

        {/* ── Environment Status Banner ── */}
        <div className={`status-banner ${statusClass} fade-in`}>
          <div className="status-icon">{sm.icon}</div>
          <div className="status-text">
            <div className="status-label">Environment Status</div>
            <div className="status-value">{sm.text}</div>
          </div>
          {stats?.reading_count > 0 && (
            <div style={{ textAlign:'right', fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-muted)' }}>
              <div style={{ color:'var(--text-secondary)' }}>{stats.reading_count}</div>
              <div>readings today</div>
            </div>
          )}
        </div>

        {/* ── Sensor Cards ── */}
        <div className="sensor-grid">
          <SensorCard type="temp"  icon="🌡️" label="TEMPERATURE"         value={data?.temperature} unit="°C"  min="0°C"  max="50°C"   barPercent={tempBar}  pill={tempPill}  />
          <SensorCard type="hum"   icon="💧" label="HUMIDITY"            value={data?.humidity}    unit="%"   min="0%"   max="100%"   barPercent={humBar}   pill={humPill}   />
          <SensorCard type="air"   icon="🌫️" label="MQ135 AIR QUALITY (RAW)" value={airAdc} unit="ADC" min={preferredRanges.airQuality.min} max={preferredRanges.airQuality.max} barPercent={airBar} pill={airPill} />
          <SensorCard type="light" icon="💡" label="AMBIENT LIGHT (LDR)"   value={data?.light}      unit="ADC" min="0"    max="4095"   barPercent={lightBar} pill={lightPill} />
        </div>
        <p className="air-condition-note">Air conditions are based on the configured ADC range. MQ135 readings are not calibrated to ppm.</p>

        {/* ── Tab Nav ── */}
        <div className="tab-nav">
          {[
            { key:'live',        label:'// Live Charts & Remote Control' },
            { key:'recommendations', label:'// Recommendations & Alerts' },
            { key:'forecast', label:'// ML & Predictions' },
            { key:'stats',       label:'// Reading Statistics' },
          ].map(t => (
            <button key={t.key} className={`tab-btn ${activeTab === t.key ? 'active' : ''}`} onClick={() => setActiveTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── TAB: Live Charts & Remote Controls ── */}
        {activeTab === 'live' && (
          <div className="charts-section fade-in">
            <div className="actuator-control-bar">
              <span className="actuator-label">🎛️ Remote ESP32 LED Control (MQTT):</span>
              <div className="actuator-buttons">
                <button className="btn-led led-green" onClick={() => handleActuatorLed('green')}>Green LED (Ideal)</button>
                <button className="btn-led led-yellow" onClick={() => handleActuatorLed('yellow')}>Yellow LED (Moderate)</button>
                <button className="btn-led led-red" onClick={() => handleActuatorLed('red')}>Red LED (Poor)</button>
              </div>
            </div>

            <div className="history-toolbar">
              <label htmlFor="history-range">Chart time range</label>
              <HistoryRangePicker value={historyRange} onChange={setHistoryRange} />
              <span>{historyRange === 'live' ? 'Updating from the latest 60 sensor readings' : historyRange === 'stored' ? 'Actual saved readings' : 'Filtered by recorded timestamp'}</span>
            </div>

            <div className="charts-grid">
              <MiniChart data={history.temperature} color="#ff6b35" title="Temperature" unit="°C" gradId="g-temp" />
              <MiniChart data={history.humidity} color="#00d4ff" title="Humidity" unit="%" gradId="g-hum" />
              <MiniChart data={history.airQuality} color="#00ff9d" title="MQ135 air quality (raw ADC)" unit="ADC" gradId="g-air" lineOnly />
              <MiniChart data={history.light} color="#ffd60a" title="Light Level" unit="ADC" gradId="g-light" />
            </div>

            <div className="forecast-grid" style={{ marginTop: 24 }}>
              <ForecastChart history={history} metric="temperature" title="Temperature (°C) history" unit="°C" color="#ff6b35" sourceLabel={historyRange === 'live' ? 'Live session' : 'Recorded history'} />
              <ForecastChart history={history} metric="humidity" title="Humidity (%) history" unit="%" color="#00d4ff" sourceLabel={historyRange === 'live' ? 'Live session' : 'Recorded history'} />
              <ForecastChart history={history} metric="airQuality" title="MQ135 air quality (raw ADC)" unit=" ADC" color="#00ff9d" sourceLabel={historyRange === 'live' ? 'Live session' : 'Recorded history'} />
              <ForecastChart history={history} metric="light" title="LDR raw ADC history" unit=" ADC" color="#ffd60a" sourceLabel={historyRange === 'live' ? 'Live session' : 'Recorded history'} />
            </div>
          </div>
        )}

        {/* ── TAB: Recommendations & Alerts ── */}
        {activeTab === 'recommendations' && (
          <div className="predictions-section fade-in">
            <MLPredictionCard recommendations={recommendations} alerts={alerts} settings={settings} settingsError={settingsError} onAcknowledge={handleAcknowledge} onSaveSettings={handleSaveSettings} />
          </div>
        )}

        {/* ── TAB: ML forecasts ── */}
        {activeTab === 'forecast' && (
          <div className="predictions-section fade-in">
            <ForecastPanel data={forecastData} error={forecastError} onRefresh={() => fetch(`${BACKEND_URL}/api/forecast`).then(r => r.json()).then(setForecastData).catch(error => setForecastError(error.message))} />
          </div>
        )}

        {/* ── TAB: Selected Range Stats ── */}
        {activeTab === 'stats' && (
          <div className="stats-section fade-in">
            <div className="stats-card">
              <div className="stats-card-title">{historyRange === 'stored' ? 'Latest Stored Reading Summary' : historyRange === 'live' ? 'Live Session Summary' : 'Selected Time Range Summary'}</div>
              {[['🌡️ Temperature','temp','°C','#ff6b35'],['💧 Humidity','hum','%','#00d4ff'],['🌫️ MQ135 raw reading','aq',' ADC','#00ff9d'],['💡 LDR ADC','light',' ADC','#ffd60a']].map(([label,key,unit,color]) => (
                <div className="stat-row" key={key}>
                  <div className="stat-label" style={{ color }}>{label}</div>
                  <div className="stat-cells">
                    {['min','max','avg','median'].map(field => {
                      const value = key === 'aq' ? airAdcStats?.[field]
                        : (visibleRangeStats?.[key + '_' + field] ?? chartStats[key]?.[field]);
                      const formatted = value == null ? '—' : Number(value).toFixed(key === 'temp' || key === 'hum' ? 1 : 0);
                      return <div className="stat-cell" key={field}><span className="stat-cell-label">{field.toUpperCase()}</span><span className="stat-cell-val" style={{ color }}>{formatted}<span className="stat-unit">{unit}</span></span></div>;
                    })}
                  </div>
                </div>
              ))}
              <div className="stats-card-title">Based on {historyRange === 'live' ? (history.temperature.length || 0) : (visibleRangeStats?.reading_count ?? 0)} {historyRange === 'live' ? 'live readings' : 'stored readings in the selected range'}</div>
            </div>
          </div>
        )}

        {/* ── Footer ── */}
        <footer className="footer">
          <div className="footer-brand">
            <span>SSES</span> · Smart Study Environment Sensing System
          </div>
          <div className="footer-tags">
            {['ESP32', 'MQTT', 'SQLite', 'Rule-based alerts', `Forecast: ${getForecastModels(forecastData?.latest?.methods).join(' + ') || 'waiting for model'}`, 'Rolling median + MAD', 'Node.js', 'React', 'Supabase (optional)'].map(t => (
              <span key={t} className="footer-tag">{t}</span>
            ))}
          </div>
          <div className="footer-dev">
            Developed by{' '}
            <a href="https://github.com/sudhanva1608" target="_blank" rel="noopener noreferrer" className="footer-dev-link">
              Sudhanva
            </a>
          </div>
        </footer>

        <ExportModal
          isOpen={isExportModalOpen}
          onClose={() => setIsExportModalOpen(false)}
          backendUrl={BACKEND_URL}
        />
      </div>
    </>
  );
}
