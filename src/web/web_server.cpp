/*
 * SparkMiner - Synchronous Web Server & REST API Implementation
 *
 * Uses the core ESP32 WebServer (synchronous) driven by a dedicated
 * FreeRTOS task on core 0. This mirrors the known-working BurtonMiner
 * approach: the async stack (ESPAsyncWebServer/AsyncTCP) would start but
 * its task got starved by mining and never served requests on this board.
 *
 * GPL v3 License
 */

#if defined(USE_WEB_SERVER) && USE_WEB_SERVER

#include <Arduino.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include <Update.h>

#include "web_server.h"
#include "index_html.h"
#include <board_config.h>
#include "../mining/miner.h"
#include "../stratum/stratum.h"
#include "../stratum/stratum_types.h"
#include "../stats/monitor.h"
#include "../config/nvs_config.h"
#include "../config/wifi_manager.h"
#include "../display/display.h"

// Synchronous web server on port 80, driven by s_webTask via handleClient().
static WebServer s_server(80);
static bool s_running = false;
static bool s_routesRegistered = false;
static TaskHandle_t s_webTask = NULL;

// Reject new requests when free heap is low, to avoid OOM reboots.
#define WEB_MIN_FREE_HEAP 30000  // bytes
static bool webHeapLow() {
    return ESP.getFreeHeap() < WEB_MIN_FREE_HEAP;
}

static void safeStrCpy(char *dest, const char *src, size_t maxLen) {
    if (src) {
        strncpy(dest, src, maxLen - 1);
        dest[maxLen - 1] = '\0';
    } else {
        dest[0] = '\0';
    }
}

// Authentication against adminPassword in NVS. Empty password = auth disabled.
static bool isAuthorized(const miner_config_t *config) {
    if (!config || config->adminPassword[0] == '\0') {
        return true;
    }
    if (s_server.hasHeader("X-Auth") && s_server.header("X-Auth") == config->adminPassword) {
        return true;
    }
    if (s_server.hasArg("auth") && s_server.arg("auth") == config->adminPassword) {
        return true;
    }
    if (s_server.hasArg("password") && s_server.arg("password") == config->adminPassword) {
        return true;
    }
    return false;
}

// Basic anti-hammering rate limiter (min 300ms between state-changing POSTs).
static bool isRateLimited() {
    uint32_t now = millis();
    static uint32_t s_lastPostTime = 0;
    if (now >= s_lastPostTime && (now - s_lastPostTime) < 300) {
        return true;
    }
    s_lastPostTime = now;
    return false;
}

static void formatNetworkDifficulty(double diff, char *buffer, size_t size) {
    if (diff >= 1e12) {
        snprintf(buffer, size, "%.2f T", diff / 1e12);
    } else if (diff >= 1e9) {
        snprintf(buffer, size, "%.2f G", diff / 1e9);
    } else if (diff >= 1e6) {
        snprintf(buffer, size, "%.2f M", diff / 1e6);
    } else if (diff > 0.0) {
        snprintf(buffer, size, "%.2f", diff);
    } else {
        snprintf(buffer, size, "0.00");
    }
}

static void sendJson(int code, const JsonDocument &doc) {
    String out;
    serializeJson(doc, out);
    s_server.sendHeader("Access-Control-Allow-Origin", "*");
    s_server.sendHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    s_server.send(code, "application/json", out);
}

// GET /api/stats - real-time telemetry
static void handleApiStats() {
    if (webHeapLow()) {
        s_server.send(503, "application/json", "{\"error\":\"Low memory\"}");
        return;
    }

    mining_stats_t *mstats = miner_get_stats();
    mining_persistence_t *pstats = nvs_stats_get();
    miner_config_t *config = nvs_config_get();

    double hashrate = monitor_get_hashrate();

    uint32_t now = millis();
    uint32_t sessionMs = (mstats->startTime > 0 && now >= mstats->startTime) ? (now - mstats->startTime) : 0;
    double hashrate_raw = (sessionMs >= 1000) ? ((double)mstats->hashes * 1000.0 / (double)sessionMs) : hashrate;

    uint32_t accepted = pstats->lifetimeAccepted + mstats->accepted;
    uint32_t rejected = pstats->lifetimeRejected + mstats->rejected;
    uint32_t blocks = pstats->lifetimeBlocks + mstats->blocks;
    double bestDiff = (mstats->bestDifficulty > pstats->bestDifficultyEver)
                      ? mstats->bestDifficulty : pstats->bestDifficultyEver;

    bool poolConnected = stratum_is_connected();
    const char *poolUrl = stratum_get_pool();
    if (!poolUrl || poolUrl[0] == '\0') {
        poolUrl = config->poolUrl;
    }
    double poolDiff = miner_get_difficulty();
    bool isBackup = stratum_is_backup();
    uint32_t latency = mstats->avgLatency;

    char userStr[160];
    if (config->workerName[0] != '\0' && config->wallet[0] != '\0') {
        snprintf(userStr, sizeof(userStr), "%s.%s", config->wallet, config->workerName);
    } else if (config->wallet[0] != '\0') {
        snprintf(userStr, sizeof(userStr), "%s", config->wallet);
    } else {
        snprintf(userStr, sizeof(userStr), "anonymous");
    }

    uint32_t blockHeight = 0;
    double networkDifficulty = 0.0;
    stratum_get_network_info(&blockHeight, &networkDifficulty);
    char netDiffFormatted[32];
    formatNetworkDifficulty(networkDifficulty, netDiffFormatted, sizeof(netDiffFormatted));

    uint32_t uptime = now / 1000;
    uint32_t freeHeap = ESP.getFreeHeap();
    uint32_t minFreeHeap = ESP.getMinFreeHeap();
    int8_t rssi = (WiFi.status() == WL_CONNECTED) ? WiFi.RSSI() : 0;
    const char *ip = wifi_manager_get_ip();
    const char *minerName = (config->workerName[0] != '\0') ? config->workerName : MINER_NAME;
    uint32_t cpuMhz = getCpuFrequencyMhz();

    StaticJsonDocument<1024> doc;
    doc["hashrate"] = hashrate;
    doc["hashrate_raw"] = hashrate_raw;
    doc["hashes_total"] = pstats->lifetimeHashes + mstats->hashes;
    doc["hashes_session"] = mstats->hashes;

    JsonObject poolObj = doc.createNestedObject("pool");
    poolObj["url"] = poolUrl;
    poolObj["connected"] = poolConnected;
    poolObj["user"] = userStr;
    poolObj["diff"] = poolDiff;
    poolObj["is_backup"] = isBackup;
    poolObj["latency"] = latency;

    JsonObject sharesObj = doc.createNestedObject("shares");
    sharesObj["accepted"] = accepted;
    sharesObj["rejected"] = rejected;
    sharesObj["best_diff"] = bestDiff;
    sharesObj["session_accepted"] = mstats->accepted;
    sharesObj["session_rejected"] = mstats->rejected;
    sharesObj["blocks"] = blocks;

    JsonObject netObj = doc.createNestedObject("network");
    netObj["block_height"] = blockHeight;
    netObj["difficulty"] = networkDifficulty;
    netObj["difficulty_formatted"] = netDiffFormatted;

    JsonObject sysObj = doc.createNestedObject("system");
    sysObj["uptime"] = uptime;
    sysObj["free_heap"] = freeHeap;
    sysObj["min_free_heap"] = minFreeHeap;
    sysObj["wifi_rssi"] = rssi;
    sysObj["ip"] = ip;
    sysObj["firmware_version"] = AUTO_VERSION;
    sysObj["miner_name"] = minerName;
    sysObj["cpu_mhz"] = cpuMhz;

    sendJson(200, doc);
}

// GET /api/config - configuration without secrets
static void handleApiConfigGet() {
    if (webHeapLow()) {
        s_server.send(503, "application/json", "{\"error\":\"Low memory\"}");
        return;
    }
    miner_config_t *config = nvs_config_get();
    StaticJsonDocument<768> doc;

    doc["poolUrl"] = config->poolUrl;
    doc["poolPort"] = config->poolPort;
    doc["wallet"] = config->wallet;
    doc["workerName"] = config->workerName;
    doc["poolPassword"] = (config->poolPassword[0] != '\0') ? "****" : "";
    doc["backupPoolUrl"] = config->backupPoolUrl;
    doc["backupPoolPort"] = config->backupPoolPort;
    doc["backupWallet"] = config->backupWallet;
    doc["backupPoolPassword"] = (config->backupPoolPassword[0] != '\0') ? "****" : "";
    doc["brightness"] = config->brightness;
    doc["screenTimeout"] = config->screenTimeout;
    doc["rotation"] = config->rotation;
    doc["displayEnabled"] = config->displayEnabled;
    doc["invertColors"] = config->invertColors;
    doc["timezoneOffset"] = config->timezoneOffset;
    doc["targetDifficulty"] = config->targetDifficulty;
    doc["statsEnabled"] = config->statsEnabled;
    doc["adminPasswordSet"] = (config->adminPassword[0] != '\0');

    sendJson(200, doc);
}

// POST /api/config - authenticated config update with validation & wear leveling
static void handleApiConfigPost() {
    miner_config_t *config = nvs_config_get();
    if (!isAuthorized(config)) {
        s_server.send(401, "application/json", "{\"error\":\"Unauthorized\",\"message\":\"Invalid or missing admin password\"}");
        return;
    }
    if (isRateLimited()) {
        s_server.send(429, "application/json", "{\"error\":\"Too Many Requests\"}");
        return;
    }

    bool changed = false;
    bool poolChanged = false;
    bool displayChanged = false;

    if (s_server.hasArg("poolUrl")) {
        String val = s_server.arg("poolUrl"); val.trim();
        if (val.length() > 0 && val.length() <= MAX_POOL_URL_LEN && val != config->poolUrl) {
            safeStrCpy(config->poolUrl, val.c_str(), sizeof(config->poolUrl));
            changed = true; poolChanged = true;
        }
    }
    if (s_server.hasArg("poolPort")) {
        int val = s_server.arg("poolPort").toInt();
        if (val >= 1 && val <= 65535 && val != config->poolPort) {
            config->poolPort = val; changed = true; poolChanged = true;
        }
    }
    if (s_server.hasArg("wallet")) {
        String val = s_server.arg("wallet"); val.trim();
        if (val.length() > 0 && val.length() <= MAX_WALLET_LEN && val != config->wallet) {
            safeStrCpy(config->wallet, val.c_str(), sizeof(config->wallet));
            changed = true; poolChanged = true;
        }
    }
    if (s_server.hasArg("workerName")) {
        String val = s_server.arg("workerName"); val.trim();
        if (val.length() <= 31 && val != config->workerName) {
            safeStrCpy(config->workerName, val.c_str(), sizeof(config->workerName));
            changed = true; poolChanged = true;
        }
    }
    if (s_server.hasArg("poolPassword")) {
        String val = s_server.arg("poolPassword");
        if (val != "****" && val.length() <= MAX_PASSWORD_LEN && val != config->poolPassword) {
            safeStrCpy(config->poolPassword, val.c_str(), sizeof(config->poolPassword));
            changed = true; poolChanged = true;
        }
    }
    if (s_server.hasArg("backupPoolUrl")) {
        String val = s_server.arg("backupPoolUrl"); val.trim();
        if (val.length() <= MAX_POOL_URL_LEN && val != config->backupPoolUrl) {
            safeStrCpy(config->backupPoolUrl, val.c_str(), sizeof(config->backupPoolUrl));
            changed = true;
        }
    }
    if (s_server.hasArg("backupPoolPort")) {
        int val = s_server.arg("backupPoolPort").toInt();
        if (val >= 0 && val <= 65535 && val != config->backupPoolPort) {
            config->backupPoolPort = val; changed = true;
        }
    }
    if (s_server.hasArg("brightness")) {
        int val = s_server.arg("brightness").toInt();
        if (val >= 0 && val <= 100 && val != config->brightness) {
            config->brightness = val; changed = true; displayChanged = true;
        }
    }
    if (s_server.hasArg("rotation")) {
        int val = s_server.arg("rotation").toInt();
        if (val >= 0 && val <= 3 && val != config->rotation) {
            config->rotation = val; changed = true; displayChanged = true;
        }
    }
    if (s_server.hasArg("invertColors")) {
        String s = s_server.arg("invertColors");
        bool val = (s == "1" || s == "true");
        if (val != config->invertColors) {
            config->invertColors = val; changed = true; displayChanged = true;
        }
    }
    if (s_server.hasArg("timezoneOffset")) {
        int val = s_server.arg("timezoneOffset").toInt();
        if (val >= -12 && val <= 14 && val != config->timezoneOffset) {
            config->timezoneOffset = val; changed = true;
        }
    }
    if (s_server.hasArg("screenTimeout")) {
        int val = s_server.arg("screenTimeout").toInt();
        if (val >= 0 && val <= 3600 && val != config->screenTimeout) {
            config->screenTimeout = val; changed = true;  // applied live by monitor
        }
    }
    if (s_server.hasArg("newAdminPassword")) {
        String val = s_server.arg("newAdminPassword");
        if (val.length() <= 32 && val != config->adminPassword) {
            safeStrCpy(config->adminPassword, val.c_str(), sizeof(config->adminPassword));
            changed = true;
        }
    }

    if (changed) {
        nvs_config_save(config);
        if (displayChanged) {
            #if (USE_DISPLAY || USE_OLED_DISPLAY || USE_EINK_DISPLAY)
            display_set_brightness(config->brightness);
            display_set_rotation(config->rotation);
            display_set_inverted(config->invertColors);
            #endif
        }
        if (poolChanged) {
            stratum_set_pool(config->poolUrl, config->poolPort, config->wallet, config->poolPassword, config->workerName);
            stratum_reconnect();
        }
    }

    StaticJsonDocument<256> respDoc;
    respDoc["status"] = "ok";
    respDoc["message"] = changed ? "Configuration saved" : "No changes detected";
    respDoc["changed"] = changed;
    respDoc["reconnected"] = poolChanged;
    sendJson(200, respDoc);
}

// POST /api/name - authenticated quick rename
static void handleApiNamePost() {
    miner_config_t *config = nvs_config_get();
    if (!isAuthorized(config)) {
        s_server.send(401, "application/json", "{\"error\":\"Unauthorized\"}");
        return;
    }
    if (isRateLimited()) {
        s_server.send(429, "application/json", "{\"error\":\"Too Many Requests\"}");
        return;
    }

    String newName = "";
    if (s_server.hasArg("value")) newName = s_server.arg("value");
    else if (s_server.hasArg("name")) newName = s_server.arg("name");
    newName.trim();

    if (newName.length() > 0 && newName.length() <= 31) {
        if (newName != config->workerName) {
            safeStrCpy(config->workerName, newName.c_str(), sizeof(config->workerName));
            nvs_config_save(config);
            stratum_set_pool(config->poolUrl, config->poolPort, config->wallet, config->poolPassword, config->workerName);
            stratum_reconnect();
        }
        StaticJsonDocument<128> doc;
        doc["status"] = "ok";
        doc["workerName"] = config->workerName;
        sendJson(200, doc);
    } else {
        s_server.send(400, "application/json", "{\"error\":\"Invalid worker name\"}");
    }
}

// POST /update - OTA firmware upload (final response handler)
static void handleOtaDone() {
    miner_config_t *config = nvs_config_get();
    if (!isAuthorized(config)) {
        s_server.send(401, "application/json", "{\"error\":\"Unauthorized\"}");
        return;
    }
    bool ok = !Update.hasError();
    String msg = ok ? "OK: Firmware updated. Rebooting..."
                    : (String("FAIL: ") + Update.errorString());
    s_server.sendHeader("Connection", "close");
    s_server.send(ok ? 200 : 500, "text/plain", msg);
    if (ok) {
        delay(150);
        ESP.restart();
    }
}

// POST /update - OTA upload chunk handler
static void handleOtaUpload() {
    HTTPUpload &upload = s_server.upload();
    miner_config_t *config = nvs_config_get();
    if (!isAuthorized(config)) {
        return;  // final handler returns 401
    }
    if (upload.status == UPLOAD_FILE_START) {
        Serial.printf("[OTA] Update started: %s\n", upload.filename.c_str());
        if (!Update.begin(UPDATE_SIZE_UNKNOWN, U_FLASH)) {
            Update.printError(Serial);
        }
    } else if (upload.status == UPLOAD_FILE_WRITE) {
        if (!Update.hasError()) {
            if (Update.write(upload.buf, upload.currentSize) != upload.currentSize) {
                Update.printError(Serial);
            }
        }
    } else if (upload.status == UPLOAD_FILE_END) {
        if (Update.end(true)) {
            Serial.printf("[OTA] Update success: %u bytes\n", upload.totalSize);
        } else {
            Update.printError(Serial);
        }
    }
}

// Dedicated task on core 0 that pumps the synchronous server.
static void webServerTask(void *param) {
    Serial.printf("[WEB] Server task on core %d\n", xPortGetCoreID());
    for (;;) {
        s_server.handleClient();
        vTaskDelay(pdMS_TO_TICKS(5));  // yield to mining/other tasks
    }
}

void web_server_init() {
    if (s_running) {
        return;
    }

    if (!s_routesRegistered) {
        // Custom headers we want readable (WebServer ignores others by default)
        static const char *headerKeys[] = {"X-Auth"};
        s_server.collectHeaders(headerKeys, 1);

        s_server.on("/", HTTP_GET, []() {
            if (webHeapLow()) {
                s_server.send(503, "text/plain", "Low memory - try again shortly");
                return;
            }
            s_server.send_P(200, "text/html", INDEX_HTML);
        });
        s_server.on("/api/stats", HTTP_GET, handleApiStats);
        s_server.on("/api/config", HTTP_GET, handleApiConfigGet);
        s_server.on("/api/config", HTTP_POST, handleApiConfigPost);
        s_server.on("/api/name", HTTP_POST, handleApiNamePost);
        s_server.on("/update", HTTP_POST, handleOtaDone, handleOtaUpload);
        s_server.onNotFound([]() {
            s_server.send(404, "application/json", "{\"error\":\"Not Found\"}");
        });
        s_routesRegistered = true;
    }

    if (MDNS.begin("sparkminer")) {
        MDNS.addService("http", "tcp", 80);
        Serial.println("[WEB] mDNS responder started: http://sparkminer.local");
    } else {
        Serial.println("[WEB] Warning: Failed to start mDNS responder");
    }

    s_server.begin();
    s_running = true;

    if (s_webTask == NULL) {
        // Core 0, priority 2 (above Miner0, alongside Stratum). The task sleeps
        // 5ms each loop so it never starves mining.
        xTaskCreatePinnedToCore(webServerTask, "WebServer", 8192, NULL, 2, &s_webTask, 0);
    }

    Serial.println("[WEB] Sync Web Server started on port 80");
}

void web_server_stop() {
    if (!s_running) {
        return;
    }
    if (s_webTask != NULL) {
        vTaskDelete(s_webTask);
        s_webTask = NULL;
    }
    s_server.stop();
    MDNS.end();
    s_running = false;
    Serial.println("[WEB] Web Server stopped");
}

bool web_server_is_running() {
    return s_running;
}

#endif // USE_WEB_SERVER
