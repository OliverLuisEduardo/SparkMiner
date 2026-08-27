/**
 * SparkMiner - Milestone 4 (M4) Automated Verification Test Suite
 * Tests: Dual OTA Partitions, NVS Offset Preservation (0x9000), POST /update Endpoint, Update.h Integration, and Security.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('============================================================');
console.log('[M4 TEST] Dual OTA Partitions, Update Endpoint & Safety Audit');
console.log('============================================================\n');

const ROOT_DIR = path.resolve(__dirname, '..');

// ------------------------------------------------------------
// Test 1: partitions_ota.csv Structure & Offset Verification
// ------------------------------------------------------------
console.log('--- Test 1: partitions_ota.csv Layout & NVS Offset Preservation Audit ---');
const partitionsPath = path.join(ROOT_DIR, 'partitions_ota.csv');
assert(fs.existsSync(partitionsPath), 'FAIL: partitions_ota.csv does not exist');
const partitionsContent = fs.readFileSync(partitionsPath, 'utf8');

const lines = partitionsContent.split('\n')
    .map(l => l.trim())
    .filter(l => l.length > 0 && !l.startsWith('#'));

let nvsFound = false;
let otaDataFound = false;
let app0Found = false;
let app1Found = false;

for (const line of lines) {
    const parts = line.split(',').map(p => p.trim());
    const [name, type, subtype, offsetStr, sizeStr] = parts;
    const offset = parseInt(offsetStr, 16);
    const size = parseInt(sizeStr, 16);

    if (name === 'nvs') {
        assert.strictEqual(type, 'data', 'NVS type must be data');
        assert.strictEqual(subtype, 'nvs', 'NVS subtype must be nvs');
        assert.strictEqual(offset, 0x9000, 'CRITICAL: NVS offset must be exactly 0x9000 to preserve settings/stats!');
        assert.strictEqual(size, 0x5000, 'NVS size must be 0x5000 (20KB)');
        nvsFound = true;
    } else if (name === 'otadata') {
        assert.strictEqual(type, 'data', 'otadata type must be data');
        assert.strictEqual(subtype, 'ota', 'otadata subtype must be ota');
        assert.strictEqual(offset, 0xe000, 'otadata offset must be 0xe000');
        assert.strictEqual(size, 0x2000, 'otadata size must be 0x2000');
        otaDataFound = true;
    } else if (name === 'app0') {
        assert.strictEqual(type, 'app', 'app0 type must be app');
        assert.strictEqual(subtype, 'ota_0', 'app0 subtype must be ota_0');
        assert.strictEqual(offset, 0x10000, 'app0 offset must be 0x10000');
        assert(size >= 0x180000, 'app0 size must be at least 1.5MB (0x180000)');
        app0Found = true;
    } else if (name === 'app1') {
        assert.strictEqual(type, 'app', 'app1 type must be app');
        assert.strictEqual(subtype, 'ota_1', 'app1 subtype must be ota_1');
        assert(offset >= 0x190000, 'app1 offset must follow app0');
        assert(size >= 0x180000, 'app1 size must be at least 1.5MB (0x180000)');
        app1Found = true;
    }
}

assert(nvsFound, 'FAIL: NVS partition missing');
assert(otaDataFound, 'FAIL: otadata partition missing');
assert(app0Found, 'FAIL: app0 partition missing');
assert(app1Found, 'FAIL: app1 partition missing');

console.log('  [PASS] partitions_ota.csv layout verified: NVS offset strictly preserved at 0x9000 with dual OTA app slots.');

// ------------------------------------------------------------
// Test 2: platformio.ini Partition Configuration Audit
// ------------------------------------------------------------
console.log('\n--- Test 2: platformio.ini Partition Configuration Audit ---');
const pioContent = fs.readFileSync(path.join(ROOT_DIR, 'platformio.ini'), 'utf8');

assert(pioContent.includes('board_build.partitions = partitions_ota.csv'),
    'FAIL: platformio.ini must configure board_build.partitions = partitions_ota.csv');

console.log('  [PASS] platformio.ini references partitions_ota.csv.');

// ------------------------------------------------------------
// Test 3: Web Server /update Route & Update.h Integration Audit
// ------------------------------------------------------------
console.log('\n--- Test 3: Web Server /update Route & Update.h Integration Audit ---');
const webServerContent = fs.readFileSync(path.join(ROOT_DIR, 'src/web/web_server.cpp'), 'utf8');

assert(webServerContent.includes('#include <Update.h>'),
    'FAIL: web_server.cpp must include <Update.h>');

assert(webServerContent.includes('s_server.on("/update"'),
    'FAIL: web_server.cpp must register /update route');

assert(webServerContent.includes('Update.begin('),
    'FAIL: web_server.cpp must call Update.begin()');

assert(webServerContent.includes('Update.write('),
    'FAIL: web_server.cpp must call Update.write() for chunked streaming');

assert(webServerContent.includes('Update.end('),
    'FAIL: web_server.cpp must call Update.end()');

assert(webServerContent.includes('ESP.restart()'),
    'FAIL: web_server.cpp must reboot after successful update');

assert(webServerContent.includes('isAuthorized(request, config)'),
    'FAIL: /update route must be protected by isAuthorized() check');

console.log('  [PASS] /update OTA endpoint streaming, Update.h integration, and authentication verified.');

console.log('\n============================================================');
console.log('[M4 TEST] ALL AUDIT CHECKS PASSED SUCCESSFULLY!');
console.log('============================================================\n');
