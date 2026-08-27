/*
 * SparkMiner - Stratum Network Calculations
 * Implementation of nbits_to_difficulty and coinbase_to_block_height.
 */

#include "network_calc.h"
#include <string.h>
#include <stdlib.h>
#include <math.h>

// Helper to decode single hex character: returns 0..15 or -1 on invalid character
static inline int hex_char_to_val(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// Helper to decode 2 hex characters into a byte
static inline bool parse_hex_byte(const char *hex, uint8_t *out) {
    int high = hex_char_to_val(hex[0]);
    int low = hex_char_to_val(hex[1]);
    if (high < 0 || low < 0) return false;
    *out = (uint8_t)((high << 4) | low);
    return true;
}

double nbits_to_difficulty(const char* nbits_hex) {
    if (!nbits_hex) return 0.0;
    
    // nBits must be exactly 8 hex characters (4 bytes)
    if (strlen(nbits_hex) != 8) return 0.0;

    // Validate all characters
    for (int i = 0; i < 8; i++) {
        if (hex_char_to_val(nbits_hex[i]) < 0) {
            return 0.0;
        }
    }

    uint32_t nbits = (uint32_t)strtoul(nbits_hex, NULL, 16);

    uint32_t exponent = (nbits >> 24) & 0xFF;
    uint32_t sign = nbits & 0x00800000;
    uint32_t mantissa = nbits & 0x007FFFFF;

    // Bitcoin compact target rules:
    // - Sign bit (0x00800000) indicates negative target -> invalid
    // - Mantissa == 0 -> invalid
    // - Exponent == 0 or Exponent > 32 (256 bits) -> invalid
    if (sign != 0 || mantissa == 0 || exponent == 0 || exponent > 32) {
        return 0.0;
    }

    // Difficulty formula:
    // Target1 = 0x0000ffff * 256^(0x1d - 3) = 65535 * 256^26
    // Target  = mantissa * 256^(exponent - 3)
    // Diff    = Target1 / Target = (65535.0 / mantissa) * 256^(29 - exponent)
    //         = (65535.0 / mantissa) * 2^(8 * (29 - exponent))
    int exp_diff = 29 - (int)exponent;
    double diff = ldexp(65535.0 / (double)mantissa, 8 * exp_diff);

    if (isnan(diff) || isinf(diff) || diff <= 0.0) {
        return 0.0;
    }

    return diff;
}

uint32_t coinbase_to_block_height(const char* coinbase1_hex) {
    if (!coinbase1_hex) return 0;

    size_t len = strlen(coinbase1_hex);
    
    // Minimum length check:
    // 4B Version (8 hex) + 1B InCount (2 hex) + 32B PrevTxID (64 hex) + 4B PrevIdx (8 hex) +
    // 1B ScriptLen (2 hex) + 1B PushOpcode (2 hex) + 1B Height (2 hex) = 88 hex characters
    if (len < 88) return 0;

    size_t idx = 0;

    // 1. Skip Version (4 bytes = 8 hex chars)
    idx += 8;

    // 2. Parse Input Count VarInt
    uint8_t in_count_hdr = 0;
    if (!parse_hex_byte(coinbase1_hex + idx, &in_count_hdr)) return 0;
    if (in_count_hdr < 0xFD) {
        idx += 2;
    } else if (in_count_hdr == 0xFD) {
        idx += 6;
    } else if (in_count_hdr == 0xFE) {
        idx += 10;
    } else {
        idx += 18;
    }

    // 3. Skip Prevout (32 bytes hash + 4 bytes index = 36 bytes = 72 hex chars)
    if (len < idx + 72) return 0;
    idx += 72;

    // 4. Parse scriptSig Length VarInt
    if (len < idx + 2) return 0;
    uint8_t script_len_hdr = 0;
    if (!parse_hex_byte(coinbase1_hex + idx, &script_len_hdr)) return 0;
    if (script_len_hdr < 0xFD) {
        idx += 2;
    } else if (script_len_hdr == 0xFD) {
        idx += 6;
    } else if (script_len_hdr == 0xFE) {
        idx += 10;
    } else {
        idx += 18;
    }

    // 5. Read first opcode of scriptSig (BIP34 height push)
    if (len < idx + 2) return 0;
    uint8_t opcode = 0;
    if (!parse_hex_byte(coinbase1_hex + idx, &opcode)) return 0;
    idx += 2;

    // 6. Decode Height
    // Case A: Data push 1..4 bytes (0x01..0x04)
    if (opcode >= 0x01 && opcode <= 0x04) {
        uint8_t push_len = opcode;
        if (len < idx + (push_len * 2)) return 0;

        uint32_t height = 0;
        for (uint8_t i = 0; i < push_len; i++) {
            uint8_t b = 0;
            if (!parse_hex_byte(coinbase1_hex + idx + (i * 2), &b)) {
                return 0;
            }
            height |= ((uint32_t)b) << (i * 8);
        }
        return height;
    }
    
    // Case B: Direct OP_1..OP_16 (0x51..0x60)
    if (opcode >= 0x51 && opcode <= 0x60) {
        return (uint32_t)(opcode - 0x50);
    }

    // Case C: OP_0 (0x00) -> Genesis block
    if (opcode == 0x00) {
        return 0;
    }

    return 0;
}
