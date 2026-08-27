// Empirical Verification Harness for Hashrate EMA Smoothing Math
// Tests monitor.cpp smoothing algorithm under various operational conditions

const assert = require('assert');

class MonitorEMASimulator {
    constructor() {
        this.reset();
    }

    reset() {
        this.lastHashes = 0n;
        this.lastHashTime = 0;
        this.smoothedHashRate = 0.0;
        this.firstSample = true;
        this.s_hashRate = 0.0;
    }

    // Exact replica of monitor.cpp updateDisplayData lines 74-106
    update(now_ms, current_hashes_u64) {
        // uint32_t subtraction handles wrap-around naturally in C++ (uint32_t arithmetic)
        let elapsed = (now_ms - this.lastHashTime) >>> 0; // Unsigned 32-bit subtraction

        if (elapsed >= 1000) {
            let deltaHashes = (current_hashes_u64 - this.lastHashes);
            let instantRate = Number(deltaHashes) * 1000.0 / elapsed;

            const alpha = 0.15;

            if (this.firstSample) {
                this.smoothedHashRate = instantRate;
                this.firstSample = false;
            } else {
                this.smoothedHashRate = alpha * instantRate + (1.0 - alpha) * this.smoothedHashRate;
            }

            this.s_hashRate = this.smoothedHashRate;
            this.lastHashes = current_hashes_u64;
            this.lastHashTime = now_ms;
        }

        return this.s_hashRate;
    }
}

function runTests() {
    console.log("============================================================");
    console.log("[HARNESS 2] Starting Hashrate EMA Smoothing Math Verification");
    console.log("============================================================");

    const sim = new MonitorEMASimulator();

    // ------------------------------------------------------------
    // Test 1: First Sample Startup
    // ------------------------------------------------------------
    console.log("\n--- Test 1: First Sample Startup ---");
    sim.reset();
    let r1 = sim.update(1000, 500000n); // 500k hashes in 1st sec
    console.log(`Initial sample (1000ms, 500k hashes): smoothed = ${r1.toFixed(2)} H/s (expected 500000.00)`);
    assert.strictEqual(r1, 500000.0, "First sample should immediately reflect instant rate");

    // ------------------------------------------------------------
    // Test 2: Step Response (0 -> 500,000 H/s)
    // ------------------------------------------------------------
    console.log("\n--- Test 2: Step Response (0 -> 500,000 H/s) ---");
    sim.reset();
    // Simulate miner starting cold with 0 hashes, then jumping to 500k H/s
    // Step 0: time 1000, hashes 0
    sim.update(1000, 0n);
    console.log(`t = 1s, hashes = 0: rate = ${sim.s_hashRate.toFixed(2)} H/s`);

    let currentHashes = 0n;
    let history = [];
    for (let t = 2; t <= 60; t++) {
        currentHashes += 500000n;
        let rate = sim.update(t * 1000, currentHashes);
        history.push({ t, rate });
        if (t <= 5 || t === 10 || t === 18 || t === 28 || t === 30 || t === 60) {
            let pct = (rate / 500000.0) * 100;
            console.log(`t = ${t}s: smoothed = ${rate.toFixed(2)} H/s (${pct.toFixed(2)}% of target)`);
        }
    }

    // Mathematical verification:
    // Theoretical 95% settling time for alpha=0.15 is ~18s (1 - 0.85^18 = 0.946)
    // Theoretical 99% settling time is ~28s (1 - 0.85^28 = 0.989)
    let rate18s = history.find(h => h.t === 19).rate; // 18 steps after jump
    let rate28s = history.find(h => h.t === 29).rate; // 28 steps after jump
    let rate60s = history.find(h => h.t === 60).rate;

    console.log(`Rate after 18 steps: ${rate18s.toFixed(2)} H/s (${(rate18s/5000).toFixed(2)}%)`);
    console.log(`Rate after 28 steps: ${rate28s.toFixed(2)} H/s (${(rate28s/5000).toFixed(2)}%)`);
    console.log(`Rate after 59 steps: ${rate60s.toFixed(2)} H/s (${(rate60s/5000).toFixed(2)}%)`);

    assert(rate18s >= 470000.0, "18s rate should exceed 94% of target");
    assert(rate28s >= 494000.0, "28s rate should exceed 98.8% of target");
    assert(Math.abs(rate60s - 500000.0) < 50.0, "60s rate should reach 99.99% of target");

    // ------------------------------------------------------------
    // Test 3: Sudden Drop to Zero (500,000 -> 0 H/s)
    // ------------------------------------------------------------
    console.log("\n--- Test 3: Sudden Drop (500,000 -> 0 H/s) ---");
    // At t=60, miner abruptly stops producing hashes (pool disconnect or job paused)
    for (let t = 61; t <= 120; t++) {
        // currentHashes does NOT increase
        let rate = sim.update(t * 1000, currentHashes);
        if (t <= 65 || t === 70 || t === 78 || t === 88 || t === 95 || t === 120) {
            console.log(`t = ${t}s (drop +${t-60}s): smoothed = ${rate.toFixed(2)} H/s`);
        }
    }
    let rateDrop28s = sim.s_hashRate; // at t=120, 60s after drop
    console.log(`Rate 60s after drop: ${rateDrop28s.toExponential(4)} H/s`);
    assert(sim.s_hashRate < 50.0, "Hashrate should decay by >99.99% within 60s of stopping");
    assert(sim.s_hashRate >= 0.0, "Hashrate must never go negative");

    // ------------------------------------------------------------
    // Test 4: Extended Zero Hashrate
    // ------------------------------------------------------------
    console.log("\n--- Test 4: Extended Zero Hashrate Stability ---");
    for (let t = 121; t <= 300; t++) {
        sim.update(t * 1000, currentHashes);
    }
    console.log(`Rate after 180s of 0 H/s: ${sim.s_hashRate.toExponential(6)} H/s`);
    assert(!isNaN(sim.s_hashRate), "Must not produce NaN on zero hashrate");
    assert(!isFinite(sim.s_hashRate) === false, "Must not produce Infinity");
    assert(sim.s_hashRate >= 0.0, "Must remain non-negative");

    // ------------------------------------------------------------
    // Test 5: Burst Hashrates (Short intense bursts followed by idle)
    // ------------------------------------------------------------
    console.log("\n--- Test 5: Burst Hashrates ---");
    sim.reset();
    let burstHashes = 0n;
    // 10 cycles of: 2s active (1,000,000 H/s) + 8s idle (0 H/s). Mean = 200,000 H/s.
    let burstRates = [];
    let curTime = 1000;
    for (let cycle = 0; cycle < 20; cycle++) {
        for (let s = 0; s < 10; s++) {
            if (s < 2) {
                burstHashes += 1000000n;
            }
            let rate = sim.update(curTime, burstHashes);
            curTime += 1000;
            if (cycle >= 15) {
                burstRates.push(rate);
            }
        }
    }
    let avgBurstRate = burstRates.reduce((a, b) => a + b, 0) / burstRates.length;
    console.log(`Simulated periodic 2s on / 8s off burst mining.`);
    console.log(`True average instant rate = 200,000 H/s.`);
    console.log(`Smoothed rates in steady state cycle: min = ${Math.min(...burstRates).toFixed(2)}, max = ${Math.max(...burstRates).toFixed(2)}, avg = ${avgBurstRate.toFixed(2)} H/s`);
    assert(Math.abs(avgBurstRate - 200000) < 5000, "Mean smoothed rate should match true time-average within 2.5%");

    // ------------------------------------------------------------
    // Test 6: Irregular Polling / Timer Jitter (elapsed != 1000ms)
    // ------------------------------------------------------------
    console.log("\n--- Test 6: Timer Jitter (elapsed = 1100ms, 1500ms, 2500ms) ---");
    sim.reset();
    let jitterTime = 1000;
    let jitterHashes = 0n;
    const nominalRate = 450000.0; // 450 kH/s

    for (let i = 0; i < 50; i++) {
        let dt = 1000 + Math.floor(Math.random() * 1500); // 1000 to 2500ms
        jitterTime += dt;
        jitterHashes += BigInt(Math.floor(nominalRate * (dt / 1000.0)));
        sim.update(jitterTime, jitterHashes);
    }
    console.log(`Rate under variable update intervals (1000-2500ms): ${sim.s_hashRate.toFixed(2)} H/s (Target: 450000)`);
    assert(Math.abs(sim.s_hashRate - nominalRate) < 1000, "EMA must accurately track hashrate regardless of variable loop delays");

    // ------------------------------------------------------------
    // Test 7: millis() 32-bit Overflow / Wrap-Around
    // ------------------------------------------------------------
    console.log("\n--- Test 7: millis() 32-bit Wrap-Around ---");
    sim.reset();
    let wrapTimeBefore = 4294966000; // ~1.29s before overflow
    let wrapHashes = 1000000000n;
    
    // Seed initial steady state at 500k H/s
    sim.lastHashTime = wrapTimeBefore - 1000;
    sim.lastHashes = wrapHashes - 500000n;
    sim.smoothedHashRate = 500000.0;
    sim.firstSample = false;

    // Sample just before wrap
    sim.update(wrapTimeBefore, wrapHashes);

    // Next sample crosses 0 (wrap-around)
    let wrapTimeAfter = 200; // 200ms after overflow (1496 ms elapsed)
    wrapHashes += BigInt(Math.floor(500000 * (1496 / 1000.0)));
    let rateWrapped = sim.update(wrapTimeAfter, wrapHashes);
    console.log(`Pre-wrap timestamp: ${wrapTimeBefore}, Post-wrap: ${wrapTimeAfter}`);
    console.log(`Elapsed unsigned delta: ${(wrapTimeAfter - wrapTimeBefore) >>> 0} ms`);
    console.log(`Calculated smoothed hashrate across wrap: ${rateWrapped.toFixed(2)} H/s (Target: 500000)`);
    assert(Math.abs(rateWrapped - 500000.0) < 1.0, "Wrap-around subtraction must be seamless and correct");

    // ------------------------------------------------------------
    // Test 8: Sub-second Calls (< 1000ms)
    // ------------------------------------------------------------
    console.log("\n--- Test 8: Sub-second Calls (< 1000ms) ---");
    sim.reset();
    sim.update(1000, 500000n);
    let initialRate = sim.s_hashRate;
    // Calling at 1200ms (elapsed = 200ms < 1000ms)
    let rateSub = sim.update(1200, 600000n);
    console.log(`Call after 200ms: rate = ${rateSub} (should remain ${initialRate})`);
    assert.strictEqual(rateSub, initialRate, "Should not update when elapsed < 1000ms");

    // ------------------------------------------------------------
    // Test 9: Massive Lifetime Hash Count (64-bit math)
    // ------------------------------------------------------------
    console.log("\n--- Test 9: Massive Session Hash Count (64-bit integer delta) ---");
    sim.reset();
    let massiveBase = 18000000000000000000n; // 18 quintillion hashes (near uint64 max)
    sim.lastHashTime = 1000;
    sim.lastHashes = massiveBase;
    sim.firstSample = false;
    sim.smoothedHashRate = 600000.0;

    let rMassive = sim.update(2000, massiveBase + 600000n);
    console.log(`Massive hash count test: rate = ${rMassive.toFixed(2)} H/s (Target: 600000)`);
    assert.strictEqual(rMassive, 600000.0, "Delta calculation must work seamlessly with huge 64-bit hash counts");

    console.log("\n============================================================");
    console.log("[HARNESS 2] ALL 9 TESTS PASSED! EMA Math confirmed mathematically robust and stable.");
    console.log("============================================================\n");
}

runTests();
