// Empirical Verification Harness for SparkMiner Concurrency & Spinlock Safety
// Simulates FreeRTOS multi-core memory model with shared spinlock memory

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

class SharedSpinlock {
    constructor(sharedBuffer, byteOffset) {
        this.lockArray = new Int32Array(sharedBuffer, byteOffset, 1);
    }

    enter() {
        while (Atomics.compareExchange(this.lockArray, 0, 0, 1) !== 0) {
            // Spin
        }
    }

    exit() {
        Atomics.store(this.lockArray, 0, 0);
    }
}

// Emulated stratum network info state
class StratumNetworkInfo {
    constructor(sharedBuffer) {
        // Lock at byte 0
        this.mux = new SharedSpinlock(sharedBuffer, 0);
        // [0]: blockHeight (uint32) at byte 4
        // [1]: networkInfoValid (uint32) at byte 8
        this.uintView = new Uint32Array(sharedBuffer, 4, 2);
        // Float64 at byte 16: networkDifficulty
        this.floatView = new Float64Array(sharedBuffer, 16, 1);
    }

    set(height, difficulty) {
        this.mux.enter();
        if (height > 0) {
            this.uintView[0] = height;
        }
        if (difficulty > 0.0) {
            this.floatView[0] = difficulty;
        }
        if (this.uintView[0] > 0 || this.floatView[0] > 0.0) {
            this.uintView[1] = 1;
        }
        this.mux.exit();
    }

    get() {
        this.mux.enter();
        const height = this.uintView[0];
        const diff = this.floatView[0];
        const valid = this.uintView[1] === 1;
        this.mux.exit();
        return { height, diff, valid };
    }
}

// Emulated monitor smoothed hashrate state
class MonitorHashrate {
    constructor(sharedBuffer) {
        // Lock at byte 24
        this.mux = new SharedSpinlock(sharedBuffer, 24);
        // Float64 at byte 32: s_hashRate
        this.floatView = new Float64Array(sharedBuffer, 32, 1);
    }

    set(rate) {
        this.mux.enter();
        this.floatView[0] = rate;
        this.mux.exit();
    }

    get() {
        this.mux.enter();
        const rate = this.floatView[0];
        this.mux.exit();
        return rate;
    }
}

if (isMainThread) {
    const sharedBuffer = new SharedArrayBuffer(64);
    const stratum = new StratumNetworkInfo(sharedBuffer);
    const monitor = new MonitorHashrate(sharedBuffer);

    // Initial state
    stratum.set(800000, 800000000.0);
    monitor.set(450000.0);

    const NUM_WORKERS = 4;
    const ITERATIONS = 1000000;
    let completed = 0;
    const results = [];

    console.log(`[HARNESS 1] Starting spinlock stress test with ${NUM_WORKERS} concurrent threads, ${ITERATIONS} iterations each...`);

    for (let i = 0; i < NUM_WORKERS; i++) {
        const worker = new Worker(__filename, {
            workerData: { id: i, sharedBuffer, iterations: ITERATIONS }
        });

        worker.on('message', (msg) => {
            results.push(msg);
            completed++;
            if (completed === NUM_WORKERS) {
                let totalTornReads = results.reduce((acc, r) => acc + r.tornReads, 0);
                let totalOps = results.reduce((acc, r) => acc + r.ops, 0);
                console.log(`[HARNESS 1] Completed ${totalOps} operations across ${NUM_WORKERS} threads.`);
                console.log(`[HARNESS 1] Torn reads / Inconsistencies detected: ${totalTornReads}`);
                if (totalTornReads === 0) {
                    console.log(`[HARNESS 1] PASS: Concurrency safety and spinlock isolation verified!`);
                } else {
                    console.error(`[HARNESS 1] FAIL: Detected ${totalTornReads} torn reads!`);
                    process.exit(1);
                }
            }
        });
    }
} else {
    const { id, sharedBuffer, iterations } = workerData;
    const stratum = new StratumNetworkInfo(sharedBuffer);
    const monitor = new MonitorHashrate(sharedBuffer);

    let tornReads = 0;
    let ops = 0;

    for (let i = 1; i <= iterations; i++) {
        if (id % 2 === 0) {
            // Writer thread (simulates Stratum task & Monitor task on Core 0)
            const k = (i % 1000) + 1;
            stratum.set(k, k * 1000.0);
            monitor.set(k * 10.0);
            ops += 2;
        } else {
            // Reader thread (simulates Display task / Web server / REST API calling getters)
            const sInfo = stratum.get();
            const rate = monitor.get();
            ops += 2;

            // Verify consistency: height and diff must match (diff == height * 1000.0)
            if (sInfo.valid) {
                if (sInfo.height > 0 && sInfo.diff > 0.0) {
                    if (Math.abs(sInfo.diff - sInfo.height * 1000.0) > 1e-5) {
                        tornReads++;
                    }
                }
            }
            if (rate < 0 || isNaN(rate)) {
                tornReads++;
            }
        }
    }

    parentPort.postMessage({ id, ops, tornReads });
}
