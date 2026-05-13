import React, { useEffect, useState, useRef } from 'react';
import { io } from 'socket.io-client';
import {
  AreaChart, Area, XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid
} from 'recharts';
import './index.css';

const BACKEND_URL = ''; // Relative path leverages Vite's proxy for ngrok/LAN support

// ─── Utilities ────────────────────────────────────────────
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

// ─── Custom Tooltip ───────────────────────────────────────
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

// ─── Sensor Card ──────────────────────────────────────────
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

// ─── Mini Chart ───────────────────────────────────────────
const MiniChart = ({ data, color, title, unit, gradId }) => (
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
        <YAxis tick={{ fill:'#3d4452', fontSize:9, fontFamily:'Share Tech Mono' }} tickLine={false} axisLine={false} width={40} />
        <Tooltip content={<CustomTooltip unit={unit} />} />
        <Area type="monotone" dataKey="value" stroke={color} strokeWidth={1.5} fill={`url(#${gradId})`} dot={false}
          activeDot={{ r:4, fill:color, stroke:'var(--bg-primary)', strokeWidth:2 }} />
      </AreaChart>
    </ResponsiveContainer>
  </div>
);

// ─── Stat Mini Card ───────────────────────────────────────
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

// ─── History Table ────────────────────────────────────────
const HistoryTable = ({ rows }) => {
  if (!rows.length) return (
    <div style={{ textAlign:'center', padding:'32px 0', color:'var(--text-muted)', fontFamily:'var(--font-mono)', fontSize:12 }}>
      No historical records yet.
    </div>
  );

  return (
    <div className="history-table-wrap">
      <table className="history-table">
        <thead>
          <tr>
            {['Timestamp','Temp (°C)','Humidity (%)','Light (ADC)','Air Quality','Status'].map(h => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} className={`row-${(r.status || '').toLowerCase()}`}>
              <td className="td-mono">{new Date(r.recorded_at).toLocaleString('en-IN')}</td>
              <td className="td-mono">{r.temperature}</td>
              <td className="td-mono">{r.humidity}</td>
              <td className="td-mono">{r.light}</td>
              <td className="td-mono">{r.air_quality}</td>
              <td>
                <span className={`status-chip chip-${(r.status || '').toLowerCase()}`}>{r.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// ─── Main App ─────────────────────────────────────────────
export default function App() {
  const [data,        setData]        = useState(null);
  const [history,     setHistory]     = useState({ temperature:[], humidity:[], light:[], airQuality:[] });
  const [stats,       setStats]       = useState(null);
  const [histRows,    setHistRows]    = useState([]);
  const [histTotal,   setHistTotal]   = useState(0);
  const [histPage,    setHistPage]    = useState(0);
  const [connected,   setConnected]   = useState(false);
  const [hasData,     setHasData]     = useState(false);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [activeTab,   setActiveTab]   = useState('live'); // 'live' | 'history' | 'stats'
  const socketRef = useRef(null);
  const PAGE_SIZE = 20;

  // ── Fetch history rows ──────────────────────────────────
  const fetchHistory = (page = 0) => {
    fetch(`${BACKEND_URL}/api/history?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`)
      .then(r => r.json())
      .then(d => { setHistRows(d.rows || []); setHistTotal(d.total || 0); setHistPage(page); })
      .catch(() => {});
  };

  // ── Socket connection ───────────────────────────────────
  useEffect(() => {
    const socket = io(BACKEND_URL, { transports: ['websocket', 'polling'] });
    socketRef.current = socket;

    socket.on('connect',    () => setConnected(true));
    socket.on('disconnect', () => setConnected(false));

    socket.on('sensor-update', ({ history: hist, stats: s, ...sensor }) => {
      setData(sensor);
      setHistory(hist || { temperature:[], humidity:[], light:[], airQuality:[] });
      setStats(s || null);
      setHasData(true);
      setLastUpdated(new Date());
    });

    // Initial REST fetch
    fetch(`${BACKEND_URL}/api/sensor-data`)
      .then(r => r.ok ? r.json() : null)
      .then(payload => {
        if (!payload) return;
        const { history: hist, stats: s, ...sensor } = payload;
        setData(sensor);
        setHistory(hist || { temperature:[], humidity:[], light:[], airQuality:[] });
        setStats(s || null);
        setHasData(true);
        setLastUpdated(new Date());
      })
      .catch(() => {});

    fetchHistory(0);

    return () => socket.disconnect();
  }, []);

  // Refresh history table when tab opens
  useEffect(() => {
    if (activeTab === 'history') fetchHistory(histPage);
  }, [activeTab]);

  // ── CSV Export ─────────────────────────────────────────
  const handleExport = () => {
    window.open(`${BACKEND_URL}/api/export`, '_blank');
  };

  // ── Derived values ─────────────────────────────────────
  const statusClass = data ? getStatusClass(data.status) : 'no-data';
  const statusMeta  = {
    ideal:    { icon:'✦', text:'Ideal Study Environment — All parameters within optimal range'   },
    moderate: { icon:'◈', text:'Moderate Conditions — Some parameters slightly out of range'     },
    poor:     { icon:'◉', text:'Poor Conditions — Environment needs attention'                   },
    'no-data':{ icon:'◌', text:'Awaiting sensor data from ESP32...'                             },
  };
  const sm = statusMeta[statusClass];

  const tempPill  = data ? getTempPill(data.temperature)    : null;
  const humPill   = data ? getHumPill(data.humidity)        : null;
  const airPill   = data ? getAirPill(data.airQuality)      : null;
  const lightPill = data ? getLightPill(data.lightLabel)    : null;

  const tempBar  = data ? clamp(((data.temperature - 0) / 50) * 100, 0, 100) : 0;
  const humBar   = data ? clamp(data.humidity, 0, 100) : 0;
  const airBar   = data ? clamp((data.airQuality / 1000) * 100, 0, 100) : 0;
  const lightBar = data ? clamp((data.light / 4095) * 100, 0, 100) : 0;

  const connState = connected ? (hasData ? 'connected' : 'waiting') : 'disconnected';
  const connLabel = connected ? (hasData ? 'LIVE'       : 'AWAITING ESP32') : 'DISCONNECTED';

  const totalPages = Math.ceil(histTotal / PAGE_SIZE);

  // ── Status distribution bar helper ──────────────────────
  const distMap = {};
  (stats?.statusDistribution || []).forEach(d => { distMap[d.status] = d.n; });
  const totalDist = stats?.reading_count || 1;

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
              <span>SSES Dashboard</span>
            </div>
          </div>
          <div className="header-right">
            {lastUpdated && (
              <div className="last-updated">UPD {lastUpdated.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', second:'2-digit' })}</div>
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

        {/* ── Status Banner ── */}
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
          <SensorCard type="temp"  icon="🌡️" label="TEMPERATURE"       value={data?.temperature} unit="°C"  min="0°C"  max="50°C"   barPercent={tempBar}  pill={tempPill}  />
          <SensorCard type="hum"   icon="💧" label="HUMIDITY"          value={data?.humidity}    unit="%"   min="0%"   max="100%"   barPercent={humBar}   pill={humPill}   />
          <SensorCard type="air"   icon="🌫️" label="AIR QUALITY (MQ135)" value={data?.airQuality} unit="ADC" min="0"    max="1000+"  barPercent={airBar}   pill={airPill}   />
          <SensorCard type="light" icon="💡" label="AMBIENT LIGHT (LDR)" value={data?.light}     unit="ADC" min="0"    max="4095"   barPercent={lightBar} pill={lightPill} />
        </div>

        {/* ── Tab Nav ── */}
        <div className="tab-nav">
          {[
            { key:'live',    label:'// Live Charts'    },
            { key:'stats',   label:'// Today\'s Stats' },
            { key:'history', label:'// DB History'     },
          ].map(t => (
            <button key={t.key} className={`tab-btn ${activeTab === t.key ? 'active' : ''}`} onClick={() => setActiveTab(t.key)}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── TAB: Live Charts ── */}
        {activeTab === 'live' && (
          <div className="charts-section">
            {!hasData ? (
              <div className="no-data-state">
                <div className="no-data-icon">📶</div>
                <div className="no-data-text">No data received</div>
                <div className="no-data-sub">
                  Ensure ESP32 is posting to<br />
                  <span style={{ color:'var(--cyan)', fontFamily:'var(--font-mono)' }}>
                    http://&lt;YOUR_PC_IP&gt;:3001/api/sensor-data
                  </span>
                </div>
              </div>
            ) : (
              <div className="charts-grid">
                <MiniChart data={history.temperature} color="#ff6b35" title="Temperature"  unit="°C"  gradId="g-temp"  />
                <MiniChart data={history.humidity}    color="#00d4ff" title="Humidity"     unit="%"   gradId="g-hum"   />
                <MiniChart data={history.airQuality}  color="#00ff9d" title="Air Quality"  unit="ADC" gradId="g-air"   />
                <MiniChart data={history.light}       color="#ffd60a" title="Light Level"  unit="ADC" gradId="g-light" />
              </div>
            )}
          </div>
        )}

        {/* ── TAB: Today's Stats ── */}
        {activeTab === 'stats' && (
          <div className="stats-section fade-in">
            {!stats || stats.reading_count === 0 ? (
              <div className="no-data-state">
                <div className="no-data-icon">📊</div>
                <div className="no-data-text">No readings today yet</div>
              </div>
            ) : (
              <>
                <div className="stats-card">
                  <div className="stats-card-title">Today's Sensor Summary</div>
                  <StatRow label="🌡️ Temperature" min={stats.temp_min}  max={stats.temp_max}  avg={stats.temp_avg}  unit="°C"  color="#ff6b35" />
                  <StatRow label="💧 Humidity"    min={stats.hum_min}   max={stats.hum_max}   avg={stats.hum_avg}   unit="%"   color="#00d4ff" />
                  <StatRow label="🌫️ Air Quality" min={stats.aq_min}    max={stats.aq_max}    avg={stats.aq_avg}    unit=" ADC" color="#00ff9d" />
                  <StatRow label="💡 Light"       min={stats.light_min} max={stats.light_max} avg={stats.light_avg} unit=" ADC" color="#ffd60a" />
                </div>

                {/* Status distribution */}
                <div className="stats-card" style={{ marginTop:16 }}>
                  <div className="stats-card-title">Status Distribution — Today ({stats.reading_count} readings)</div>
                  <div className="dist-bars">
                    {['Ideal','Moderate','Poor'].map(s => {
                      const n = distMap[s] || 0;
                      const pct = Math.round((n / totalDist) * 100);
                      const color = s === 'Ideal' ? 'var(--green)' : s === 'Moderate' ? 'var(--yellow)' : 'var(--red)';
                      return (
                        <div key={s} className="dist-row">
                          <div className="dist-label" style={{ color }}>{s}</div>
                          <div className="dist-bar-track">
                            <div className="dist-bar-fill" style={{ width:`${pct}%`, background:color, boxShadow:`0 0 6px ${color}` }} />
                          </div>
                          <div className="dist-count" style={{ color }}>{n} <span style={{ color:'var(--text-muted)' }}>({pct}%)</span></div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── TAB: DB History ── */}
        {activeTab === 'history' && (
          <div className="history-section fade-in">
            <div className="history-header">
              <div style={{ fontFamily:'var(--font-mono)', fontSize:11, color:'var(--text-secondary)' }}>
                {histTotal} total records · Page {histPage + 1} of {Math.max(totalPages, 1)}
              </div>
              <div style={{ display:'flex', gap:8 }}>
                <button className="page-btn" disabled={histPage === 0} onClick={() => fetchHistory(histPage - 1)}>← Prev</button>
                <button className="page-btn" disabled={histPage >= totalPages - 1} onClick={() => fetchHistory(histPage + 1)}>Next →</button>
              </div>
            </div>
            <HistoryTable rows={histRows} />
          </div>
        )}

        {/* ── System Info ── */}
        <div className="charts-section" style={{ marginTop:28 }}>
          <div className="section-header">
            <div className="section-title">// System Info</div>
            <div className="section-line" />
          </div>
          <div className="system-grid">
            {[
              { icon:'⚡', label:'Microcontroller',  val:'ESP32 (Xtensa LX6)' },
              { icon:'🌡️', label:'Temp / Humidity',  val:'DHT22 — GPIO 4'     },
              { icon:'🌫️', label:'Air Quality',       val:'MQ135 — ADC 34'     },
              { icon:'💡', label:'Light',             val:'LDR — ADC 35'       },
              { icon:'🗄️', label:'Database',          val:'SQLite (sses.db)'   },
              { icon:'🔄', label:'Update Interval',   val:'2 seconds'          },
            ].map(item => (
              <div key={item.label} className="sys-card">
                <div className="sys-icon">{item.icon}</div>
                <div className="sys-info">
                  <div className="sys-label">{item.label}</div>
                  <div className="sys-val">{item.val}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* ── Footer ── */}
        <footer className="footer">
          <div className="footer-brand">
            <span>SSES</span> · Smart Study Environment Sensing System
          </div>
          <div className="footer-tags">
            {['ESP32','DHT22','MQ135','LDR','Node.js','React','SQLite'].map(t => (
              <span key={t} className="footer-tag">{t}</span>
            ))}
          </div>
          <div className="footer-dev">
            Developed by{' '}
            <a
              href="https://github.com/sudhanva1608"
              target="_blank"
              rel="noopener noreferrer"
              className="footer-dev-link"
            >
              Sudhanva
            </a>
          </div>
        </footer>

      </div>
    </>
  );
}
