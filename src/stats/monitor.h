/*
 * SparkMiner - Monitor Task
 * Coordinates display updates and live stats fetching
 */

#ifndef MONITOR_H
#define MONITOR_H

#include <Arduino.h>

/**
 * Initialize monitor subsystem
 */
void monitor_init();

/**
 * Monitor task (runs on Core 0)
 * Updates display and fetches live stats periodically
 */
void monitor_task(void *param);

/**
 * Reset screen timeout activity timer
 * Call on user input (button press, touch) to keep screen on
 */
void monitor_reset_activity();

/**
 * Get smoothed hashrate (exponential moving average over ~30s window)
 * Thread-safe getter
 * @return Smoothed hashrate in H/s
 */
double monitor_get_hashrate();

#endif // MONITOR_H
