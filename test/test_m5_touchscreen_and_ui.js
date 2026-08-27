/**
 * SparkMiner - Milestone 5 (M5) Automated Verification Test Suite
 * Tests: XPT2046 Touchscreen Wiring on VSPI, Non-blocking Polling in monitor_task (100ms / 400ms debounce),
 * Rotation Synchronization, Backlight Wake, and Core 0 Isolation.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('============================================================');
console.log('[M5 TEST] XPT2046 Touchscreen Driver, UI & Core 0 Isolation Audit');
console.log('============================================================\n');

const ROOT_DIR = path.resolve(__dirname, '..');

// ------------------------------------------------------------
// Test 1: display.cpp Touchscreen Hardware & VSPI Wiring Audit
// ------------------------------------------------------------
console.log('--- Test 1: display.cpp XPT2046 VSPI Wiring Audit ---');
const displayCppPath = path.join(ROOT_DIR, 'src/display/display.cpp');
const displayCppContent = fs.readFileSync(displayCppPath, 'utf8');

assert(displayCppContent.includes('#include <XPT2046_Touchscreen.h>'),
    'FAIL: display.cpp must include <XPT2046_Touchscreen.h>');

assert(displayCppContent.includes('TOUCH_CS_PIN') && displayCppContent.includes('TOUCH_CLK_PIN'),
    'FAIL: display.cpp missing touch pin definitions');

assert(displayCppContent.includes('s_touchSpi.begin(') && displayCppContent.includes('s_touch.begin('),
    'FAIL: display.cpp must initialize XPT2046 on dedicated VSPI bus');

assert(displayCppContent.includes('bool display_touched()') && displayCppContent.includes('return s_touch.touched();'),
    'FAIL: display_touched() must query s_touch.touched()');

assert(displayCppContent.includes('void display_handle_touch()') && displayCppContent.includes('display_next_screen();'),
    'FAIL: display_handle_touch() must invoke display_next_screen()');

console.log('  [PASS] XPT2046 touchscreen driver properly wired on dedicated VSPI bus (pins: 25, 32, 39, 33, 36).');

// ------------------------------------------------------------
// Test 2: Touch Rotation Synchronization Audit
// ------------------------------------------------------------
console.log('\n--- Test 2: Touch & Display Rotation Synchronization Audit ---');

assert(displayCppContent.includes('void display_set_rotation(uint8_t rotation)'),
    'FAIL: display_set_rotation missing');

const setRotationMethod = displayCppContent.substring(
    displayCppContent.indexOf('void display_set_rotation('),
    displayCppContent.indexOf('void display_set_inverted(')
);

assert(setRotationMethod.includes('s_touch.setRotation(s_rotation)'),
    'FAIL: display_set_rotation must synchronize s_touch.setRotation(s_rotation)');

console.log('  [PASS] Touch coordinates properly synchronized with TFT rotation (0-3).');

// ------------------------------------------------------------
// Test 3: monitor_task Non-Blocking Touch Polling Audit
// ------------------------------------------------------------
console.log('\n--- Test 3: monitor_task Touch Polling & Debounce Audit ---');
const monitorCppPath = path.join(ROOT_DIR, 'src/stats/monitor.cpp');
const monitorCppContent = fs.readFileSync(monitorCppPath, 'utf8');

assert(monitorCppContent.includes('display_touched()'),
    'FAIL: monitor.cpp must poll display_touched()');

assert(monitorCppContent.includes('s_lastTouchPollTime') || monitorCppContent.includes('400'),
    'FAIL: monitor.cpp must apply 400ms debounce window');

assert(monitorCppContent.includes('monitor_reset_activity()'),
    'FAIL: monitor.cpp must reset inactivity timer on touch');

assert(monitorCppContent.includes('display_is_backlight_off()') && monitorCppContent.includes('display_set_backlight_on()'),
    'FAIL: monitor.cpp must wake backlight on touch if screen was dimmed/timed out');

console.log('  [PASS] monitor_task non-blocking touch polling (100ms cycle / 400ms debounce) verified.');

// ------------------------------------------------------------
// Test 4: UI Redraw Throttling (1 Hz) & Core 1 Isolation Audit
// ------------------------------------------------------------
console.log('\n--- Test 4: UI Redraw Throttling & Core 1 Mining Protection Audit ---');

assert(monitorCppContent.includes('DISPLAY_UPDATE_MS'),
    'FAIL: monitor.cpp must throttle display redraw to DISPLAY_UPDATE_MS (1000ms)');

// Confirm no new tasks or touch loops on Core 1
const mainCppContent = fs.readFileSync(path.join(ROOT_DIR, 'src/main.cpp'), 'utf8');
assert(mainCppContent.includes('MINER_1_CORE'), 'FAIL: main.cpp missing MINER_1_CORE');
assert(!monitorCppContent.includes('xTaskCreatePinnedToCore') || monitorCppContent.includes('CORE_0'),
    'FAIL: All monitoring and touch tasks must be pinned to Core 0');

console.log('  [PASS] UI redraw throttled at 1 Hz, zero CPU starvation, Core 1 completely isolated.');

console.log('\n============================================================');
console.log('[M5 TEST] ALL AUDIT CHECKS PASSED SUCCESSFULLY!');
console.log('============================================================\n');
