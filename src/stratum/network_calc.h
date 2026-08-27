/*
 * SparkMiner - Stratum Network Calculations
 * Derives Bitcoin network difficulty and block height directly from Stratum mining jobs.
 *
 * Zero heap allocation, fully defensive bounds-checked parsing.
 */

#ifndef NETWORK_CALC_H
#define NETWORK_CALC_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * Convert 8-character hex nBits string (compact target) to Bitcoin network difficulty.
 *
 * @param nbits_hex 8-character hex string (e.g. "1703a30c" or "1d00ffff")
 * @return double Network difficulty, or 0.0 on invalid input
 */
double nbits_to_difficulty(const char* nbits_hex);

/**
 * Parse BIP34 block height from coinbase1 hex string.
 *
 * @param coinbase1_hex Hex string of coinBase1 from mining.notify
 * @return uint32_t Block height, or 0 on error / unsupported format
 */
uint32_t coinbase_to_block_height(const char* coinbase1_hex);

/**
 * Inline alias for PLAN.md section 3.1 naming compatibility
 */
static inline uint32_t coinbase_to_height(const char* coinBase1Hex) {
    return coinbase_to_block_height(coinBase1Hex);
}

#ifdef __cplusplus
}
#endif

#endif // NETWORK_CALC_H
