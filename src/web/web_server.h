/*
 * SparkMiner - Asynchronous Web Server & REST API
 * Pinned to Core 0 (Priority 2) for zero mining disruption
 *
 * GPL v3 License
 */

#ifndef WEB_SERVER_H
#define WEB_SERVER_H

#include <Arduino.h>

#if defined(USE_WEB_SERVER) && USE_WEB_SERVER

/**
 * Initialize and start the asynchronous HTTP web server and mDNS responder.
 * Should be called once WiFi is connected (STA mode).
 * Thread-safe and idempotent (safe to call multiple times).
 */
void web_server_init();

/**
 * Stop the web server and mDNS responder.
 * Closes active connections and releases listening sockets.
 */
void web_server_stop();

/**
 * Query whether the web server is actively running and listening.
 * @return true if running, false otherwise
 */
bool web_server_is_running();

#else

// Web server disabled for this build target: no-op stubs so callers link cleanly.
static inline void web_server_init() {}
static inline void web_server_stop() {}
static inline bool web_server_is_running() { return false; }

#endif // USE_WEB_SERVER

#endif // WEB_SERVER_H
