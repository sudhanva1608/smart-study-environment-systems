import { useState } from 'react';

const SENSOR_NAMES = {
  temperature: 'Temperature',
  humidity: 'Humidity',
  light: 'LDR ADC',
  airQuality: 'MQ135 ADC',
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
        <div className="settings-grid">
          <label>Sensitivity (1–10)<input type="number" min="1" max="10" step="0.1" value={values.sensitivity} onChange={e => change('sensitivity', e.target.value)} /></label>
          <label>Persistent readings (2–10)<input type="number" min="2" max="10" value={values.persistence} onChange={e => change('persistence', e.target.value)} /></label>
          <label>Cooldown minutes<input type="number" min="1" max="1440" value={values.cooldownMinutes} onChange={e => change('cooldownMinutes', e.target.value)} /></label>
        </div>
        <h5>Preferred sensor ranges</h5>
        <div className="settings-grid">
          {[
            ['temperature', 'Temperature °C'], ['humidity', 'Humidity %'],
            ['airQuality', 'MQ135 ADC'], ['light', 'LDR ADC']
          ].map(([key, label]) => (
            <fieldset key={key}>
              <legend>{label}</legend>
              <label>Min<input type="number" step="any" value={values.ranges[key].min} onChange={e => changeRange(key, 'min', e.target.value)} /></label>
              <label>Max<input type="number" step="any" value={values.ranges[key].max} onChange={e => changeRange(key, 'max', e.target.value)} /></label>
            </fieldset>
          ))}
        </div>
        <div className="settings-submit"><button className="export-btn" type="submit">Save settings</button><span>{saved}</span></div>
        <small>MQ135 is a relative ADC reading; LDR ADC polarity is not verified here. Configure those ranges from your own observed sensor values.</small>
      </form>
    </section>
  );
}
