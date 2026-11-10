# Minecraft AFK Bot — v2.11.0

A self-healing AFK session for a Minecraft server, plus a dashboard that tells the
truth about what is happening. Built for free/shared hosts (Aternos, exaroton,
self-hosted Paper), where the server is up long before it is *ready* and where
getting kicked is normal.

The bot never drives a host's website and never fakes player activity — it plays
like a normal client. See [Rules this bot follows](#rules-this-bot-follows).

```
npm install
npm run doctor     # pre-flight: node version, files, deps, target, port
npm start          # dashboard on http://localhost:5000
npm run test:all   # 191 tests, no framework, no network
```

---

## Contents

- [What changed in 2.11](#what-changed-in-211)
- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Reconnect logic](#reconnect-logic)
- [Watchdogs](#watchdogs)
- [Single instance, mirror failover](#single-instance-mirror-failover)
- [Policy bans](#policy-bans)
- [Serverless and proxy mode](#serverless-and-proxy-mode)
- [Provider API (exaroton)](#provider-api-exaroton)
- [HTTP endpoints](#http-endpoints)
- [Dashboard](#dashboard)
- [Keep-alive self-ping](#keep-alive-self-ping)
- [Configuration](#configuration)
- [Environment variables](#environment-variables)
- [Deploying](#deploying)
- [Free 24/7 hosting](#free-247-hosting)
- [Tests](#tests)
- [Rules this bot follows](#rules-this-bot-follows)
- [Troubleshooting](#troubleshooting)

---

## What changed in 2.11

| Area | Behaviour |
| --- | --- |
| Probes | `probe.js` does a raw TCP connect **and** a real Minecraft status ping (VarInt parsed). Results are `online` / `offline` / `timeout` / `error`, and `ambiguous` when the port is open but no status reply arrives. |
| Reconnect | One serialized scheduler. Login happens only after the probe says the server is ready — but after **6** not-ready probes a real login is forced anyway, because probes are advisory, not authoritative. Backoff is exponential, jittered and capped by `max-reconnect-delay`. Duplicate-login kicks back off **120–180s** with jitter. |
| Shutdown | `SIGTERM` / `SIGINT` quit the bot cleanly, stop every timer, release the lease and exit — no more "ignore the signal and hope". |
| Watchdogs | 90s socket silence → reconnect, 120s spawn timeout, 10min without movement → nudge → reconnect. Armed *before* module init; module init is wrapped in `try/catch` so a broken module degrades the session instead of ending it. Tunable under `utils.watchdog`. |
| Single instance | Lease file in `/tmp` (60s TTL, `BOT_LEASE_DIR` override) so two copies never fight over the username. Cross-machine failover via `BOT_MIRROR_URL` and `POST`/`GET /mirror/status`. |
| Policy bans | `banned.reason`, "idle for too long", "terms of service" → `[POLICY]` block, `policyBlocked`, reconnect loop **paused**, dashboard banner. `/start` is an explicit, deliberate retry. |
| Serverless | Detects `VERCEL` / `LAMBDA` / `NETLIFY` / `CF_PAGES`. With `BOT_BACKEND_URL` set, every request is proxied to an always-on bot (status codes and bodies preserved); otherwise the dashboard says "no bot can run here" instead of pretending. |
| Provider | `provider.js` talks to exaroton's API (status 0–10 → label, players, address, start/stop/restart). Tokens come **only** from `EXAROTON_TOKEN`. Manual fallback = reporting mode: it explains, it never claims success. |
| Endpoints | `/`, `/logs`, `/tutorial`, `/health`, `/ping`, `/server/status` (+ `?light=1` cache-only), `/server/start|stop|restart`, `/server/check`, `/status/light`, `/light`, `/mirror/status`, `POST /start`, `/stop`, `/command`. |
| Keep-alive | Self-ping via `PUBLIC_URL` or auto-detected `RENDER_EXTERNAL_URL` / `KOYEB_PUBLIC_DOMAIN` / `FLY_APP_NAME` / `RAILWAY_PUBLIC_DOMAIN`, every `SELF_PING_INTERVAL_MS` (default 4 min), skipped in proxy/serverless mode. |
| Dashboard | Status card with the reason, **session** uptime (not process uptime), coordinates, server card with Start/Stop/Restart, player count, join address, policy banner, serverless banner. |

---

## Quick start

1. **Point the bot at a server** — edit `settings.json`:

   ```json
   {
     "bot-account": { "username": "YourName", "password": "", "type": "offline" },
     "server": { "ip": "yourserver.aternos.me", "port": 25565, "version": false }
   }
   ```

   `version: false` lets mineflayer auto-detect. Set `"type": "microsoft"` for a
   premium account (a `password` or `MC_PASSWORD` is required).

2. **Run it**

   ```bash
   npm install
   npm start
   ```

   Requires **Node 20–22** (`engines: ">=20 <23"`); the Dockerfile and nixpacks
   config both pin Node 20.

3. **Open the dashboard** at `http://localhost:5000`. The status card shows
   *Probing* → *Connecting* → *Connected*, or *Disconnected* with the reason.

4. **(Optional) let the bot wake the server** — set `EXAROTON_TOKEN` and
   `EXAROTON_SERVER_ID`, then use the *Start server* button.

Environment variables always win over `settings.json`.

---

## Architecture

```
                 ┌───────────────────────────── index.js ─────────────────────────────┐
  HTTP  ────────►│ express app ── endpoints ── dashboard renderer                      │
                 │      │                                                             │
                 │      ├── proxyToBackend (BOT_BACKEND_URL set? forward everything)   │
                 │      │                                                             │
                 │  runtime state ◄──── reconnect scheduler (single owner)            │
                 │      │                    │                                         │
                 │      │                    ├── probe.js      is the server ready?   │
                 │      │                    ├── watcher.js    is the session alive?   │
                 │      │                    └── mineflayer    the actual game client  │
                 │      │                                                             │
                 │  lease (single instance) · mirror (failover) · provider (exaroton)  │
                 └────────────────────────────────────────────────────────────────────┘
```

| File | Responsibility |
| --- | --- |
| `index.js` | Config, runtime state, reconnect scheduler, dashboard/HTTP, lease, mirror, boot/shutdown. |
| `probe.js` | TCP + Minecraft Server List Ping (hand-rolled VarInt framing). No deps. |
| `watcher.js` | `Watchdog` class (silence / spawn / stall) and the keep-alive self-ping. |
| `provider.js` | exaroton client, status mapping, strict token handling. |
| `leaveRejoin.js` | Optional scheduled leave; **never** reconnects on its own. |
| `logger.js` | In-memory ring buffer + console fan-out. |
| `doctor.js` | Pre-flight check (`npm run doctor`): Node version, files in the right place, installed dependencies, `settings.json` target/account, the port the host assigned, and platform-mode hints. Exits non-zero on anything that would stop the bot. |
| `api/index.js` | Serverless entry point — exports the express handler Vercel invokes. Never starts a bot. |
| `vercel.json` | Routes `/(.*)` → `api/index.js`, declares the function budget, publishes only `public/`, no-store on status routes. |
| `public/index.html` | The only published static file: a self-contained status shell that queries `/status/light` and explains itself when no API is present. Keeps a static deployment from ever serving source. |
| `docker-compose.yml` | One container, `restart: always`, healthcheck on `/ping` — for a VM, a VPS, a home PC or a Pi. |
| `deploy/minecraft-afk-bot.service` | systemd unit for a native install: `Restart=always`, `SIGTERM` for a clean game quit, journald logs. |
| `deploy/vm-install.sh` | Installs Node 20, copies the app to `/opt/minecraft-afk-bot`, enables the unit. |
| `deploy/termux-install.sh` | The same on Android: Node LTS, `npm ci`, `termux-wake-lock`, `tmux` instructions. |
| `deploy/free-hosts.md` | Which free hosts allow 24/7, what each one costs you in RAM, and why Render's free tier suspends this bot. |

There is exactly **one** owner for each timer: `timers.reconnect`, one watchdog
per connection attempt, one keep-alive interval, one lease renewal.

---

## Reconnect logic

Every disconnect path ends in the same place: `scheduleReconnect(reason)`.

1. If the bot is stopped, policy-blocked or shutting down → do nothing.
2. If a reconnect is already scheduled → ignore the duplicate (this used to cause
   double logins).
3. Pick a delay:
   - explicit (`duplicate-login`, `throttle`), or
   - `min(base × 2^(attempt-1), max-reconnect-delay)` plus up to 20% jitter.
4. Wait, then `runCycle()`:

```
probe ──► ready?  ── yes ──► login
             │
             └── no ──► notReadyProbes++
                          │
                          ├── < 6  ──► schedule the next probe (backoff)
                          └── >= 6 ──► force a real login
```

Why the force path exists: Aternos' proxy accepts TCP connections while the world
is still booting, and its status ping can stay unanswered for minutes. Trusting
the probe forever would mean never joining at all. After six not-ready probes the
bot logs in for real — the probe is advice, not a gate.

**Invariants**

* A login never happens while another reconnect is pending.
* Duplicate-login kicks (someone else on the username) always take the long
  120–180s jittered path, never the 2s path.
* `reconnectAttempts` resets on a successful spawn.

---

## Watchdogs

`utils.watchdog` (all optional, all in milliseconds):

| Key | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | Master switch. |
| `silence-timeout` | `90000` | No bytes from the server for 90s → reconnect. |
| `spawn-timeout` | `120000` | No spawn 120s after the attempt started → abandon it. |
| `stall-timeout` | `600000` | No movement for 10min → nudge (look / jump / swing). |
| `stall-grace` | `120000` | Still no movement 2min after the nudge → reconnect. |
| `tick-interval` | `5000` | Evaluation cadence. |

Ordering guarantees:

* The watchdog is created **before** `mineflayer.createBot()` and before any
  module code runs, so a session can never be left unsupervised.
* `initializeModules()` is wrapped in `try/catch`; a module that throws is logged
  and skipped, the session keeps running.
* Watchdog callbacks are wrapped too — an exploding handler is logged and the
  watchdog keeps ticking.

---

## Single instance, mirror failover

### Lease (same machine)

* File: `${BOT_LEASE_DIR:-/tmp}/minecraft-afk-bot-<username>.lease`
* Contents: `pid`, `hostname`, `username`, `token`, `startedAt`, `renewedAt`
* TTL **60s**, renewed every **20s**.
* Stale when: unreadable, older than the TTL, or the recorded pid is gone on this
  host. A stale lease is taken over (logged as `took over a stale lease`).
* A running second instance serves the dashboard but **never logs in**.
* If the lease file disappears or changes owner, the bot stops itself.

### Mirror (across machines)

```
BOT_MIRROR_URL=https://standby.example.com
```

* Primary `POST`s a public-safe snapshot to `<mirror>/mirror/status` every 60s.
* A standby `GET`s the same path and can claim the lease + start its own bot.
* The snapshot contains status, session uptime, server label, reconnect count and
  `updatedAt` — never coordinates, chat, or secrets.

---

## Policy bans

A policy ban is a **stop** signal, not a retry signal:

```
[POLICY] ============================================================
[POLICY] Blocked by server policy: account banned
[POLICY] Server said: {"text":"banned.reason"}
[POLICY] Automatic reconnects are PAUSED. Retrying would escalate this
[POLICY] into a permanent ban, so the bot stays down until you press Start.
[POLICY] ============================================================
```

Detected patterns include `banned.reason`, "you have been banned", "idle for too
long", "terms of service", `tos violation`, and automation/botting language —
matched against string, JSON and chat-component kick reasons.

Effects: `runtime.policyBlocked = true`, the pending reconnect timer is cleared,
the bot is torn down, the dashboard shows an amber banner explaining that
reconnects are paused, and `/status/light` reports `policyBlocked: true`.

`POST /start` (dashboard button or `curl`) clears the block and retries **once**,
deliberately. It is not a loop.

---

## Serverless and proxy mode

| Situation | What happens |
| --- | --- |
| `VERCEL`, `AWS_LAMBDA_*`, `NETLIFY`, `CF_PAGES` set, **no** backend | No bot is started. `/health` reports `serverless: true`; the dashboard shows "Serverless runtime detected … no bot is running in this process" instead of faking a connection. |
| `BOT_BACKEND_URL` set | Every path and method is proxied to that always-on bot. Upstream status codes, headers and bodies are preserved; an unreachable backend returns `502` with an explanation. |
| Neither | Normal local mode. |

`BOT_BACKEND_URL` must be `http://` or `https://`; anything else is refused at
boot and surfaced in `environment.backendError`.

---

## Provider API (exaroton)

```bash
EXAROTON_TOKEN=...            # environment only — never settings.json, never logged
EXAROTON_SERVER_ID=AbCd1234   # or settings.json → provider.exaroton-server-id
EXAROTON_BASE_URL=https://api.exaroton.com/v1   # optional; the scheme is taken literally
```

| API call | Used by |
| --- | --- |
| `GET /servers/{id}` | `/server/status`, `/server/check`, dashboard card |
| `POST /servers/{id}/start` | `/server/start` |
| `POST /servers/{id}/stop` | `/server/stop` |
| `POST /servers/{id}/restart` | `/server/restart` |

Status codes map to labels:

| 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Offline | Online | Starting | Stopping | Restarting | Saving | Loading | Crashed | Pending | Transferring | Preparing |

Token handling is strict:

* read **only** from `process.env.EXAROTON_TOKEN`;
* scrubbed out of error text and response bodies (`[redacted]`);
* never included in any HTTP response the dashboard receives (covered by a test).

Without a token, server endpoints return **409** with `mode: "reporting"` and the
`provider.manual-start-hint` from `settings.json`. Reporting mode explains what to
do; it never pretends to have done it.

---

## HTTP endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/` | Dashboard. |
| GET | `/logs` | Log viewer (`?format=json&limit=300` for JSON). |
| GET | `/tutorial` | Setup guide. |
| GET | `/health` | Machine-readable health: status, uptime, serverless, proxy, policy. |
| GET | `/ping` | `pong` — used by the keep-alive and by host health checks. |
| GET | `/status` | Full status object (as the dashboard sees it). |
| GET | `/status/light` | **Public-safe** status: no coordinates, no player names, no kick text. |
| GET | `/light` | Tiny self-contained status page (good for an iframe). |
| GET | `/server/status` | Bot + server + provider status. `?light=1` is cache-only and never calls the provider API. |
| GET | `/server/check` | Force a fresh probe + provider refresh. |
| POST | `/server/start` \| `/server/stop` \| `/server/restart` | Provider actions (409 in reporting mode). |
| GET/POST | `/mirror/status` | Mirror snapshot (GET) / inbound standby report (POST). |
| POST | `/start` | Start the bot; also clears a policy block (explicit retry). |
| POST | `/stop` | Stop the bot until `/start`. |
| POST | `/command` | `{ "command": "/list" }` — `/help`, `/pos`, `/status`, `/chat`, `/probe`, `/start`, `/stop`, or anything sent in-game. |
| POST | `/chat` | `{ "enabled": false }` — turn automatic chat off/on live (no body toggles). `"off"` is a hard stop: the timer is cleared, nothing is queued. |

All of the above work unchanged inside a serverless function (they are served by
the same express app); in proxy mode they are forwarded to the always-on bot so
the dashboard you look at is the real, live session.

---

## No Variables tab on your host?

SillyDev's panel does not always expose environment variables, and losing the
Pterodactyl startup tab is easy. Two file-based ways to configure everything,
no panel features required.

### Option A — a `.env` file (works on every host)

Create `.env` in the project root (next to `index.js`) with the file manager:

```
DASHBOARD_PATH=my-bot-7f3a
TZ=Asia/Kolkata
NODE_OPTIONS=--max-old-space-size=192
MC_SERVER_HOST=ZLAG.aternos.me
MC_SERVER_PORT=39033
```

Then restart. Log:

```
[Config] .env: 3 variable(s) — DASHBOARD_PATH, TZ, NODE_OPTIONS
[Config] Time zone: Asia/Kolkata
[Config] Dashboard: secret link /my-bot-7f3a
```

A real panel variable always beats the file (`test-envfile.js` pins that), so a
forgotten `.env` cannot override what the host set.

### Option B — `settings.json`

```json
{
  "timezone": "Asia/Kolkata",
  "dashboard": { "path": "my-bot-7f3a", "password": "", "user": "admin" }
}
```

`dashboard.path` gives you the secret link, `dashboard.password` turns on basic
auth, `timezone` fixes quiet hours and log timestamps. Precedence:
environment > `.env` > `settings.json`.

`npm run doctor` tells you which of the three it found:

```
[ ok ] Variables file: .env with 3 line(s) — used when the panel has no Variables tab
[warn] Dashboard access: open — anyone with the URL can stop the bot; set DASHBOARD_PATH=<secret>
```

## If you do not want a password

A panel port is on the open internet, so an unguarded dashboard lets anyone who
scans it press **Stop** or chat as the bot. You do not have to type a password to
fix that — use a link only you know:

```
DASHBOARD_PATH=my-bot-7f3a      # any long, random string
```

* open `http://host:port/my-bot-7f3a` — same dashboard, no login prompt
* `http://host:port/` answers a bare `404 Not found`, so nothing advertises itself
* `/health`, `/ping`, `/mirror/status` stay at the root, so panels and keep-alives
  keep working
* bookmark it once; that is the whole setup

Log on boot:

```
[Server] Dashboard listening on http://0.0.0.0:6005/my-bot-7f3a
[Server] Dashboard uses a secret link (/my-bot-7f3a) — bookmarks only, the root answers 404
```

`npm run doctor` warns when the dashboard is open and neither guard is set.

## Looking like a player, not a cron job

Servers notice regularity faster than they notice anything else. A ternos is
blunt about it: an account that is online 24/7, performs one action every 45
seconds and never says anything is not playing, it is idling. Three things keep
the bot on the human side of that line.

| Signal | Old behaviour | Now |
| --- | --- | --- |
| Anti-AFK | swing every 45 s, hotbar every 60 s, forever | one action every **20-90 s**, chosen at random: look around (32%+26%), swing, hotbar, sit idle, sneak, jump — and doing nothing between them is normal |
| Chat | five fixed lines every 120 s | random line, gap 60-140% of `repeat-delay`, only when someone else is online |
| Sessions | connected for weeks | optional `leave-rejoin` (45-150 min, then a 10-40 min break) and optional **quiet hours** |

**Quiet hours** are honest offline time, not silence: the bot closes the
connection and comes back on its own.

```json
"human-mode": { "enabled": true, "quiet-hours": { "enabled": true, "start-hour": 1, "end-hour": 8 } }
```

```
[Human] Quiet hours (1:00-8:00) — going offline like a person would
[Human] Quiet hours are over — coming back online
```

Two warnings that matter more than the settings:

1. On **Aternos**, a break usually means the server shuts down while the bot is
   away, and the bot cannot start it again — someone has to open the Aternos
   panel. Only leave `leave-rejoin` / quiet hours on if you accept that, or use
   exaroton (where the API can start the server).
2. **No setting makes automation allowed.** Aternos' rules prohibit AFK bots
   regardless of how human the traffic looks. Human mode reduces the chance of
   an automated flag and makes the account indistinguishable to other players; it
   cannot make a rule go away.

`npm run doctor` reports which mode you are in:

```
[ ok ] Human mode: on — jittered anti-AFK, random chat; quiet hours off (24/7)
```

## Automatic chat, on a switch

Two independent knobs, often confused:

| Knob | Where | Effect |
| --- | --- | --- |
| `utils."chat-messages".enabled` | `settings.json` | the master switch. `false` = the bot never calls `bot.chat()` on its own |
| `utils."chat-messages"."repeat-delay"` | `settings.json` | only matters while `enabled` is true: seconds between lines (60-140% jitter applied, 5 s floor) |

To silence a running bot without editing files:

| Where | What to do |
| --- | --- |
| Dashboard | the **Turn auto-chat off / on** button in the Bot card, or `POST /chat` |
| Panel console | `/chat off`, `/chat on`, `/chat` (reports the current state) |
| Minecraft chat | `/msg <bot> chat off` if you allow chat commands from players |

`/chat off` clears the interval and removes it from the tracked set, so a
reconnect cannot re-arm it — the next `/chat on` (or restart) does. That is a
different thing from raising `repeat-delay`, which only makes the messages rarer.

## Dashboard

* **Status card** — `Connected` / `Disconnected` / `Stopped` plus the *reason*
  (last kick text, "socket silence", "spawn timeout", "another instance is
  running this username", …).
* **Session uptime** — measured from the last successful spawn, so a reconnect
  resets it. Process uptime is shown separately in `/health`.
* **Coordinates** — from `bot.entity.position`.
* **Server card** — address, join address, player count from the status ping,
  version, ping latency, provider status, and Start / Stop / Restart buttons.
* **Banners** — policy block (amber), serverless (blue-grey), proxy mode (green),
  invalid backend URL (red).
* Auto-refreshes provider status every 20s; the full page reloads after an action.

---

## Keep-alive self-ping

```
PUBLIC_URL            explicit override, always wins
RENDER_EXTERNAL_URL   auto (Render)
KOYEB_PUBLIC_DOMAIN   auto — https:// is added
FLY_APP_NAME          auto — https://<app>.fly.dev
RAILWAY_PUBLIC_DOMAIN auto
```

* Interval: `SELF_PING_INTERVAL_MS`, default `240000` (4 minutes).
* Target: `<origin>/ping`.
* Skipped entirely in proxy and serverless mode (there is nothing to keep warm).
* Failures are logged and counted so a dying instance is visible in the logs.

---

## Configuration

`settings.json` (kebab-case keys, comments are for this document only):

```jsonc
{
  "bot-account": {
    "username": "AFKBot",     // MC_USERNAME overrides
    "password": "",           // MC_PASSWORD overrides; leave empty for offline
    "type": "offline"         // "offline" | "microsoft"
  },
  "server": {
    "ip": "your-server.aternos.me",   // MC_SERVER_HOST overrides
    "port": 25565,                    // MC_SERVER_PORT overrides
    "version": false,                 // false = auto-detect
    "try-creative": false
  },
  "utils": {
    "auto-reconnect": true,
    "auto-reconnect-delay": 2000,          // base backoff
    "max-reconnect-delay": 120000,         // hard cap
    "force-login-after-probes": 6,         // probes are advisory
    "duplicate-login-backoff-min": 120000,
    "duplicate-login-backoff-max": 180000,
    "probe-timeout": 6000,
    "probe-cache-ms": 5000,
    "watchdog": {
      "enabled": true,
      "silence-timeout": 90000,
      "spawn-timeout": 120000,
      "stall-timeout": 600000,
      "stall-grace": 120000,
      "tick-interval": 5000
    },
    "auto-auth":     { "enabled": false, "password": "" },
    "anti-afk":      { "enabled": true,  "sneak": false },      // jittered 20-90s, weighted actions
    "human-mode":    {
      "enabled": true,
      "quiet-hours": { "enabled": false, "start-hour": 1, "end-hour": 8 }  // true = offline at night
    },
    "chat-messages": {
      "enabled": false,                  // true = the bot talks
      "repeat": false,                   // true = keep talking every "repeat-delay"
      "repeat-delay": 420,               // seconds; 60-140% jitter applied, 5s floor
      "only-when-players-online": true,  // stay silent on an empty server
      "messages": []                     // picked at random, never twice in a row
    },
    "leave-rejoin":  {
      "enabled": false,                 // leave politely after a random session
      "min-stay-ms": 2700000,           // 45 min
      "max-stay-ms": 9000000,           // 150 min
      "rest-min-ms": 600000,            // break 10-40 min before rejoining
      "rest-max-ms": 2400000
    }
  },
  "provider": {
    "enabled": true,
    "exaroton-server-id": "",       // EXAROTON_SERVER_ID overrides
    "exaroton-server-address": "",
    "status-cache-ms": 15000,
    "manual-start-hint": "…"
  }
}
```

Anything omitted falls back to sane defaults (`deepMerge` over `DEFAULT_CONFIG`),
so a partial `settings.json` still boots.

---

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `5000` | HTTP port (binds `0.0.0.0`). Panel hosts that assign one, like Botkeep, pass it as `SERVER_PORT` and that is read automatically. |
| `MC_SERVER_HOST` / `MC_SERVER_PORT` | settings | Server target (`host:port` also accepted). |
| `MC_USERNAME` / `MC_PASSWORD` | settings | Account credentials. |
| `DASHBOARD_PATH` | (none) | Serve the dashboard under a secret path instead of the root: `DASHBOARD_PATH=my-bot-7f3a` → `http://host:port/my-bot-7f3a`. No login prompt, nothing to type twice; the root answers plain `404` and scanners see nothing. `/ping`, `/health`, `/mirror/status` stay at the root. |
| `DASHBOARD_PASSWORD` | (none) | HTTP basic auth for the dashboard. Set it whenever the port is public — a panel host publishes it. `/ping`, `/health` and `/mirror/status` stay open so health checks work. Surrounding whitespace is trimmed. |
| `DASHBOARD_USER` | `admin` | User name for that password. |
| `PUBLIC_URL` | auto | Keep-alive target. |
| `SELF_PING_INTERVAL_MS` | `240000` | Keep-alive cadence. |
| `BOT_BACKEND_URL` | — | Proxy every request to an always-on bot. |
| `BOT_LEASE_DIR` | `os.tmpdir()` | Where the single-instance lease lives. |
| `BOT_MIRROR_URL` | — | Cross-machine failover peer. |
| `EXAROTON_TOKEN` | — | Provider token (**env only**). |
| `EXAROTON_SERVER_ID` | settings | Provider server id. |
| `EXAROTON_BASE_URL` | `https://api.exaroton.com/v1` | Provider API base. |
| `LOG_BUFFER_SIZE` | `500` | Log ring-buffer size. |
| `VERCEL` / `AWS_LAMBDA_FUNCTION_NAME` / `NETLIFY` / `CF_PAGES` | — | Serverless detection. |

---

## Deploying

### One host runs everything

The dashboard and the bot are **one process**, so an always-on host is the whole
deployment: `npm start`, open the port, press Start. No second service, no
`BOT_BACKEND_URL`, no proxy, nothing to keep in sync.

```
one always-on host  ──►  node index.js  ──►  dashboard + /start + /stop + bot
                                              │
                                              └──► Minecraft server (TCP, 24/7)
```

The **only** reason this repo mentions a second host is serverless: Vercel,
Netlify and Lambda kill a function after 10–30 seconds, so a Minecraft TCP
session cannot live there. That is a platform limit, not a missing setting. If
your dashboard is on a serverless plan, the bot needs an always-on host and the
function proxies to it; if your dashboard is on any always-on host, you need
nothing else at all.

* **Render free — $0, recommended** — `render.yaml` deploys **one** free web
  service that runs the dashboard and the bot together. Nothing else to create.
  What the free plan means for this bot:

  | Free limit | Effect on the bot |
  | --- | --- |
  | 512 MB RAM / 0.1 CPU | Fine — the process idles around 70 MB and reaches ~100–130 MB after `minecraft-data` loads. `NODE_OPTIONS=--max-old-space-size=384` is set so a memory problem surfaces as a Node error, not a kernel OOM kill. |
  | Spins down after 15 min without inbound traffic | The self-ping hits `/ping` every 4 min, so this never triggers. An outbound Minecraft connection does **not** count as traffic — the self-ping is what keeps the host awake. |
  | 750 instance hours per workspace per month | One service awake 24/7 uses 720 h (30-day) / 744 h (31-day). Do not run a second free service in the same workspace, or Render suspends both until next month. |
  | Render may restart a free service at any time | The bot connects on boot, so a restart is a short gap, not a dead bot. `/start` still works after it. |
  | Ephemeral filesystem | Nothing is stored on disk. The `/tmp` lease is per-container by design. |
  | Cold start ≈ 1 min after a spin-down | Only matters if the service ever sleeps; the self-ping normally prevents it. |

  Render's own docs say free instances are not for production. For this bot that
  means *expect the occasional restart*, not *expect it not to work*. If you want
  no restarts, switch `plan: free` to `plan: starter` ($7/mo, same 512 MB) —
  nothing else changes.

  > **Read this before choosing Render free.** The self-ping above exists to stop
  > the 15-minute spin-down, and that is exactly what Render treats as abusing an
  > evaluation tier — three accounts have already been suspended for it in this
  > project. Render suspends for keeping a free service permanently awake, and
  > again for opening a second account to get a second free service. If your
  > account is gone, do not recreate it: use a host where 24/7 is the product —
  > see [Free 24/7 hosting](#free-247-hosting).

* **Render paid / Koyeb / Fly / Railway** — the same single service; these never
  sleep, so the self-ping becomes optional insurance rather than the thing that
  keeps it alive.
* **A free host that allows 24/7** — a bot panel (512 MB, no card), Oracle Cloud
  Always Free, an old Android phone on Termux, or a ₹99 VPS. Step-by-step for
  each is in [`deploy/free-hosts.md`](deploy/free-hosts.md); the repo ships
  `docker-compose.yml`, `deploy/minecraft-afk-bot.service`,
  `deploy/vm-install.sh` and `deploy/termux-install.sh` to match.
* **Docker** — `Dockerfile` (Node 20 Alpine, `tini` for clean signals, non-root user,
  `HEALTHCHECK` on `/ping`). Build ignores `.env`, `tests`, docs via `.dockerignore`.
* **Procfile / nixpacks** — `Procfile` (`web: node index.js`) and `nixpacks.toml`
  (Node 20, `npm ci --omit=dev`, `node --check` build step) for Railway/Coolify.
* **Vercel — optional, dashboard only.** Skip this entirely if you deployed on
  Render/Docker/a VPS: the same process already serves the page. Only use Vercel
  if you specifically want the dashboard on Vercel, in which case the bot still
  has to run on one always-on host and Vercel proxies to it. `api/index.js` is
  the request handler and `vercel.json` routes every path to it, so the page
  renders instead of returning `500 FUNCTION_INVOCATION_FAILED`:

  1. Import the repo on Vercel (framework preset: **Other**, no build command —
     `vercel.json` sets `framework: null`).

     The config is deliberately warning-free:

     * **no `memory`** in `vercel.json` — it is ignored (and warns) on Active CPU
       billing, so the plan decides it;
     * **`engines.node` is a bounded range** (`>=20 <23`), not `>=18`: an
       open-ended range makes Vercel warn and silently upgrade the major under you;
     * `maxDuration: 30` is kept because it is honoured on every plan;
     * `.npmrc` pins the install behaviour instead of relying on platform env.

  2. Deploy **one** always-on bot instance (Render free is enough — see above) —
     a function cannot hold a Minecraft TCP session.
  3. In **Project → Settings → Environment Variables** add
     `BOT_BACKEND_URL=https://your-always-on-bot.example.com` and redeploy.

  With that variable set, the Vercel deployment proxies every request — dashboard,
  logs, controls, `/command` — to the real bot, so the site shows the **live**
  session. Without it, the deployment honestly reports
  *"Serverless runtime detected — no bot can run here"* and never claims to be
  connected. Requests are stateless between invocations, so `/start` and `/stop`
  belong on the always-on instance (which is exactly where proxy mode sends them).

* **Netlify / AWS Lambda** — the same handler works (`api/index.js` exports an
  `(req, res)` function); point the platform's function route at it and set
  `BOT_BACKEND_URL` the same way.

Keep it to **one** bot instance per username.

---

## Free 24/7 hosting

Every option below runs this bot the way it is meant to run — one process, no
second host, no trick to stay awake. Full steps: [`deploy/free-hosts.md`](deploy/free-hosts.md).

| Option | Signup | Card | Why it does not get suspended | RAM |
| --- | --- | --- | --- | --- |
| Bot panel — Botkeep, HeavenCloud, SillyDev, Waifly, VisiHost | email, 2 min | no | 24/7 is the product; being online is expected | 256–512 MB |
| Oracle Cloud Always Free | email + card | yes, ₹0 | a real always-free VM; nothing spins down | up to 24 GB |
| Old Android + Termux | none | no | it is your own device; nothing to suspend | phone RAM |
| ₹99/mo VPS (RackNerd, Hetzner, VisiHost) | email + UPI | yes | paid host, no free-tier rules | 512 MB+ |

What the bot actually uses, measured locally: **~70 MB idle, ~100–130 MB after
`minecraft-data` loads, one outbound TCP connection**. 512 MB is comfortable,
256 MB is tight — set `NODE_OPTIONS=--max-old-space-size=192` there.

### Botkeep (easiest, 512 MB, no card, no renewals)

Sign up at `botkeep.cloud/register`, create a **Node.js 22** server, upload a ZIP
whose root contains `package.json` (GitHub "Download ZIP" adds an outer folder —
re-zip the contents), start command `npm start`, and one environment variable:

```
NODE_OPTIONS=--max-old-space-size=384
```

Leave `PORT` unset: Botkeep passes the assigned port as `SERVER_PORT` and the app
binds it. Full walkthrough with the exact console output:
[`deploy/free-hosts.md`](deploy/free-hosts.md#1-botkeep--step-by-step).

SillyDev has its own walkthrough (panel setup, the one-file update, and wiring
the panel port to a Vercel dashboard):
[`deploy/free-hosts.md`](deploy/free-hosts.md#2b-sillydev-start-to-finish).

Other Pterodactyl-style panels (HeavenCloud, SillyDev, Waifly) have no build
step — `unzip`, `npm ci --omit=dev`, startup command `node index.js`. Those
panels give no public URL, so the console is your dashboard; the bot is identical.

### VM, VPS, home PC, Raspberry Pi

```
git clone <this repo> && cd <repo>
sudo docker compose up -d --build        # or: sudo bash deploy/vm-install.sh
```

`docker-compose.yml` and `deploy/minecraft-afk-bot.service` both use
`restart: always`, so a crash, a reboot or an OOM kill brings the bot back —
the thing a PaaS free tier keeps undoing.

### Old Android phone

```
pkg install git
git clone <this repo> ~/afk-bot
bash ~/afk-bot/deploy/termux-install.sh
```

No account, no card, no limits — the phone just has to stay on and charging.

### Why Render free suspended accounts

The self-ping defeats the 15-minute spin-down, and a second account to get a
second free service is ban evasion. Both are free-tier abuse on any sleep-based
PaaS. Do not re-create those accounts; move to a host above, where leaving a bot
online is normal.

---

## Tests

```
npm test                  # syntax check of every module
npm run test:all          # syntax + all 15 suites (191 tests)
```

| Suite | Tests | Covers |
| --- | --- | --- |
| `test-lifecycle.js` | 17 | Backoff growth and cap, probe readiness, forced login after 6 probes, kick classification, duplicate-login window, policy pauses, stop/start, session uptime, SIGTERM, watchdog-before-modules. |
| `test-duplicate-instance.js` | 5 | Lease acquisition, live-owner blocking, stale takeover, TTL/pid rules, renewal + release + `BOT_LEASE_DIR`. |
| `test-mirror.js` | 6 | Payload shape, inbound accept/reject, GET snapshot, `BOT_MIRROR_URL` parsing, real round-trip, unreachable peer. |
| `test-watcher-policy.js` | 16 | 90s silence, 120s spawn, 10min nudge + grace, tunables, throwing handlers, policy categories, banner rendering. |
| `test-provider.js` | 21 | Status map 0–10, token exclusivity, base URL scheme, start/stop/restart paths, error surfacing, token scrubbing, endpoint wiring. |
| `test-proxy.js` | 16 | Vercel/Lambda/Netlify/CF detection, backend URL validation, status/body/header passthrough, 502 on dead backend, serverless banner. |
| `test-keepalive.js` | 18 | URL detection order, interval override, repeat + stop, proxy/serverless skip, failure logging, `/ping` round-trip. |
| `test-chat.js` | 11 |
| `test-human.js` | 9 | Behaviour that does not look like a cron: anti-AFK gaps are 20–90 s and actually vary, actions are weighted (look/swing dominate), quiet hours handle windows that wrap midnight, breaks are 10–40 min, a source scan fails the build if the old 45 s/60 s fixed timers come back, and every `guard()` in `initializeModules` must name a function that exists — the check that would have caught the release where five modules were armed but undefined. | Chat that reads like a person: every gap is 60–140% of `repeat-delay` with a 5 s floor, the same line never repeats back to back even with a degenerate random source, one-line and empty lists behave, 420 s averages 6–8 minutes; and the console box sends chat, refuses shell commands (`npm install` gets an explanation instead of "not connected") reports stopped vs not-connected correctly; and `/chat off` (or the dashboard button) is a hard stop that clears the timer, not a shorter delay. |
| `test-envfile.js` | 7 | `.env` parsing (comments, `export`, quotes, junk lines, CRLF), a real panel variable always beats the file, missing/unreadable files are not errors, and the dashboard can be configured from `settings.json` when the host has no Variables tab. |
| `test-dashboard-auth.js` | 9 | Optional dashboard password: off with no env var, 401 + `WWW-Authenticate` without one, accepted with the right user/password, wrong user/password/garbage rejected, `/ping` `/health` `/mirror/status` left open for health checks, tricky passwords (`:`, unicode) still work; a `DASHBOARD_PATH` hides the root with a 404, rewrites the prefixed URL, keeps health at the root, and normalises slashes. |
| `test-doctor.js` | 10 | The pre-flight check: a real checkout passes, a ZIP with an extra folder is explained with the `mv` that fixes it, missing `node_modules` names the command, broken `settings.json` and an empty target fail, Node 18 fails / 25 warns, `SERVER_PORT` becomes the reported port, Vercel without `BOT_BACKEND_URL` is a hard failure, and a half-written `node_modules` is caught when mineflayer is required instead of at login. |
| `test-liveness.js` | 6 | What counts as "the server is still talking": parsed packets alone keep a session alive (the panel-host 90s loop), raw bytes and chat still count, genuine silence still reconnects, detach removes every listener, and a bot with no `_client` never throws. |
| `test-single-host.js` | 19 | The one-host promise, enforced: `render.yaml` has exactly **one** service, stays on `plan: free`, runs one instance of `node index.js`, keeps `BOT_BACKEND_URL` empty, caps the V8 heap under 512 MB, self-pings faster than Render's 15-min spin-down and health-checks `/health`; `Procfile`/`nixpacks`/`Dockerfile` agree on the port and the endpoint; `docker-compose.yml` and the systemd unit restart forever; the Termux script takes a wake-lock; `SERVER_PORT` is read so a panel host's assigned port is bound; `deploy/free-hosts.md` covers every free option and warns about multi-accounting; the serverless entry never claims to start a bot. |
| `test-serverless.js` | 21 | The Vercel/Lambda entry: callable export, warning-free `vercel.json` + bounded `engines`, static-output hygiene, routing, no bot started, every page 200, honest banner, warm-handler reuse, POST bodies, proxying, 502 on a dead backend, plus the degraded paths (stripped `index.js`, module that throws, backend still reachable) and an import/export consistency check. |

The suites use a 40-line harness (`tests/harness.js`) on top of `node:assert`.
They start real local HTTP servers where behaviour matters, and they never touch
the network.

---

## Rules this bot follows

* **No website automation.** Nothing here drives Aternos' panel with a browser or
  scrapes its queue. That violates Aternos' Terms of Service §5, and a bot that
  does it gets the account banned — plus everyone else's server.
* **No fake activity.** The bot moves, looks and chats like a normal client would;
  it does not inject synthetic packets to dodge idle detection.
* **A policy ban is not retried into a loop.** Automatic reconnects stop dead;
  `/start` is a human decision.
* **No duplicate logins.** The lease plus the 120–180s duplicate-login backoff
  keep two copies from kicking each other forever.
* **No lying dashboards.** If there is no bot (serverless), no provider token, or
  no cached status, the UI says so.

If you want the server awake around the clock, use the host's own API (exaroton is
supported) or a paid plan — not automation of the free queue.

---

## Troubleshooting

**"Disconnected" with a probe error and it keeps probing**
The port is not answering yet. Aternos' proxy opens it before the world is ready,
which shows up as `port open, no status reply (server still booting)`. After six
probes the bot forces a login, so just leave it running.

**`[Watchdog] Socket silent for ~92s` in a loop, right after spawn**
The session is fine, the silence detector was blind. Fixed: liveness now comes
from every parsed packet as well as raw socket bytes, so a host where mineflayer
never emits `socket` no longer looks dead. If you still see it on an older
commit or a panel that genuinely drops the connection:

* the log line now ends with `(tcp: open, phase: connected)` — `tcp: open` with
  keepalives arriving means the detector, `tcp: closed` means the network;
* run **Node 20–22**, not 23+: `engines` is `>=20 <23`, and some panels default
  to Node 25, where mineflayer is untested and `npm warn EBADENGINE` warns you;
* raise `utils.watchdog.silence-timeout` in `settings.json` (e.g. `180000`) if
  the Minecraft server itself is quiet during long night-time lulls.

**A host suspended the server: was it the bot?**
Usually one of three things, all visible in your own config: fast repeating chat
(`utils."chat-messages"` under 120 s, or a threat like "I will ban you" — hosts
call that spam and servers ban for it), a reconnect storm from an old `index.js`,
or a second account/server after a suspension (ban evasion). `npm run doctor`
judges all of it. Chat itself is fine — and it is the most human-looking thing a
bot does, so keep gaps at 5-10 minutes with jitter. SillyDev explicitly allows
AFK clients; Aternos does not allow AFK bots at all, so the *Minecraft* server can
be suspended regardless of the host, and chat does not change that.
See [Suspensions](deploy/free-hosts.md#11-suspensions-what-actually-gets-this-bot-banned).

**"Another instance is running this username"**
A lease exists in `/tmp` (or `BOT_LEASE_DIR`). It clears itself 60s after the other
process stops. Two containers on different machines need `BOT_MIRROR_URL`, not a
shared `/tmp`.

**Duplicate-login kicks every few minutes**
Something else is using the same username. The bot backs off 120–180s, but the real
fix is to stop the other client.

**Amber "Blocked by server policy" banner**
The server banned you for idling, automation, or ToS. Reconnecting will not help
and will likely escalate. Change the behaviour (or the server), then press Start.

**Dashboard says the bot is stopped on Vercel**
Correct — a serverless function cannot hold a Minecraft TCP connection. Either set
`BOT_BACKEND_URL` to an always-on bot, or drop Vercel: `render.yaml` deploys the
dashboard *and* the bot as one free service, and then the whole app lives on a
single host.

**Do I need a second host?**
No, unless the dashboard is on Vercel/Netlify/Lambda. One always-on process runs
the dashboard, the controls and the bot together.

**The URL shows raw JavaScript (`"use strict"; const fs = require(...)`)**
That project is deployed as a **static site**, so `/` resolved to `index.js` and
Vercel served the source as text. Nothing in the file structure prevented it —
that is the bug this repo now fixes on three fronts:

* `index.html` sits at the **repository root** — what any static host serves at
  `/` — so even a project that ignores `vercel.json` gets the page;
* `public/index.html` is the only published static file
  (`outputDirectory: "public"`) for projects that do honour it, so `index.js`,
  `settings.json` and friends have no URL at all;
* `/` renders a status shell that queries `/status/light`;
* when the function is deployed properly, `rewrites` send every path to
  `api/index.js` and the static file is never reached.

An **existing** static project will keep serving the old source until you either
redeploy this commit or, better, switch it to the function layout:

1. **Settings → Build & Development Settings** → Framework Preset **Other**,
   Build Command *empty*, Output Directory **empty** (run `vercel.json`'s
   `outputDirectory` for you) or explicitly `public`.
2. Confirm **Root Directory** is the repo root so `api/index.js` is detected.
3. **Redeploy** (Build Cache off). `/` should then return the dashboard HTML and
   `/health` should return JSON.

If the project still serves files after that, the deployment is static-only:
delete the project and re-import the repo — a project created as a static site
keeps no functions.

**Build log warns about `engines`, `memory` or `cache-dir`**
All three are handled in this repo; seeing them means the deployed commit is older
than `0de812e`:

| Warning | Cause | Handled by |
| --- | --- | --- |
| `"engines": { "node": ">=18" } … will automatically upgrade` | open-ended range | `engines.node: ">=20 <23"` |
| `Provided memory setting in vercel.json is ignored on Active CPU billing` | plan-specific setting | `memory` removed; only `maxDuration` remains |
| `npm warn Unknown env config "cache-dir"` | Vercel injects an env config npm 11 dropped | `.npmrc` pins supported options; harmless either way |

**Vercel shows `500: INTERNAL_SERVER_ERROR` / `FUNCTION_INVOCATION_FAILED`**
The function threw while loading. This repo ships the handler at `api/index.js`
plus the `vercel.json` rewrite, and the handler has three layers of fallback:

1. the full dashboard from `../index.js`;
2. a dependency-free page that names the load error and explains the fix;
3. plain `http` forwarding when a backend is configured.

So a 500 now only means the *file itself* failed (bad syntax) or the project
config is wrong. Check, in order:

* **Root Directory** on Vercel is the repository root, not a subfolder;
* `api/index.js`, `index.js`, `settings.json`, `package.json` and
  `vercel.json` are committed on the deployed branch;
* the build ran `npm install` (Vercel → Deployments → build log);
* `vercel logs <deployment-url>` for the actual stack trace.

The handler logs its mode on cold start:
`[Serverless] Request handler created (mode: serverless) — no Minecraft session is started here`.
If you see the "Dashboard unavailable in this runtime" page instead, the message
on it names the exact reason (e.g. *index.js does not export a serverless
handler*), which is the case to fix in code.

> **Never delete the `SERVERLESS ENTRY` block in `index.js`.** `api/index.js`
> imports `makeServerlessHandler` from it. `tests/test-serverless.js` asserts the
> import list matches the exports, so `npm run test:all` fails instead of the
> production site 500ing.

**Server buttons return 409 "reporting mode"**
No provider API is configured. Set `EXAROTON_TOKEN` + `EXAROTON_SERVER_ID`, or start
the server manually — the bot joins on its own once the port answers.

---

MIT © Lamgerr
