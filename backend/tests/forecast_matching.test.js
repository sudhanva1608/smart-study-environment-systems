const test = require('node:test');
const assert = require('node:assert/strict');

const { canMatchForecast, absoluteErrors, sensorMessageKey } = require('../forecast_matching');

test('matches a forecast only with an actual reading at or shortly after its target', () => {
  const target = '2026-10-20T10:00:00.000Z';
  assert.equal(canMatchForecast(target, '2026-10-20T10:00:02.000Z'), true);
  assert.equal(canMatchForecast(target, '2026-10-20T09:59:59.000Z'), false);
  assert.equal(canMatchForecast(target, '2026-10-20T10:00:31.000Z'), false);
});

test('uses stable source identity for duplicate MQTT payloads and rejects missing identity', () => {
  assert.equal(sensorMessageKey('device-a', 1234), sensorMessageKey('device-a', 1234));
  assert.notEqual(sensorMessageKey('device-a', 1234), sensorMessageKey('device-a', 1235));
  assert.equal(sensorMessageKey('', 1234), null);
  assert.equal(sensorMessageKey('device-a', Infinity), null);
});

test('computes actual absolute errors for all forecast sensor values', () => {
  assert.deepEqual(absoluteErrors(
    { temperature: 25, humidity: 50, light: 2200, airQuality: 800 },
    { temperature: 26, humidity: 48, light: 2190, airQuality: 820 }
  ), { temperature: 1, humidity: 2, light: 10, airQuality: 20 });
});
