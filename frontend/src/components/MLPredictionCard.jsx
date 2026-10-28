import { useState } from 'react';

const SENSOR_NAMES = {
  temperature: 'Temperature',
  humidity: 'Humidity',
  light: 'Room brightness',
  airQuality: 'Air quality sensor',
};

function AlertItem({ alert, onAcknowledge }) {
  return (
    <article className={`alert-item alert-${alert.severity || 'warning'}`}>
      <div className="alert-item-heading">
        <strong>{SENSOR_NAMES[alert.sensor] || alert.sensor}</strong>
        <span className="alert-state">{alert.status}</span>
      </div>
      <p>{alert.reason}</p>
      <p className="alert-action"><b>Suggested action:</b> {alert.action}</p>
      <small>{new Date(alert.created_at).toLocaleString()}</small>
      {alert.status === 'active' && (
        <button className="btn-led" onClick={() => onAcknowledge(alert.id)}>Acknowledge</button>
      )}
    </article>
  );
}

export default function MLPredictionCard({ recommendations = [], alerts = [], settings, settingsError = '', onAcknowledge, onSaveSettings }) {
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState('');
  const [filter, setFilter] = useState('active');
  const values = form || settings;

  if (!values) return (
    <section className="ml-prediction-section fade-in">
      <div className="ml-header">
        <div><h3>Recommendations &amp; Sensor Alerts</h3><span className="ml-subtitle">Rule based guidance from validated sensor readings.</span></div>
        <span className="ml-live-chip">Monitoring offline</span>
      </div>
      <div className={settingsError ? 'data-warning' : 'recommendation-box'} role={settingsError ? 'alert' : 'status'}>
        {settingsError || 'Loading saved monitoring settings…'}
      </div>
      <p className="ui-fallback-note">This panel needs the project backend’s monitoring API to load recommendations, alerts and editable ranges. Sensor charts remain available while it reconnects.</p>
    </section>
  );

  const change = (key, value) => setForm(current => ({ ...(current || settings), [key]: value }));
  const changeRange = (key, field, value) => setForm(current => ({
    ...(current || settings),
    ranges: { ...(current || settings).ranges, [key]: { ...(current || settings).ranges[key], [field]: value } }
  }));
  const shownAlerts = alerts.filter(alert => filter === 'active' ? alert.status !== 'resolved' : alert.status === 'resolved');

  const save = async event => {
    event.preventDefault();
    setSaved('');
    try {
      const updated = await onSaveSettings({
        ...values,
        sensitivity: Number(values.sensitivity),
        persistence: Number(values.persistence),
        cooldownMinutes: Number(values.cooldownMinutes),
        ranges: Object.fromEntries(Object.entries(values.ranges).map(([key, range]) =>
          [key, { min: Number(range.min), max: Number(range.max) }]))
      });
      if (updated) setForm(updated);
      setSaved('Settings saved.');
    } catch (error) { setSaved(error.message || 'Could not save settings.'); }
  };

  return (
    <section className="ml-prediction-section">
      <div className="ml-header">
        <div>
          <h3>Recommendations &amp; Sensor Alerts</h3>
          <span className="ml-subtitle">Rule based guidance from validated sensor readings; alerts indicate deviations, not automatic danger.</span>
        </div>
        <span className="ml-live-chip">Rolling median + MAD</span>
      </div>

      <div className="recommendation-list">
        {recommendations.map((item, index) => (
          <div className="recommendation-box" key={item.sensor || index}>
            <div className="recommendation-content">
              <h4>{item.sensor ? SENSOR_NAMES[item.sensor] : 'Within preferred ranges'}</h4>
              <p>{item.reason}</p>
              <p className="alert-action"><b>Suggested action:</b> {item.action}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="alert-toolbar">
        <h4>Recorded alerts</h4>
        <div>
          <button className={filter === 'active' ? 'alert-filter active' : 'alert-filter'} onClick={() => setFilter('active')}>Active</button>
          <button className={filter === 'resolved' ? 'alert-filter active' : 'alert-filter'} onClick={() => setFilter('resolved')}>Resolved</button>
        </div>
      </div>
      {shownAlerts.length ? (
        <div className="alert-list">{shownAlerts.map(alert => <AlertItem key={alert.id} alert={alert} onAcknowledge={onAcknowledge} />)}</div>
      ) : <p className="empty-alerts">No {filter} alerts recorded.</p>}

      <form className="monitor-settings" onSubmit={save}>
        <h4>Monitoring settings</h4>
        <p className="settings-intro">These settings control when readings raise alerts and which status appears on the dashboard and LEDs.</p>
        <div className="settings-grid">
          <label><span>Alert sensitivity (1–10)</span><input type="number" min="1" max="10" step="0.1" value={values.sensitivity} onChange={e => change('sensitivity', e.target.value)} /><small className="setting-help">Higher values ignore small changes; lower values catch them sooner.</small></label>
          <label><span>Unusual readings to trigger an alert (2–10)</span><input type="number" min="2" max="10" value={values.persistence} onChange={e => change('persistence', e.target.value)} /><small className="setting-help">An alert waits for this many unusual readings in a row.</small></label>
          <label><span>Wait before repeating an alert (minutes)</span><input type="number" min="1" max="1440" value={values.cooldownMinutes} onChange={e => change('cooldownMinutes', e.target.value)} /><small className="setting-help">Prevents the same sensor from sending alerts too often.</small></label>
        </div>
        <h5>Preferred sensor ranges</h5>
        <p className="settings-intro">Readings inside a range count as Normal (green). Small misses are Moderate (yellow); large misses are Poor (red).</p>
        <div className="settings-grid">
          {[
            ['temperature', 'Room temperature (°C)', 'Comfortable temperature for your room.'],
            ['humidity', 'Air moisture (%)', 'Comfortable amount of moisture in the air.'],
            ['airQuality', 'Air quality sensor', 'Sensor readings that count as normal.'],
            ['light', 'Room brightness sensor', 'Brightness readings that count as normal.']
          ].map(([key, label, description]) => (
            <fieldset key={key}>
              <legend>{label}</legend>
              <small className="setting-help">{description}</small>
              <label>Lower<input type="number" step="any" value={values.ranges[key].min} onChange={e => changeRange(key, 'min', e.target.value)} /></label>
              <label>Upper<input type="number" step="any" value={values.ranges[key].max} onChange={e => changeRange(key, 'max', e.target.value)} /></label>
            </fieldset>
          ))}
        </div>
        <div className="settings-submit"><button className="export-btn" type="submit">Save settings</button><span>{saved}</span></div>
        <small>Air quality and brightness use raw sensor readings. Their typical values depend on your sensor and room.</small>
      </form>
    </section>
  );
}
