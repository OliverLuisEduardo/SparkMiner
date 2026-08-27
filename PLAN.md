# SparkMiner — Especificação de Execução (fork custom)

> **PARA O AGENTE EXECUTOR:** este documento é uma **especificação**, não um guia.
> Faça exatamente o que está aqui. **Não invente** APIs, arquivos, libs ou pinos.
> Se algo necessário não estiver especificado, **pare e pergunte** ao usuário em vez
> de improvisar. Toda referência `arquivo.cpp:linha` foi verificada no commit atual.

Board de referência: **CYD `esp32-2432s028`** (`default_envs` em `platformio.ini:9`),
ESP32 dual-core, display TFT ILI9341 via `src/display/display.cpp`.

---

## 0. Regras invioláveis (valem para TODAS as fases)

1. **Core 1 é sagrado.** Só `Miner1` (prioridade 19) roda nele
   (`include/board_config.h:436`). **NENHUM** código novo pode ser criado, fixado ou
   agendado no Core 1. Web server, OTA, touch, stats: tudo no **Core 0**.
2. **Prioridade de qualquer task nova ≤ 2** e **event-driven** (sem loop apertado).
   Referência das prioridades atuais: `board_config.h:423-455`.
3. **Nunca bloquear** um handler por mais que centenas de ms sem `vTaskDelay` — o
   watchdog é de 30 s (`main.cpp:359`) e o Miner0 (Core 0, pri 1) precisa ceder.
4. **Gate de hashrate:** nenhuma fase faz merge sem passar no teste da Fase 0.
5. **Uma branch por fase.** Nome: `feat/fase-N-descricao`. Não misturar fases.
6. **Não expor segredos** em respostas HTTP: senha de WiFi nunca; senha de pool
   mascarada.

---

## 1. Inventário de API existente (USE estas — já existem)

Verificado nos headers. **Reutilize; não recrie.**

| Função | Retorno | Arquivo |
|---|---|---|
| `miner_get_stats()` | `mining_stats_t*` (hashes, shares, accepted, rejected, blocks, matches32, avgLatency, bestDifficulty, templates, startTime) | `src/mining/miner.h:51` |
| `miner_get_difficulty()` | `double` (dificuldade da pool) | `src/mining/miner.h:73` |
| `miner_start_job(const stratum_job_t*)` | `void` | `src/mining/miner.h:35` |
| `stratum_is_connected()` | `bool` | `src/stratum/stratum.h:50` |
| `stratum_is_backup()` | `bool` | `src/stratum/stratum.h:55` |
| `stratum_get_pool()` | `const char*` | `src/stratum/stratum.h:60` |
| `nvs_config_get()` | `miner_config_t*` | `src/config/nvs_config.h:109` |
| `nvs_config_save(const miner_config_t*)` | `bool` | `src/config/nvs_config.h:98` |
| `nvs_stats_get()` | `mining_persistence_t*` (lifetime) | `src/config/nvs_config.h:138` |
| `wifi_manager_get_ip()` | `const char*` | `src/config/wifi_manager.h` |
| `live_stats_get_copy(live_stats_t*)` | `void` (thread-safe) | `src/stats/live_stats.h` |

Estruturas: `mining_stats_t` (`src/stratum/stratum_types.h:76`), `stratum_job_t`
(`:40`, contém `version`, `nbits`, `ntime`, `coinBase1`, `coinBase2`, `prevHash`),
`display_data_t` (`src/display/display.h:26`), `miner_config_t`
(`src/config/nvs_config.h:18`).

**API que NÃO existe hoje e que cada fase manda criar (não crie fora do escrito):**
- `monitor_get_hashrate()` → hashrate suavizado (hoje é `static` local em
  `updateDisplayData`, `monitor.cpp:73-97`). Criado na Fase 1.
- `stratum_get_network_info(uint32_t* height, double* difficulty)` → altura/dif da
  rede derivadas do job. Criado na Fase 1.

---

## 2. Fase 0 — Baseline de hashrate (PRÉ-REQUISITO, bloqueia tudo)

Objetivo: criar a régua contra a qual todas as fases serão medidas.

**Passos:**
1. Build e flash do firmware **atual, sem alterações** (ver seção "Flashing").
2. Deixar minerando com WiFi conectado por **≥ 15 min** após estabilizar.
3. Coletar do serial (já logado em `monitor.cpp:259-292`):
   - `Hashrate: X H/s` (linha `[STATS]`) — anotar média, mínimo, máximo.
   - `[STATS] Core0: ... Core1: ...` — hashes por core.
   - `[HEAP] Free/Min/MaxAlloc`.
4. Criar `docs/hashrate-baseline.md` com: versão (`AUTO_VERSION`), board, hashrate
   médio/min/max, heap livre médio/mínimo, e a data.
5. Definir o **gate numérico**: `hashrate_medio_fase >= 0.98 * baseline_medio`.
   Registrar esse número no arquivo.

**Aceitação da Fase 0:** `docs/hashrate-baseline.md` existe e contém os números.
Nenhuma mudança de código nesta fase.

---

## 3. Fase 1 — Stats da 2ª tela derivadas do job (conserta o bug + melhora hashrate)

**Problema (diagnóstico verificado):** a tela `SCREEN_STATS` (índice 1,
`display.cpp:913`) mostra `"Loading..."` eterno porque `data->btcPrice` fica 0
(`display.cpp:561-566`) e `networkHashrate`/`blockHeight` ficam vazios. Motivo:
esses dados só chegam por HTTPS via proxy/API que **não vem configurado**
(`live_stats.cpp:691`, `:751`, `:783`). Só block height e fees (HTTP puro) carregam.

**Solução:** derivar dificuldade e altura do **próprio job de mining** (já na
memória), eliminando a dependência de HTTPS.

### 3.1 Criar cálculo de rede a partir do job

Arquivo novo: `src/stratum/network_calc.h` + `src/stratum/network_calc.cpp`.

- `double nbits_to_difficulty(const char* nbitsHex);`
  - Converte `nbits` (8 hex, ex.: `"1703a30c"`) em dificuldade de rede.
  - Fórmula: `nbits` = compact target. `exponent = primeiro byte`,
    `mantissa = 3 bytes seguintes`. `target = mantissa * 256^(exponent-3)`.
    `difficulty = difficulty_1_target / target`, com
    `difficulty_1_target = 0xFFFF * 256^(0x1D-3)`.
  - Retornar `0.0` se `nbitsHex` for nulo ou `strlen != 8`.
- `uint32_t coinbase_to_height(const char* coinBase1Hex);`
  - Extrai a altura via BIP34: no scriptSig da coinbase, o primeiro item é um push
    do número do bloco. Ler o primeiro byte após o início do scriptSig como
    tamanho do push (`n`), depois ler `n` bytes little-endian → altura.
  - **Parser defensivo:** validar `strlen(coinBase1Hex)` suficiente antes de ler;
    retornar `0` em qualquer dúvida. Não estourar buffer.
- Cobrir com um teste manual: colocar um `nbits`/coinbase conhecido e conferir o
  número no serial (log temporário, remover antes do merge).

### 3.2 Expor os dados de rede pelo stratum

Em `src/stratum/stratum.cpp`, no ponto que trata `mining.notify` e preenche o
`stratum_job_t` (parsing em `stratum.cpp:210-224`, após montar o job):
- Calcular `difficulty = nbits_to_difficulty(job.nbits)` e
  `height = coinbase_to_height(job.coinBase1)`.
- Guardar em duas variáveis `static` protegidas por um mutex já existente do
  stratum (ou criar um `static portMUX_TYPE`), e adicionar em `stratum.h`:
  - `void stratum_get_network_info(uint32_t* height, double* difficulty);`
- **Custo:** aritmética por job (µs). Sem rede.

### 3.3 Expor o hashrate suavizado

Em `src/stats/monitor.cpp`, o hashrate suavizado é um `static double smoothedHashRate`
local (`monitor.cpp:73`). Refatorar:
- Mover para uma variável de arquivo `static volatile double s_hashRate;` atualizada
  em `monitor.cpp:95`.
- Adicionar em `src/stats/monitor.h`: `double monitor_get_hashrate();` e implementar
  retornando `s_hashRate`.
- O display continua usando o mesmo valor (sem mudança de comportamento).

### 3.4 Alimentar o display com dados do job

Em `updateDisplayData` (`monitor.cpp:47`):
- Após obter os stats, chamar `stratum_get_network_info(&h, &d)`.
- Preencher `data->blockHeight = h` (se `h > 0`).
- Formatar dificuldade em string e gravar em `data->networkDifficulty`
  (ex.: `"%.2f T"`, dividindo por 1e12), como já se faz em `live_stats.cpp:864`.
- **Prioridade:** se o proxy/live_stats trouxer valores válidos (`lstats.networkValid`),
  eles continuam tendo prioridade (compatibilidade); senão usar os do job.

### 3.5 Ajustar a tela STATS para não travar

Em `src/display/display.cpp:561-566` (`drawStatsScreen`):
- Se `data->btcPrice <= 0`, imprimir `"--"` em vez de `"Loading..."` (o preço USD
  é opcional e não deve parecer "carregando pra sempre").
- Garantir que dificuldade e altura do bloco (agora vindos do job) aparecem.

### 3.6 Desligar o fetch de rede HTTPS por padrão (ganho de hashrate)

Em `src/stats/live_stats.cpp`, as funções `updatePrice`, `updatePoolStats`,
`updateNetworkHashrate`, `updateNetworkDifficulty` já retornam cedo sem proxy
(`:691-692`, `:751-752`, etc.). **Não remover** o código (mantém compatibilidade com
quem usa proxy). Confirmar apenas que, sem config de proxy/API, **nenhuma** chamada
HTTPS ocorre. Se ocorrer, corrigir a guarda. `updateBlockHeight`/`updateFees` (HTTP
puro) podem permanecer ativos, mas agora são redundantes com o job — deixá-los como
fallback, sem alterar.

**Aceitação da Fase 1:**
- Device virgem (sem proxy/API): a 2ª tela mostra **altura do bloco e dificuldade
  reais** em segundos, sem nenhuma config.
- Nenhuma requisição HTTPS no boot limpo (verificar no serial: sem `[STATS] ... error`
  de HTTPS).
- **Gate de hashrate:** hashrate médio ≥ baseline (esperado: igual ou maior).

---

## 4. Fase 2 — LAN Dashboard read-only (`/api/stats` + página)

**Objetivo:** ver a mineração pelo navegador em `http://sparkminer.local`.

### 4.1 Dependências (adicionar em `platformio.ini`, bloco `lib_deps` do env
`esp32-2432s028` em `platformio.ini:95` e nos demais envs com display que forem
alvo):
```
    ESP32Async/ESPAsyncWebServer @ ^3.6.0
    ESP32Async/AsyncTCP @ ^3.3.2
```
Adicionar build flag para fixar o task do AsyncTCP no Core 0:
```
    -D CONFIG_ASYNC_TCP_RUNNING_CORE=0
    -D CONFIG_ASYNC_TCP_TASK_PRIORITY=2
```
> Se a versão exata das libs não bater no registro do PlatformIO, **pare e pergunte**
> — não troque por outra biblioteca (ex.: WebServer síncrono) sem aprovação, porque
> muda o perfil de CPU.

### 4.2 Módulo novo: `src/web/web_server.h` + `src/web/web_server.cpp`
- `void web_server_init();` — cria o `AsyncWebServer server(80);`, registra rotas,
  chama `server.begin()`. Inicia mDNS: `MDNS.begin("sparkminer");`
  `MDNS.addService("http", "tcp", 80);`.
- Rota `GET /api/stats` → monta JSON (usar `ArduinoJson`, já é dependência
  `platformio.ini:26`) com, no mínimo:
  - `hashrate` ← `monitor_get_hashrate()`
  - `accepted`/`rejected`/`blocks`/`bestDifficulty` ← `miner_get_stats()` +
    lifetime de `nvs_stats_get()` (mesma soma feita em `monitor.cpp:55-62`)
  - `poolConnected` ← `stratum_is_connected()`, `pool` ← `stratum_get_pool()`
  - `blockHeight`/`networkDifficulty` ← `stratum_get_network_info()`
  - `uptime`, `ip` ← `wifi_manager_get_ip()`, `rssi` ← `WiFi.RSSI()`
  - `freeHeap` ← `ESP.getFreeHeap()`
  - Responder com `AsyncResponseStream`, `Content-Type: application/json`.
- Rota `GET /` → página HTML única (ver 4.3).
- **Consistência de leitura:** as funções acima já são thread-safe ou leem structs
  simples; não segurar locks longos dentro do handler.

### 4.3 Página do dashboard
- Servir HTML/CSS/JS **inline** a partir de uma string `PROGMEM` no `web_server.cpp`
  (não usar SPIFFS/LittleFS nesta fase — evita mexer em partição).
- JS faz `fetch('/api/stats')` a cada 3–5 s e atualiza os campos. Sem frameworks,
  sem CDN externo. Página < 8 KB.

### 4.4 Inicialização
- Chamar `web_server_init()` em `setup()` (`main.cpp`), **depois** de
  `wifi_manager_start()` (`main.cpp:405`) e de `monitor_init()` (`main.cpp:417`),
  e **somente** se `WiFi.status() == WL_CONNECTED` (ou registrar via evento WiFi
  quando conectar). Não iniciar em modo AP/portal.

**Aceitação da Fase 2:**
- Abrir `http://sparkminer.local` no celular na mesma LAN → stats atualizando.
- `curl http://<ip>/api/stats` retorna JSON válido.
- **Gate de hashrate:** com o dashboard aberto 10 min, hashrate médio dentro do gate.
- `[HEAP] Free` não cai abaixo de 50 KB com 1 cliente aberto.

---

## 5. Fase 3 — Configuração via web (editar sem reflashar)

Estende o módulo `web/web_server.cpp`. **Toda rota que muda estado exige senha.**

### 5.1 Senha admin (decidido pelo usuário)
- **Adicionar** campo `char adminPassword[33];` ao `miner_config_t` (`nvs_config.h:18`).
  Isso muda o layout/checksum do NVS — tratar migração:
  - Em `nvs_config_reset()` (`src/config/nvs_config.cpp`), default `adminPassword[0] = '\0'`
    (vazio).
  - Carregar com fallback: se o campo não existir no NVS antigo, assumir vazio, não
    travar boot. Recalcular checksum incluindo o novo campo.
  - Configurável no **captive portal** (`src/config/wifi_manager.cpp`, junto dos
    campos de pool/wallet) **e** em `POST /api/config`.
- **Vazio = autenticação desligada:** se `adminPassword[0] == '\0'`, as rotas de
  escrita (`POST /api/config`, `POST /api/name`, `POST /update`) ficam **abertas** na
  LAN. Se preenchido, exigir a senha.
- Autenticação: header `X-Auth` ou parâmetro; comparar com `adminPassword`. Rejeitar
  com 401 se não bater. Rate-limit básico (ex.: descartar POSTs a < 1 s).
- `GET /api/config` **nunca** retorna `adminPassword` (nem mascarado como valor real;
  devolver só um booleano `adminPasswordSet`).

### 5.2 Rotas
- `GET /api/config` → JSON com `poolUrl`, `poolPort`, `wallet`, `workerName`,
  `backupPoolUrl`, `backupPoolPort`, `brightness`, `timezoneOffset`, `rotation`.
  **Nunca** retornar `wifiPassword`; retornar senha da pool mascarada (`"****"`).
- `POST /api/config` (autenticado) → recebe os campos acima, **valida no servidor**
  (tamanhos conforme os `MAX_*` de `board_config.h`; porta 1–65535), grava com
  `nvs_config_save()` **somente se houve mudança real** (comparar antes, padrão de
  wear já usado). Aplicar a quente o que der (brilho via `display_set_brightness`,
  worker name); mudanças de pool disparam `stratum_reconnect()`
  (`src/stratum/stratum.h:45`).
- `POST /api/name?value=NOME` (autenticado) → atalho para renomear o worker; grava e
  reconecta.

**Aceitação da Fase 3:**
- Trocar a pool pelo navegador, salvar → device reconecta na pool nova sem USB
  (confirmar no serial e em `stratum_is_connected()`).
- `GET /api/config` não expõe nenhuma senha em claro.
- **Gate de hashrate:** dentro do gate (POSTs são raros/pontuais).

---

## 6. Fase 4 — OTA update (flash pela rede)

> **Mudança de particionamento — item de maior risco. Migração cuidadosa.**

### 6.1 Nova tabela de partições
- Hoje: `board_build.partitions = huge_app.csv` (app único, **sem OTA**,
  `platformio.ini:38`).
- Criar `partitions_ota.csv` com **dois slots de app (`app0`/`app1`)** + `nvs` +
  `otadata`. **Preservar o offset da partição `nvs`** igual ao layout atual para
  **não perder config nem lifetime stats** ao reflashar por USB uma vez.
  - Conferir o tamanho de app que o firmware ocupa hoje (saída do build) e
    dimensionar cada slot com folga. Se não couber em dois slots, **pare e pergunte**
    (pode exigir remover libs ou reduzir features).
- Trocar `board_build.partitions = partitions_ota.csv` no env alvo.

### 6.2 Rota OTA
- `POST /update` (autenticado com a senha da Fase 3) usando `Update.h` (core ESP32)
  via handler de upload do ESPAsyncWebServer (streaming do body):
  - `Update.begin(UPDATE_SIZE_UNKNOWN)`, alimentar chunks com `Update.write`,
    finalizar com `Update.end(true)`; validar retorno; `ESP.restart()` no sucesso.
  - Rejeitar se `Update.begin` falhar (sem espaço) ou se o binário não validar.
- Página `/` ganha um formulário de upload de `.bin` protegido pela senha.

**Aceitação da Fase 4:**
- Migrar via **1 flash USB** para o layout OTA preservando config + lifetime stats.
- Subir um `.bin` novo pelo navegador → device reinicia na versão nova, config e
  lifetime stats **intactos**.
- **Gate de hashrate:** fora do momento do upload, dentro do gate. Durante o upload,
  queda esperada e documentada.

---

## 7. Fase 5 — Touch + polimento de UI (com trava de hashrate)

O CYD envia touch **desligado** no upstream. A lib `XPT2046_Touchscreen` **já é
dependência** (`platformio.ini:99`).

### 7.1 Habilitar touch
- Inicializar o XPT2046 nos pinos dedicados do CYD (SPI de touch separado). **Não
  adivinhar pinos** — usar os pinos padrão do CYD documentados no board;
  se não estiverem definidos em `board_config.h`, **pare e pergunte** antes de
  hardcodar.
- Implementar `display_touched()` e `display_handle_touch()` (hoje há stubs/checagem
  em `monitor.cpp:237`) para: "tap = próxima tela" via `display_next_screen()`
  (`display.cpp:949`).
- **Leitura do touch:** por evento/IRQ ou polling lento (≥ 50 ms), no Core 0. **Sem
  loop apertado.** Reusar o ciclo do `monitor_task` (já roda a cada 100 ms,
  `monitor.cpp:397`) em vez de criar task nova, se possível.

### 7.2 Polimento visual
- Melhorias de tipografia/sparkline **sem** aumentar a frequência de redraw. O redraw
  hoje é 1 Hz (`DISPLAY_UPDATE_MS`, `monitor.cpp:19`). **Não reduzir** esse intervalo.
- Redraw só sob mudança de dado/tela, nunca em loop apertado.

**Aceitação da Fase 5:**
- Tocar a tela cicla as telas.
- **Gate de hashrate:** UI nova dentro do gate; redraw não mais frequente que hoje.

---

## 8. Flashing — como gravar o miner

### 8.1 USB (hoje, e sempre disponível)
Ambiente PlatformIO no venv do repo (`.venv\Scripts\pio.exe`). Board default:
`esp32-2432s028`.

Build:
```bash
pio run -e esp32-2432s028
```
Gravar (auto-detecta ou informe a porta):
```bash
pio run -e esp32-2432s028 -t upload --upload-port COM3
```
Monitor serial (115200):
```bash
pio device monitor -b 115200 -p COM3
```
Atalho para a variante 2-USB do CYD (script pronto, faz build+flash+monitor):
```bash
.\flash-2usb.ps1
```
> `flash-2usb.ps1` usa o env `esp32-2432s028-2usb` e o binário mesclado
> `.pio\build\<env>\<env>_factory.bin` (gerado por `scripts/post_build_merge.py`,
> `platformio.ini:23`). `upload_speed = 921600` (`platformio.ini:39`).
> Se o upload falhar: segurar **BOOT** ao conectar o USB; usar cabo de dados;
> instalar driver CH340/CP2102.

### 8.2 OTA (disponível só APÓS a Fase 4)
Sem cabo, pela LAN: acessar `http://sparkminer.local/update`, autenticar com a senha
de setup e enviar o `.bin` gerado pelo build. Requer o layout de partições OTA da
Fase 4. **Não existe antes da Fase 4.**

---

## 9. Previsão de impacto no hashrate (resumo para decisão)

| Fase | Impacto permanente | Impacto temporário |
|---|---|---|
| 0 Baseline | nenhum (só mede) | nenhum |
| 1 Stats do job | **positivo** (remove HTTPS/TLS + colisão SHA) | nenhum |
| 2 Dashboard read-only | ~neutro (Core 1 intocado, async no Core 0) | micro-queda por request |
| 3 Config web | ~neutro (POST raro) | micro-queda no POST |
| 4 OTA | ~neutro fora do update | **queda durante o upload** (esperada) |
| 5 Touch + UI | ~neutro (IRQ/polling lento) | nenhum se sem loop apertado |

**Conclusão:** não há previsão de **regressão permanente**. A Fase 1 tende a
melhorar. As únicas quedas são transitórias (upload da OTA e instantes de request),
e o gate da Fase 0 barra qualquer regressão real antes do merge.

---

## 10. Riscos e mitigações

- **Colisão SHA hardware (mining ↔ mbedtls/TLS):** eliminada ao abandonar HTTPS na
  Fase 1. Se reintroduzir TLS no futuro, isolar o uso do SHA-HW.
- **AsyncTCP no core errado:** garantir `CONFIG_ASYNC_TCP_RUNNING_CORE=0` (Fase 2).
  Se cair no Core 1, mata o hashrate — verificar no serial o core do task.
- **Heap/fragmentação:** servir página do PROGMEM, limitar conexões, monitorar
  `[HEAP]` (`monitor.cpp:286`). Abortar/avisar se `freeHeap < 30 KB`.
- **Watchdog 30 s:** handlers e OTA não podem bloquear; ceder com `vTaskDelay`.
- **NVS wear/layout:** `POST /api/config` só grava em mudança real; mudança de struct
  `miner_config_t` altera checksum/layout — só com aprovação explícita.
- **Partição OTA:** dimensionar dois slots; preservar offset de NVS. Se não couber,
  parar e perguntar.

---

## 11. Ordem de execução (obrigatória)

`Fase 0` → `Fase 1` → `Fase 2` → `Fase 3` → `Fase 4` → `Fase 5`.

Cada fase: branch própria, implementar, medir hashrate vs baseline, passar no gate,
abrir PR. **Não pular fases** (a Fase 2 depende dos getters da Fase 1; a Fase 4
depende da senha da Fase 3).

---

## 12. Decisões que exigem PARAR e perguntar ao usuário

O agente executor **não decide sozinho**:
1. ~~Adicionar campo ao `miner_config_t`~~ — **DECIDIDO:** adicionar `char adminPassword[33]`,
   vazio = auth desligada (ver 5.1). Tratar migração de checksum/layout NVS.
2. Versões de lib que não baterem no registro PlatformIO.
3. Dimensionamento de partições OTA se o app não couber em 2 slots.
4. Pinos de touch se não estiverem em `board_config.h`.
5. Reintroduzir qualquer caminho HTTPS no ESP32.
6. Manter/remover o campo "preço BTC USD" na 2ª tela (hoje: mostrar `--`).
