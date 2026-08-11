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

  StaticJsonDocument<256> doc;
  DeserializationError err = deserializeJson(doc, message);
  if (!err) {
    if (doc.containsKey("ledOverride")) {
      const char* color = doc["ledOverride"];
      digitalWrite(GREEN_LED,  String(color) == "green"  ? HIGH : LOW);
      digitalWrite(YELLOW_LED, String(color) == "yellow" ? HIGH : LOW);
      digitalWrite(RED_LED,    String(color) == "red"    ? HIGH : LOW);
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

    float temp = dht.readTemperature();
    float hum  = dht.readHumidity();
    int lightValue = analogRead(LDR_PIN);
    int airValue   = analogRead(MQ135_PIN);

    if (isnan(temp) || isnan(hum)) {
      Serial.println("❌ DHT read failed — skipping cycle");
      return;
    }

    const char* status;
    if (temp >= 20 && temp <= 28 && hum >= 40 && hum <= 65 && lightValue < 3500 && airValue < 350) {
      digitalWrite(GREEN_LED,  HIGH);
      digitalWrite(YELLOW_LED, LOW);
      digitalWrite(RED_LED,    LOW);
      status = "Ideal";
    } else if ((temp > 28 && temp <= 32) || (hum > 65 && hum <= 75) || (airValue >= 350 && airValue < 500)) {
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
    doc["temperature"] = temp;
    doc["humidity"]    = hum;
    doc["light"]       = lightValue;
    doc["airQuality"]  = airValue;
    doc["status"]      = status;
    doc["deviceId"]    = CLIENT_ID;
    doc["timestamp"]   = millis();

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