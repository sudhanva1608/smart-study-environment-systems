import { useEffect, useState, useRef } from 'react';
import { io } from 'socket.io-client';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid
} from 'recharts';
import MqttStatusBadge from './components/MqttStatusBadge';
import MLPredictionCard from './components/MLPredictionCard';
import ForecastChart from './components/ForecastChart';
import './index.css';

const BACKEND_URL = '';

function clamp(val, min, max) { return Math.min(Math.max(val, min), max); }

function getStatusClass(status) {
  if (!status) return 'no-data';
  const s = status.toLowerCase();
  if (s === 'ideal') return 'ideal';
  if (s === 'moderate') return 'moderate';
  return 'poor';
}

function getTempPill(t)  { return t >= 20 && t <= 28 ? { cls:'pill-good', label:'OPTIMAL' } : t > 28 && t <= 32 ? { cls:'pill-warn', label:'WARM' } : { cls:'pill-bad', label:'CRITICAL' }; }
function getHumPill(h)   { return h >= 40 && h <= 65 ? { cls:'pill-good', label:'OPTIMAL' } : h > 65 && h <= 75 ? { cls:'pill-warn', label:'HUMID'   } : { cls:'pill-bad', label:'POOR'     }; }
function getAirPill(a)   { return a < 350            ? { cls:'pill-good', label:'CLEAN'   } : a < 500            ? { cls:'pill-warn', label:'MODERATE'} : { cls:'pill-bad', label:'POLLUTED' }; }
function getLightPill(l) {
  const m = { Bright: 'pill-warn', Normal: 'pill-good', Dim: 'pill-warn', Dark: 'pill-bad' };
  return { cls: m[l] || 'pill-neutral', label: (l || 'N/A').toUpperCase() };
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

const MiniChart = ({ data, color, title, unit, gradId, yDomain, yTicks }) => (
  <div className="chart-card">
    <div className="chart-title">
      <div className="chart-title-dot" style={{ background: color }} />
      {title}
    </div>
    <ResponsiveContainer width="100%" height={150}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor={color} stopOpacity={0.3} />
            <stop offset="95%" stopColor={color} stopOpacity={0}   />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="#1a1a2e" />
        <XAxis dataKey="time" tick={{ fill:'#3d4452', fontSize:9, fontFamily:'Share Tech Mono' }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
        <YAxis
          tick={{ fill:'#3d4452', fontSize:9, fontFamily:'Share Tech Mono' }}
          tickLine={false}
          axisLine={false}
          width={40}
          {...(yDomain ? { domain: yDomain } : {})}
          {...(yTicks  ? { ticks: yTicks   } : {})}
        />
        <Tooltip content={<CustomTooltip unit={unit} />} />
        <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} fill={`url(#${gradId})`} dot={false}
          activeDot={{ r:4, fill:color, stroke:'var(--bg-primary)', strokeWidth:2 }} />
      </AreaChart>
    </ResponsiveContainer>
  </div>
);

const StatRow = ({ label, min, max, avg, unit, color }) => (
  <div className="stat-row">
    <div className="stat-label" style={{ color }}>{label}</div>
    <div className="stat-cells">
      <div className="stat-cell">
        <span className="stat-cell-label">MIN</span>
        <span className="stat-cell-val" style={{ color }}>{min ?? '—'}<span className="stat-unit">{unit}</span></span>
      </div>
      <div className="stat-cell">
        <span className="stat-cell-label">AVG</span>
        <span className="stat-cell-val" style={{ color }}>{avg ?? '—'}<span className="stat-unit">{unit}</span></span>
      </div>
      <div className="stat-cell">
        <span className="stat-cell-label">MAX</span>
        <span className="stat-cell-val" style={{ color }}>{max ?? '—'}<span className="stat-unit">{unit}</span></span>
      </div>
    </div>
  </div>
);

export default function App() {
  const [data, setData] = useState(null);
  const [history, setHistory] = useState({ temperature: [], humidity: [], light: [], airQuality: [] });
  const [stats, setStats] = useState(null);
  const [predictions, setPredictions] = useState(null);
  const [mqttStatus, setMqttStatus] = useState(null);
  const [connected, setConnected] = useState(false);
  const [hasData, setHasData] = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [activeTab, setActiveTab] = useState('live'); // 'live' | 'predictions' | 'stats'

  const socketRef = useRef(null);

  useEffect(() => {
    const socket = io(BACKEND_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect', () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('sensor-update', ({ history: hist, stats: s, predictions: pred, mqttStatus: mq, ...sensor }) => {
      setData(sensor);
      if (hist) setHistory(hist);
      if (s) setStats(s);
      if (pred) setPredictions(pred);
      if (mq) setMqttStatus(mq);
      setHasData(true);
      setLastUpdated(new Date());
    });

    fetch(`${BACKEND_URL}/api/sensor-data`)
      .then(r => r.ok ? r.json() : null)
      .then(payload => {
        if (!payload) return;
        const { history: hist, stats: s, predictions: pred, mqttStatus: mq, ...sensor } = payload;
        setData(sensor);
        if (hist) setHistory(hist);
        if (s) setStats(s);
        if (pred) setPredictions(pred);
        if (mq) setMqttStatus(mq);
        setHasData(true);
        setLastUpdated(new Date());
      })
      .catch(() => {});

    return () => socket.disconnect();
  }, []);

  const handleActuatorLed = (color) => {
    fetch(`${BACKEND_URL}/api/actuators/leds`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ color })
    }).catch(err => console.error('Failed to trigger remote LED:', err));
  };

  const handleExport = () => {
    window.open(`${BACKEND_URL}/api/export`, '_blank');
  };

  const statusClass = data ? getStatusClass(data.status) : 'no-data';
  const statusMeta = {
    ideal:    { icon:'✦', text:'Ideal Study Environment — All parameters within optimal range' },
    moderate: { icon:'◈', text:'Moderate Conditions — Some parameters slightly out of range' },
    poor:     { icon:'◉', text:'Poor Conditions — Environment needs attention' },
    'no-data':{ icon:'◌', text:'Awaiting sensor data from ESP32...' },
  };
  const sm = statusMeta[statusClass];

  const tempPill  = data ? getTempPill(data.temperature) : null;
  const humPill   = data ? getHumPill(data.humidity) : null;
  const airPill   = data ? getAirPill(data.airQuality) : null;
  const lightPill = data ? getLightPill(data.lightLabel) : null;

  const tempBar  = data ? clamp(((data.temperature - 0) / 50) * 100, 0, 100) : 0;
  const humBar   = data ? clamp(data.humidity, 0, 100) : 0;
  const airBar   = data ? clamp((data.airQuality / 1000) * 100, 0, 100) : 0;
  const lightBar = data ? clamp((data.light / 4095) * 100, 0, 100) : 0;

  const connState = connected ? (hasData ? 'connected' : 'waiting') : 'disconnected';
  const connLabel = connected ? (hasData ? 'CLOUD CONNECTED' : 'AWAITING ESP32') : 'DISCONNECTED';

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
              <span>SSES Cloud & ML Intelligence</span>
            </div>
          </div>
          <div className="header-right">
            {lastUpdated && (
              <div className="last-updated">
                UPD {new Date(lastUpdated).toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', second:'2-digit' })}
              </div>
            )}
            <button className="export-btn" onClick={handleExport} title="Download all readings as CSV">
              ⬇ Export CSV
            </button>
            <div className={`connection-badge ${connState}`}>
              <div className={`pulse-dot ${connected ? (hasData ? 'active' : 'waiting') : 'inactive'}`} />
              {connLabel}
            </div>
          </div>
        </header>

        {/* ── MQTT Status Banner ── */}
        <MqttStatusBadge mqttStatus={mqttStatus} stats={stats} />

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
          <SensorCard type="air"   icon="🌫️" label="AIR QUALITY (MQ135)"   value={data?.airQuality} unit="ADC" min="0"    max="1000+"  barPercent={airBar}   pill={airPill}   />
          <SensorCard type="light" icon="💡" label="AMBIENT LIGHT (LDR)"   value={data?.light}      unit="ADC" min="0"    max="4095"   barPercent={lightBar} pill={lightPill} />
        </div>

        {/* ── Tab Nav ── */}
        <div className="tab-nav">
          {[
            { key:'live',        label:'// Live Charts & Remote Control' },
            { key:'predictions', label:'// AI Predictions & Forecast' },
            { key:'stats',       label:'// Today\'s Stats' },
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

            <div className="charts-grid">
              <MiniChart data={history.temperature} color="#ff6b35" title="Temperature" unit="°C" gradId="g-temp" yDomain={[20, 40]} />
              <MiniChart data={history.humidity} color="#00d4ff" title="Humidity" unit="%" gradId="g-hum" />
              <MiniChart data={history.airQuality} color="#00ff9d" title="Air Quality" unit="ADC" gradId="g-air" />
              <MiniChart data={history.light} color="#ffd60a" title="Light Level" unit="ADC" gradId="g-light" />
            </div>

            <div className="forecast-grid" style={{ marginTop: 24 }}>
              <ForecastChart history={history} predictions={predictions} metric="temperature" title="Temperature (°C) Trend & AI Forecast" unit="°C" color="#ff6b35" />
              <ForecastChart history={history} predictions={predictions} metric="humidity" title="Humidity (%) Trend & AI Forecast" unit="%" color="#00d4ff" />
              <ForecastChart history={history} predictions={predictions} metric="airQuality" title="Air Quality (ADC) Trend & AI Forecast" unit=" ADC" color="#00ff9d" />
            </div>
          </div>
        )}

        {/* ── TAB: AI Predictions ── */}
        {activeTab === 'predictions' && (
          <div className="predictions-section fade-in">
            <MLPredictionCard predictions={predictions} />
          </div>
        )}

        {/* ── TAB: Today's Stats ── */}
        {activeTab === 'stats' && (
          <div className="stats-section fade-in">
            <div className="stats-card">
              <div className="stats-card-title">Today's Sensor Summary</div>
              <StatRow label="🌡️ Temperature" min={stats?.temp_min}  max={stats?.temp_max}  avg={stats?.temp_avg}  unit="°C"  color="#ff6b35" />
              <StatRow label="💧 Humidity"    min={stats?.hum_min}   max={stats?.hum_max}   avg={stats?.hum_avg}   unit="%"   color="#00d4ff" />
              <StatRow label="🌫️ Air Quality" min={stats?.aq_min}    max={stats?.aq_max}    avg={stats?.aq_avg}    unit=" ADC" color="#00ff9d" />
              <StatRow label="💡 Light"       min={stats?.light_min} max={stats?.light_max} avg={stats?.light_avg} unit=" ADC" color="#ffd60a" />
            </div>
          </div>
        )}

        {/* ── Footer ── */}
        <footer className="footer">
          <div className="footer-brand">
            <span>SSES</span> · Smart Study Environment Sensing System
          </div>
          <div className="footer-tags">
            {['ESP32', 'MQTT', 'HiveMQ Cloud', 'Scikit-Learn', 'Node.js', 'React', 'Supabase'].map(t => (
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

      </div>
    </>
  );
}