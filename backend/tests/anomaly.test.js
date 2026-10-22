const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_SETTINGS, median, getEnvironmentStatus, validateReading, validateSettings, createDetector } = require('../anomaly');

const normal = { temperature: 24, humidity: 50, light: 2100, airQuality: 300 };

test('validates sensor payloads and rejects missing, non-finite, and out-of-range values', () => {
  assert.equal(validateReading(normal).valid, true);
  assert.equal(validateReading({ ...normal, light: 5000 }).valid, false);
  assert.equal(validateReading({ ...normal, temperature: 'NaN' }).valid, false);
  assert.equal(validateReading({ ...normal, airQuality: undefined }).valid, false);
});

test('median handles even and odd sample counts', () => {
  assert.equal(median([8, 1, 3]), 3);
  assert.equal(median([8, 1, 3, 5]), 4);
  assert.equal(median([]), null);
});

test('environment status follows preferred ranges and gives a buffer around them', () => {
  const typical = { temperature: 27, humidity: 69, light: 2300, airQuality: 900 };
  assert.equal(getEnvironmentStatus(typical), 'Ideal');
  assert.equal(getEnvironmentStatus({ ...typical, humidity: 78 }), 'Moderate');
  assert.equal(getEnvironmentStatus({ ...typical, airQuality: 1800 }), 'Poor');
});

test('sustained deviations create one alert and normal readings resolve it', async () => {
  const baseline = Array.from({ length: 20 }, () => ({ ...normal }));
  const created = [];
  const resolved = [];
  let id = 0;
  const detector = createDetector({
    settings: { ...DEFAULT_SETTINGS, persistence: 3, cooldownMinutes: 15 },
    initialReadings: baseline,
    getLastAlertTime: () => null,
    createAlert: async value => { const alert = { ...value, id: ++id, status: 'active' }; created.push(alert); return alert; },
    resolveAlert: async alertId => resolved.push(alertId)
  });
  for (let i = 0; i < 2; i++) await detector.process({ ...normal, temperature: 31 });
  assert.equal(created.length, 0);
  await detector.process({ ...normal, temperature: 31 });
  assert.equal(created.length, 1);
  assert.match(created[0].reason, /rolling median/);
  for (let i = 0; i < 3; i++) await detector.process(normal);
  assert.deepEqual(resolved, [created[0].id]);
});

test('insufficient samples and invalid readings never raise an alert', async () => {
  const created = [];
  const detector = createDetector({
    settings: DEFAULT_SETTINGS,
    initialReadings: [],
    createAlert: async alert => { created.push(alert); return alert; }
  });
  const invalid = await detector.process({ ...normal, humidity: 101 });
  assert.equal(invalid.valid, false);
  for (let i = 0; i < 6; i++) await detector.process({ ...normal, temperature: 50 });
  assert.equal(created.length, 0);
});

test('settings input is bounded and requires ordered ranges', () => {
  assert.ok(validateSettings(DEFAULT_SETTINGS).value);
  assert.ok(validateSettings({ ...DEFAULT_SETTINGS, persistence: 1 }).error);
  assert.ok(validateSettings({ ...DEFAULT_SETTINGS, ranges: { ...DEFAULT_SETTINGS.ranges, light: { min: 3000, max: 1000 } } }).error);
});
