const DEFAULT_SETTINGS = Object.freeze({
  sensitivity: 3.5,
  persistence: 3,
  cooldownMinutes: 15,
  ranges: {
    // Preferred bands centered around the most common values in the local
    // 500-reading baseline (T≈27°C, RH≈69%, LDR≈2900, MQ135≈900 ADC).
    temperature: { min: 24, max: 30 },
    humidity: { min: 60, max: 75 },
    airQuality: { min: 0, max: 1300 },
    light: { min: 2000, max: 2500 }
  }
});

const METRICS = {
  temperature: { label: 'Temperature', floor: 1.5, unit: '°C', action: 'Check room temperature and adjust ventilation or the fan if needed.' },
  humidity: { label: 'Humidity', floor: 5, unit: '%', action: 'Check room ventilation and monitor humidity.' },
  light: { label: 'LDR ADC', floor: 150, unit: ' ADC', action: 'Compare this LDR ADC reading with a known comfortable lighting setup; ADC direction is hardware dependent.' },
  airQuality: { label: 'MQ135 ADC', floor: 50, unit: ' ADC', action: 'Ventilate the room and recheck the relative MQ135 ADC reading; it is not calibrated to ppm.' }
};

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function getEnvironmentStatus(reading, ranges = DEFAULT_SETTINGS.ranges) {
  const sensors = ['temperature', 'humidity', 'light', 'airQuality'];
  const outside = sensors.filter(sensor => {
    const value = Number(reading?.[sensor]);
    const range = ranges[sensor];
    return !Number.isFinite(value) || value < range.min || value > range.max;
  });
  if (!outside.length) return 'Ideal';

  // A modest buffer avoids calling a near-boundary reading "Poor". This is a
  // study-environment status, not a health or air-safety classification.
  const beyondSoftBand = outside.some(sensor => {
    const value = Number(reading[sensor]);
    const { min, max } = ranges[sensor];
    const margin = Math.max((max - min) * 0.5, 1);
    return value < min - margin || value > max + margin;
  });
  return beyondSoftBand ? 'Poor' : 'Moderate';
}

function validateReading(input) {
  const aliases = { temperature: ['temperature'], humidity: ['humidity'], light: ['light'], airQuality: ['airQuality', 'air_quality', 'mq135'] };
  const value = {};
  for (const [key, names] of Object.entries(aliases)) {
    const raw = names.map(name => input?.[name]).find(item => item !== undefined && item !== null);
    if (raw === undefined || (typeof raw === 'string' && raw.trim() === '')) return { valid: false, reason: 'Missing ' + key };
    const n = Number(raw);
    if (!Number.isFinite(n)) return { valid: false, reason: key + ' must be a finite number' };
    value[key] = n;
  }
  const bounds = { temperature: [-40, 80], humidity: [0, 100], light: [0, 4095], airQuality: [0, 4095] };
  for (const [key, [min, max]] of Object.entries(bounds)) {
    if (value[key] < min || value[key] > max) return { valid: false, reason: key + ' is outside the supported sensor range' };
  }
  return { valid: true, value };
}

function validateSettings(input) {
  const sensitivity = Number(input?.sensitivity);
  const persistence = Number(input?.persistence);
  const cooldownMinutes = Number(input?.cooldownMinutes);
  if (!Number.isFinite(sensitivity) || sensitivity < 1 || sensitivity > 10) return { error: 'Sensitivity must be between 1 and 10.' };
  if (!Number.isInteger(persistence) || persistence < 2 || persistence > 10) return { error: 'Persistence must be between 2 and 10 readings.' };
  if (!Number.isFinite(cooldownMinutes) || cooldownMinutes < 1 || cooldownMinutes > 1440) return { error: 'Cooldown must be between 1 and 1440 minutes.' };
  const ranges = {};
  for (const [key, bounds] of Object.entries({ temperature: [-40, 80], humidity: [0, 100], airQuality: [0, 4095], light: [0, 4095] })) {
    const min = Number(input?.ranges?.[key]?.min);
    const max = Number(input?.ranges?.[key]?.max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min < bounds[0] || max > bounds[1] || min > max) {
      return { error: 'Check the preferred range for ' + key + '.' };
    }
    ranges[key] = { min, max };
  }
  return { value: { sensitivity, persistence, cooldownMinutes, ranges } };
}

function getRecommendations(reading, settings) {
  const recommendations = [];
  const checks = [
    ['temperature', 'Temperature', '°C', 'Adjust room temperature or ventilation.'],
    ['humidity', 'Humidity', '%', 'Check ventilation and monitor humidity.'],
    ['airQuality', 'MQ135 raw ADC', ' ADC', 'Ventilate and recheck; this is a relative sensor reading, not ppm.'],
    ['light', 'LDR raw ADC', ' ADC', 'Compare with a comfortable lighting setup; ADC direction depends on the circuit.']
  ];
  for (const [key, label, unit, action] of checks) {
    const value = reading[key];
    const range = settings.ranges[key];
    if (value < range.min || value > range.max) {
      recommendations.push({
        sensor: key, observedValue: value, reason: label + ' ' + value + unit + ' is outside your preferred range ' + range.min + '–' + range.max + unit + '.',
        action
      });
    }
  }
  if (!recommendations.length) recommendations.push({
    sensor: null, observedValue: null,
    reason: 'Current validated readings are within the configured preferred ranges.',
    action: 'Continue monitoring; MQ135 and LDR values are raw ADC readings.'
  });
  return recommendations;
}

function createDetector({ settings = DEFAULT_SETTINGS, initialReadings = [], activeAlerts = [], getLastAlertTime = () => null, createAlert = async alert => alert, resolveAlert = async () => {} } = {}) {
  const windowSize = 120;
  const minimumSamples = 12;
  const state = Object.fromEntries(Object.keys(METRICS).map(sensor => [sensor, { samples: [], deviations: 0, normals: 0 }]));
  const activeBySensor = new Map(activeAlerts.map(alert => [alert.sensor, alert]));

  function addToWindow(sensor, value) {
    const samples = state[sensor].samples;
    samples.push(value);
    if (samples.length > windowSize) samples.shift();
  }
  for (const row of initialReadings) {
    const checked = validateReading({ ...row, airQuality: row.airQuality ?? row.air_quality });
    if (checked.valid) for (const sensor of Object.keys(METRICS)) addToWindow(sensor, checked.value[sensor]);
  }

  async function process(reading, now = new Date()) {
    const checked = validateReading(reading);
    if (!checked.valid) return { valid: false, reason: checked.reason, created: [], resolved: [], anomalies: [], recommendations: [] };
    const value = checked.value, created = [], resolved = [], anomalies = [];
    for (const [sensor, meta] of Object.entries(METRICS)) {
      const tracker = state[sensor];
      if (tracker.samples.length >= minimumSamples) {
        const baseline = median(tracker.samples);
        const deviations = tracker.samples.map(sample => Math.abs(sample - baseline));
        const mad = median(deviations);
        const threshold = Math.max(settings.sensitivity * 1.4826 * (mad || 0), meta.floor);
        const distance = Math.abs(value[sensor] - baseline);
        const outside = distance > threshold;
        const existing = activeBySensor.get(sensor);
        if (outside) {
          tracker.deviations += 1; tracker.normals = 0;
          if (tracker.deviations >= settings.persistence) {
            const reason = sensor + ' stayed ' + distance.toFixed(2) + meta.unit + ' from rolling median ' + baseline.toFixed(2) + meta.unit + ' for ' + tracker.deviations + ' consecutive readings (threshold ' + threshold.toFixed(2) + meta.unit + '; MAD ' + mad.toFixed(2) + ').';
            anomalies.push({ sensor, observedValue: value[sensor], baseline, threshold, mad, reason });
            if (!existing) {
              const lastAt = await getLastAlertTime(sensor);
              const cooled = !lastAt || now.getTime() - new Date(lastAt).getTime() >= settings.cooldownMinutes * 60000;
              if (cooled) {
                const alert = await createAlert({
                  created_at: now.toISOString(), sensor, observed_value: value[sensor], baseline,
                  reason, severity: distance > threshold * 2 ? 'high' : 'warning', action: meta.action
                });
                activeBySensor.set(sensor, alert); created.push(alert);
              }
            }
          }
        } else {
          tracker.deviations = 0;
          if (existing) {
            tracker.normals += 1;
            if (tracker.normals >= settings.persistence) {
              await resolveAlert(existing.id);
              activeBySensor.delete(sensor);
              tracker.normals = 0;
              resolved.push(existing.id);
            }
          } else tracker.normals = 0;
        }
      }
      addToWindow(sensor, value[sensor]);
    }
    return { valid: true, created, resolved, anomalies, recommendations: getRecommendations(value, settings) };
  }
  return { process, activeAlerts: () => [...activeBySensor.values()] };
}

module.exports = { DEFAULT_SETTINGS, METRICS, median, getEnvironmentStatus, validateReading, validateSettings, getRecommendations, createDetector };
