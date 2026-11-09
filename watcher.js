"use strict";

// ============================================================
// watcher.js — watchdogs + self-ping keep-alive
//
// Two independent safety nets live here because they are both
// "is this thing still alive?" timers:
//
// 1. Watchdog
//      - 90s of socket silence          -> reconnect
//      - 120s with no spawn             -> abandon the attempt
//      - 10min with no player movement  -> nudge, then reconnect
//
//    Every threshold is tunable through settings.json →
//    utils.watchdog, and every callback is optional so the
//    module stays unit-testable without mineflayer.
//
// 2. Keep-alive self-ping
//      Free hosts (Render, Koyeb, Fly, Railway) sleep idle
//      services. We ping our own public URL on a timer so the
//      process stays warm. Skipped entirely when the bot is
//      running in proxy / serverless mode, where the request
//      would just bounce back to a stateless function.
// ============================================================

const http = require("http");
const https = require("https");

// ------------------------------------------------------------
// Defaults
// ------------------------------------------------------------

const WATCHDOG_DEFAULTS = {
  enabled: true,
  "silence-timeout": 90_000, // 90s no socket data
  "spawn-timeout": 120_000, // 120s wait for spawn
  "stall-timeout": 600_000, // 10min no movement -> nudge
  "stall-grace": 120_000, // 2min after nudge -> reconnect
  "tick-interval": 5_000, // how often we check
};

const KEEPALIVE_DEFAULTS = {
  interval: 4 * 60_000, // 4 minutes
  path: "/ping",
  timeoutMs: 15_000,
};

function toPositiveNumber(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** Merge settings.json utils.watchdog over the built-in defaults. */
function resolveWatchdogConfig(utils = {}) {
  const raw = (utils && utils.watchdog) || {};
  return {
    enabled: raw.enabled !== false,
    silenceTimeout: toPositiveNumber(
      raw["silence-timeout"],
      WATCHDOG_DEFAULTS["silence-timeout"],
    ),
    spawnTimeout: toPositiveNumber(
      raw["spawn-timeout"],
      WATCHDOG_DEFAULTS["spawn-timeout"],
    ),
    stallTimeout: toPositiveNumber(
      raw["stall-timeout"],
      WATCHDOG_DEFAULTS["stall-timeout"],
    ),
    stallGrace: toPositiveNumber(
      raw["stall-grace"],
      WATCHDOG_DEFAULTS["stall-grace"],
    ),
    tickInterval: toPositiveNumber(
      raw["tick-interval"],
      WATCHDOG_DEFAULTS["tick-interval"],
    ),
  };
}

// ------------------------------------------------------------
// Watchdog
// ------------------------------------------------------------

function safeInvoke(fn, arg, log) {
  if (typeof fn !== "function") return;
  try {
    fn(arg);
  } catch (err) {
    if (typeof log === "function") {
      log(`[Watchdog] Callback failed (watchdog keeps running): ${err.message}`);
    }
  }
}

class Watchdog {
  /**
   * @param {object} options
   * @param {function} [options.log]
   * @param {function} [options.onSilence]        (info) => void  -> reconnect
   * @param {function} [options.onSpawnTimeout]   (info) => void  -> reconnect
   * @param {function} [options.onStall]          (info) => void  -> nudge
   * @param {function} [options.onStallExpired]   (info) => void  -> reconnect
   * @param {function} [options.now]              clock override for tests
   * @param {object}   [options.config]           resolved watchdog config
   */
  constructor(options = {}) {
    this.config = options.config || resolveWatchdogConfig();
    this.log = options.log || (() => {});
    this.onSilence = options.onSilence || null;
    this.onSpawnTimeout = options.onSpawnTimeout || null;
    this.onStall = options.onStall || null;
    this.onStallExpired = options.onStallExpired || null;
    this.now = options.now || Date.now;

    this.timer = null;
    this.running = false;

    this.reset();
  }

  reset() {
    const t = this.now();
    this.armedAt = t;
    this.lastDataAt = t;
    this.lastMovementAt = t;
    this.spawned = false;
    this.nudged = false;
    this.nudgeAt = 0;
    this.fired = { silence: false, spawn: false, stall: false, stallExpired: false };
  }

  /** Arm the watchdog for a fresh connection attempt. */
  start() {
    if (!this.config.enabled) return this;
    this.reset();
    this.running = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), this.config.tickInterval);
    if (typeof this.timer.unref === "function") this.timer.unref();
    return this;
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this;
  }

  /** Any bytes off the wire. */
  noteData() {
    this.lastDataAt = this.now();
  }

  /** The bot entity has spawned. A fresh spawn starts a fresh evaluation. */
  noteSpawn() {
    this.spawned = true;
    const t = this.now();
    this.lastDataAt = t;
    this.lastMovementAt = t;
    this.nudged = false;
    this.nudgeAt = 0;
    this.lastPosition = null;
    this.fired = { silence: false, spawn: false, stall: false, stallExpired: false };
  }

  /** Explicit activity callback (movement, chat, swing...). */
  noteMovement() {
    this.lastMovementAt = this.now();
  }

  /**
   * Position-based movement detection: call with the current
   * position once per tick; only a real coordinate change counts.
   */
  notePosition(pos, epsilon = 0.05) {
    if (!pos || !Number.isFinite(pos.x)) return false;
    if (!this.lastPosition) {
      this.lastPosition = { x: pos.x, y: pos.y, z: pos.z };
      this.lastMovementAt = this.now();
      return false;
    }
    const moved =
      Math.abs(pos.x - this.lastPosition.x) > epsilon ||
      Math.abs(pos.y - this.lastPosition.y) > epsilon ||
      Math.abs(pos.z - this.lastPosition.z) > epsilon;
    if (moved) {
      this.lastPosition = { x: pos.x, y: pos.y, z: pos.z };
      this.lastMovementAt = this.now();
    }
    return moved;
  }

  /** Single evaluation pass. Exposed so tests can drive time directly. */
  tick() {
    if (!this.running || !this.config.enabled) return;
    const t = this.now();

    // 1. spawn timeout — only until the entity exists
    if (!this.spawned) {
      const waited = t - this.armedAt;
      if (!this.fired.spawn && waited >= this.config.spawnTimeout) {
        this.fired.spawn = true;
        this.log(
          `[Watchdog] No spawn after ${Math.round(waited / 1000)}s — abandoning attempt`,
        );
        safeInvoke(this.onSpawnTimeout, { waitedMs: waited }, this.log);
        return;
      }
      return; // silence/stall are meaningless before spawn
    }

    // 2. socket silence
    const silentFor = t - this.lastDataAt;
    if (!this.fired.silence && silentFor >= this.config.silenceTimeout) {
      this.fired.silence = true;
      this.log(
        `[Watchdog] Socket silent for ${Math.round(silentFor / 1000)}s — reconnecting`,
      );
      safeInvoke(this.onSilence, { silentMs: silentFor }, this.log);
      return;
    }

    // 3. movement stall -> nudge, then give up
    const stillFor = t - this.lastMovementAt;
    if (!this.nudged && stillFor >= this.config.stallTimeout) {
      this.nudged = true;
      this.nudgeAt = t;
      this.log(
        `[Watchdog] No movement for ${Math.round(stillFor / 1000)}s — nudging`,
      );
      safeInvoke(this.onStall, { stalledMs: stillFor }, this.log);
      return;
    }

    if (
      this.nudged &&
      !this.fired.stallExpired &&
      t - this.nudgeAt >= this.config.stallGrace
    ) {
      this.fired.stallExpired = true;
      this.log(
        `[Watchdog] Still no movement ${Math.round((t - this.nudgeAt) / 1000)}s after nudge — reconnecting`,
      );
      safeInvoke(this.onStallExpired, { stalledMs: t - this.lastMovementAt }, this.log);
    }
  }
}

function createWatchdog(options = {}) {
  return new Watchdog(options);
}

// ------------------------------------------------------------
// Keep-alive
// ------------------------------------------------------------

/** Normalise "example.com" / "https://example.com/" to a bare origin. */
function normalisePublicUrl(raw) {
  if (!raw) return null;
  let value = String(raw).trim();
  if (value === "") return null;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  try {
    const url = new URL(value);
    if (!url.hostname) return null;
    return url.origin;
  } catch (_err) {
    return null;
  }
}

/**
 * Figure out our own public URL from the environment.
 * Order matters: an explicit PUBLIC_URL always wins.
 */
function resolvePublicUrl(env = process.env) {
  const explicit = normalisePublicUrl(env.PUBLIC_URL);
  if (explicit) return explicit;

  const render = normalisePublicUrl(env.RENDER_EXTERNAL_URL);
  if (render) return render;

  if (env.KOYEB_PUBLIC_DOMAIN) {
    const koyeb = normalisePublicUrl(env.KOYEB_PUBLIC_DOMAIN);
    if (koyeb) return koyeb;
  }

  if (env.FLY_APP_NAME) {
    const fly = normalisePublicUrl(`${env.FLY_APP_NAME}.fly.dev`);
    if (fly) return fly;
  }

  if (env.RAILWAY_PUBLIC_DOMAIN) {
    const railway = normalisePublicUrl(env.RAILWAY_PUBLIC_DOMAIN);
    if (railway) return railway;
  }

  return null;
}

function resolveKeepAliveInterval(env = process.env) {
  return toPositiveNumber(env.SELF_PING_INTERVAL_MS, KEEPALIVE_DEFAULTS.interval);
}

/** One ping. Resolves with { ok, statusCode, error }. */
function pingUrl(url, options = {}) {
  const timeoutMs = options.timeoutMs || KEEPALIVE_DEFAULTS.timeoutMs;
  const target = options.url || url;

  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(target);
    } catch (err) {
      resolve({ ok: false, statusCode: 0, error: err.message });
      return;
    }

    const transport = parsed.protocol === "https:" ? https : http;
    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: "GET",
        headers: {
          "User-Agent": "minecraft-afk-bot/2.11 (keepalive)",
          Accept: "*/*",
        },
      },
      (res) => {
        res.resume(); // drain
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 400,
          statusCode: res.statusCode,
          error: null,
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`keepalive ping timed out after ${timeoutMs}ms`));
    });
    req.on("error", (err) => {
      resolve({ ok: false, statusCode: 0, error: err.message });
    });
    req.end();
  });
}

/**
 * Start the self-ping loop.
 *
 * @returns {{stop:function, ping:function, url:string|null, intervalMs:number, skipped:string|null}}
 */
function startKeepAlive(options = {}) {
  const env = options.env || process.env;
  const log = options.log || (() => {});
  const url = options.url || resolvePublicUrl(env);
  const intervalMs = toPositiveNumber(options.intervalMs, resolveKeepAliveInterval(env));
  const path = options.path || KEEPALIVE_DEFAULTS.path;

  const noop = {
    stop() {},
    async ping() {
      return { ok: false, skipped: true };
    },
    url,
    intervalMs,
    skipped: null,
  };

  if (options.proxyMode || options.serverless) {
    noop.skipped = "proxy/serverless mode";
    log("[KeepAlive] Skipped — running behind a proxy / serverless runtime");
    return noop;
  }

  if (!url) {
    noop.skipped = "no public url";
    log(
      "[KeepAlive] No PUBLIC_URL / RENDER_EXTERNAL_URL / KOYEB_PUBLIC_DOMAIN / FLY_APP_NAME / RAILWAY_PUBLIC_DOMAIN set — self-ping disabled",
    );
    return noop;
  }

  const target = url.replace(/\/+$/, "") + path;
  let timer = null;
  let failures = 0;

  const ping = async () => {
    const result = await pingUrl(target, { timeoutMs: options.timeoutMs });
    if (result.ok) {
      if (failures > 0) log(`[KeepAlive] Ping recovered after ${failures} failure(s)`);
      failures = 0;
    } else {
      failures += 1;
      log(
        `[KeepAlive] Ping failed (${result.error || result.statusCode}) — ${failures} in a row`,
      );
    }
    return result;
  };

  timer = setInterval(() => {
    ping().catch((err) => log(`[KeepAlive] Ping error: ${err.message}`));
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();

  log(
    `[KeepAlive] Self-ping every ${Math.round(intervalMs / 1000)}s -> ${target}`,
  );

  return {
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    ping,
    url,
    intervalMs,
    target,
    skipped: null,
  };
}

module.exports = {
  Watchdog,
  safeInvoke,
  createWatchdog,
  resolveWatchdogConfig,
  WATCHDOG_DEFAULTS,
  KEEPALIVE_DEFAULTS,
  resolvePublicUrl,
  resolveKeepAliveInterval,
  normalisePublicUrl,
  pingUrl,
  startKeepAlive,
};
