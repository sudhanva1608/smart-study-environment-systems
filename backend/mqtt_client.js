const mqtt = require('mqtt');

function initMQTT(onTelemetryReceived) {
  const brokerUrl = process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com:1883';
  const topicTelemetry = process.env.MQTT_TOPIC_TELEMETRY || 'sses/sensors/telemetry';
  const topicActuator = process.env.MQTT_TOPIC_ACTUATOR || 'sses/actuators/leds';

  const options = {
    clientId: `SSES_Backend_${Math.random().toString(16).substring(2, 8)}`,
    keepalive: 60,
    reconnectPeriod: 3000,
    connectTimeout: 30 * 1000,
  };

  if (process.env.MQTT_USERNAME) {
    options.username = process.env.MQTT_USERNAME;
    options.password = process.env.MQTT_PASSWORD;
  }

  console.log(`[MQTT] 🔌 Connecting to MQTT Broker at ${brokerUrl}...`);
  const client = mqtt.connect(brokerUrl, options);

  let isConnected = false;

  client.on('connect', () => {
    isConnected = true;
    console.log(`[MQTT] ✅ Connected to Cloud MQTT Broker! Subscribing to: ${topicTelemetry}`);
    client.subscribe(topicTelemetry, (err) => {
      if (err) console.error('[MQTT] ❌ Subscription error:', err);
    });
  });

  client.on('message', (topic, payload) => {
    try {
      const data = JSON.parse(payload.toString());
      console.log(`[MQTT] 📡 Telemetry received on [${topic}]:`, data);
      if (onTelemetryReceived) {
        onTelemetryReceived(data);
      }
    } catch (err) {
      console.error('[MQTT] Failed to parse incoming MQTT payload:', err.message);
    }
  });

  client.on('error', (err) => {
    console.error('[MQTT] ❌ Connection error:', err.message);
  });

  client.on('offline', () => {
    isConnected = false;
    console.warn('[MQTT] ⚠️ Client went offline, attempting reconnect...');
  });

  function publishActuatorCommand(commandObj) {
    if (client && isConnected) {
      const payload = JSON.stringify(commandObj);
      client.publish(topicActuator, payload, { qos: 0 }, (err) => {
        if (!err) {
          console.log(`[MQTT] 📤 Actuator command published to [${topicActuator}]:`, payload);
        } else {
          console.error('[MQTT] ❌ Actuator publish error:', err);
        }
      });
    }
  }

  function getStatus() {
    return {
      connected: isConnected,
      broker: brokerUrl,
      topic: topicTelemetry
    };
  }

  return {
    client,
    publishActuatorCommand,
    getStatus
  };
}

module.exports = { initMQTT };
