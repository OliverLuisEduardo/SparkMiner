// Comprehensive Test Runner for M1 Challenger 2

const { execSync } = require('child_process');
const path = require('path');

const tests = [
    'test_spinlock_concurrency.js',
    'test_hashrate_ema_math.js',
    'test_core1_zero_impact_and_critical_sections.js',
    'test_m2_web_dashboard_and_api.js',
    'test_m3_web_config_and_auth.js',
    'test_m4_ota_support.js',
    'test_m5_touchscreen_and_ui.js'
];

console.log("================================================================================");
console.log("       SparkMiner Test Suite (All Milestones)");
console.log("================================================================================\n");

let passed = 0;
let failed = 0;

for (const test of tests) {
    const testPath = path.join(__dirname, test);
    console.log(`>>> Executing ${test}...`);
    try {
        const output = execSync(`node "${testPath}"`, { encoding: 'utf8' });
        console.log(output);
        passed++;
    } catch (err) {
        console.error(`FAILED: ${test}`);
        console.error(err.stdout || err.message);
        failed++;
    }
}

console.log("--------------------------------------------------------------------------------");
console.log(`SUMMARY: ${passed} passed, ${failed} failed out of ${tests.length} test suites.`);
console.log("================================================================================");

if (failed > 0) {
    process.exit(1);
}
