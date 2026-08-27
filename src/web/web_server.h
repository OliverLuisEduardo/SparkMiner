/*
 * SparkMiner - Asynchronous Web Server & REST API
 * Pinned to Core 0 (Priority 2) for zero mining disruption
 *
 * GPL v3 License
 */

#ifndef WEB_SERVER_H
#define WEB_SERVER_H

#include <Arduino.h>

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

#endif // WEB_SERVER_H
