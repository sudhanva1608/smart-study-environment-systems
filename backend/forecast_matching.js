const crypto = require('crypto');
const SENSOR_FIELDS = ['temperature', 'humidity', 'light', 'airQuality'];

function canMatchForecast(targetAt, actualAt, toleranceSeconds = 30) {
  const target = Date.parse(targetAt);
  const actual = Date.parse(actualAt);
  return Number.isFinite(target) && Number.isFinite(actual) && actual >= target &&
    actual - target <= toleranceSeconds * 1000;
}

function absoluteErrors(predicted, actual) {
  return Object.fromEntries(SENSOR_FIELDS.map(sensor => [sensor,
    Math.abs(Number(actual[sensor]) - Number(predicted[sensor]))]));
}

function sensorMessageKey(deviceId, deviceTimestamp) {
  if (typeof deviceId !== 'string' || !deviceId.trim() || deviceId.length > 200 ||
      deviceTimestamp === undefined || deviceTimestamp === null ||
      (typeof deviceTimestamp !== 'string' && typeof deviceTimestamp !== 'number') ||
      (typeof deviceTimestamp === 'number' && !Number.isFinite(deviceTimestamp)) ||
      (typeof deviceTimestamp === 'string' && (!deviceTimestamp.trim() || deviceTimestamp.length > 80))) return null;
  return crypto.createHash('sha256').update(`${deviceId}:${deviceTimestamp}`).digest('hex');
}

module.exports = { canMatchForecast, absoluteErrors, sensorMessageKey };
