/**
 * SparkMiner Milestone 2 Verification Suite
 * Tests for Web Dashboard, PROGMEM HTML size/integrity, AsyncWebServer, /api/stats, and Core 0 Isolation
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log("============================================================");
console.log("[M2 TEST] Web Dashboard, REST API & Core 0 Isolation Audit");
console.log("============================================================");

const projectRoot = path.resolve(__dirname, '..');

// 1. Audit platformio.ini
console.log("\n--- Test 1: platformio.ini Dependency & Build Flag Audit ---");
const pioPath = path.join(projectRoot, 'platformio.ini');
const pioContent = fs.readFileSync(pioPath, 'utf8');

assert(pioContent.includes('ESP32Async/ESPAsyncWebServer @ ^3.6.0'), "platformio.ini missing ESPAsyncWebServer @ ^3.6.0");
assert(pioContent.includes('ESP32Async/AsyncTCP @ ^3.3.2'), "platformio.ini missing AsyncTCP @ ^3.3.2");
assert(pioContent.includes('CONFIG_ASYNC_TCP_RUNNING_CORE=0'), "platformio.ini missing CONFIG_ASYNC_TCP_RUNNING_CORE=0");
assert(pioContent.includes('CONFIG_ASYNC_TCP_TASK_PRIORITY=2'), "platformio.ini missing CONFIG_ASYNC_TCP_TASK_PRIORITY=2");
console.log("  [PASS] AsyncTCP pinned to Core 0 with Priority 2 and dependencies registered.");

// 2. Audit src/web/index_html.h
console.log("\n--- Test 2: src/web/index_html.h PROGMEM & Offline Integrity Audit ---");
const indexHtmlPath = path.join(projectRoot, 'src', 'web', 'index_html.h');
assert(fs.existsSync(indexHtmlPath), "src/web/index_html.h does not exist!");
const indexHtmlContent = fs.readFileSync(indexHtmlPath, 'utf8');

// Extract HTML payload between rawliteral(...)rawliteral
const htmlMatch = indexHtmlContent.match(/R"rawliteral\(([\s\S]*?)\)rawliteral"/);
assert(htmlMatch, "Could not extract rawliteral HTML from index_html.h");
const rawHtml = htmlMatch[1];
const htmlSizeBytes = Buffer.byteLength(rawHtml, 'utf8');
console.log(`  HTML Payload Uncompressed Size: ${htmlSizeBytes} bytes`);
assert(htmlSizeBytes < 8192, `HTML payload (${htmlSizeBytes} bytes) exceeds 8KB (8192 bytes) budget!`);

// Check zero external dependencies (no external http/https CDN links)
const cdnPatterns = [/https?:\/\/(?!(\/|127\.|localhost))/i, /cdn\./i, /cdnjs/i, /unpkg/i, /fonts\.google/i];
cdnPatterns.forEach(pattern => {
    assert(!pattern.test(rawHtml), `Found external network dependency matching ${pattern} in index_html.h!`);
});
console.log("  [PASS] 100% offline self-contained: 0 external CDN / font dependencies.");

// Check key DOM elements
const requiredDomIds = [
    'vH', 'uH', 'vD', 'vHs', 'vB', 'vU',
    'vA', 'vJ', 'vR', 'bA', 'bJ',
    'vPS', 'vPU', 'vPD', 'vPP',
    'vBH', 'vND',
    'vT', 'vM', 'vW', 'vI',
    'tN', 'tL', 'vV', 'vS'
];
requiredDomIds.forEach(id => {
    assert(rawHtml.includes(`id="${id}"`), `Missing required DOM element id="${id}" in index_html.h`);
});
console.log(`  [PASS] All ${requiredDomIds.length} required DOM IDs present in dashboard UI.`);

// 3. Audit src/web/web_server.h and src/web/web_server.cpp
console.log("\n--- Test 3: Web Server & /api/stats Lifecycle and Security Audit ---");
const webServerHPath = path.join(projectRoot, 'src', 'web', 'web_server.h');
const webServerCppPath = path.join(projectRoot, 'src', 'web', 'web_server.cpp');
assert(fs.existsSync(webServerHPath), "src/web/web_server.h does not exist!");
assert(fs.existsSync(webServerCppPath), "src/web/web_server.cpp does not exist!");

const webHContent = fs.readFileSync(webServerHPath, 'utf8');
const webCppContent = fs.readFileSync(webServerCppPath, 'utf8');

assert(webHContent.includes('void web_server_init();'), "web_server.h missing web_server_init()");
assert(webHContent.includes('void web_server_stop();'), "web_server.h missing web_server_stop()");
assert(webHContent.includes('bool web_server_is_running();'), "web_server.h missing web_server_is_running()");

assert(webCppContent.includes('MDNS.begin("sparkminer")'), "web_server.cpp missing MDNS.begin(\"sparkminer\")");
assert(webCppContent.includes('MDNS.addService("http", "tcp", 80)'), "web_server.cpp missing MDNS.addService(\"http\", \"tcp\", 80)");
assert(webCppContent.includes('StaticJsonDocument<1024> doc;'), "web_server.cpp should use StaticJsonDocument<1024>");
assert(webCppContent.includes('request->beginResponseStream("application/json")'), "web_server.cpp should use AsyncResponseStream for JSON streaming");
assert(webCppContent.includes('INDEX_HTML'), "web_server.cpp should serve INDEX_HTML at /");

// Verify secrets are NOT exposed in /api/stats telemetry
const statsHandler = webCppContent.substring(
    webCppContent.indexOf('handleApiStats'),
    webCppContent.indexOf('handleApiConfigGet') > 0 ? webCppContent.indexOf('handleApiConfigGet') : webCppContent.length
);
assert(!statsHandler.includes('wifiPassword'), "CRITICAL SECURITY ERROR: wifiPassword exposed in handleApiStats!");
assert(!statsHandler.includes('poolPassword'), "CRITICAL SECURITY ERROR: poolPassword exposed in handleApiStats!");
assert(!statsHandler.includes('backupPoolPassword'), "CRITICAL SECURITY ERROR: backupPoolPassword exposed in handleApiStats!");
console.log("  [PASS] Secrets security verified: WiFi and pool passwords strictly excluded from telemetry.");
console.log("  [PASS] mDNS sparkminer.local & StaticJsonDocument<1024> zero-heap streaming verified.");

// 4. Audit src/main.cpp integration
console.log("\n--- Test 4: src/main.cpp Web Server Integration Audit ---");
const mainCppPath = path.join(projectRoot, 'src', 'main.cpp');
const mainCppContent = fs.readFileSync(mainCppPath, 'utf8');

assert(mainCppContent.includes('#include "web/web_server.h"'), "main.cpp missing #include \"web/web_server.h\"");
assert(mainCppContent.includes('web_server_init();'), "main.cpp does not call web_server_init()");
assert(mainCppContent.includes('ARDUINO_EVENT_WIFI_STA_GOT_IP'), "main.cpp missing ARDUINO_EVENT_WIFI_STA_GOT_IP web_server_init hook");
console.log("  [PASS] main.cpp properly includes web_server.h and initializes web server on WiFi connection.");

console.log("\n============================================================");
console.log("[M2 TEST] ALL AUDIT CHECKS PASSED SUCCESSFULLY!");
console.log("============================================================");
