import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

const SENSORS = [
  ['temperature', 'Room temperature', '°C', '#ff6b35'], ['humidity', 'Air moisture', '%', '#00d4ff'],
  ['light', 'Room brightness', 'raw units', '#ffd60a'], ['airQuality', 'Air quality', 'raw units', '#00ff9d']
];
const prettyTime = value => value ? new Date(value).toLocaleString() : '—';
const sensorMeaning = {
  temperature: 'How warm the room may be', humidity: 'How much moisture may be in the air',
  light: 'Raw reading from the brightness sensor', airQuality: 'Raw reading from the air sensor'
};
const methodName = method => ({
  random_forest: 'Estimate from past readings',
  hist_gradient_boosting: 'Estimate from past readings',
  persistence: 'Latest reading'
}[method] || 'Waiting for data');
const methodMeaning = method => ({
  random_forest: 'Uses earlier readings to estimate the next value.',
  hist_gradient_boosting: 'Uses earlier readings to estimate the next value.',
  persistence: 'An estimate was not ready, so this shows the newest reading.'
}[method] || 'More readings are needed before an estimate is available.');
const technicalMethodName = method => ({
  random_forest: 'Random Forest',
  hist_gradient_boosting: 'Histogram Gradient Boosting',
  persistence: 'latest reading'
}[method] || 'not available');
const statusMeaning = status => ({
  model: 'Forecast ready', baseline_fallback: 'Using recent readings', pending: 'Forecast is being prepared',
  stale: 'Sensor data is out of date', unavailable: 'Forecast unavailable', insufficient_data: 'More readings needed'
}[status] || 'Forecast status unavailable');
const forecastReasonForDisplay = (reason, status) => {
  if (status !== 'baseline_fallback') return reason;
  if (/did not beat persistence/i.test(reason || '')) {
    return 'The model estimates have been less accurate than recent sensor readings, so the latest readings are shown instead.';
  }
  if (/worker is unavailable|could not be loaded/i.test(reason || '')) {
    return 'The forecast service is unavailable right now, so the latest sensor readings are shown.';
  }
  return 'The latest sensor readings are shown because there is not enough reliable forecast data yet.';
};
const displayValue = (value, key) => value != null && value !== '' && Number.isFinite(Number(value))
  ? Number(value).toFixed(key === 'temperature' || key === 'humidity' ? 1 : 0) : '—';

function ForecastTooltip({ active, payload, unit }) {
  if (!active || !payload?.length) return null;
  const timestamp = payload[0]?.payload?.timestamp;
  return (
    <div className="forecast-tooltip">
      <strong>{timestamp ? new Date(timestamp).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'Reading time unavailable'}</strong>
      {payload.map(item => (
        <div className="forecast-tooltip-value" key={item.dataKey}>
          <span><i style={{ background: item.color }} />{item.name || 'Sensor reading'}</span>
          <b>{Number(item.value).toFixed(unit === '°C' || unit === '%' ? 1 : 0)} {unit}</b>
        </div>
      ))}
    </div>
  );
}

function ForecastTrend({ sensor, unit, color, readings, forecasts }) {
  const points = useMemo(() => {
    const byTime = new Map();
    const add = timestamp => {
      if (!byTime.has(timestamp)) byTime.set(timestamp, { timestamp, time: new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
      return byTime.get(timestamp);
    };
    readings.forEach(row => {
      const timestamp = row.timestamp || row.recorded_at;
      const value = Number(row[sensor] ?? (sensor === 'airQuality' ? row.air_quality : undefined));
      if (timestamp && Number.isFinite(value)) add(timestamp).actual = value;
    });
    forecasts.forEach(row => {
      const predicted = Number(row.values?.[sensor]);
      if (row.target_at && Number.isFinite(predicted)) add(row.target_at).forecast = predicted;
      if (row.status === 'matched' && row.matched_at && Number.isFinite(Number(row.actual?.[sensor]))) add(row.matched_at).actual = Number(row.actual[sensor]);
    });
    return [...byTime.values()].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).slice(-120);
  }, [sensor, readings, forecasts]);

  if (!points.length) return <div className="forecast-trend-empty">Waiting for actual sensor history.</div>;
  return (
    <div className="forecast-trend-chart">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 12, right: 14, left: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#1a1a2e" vertical={false} />
          <XAxis dataKey="time" stroke="var(--text-muted)" tick={{ fontSize: 10, fill: 'var(--text-secondary)' }} interval="preserveStartEnd" minTickGap={30} />
          <YAxis stroke="var(--text-muted)" tick={{ fontSize: 10, fill: 'var(--text-secondary)' }} width={58} />
          <Tooltip content={<ForecastTooltip unit={unit} />} cursor={{ stroke: 'var(--text-muted)', strokeDasharray: '4 4' }} />
          <Line type="monotone" dataKey="actual" name="Measured reading" stroke={color} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          <Line type="monotone" dataKey="forecast" name="Earlier estimate" stroke="#b895ff" strokeWidth={2} strokeDasharray="5 4" dot={{ r: 2 }} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export default function ForecastPanel({ data, error, onRefresh }) {
  const [selected, setSelected] = useState('temperature');
  const forecasts = data?.forecasts || [];
  const latest = data?.latest;
  const readings = data?.readings || [];
  const evaluation = latest?.evaluation || data?.evaluation || {};
  const status = data?.status === 'stale' ? 'stale' : (latest?.model_status || data?.status || 'unavailable');
  const sensor = SENSORS.find(item => item[0] === selected) || SENSORS[0];
  const matched = forecasts.filter(item => item.status === 'matched');
  const modelSummary = latest ? SENSORS.map(([key, label]) => `${label}: ${technicalMethodName(latest.methods?.[key])}`).join(' · ') : '';

  return (
    <section className="forecast-panel fade-in" aria-labelledby="forecast-title">
      <div className="forecast-panel-header">
        <div><h3 id="forecast-title">What may change in the next 5 minutes?</h3><p>These are estimates from your saved sensor readings. They help you spot trends; they are not guarantees.</p></div>
        <div className={`forecast-state forecast-${status}`}>{statusMeaning(status)}</div>
      </div>
      {error && <div className="data-warning" role="alert">{error}</div>}
      {!latest ? (
        <div className="recommendation-box"><b>Forecast unavailable.</b> {data?.reason || 'Waiting for a fresh reading and at least five minutes of recent history.'} The rest of the monitoring dashboard continues normally.</div>
      ) : (
        <>
          <div className="forecast-model-note"><b>How to read these values</b><span>Estimates use earlier readings. If there isn’t enough information, the latest sensor reading is shown instead.</span></div>
          {data?.status === 'stale' && <div className="data-warning" role="status">{data.reason || 'The latest sensor input is stale; do not treat this forecast as current.'}</div>}
          {latest.reason && <div className="recommendation-box"><b>{status === 'baseline_fallback' ? 'Why recent readings are shown:' : 'Forecast note:'}</b> {forecastReasonForDisplay(latest.reason, status)}</div>}
          <div className="forecast-meta">Estimate for {prettyTime(latest.target_at)} · Last sensor reading {prettyTime(latest.source_reading_at)}</div>
          <div className="forecast-value-grid">
            {SENSORS.map(([key, label, unit, color]) => (
              <article key={key} className="forecast-value-card">
                <span>{label}</span><strong style={{ color }}>{displayValue(latest.values?.[key], key)} <small>{unit}</small></strong>
                <small>{sensorMeaning[key]}</small>
                <small className="forecast-method"><b>{methodName(latest.methods?.[key])}</b> — {methodMeaning(latest.methods?.[key])}</small>
              </article>
            ))}
          </div>

          <details className="forecast-evaluation">
            <summary>How reliable has it been? (technical details)</summary>
            <p className="forecast-explainer">Past estimates are compared with readings collected later. “Typical miss” means how far the estimate was from the later reading on average. A smaller number means closer estimates. This describes past results and cannot guarantee the next one.</p>
            <p>{evaluation.status ? `${evaluation.valid_readings || 0} valid saved readings · ${evaluation.usable_examples || 0} examples available for checking.` : 'Not enough evaluation information is available yet.'}</p>
            <div className="forecast-metrics-grid">
              {SENSORS.map(([key, label, unit]) => {
                const metrics = evaluation.targets?.[key];
                return <div className="forecast-metric" key={key}><b>{label}</b>
                  {metrics?.status === 'evaluated' ? <span>Model selected: {methodName(metrics.operational_model)}. Typical past miss: {displayValue(metrics.selected_metrics?.mae, key)} {unit}. Checked against {metrics.test_examples} later readings.</span>
                    : <span>{metrics?.reason || 'Not enough saved readings to check this estimate yet.'}</span>}
                </div>;
              })}
            </div>
          </details>

          <div className="forecast-chart-section">
            <div className="forecast-chart-heading"><div><h4>Past readings vs estimates</h4><p>Solid line = measured. Dashed line = earlier estimate.</p></div>
              <select aria-label="Forecast chart sensor" value={selected} onChange={event => setSelected(event.target.value)}>
                {SENSORS.map(([key, label]) => <option value={key} key={key}>{label}</option>)}
              </select>
            </div>
            <ForecastTrend sensor={sensor[0]} unit={sensor[2]} color={sensor[3]} readings={readings} forecasts={forecasts} />
            <small>If the dashed line is missing, no saved estimate is available for that time. ADC values are raw sensor counts, not calibrated physical units.</small>
          </div>

          <div className="forecast-actuals">
            <h4>How previous estimates compared</h4>
            {matched.length ? <div className="forecast-match-list">{matched.slice(-6).reverse().map(item => (
              <div className="forecast-match-row" key={item.id}>
                <b>Checked at {prettyTime(item.matched_at || item.target_at)}</b>
                <span>{SENSORS.map(([key, label, unit]) => `${label}: estimated ${displayValue(item.values?.[key], key)} ${unit}, measured ${displayValue(item.actual?.[key], key)} ${unit} (difference ${displayValue(item.errors?.[key], key)} ${unit})`).join(' · ')}</span>
            </div>))}</div> : <p>No estimates have reached their check time yet. Once later readings arrive, comparisons will appear here.</p>}
          </div>
          <details className="forecast-model-footer"><summary>Technical forecast details</summary><span>{modelSummary}</span><small>Forecast methods are compared with later sensor readings. These comparisons describe past results and cannot guarantee a future reading.</small></details>
          <button className="export-btn" type="button" onClick={onRefresh}>Refresh forecast</button>
        </>
      )}
    </section>
  );
}
