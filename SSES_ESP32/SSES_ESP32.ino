/*
  Smart Study Environment Sensing System (SSES)
  ESP32 Firmware — MQTT & Cloud Edition

  Publishes sensor readings to Cloud MQTT Broker (HiveMQ Cloud / Mosquitto)
  over SSL/TLS on topic: sses/sensors/telemetry
  Subscribes to actuator topic: sses/actuators/leds

*/

#include "DHT.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

// ─── WiFi Config ─────────────────────────────────────────
const char* WIFI_SSID = "Excitel_2.4G No Internet";      // ← Replace with your WiFi name
const char* WIFI_PASS = "danzocmtrs";  // ← Replace with your WiFi password

// ─── MQTT Broker Config ──────────────────────────────────
// HiveMQ Cloud details (or local/public MQTT broker)
const char* MQTT_BROKER = "71fb498cb7b743f3941268421fa55d17.s1.eu.hivemq.cloud";
const int   MQTT_PORT   = 8883;
const char* MQTT_USER   = "sudhanva16";
const char* MQTT_PASS   = "Sudhu*123";      
const char* CLIENT_ID     = "ESP32_SSES_Node";

const char* TOPIC_TELEMETRY = "sses/sensors/telemetry";
const char* TOPIC_ACTUATOR  = "sses/actuators/leds";

// ─── Pin Definitions ──────────────────────────────────────
#define DHTPIN    4
#define DHTTYPE   DHT22
#define LDR_PIN   35
#define MQ135_PIN 34
#define GREEN_LED 18
#define YELLOW_LED 19
#define RED_LED   21

DHT dht(DHTPIN, DHTTYPE);

WiFiClientSecure espClient; 
PubSubClient mqttClient(espClient);

unsigned long lastMsgTime = 0;

// These preferred bands match the backend defaults. The backend also sends
// saved ranges over the existing actuator MQTT topic after each connection.
float temperatureMin = 24.0f, temperatureMax = 30.0f;
float humidityMin = 60.0f, humidityMax = 75.0f;
int lightMin = 2000, lightMax = 2500;
int airQualityMin = 0, airQualityMax = 1300;

// ─── Helper: Connect Wi-Fi ─────────────────────────────────
bool connectWiFi(uint32_t timeoutMs = 15000) {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < timeoutMs) {
    delay(250);
    Serial.print('.');
  }
  Serial.println();
  return WiFi.status() == WL_CONNECTED;
}

// ─── MQTT Callback (Receive messages from Cloud) ───────────
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message;
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  Serial.printf("📩 [MQTT Recv] Topic: %s | Payload: %s\n", topic, message.c_str());

  StaticJsonDocument<512> doc;
  DeserializationError err = deserializeJson(doc, message);
  if (err) {
    Serial.printf("❌ Actuator message JSON failed: %s\n", err.c_str());
    return;
  }
  if (doc.containsKey("ledOverride")) {
    const char* color = doc["ledOverride"];
    digitalWrite(GREEN_LED,  String(color) == "green"  ? HIGH : LOW);
    digitalWrite(YELLOW_LED, String(color) == "yellow" ? HIGH : LOW);
    digitalWrite(RED_LED,    String(color) == "red"    ? HIGH : LOW);
  }
  if (doc.containsKey("sensorRanges")) {
    JsonObject ranges = doc["sensorRanges"];
    JsonObject t = ranges["temperature"];
    JsonObject h = ranges["humidity"];
    JsonObject l = ranges["light"];
    JsonObject a = ranges["airQuality"];
    if (!t.isNull() && !h.isNull() && !l.isNull() && !a.isNull()) {
      float tMin = t["min"] | temperatureMin, tMax = t["max"] | temperatureMax;
      float hMin = h["min"] | humidityMin, hMax = h["max"] | humidityMax;
      int lMin = l["min"] | lightMin, lMax = l["max"] | lightMax;
      int aMin = a["min"] | airQualityMin, aMax = a["max"] | airQualityMax;
      if (tMin >= -40 && tMax <= 80 && tMin <= tMax &&
          hMin >= 0 && hMax <= 100 && hMin <= hMax &&
          lMin >= 0 && lMax <= 4095 && lMin <= lMax &&
          aMin >= 0 && aMax <= 4095 && aMin <= aMax) {
        temperatureMin = tMin; temperatureMax = tMax;
        humidityMin = hMin; humidityMax = hMax;
        lightMin = lMin; lightMax = lMax;
        airQualityMin = aMin; airQualityMax = aMax;
        Serial.printf("✅ Sensor ranges updated: T %.1f–%.1f, RH %.1f–%.1f, LDR %d–%d, MQ135 %d–%d. LEDs will use these ranges.\n",
                      temperatureMin, temperatureMax, humidityMin, humidityMax,
                      lightMin, lightMax, airQualityMin, airQualityMax);
      }
    }
  }
}

// ─── Reconnect to MQTT Broker ──────────────────────────────
void reconnectMQTT() {
  while (!mqttClient.connected()) {
    Serial.printf("🔌 Connecting to MQTT Broker (%s:%d)... ", MQTT_BROKER, MQTT_PORT);
    bool connected = false;
    if (strlen(MQTT_USER) > 0) {
      connected = mqttClient.connect(CLIENT_ID, MQTT_USER, MQTT_PASS);
    } else {
      connected = mqttClient.connect(CLIENT_ID);
    }

    if (connected) {
      Serial.println("✅ Connected to MQTT Broker!");
      mqttClient.subscribe(TOPIC_ACTUATOR);
      Serial.printf("📡 Subscribed to topic: %s\n", TOPIC_ACTUATOR);
    } else {
      Serial.printf("❌ MQTT Connect failed, rc=%d. Retrying in 5s...\n", mqttClient.state());
      delay(5000);
    }
  }
}

// ─── Setup ────────────────────────────────────────────────
void setup() {
  Serial.begin(115200);

  dht.begin();

  pinMode(GREEN_LED, OUTPUT);
  pinMode(YELLOW_LED, OUTPUT);
  pinMode(RED_LED, OUTPUT);

  if (!connectWiFi()) {
    Serial.println("⚠️ WiFi connection pending – will retry in main loop");
  }

  // Allow SSL connection to HiveMQ Cloud on port 8883
  espClient.setInsecure();

  mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);

}

// ─── Main Loop ────────────────────────────────────────────
void loop() {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("📶 Wi-Fi lost, reconnecting...");
    if (!connectWiFi()) {
      delay(5000);
      return;
    }
  }

  if (!mqttClient.connected()) {
    reconnectMQTT();
  }
  mqttClient.loop();

  unsigned long now = millis();
  if (now - lastMsgTime > 2000) { // Every 2 seconds
    lastMsgTime = now;

    // ── Read sensors ──────────────────────────────────────
    float temp = dht.readTemperature();
    float hum  = dht.readHumidity();
    int lightValue = analogRead(LDR_PIN);
    int airValue   = analogRead(MQ135_PIN);

    if (isnan(temp) || isnan(hum)) {
      Serial.println("❌ DHT read failed — skipping cycle");
      return;
    }

    // ── Rule-based environment status (same ranges as dashboard/backend) ──
    const char* status;
    bool withinPreferred = temp >= temperatureMin && temp <= temperatureMax &&
                           hum >= humidityMin && hum <= humidityMax &&
                           lightValue >= lightMin && lightValue <= lightMax &&
                           airValue >= airQualityMin && airValue <= airQualityMax;
    bool withinSoftBand = temp >= temperatureMin - (temperatureMax - temperatureMin) * 0.5f &&
                          temp <= temperatureMax + (temperatureMax - temperatureMin) * 0.5f &&
                          hum >= humidityMin - (humidityMax - humidityMin) * 0.5f &&
                          hum <= humidityMax + (humidityMax - humidityMin) * 0.5f &&
                          lightValue >= lightMin - (lightMax - lightMin) * 0.5f &&
                          lightValue <= lightMax + (lightMax - lightMin) * 0.5f &&
                          airValue >= airQualityMin - (airQualityMax - airQualityMin) * 0.5f &&
                          airValue <= airQualityMax + (airQualityMax - airQualityMin) * 0.5f;
    if (withinPreferred) {
      digitalWrite(GREEN_LED,  HIGH);
      digitalWrite(YELLOW_LED, LOW);
      digitalWrite(RED_LED,    LOW);
      status = "Ideal";
    } else if (withinSoftBand) {
      digitalWrite(GREEN_LED,  LOW);
      digitalWrite(YELLOW_LED, HIGH);
      digitalWrite(RED_LED,    LOW);
      status = "Moderate";
    } else {
      digitalWrite(GREEN_LED,  LOW);
      digitalWrite(YELLOW_LED, LOW);
      digitalWrite(RED_LED,    HIGH);
      status = "Poor";
    }

    StaticJsonDocument<256> doc;
    doc["temperature"]     = temp;
    doc["humidity"]        = hum;
    doc["light"]           = lightValue;
    doc["airQuality"]      = airValue;
    doc["status"]          = status;
    doc["deviceId"]        = CLIENT_ID;
    doc["timestamp"]       = millis();

    char payload[256];
    serializeJson(doc, payload);

    bool pubStatus = mqttClient.publish(TOPIC_TELEMETRY, payload);
    if (pubStatus) {
      Serial.printf("   [MQTT] 📡 Published to %s: %s\n", TOPIC_TELEMETRY, payload);
    } else {
      Serial.println("   [MQTT] ❌ Publish failed");
    }
  }
}
