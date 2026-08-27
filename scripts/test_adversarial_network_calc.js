/**
 * SparkMiner - Adversarial Test Harness for Stratum Network Calculations
 * Empirical verification of nbits_to_difficulty and coinbase_to_block_height.
 */

const fs = require('fs');
const crypto = require('crypto');

// --- Helper Functions Emulating C++ network_calc.cpp ---

function hex_char_to_val(c) {
    const code = c.charCodeAt(0);
    if (code >= 48 && code <= 57) return code - 48; // '0'-'9'
    if (code >= 97 && code <= 102) return code - 97 + 10; // 'a'-'f'
    if (code >= 65 && code <= 70) return code - 65 + 10; // 'A'-'F'
    return -1;
}

function parse_hex_byte(hex, offset) {
    if (offset + 1 >= hex.length) return null;
    const high = hex_char_to_val(hex[offset]);
    const low = hex_char_to_val(hex[offset + 1]);
    if (high < 0 || low < 0) return null;
    return (high << 4) | low;
}

// C++ Implementation of nbits_to_difficulty (src/stratum/network_calc.cpp:28-68)
function cpp_nbits_to_difficulty(nbits_hex) {
    if (!nbits_hex || typeof nbits_hex !== 'string') return 0.0;
    if (nbits_hex.length !== 8) return 0.0;

    for (let i = 0; i < 8; i++) {
        if (hex_char_to_val(nbits_hex[i]) < 0) return 0.0;
    }

    const nbits = parseInt(nbits_hex, 16) >>> 0;
    const exponent = (nbits >>> 24) & 0xFF;
    const sign = nbits & 0x00800000;
    const mantissa = nbits & 0x007FFFFF;

    if (sign !== 0 || mantissa === 0 || exponent === 0 || exponent > 32) {
        return 0.0;
    }

    const exp_diff = 29 - exponent;
    const diff = (65535.0 / mantissa) * Math.pow(2, 8 * exp_diff);

    if (isNaN(diff) || !isFinite(diff) || diff <= 0.0) {
        return 0.0;
    }

    return diff;
}

// C++ Implementation of coinbase_to_block_height (src/stratum/network_calc.cpp:70-150)
function cpp_coinbase_to_block_height(coinbase1_hex) {
    if (!coinbase1_hex || typeof coinbase1_hex !== 'string') return 0;

    const len = coinbase1_hex.length;
    if (len < 88) return 0;

    let idx = 0;
    // 1. Skip Version (4 bytes = 8 hex chars)
    idx += 8;

    // 2. Parse Input Count VarInt
    const in_count_hdr = parse_hex_byte(coinbase1_hex, idx);
    if (in_count_hdr === null) return 0;
    if (in_count_hdr < 0xFD) {
        idx += 2;
    } else if (in_count_hdr === 0xFD) {
        idx += 6;
    } else if (in_count_hdr === 0xFE) {
        idx += 10;
    } else {
        idx += 18;
    }

    // 3. Skip Prevout (36 bytes = 72 hex chars)
    if (len < idx + 72) return 0;
    idx += 72;

    // 4. Parse scriptSig Length VarInt
    if (len < idx + 2) return 0;
    const script_len_hdr = parse_hex_byte(coinbase1_hex, idx);
    if (script_len_hdr === null) return 0;
    if (script_len_hdr < 0xFD) {
        idx += 2;
    } else if (script_len_hdr === 0xFD) {
        idx += 6;
    } else if (script_len_hdr === 0xFE) {
        idx += 10;
    } else {
        idx += 18;
    }

    // 5. Read first opcode of scriptSig
    if (len < idx + 2) return 0;
    const opcode = parse_hex_byte(coinbase1_hex, idx);
    if (opcode === null) return 0;
    idx += 2;

    // 6. Decode Height
    // Case A: Data push 1..4 bytes (0x01..0x04)
    if (opcode >= 0x01 && opcode <= 0x04) {
        const push_len = opcode;
        if (len < idx + (push_len * 2)) return 0;

        let height = 0;
        for (let i = 0; i < push_len; i++) {
            const b = parse_hex_byte(coinbase1_hex, idx + (i * 2));
            if (b === null) return 0;
            height = (height | (b << (i * 8))) >>> 0;
        }
        return height;
    }

    // Case B: Direct OP_1..OP_16 (0x51..0x60)
    if (opcode >= 0x51 && opcode <= 0x60) {
        return (opcode - 0x50) >>> 0;
    }

    // Case C: OP_0 (0x00)
    if (opcode === 0x00) {
        return 0;
    }

    return 0;
}

// Independent Reference Oracle using standard Bitcoin compact target ratio: Target(0x1d00ffff) / Target(nbits)
function oracle_nbits_to_difficulty(nbits_hex) {
    if (!nbits_hex || typeof nbits_hex !== 'string' || nbits_hex.length !== 8) return 0.0;
    if (!/^[0-9a-fA-F]{8}$/.test(nbits_hex)) return 0.0;

    const nbits = parseInt(nbits_hex, 16) >>> 0;
    const exponent = (nbits >>> 24) & 0xFF;
    const sign = nbits & 0x00800000;
    const mantissa = nbits & 0x007FFFFF;

    if (sign !== 0 || mantissa === 0 || exponent === 0 || exponent > 32) return 0.0;

    const target1 = 65535.0 * Math.pow(256, 26);
    const target = mantissa * Math.pow(256, exponent - 3);

    return target1 / target;
}

function buildCoinbase1({
    versionHex = "01000000",
    inCountVarInt = "01",
    prevoutHex = "0000000000000000000000000000000000000000000000000000000000000000ffffffff",
    scriptLenVarInt = "04",
    scriptSigPrefix = ""
}) {
    return versionHex + inCountVarInt + prevoutHex + scriptLenVarInt + scriptSigPrefix;
}

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failureLog = [];

function assertTest(name, condition, details = "") {
    totalTests++;
    if (condition) {
        passedTests++;
    } else {
        failedTests++;
        failureLog.push(`FAIL: ${name} — ${details}`);
        console.error(`[FAIL] ${name}: ${details}`);
    }
}

console.log("================================================================================");
console.log("   SPARKMINER EMPIRICAL CHALLENGE — STRATUM NETWORK CALCULATIONS TEST HARNESS   ");
console.log("================================================================================\n");

// SECTION 1: NBITS MATHEMATICAL ACCURACY
console.log("--- Section 1: nbits_to_difficulty Mathematical Accuracy vs Oracle ---");

const knownMainnetBlocks = [
    { name: "Genesis (Block 0)", nbits: "1d00ffff", expectedDiff: 1.0 },
    { name: "Block 32256", nbits: "1d00d86a", expectedDiff: 1.1828995343128408 },
    { name: "Block 100000 Target", nbits: "1a044b74", expectedDiff: 3906398.2468556813 },
    { name: "Block 200000 Target", nbits: "1a057b42", expectedDiff: 3060664.777164745 },
    { name: "Block 300000 Target", nbits: "1832413a", expectedDiff: 21878408466.105083 },
    { name: "Block 400000 Target", nbits: "18055bf9", expectedDiff: 205157646882.4832 },
    { name: "Block 500000 Target", nbits: "1800d633", expectedDiff: 1314060263085.6235 },
    { name: "Block 600000 Target", nbits: "17148bf0", expectedDiff: 13699116106664.797 },
    { name: "Block 700000 Target", nbits: "170e7e29", expectedDiff: 19421397322947.48 },
    { name: "Block 800000 Target", nbits: "17079b76", expectedDiff: 37000225852437.75 },
    { name: "Stratum Target (77.39 T)", nbits: "1703a30c", expectedDiff: 77392982524430.0 },
    { name: "Block 840000 Actual (86.39 T)", nbits: "17034219", expectedDiff: 86388558925353.48 },
    { name: "Current Era (~105.68 T)", nbits: "1702a9cf", expectedDiff: 105684344824672.67 },
    { name: "Current Era (~109.92 T)", nbits: "17028f86", expectedDiff: 109922072048415.75 }
];

for (const b of knownMainnetBlocks) {
    const diff = cpp_nbits_to_difficulty(b.nbits);
    const oracleDiff = oracle_nbits_to_difficulty(b.nbits);
    const relError = Math.abs(diff - b.expectedDiff) / b.expectedDiff;
    const oracleRelError = Math.abs(diff - oracleDiff) / oracleDiff;

    assertTest(
        `Mainnet nbits ${b.name} (${b.nbits})`,
        relError < 1e-10 && oracleRelError < 1e-12,
        `cpp=${diff}, expected=${b.expectedDiff}, oracle=${oracleDiff}, relErr=${relError}`
    );
}

// Valid exponents 1..32 with various mantissas
for (let exp = 1; exp <= 32; exp++) {
    const mantissas = [1, 2, 0x10, 0x100, 0x1000, 0x03a30c, 0x00ffff, 0x123456, 0x7ffffe, 0x7fffff];
    for (const mant of mantissas) {
        const nbitsVal = ((exp << 24) | mant) >>> 0;
        const hex = nbitsVal.toString(16).padStart(8, '0');
        const diff = cpp_nbits_to_difficulty(hex);
        const oracleDiff = oracle_nbits_to_difficulty(hex);

        const relErr = Math.abs(diff - oracleDiff) / oracleDiff;
        assertTest(
            `Exponent ${exp} with Mantissa 0x${mant.toString(16)} (hex=${hex})`,
            diff > 0 && relErr < 1e-12,
            `diff=${diff}, oracle=${oracleDiff}, relErr=${relErr}`
        );
    }
}

// SECTION 2: NBITS ADVERSARIAL EDGE CASES
console.log("\n--- Section 2: nbits_to_difficulty Adversarial Edge Cases & Rejections ---");

const nbitsHostileCases = [
    { desc: "Null pointer / undefined", input: null, expected: 0.0 },
    { desc: "Undefined", input: undefined, expected: 0.0 },
    { desc: "Empty string", input: "", expected: 0.0 },
    { desc: "1 char", input: "1", expected: 0.0 },
    { desc: "7 chars", input: "1703a30", expected: 0.0 },
    { desc: "9 chars", input: "1703a30c0", expected: 0.0 },
    { desc: "Whitespace leading", input: " 1703a30", expected: 0.0 },
    { desc: "Whitespace trailing", input: "1703a30 ", expected: 0.0 },
    { desc: "Whitespace embedded", input: "1703 30c", expected: 0.0 },
    { desc: "Non-hex character 'g'", input: "1703a30g", expected: 0.0 },
    { desc: "Non-hex character 'Z'", input: "1703a30Z", expected: 0.0 },
    { desc: "Non-hex character '!'", input: "1703a30!", expected: 0.0 },
    { desc: "Prefix 0x (10 chars)", input: "0x1703a3", expected: 0.0 },
    { desc: "Negative hex '-1703a3'", input: "-1703a30", expected: 0.0 },
    { desc: "Zero mantissa (0x17000000)", input: "17000000", expected: 0.0 },
    { desc: "Zero exponent (0x0000ffff)", input: "0000ffff", expected: 0.0 },
    { desc: "Zero nbits (0x00000000)", input: "00000000", expected: 0.0 },
    { desc: "Exponent = 33 (0x2100ffff)", input: "2100ffff", expected: 0.0 },
    { desc: "Exponent = 34 (0x2200ffff)", input: "2200ffff", expected: 0.0 },
    { desc: "Exponent = 255 (0xff00ffff)", input: "ff00ffff", expected: 0.0 },
    { desc: "Negative sign bit (0x1783a30c)", input: "1783a30c", expected: 0.0 },
    { desc: "Negative sign bit with 1 (0x1d800001)", input: "1d800001", expected: 0.0 },
    { desc: "Negative sign bit max (0x1dffffff)", input: "1dffffff", expected: 0.0 }
];

for (const tc of nbitsHostileCases) {
    const res = cpp_nbits_to_difficulty(tc.input);
    assertTest(`nbits rejection: ${tc.desc}`, res === tc.expected, `got ${res}, expected ${tc.expected}`);
}

const caseVectors = ["1703A30C", "1703a30c", "1703A30c", "1D00FFFF", "1d00ffff", "1D00FfFf"];
for (const v of caseVectors) {
    const res = cpp_nbits_to_difficulty(v);
    assertTest(`nbits case insensitivity '${v}'`, res > 0, `got ${res}`);
}

// SECTION 3: COINBASE_TO_BLOCK_HEIGHT BIP34 HEIGHTS
console.log("\n--- Section 3: coinbase_to_block_height BIP34 Mainnet & Historical Heights ---");

const realBlockVectors = [
    {
        name: "Genesis Block (height 0, OP_0)",
        height: 0,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "00" + "ffffffff" })
    },
    {
        name: "Block 1 (height 1, OP_1)",
        height: 1,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "51" + "00000000" })
    },
    {
        name: "Block 1 (height 1, 1-byte push 0x0101)",
        height: 1,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "0101" + "00000000" })
    },
    {
        name: "Block 16 (height 16, OP_16 0x60)",
        height: 16,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "60" + "00000000" })
    },
    {
        name: "Block 16 (height 16, 1-byte push 0x0110)",
        height: 16,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "0110" + "00000000" })
    },
    {
        name: "Block 17 (height 17, 1-byte push 0x0111)",
        height: 17,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "0111" + "00000000" })
    },
    {
        name: "Block 127 (height 127, 1-byte push 0x017f)",
        height: 127,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "017f" + "00000000" })
    },
    {
        name: "Block 128 (height 128, 2-byte push 0x028000)",
        height: 128,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "028000" + "00000000" })
    },
    {
        name: "Block 255 (height 255, 2-byte push 0x02ff00)",
        height: 255,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "02ff00" + "00000000" })
    },
    {
        name: "Block 256 (height 256, 2-byte push 0x020001)",
        height: 256,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "020001" + "00000000" })
    },
    {
        name: "Block 32767 (height 32767, 2-byte push 0x02ff7f)",
        height: 32767,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "02ff7f" + "00000000" })
    },
    {
        name: "Block 32768 (height 32768, 3-byte push 0x03008000)",
        height: 32768,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "03008000" + "00000000" })
    },
    {
        name: "Block 227836 (BIP34 Activation, 3-byte push 0x03fc7903)",
        height: 227836,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "03fc7903" + "00000000" })
    },
    {
        name: "Block 500000 (3-byte push 0x0320a107)",
        height: 500000,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "0320a107" + "00000000" })
    },
    {
        name: "Block 840000 (Halving 2024, 3-byte push 0x0340d10c)",
        height: 840000,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "0340d10c" + "00000000" })
    },
    {
        name: "Block 885000 (Current Era, 3-byte push 0x0308810d)",
        height: 885000,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "0308810d" + "00000000" })
    },
    {
        name: "Block 8388607 (Max 3-byte, 0x03ffff7f)",
        height: 8388607,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "03ffff7f" + "00000000" })
    },
    {
        name: "Block 8388608 (Min 4-byte, 0x0400008000)",
        height: 8388608,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "0400008000" + "00000000" })
    },
    {
        name: "Block 10000000 (4-byte push 0x0480969800)",
        height: 10000000,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "0480969800" + "00000000" })
    },
    {
        name: "Block 4000000000 (4-byte push 0x0400286bee)",
        height: 4000000000,
        coinbase1: buildCoinbase1({ scriptSigPrefix: "0400286bee" + "00000000" })
    }
];

for (const rb of realBlockVectors) {
    const res = cpp_coinbase_to_block_height(rb.coinbase1);
    assertTest(
        `Coinbase Height: ${rb.name}`,
        res === rb.height,
        `got ${res}, expected ${rb.height}`
    );
}

// SECTION 4: VARINT ENCODINGS
console.log("\n--- Section 4: coinbase_to_block_height VarInt Decoding Resilience ---");

const varIntVariants = [
    {
        desc: "InCount 1-byte (0x01)",
        coinbase1: buildCoinbase1({ inCountVarInt: "01", scriptSigPrefix: "0340d10c00" }),
        expected: 840000
    },
    {
        desc: "InCount 3-byte VarInt (0xfd0100)",
        coinbase1: buildCoinbase1({ inCountVarInt: "fd0100", scriptSigPrefix: "0340d10c00" }),
        expected: 840000
    },
    {
        desc: "InCount 5-byte VarInt (0xfe01000000)",
        coinbase1: buildCoinbase1({ inCountVarInt: "fe01000000", scriptSigPrefix: "0340d10c00" }),
        expected: 840000
    },
    {
        desc: "InCount 9-byte VarInt (0xff0100000000000000)",
        coinbase1: buildCoinbase1({ inCountVarInt: "ff0100000000000000", scriptSigPrefix: "0340d10c00" }),
        expected: 840000
    },
    {
        desc: "ScriptLen 1-byte (0x24)",
        coinbase1: buildCoinbase1({ scriptLenVarInt: "24", scriptSigPrefix: "0340d10c00" }),
        expected: 840000
    },
    {
        desc: "ScriptLen 3-byte VarInt (0xfd6400)",
        coinbase1: buildCoinbase1({ scriptLenVarInt: "fd6400", scriptSigPrefix: "0340d10c00" }),
        expected: 840000
    },
    {
        desc: "ScriptLen 5-byte VarInt (0xfe64000000)",
        coinbase1: buildCoinbase1({ scriptLenVarInt: "fe64000000", scriptSigPrefix: "0340d10c00" }),
        expected: 840000
    },
    {
        desc: "ScriptLen 9-byte VarInt (0xff6400000000000000)",
        coinbase1: buildCoinbase1({ scriptLenVarInt: "ff6400000000000000", scriptSigPrefix: "0340d10c00" }),
        expected: 840000
    },
    {
        desc: "Both InCount 3-byte and ScriptLen 3-byte VarInts",
        coinbase1: buildCoinbase1({ inCountVarInt: "fd0100", scriptLenVarInt: "fd5000", scriptSigPrefix: "0340d10c00" }),
        expected: 840000
    }
];

for (const vi of varIntVariants) {
    const res = cpp_coinbase_to_block_height(vi.coinbase1);
    assertTest(`VarInt variant: ${vi.desc}`, res === vi.expected, `got ${res}, expected ${vi.expected}`);
}

// SECTION 5: ADVERSARIAL TRUNCATIONS & BOUNDARIES
console.log("\n--- Section 5: coinbase_to_block_height Truncation & Boundaries ---");

const baseValidCoinbase = buildCoinbase1({ scriptSigPrefix: "0340d10c" }); // 88 hex chars

// 1. Truncate character by character from length 0 to 87
for (let l = 0; l < 88; l++) {
    const truncated = baseValidCoinbase.slice(0, l);
    const res = cpp_coinbase_to_block_height(truncated);
    assertTest(`Truncation at length ${l} (<88)`, res === 0, `got ${res}, expected 0`);
}

// 2. Odd lengths >= 88
const oddCoinbases = [
    baseValidCoinbase + "0",      // 89 chars
    baseValidCoinbase + "000",    // 91 chars
    baseValidCoinbase + "00000"   // 93 chars
];
for (const odd of oddCoinbases) {
    const res = cpp_coinbase_to_block_height(odd);
    assertTest(`Odd length coinbase (${odd.length} chars)`, res === 840000, `got ${res}, expected 840000`);
}

// 3. Corrupt byte boundaries that are parsed by parse_hex_byte
const parsedIndices = [8, 9, 82, 83, 84, 85, 86, 87];
for (const idx of parsedIndices) {
    const corrupted = baseValidCoinbase.substring(0, idx) + 'X' + baseValidCoinbase.substring(idx + 1);
    const res = cpp_coinbase_to_block_height(corrupted);
    assertTest(`Corrupted parsed byte at index ${idx} ('X')`, res === 0, `got ${res}, expected 0`);
}

// 4. Truncated VarInt headers
const truncatedVarInts = [
    "01000000" + "fd01" + "0000000000000000000000000000000000000000000000000000000000000000ffffffff" + "04" + "0340d10c",
    "01000000" + "fe0100" + "0000000000000000000000000000000000000000000000000000000000000000ffffffff" + "04" + "0340d10c",
    "01000000" + "ff01000000" + "0000000000000000000000000000000000000000000000000000000000000000ffffffff" + "04" + "0340d10c"
];
for (let i = 0; i < truncatedVarInts.length; i++) {
    const res = cpp_coinbase_to_block_height(truncatedVarInts[i]);
    assertTest(`Truncated InCount VarInt #${i}`, res === 0, `got ${res}, expected 0`);
}

// 5. Push opcode requiring more bytes than available
const pushOverflows = [
    buildCoinbase1({ scriptSigPrefix: "0240" }),
    buildCoinbase1({ scriptSigPrefix: "0340d1" }),
    buildCoinbase1({ scriptSigPrefix: "0440d10c" })
];
for (let i = 0; i < pushOverflows.length; i++) {
    const res = cpp_coinbase_to_block_height(pushOverflows[i]);
    assertTest(`Push opcode overflow #${i}`, res === 0, `got ${res}, expected 0`);
}

// 6. Unsupported opcodes
const unsupportedOpcodes = ["05", "4f", "50", "61", "76", "ac", "ff"];
for (const op of unsupportedOpcodes) {
    const cb = buildCoinbase1({ scriptSigPrefix: op + "40d10c00" });
    const res = cpp_coinbase_to_block_height(cb);
    assertTest(`Unsupported opcode 0x${op}`, res === 0, `got ${res}, expected 0`);
}

// 7. Null and empty input
assertTest("Coinbase null pointer", cpp_coinbase_to_block_height(null) === 0, "expected 0");
assertTest("Coinbase undefined", cpp_coinbase_to_block_height(undefined) === 0, "expected 0");
assertTest("Coinbase empty string", cpp_coinbase_to_block_height("") === 0, "expected 0");

// SECTION 6: MINIMAL COINBASE1 EDGE CASE (86 CHARS vs 88 CHARS)
console.log("\n--- Section 6: Minimal Length Boundary Edge Case Analysis ---");
const minimal86CharCoinbase = "01000000" + "01" + "0000000000000000000000000000000000000000000000000000000000000000ffffffff" + "01" + "51";
const res86 = cpp_coinbase_to_block_height(minimal86CharCoinbase);
const padded88CharCoinbase = minimal86CharCoinbase + "00";
const res88 = cpp_coinbase_to_block_height(padded88CharCoinbase);

console.log(`[ANALYSIS] 86-char minimal OP_1 coinbase1 (len=${minimal86CharCoinbase.length}): returned height = ${res86}`);
console.log(`[ANALYSIS] 88-char padded OP_1 coinbase1 (len=${padded88CharCoinbase.length}): returned height = ${res88}`);

assertTest("88-char padded OP_1 coinbase1 returns height 1", res88 === 1, `got ${res88}`);

// SECTION 7: FUZZING AND STRESS TESTING (10,000 Iterations)
console.log("\n--- Section 7: Randomized Fuzzing & Stress Testing (10,000 Iterations) ---");

let fuzzNbitsExceptions = 0;
let fuzzCoinbaseExceptions = 0;

for (let iter = 0; iter < 10000; iter++) {
    // 1. Fuzz nbits
    const randLen = Math.floor(Math.random() * 20);
    const randHex = crypto.randomBytes(randLen).toString('hex').slice(0, randLen);
    try {
        const d = cpp_nbits_to_difficulty(randHex);
        if (isNaN(d) || !isFinite(d) || d < 0) {
            fuzzNbitsExceptions++;
        }
    } catch (e) {
        fuzzNbitsExceptions++;
    }

    // 2. Fuzz coinbase
    const cbLen = Math.floor(Math.random() * 200);
    const randCb = crypto.randomBytes(cbLen).toString('hex').slice(0, cbLen);
    try {
        const h = cpp_coinbase_to_block_height(randCb);
        if (typeof h !== 'number' || h < 0 || !Number.isInteger(h)) {
            fuzzCoinbaseExceptions++;
        }
    } catch (e) {
        fuzzCoinbaseExceptions++;
    }
}

assertTest("Fuzzing nbits_to_difficulty: 0 unexpected exceptions / NaNs across 10,000 vectors", fuzzNbitsExceptions === 0, `exceptions=${fuzzNbitsExceptions}`);
assertTest("Fuzzing coinbase_to_block_height: 0 unexpected exceptions across 10,000 vectors", fuzzCoinbaseExceptions === 0, `exceptions=${fuzzCoinbaseExceptions}`);

// SUMMARY & VERDICT
console.log("\n================================================================================");
console.log(`TOTAL TESTS EXECUTED: ${totalTests}`);
console.log(`PASSED: ${passedTests}`);
console.log(`FAILED: ${failedTests}`);
console.log("================================================================================");

if (failedTests > 0) {
    console.error(`VERDICT: FOUND_BUG (${failedTests} tests failed)`);
    process.exit(1);
} else {
    console.log("VERDICT: CONFIRM_CORRECTNESS (All tests passed with zero errors)");
    process.exit(0);
}
