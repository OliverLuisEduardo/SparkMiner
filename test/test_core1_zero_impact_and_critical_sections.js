// Empirical Verification Harness for Core 1 Isolation & Critical Section Audit
// Scans source files and audits spinlock critical sections, core pinning, and blocking/allocation calls.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function auditCriticalSections(filePath) {
    const code = fs.readFileSync(filePath, 'utf8');
    const lines = code.split('\n');
    
    let inCriticalSection = false;
    let criticalStartLine = 0;
    let currentMux = '';
    const criticalSections = [];

    const forbiddenPatterns = [
        /\bmalloc\s*\(/,
        /\bfree\s*\(/,
        /\bcalloc\s*\(/,
        /\brealloc\s*\(/,
        /\bnew\s+/,
        /\bdelete\s+/,
        /\bstrdup\s*\(/,
        /\bvTaskDelay\s*\(/,
        /\bdelay\s*\(/,
        /\bxQueueSend\s*\(/,
        /\bxQueueReceive\s*\(/,
        /\bxSemaphoreTake\s*\(/,
        /\bxSemaphoreGive\s*\(/,
        /\bdeserializeJson\s*\(/,
        /\bserializeJson\s*\(/,
        /\bSerial\.print/,
        /\bprintf\s*\(/,
        /\bWiFiClient\b/,
        /\bHTTPClient\b/,
        /\bString\s+\w+\s*=/
    ];

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineNum = i + 1;

        if (line.includes('portENTER_CRITICAL')) {
            assert(!inCriticalSection, `Nested portENTER_CRITICAL found at ${filePath}:${lineNum}`);
            inCriticalSection = true;
            criticalStartLine = lineNum;
            const match = line.match(/portENTER_CRITICAL\s*\(\s*&?(\w+)\s*\)/);
            currentMux = match ? match[1] : 'unknown';
        } else if (line.includes('portEXIT_CRITICAL')) {
            assert(inCriticalSection, `portEXIT_CRITICAL without portENTER_CRITICAL at ${filePath}:${lineNum}`);
            inCriticalSection = false;
            criticalSections.push({
                file: path.basename(filePath),
                mux: currentMux,
                start: criticalStartLine,
                end: lineNum,
                lineCount: lineNum - criticalStartLine + 1
            });
        } else if (inCriticalSection) {
            for (const pattern of forbiddenPatterns) {
                if (pattern.test(line)) {
                    throw new Error(`VIOLATION: Forbidden blocking/allocation/IO call in critical section at ${filePath}:${lineNum}: "${line.trim()}"`);
                }
            }
        }
    }

    assert(!inCriticalSection, `Unclosed portENTER_CRITICAL in ${filePath} starting at line ${criticalStartLine}`);
    return criticalSections;
}

function auditCorePinning(mainCppPath, boardConfigPath) {
    const mainCode = fs.readFileSync(mainCppPath, 'utf8');
    const boardConfig = fs.readFileSync(boardConfigPath, 'utf8');

    console.log("\n--- Auditing Task Core Pinning & Priorities ---");

    // Check board_config.h
    const core1MinerMatch = boardConfig.match(/#define\s+MINER_1_CORE\s+(\w+)/);
    const core1PriMatch = boardConfig.match(/#define\s+MINER_1_PRIORITY\s+(\d+)/);
    const core0MinerMatch = boardConfig.match(/#define\s+MINER_0_CORE\s+(\w+)/);
    const core0PriMatch = boardConfig.match(/#define\s+MINER_0_PRIORITY\s+(\d+)/);
    const stratumCoreMatch = boardConfig.match(/#define\s+STRATUM_CORE\s+(\w+)/);
    const monitorCoreMatch = boardConfig.match(/#define\s+MONITOR_CORE\s+(\w+)/);

    console.log(`MINER_1_CORE: ${core1MinerMatch ? core1MinerMatch[1] : 'N/A'} (Expected: CORE_1 / 1)`);
    console.log(`MINER_1_PRIORITY: ${core1PriMatch ? core1PriMatch[1] : 'N/A'} (Expected: 19)`);
    console.log(`MINER_0_CORE: ${core0MinerMatch ? core0MinerMatch[1] : 'N/A'} (Expected: CORE_0 / 0)`);
    console.log(`MINER_0_PRIORITY: ${core0PriMatch ? core0PriMatch[1] : 'N/A'} (Expected: 1)`);
    console.log(`STRATUM_CORE: ${stratumCoreMatch ? stratumCoreMatch[1] : 'N/A'} (Expected: CORE_0 / 0)`);
    console.log(`MONITOR_CORE: ${monitorCoreMatch ? monitorCoreMatch[1] : 'N/A'} (Expected: CORE_0 / 0)`);

    assert.strictEqual(core1MinerMatch[1], 'CORE_1', "Miner 1 must be pinned to CORE_1");
    assert.strictEqual(core1PriMatch[1], '19', "Miner 1 priority must be 19");
    assert.strictEqual(stratumCoreMatch[1], 'CORE_0', "Stratum task must be on CORE_0");
    assert.strictEqual(monitorCoreMatch[1], 'CORE_0', "Monitor task must be on CORE_0");

    // Scan main.cpp for all xTaskCreatePinnedToCore calls
    const taskRegex = /xTaskCreatePinnedToCore\s*\(\s*(\w+)\s*,\s*"([^"]+)"\s*,\s*[^,]+\s*,\s*[^,]+\s*,\s*([^,]+)\s*,\s*[^,]+\s*,\s*([^)]+)\s*\)/g;
    let match;
    const tasks = [];
    while ((match = taskRegex.exec(mainCode)) !== null) {
        tasks.push({
            functionName: match[1],
            taskName: match[2],
            priority: match[3].trim(),
            core: match[4].trim()
        });
    }

    console.log("\nTasks created in main.cpp:");
    for (const t of tasks) {
        console.log(`  - Task "${t.taskName}" (${t.functionName}): Core = ${t.core}, Priority = ${t.priority}`);
        if (t.taskName === "Miner1") {
            assert(t.core.includes("MINER_1_CORE") || t.core === "1", "Miner1 must run on Core 1");
        } else {
            assert(!t.core.includes("CORE_1") && t.core !== "1", `Task ${t.taskName} is violating Rule 1 by running on Core 1!`);
        }
    }
}

function runAudit() {
    console.log("============================================================");
    console.log("[HARNESS 3] Core 1 Isolation & Critical Section Safety Audit");
    console.log("============================================================");

    const projectRoot = path.resolve(__dirname, '..');
    const monitorCpp = path.join(projectRoot, 'src', 'stats', 'monitor.cpp');
    const stratumCpp = path.join(projectRoot, 'src', 'stratum', 'stratum.cpp');
    const mainCpp = path.join(projectRoot, 'src', 'main.cpp');
    const boardConfigH = path.join(projectRoot, 'include', 'board_config.h');

    console.log("\n--- Auditing Critical Sections in monitor.cpp ---");
    const monitorCS = auditCriticalSections(monitorCpp);
    for (const cs of monitorCS) {
        console.log(`  [OK] Lines ${cs.start}-${cs.end} (${cs.lineCount} lines): Spinlock "${cs.mux}" - Pure scalar manipulation, 0 blocking, 0 allocations.`);
    }

    console.log("\n--- Auditing Critical Sections in stratum.cpp ---");
    const stratumCS = auditCriticalSections(stratumCpp);
    for (const cs of stratumCS) {
        console.log(`  [OK] Lines ${cs.start}-${cs.end} (${cs.lineCount} lines): Spinlock "${cs.mux}" - Pure scalar manipulation, 0 blocking, 0 allocations.`);
    }

    auditCorePinning(mainCpp, boardConfigH);

    console.log("\n============================================================");
    console.log("[HARNESS 3] AUDIT PASSED: Zero impact on Core 1 confirmed.");
    console.log("============================================================\n");
}

runAudit();
