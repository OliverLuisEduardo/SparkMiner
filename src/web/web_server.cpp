/*
 * SparkMiner - Asynchronous Web Server & REST API Implementation
 * Pinned to Core 0 (Priority 2) for zero mining disruption
 *
 * GPL v3 License
 */

#if defined(USE_WEB_SERVER) && USE_WEB_SERVER

#include <Arduino.h>
#include <ESPAsyncWebServer.h>
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

// File-scoped static web server on port 80
static AsyncWebServer s_server(80);
static bool s_running = false;
static bool s_routesRegistered = false;

// Reject new requests when free heap is low, to avoid OOM reboots under
// concurrent clients. Protects mining stability over serving the dashboard.
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

// Authentication verification against adminPassword in NVS
static bool isAuthorized(AsyncWebServerRequest *request, const miner_config_t *config) {
    if (!config || config->adminPassword[0] == '\0') {
        return true; // Authentication disabled when empty
    }
    if (request->hasHeader("X-Auth")) {
        if (request->getHeader("X-Auth")->value() == config->adminPassword) {
            return true;
        }
    }
    if (request->hasParam("auth")) {
        if (request->getParam("auth")->value() == config->adminPassword) {
            return true;
        }
    }
    if (request->hasParam("password")) {
        if (request->getParam("password")->value() == config->adminPassword) {
            return true;
        }
    }
    if (request->hasParam("auth", true)) {
        if (request->getParam("auth", true)->value() == config->adminPassword) {
            return true;
        }
    }
    if (request->hasParam("password", true)) {
        if (request->getParam("password", true)->value() == config->adminPassword) {
            return true;
        }
    }
    return false;
}

// Basic anti-hammering rate limiter (min 300ms between POST state modifications)
static bool isRateLimited() {
    uint32_t now = millis();
    static uint32_t s_lastPostTime = 0;
    if (now >= s_lastPostTime && (now - s_lastPostTime) < 300) {
        return true;
    }
    s_lastPostTime = now;
    return false;
}

// Format network difficulty into human-readable representation
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

/**
 * GET /api/stats Request Handler
 * Streams real-time telemetry JSON with zero heap allocations.
 */
static void handleApiStats(AsyncWebServerRequest *request) {
    if (webHeapLow()) {
        request->send(503, "application/json", "{\"error\":\"Low memory\"}");
        return;
    }
    // 1. Gather stats from miner, persistence, and configuration
    mining_stats_t *mstats = miner_get_stats();
    mining_persistence_t *pstats = nvs_stats_get();
    miner_config_t *config = nvs_config_get();

    // Smoothed hashrate (thread-safe 30s EMA from monitor)
    double hashrate = monitor_get_hashrate();

    // Session raw / average hashrate
    uint32_t now = millis();
    uint32_t sessionMs = (mstats->startTime > 0 && now >= mstats->startTime) ? (now - mstats->startTime) : 0;
    double hashrate_raw = (sessionMs >= 1000) ? ((double)mstats->hashes * 1000.0 / (double)sessionMs) : hashrate;

    // Aggregated shares (lifetime persistent + in-memory session)
    uint32_t accepted = pstats->lifetimeAccepted + mstats->accepted;
    uint32_t rejected = pstats->lifetimeRejected + mstats->rejected;
    uint32_t blocks = pstats->lifetimeBlocks + mstats->blocks;
    double bestDiff = (mstats->bestDifficulty > pstats->bestDifficultyEver)
                      ? mstats->bestDifficulty : pstats->bestDifficultyEver;

    // Pool information
    bool poolConnected = stratum_is_connected();
    const char *poolUrl = stratum_get_pool();
    if (!poolUrl || poolUrl[0] == '\0') {
        poolUrl = config->poolUrl;
    }
    double poolDiff = miner_get_difficulty();
    bool isBackup = stratum_is_backup();
    uint32_t latency = mstats->avgLatency;

    // Construct user/worker identifier (passwords are strictly omitted)
    char userStr[160];
    if (config->workerName[0] != '\0' && config->wallet[0] != '\0') {
        snprintf(userStr, sizeof(userStr), "%s.%s", config->wallet, config->workerName);
    } else if (config->wallet[0] != '\0') {
        snprintf(userStr, sizeof(userStr), "%s", config->wallet);
    } else {
        snprintf(userStr, sizeof(userStr), "anonymous");
    }

    // Stratum job-derived network telemetry
    uint32_t blockHeight = 0;
    double networkDifficulty = 0.0;
    stratum_get_network_info(&blockHeight, &networkDifficulty);
    char netDiffFormatted[32];
    formatNetworkDifficulty(networkDifficulty, netDiffFormatted, sizeof(netDiffFormatted));

    // Hardware & system telemetry
    uint32_t uptime = now / 1000;
    uint32_t freeHeap = ESP.getFreeHeap();
    uint32_t minFreeHeap = ESP.getMinFreeHeap();
    float chipTemp = temperatureRead();
    int8_t rssi = (WiFi.status() == WL_CONNECTED) ? WiFi.RSSI() : 0;
    const char *ip = wifi_manager_get_ip();
    const char *minerName = (config->workerName[0] != '\0') ? config->workerName : MINER_NAME;
    uint32_t cpuMhz = getCpuFrequencyMhz();

    // 2. Build JSON using stack-allocated StaticJsonDocument (0 heap allocation)
    StaticJsonDocument<1024> doc;

    doc["hashrate"] = hashrate;
    doc["hashrate_raw"] = hashrate_raw;
    doc["hashes_total"] = pstats->lifetimeHashes + mstats->hashes;
    doc["hashes_session"] = mstats->hashes;

    // Pool group
    JsonObject poolObj = doc.createNestedObject("pool");
    poolObj["url"] = poolUrl;
    poolObj["connected"] = poolConnected;
    poolObj["user"] = userStr;
    poolObj["diff"] = poolDiff;
    poolObj["is_backup"] = isBackup;
    poolObj["latency"] = latency;

    // Shares group
    JsonObject sharesObj = doc.createNestedObject("shares");
    sharesObj["accepted"] = accepted;
    sharesObj["rejected"] = rejected;
    sharesObj["best_diff"] = bestDiff;
    sharesObj["session_accepted"] = mstats->accepted;
    sharesObj["session_rejected"] = mstats->rejected;
    sharesObj["blocks"] = blocks;

    // Network group
    JsonObject netObj = doc.createNestedObject("network");
    netObj["block_height"] = blockHeight;
    netObj["difficulty"] = networkDifficulty;
    netObj["difficulty_formatted"] = netDiffFormatted;

    // System group
    JsonObject sysObj = doc.createNestedObject("system");
    sysObj["uptime"] = uptime;
    sysObj["free_heap"] = freeHeap;
    sysObj["min_free_heap"] = minFreeHeap;
    sysObj["chip_temp"] = chipTemp;
    sysObj["temp"] = chipTemp;
    sysObj["wifi_rssi"] = rssi;
    sysObj["ip"] = ip;
    sysObj["firmware_version"] = AUTO_VERSION;
    sysObj["miner_name"] = minerName;
    sysObj["cpu_mhz"] = cpuMhz;

    // 3. Stream serialized JSON response
    AsyncResponseStream *response = request->beginResponseStream("application/json");
    response->addHeader("Access-Control-Allow-Origin", "*");
    response->addHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    response->addHeader("Pragma", "no-cache");
    response->addHeader("Expires", "0");

    serializeJson(doc, *response);
    request->send(response);
}

/**
 * GET /api/config Request Handler
 * Returns miner configuration with WiFi secret omitted and pool credential masked.
 */
static void handleApiConfigGet(AsyncWebServerRequest *request) {
    if (webHeapLow()) {
        request->send(503, "application/json", "{\"error\":\"Low memory\"}");
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

    AsyncResponseStream *response = request->beginResponseStream("application/json");
    response->addHeader("Access-Control-Allow-Origin", "*");
    response->addHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    serializeJson(doc, *response);
    request->send(response);
}

/**
 * POST /api/config Request Handler
 * Authenticated endpoint to update configuration with validation & wear leveling.
 */
static void handleApiConfigPost(AsyncWebServerRequest *request) {
    miner_config_t *config = nvs_config_get();
    if (!isAuthorized(request, config)) {
        request->send(401, "application/json", "{\"error\":\"Unauthorized\",\"message\":\"Invalid or missing admin password\"}");
        return;
    }

    if (isRateLimited()) {
        request->send(429, "application/json", "{\"error\":\"Too Many Requests\"}");
        return;
    }

    bool changed = false;
    bool poolChanged = false;
    bool displayChanged = false;

    // Primary Pool URL
    if (request->hasParam("poolUrl", true) || request->hasParam("poolUrl")) {
        String val = request->hasParam("poolUrl", true) ? request->getParam("poolUrl", true)->value() : request->getParam("poolUrl")->value();
        val.trim();
        if (val.length() > 0 && val.length() <= MAX_POOL_URL_LEN && val != config->poolUrl) {
            safeStrCpy(config->poolUrl, val.c_str(), sizeof(config->poolUrl));
            changed = true;
            poolChanged = true;
        }
    }

    // Primary Pool Port
    if (request->hasParam("poolPort", true) || request->hasParam("poolPort")) {
        int val = request->hasParam("poolPort", true) ? request->getParam("poolPort", true)->value().toInt() : request->getParam("poolPort")->value().toInt();
        if (val >= 1 && val <= 65535 && val != config->poolPort) {
            config->poolPort = val;
            changed = true;
            poolChanged = true;
        }
    }

    // Wallet
    if (request->hasParam("wallet", true) || request->hasParam("wallet")) {
        String val = request->hasParam("wallet", true) ? request->getParam("wallet", true)->value() : request->getParam("wallet")->value();
        val.trim();
        if (val.length() > 0 && val.length() <= MAX_WALLET_LEN && val != config->wallet) {
            safeStrCpy(config->wallet, val.c_str(), sizeof(config->wallet));
            changed = true;
            poolChanged = true;
        }
    }

    // Worker Name
    if (request->hasParam("workerName", true) || request->hasParam("workerName")) {
        String val = request->hasParam("workerName", true) ? request->getParam("workerName", true)->value() : request->getParam("workerName")->value();
        val.trim();
        if (val.length() <= 31 && val != config->workerName) {
            safeStrCpy(config->workerName, val.c_str(), sizeof(config->workerName));
            changed = true;
            poolChanged = true;
        }
    }

    // Pool Password (only if not masked)
    if (request->hasParam("poolPassword", true) || request->hasParam("poolPassword")) {
        String val = request->hasParam("poolPassword", true) ? request->getParam("poolPassword", true)->value() : request->getParam("poolPassword")->value();
        if (val != "****" && val.length() <= MAX_PASSWORD_LEN && val != config->poolPassword) {
            safeStrCpy(config->poolPassword, val.c_str(), sizeof(config->poolPassword));
            changed = true;
            poolChanged = true;
        }
    }

    // Backup Pool URL
    if (request->hasParam("backupPoolUrl", true) || request->hasParam("backupPoolUrl")) {
        String val = request->hasParam("backupPoolUrl", true) ? request->getParam("backupPoolUrl", true)->value() : request->getParam("backupPoolUrl")->value();
        val.trim();
        if (val.length() <= MAX_POOL_URL_LEN && val != config->backupPoolUrl) {
            safeStrCpy(config->backupPoolUrl, val.c_str(), sizeof(config->backupPoolUrl));
            changed = true;
        }
    }

    // Backup Pool Port
    if (request->hasParam("backupPoolPort", true) || request->hasParam("backupPoolPort")) {
        int val = request->hasParam("backupPoolPort", true) ? request->getParam("backupPoolPort", true)->value().toInt() : request->getParam("backupPoolPort")->value().toInt();
        if (val >= 0 && val <= 65535 && val != config->backupPoolPort) {
            config->backupPoolPort = val;
            changed = true;
        }
    }

    // Brightness
    if (request->hasParam("brightness", true) || request->hasParam("brightness")) {
        int val = request->hasParam("brightness", true) ? request->getParam("brightness", true)->value().toInt() : request->getParam("brightness")->value().toInt();
        if (val >= 0 && val <= 100 && val != config->brightness) {
            config->brightness = val;
            changed = true;
            displayChanged = true;
        }
    }

    // Rotation
    if (request->hasParam("rotation", true) || request->hasParam("rotation")) {
        int val = request->hasParam("rotation", true) ? request->getParam("rotation", true)->value().toInt() : request->getParam("rotation")->value().toInt();
        if (val >= 0 && val <= 3 && val != config->rotation) {
            config->rotation = val;
            changed = true;
            displayChanged = true;
        }
    }

    // Invert Colors
    if (request->hasParam("invertColors", true) || request->hasParam("invertColors")) {
        String s = request->hasParam("invertColors", true) ? request->getParam("invertColors", true)->value() : request->getParam("invertColors")->value();
        bool val = (s == "1" || s == "true");
        if (val != config->invertColors) {
            config->invertColors = val;
            changed = true;
            displayChanged = true;
        }
    }

    // Timezone Offset
    if (request->hasParam("timezoneOffset", true) || request->hasParam("timezoneOffset")) {
        int val = request->hasParam("timezoneOffset", true) ? request->getParam("timezoneOffset", true)->value().toInt() : request->getParam("timezoneOffset")->value().toInt();
        if (val >= -12 && val <= 14 && val != config->timezoneOffset) {
            config->timezoneOffset = val;
            changed = true;
        }
    }

    // Admin Password update
    if (request->hasParam("newAdminPassword", true) || request->hasParam("newAdminPassword")) {
        String val = request->hasParam("newAdminPassword", true) ? request->getParam("newAdminPassword", true)->value() : request->getParam("newAdminPassword")->value();
        if (val.length() <= 32 && val != config->adminPassword) {
            safeStrCpy(config->adminPassword, val.c_str(), sizeof(config->adminPassword));
            changed = true;
        }
    }

    // Wear-leveling: Only save to NVS if real changes occurred
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

    AsyncResponseStream *response = request->beginResponseStream("application/json");
    response->addHeader("Access-Control-Allow-Origin", "*");
    serializeJson(respDoc, *response);
    request->send(response);
}

/**
 * POST /api/name Request Handler
 * Authenticated quick rename shortcut.
 */
static void handleApiNamePost(AsyncWebServerRequest *request) {
    miner_config_t *config = nvs_config_get();
    if (!isAuthorized(request, config)) {
        request->send(401, "application/json", "{\"error\":\"Unauthorized\"}");
        return;
    }

    if (isRateLimited()) {
        request->send(429, "application/json", "{\"error\":\"Too Many Requests\"}");
        return;
    }

    String newName = "";
    if (request->hasParam("value", true)) {
        newName = request->getParam("value", true)->value();
    } else if (request->hasParam("value")) {
        newName = request->getParam("value")->value();
    } else if (request->hasParam("name", true)) {
        newName = request->getParam("name", true)->value();
    } else if (request->hasParam("name")) {
        newName = request->getParam("name")->value();
    }

    newName.trim();
    if (newName.length() > 0 && newName.length() <= 31) {
        bool changed = (newName != config->workerName);
        if (changed) {
            safeStrCpy(config->workerName, newName.c_str(), sizeof(config->workerName));
            nvs_config_save(config);
            stratum_set_pool(config->poolUrl, config->poolPort, config->wallet, config->poolPassword, config->workerName);
            stratum_reconnect();
        }

        StaticJsonDocument<128> doc;
        doc["status"] = "ok";
        doc["workerName"] = config->workerName;

        AsyncResponseStream *response = request->beginResponseStream("application/json");
        response->addHeader("Access-Control-Allow-Origin", "*");
        serializeJson(doc, *response);
        request->send(response);
    } else {
        request->send(400, "application/json", "{\"error\":\"Invalid worker name\"}");
    }
}

void web_server_init() {
    if (s_running) {
        return;
    }

    if (!s_routesRegistered) {
        // GET / : Serve embedded PROGMEM dashboard HTML
        s_server.on("/", HTTP_GET, [](AsyncWebServerRequest *request) {
            if (webHeapLow()) {
                request->send(503, "text/plain", "Low memory - try again shortly");
                return;
            }
            request->send_P(200, "text/html", (const uint8_t*)INDEX_HTML, sizeof(INDEX_HTML) - 1);
        });

        // GET /api/stats : Real-time JSON telemetry
        s_server.on("/api/stats", HTTP_GET, handleApiStats);

        // GET & POST /api/config : Configuration read & update
        s_server.on("/api/config", HTTP_GET, handleApiConfigGet);
        s_server.on("/api/config", HTTP_POST, handleApiConfigPost);

        // POST /api/name : Quick rename endpoint
        s_server.on("/api/name", HTTP_POST, handleApiNamePost);

        // POST /update : Chunked streaming OTA firmware upload
        s_server.on("/update", HTTP_POST, [](AsyncWebServerRequest *request) {
            miner_config_t *config = nvs_config_get();
            if (!isAuthorized(request, config)) {
                request->send(401, "application/json", "{\"error\":\"Unauthorized\",\"message\":\"Invalid or missing admin password\"}");
                return;
            }
            bool shouldReboot = !Update.hasError();
            AsyncWebServerResponse *response = request->beginResponse(
                shouldReboot ? 200 : 500,
                "text/plain",
                shouldReboot ? "OK: Firmware updated successfully. Rebooting..." : "FAIL: OTA Update failed."
            );
            response->addHeader("Connection", "close");
            response->addHeader("Access-Control-Allow-Origin", "*");
            request->send(response);
            if (shouldReboot) {
                delay(150);
                ESP.restart();
            }
        }, [](AsyncWebServerRequest *request, String filename, size_t index, uint8_t *data, size_t len, bool final) {
            miner_config_t *config = nvs_config_get();
            if (!isAuthorized(request, config)) {
                return;
            }
            if (index == 0) {
                Serial.printf("[OTA] Update started: %s\n", filename.c_str());
                if (!Update.begin(UPDATE_SIZE_UNKNOWN, U_FLASH)) {
                    Update.printError(Serial);
                }
            }
            if (!Update.hasError()) {
                if (Update.write(data, len) != len) {
                    Update.printError(Serial);
                }
            }
            if (final) {
                if (Update.end(true)) {
                    Serial.printf("[OTA] Update success: %u bytes\n", index + len);
                } else {
                    Update.printError(Serial);
                }
            }
        });

        // 404 Fallback Handler
        s_server.onNotFound([](AsyncWebServerRequest *request) {
            request->send(404, "application/json", "{\"error\":\"Not Found\"}");
        });

        s_routesRegistered = true;
    }

    // Start mDNS Responder
    if (MDNS.begin("sparkminer")) {
        MDNS.addService("http", "tcp", 80);
        Serial.println("[WEB] mDNS responder started: http://sparkminer.local");
    } else {
        Serial.println("[WEB] Warning: Failed to start mDNS responder");
    }

    s_server.begin();
    s_running = true;
    Serial.println("[WEB] Async Web Server started on port 80");
}

void web_server_stop() {
    if (!s_running) {
        return;
    }
    s_server.end();
    MDNS.end();
    s_running = false;
    Serial.println("[WEB] Async Web Server stopped");
}

bool web_server_is_running() {
    return s_running;
}

#endif // USE_WEB_SERVER
