# Project: SparkMiner ESP32-2432S028 Firmware Enhancements

## Architecture
- **Hardware Target**: ESP32-2432S028 (CYD - Cheap Yellow Display: ESP32-WROOM-32, 2.8" TFT ILI9341 on HSPI, XPT2046 Resistive Touch on VSPI).
- **Core 1 Isolation (Rule 1)**: Core 1 is strictly and exclusively dedicated to `Miner1` task (Priority 19). No new tasks, callbacks, or loops on Core 1.
- **Core 0 Allocation**: All auxiliary tasks (`Miner0`, `StratumTask`, `MonitorTask`, `AsyncTCP`, `WebServer`, `StatsTask`, `Touch`) execute on Core 0 at priorities $\le 2$.
- **Networking & Stratum**: Stratum v1 protocol over TCP socket. Block height derived via BIP34 scriptSig from `job.coinBase1`. Network difficulty derived from `job.nbits` compact target.
- **Web & Async I/O**: `ESP32Async/ESPAsyncWebServer` & `ESP32Async/AsyncTCP` pinned to Core 0 with priority 2 (`-D CONFIG_ASYNC_TCP_RUNNING_CORE=0 -D CONFIG_ASYNC_TCP_TASK_PRIORITY=2`). Zero heap allocation during steady-state polling.
- **Storage & Partitions**: NVS at `0x9000` (`0x5000` size) holds miner config and persistent lifetime statistics. Dual OTA app slots (`app0`, `app1` at `0x1E0000` each).

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Network Difficulty Derivation | Convert `job.nbits` compact target to difficulty float | M1 | PLAN.md §3.1 |
| 2 | Block Height Derivation | Extract BIP34 block height from `job.coinBase1` scriptSig | M1 | PLAN.md §3.1 |
| 3 | Stratum Network Info API | Thread-safe `stratum_get_network_info()` getter | M1 | PLAN.md §3.1 |
| 4 | Smoothed Hashrate Calculation | 30s exponential moving average exposed via `monitor_get_hashrate()` | M1 | PLAN.md §3.2 |
| 5 | Display Loading Screen Fix | Prevent infinite "Loading..." on screen 2 when btcPrice <= 0 | M1 | PLAN.md §3.3 |
| 6 | Disable HTTPS by Default | Bypass slow HTTPS calls in live_stats when no proxy/API is set | M1 | PLAN.md §3.4 |
| 7 | Web Server Dependencies & Flags | Add AsyncTCP/ESPAsyncWebServer with Core 0 / Pri 2 flags to platformio.ini | M2 | PLAN.md §4.1 |
| 8 | mDNS Discovery | Announce `sparkminer.local` (or hostname from config) | M2 | PLAN.md §4.2 |
| 9 | GET /api/stats Endpoint | Stream live metrics (hashrate, pool, shares, temp, memory, uptime) as JSON | M2 | PLAN.md §4.3 |
| 10 | Embedded Web Dashboard | Single-page vanilla HTML/CSS/JS in PROGMEM (<8KB), auto-refresh 3s | M2 | PLAN.md §4.4 |
| 11 | Web Server Lifecycle Integration | Initialize web server in setup() upon WiFi connection | M2 | PLAN.md §4.5 |
| 12 | Admin Password in NVS | Add `char adminPassword[33]` to `miner_config_t` with migration handling | M3 | PLAN.md §5.1 |
| 13 | GET /api/config Endpoint | Return JSON config with wifiPassword omitted & poolPassword masked | M3 | PLAN.md §5.2 |
| 14 | POST /api/config Endpoint | Update config with auth check, field validation, and wear leveling | M3 | PLAN.md §5.3 |
| 15 | POST /api/name Endpoint | Quick miner rename endpoint with auth | M3 | PLAN.md §5.4 |
| 16 | Dual OTA Partition Table | `partitions_ota.csv` with NVS at 0x9000 and 2x 1.875MB app slots | M4 | PLAN.md §6.1 |
| 17 | POST /update Endpoint | Chunked streaming firmware flash upload with Update.h and reboot | M4 | PLAN.md §6.2 |
| 18 | Web UI OTA Form | File input and progress indicator for firmware updates | M4 | PLAN.md §6.3 |
| 19 | CYD Touchscreen Hardware Wiring | XPT2046 on dedicated VSPI (CLK:25, MOSI:32, MISO:39, CS:33, IRQ:36) | M5 | PLAN.md §7.1 |
| 20 | Non-blocking Touch Polling | Poll touch in monitor_task 100ms loop with 400ms debounce | M5 | PLAN.md §7.2 |
| 21 | Touch Handler & Screen Cycle | Wake backlight or call `display_next_screen()`, sync rotation | M5 | PLAN.md §7.3 |
| 22 | UI Polish & Redraw Throttling | Event-driven 1 Hz display updates, stable layout | M5 | PLAN.md §7.4 |
| 23 | Clean Build & E2E Verification | Successful compilation of `esp32-2432s028` with zero warnings/errors | M_VERIFY | PLAN.md §8 |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| 1 | M1: Network Calc & Hashrate | Features 1-6 (network_calc, stratum, monitor, display fix) | none | DONE |
| 2 | M2: LAN Dashboard Read-Only | Features 7-11 (web server, /api/stats, PROGMEM UI, mDNS) | M1 | DONE |
| 3 | M3: Web Config & Admin Auth | Features 12-15 (adminPassword, NVS migration, /api/config, /api/name) | M2 | DONE |
| 4 | M4: OTA Support | Features 16-18 (partitions_ota.csv, POST /update, web upload form) | M3 | DONE |
| 5 | M5: Touchscreen & UI Polish | Features 19-22 (XPT2046 VSPI, monitor_task touch, screen cycling) | M1 | DONE |
| 6 | M_VERIFY: E2E Build Verification | Feature 23 (Full build, static analysis, integrity check) | M1, M2, M3, M4, M5 | DONE |

## Interface Contracts
### `network_calc.h` ↔ `stratum.cpp` / `monitor.cpp`
```cpp
// Conversion from compact target (nbits) to standard difficulty
double nbits_to_difficulty(const char* nbits_hex);

// Conversion from BIP34 scriptSig in coinbase1 to block height
uint32_t coinbase_to_block_height(const char* coinbase1_hex);
```

### `stratum.h` ↔ `monitor.cpp` / `web_server.cpp`
```cpp
// Thread-safe getter for derived network data
bool stratum_get_network_info(uint32_t* height, double* difficulty);
```

### `monitor.h` ↔ `web_server.cpp`
```cpp
// Thread-safe getter for smoothed hashrate (30s window)
double monitor_get_hashrate();
```

### `nvs_config.h` ↔ `web_server.cpp`
```cpp
// Extended miner_config_t with adminPassword[33]
// Backward-compatible loading in nvs_config_load()
bool nvs_config_save(const miner_config_t* config);
miner_config_t* nvs_config_get();
```

### `web_server.h` ↔ `main.cpp`
```cpp
void web_server_init();
void web_server_stop();
```

### `display.h` ↔ `monitor.cpp`
```cpp
bool display_touched();
void display_handle_touch();
void display_next_screen();
void display_set_rotation(uint8_t rotation);
```

## Code Layout
- `src/network_calc.h`, `src/network_calc.cpp` — Mathematical target/difficulty & BIP34 parsing
- `src/stratum/stratum.h`, `src/stratum/stratum.cpp` — Stratum client & network info caching
- `src/stats/monitor.h`, `src/stats/monitor.cpp` — Smoothed hashrate & touch polling loop
- `src/display/display.h`, `src/display/display.cpp` — Touchscreen driver & screen rendering
- `src/config/nvs_config.h`, `src/config/nvs_config.cpp` — NVS persistence & struct migration
- `src/web/web_server.h`, `src/web/web_server.cpp` — AsyncWebServer, REST APIs, PROGMEM UI
- `platformio.ini`, `partitions_ota.csv` — Build config, dependencies, partition layout
