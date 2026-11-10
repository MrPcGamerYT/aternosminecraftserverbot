"use strict";

// ============================================================================
//  Minecraft AFK Bot — v2.11.0
//
//  A self-healing AFK session for Minecraft servers, plus an Express
//  dashboard that tells the truth about what is happening.
//
//  Design rules enforced throughout this file:
//    * Never automate Aternos' website, never fake player activity
//      (Aternos ToS §5). The bot plays like a normal client would.
//    * A policy ban is a STOP signal, not a retry signal.
//    * Every timer has exactly one owner — one reconnect scheduler,
//      one watchdog, one keep-alive. No stacked loops.
//    * Settings stay kebab-case, environment variables stay
//      snake_case, and secrets never leave process.env.
// ============================================================================

const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const crypto = require("crypto");
const https = require("https");
const { URL } = require("url");
const express = require("express");

const { addLog, getLogs, getLogText, subscribe } = require("./logger");
const probeModule = require("./probe");
const watcherModule = require("./watcher");
const providerModule = require("./provider");
const setupLeaveRejoin = require("./leaveRejoin");

let VERSION = "2.11.0";
try {
  VERSION = require("./package.json").version || VERSION;
} catch (_err) {
  /* package.json is optional at runtime */
}

const IS_MAIN = (() => {
  try {
    return require.main === module;
  } catch (_err) {
    return false;
  }
})();

// ============================================================================
//  CONFIG
// ============================================================================

const DEFAULT_CONFIG = {
  name: "FKtheserverhost",
  "bot-account": { username: "OfflinePlayer", password: "", type: "offline" },
  server: { ip: "", port: 25565, version: false, "try-creative": false },
  position: { enabled: false, x: 0, y: 100, z: 0 },
  utils: {
    "auto-auth": { enabled: false, password: "" },
    "anti-afk": { enabled: true, sneak: false },
    "chat-messages": {
      enabled: false,
      repeat: false,
      "repeat-delay": 120,
      "only-when-players-online": false,
      messages: [],
    },
    "chat-log": true,
    "auto-reconnect": true,
    "auto-reconnect-delay": 2000,
    "max-reconnect-delay": 120000,
    "force-login-after-probes": 6,
    "duplicate-login-backoff-min": 120000,
    "duplicate-login-backoff-max": 180000,
    "leave-rejoin": { enabled: false, "min-stay-ms": 300000, "max-stay-ms": 900000 },
    watchdog: {
      enabled: true,
      "silence-timeout": 90000,
      "spawn-timeout": 120000,
      "stall-timeout": 600000,
      "stall-grace": 120000,
      "tick-interval": 5000,
    },
  },
  movement: {
    enabled: true,
    "circle-walk": { enabled: false, radius: 4, speed: 3000 },
    "look-around": { enabled: true, interval: 5000 },
    "random-jump": { enabled: false, interval: 10000 },
  },
  modules: { avoidMobs: false, combat: false, beds: false, chat: true, "console-commands": true },
  combat: { "attack-mobs": false, "auto-eat": true },
  beds: { "pick-up-day": false, "place-night": false },
  discord: { enabled: false, webhookUrl: "", events: { connect: true, disconnect: true, chat: false } },
  chat: { respond: false },
  provider: {
    enabled: true,
    "exaroton-server-id": "",
    "exaroton-server-address": "",
    "status-cache-ms": 15000,
    "manual-start-hint":
      "No provider API is configured. Start the server in your host's panel — the bot joins automatically once the port answers.",
  },
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Deep-merge `source` over `target` without mutating either. */
function deepMerge(target, source) {
  const out = Array.isArray(target) ? target.slice() : { ...target };
  if (!isPlainObject(source)) return out;
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function loadConfig(file = path.join(__dirname, "settings.json")) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    addLog(`[Config] Could not read ${path.basename(file)}: ${err.message} — using defaults`);
  }
  return deepMerge(DEFAULT_CONFIG, raw);
}

const config = loadConfig();

function configNumber(section, key, fallback) {
  const source = section ? config[section] : config;
  const value = Number(source && source[key]);
  return Number.isFinite(value) ? value : fallback;
}

function envNumber(env, key, fallback) {
  const value = Number(env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function envFlag(env, key, fallback = false) {
  const value = env[key];
  if (value === undefined || value === null || value === "") return fallback;
  const normalised = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalised)) return true;
  if (["0", "false", "no", "off"].includes(normalised)) return false;
  return fallback;
}

// ============================================================================
//  SERVER ADDRESS RESOLUTION
// ============================================================================

function resolveServerTarget(cfg = config, env = process.env) {
  const providerConfig = cfg.provider || {};
  const envHost = (env.MC_SERVER_HOST || "").trim();
  const settingsHost = ((cfg.server && cfg.server.ip) || "").trim();
  const providerAddress = (providerConfig["exaroton-server-address"] || "").trim();
  const raw = envHost || settingsHost || providerAddress || "";

  // Allow "host:port" in any of the sources.
  let host = raw;
  let port = envNumber(env, "MC_SERVER_PORT", Number(cfg.server && cfg.server.port) || 25565);
  const match = /^([^:]+):(\d+)$/.exec(raw);
  if (match) {
    host = match[1];
    port = Number(match[2]);
  }

  return {
    host,
    port,
    label: host ? `${host}:${port}` : "not configured",
    configured: Boolean(host),
  };
}

function resolveUsername(cfg = config, env = process.env) {
  return (env.MC_USERNAME || (cfg["bot-account"] && cfg["bot-account"].username) || "AFKBot").trim();
}

function botAuthType(cfg = config) {
  return (cfg["bot-account"] && cfg["bot-account"].type) || "offline";
}

// ============================================================================
//  RUNTIME ENVIRONMENT DETECTION (serverless / proxy)
// ============================================================================

const SERVERLESS_MARKERS = [
  ["VERCEL", "vercel"],
  ["AWS_LAMBDA_FUNCTION_NAME", "lambda"],
  ["LAMBDA_TASK_ROOT", "lambda"],
  ["NETLIFY", "netlify"],
  ["CF_PAGES", "cloudflare-pages"],
];

/**
 * Detect a serverless runtime. A serverless function cannot hold a
 * Minecraft TCP session open, so we must not pretend a bot is running.
 */
function detectServerless(env = process.env) {
  let platform = null;
  for (const [key, name] of SERVERLESS_MARKERS) {
    const value = env[key];
    if (value !== undefined && value !== null && String(value).trim() !== "" && String(value) !== "0") {
      platform = name;
      break;
    }
  }
  // VERCEL="0" or similar is treated as "not set"
  return { serverless: Boolean(platform), platform, reason: platform ? `${platform} runtime detected` : null };
}

/** Validate a backend URL; only http/https are proxied. */
function validateBackendUrl(raw) {
  if (!raw || String(raw).trim() === "") {
    return { ok: false, backend: null, error: "BOT_BACKEND_URL is empty" };
  }
  const value = String(raw).trim().replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(value);
  } catch (err) {
    return { ok: false, backend: null, error: `BOT_BACKEND_URL is not a valid URL: ${err.message}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, backend: null, error: "BOT_BACKEND_URL must start with http:// or https://" };
  }
  return { ok: true, backend: `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`, error: null };
}

/** Proxy mode: every request is forwarded to an always-on bot. */
function detectProxyMode(env = process.env) {
  const raw = (env.BOT_BACKEND_URL || "").trim();
  if (!raw) return { proxy: false, backend: null, error: null };
  const result = validateBackendUrl(raw);
  return { proxy: result.ok, backend: result.backend, error: result.error };
}

/**
 * Decide what this process is allowed to do.
 *
 *   proxy mode      -> forward everything to BOT_BACKEND_URL, run no bot
 *   serverless      -> serve an honest banner, run no bot
 *   local           -> run the bot normally
 */
function resolveRunMode(env = process.env) {
  const proxy = detectProxyMode(env);
  if (proxy.proxy) {
    return {
      mode: "proxy",
      canRunBot: false,
      proxy,
      serverless: detectServerless(env),
      reason: `proxying every request to ${proxy.backend}`,
    };
  }
  const serverless = detectServerless(env);
  if (serverless.serverless) {
    return {
      mode: "serverless",
      canRunBot: false,
      proxy,
      serverless,
      reason: `${serverless.platform} functions cannot hold a Minecraft session`,
    };
  }
  return {
    mode: "local",
    canRunBot: true,
    proxy,
    serverless,
    reason: null,
  };
}

// ============================================================================
//  SMALL UTILITIES
// ============================================================================

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** 3600 -> "1h 0m 0s" */
function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/** 90000 -> "90s", 754000 -> "12m 34s" — compact, human readable. */
function formatMs(ms) {
  const seconds = Math.round((Number(ms) || 0) / 1000);
  return formatDuration(seconds);
}

function isoTime(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return null;
  return new Date(value).toISOString();
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_err) {
    return "{}";
  }
}

// ============================================================================
//  RECONNECT MATH (pure, unit-tested)
// ============================================================================

const DEFAULT_FORCE_LOGIN_PROBES = 6;
const DUPLICATE_LOGIN_MIN_MS = 120000;
const DUPLICATE_LOGIN_MAX_MS = 180000;

/**
 * Exponential backoff with jitter, hard-capped by max-reconnect-delay.
 * attempt 1 -> base, attempt 2 -> 2*base ... never above maxDelay.
 */
function computeBackoff(attempt, baseDelay, maxDelay, options = {}) {
  const base = Math.max(1, Number(baseDelay) || 2000);
  const cap = Math.max(base, Number(maxDelay) || 120000);
  const n = Math.max(0, Math.floor(Number(attempt) || 0));
  const raw = base * Math.pow(2, Math.max(0, n - 1));
  const bounded = Math.min(raw, cap);
  const jitterRatio = typeof options.jitterRatio === "number" ? options.jitterRatio : 0.2;
  const rand = typeof options.random === "function" ? options.random : Math.random;
  const jitter = bounded * jitterRatio * rand();
  return Math.round(clamp(bounded + jitter, 1, cap));
}

/** Duplicate-login kick -> 120–180s (never a tight loop). */
function computeDuplicateLoginDelay(options = {}) {
  const min = Number(options.min) || DUPLICATE_LOGIN_MIN_MS;
  const max = Number(options.max) || DUPLICATE_LOGIN_MAX_MS;
  const rand = typeof options.random === "function" ? options.random : Math.random;
  const span = Math.max(0, max - min);
  return Math.round(min + rand() * span);
}

/** Should we stop trusting the probe and log in anyway? */
function shouldForceLogin(notReadyProbes, limit = DEFAULT_FORCE_LOGIN_PROBES) {
  const threshold = Number(limit) > 0 ? Number(limit) : DEFAULT_FORCE_LOGIN_PROBES;
  return Number(notReadyProbes) >= threshold;
}

/**
 * A probe is "ready" only when it honestly answered a status ping.
 * `ambiguous` (port open, no status reply) means "booting", not "up".
 */
function isProbeReady(probe) {
  if (!probe || typeof probe !== "object") return false;
  return probe.status === "online" && probe.online === true && probe.ambiguous !== true;
}

// ============================================================================
//  KICK / POLICY CLASSIFICATION (pure, unit-tested)
// ============================================================================

/** Flatten a mineflayer kick reason (string, JSON, or chat component). */
function flattenKickReason(reason) {
  if (reason === null || reason === undefined) return "";
  if (typeof reason === "string") {
    const trimmed = reason.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return flattenKickReason(JSON.parse(trimmed));
      } catch (_err) {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (typeof reason === "object") {
    if (typeof reason.value === "string" && reason.value.trim() !== "") {
      return reason.value;
    }
    let text = "";
    if (typeof reason.text === "string") text += reason.text;
    if (typeof reason.translate === "string") text += ` ${reason.translate}`;
    if (typeof reason.reason === "string") text += ` ${reason.reason}`;
    if (Array.isArray(reason.with)) text += ` ${reason.with.map(flattenKickReason).join(" ")}`;
    if (Array.isArray(reason.extra)) text += ` ${reason.extra.map(flattenKickReason).join(" ")}`;
    if (text.trim() !== "") return text.trim();
    try {
      return JSON.stringify(reason);
    } catch (_err) {
      return String(reason);
    }
  }
  return String(reason);
}

const DUPLICATE_LOGIN_PATTERNS = [
  /duplicate[ _-]?login/i,
  /already (?:logged|connected)/i,
  /you are already playing/i,
  /logged in from another location/i,
  /another player (?:is )?using (?:that|this) (?:username|name)/i,
  /kicked for (?:spam|flying)? ?.*duplicate/i,
];

function isDuplicateLoginKick(reason) {
  const text = flattenKickReason(reason);
  if (!text) return false;
  return DUPLICATE_LOGIN_PATTERNS.some((pattern) => pattern.test(text));
}

const THROTTLE_PATTERNS = [
  /throttl/i,
  /wait before (?:you )?(?:re)?connect/i,
  /too (?:fast|many)/i,
  /slow down/i,
];

function isThrottleKick(reason) {
  const text = flattenKickReason(reason);
  if (!text) return false;
  return THROTTLE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Policy bans. This is the one class of disconnect we must never
 * retry: Aternos suspends accounts for automation / idling, and a
 * reconnect loop would turn a warning into a permanent ban.
 */
const POLICY_PATTERNS = [
  { id: "banned", label: "account banned", pattern: /banned\.reason/i },
  { id: "banned", label: "account banned", pattern: /\byou (?:have been|are|were) banned\b/i },
  { id: "idle", label: "kicked for being idle", pattern: /idle for too long/i },
  { id: "tos", label: "terms of service violation", pattern: /terms of service/i },
  { id: "tos", label: "terms of service violation", pattern: /\btos\b violation/i },
  { id: "automation", label: "automation detected", pattern: /(?:automation|automatic(?:ally)? (?:bot|afk)|botting)/i },
];

/**
 * @returns {{blocked:boolean, category:string|null, reason:string|null, raw:string}}
 */
function detectPolicyBan(reason) {
  const raw = flattenKickReason(reason);
  if (!raw) return { blocked: false, category: null, reason: null, raw: "" };
  for (const entry of POLICY_PATTERNS) {
    if (entry.pattern.test(raw)) {
      return { blocked: true, category: entry.id, reason: entry.label, raw };
    }
  }
  return { blocked: false, category: null, reason: null, raw };
}

/** Explain why the bot is where it is, in one short line. */
function describeStatus(status, state) {
  const s = state || {};
  switch (status) {
    case "connected":
      return s.serverLabel ? `Playing on ${s.serverLabel}` : "Connected";
    case "connecting":
      return s.statusDetail || "Logging in…";
    case "probing":
      return s.statusDetail || "Waiting for the server to answer";
    case "disconnected":
      return s.lastDisconnectReason || "Disconnected — retrying";
    case "stopped":
      return s.statusDetail || "Stopped";
    case "policy-blocked":
      return s.policyReason || "Paused after a policy block";
    default:
      return "Starting up";
  }
}

// ============================================================================
//  SINGLE-INSTANCE LEASE
//
//  Two copies of the bot using the same Minecraft username is the
//  fastest way to look like a bot farm: each login kicks the other,
//  forever. The lease is a small JSON file in /tmp with a 60s TTL,
//  refreshed every 20s. If the file is missing, stale, or owned by
//  a dead pid on this host, we take it over.
//
//  BOT_LEASE_DIR overrides the directory (multi-worker hosts).
// ============================================================================

const LEASE_TTL_MS = 60_000;
const LEASE_RENEW_MS = 20_000;

function sanitiseLeaseName(value) {
  return String(value || "bot").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
}

function resolveLeaseDir(env = process.env) {
  const raw = (env.BOT_LEASE_DIR || "").trim();
  return raw || os.tmpdir();
}

function resolveLeaseFile(options = {}) {
  const env = options.env || process.env;
  const dir = options.dir || resolveLeaseDir(env);
  const username = options.username || "bot";
  return path.join(dir, `minecraft-afk-bot-${sanitiseLeaseName(username)}.lease`);
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) return false;
  if (n === process.pid) return true;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err && err.code === "EPERM";
  }
}

function readLease(file) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return null;
    return parsed;
  } catch (_err) {
    return null;
  }
}

/** A lease is stale when it is unreadable, expired, or its owner is gone. */
function isLeaseStale(record, options = {}) {
  if (!record) return true;
  const now = Number(options.now) || Date.now();
  const ttl = Number(options.ttlMs) || LEASE_TTL_MS;
  const renewedAt = Number(record.renewedAt || record.startedAt || 0);
  if (!Number.isFinite(renewedAt) || renewedAt <= 0) return true;
  if (now - renewedAt > ttl) return true;
  const sameHost = record.hostname === (options.hostname || os.hostname());
  if (sameHost && record.pid && !pidAlive(record.pid)) return true;
  return false;
}

function buildLeaseRecord(options = {}) {
  const now = Number(options.now) || Date.now();
  return {
    pid: process.pid,
    hostname: os.hostname(),
    username: options.username || "bot",
    token: options.token || `${process.pid}-${now}-${Math.random().toString(36).slice(2, 10)}`,
    startedAt: Number(options.startedAt) || now,
    renewedAt: now,
  };
}

function writeLease(file, record) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record), "utf8");
    fs.renameSync(tmp, file);
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Try to take the single-instance lease.
 *
 * @returns {{acquired:boolean, file:string, record:object|null,
 *            owner:object|null, reason:string, tookOver:boolean}}
 */
function acquireLease(options = {}) {
  const now = Number(options.now) || Date.now();
  const ttlMs = Number(options.ttlMs) || LEASE_TTL_MS;
  const file = options.file || resolveLeaseFile(options);
  const hostname = os.hostname();
  const existing = readLease(file);

  const selfSamePid =
    existing && existing.pid === process.pid && existing.hostname === hostname;

  if (existing && !selfSamePid && !isLeaseStale(existing, { now, ttlMs, hostname })) {
    return {
      acquired: false,
      file,
      record: null,
      owner: existing,
      reason: `already held by pid ${existing.pid} on ${existing.hostname}`,
      tookOver: false,
    };
  }

  const tookOver = Boolean(existing && !selfSamePid);
  const record = existing && selfSamePid
    ? { ...existing, renewedAt: now }
    : buildLeaseRecord({ now, username: options.username, startedAt: now });

  const write = writeLease(file, record);
  if (!write.ok) {
    return {
      acquired: false,
      file,
      record: null,
      owner: null,
      reason: `could not write lease: ${write.error}`,
      tookOver: false,
    };
  }

  return {
    acquired: true,
    file,
    record,
    owner: null,
    reason: tookOver ? "took over a stale lease" : "acquired",
    tookOver,
  };
}

function renewLease(file, record, options = {}) {
  if (!record) return { ok: false, error: "no lease record" };
  const now = Number(options.now) || Date.now();
  const next = { ...record, renewedAt: now };
  const write = writeLease(file, next);
  return { ok: write.ok, error: write.error, record: write.ok ? next : record };
}

function releaseLease(file, record) {
  const current = readLease(file);
  if (!current) return { ok: true, removed: false };
  if (record && current.token && record.token && current.token !== record.token) {
    return { ok: false, removed: false, error: "lease owned by another instance" };
  }
  try {
    fs.unlinkSync(file);
    return { ok: true, removed: true };
  } catch (err) {
    return { ok: false, removed: false, error: err.message };
  }
}

// ============================================================================
//  HTTP HELPERS (used for mirror failover, discord, keep-alive)
// ============================================================================

function httpJsonRequest(options = {}) {
  const {
    url,
    method = "GET",
    headers = {},
    body = null,
    timeoutMs = 10000,
  } = options;

  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      resolve({ ok: false, statusCode: 0, body: null, text: "", error: err.message });
      return;
    }

    const transport = parsed.protocol === "https:" ? https : http;
    const payload = body === null || body === undefined
      ? null
      : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));

    const requestHeaders = { Accept: "application/json", ...headers };
    if (payload) {
      requestHeaders["Content-Type"] = requestHeaders["Content-Type"] || "application/json";
      requestHeaders["Content-Length"] = payload.length;
    }

    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method,
        headers: requestHeaders,
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let json = null;
          if (text.trim() !== "") {
            try {
              json = JSON.parse(text);
            } catch (_err) {
              json = null;
            }
          }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            statusCode: res.statusCode,
            body: json,
            text,
            error: null,
          });
        });
        res.on("error", (err) => {
          resolve({ ok: false, statusCode: res.statusCode || 0, body: null, text: "", error: err.message });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });
    req.on("error", (err) => {
      resolve({ ok: false, statusCode: 0, body: null, text: "", error: err.message });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

// ============================================================================
//  CROSS-MACHINE MIRROR (BOT_MIRROR_URL)
//
//  A standby machine can watch the primary and take over when it
//  stops reporting. The primary POSTs a public-safe snapshot to
//  <mirror>/mirror/status every minute; the standby GETs it and can
//  decide to claim the lease + start its own bot.
// ============================================================================

const MIRROR_INTERVAL_MS = 60_000;

function resolveMirrorUrl(env = process.env) {
  const raw = (env.BOT_MIRROR_URL || "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin + parsed.pathname.replace(/\/+$/, "");
  } catch (_err) {
    return null;
  }
}

/** The snapshot another instance needs to decide about failover. */
function buildMirrorPayload(snapshot) {
  const s = snapshot || {};
  return {
    ok: true,
    role: "primary",
    version: VERSION,
    hostname: os.hostname(),
    pid: process.pid,
    username: s.username || null,
    status: s.status || "unknown",
    connected: Boolean(s.connected),
    sessionUptimeMs: Number(s.sessionUptimeMs) || 0,
    server: s.serverLabel || null,
    policyBlocked: Boolean(s.policyBlocked),
    reconnectAttempts: Number(s.reconnectAttempts) || 0,
    updatedAt: new Date().toISOString(),
  };
}

function normalizeMirrorPayload(payload) {
  if (!isPlainObject(payload)) {
    return { valid: false, error: "payload is not an object", data: null };
  }
  const updatedAt = payload.updatedAt || null;
  const ageMs = updatedAt ? Math.max(0, Date.now() - new Date(updatedAt).getTime()) : null;
  return {
    valid: true,
    error: null,
    data: {
      role: payload.role || "unknown",
      version: payload.version || null,
      hostname: payload.hostname || null,
      pid: payload.pid || null,
      username: payload.username || null,
      status: payload.status || "unknown",
      connected: Boolean(payload.connected),
      sessionUptimeMs: Number(payload.sessionUptimeMs) || 0,
      server: payload.server || null,
      policyBlocked: Boolean(payload.policyBlocked),
      reconnectAttempts: Number(payload.reconnectAttempts) || 0,
      updatedAt,
      ageMs: Number.isFinite(ageMs) ? ageMs : null,
    },
  };
}

async function pushMirrorStatus(mirrorUrl, payload, options = {}) {
  const url = String(mirrorUrl || "").replace(/\/+$/, "") + "/mirror/status";
  const result = await httpJsonRequest({
    url,
    method: "POST",
    body: payload,
    timeoutMs: options.timeoutMs || 8000,
  });
  return { ok: result.ok, statusCode: result.statusCode, error: result.error, response: result.body };
}

async function fetchMirrorStatus(mirrorUrl, options = {}) {
  const url = String(mirrorUrl || "").replace(/\/+$/, "") + "/mirror/status";
  const result = await httpJsonRequest({ url, method: "GET", timeoutMs: options.timeoutMs || 8000 });
  if (!result.ok) {
    return { ok: false, statusCode: result.statusCode, error: result.error || `HTTP ${result.statusCode}`, mirror: null };
  }
  const normalized = normalizeMirrorPayload(result.body);
  return {
    ok: normalized.valid,
    statusCode: result.statusCode,
    error: normalized.error,
    mirror: normalized.data,
  };
}

// ============================================================================
//  RUNTIME STATE
// ============================================================================

const runtime = {
  // operator intent: /stop sets this false, /start sets it true
  intent: "running", // "running" | "stopped"
  phase: "starting", // starting|probing|connecting|connected|disconnected|stopped|policy-blocked
  statusDetail: "Starting up",

  bot: null,
  spawnHandled: false,
  connectedAt: null,
  lastDisconnectAt: null,
  lastDisconnectReason: null,
  lastKickReason: null,

  reconnectAttempts: 0,
  notReadyProbes: 0,
  totalConnects: 0,
  totalDisconnects: 0,
  loginCount: 0,

  policyBlocked: false,
  policyReason: null,
  policyRaw: null,
  policyBlockedAt: null,
  policyCategory: null,

  forcedLogin: false,
  lastProbe: null,
  lastProbeAt: 0,
  lastError: null,

  startedAt: Date.now(),
  instanceId: `${os.hostname()}-${process.pid}`,

  simulation: false,
  lease: null,
  leaseHandle: null,

  // Set by the serverless entry point: this process serves the dashboard but
  // can never own a Minecraft session, so the phase must say so from request
  // one instead of claiming to be "starting".
  serverlessOnly: false,
};

// Single owners for every timer in the process.
const timers = {
  reconnect: null,
  leaseRenew: null,
  leaseWatch: null,
  mirrorPush: null,
  keepAlive: null,
  intervals: new Set(),
};

const providerCache = { at: 0, result: null, inFlight: null };
const probeCache = { at: 0, result: null, inFlight: null };

const env = process.env;
const serverTarget = resolveServerTarget(config, env);
const username = resolveUsername(config, env);
const serverlessInfo = detectServerless(env);
const proxyInfo = detectProxyMode(env);

const provider = providerModule.createProvider(config, env);

// ============================================================================
//  STATUS SNAPSHOT
//
//  `light` snapshots are public-safe: no coordinates, no player
//  names, no kick text — safe to expose on /status/light.
// ============================================================================

function sessionUptimeMs(now = Date.now()) {
  if (!runtime.connectedAt) return 0;
  return Math.max(0, now - runtime.connectedAt);
}

function botCoordinates() {
  const bot = runtime.bot;
  if (!bot || !bot.entity || !bot.entity.position) return null;
  const p = bot.entity.position;
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

function reconcilePhase() {
  if (runtime.policyBlocked) return "policy-blocked";
  if (runtime.intent === "stopped") return "stopped";
  // Nothing can be connected here and nothing is retrying: never report
  // "starting" / "connecting" from a process that has no bot.
  if (runtime.serverlessOnly) return "stopped";
  if (runtime.bot && runtime.spawnHandled) return "connected";
  // An environment-level stop (serverless / proxy) is terminal: never report it
  // as "disconnected and retrying" when nothing is retrying.
  if (runtime.phase === "stopped") return "stopped";
  // A cycle that is in flight (probing or logging in) owns the phase; there is
  // no reconnect timer at that moment and reporting "disconnected" would lie.
  if (runtime.phase === "probing" || runtime.phase === "connecting") return runtime.phase;
  if (timers.reconnect) {
    return runtime.lastProbe && !isProbeReady(runtime.lastProbe) ? "probing" : "connecting";
  }
  return runtime.phase === "starting" ? "starting" : "disconnected";
}

function publicState() {
  const phase = reconcilePhase();
  const now = Date.now();
  const coords = botCoordinates();
  const uptimeMs = sessionUptimeMs(now);
  const probe = runtime.lastProbe;

  const chat = chatState();
  const state = {
    version: VERSION,
    name: config.name || "AFK Bot",
    chat: {
      enabled: chat.enabled,
      every: chat.delay,
      messages: chat.messages.length,
      onlyWhenPlayersOnline: chat.onlyWithPlayers,
    },
    instanceId: runtime.instanceId,
    startedAt: runtime.startedAt,
    processUptimeMs: Math.max(0, now - runtime.startedAt),
    sessionUptimeMs: uptimeMs,
    phase,
    status: phase === "policy-blocked" ? "stopped" : phase,
    statusLabel:
      phase === "connected"
        ? "Connected"
        : phase === "stopped"
          ? "Stopped"
          : phase === "policy-blocked"
            ? "Stopped (policy block)"
            : "Disconnected",
    statusDetail: describeStatus(phase, {
      serverLabel: serverTarget.label,
      statusDetail: runtime.serverlessOnly
        ? "No bot can run in a serverless function — see the banner below"
        : runtime.statusDetail,
      lastDisconnectReason: runtime.lastDisconnectReason,
      policyReason: runtime.policyReason,
    }),
    connected: phase === "connected",
    botRunning: runtime.intent === "running" && !runtime.policyBlocked,
    stopped: runtime.intent === "stopped",
    reconnectAttempts: runtime.reconnectAttempts,
    notReadyProbes: runtime.notReadyProbes,
    forceLoginAfterProbes: forceLoginThreshold(),
    totalConnects: runtime.totalConnects,
    totalDisconnects: runtime.totalDisconnects,
    lastDisconnectAt: isoTime(runtime.lastDisconnectAt),
    lastDisconnectReason: runtime.lastDisconnectReason,
    lastError: runtime.lastError,
    coords,
    username,
    server: {
      host: serverTarget.host || null,
      port: serverTarget.port,
      label: serverTarget.label,
      configured: serverTarget.configured,
      motd: (probe && probe.motd) || null,
      versionName: (probe && probe.versionName) || null,
      players: probe && probe.players ? probe.players : null,
      probeStatus: probe ? probe.status : null,
      probeAmbiguous: probe ? Boolean(probe.ambiguous) : null,
      lastProbeAt: isoTime(runtime.lastProbeAt),
      latencyMs: probe ? probe.latencyMs : null,
    },
    policy: {
      blocked: runtime.policyBlocked,
      reason: runtime.policyReason,
      category: runtime.policyCategory,
      blockedAt: isoTime(runtime.policyBlockedAt),
    },
    // Read live: a deployment marker can be set after this module loads
    // (and tests flip it), and the dashboard must never state a stale mode.
    environment: (() => {
      const serverlessNow = detectServerless(env);
      const proxyNow = detectProxyMode(env);
      return {
        serverless: serverlessNow.serverless,
        platform: serverlessNow.platform,
        proxy: proxyNow.proxy,
        backend: proxyNow.backend,
        backendError: proxyNow.error || runtime.backendError || null,
        node: process.version,
        hostname: os.hostname(),
      };
    })(),
    lease: runtime.lease
      ? {
          file: runtime.lease.file,
          acquired: runtime.lease.acquired,
          owner: runtime.lease.owner
            ? { pid: runtime.lease.owner.pid, hostname: runtime.lease.owner.hostname }
            : null,
          reason: runtime.lease.reason,
        }
      : null,
    mirror: {
      configured: Boolean(resolveMirrorUrl(env)),
      url: resolveMirrorUrl(env),
    },
  };

  return state;
}

/** Public-safe subset for /status/light and iframe badges. */
function lightState() {
  const state = publicState();
  return {
    ok: true,
    version: state.version,
    status: state.status,
    statusLabel: state.statusLabel,
    statusDetail: state.connected ? "Playing" : state.statusDetail,
    connected: state.connected,
    sessionUptimeMs: state.sessionUptimeMs,
    sessionUptime: formatDuration(state.sessionUptimeMs / 1000),
    server: state.server.configured ? state.server.label : null,
    players:
      state.server.players && state.server.players.online !== null
        ? { online: state.server.players.online, max: state.server.players.max }
        : null,
    policyBlocked: state.policy.blocked,
    updatedAt: new Date().toISOString(),
  };
}

function forceLoginThreshold() {
  return configNumber("utils", "force-login-after-probes", DEFAULT_FORCE_LOGIN_PROBES);
}

// ============================================================================
//  PROBING (cached, single-flight)
// ============================================================================

function probeTimeoutMs() {
  return configNumber("utils", "probe-timeout", 6000);
}

async function runProbe(options = {}) {
  const now = Date.now();
  const cacheMs = configNumber("utils", "probe-cache-ms", 5000);
  const fresh = options.cache !== false && probeCache.result && now - probeCache.at < cacheMs;
  if (fresh) return probeCache.result;

  if (probeCache.inFlight) return probeCache.inFlight;

  if (!serverTarget.configured) {
    const result = {
      host: null,
      port: serverTarget.port,
      status: "error",
      online: false,
      ambiguous: false,
      error: "no server address configured",
      checkedAt: now,
      latencyMs: 0,
      players: null,
    };
    runtime.lastProbe = result;
    runtime.lastProbeAt = now;
    return result;
  }

  probeCache.inFlight = probeModule
    .probeServer({
      host: serverTarget.host,
      port: serverTarget.port,
      timeoutMs: probeTimeoutMs(),
    })
    .then((result) => {
      probeCache.result = result;
      probeCache.at = Date.now();
      runtime.lastProbe = result;
      runtime.lastProbeAt = probeCache.at;
      return result;
    })
    .catch((err) => {
      const result = {
        host: serverTarget.host,
        port: serverTarget.port,
        status: "error",
        online: false,
        ambiguous: false,
        error: err.message,
        checkedAt: Date.now(),
        latencyMs: 0,
        players: null,
      };
      runtime.lastProbe = result;
      runtime.lastProbeAt = Date.now();
      return result;
    })
    .finally(() => {
      probeCache.inFlight = null;
    });

  return probeCache.inFlight;
}

function describeProbe(result) {
  if (!result) return "no probe yet";
  if (result.status === "online" && result.ambiguous) {
    return "port open, no status reply (server still booting)";
  }
  if (result.status === "online") {
    const online = result.players && result.players.online;
    return online === null || online === undefined ? "online" : `online — ${online} player(s)`;
  }
  return `${result.status}${result.error ? ` (${result.error})` : ""}`;
}

// ============================================================================
//  PROVIDER STATUS (cached)
// ============================================================================

async function getProviderStatus(options = {}) {
  const cacheMs = configNumber("provider", "status-cache-ms", 15000);
  const now = Date.now();
  if (!options.force && providerCache.result && now - providerCache.at < cacheMs) {
    return providerCache.result;
  }
  if (providerCache.inFlight) return providerCache.inFlight;

  providerCache.inFlight = provider
    .getStatus()
    .then((result) => {
      providerCache.result = result;
      providerCache.at = Date.now();
      return result;
    })
    .catch((err) => {
      const result = {
        ok: false,
        configured: provider.configured,
        error: err.message,
        server: null,
        address: provider.address,
      };
      providerCache.result = result;
      providerCache.at = Date.now();
      return result;
    })
    .finally(() => {
      providerCache.inFlight = null;
    });

  return providerCache.inFlight;
}

// ============================================================================
//  DISCORD WEBHOOK (optional, rate limited)
// ============================================================================

let lastDiscordSendAt = 0;

function sendDiscordWebhook(content, color = 0x0099ff) {
  const discord = config.discord || {};
  if (!discord.enabled || !discord.webhookUrl || discord.webhookUrl.includes("YOUR_DISCORD")) return;
  const now = Date.now();
  if (now - lastDiscordSendAt < 5000) return;
  lastDiscordSendAt = now;

  const payload = {
    username: config.name || "AFK Bot",
    embeds: [
      {
        description: String(content).slice(0, 1900),
        color,
        timestamp: new Date().toISOString(),
        footer: { text: `minecraft-afk-bot v${VERSION}` },
      },
    ],
  };

  httpJsonRequest({
    url: discord.webhookUrl,
    method: "POST",
    body: payload,
    timeoutMs: 8000,
  }).then((result) => {
    if (!result.ok) addLog(`[Discord] Webhook failed: ${result.error || result.statusCode}`);
  });
}

function discordEvent(name) {
  const events = (config.discord && config.discord.events) || {};
  return Boolean(config.discord && config.discord.enabled && events[name]);
}

// ============================================================================
//  BOT LIFECYCLE
//
//  Exactly one scheduler owns reconnects. Anything that wants a
//  reconnect (socket end, watchdog, dashboard) calls
//  scheduleReconnect() and the scheduler decides *when*.
// ============================================================================

const botIntervals = new Set();
let shuttingDown = false;
let schedulerReason = null;
let watchdog = null;

function addBotInterval(fn, delay) {
  const id = setInterval(fn, delay);
  botIntervals.add(id);
  return id;
}

function clearBotIntervals() {
  for (const id of botIntervals) clearInterval(id);
  if (botIntervals.size > 0) addLog(`[Cleanup] Cleared ${botIntervals.size} bot interval(s)`);
  botIntervals.clear();
}

function baseReconnectDelay() {
  return configNumber("utils", "auto-reconnect-delay", 2000);
}

function maxReconnectDelay() {
  return configNumber("utils", "max-reconnect-delay", 120000);
}

function setPhase(phase, detail) {
  runtime.phase = phase;
  if (detail !== undefined) runtime.statusDetail = detail;
}

/** Load mineflayer lazily: a broken optional module must not kill the app. */
function loadMineflayer() {
  if (loadMineflayer._cached !== undefined) return loadMineflayer._cached;
  try {
    // eslint-disable-next-line global-require
    loadMineflayer._cached = { mineflayer: require("mineflayer"), error: null };
  } catch (err) {
    loadMineflayer._cached = { mineflayer: null, error: err };
  }
  return loadMineflayer._cached;
}

function loadPathfinder() {
  if (loadPathfinder._cached !== undefined) return loadPathfinder._cached;
  try {
    // eslint-disable-next-line global-require
    const mod = require("mineflayer-pathfinder");
    loadPathfinder._cached = { mod, error: null };
  } catch (err) {
    loadPathfinder._cached = { mod: null, error: err };
  }
  return loadPathfinder._cached;
}

function destroyBot(reason = "teardown") {
  const bot = runtime.bot;
  runtime.bot = null;
  runtime.spawnHandled = false;
  runtime.connectedAt = null;
  clearBotIntervals();
  if (watchdog) watchdog.stop();
  if (!bot) return;

  try {
    bot.removeAllListeners();
  } catch (_err) {
    /* ignore */
  }
  try {
    bot.end(reason);
  } catch (_err) {
    try {
      bot.quit(reason);
    } catch (_err2) {
      /* ignore */
    }
  }
}

/**
 * The single reconnect scheduler.
 *
 * @param {string} reason  why we are reconnecting (logged)
 * @param {object} [options]
 * @param {number} [options.delayMs]      explicit delay (dup-login etc.)
 * @param {boolean} [options.probeFirst]  skip the probe and go straight in
 * @returns {number|null} the chosen delay, or null when suppressed
 */
function scheduleReconnect(reason, options = {}) {
  if (shuttingDown) return null;
  if (runtime.intent === "stopped") {
    addLog("[Bot] Reconnect skipped — bot is stopped");
    return null;
  }
  if (runtime.policyBlocked) {
    addLog("[Bot] Reconnect skipped — policy block is active (use /start to retry explicitly)");
    return null;
  }
  if (timers.reconnect) {
    addLog(`[Bot] Reconnect already scheduled (${schedulerReason}) — ignoring "${reason}"`);
    return null;
  }

  runtime.reconnectAttempts += 1;
  const attempt = runtime.reconnectAttempts;
  const delay = Number.isFinite(options.delayMs) && options.delayMs >= 0
    ? Math.round(options.delayMs)
    : computeBackoff(attempt, baseReconnectDelay(), maxReconnectDelay());

  schedulerReason = reason;
  const seconds = Math.max(0, Math.round(delay / 1000));
  addLog(`[Bot] Reconnect scheduled in ${seconds}s (reason: ${reason}, attempt ${attempt})`);

  if (runtime.intent === "running") setPhase("disconnected", `Reconnecting in ${seconds}s (${reason})`);

  timers.reconnect = setTimeout(() => {
    timers.reconnect = null;
    schedulerReason = null;
    runCycle(options.forceLogin === true).catch((err) => {
      addLog(`[Bot] Cycle error: ${err && err.message ? err.message : err}`);
      scheduleReconnect("cycle-error");
    });
  }, delay);
  if (typeof timers.reconnect.unref === "function") timers.reconnect.unref();

  return delay;
}

/**
 * One connection attempt: probe first, then log in.
 *
 * Probes are advisory. Aternos' proxy opens the port long before the
 * world is ready, so when the probe never says "ready" we still force
 * a real login after N not-ready probes instead of probing forever.
 */
let cycleToken = 0;

async function runCycle(forceLogin = false) {
  if (shuttingDown) return;

  // Only the newest cycle may act. Two overlapping cycles (a dashboard click
  // landing mid-probe) must not create two bots.
  const myToken = (cycleToken += 1);
  const stale = () => myToken !== cycleToken;
  if (runtime.intent === "stopped") {
    setPhase("stopped", "Stopped by operator");
    return;
  }
  if (runtime.policyBlocked) {
    setPhase("policy-blocked", runtime.policyReason);
    return;
  }

  // Serverless functions and pure proxies must never pretend to run a bot.
  const runMode = resolveRunMode(env);
  if (!runMode.canRunBot) {
    setPhase(
      runMode.mode === "proxy" ? "stopped" : "stopped",
      runMode.mode === "proxy"
        ? "Proxy mode — the always-on instance runs the bot"
        : `Serverless runtime (${runMode.serverless.platform}) — no bot can run here`,
    );
    return;
  }

  setPhase("probing", "Checking if the server is reachable…");
  const probe = await runProbe({ cache: false });

  if (stale()) return;
  if (shuttingDown || runtime.intent === "stopped" || runtime.policyBlocked) return;

  const ready = isProbeReady(probe);
  if (!ready) runtime.notReadyProbes += 1;

  const forceAfter = forceLoginThreshold();
  const force = forceLogin || shouldForceLogin(runtime.notReadyProbes, forceAfter);

  if (!ready && !force) {
    addLog(
      `[Probe] Not ready (${describeProbe(probe)}) — probe ${runtime.notReadyProbes}/${forceAfter} before forcing a login`,
    );
    setPhase("probing", `Waiting for server — probe ${runtime.notReadyProbes}/${forceAfter}`);
    scheduleReconnect("probe-not-ready", { probeFirst: true });
    return;
  }

  if (!ready && force) {
    runtime.forcedLogin = true;
    addLog(
      `[Probe] Probes never confirmed readiness (${describeProbe(probe)}) — forcing a real login after ${runtime.notReadyProbes} probe(s), as designed`,
    );
  }

  runtime.notReadyProbes = 0;
  setPhase("connecting", "Logging in…");
  connectBot();
}

/** Create the mineflayer bot and wire it to the scheduler. */
function connectBot() {
  if (shuttingDown) return;

  // Never run two bots: tear down anything still hanging around.
  if (runtime.bot) destroyBot("replace");

  if (!serverTarget.configured) {
    runtime.lastError = "no server address configured";
    addLog("[Bot] No server address configured — set server.ip in settings.json or MC_SERVER_HOST");
    setPhase("disconnected", "No server configured");
    return;
  }

  const { mineflayer, error } = loadMineflayer();
  if (!mineflayer) {
    runtime.lastError = error ? error.message : "mineflayer unavailable";
    addLog(`[Bot] mineflayer could not be loaded: ${runtime.lastError}`);
    setPhase("disconnected", "mineflayer failed to load");
    scheduleReconnect("mineflayer-missing");
    return;
  }

  // --- WATCHDOG FIRST -------------------------------------------------
  // The watchdog is armed *before* the bot exists and before any
  // module code runs, so a throwing module can never leave a session
  // with no supervisor.
  const watchdogConfig = watcherModule.resolveWatchdogConfig(config.utils);
  watchdog = watcherModule.createWatchdog({
    config: watchdogConfig,
    log: addLog,
    onSpawnTimeout: (info) => {
      addLog(`[Watchdog] Giving up on this attempt after ${formatMs(info.waitedMs)} without spawn`);
      runtime.lastDisconnectReason = "spawn timeout";
      destroyBot("spawn-timeout");
      scheduleReconnect("watchdog-spawn-timeout");
    },
    onSilence: (info) => {
      addLog(
        `[Watchdog] Reconnecting after ${formatMs(info.silentMs)} of socket silence ` +
          `(tcp: ${socketStateOf(runtime.bot)}, phase: ${runtime.phase})`,
      );
      runtime.lastDisconnectReason = "socket silence";
      destroyBot("silence-timeout");
      scheduleReconnect("watchdog-silence");
    },
    onStall: (info) => {
      addLog(`[Watchdog] No movement for ${formatMs(info.stalledMs)} — nudging the bot`);
      nudgeBot();
    },
    onStallExpired: (info) => {
      addLog(`[Watchdog] Nudge did not help (${formatMs(info.stalledMs)} still) — reconnecting`);
      runtime.lastDisconnectReason = "movement stall";
      destroyBot("stall");
      scheduleReconnect("watchdog-stall");
    },
  });
  watchdog.start();

  runtime.spawnHandled = false;
  const socketOptions = {
    username,
    host: serverTarget.host,
    port: serverTarget.port,
    version: config.server && config.server.version ? config.server.version : false,
    auth: botAuthType(config),
    hideErrors: true,
    checkTimeoutInterval: Math.max(60000, watchdogConfig.silenceTimeout),
  };
  const password = (env.MC_PASSWORD || (config["bot-account"] && config["bot-account"].password) || "").trim();
  if (password) socketOptions.password = password;

  let bot;
  try {
    bot = mineflayer.createBot(socketOptions);
  } catch (err) {
    runtime.lastError = err.message;
    addLog(`[Bot] createBot() threw: ${err.message}`);
    if (watchdog) watchdog.stop();
    setPhase("disconnected", "Could not create the bot");
    scheduleReconnect("createbot-threw");
    return;
  }

  runtime.bot = bot;
  runtime.loginCount += 1;
  addLog(`[Bot] Login attempt #${runtime.loginCount} -> ${serverTarget.label} as ${username}`);

  // --- pathfinder is optional -----------------------------------------
  const pf = loadPathfinder();
  if (pf.mod) {
    try {
      bot.loadPlugin(pf.mod.pathfinder);
    } catch (err) {
      addLog(`[Bot] pathfinder plugin failed to load: ${err.message}`);
    }
  } else if (pf.error) {
    addLog(`[Bot] pathfinder unavailable: ${pf.error.message}`);
  }

  wireBotEvents(bot);
}

/**
 * Feed every "the server is still talking to us" signal into a watchdog.
 *
 * The raw socket is the most direct one, but it is not the only one and it is
 * not reliable across versions: mineflayer does not promise that `socket` is
 * emitted before the bot starts reading, and on some runtimes the event never
 * reaches us at all. When that happened the watchdog saw *no traffic* on a
 * perfectly healthy session and reconnected every 90s — the "socket silent for
 * 92s" loop.
 *
 * So: raw bytes, plus every parsed packet off `bot._client`, plus chat. Any one
 * of them arriving is proof the connection is alive.
 *
 * @returns {function} detach every listener it attached
 */
function attachLivenessSources(bot, wd) {
  const note = () => {
    if (wd) wd.noteData();
  };
  const detach = [];

  if (!bot) return () => {};

  // 1. raw bytes (cheapest, and the earliest possible signal)
  try {
    bot.on("socket", (socket) => {
      try {
        socket.on("data", note);
        detach.push(() => socket.removeListener("data", note));
      } catch (_err) {
        /* ignore */
      }
    });
  } catch (_err) {
    /* ignore */
  }

  // 2. parsed packets — fires for every inbound packet, keepalives included,
  //    and does not depend on when `socket` is emitted.
  try {
    const client = bot._client;
    if (client && typeof client.on === "function") {
      client.on("packet", note);
      detach.push(() => client.removeListener("packet", note));
    }
  } catch (_err) {
    /* ignore */
  }

  // 3. chat / system messages
  try {
    bot.on("messagestr", note);
    detach.push(() => bot.removeListener("messagestr", note));
  } catch (_err) {
    /* ignore */
  }

  return () => {
    for (const fn of detach) {
      try {
        fn();
      } catch (_err) {
        /* ignore */
      }
    }
  };
}

/** Socket state for the log line, so a silence report says more than "silent". */
function socketStateOf(bot) {
  try {
    const socket = bot && bot._client && bot._client.socket;
    return socket && socket.readyState ? String(socket.readyState) : "none";
  } catch (_err) {
    return "unknown";
  }
}

function wireBotEvents(bot) {
  const note = () => {
    if (watchdog) watchdog.noteData();
    if (watchdog) watchdog.noteMovement();
  };

  attachLivenessSources(bot, watchdog);

  bot.on("spawn", () => {
    if (bot !== runtime.bot || runtime.spawnHandled) return;
    runtime.spawnHandled = true;
    runtime.connectedAt = Date.now();
    runtime.totalConnects += 1;
    runtime.reconnectAttempts = 0;
    runtime.notReadyProbes = 0;
    runtime.lastDisconnectReason = null;
    runtime.lastError = null;
    setPhase("connected", `Playing on ${serverTarget.label}`);
    addLog(`[Bot] Spawned in ${serverTarget.label} (version ${bot.version || "?"})`);
    if (watchdog) watchdog.noteSpawn();

    if (discordEvent("connect")) {
      sendDiscordWebhook(`✅ **Connected** to \`${serverTarget.label}\``, 0x3fb950);
    }

    // ---- MODULE INIT ---------------------------------------------------
    // Everything below runs inside a try/catch. A bad settings value or
    // a module API mismatch must degrade the bot, not kill the session.
    let mcData = null;
    try {
      // eslint-disable-next-line global-require
      mcData = require("minecraft-data")(bot.version);
    } catch (err) {
      addLog(`[Modules] minecraft-data unavailable for ${bot.version}: ${err.message}`);
    }
    try {
      initializeModules(bot, mcData);
    } catch (err) {
      addLog(`[Modules] Initialization failed (session continues): ${err.message}`);
    }

    if (config.server && config.server["try-creative"]) {
      setTimeout(() => {
        try {
          if (runtime.bot === bot && runtime.spawnHandled) bot.chat("/gamemode creative");
        } catch (_err) {
          /* ignore */
        }
      }, 3000);
    }
  });

  bot.on("physicsTick", () => {
    if (watchdog && bot.entity && bot.entity.position) {
      watchdog.notePosition(bot.entity.position);
    }
  });

  bot.on("move", () => {
    if (watchdog) watchdog.noteMovement();
  });

  bot.on("kicked", (reason) => handleKick(reason));

  bot.on("end", (reason) => {
    if (bot !== runtime.bot) return; // stale event from a torn-down bot
    handleEnd(reason);
  });

  bot.on("error", (err) => {
    runtime.lastError = err && err.message ? err.message : String(err);
    addLog(`[Bot] Error: ${runtime.lastError}`);
    note();
  });

  bot.on("death", () => {
    if (watchdog) watchdog.noteMovement();
    addLog("[Bot] Died — respawning");
    setTimeout(() => {
      try {
        if (runtime.bot === bot) bot.chat("/respawn");
      } catch (_err) {
        /* ignore */
      }
    }, 1500).unref?.();
  });

  bot.on("messagestr", (message) => {
    if (watchdog) watchdog.noteData();
    if (config.utils["chat-log"] !== false) addLog(`[Chat] ${String(message).slice(0, 300)}`);
  });
}

/** Policy block + kick bookkeeping. `end` still owns the reconnect call. */
function handleKick(reason) {
  const text = flattenKickReason(reason);
  runtime.lastKickReason = text;
  runtime.lastDisconnectReason = text || "kicked";
  addLog(`[Bot] Kicked: ${text || "(no reason given)"}`);

  const policy = detectPolicyBan(text);
  if (policy.blocked) {
    applyPolicyBlock(policy);
    return;
  }

  if (isDuplicateLoginKick(text)) {
    // Someone else owns this username right now. Hammering the server
    // makes it worse, so wait a long, jittered 2–3 minutes.
    const delay = computeDuplicateLoginDelay({
      min: configNumber("utils", "duplicate-login-backoff-min", DUPLICATE_LOGIN_MIN_MS),
      max: configNumber("utils", "duplicate-login-backoff-max", DUPLICATE_LOGIN_MAX_MS),
    });
    addLog(`[Bot] Duplicate login detected — backing off ${formatMs(delay)} before retrying`);
    markStoppedByKick();
    destroyBot("duplicate-login");
    scheduleReconnect("duplicate-login", { delayMs: delay });
    return;
  }

  if (isThrottleKick(text)) {
    const delay = Math.max(computeBackoff(runtime.reconnectAttempts + 1, baseReconnectDelay(), maxReconnectDelay()), 60000);
    addLog(`[Bot] Throttle kick — using extended delay ${formatMs(delay)}`);
    markStoppedByKick();
    destroyBot("throttle");
    scheduleReconnect("throttle", { delayMs: delay });
  }
}

function markStoppedByKick() {
  runtime.totalDisconnects += 1;
  runtime.lastDisconnectAt = Date.now();
  runtime.connectedAt = null;
  runtime.spawnHandled = false;
  clearBotIntervals();
  if (watchdog) watchdog.stop();
}

/**
 * A policy block is a hard stop: no reconnects, no timers, banner on
 * the dashboard. /start is the only thing that clears it.
 */
function applyPolicyBlock(policy) {
  runtime.policyBlocked = true;
  runtime.policyReason = `${policy.reason} — automatic reconnects paused`;
  runtime.policyRaw = policy.raw;
  runtime.policyCategory = policy.category;
  runtime.policyBlockedAt = Date.now();
  runtime.totalDisconnects += 1;
  runtime.lastDisconnectAt = Date.now();
  runtime.connectedAt = null;
  runtime.spawnHandled = false;

  addLog("[POLICY] ============================================================");
  addLog(`[POLICY] Blocked by server policy: ${policy.reason}`);
  addLog(`[POLICY] Server said: ${String(policy.raw || "").slice(0, 400)}`);
  addLog("[POLICY] Automatic reconnects are PAUSED. Retrying would escalate this");
  addLog("[POLICY] into a permanent ban, so the bot stays down until you press Start.");
  addLog("[POLICY] ============================================================");

  if (timers.reconnect) {
    clearTimeout(timers.reconnect);
    timers.reconnect = null;
    schedulerReason = null;
  }
  destroyBot("policy-block");
  setPhase("policy-blocked", runtime.policyReason);

  if (discordEvent("disconnect")) {
    sendDiscordWebhook(`⛔ **Policy block**: ${policy.reason}`, 0xe3b341);
  }
}

function handleEnd(reason) {
  const text = flattenKickReason(reason);
  addLog(`[Bot] Disconnected (${text || "no reason given"})`);
  runtime.totalDisconnects += 1;
  runtime.lastDisconnectAt = Date.now();
  runtime.connectedAt = null;
  runtime.spawnHandled = false;
  clearBotIntervals();
  if (watchdog) watchdog.stop();

  if (text) runtime.lastDisconnectReason = text;

  if (discordEvent("disconnect")) {
    sendDiscordWebhook(`🔌 **Disconnected**: ${text || "unknown"}`, 0xf85149);
  }

  runtime.bot = null;

  if (runtime.policyBlocked) {
    setPhase("policy-blocked", runtime.policyReason);
    return;
  }
  if (runtime.intent === "stopped") {
    setPhase("stopped", "Stopped by operator");
    return;
  }

  setPhase("disconnected", text ? `Disconnected: ${text.slice(0, 120)}` : "Disconnected");
  scheduleReconnect(text ? `disconnected: ${text.slice(0, 60)}` : "disconnected");
}

/** Gentle activity so the server sees a live player. Never fake input. */
function nudgeBot() {
  const bot = runtime.bot;
  if (!bot) return;
  try {
    if (typeof bot.look === "function") {
      bot.look(Math.random() * Math.PI * 2, 0, true);
    }
    if (typeof bot.setControlState === "function") {
      bot.setControlState("jump", true);
      setTimeout(() => {
        try {
          bot.setControlState("jump", false);
        } catch (_err) {
          /* ignore */
        }
      }, 400).unref?.();
    }
    if (typeof bot.swingArm === "function") bot.swingArm();
    addLog("[Watchdog] Nudge sent (look / jump / swing)");
  } catch (err) {
    addLog(`[Watchdog] Nudge failed: ${err.message}`);
  }
}

// ============================================================================
//  MODULES
//
//  initializeModules() is called from inside the spawn handler's
//  try/catch. Each module is additionally wrapped so one failure does
//  not stop the others.
// ============================================================================

function guard(name, fn) {
  try {
    fn();
  } catch (err) {
    addLog(`[Modules] ${name} failed to initialize: ${err.message}`);
  }
}

function movementConfig() {
  return config.movement || {};
}

function circleWalkEnabled() {
  const movement = movementConfig();
  return Boolean(movement.enabled !== false && movement["circle-walk"] && movement["circle-walk"].enabled);
}

function initializeModules(bot, mcData) {
  addLog("[Modules] Initializing modules…");
  const movements = buildMovements(bot, mcData);

  guard("auto-auth", () => setupAutoAuth(bot));
  guard("chat-messages", () => setupChatMessages(bot));
  guard("anti-afk", () => setupAntiAfk(bot));
  guard("movement", () => setupMovement(bot, movements));
  guard("position", () => setupPosition(bot, movements));
  guard("leave-rejoin", () => setupLeaveRejoinModule(bot));
  guard("combat", () => setupCombat(bot, mcData));
  guard("beds", () => setupBeds(bot));
  guard("chat", () => setupChatResponder(bot));

  addLog(`[Modules] Ready (${botIntervals.size} interval(s) armed)`);
}

function buildMovements(bot, mcData) {
  const pf = loadPathfinder();
  if (!pf.mod || !mcData) return null;
  try {
    const { Movements } = pf.mod;
    const movements = new Movements(bot, mcData);
    movements.canDig = false;
    movements.allowFreeMotion = false;
    movements.liquidCost = 1000;
    movements.fallDamageCost = 1000;
    return movements;
  } catch (err) {
    addLog(`[Modules] Movements setup failed: ${err.message}`);
    return null;
  }
}

function setupAutoAuth(bot) {
  const authConfig = (config.utils && config.utils["auto-auth"]) || {};
  if (!authConfig.enabled) return;
  const password = (env.MC_AUTH_PASSWORD || authConfig.password || "").trim();
  if (!password) {
    addLog("[Auth] auto-auth is enabled but no password is set — skipping");
    return;
  }

  let handled = false;
  const tryAuth = (kind) => {
    if (handled || !runtime.connectedAt) return;
    handled = true;
    try {
      bot.chat(kind === "register" ? `/register ${password} ${password}` : `/login ${password}`);
      addLog(`[Auth] Sent /${kind}`);
    } catch (err) {
      addLog(`[Auth] Failed to send /${kind}: ${err.message}`);
    }
  };

  bot.on("messagestr", (message) => {
    if (handled) return;
    const text = String(message).toLowerCase();
    if (text.includes("/register") || text.includes("register ")) tryAuth("register");
    else if (text.includes("/login") || text.includes("login ")) tryAuth("login");
  });

  setTimeout(() => tryAuth("login"), 10000).unref?.();
}

/**
 * Gap until the next chat line, in ms: 60-140% of the configured delay.
 * A fixed timer is the most machine-looking thing a bot can do.
 */
function chatGapMs(baseMs, random = Math.random) {
  const base = Math.max(5000, Number(baseMs) || 0);
  return Math.round(base * (0.6 + random() * 0.8));
}

/** Random line, never the same one twice in a row while alternatives exist. */
function pickChatMessage(messages, last, random = Math.random) {
  const list = Array.isArray(messages) ? messages.filter(Boolean) : [];
  if (list.length === 0) return "";
  if (list.length === 1) return list[0];
  // Draw from everything except the previous line, so the guarantee does not
  // depend on the random source being well behaved.
  const pool = list.filter((message) => message !== last);
  const from = pool.length > 0 ? pool : list;
  return from[Math.floor(random() * from.length)];
}

let chatTimer = null;

/** The live chat settings, whatever the dashboard or console last said. */
function chatState() {
  const chat = (config.utils && config.utils["chat-messages"]) || {};
  const messages = Array.isArray(chat.messages) ? chat.messages.filter(Boolean) : [];
  return {
    enabled: chat.enabled === true,
    repeat: chat.repeat === true,
    delay: Number(chat["repeat-delay"]) || 120,
    onlyWithPlayers: chat["only-when-players-online"] === true,
    messages,
    timer: Boolean(chatTimer),
  };
}

/**
 * Turn automatic chat on or off while the bot is running.
 *
 * `enabled: false` is a hard stop: the timer is cleared, so not even the first
 * line after a reconnect goes out. Editing settings.json needs a restart; this
 * does not.
 */
function setChatEnabled(enabled, source = "console") {
  const chat = (config.utils = config.utils || {})["chat-messages"] || (config.utils["chat-messages"] = {});
  const want = Boolean(enabled);
  const messages = Array.isArray(chat.messages) ? chat.messages.filter(Boolean) : [];

  if (!want) {
    chat.enabled = false;
    if (chatTimer) {
      clearInterval(chatTimer);
      botIntervals.delete(chatTimer);
      chatTimer = null;
    }
    addLog("[Chat] Automated messages OFF — the bot will not say anything.");
    return { ok: true, enabled: false, msg: "Automated chat off. The bot is silent (it still plays and stays connected)." };
  }

  chat.enabled = true;
  if (messages.length === 0) {
    return { ok: false, enabled: true, msg: "Chat is enabled, but the message list in settings.json is empty, so nothing will be sent." };
  }
  if (!chatTimer && runtime.bot) {
    setupChatMessages(runtime.bot);
  }
  const detail = chat.repeat === true ? `one random line every ~${Number(chat["repeat-delay"]) || 120}s with jitter` : "one line after each join";
  addLog(`[Chat] Automated messages ON — ${detail}${source === "dashboard" ? " (dashboard)" : ""}.`);
  return {
    ok: true,
    enabled: true,
    msg: `Automated chat on: ${messages.length} message(s), ${detail}${chat["only-when-players-online"] === true ? ", only when someone else is online" : ""}.`,
  };
}

function setupChatMessages(bot) {
  const chatConfig = (config.utils && config.utils["chat-messages"]) || {};
  if (!chatConfig.enabled) return;
  const messages = Array.isArray(chatConfig.messages) ? chatConfig.messages.filter(Boolean) : [];
  if (messages.length === 0) return;
  const onlyWithPlayers = chatConfig["only-when-players-online"] === true;

  const someoneElseOnline = () => {
    if (!onlyWithPlayers) return true;
    try {
      if (!bot.players || typeof bot.players !== "object") return true;
      return Object.keys(bot.players).some((name) => name !== bot.username);
    } catch (_err) {
      return true;
    }
  };

  if (chatTimer) {
    clearInterval(chatTimer);
    botIntervals.delete(chatTimer);
    chatTimer = null;
  }

  if (chatConfig.repeat) {
    const base = Math.max(5000, Number(chatConfig["repeat-delay"] || 120) * 1000);
    // A perfectly periodic timer is the most machine-looking thing a bot can
    // do. Humans type at uneven intervals, so every gap is 60-140% of the
    // configured delay; the tick only exists to check whether it is time.
    const nextGap = () => chatGapMs(base);
    let nextAt = Date.now() + nextGap();
    let last = "";
    chatTimer = addBotInterval(() => {
      if (!runtime.connectedAt) return;
      if (!config.utils["chat-messages"].enabled) return;
      if (Date.now() < nextAt) return;
      nextAt = Date.now() + nextGap();
      if (!someoneElseOnline()) return;
      try {
        last = pickChatMessage(messages, last);
        bot.chat(last);
        if (watchdog) watchdog.noteMovement();
      } catch (_err) {
        /* ignore */
      }
    }, 15000).unref?.();
  } else {
    const queue = messages.slice();
    for (let i = queue.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [queue[i], queue[j]] = [queue[j], queue[i]];
    }
    queue.forEach((message, index) => {
      setTimeout(() => {
        try {
          if (runtime.connectedAt && someoneElseOnline()) bot.chat(message);
        } catch (_err) {
          /* ignore */
        }
      }, index * 2000).unref?.();
    });
  }
}

function setupAntiAfk(bot) {
  const antiAfk = (config.utils && config.utils["anti-afk"]) || {};
  if (!antiAfk.enabled) return;

  addBotInterval(() => {
    if (!runtime.connectedAt) return;
    try {
      if (typeof bot.swingArm === "function") bot.swingArm();
      if (watchdog) watchdog.noteMovement();
    } catch (_err) {
      /* ignore */
    }
  }, 45000);

  addBotInterval(() => {
    if (!runtime.connectedAt) return;
    try {
      const slot = Math.floor(Math.random() * 9);
      if (typeof bot.setQuickBarSlot === "function") bot.setQuickBarSlot(slot);
    } catch (_err) {
      /* ignore */
    }
  }, 60000);

  if (antiAfk.sneak) {
    // A steady sneak keeps the hitbox small without sending fake input.
    const id = setInterval(() => {
      if (!runtime.connectedAt || typeof bot.setControlState !== "function") return;
      try {
        bot.setControlState("sneak", true);
        setTimeout(() => {
          try {
            bot.setControlState("sneak", false);
          } catch (_err) {
            /* ignore */
          }
        }, 800).unref?.();
      } catch (_err) {
        /* ignore */
      }
    }, 30000);
    botIntervals.add(id);
  }
}

function setupMovement(bot, movements) {
  const movement = movementConfig();
  if (movement.enabled === false) return;

  const pf = loadPathfinder();
  const hasPathfinder = Boolean(pf.mod && typeof bot.pathfinder === "object" && bot.pathfinder !== null);

  if (movement["look-around"] && movement["look-around"].enabled) {
    const interval = Math.max(1000, Number(movement["look-around"].interval) || 5000);
    addBotInterval(() => {
      if (!runtime.connectedAt) return;
      try {
        bot.look(Math.random() * Math.PI * 2 - Math.PI, (Math.random() * Math.PI) / 2 - Math.PI / 4, false);
        if (watchdog) watchdog.noteMovement();
      } catch (_err) {
        /* ignore */
      }
    }, interval);
  }

  if (movement["circle-walk"] && movement["circle-walk"].enabled && hasPathfinder && movements) {
    const radius = Math.max(1, Number(movement["circle-walk"].radius) || 4);
    const interval = Math.max(1000, Number(movement["circle-walk"].speed) || 3000);
    let angle = 0;
    addBotInterval(() => {
      if (!runtime.connectedAt || !bot.entity || !bot.entity.position) return;
      try {
        const { GoalBlock } = pf.mod.goals;
        const base = bot.entity.position;
        const x = Math.floor(base.x + Math.cos(angle) * radius);
        const z = Math.floor(base.z + Math.sin(angle) * radius);
        bot.pathfinder.setMovements(movements);
        bot.pathfinder.setGoal(new GoalBlock(x, Math.floor(base.y), z));
        angle += Math.PI / 4;
        if (watchdog) watchdog.noteMovement();
      } catch (_err) {
        /* ignore */
      }
    }, interval);
  } else if (movement["random-jump"] && movement["random-jump"].enabled) {
    const interval = Math.max(2000, Number(movement["random-jump"].interval) || 10000);
    addBotInterval(() => {
      if (!runtime.connectedAt || typeof bot.setControlState !== "function") return;
      try {
        bot.setControlState("jump", true);
        setTimeout(() => {
          try {
            bot.setControlState("jump", false);
          } catch (_err) {
            /* ignore */
          }
        }, 300).unref?.();
        if (watchdog) watchdog.noteMovement();
      } catch (_err) {
        /* ignore */
      }
    }, interval);
  }
}

function setupPosition(bot, movements) {
  const position = config.position || {};
  if (!position.enabled || circleWalkEnabled()) return;
  const pf = loadPathfinder();
  if (!pf.mod || !movements || !bot.pathfinder) return;
  try {
    const { GoalBlock } = pf.mod.goals;
    bot.pathfinder.setMovements(movements);
    bot.pathfinder.setGoal(new GoalBlock(Number(position.x) || 0, Number(position.y) || 64, Number(position.z) || 0));
    addLog(`[Position] Navigating to ${position.x}, ${position.y}, ${position.z}`);
  } catch (err) {
    addLog(`[Position] Could not set goal: ${err.message}`);
  }
}

function setupLeaveRejoinModule(bot) {
  const lr = (config.utils && config.utils["leave-rejoin"]) || {};
  if (!lr.enabled) return;
  // leaveRejoin.js schedules a quit; the reconnect scheduler notices the
  // resulting `end` event and rejoins. It never reconnects on its own.
  setupLeaveRejoin(bot, () => {
    addLog("[LeaveRejoin] Scheduled leave — the reconnect scheduler will bring the bot back");
    scheduleReconnect("leave-rejoin");
  }, {
    log: addLog,
    minStayMs: Number(lr["min-stay-ms"]) || undefined,
    maxStayMs: Number(lr["max-stay-ms"]) || undefined,
  });
}

function setupCombat(bot) {
  const combat = config.combat || {};
  if (!combat["attack-mobs"]) return;

  let lastAttack = 0;
  bot.on("physicsTick", () => {
    if (!runtime.connectedAt) return;
    const now = Date.now();
    if (now - lastAttack < 620) return; // 1.9+ attack cooldown
    try {
      const entities = Object.values(bot.entities || {});
      const target = entities.find(
        (e) =>
          e &&
          e !== bot.entity &&
          e.type === "mob" &&
          e.position &&
          bot.entity &&
          bot.entity.position.distanceTo(e.position) < 4,
      );
      if (target) {
        bot.attack(target);
        lastAttack = now;
        if (watchdog) watchdog.noteMovement();
      }
    } catch (_err) {
      /* ignore */
    }
  });

  if (combat["auto-eat"]) {
    bot.on("health", () => {
      try {
        if (typeof bot.food !== "number" || bot.food >= 14) return;
        const food = bot.inventory.items().find((item) => item.foodPoints > 0);
        if (!food) return;
        bot.equip(food, "hand")
          .then(() => bot.consume())
          .catch(() => {});
      } catch (_err) {
        /* ignore */
      }
    });
  }
}

function setupBeds(bot) {
  const beds = config.beds || {};
  if (!beds["place-night"]) return;
  let trying = false;
  addBotInterval(async () => {
    if (!runtime.connectedAt || trying) return;
    try {
      const time = bot.time && Number(bot.time.timeOfDay);
      if (!Number.isFinite(time) || time < 12500 || time > 23500) return;
      const block = bot.findBlock({
        matching: (b) => b && typeof b.name === "string" && b.name.includes("bed"),
        maxDistance: 8,
      });
      if (!block) return;
      trying = true;
      try {
        await bot.sleep(block);
        addLog("[Beds] Sleeping");
      } finally {
        trying = false;
      }
    } catch (_err) {
      trying = false;
    }
  }, 10000);
}

function setupChatResponder(bot) {
  const chat = config.chat || {};
  bot.on("chat", (author, message) => {
    if (!author || author === bot.username) return;
    if (watchdog) watchdog.noteMovement();
    if (discordEvent("chat")) sendDiscordWebhook(`💬 **${author}**: ${message}`, 0x7289da);
    if (chat.respond !== true) return;
    const text = String(message || "").toLowerCase();
    try {
      if (/(^|\s)(hi|hello|hey)\b/.test(text)) bot.chat(`Hello, ${author}!`);
    } catch (_err) {
      /* ignore */
    }
  });
}

// ============================================================================
//  CONTROL ACTIONS (dashboard + console share these)
// ============================================================================

function startBot(reason = "manual start") {
  // Never fight another instance for the username: re-check the lease first.
  if (!proxyInfo.proxy && runtime.lease && runtime.lease.acquired === false) {
    const retry = acquireLease({ username });
    runtime.lease = retry;
    if (!retry.acquired) {
      addLog(`[Lease] Start refused — ${retry.reason}. One bot per username.`);
      setPhase("stopped", "Standby — another instance is running this username");
      return { ok: false, alreadyRunning: false, leaseHeld: true, reason: retry.reason };
    }
    addLog(`[Lease] Acquired on retry (${retry.reason})`);
  }

  if (runtime.policyBlocked) {
    addLog(`[Control] ${reason}: clearing policy block and retrying explicitly`);
    runtime.policyBlocked = false;
    runtime.policyReason = null;
    runtime.policyRaw = null;
    runtime.policyCategory = null;
    runtime.policyBlockedAt = null;
  }
  runtime.intent = "running";
  runtime.reconnectAttempts = 0;
  runtime.notReadyProbes = 0;
  runtime.lastDisconnectReason = null;

  if (timers.reconnect) {
    clearTimeout(timers.reconnect);
    timers.reconnect = null;
    schedulerReason = null;
  }
  if (runtime.bot && runtime.spawnHandled) {
    setPhase("connected", `Playing on ${serverTarget.label}`);
    return { ok: true, alreadyRunning: true };
  }
  if (runtime.bot) destroyBot("restart");

  setPhase("starting", "Starting…");
  addLog(`[Control] Start requested (${reason})`);
  runCycle(false).catch((err) => {
    addLog(`[Control] Start failed: ${err.message}`);
    scheduleReconnect("start-failed");
  });
  return { ok: true, alreadyRunning: false };
}

function stopBot(reason = "manual stop") {
  runtime.intent = "stopped";
  if (timers.reconnect) {
    clearTimeout(timers.reconnect);
    timers.reconnect = null;
    schedulerReason = null;
  }
  destroyBot("stop");
  setPhase("stopped", "Stopped by operator");
  addLog(`[Control] Stop requested (${reason}) — staying offline until Start is pressed`);
  return { ok: true };
}

/** Ask the host's API to start the server, then let the bot join. */
async function startServer(reason = "dashboard") {
  if (!provider.configured) {
    const fallback = providerModule.reportingFallback("start", config, env);
    addLog(`[Provider] Start not possible: ${fallback.error}`);
    return fallback;
  }
  addLog(`[Provider] Requesting server start (${reason})`);
  const result = await provider.start();
  if (result.ok) {
    addLog(`[Provider] Start accepted — waiting for the port to answer`);
    // The bot's probe loop takes over from here; no special case needed.
    startBot("provider-start");
  } else {
    addLog(`[Provider] Start failed: ${result.error}`);
  }
  return result;
}

async function stopServer(reason = "dashboard") {
  if (!provider.configured) {
    const fallback = providerModule.reportingFallback("stop", config, env);
    addLog(`[Provider] Stop not possible: ${fallback.error}`);
    return fallback;
  }
  addLog(`[Provider] Requesting server stop (${reason})`);
  const result = await provider.stop();
  if (result.ok) addLog("[Provider] Stop accepted");
  else addLog(`[Provider] Stop failed: ${result.error}`);
  return result;
}

async function restartServer(reason = "dashboard") {
  if (!provider.configured) {
    const fallback = providerModule.reportingFallback("restart", config, env);
    addLog(`[Provider] Restart not possible: ${fallback.error}`);
    return fallback;
  }
  addLog(`[Provider] Requesting server restart (${reason})`);
  const result = await provider.restart();
  if (result.ok) addLog("[Provider] Restart accepted");
  else addLog(`[Provider] Restart failed: ${result.error}`);
  return result;
}

function sendConsoleCommand(command) {
  const cmd = String(command || "").trim();
  if (!cmd) return { ok: false, msg: "Empty command." };

  // This box sends Minecraft chat, it is not a shell. People type `npm install`
  // here because a Pterodactyl console looks the same, then are told "Bot is not
  // connected yet" and think the install failed. Say what actually happened.
  if (/^(npm|npx|pnpm|yarn|node|git|ls|cd|cat|rm|cp|mv|curl|wget|apt|apk|sudo|bash|sh|docker)\b/.test(cmd)) {
    const msg =
      `"${cmd.split(/\s+/)[0]}" is a shell command — this box only sends Minecraft chat and commands. ` +
      "npm install runs by itself when the server starts; to run the doctor set MAIN_FILE=doctor.js in Startup and restart.";
    addLog(`[Console] ${msg}`);
    return { ok: false, msg };
  }

  if (/^\/chat(\s|$)/i.test(cmd)) {
    const arg = cmd.split(/\s+/)[1] || "";
    const state = chatState();
    if (/^(off|stop|false|0|disable)$/i.test(arg)) return setChatEnabled(false);
    if (/^(on|start|true|1|enable)$/i.test(arg)) return setChatEnabled(true);
    const msg = state.enabled
      ? `Chat is ON — ${state.messages.length} message(s), every ~${state.delay}s with jitter${state.onlyWithPlayers ? ", only when someone else is online" : ""}. Use /chat off to silence it.`
      : "Chat is OFF — the bot sends nothing. Use /chat on to resume.";
    addLog(`[Console] ${msg}`);
    return { ok: true, msg };
  }

  if (cmd === "/help") {
    const lines = [
      "Available commands:",
      "  /help          Show this help",
      "  /pos           Bot coordinates",
      "  /status        Connection status + session uptime",
      "  /probe         Probe the server now",
      "  /start         Start the bot",
      "  /stop          Stop the bot",
      "  /chat          Is automatic chat on or off",
      "  /chat off      Silence the bot (no restart needed)",
      "  /chat on       Resume automatic chat",
      "  /say <text>    Chat in-game",
      "  /<anything>    Send any Minecraft command",
      "  <text>         Send plain chat (this box is not a shell)",
    ];
    lines.forEach((line) => addLog(`[Console] ${line}`));
    return { ok: true, msg: lines.join("\n") };
  }

  if (cmd === "/pos" || cmd === "/coords") {
    const coords = botCoordinates();
    const msg = coords
      ? `Position: X=${coords.x} Y=${coords.y} Z=${coords.z}`
      : "Position unavailable (bot not spawned).";
    addLog(`[Console] ${msg}`);
    return { ok: true, msg };
  }

  if (cmd === "/status") {
    const state = publicState();
    const msg = `Status: ${state.statusLabel} | Session: ${formatDuration(state.sessionUptimeMs / 1000)} | Reconnects: ${state.reconnectAttempts}`;
    addLog(`[Console] ${msg}`);
    return { ok: true, msg };
  }

  if (cmd === "/probe") {
    return { ok: true, pending: true, msg: "Probing…" };
  }

  if (cmd === "/start") {
    startBot("console");
    return { ok: true, msg: "Start requested." };
  }

  if (cmd === "/stop") {
    stopBot("console");
    return { ok: true, msg: "Stop requested." };
  }

  const bot = runtime.bot;
  if (!bot || typeof bot.chat !== "function") {
    const msg = runtime.intent === "stopped" ? "Bot is stopped." : "Bot is not connected yet.";
    addLog(`[Console] ${msg}`);
    return { ok: false, msg };
  }

  try {
    if (cmd.startsWith("/say ")) {
      bot.chat(cmd.slice(5));
    } else {
      bot.chat(cmd);
    }
    addLog(`[Console] Sent: ${cmd}`);
    return { ok: true, msg: `Sent: ${cmd}` };
  } catch (err) {
    addLog(`[Console] Send failed: ${err.message}`);
    return { ok: false, msg: err.message };
  }
}

// ============================================================================
//  DASHBOARD VIEW
// ============================================================================

const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
:root{
  --bg:#0b0f14;--panel:#131a22;--panel-2:#182028;--line:#222c37;
  --text:#e8eef5;--muted:#8b98a5;--dim:#67737f;
  --ok:#3fb950;--ok-bg:#0f2417;--bad:#f85149;--bad-bg:#2a1214;
  --warn:#d29922;--warn-bg:#2a2210;--accent:#58a6ff;--accent-2:#1f6feb;
}
body{margin:0;font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;
  background:radial-gradient(1200px 600px at 50% -20%,#16202b,var(--bg) 60%);
  color:var(--text);min-height:100vh;padding:24px 16px 64px}
main{max-width:720px;margin:0 auto}
header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:22px}
h1{font-size:22px;margin:0;letter-spacing:-.01em}
h2{font-size:14px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:26px 0 10px}
.sub{color:var(--muted);font-size:13px;margin:4px 0 0}
.badge{font-size:11px;padding:4px 9px;border-radius:999px;border:1px solid var(--line);color:var(--muted);white-space:nowrap}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px;margin-bottom:12px}
.status{display:flex;align-items:center;gap:14px}
.dot{width:14px;height:14px;border-radius:50%;flex:none;box-shadow:0 0 0 4px rgba(255,255,255,.04)}
.dot.on{background:var(--ok);box-shadow:0 0 0 4px rgba(63,185,80,.16)}
.dot.off{background:var(--bad);box-shadow:0 0 0 4px rgba(248,81,73,.16)}
.dot.idle{background:var(--dim);box-shadow:0 0 0 4px rgba(103,115,127,.16)}
.dot.warn{background:var(--warn);box-shadow:0 0 0 4px rgba(210,153,34,.16)}
.status-label{font-size:18px;font-weight:700}
.status-detail{color:var(--muted);font-size:13px;margin-top:2px;word-break:break-word}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.stat{background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.stat dt{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.06em;margin-bottom:5px}
.stat dd{margin:0;font-size:16px;font-weight:650;word-break:break-word}
.stat .note{font-size:11px;color:var(--dim);margin-top:3px}
.btn{appearance:none;border:1px solid var(--line);background:var(--panel-2);color:var(--text);
  font:inherit;font-weight:600;font-size:14px;padding:12px 16px;border-radius:10px;cursor:pointer;
  min-height:46px;transition:filter .15s,opacity .15s}
.btn:hover{filter:brightness(1.25)}
.btn:disabled{opacity:.5;cursor:not-allowed}
.btn.primary{background:var(--accent-2);border-color:var(--accent-2);color:#fff}
.btn.danger{background:#3a1618;border-color:#6b2326;color:#ffb4ae}
.btn.ghost{background:transparent}
.row{display:flex;gap:10px;flex-wrap:wrap}
.row .btn{flex:1 1 130px}
.banner{border-radius:12px;padding:14px 16px;margin-bottom:12px;font-size:13.5px;line-height:1.5}
.banner strong{display:block;font-size:14px;margin-bottom:3px}
.banner.policy{background:var(--warn-bg);border:1px solid #6b5312;color:#f0d68a}
.banner.serverless{background:#1a2130;border:1px solid #2b3a52;color:#b6c6dd}
.banner.proxy{background:#122a22;border:1px solid #1f5138;color:#a8e6c3}
.banner.err{background:var(--bad-bg);border:1px solid #6b2326;color:#ffb4ae}
pre.logs{background:#0a0e13;border:1px solid var(--line);border-radius:10px;padding:14px;
  font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.55;
  color:#c3ced9;max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:0}
a{color:var(--accent)}
footer{color:var(--dim);font-size:12px;text-align:center;margin-top:28px}
.tabs{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap}
.tabs a{font-size:13px;text-decoration:none;color:var(--muted);border:1px solid var(--line);
  border-radius:999px;padding:6px 12px}
.tabs a:hover{color:var(--text)}
`;

function statusDotClass(state) {
  if (state.policy && state.policy.blocked) return "warn";
  if (state.connected) return "on";
  if (state.status === "stopped") return "idle";
  return "off";
}

function renderBanners(state) {
  const banners = [];

  if (state.policy && state.policy.blocked) {
    banners.push(`<div class="banner policy"><strong>⛔ Blocked by server policy</strong>
      ${escapeHtml(state.policy.reason || "Policy block")}
      <div style="margin-top:6px;color:#c9b273">Automatic reconnects are paused on purpose.
      Retrying a policy ban in a loop gets accounts permanently banned.
      Fix the cause, then press <em>Start bot</em> to retry deliberately.</div></div>`);
  }

  if (state.environment.serverless && !state.environment.proxy) {
    banners.push(`<div class="banner serverless"><strong>⚡ Serverless runtime detected</strong>
      This looks like ${escapeHtml(state.environment.platform)}. A serverless function cannot
      hold a Minecraft TCP session open, so no bot is running in this process.
      Deploy the bot on an always-on host (Render worker, Koyeb, Fly, VPS) and set
      <code>BOT_BACKEND_URL</code> here to proxy to it.</div>`);
  }

  if (state.environment.proxy) {
    banners.push(`<div class="banner proxy"><strong>🔀 Proxy mode</strong>
      This dashboard forwards everything to <code>${escapeHtml(state.environment.backend || "")}</code>,
      the always-on bot instance.</div>`);
  }

  if (state.environment.backendError) {
    banners.push(`<div class="banner err"><strong>Backend URL problem</strong>
      ${escapeHtml(state.environment.backendError)}</div>`);
  }

  return banners.join("\n");
}

function renderDashboard(state) {
  const players = state.server.players;
  const playersText = players && players.online !== null && players.online !== undefined
    ? `${players.online}${players.max ? ` / ${players.max}` : ""}`
    : "unknown";
  const coords = state.coords
    ? `${state.coords.x}, ${state.coords.y}, ${state.coords.z}`
    : "—";

  const canStart = state.status === "stopped" || state.policy.blocked || !state.connected;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(state.name)} — Dashboard</title>
<style>${BASE_CSS}</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>${escapeHtml(state.name)}</h1>
      <p class="sub">Minecraft AFK session · v${escapeHtml(state.version)}</p>
    </div>
    <span class="badge">${escapeHtml(state.instanceId)}</span>
  </header>

  <nav class="tabs">
    <a href="/">Dashboard</a>
    <a href="/logs">Logs</a>
    <a href="/light">Light</a>
    <a href="/tutorial">Setup</a>
    <a href="/health">Health</a>
  </nav>

  ${renderBanners(state)}

  <section class="card status">
    <div class="dot ${statusDotClass(state)}"></div>
    <div>
      <div class="status-label">${escapeHtml(state.statusLabel)}</div>
      <div class="status-detail">${escapeHtml(state.statusDetail)}</div>
    </div>
  </section>

  <h2>Session</h2>
  <div class="grid">
    <dl class="stat"><dt>Session uptime</dt><dd>${escapeHtml(formatDuration(state.sessionUptimeMs / 1000))}</dd>
      <div class="note">since this login</div></dl>
    <dl class="stat"><dt>Coordinates</dt><dd>${escapeHtml(coords)}</dd>
      <div class="note">in-game position</div></dl>
    <dl class="stat"><dt>Reconnects</dt><dd>${state.reconnectAttempts}</dd>
      <div class="note">${state.connected ? "connected" : `probe ${state.notReadyProbes}/${state.forceLoginAfterProbes}`}</div></dl>
    <dl class="stat"><dt>Connects</dt><dd>${state.totalConnects}</dd>
      <div class="note">${state.totalDisconnects} disconnect(s)</div></dl>
  </div>

  <h2>Server</h2>
  <div class="card">
    <div class="grid">
      <dl class="stat"><dt>Address</dt><dd>${escapeHtml(state.server.configured ? state.server.label : "not configured")}</dd>
        <div class="note">${escapeHtml(state.server.probeStatus || "not probed")}${state.server.probeAmbiguous ? " · booting" : ""}</div></dl>
      <dl class="stat"><dt>Players</dt><dd>${escapeHtml(playersText)}</dd>
        <div class="note">from status ping</div></dl>
      <dl class="stat"><dt>Version</dt><dd>${escapeHtml(state.server.versionName || "auto")}</dd>
        <div class="note">${state.server.latencyMs !== null && state.server.latencyMs !== undefined ? `${state.server.latencyMs}ms ping` : "no data"}</div></dl>
      <dl class="stat"><dt>Host API</dt><dd id="provider-status">—</dd>
        <div class="note">exaroton</div></dl>
    </div>
    <div class="row" style="margin-top:14px">
      <button class="btn primary" data-post="/server/start">Start server</button>
      <button class="btn" data-post="/server/stop">Stop server</button>
      <button class="btn" data-post="/server/restart">Restart server</button>
    </div>
  </div>

  <h2>Bot</h2>
  <div class="card">
    <div class="row">
      <button class="btn primary" data-post="/start" ${canStart ? "" : "disabled"}>Start bot</button>
      <button class="btn danger" data-post="/stop" ${state.status === "stopped" ? "disabled" : ""}>Stop bot</button>
      <button class="btn ghost" data-post="/server/check">Re-check server</button>
      <button class="btn" data-post="/chat">${state.chat.enabled ? "Turn auto-chat off" : "Turn auto-chat on"}</button>
    </div>
    <p class="status-detail" style="margin:6px 0 0">Auto-chat: ${state.chat.enabled
      ? `<b>on</b> — ${state.chat.messages} line(s), one every ~${state.chat.every}s with jitter${state.chat.onlyWhenPlayersOnline ? ", only while someone else is online" : ""}`
      : "<b>off</b> — the bot sends nothing; it still plays and stays connected"}.</p>
    <div class="row" style="margin-top:10px">
      <input id="cmd" class="btn ghost" style="flex:2 1 240px;text-align:left;cursor:text"
             placeholder="chat: hello  ·  /say hi  ·  /list  ·  /pos" autocomplete="off">
      <button class="btn" id="send">Send</button>
    </div>
    <p class="status-detail" style="margin:6px 0 0">Text goes to Minecraft chat; anything starting with <code>/</code> is a command.
      This is not a shell — <code>npm install</code> runs when the server starts.</p>
    <div id="result" class="status-detail" style="margin-top:10px"></div>
  </div>

  <h2>Recent activity</h2>
  <pre class="logs" id="logs">${escapeHtml(getLogText(40))}</pre>

  <footer>minecraft-afk-bot v${escapeHtml(state.version)} · <a href="/logs">full logs</a> · <a href="/tutorial">setup guide</a></footer>
</main>
<script>
(function () {
  var result = document.getElementById('result');
  function post(url, body) {
    result.textContent = 'Working…';
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (data) {
        result.textContent = data.msg || data.error || (data.ok === false ? 'Failed' : 'Done');
        setTimeout(function () { location.reload(); }, 900);
      })
      .catch(function (err) { result.textContent = 'Error: ' + err.message; });
  }
  document.querySelectorAll('[data-post]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      btn.disabled = true;
      post(btn.getAttribute('data-post'));
    });
  });
  document.getElementById('send').addEventListener('click', function () {
    var input = document.getElementById('cmd');
    if (!input.value.trim()) return;
    post('/command', { command: input.value.trim() }).then(function () { input.value = ''; });
  });
  document.getElementById('cmd').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') document.getElementById('send').click();
  });
  function refresh() {
    fetch('/status/light').then(function (r) { return r.json(); }).then(function (data) {
      var el = document.getElementById('provider-status');
      if (el && typeof data.players !== 'undefined') { /* noop */ }
    }).catch(function () {});
    fetch('/server/status?light=1').then(function (r) { return r.json(); }).then(function (data) {
      var el = document.getElementById('provider-status');
      if (!el) return;
      if (data && data.provider && data.provider.ok && data.provider.server) {
        el.textContent = data.provider.server.statusLabel;
      } else if (data && data.provider && data.provider.mode === 'reporting') {
        el.textContent = 'manual';
      } else {
        el.textContent = 'n/a';
      }
    }).catch(function () {});
  }
  refresh();
  setInterval(refresh, 20000);
  setTimeout(function () { if (!document.getElementById('result').textContent) location.reload(); }, 60000);
})();
</script>
</body>
</html>`;
}

function renderLogsPage(limit) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(config.name || "AFK Bot")} — Logs</title>
<style>${BASE_CSS}</style>
</head>
<body>
<main>
  <header>
    <div><h1>Logs</h1><p class="sub">Last ${limit} lines · auto-refresh every 5s</p></div>
    <span class="badge">v${escapeHtml(VERSION)}</span>
  </header>
  <nav class="tabs"><a href="/">Dashboard</a><a href="/logs">Logs</a><a href="/light">Light</a></nav>
  <pre class="logs" id="logs" style="max-height:70vh">${escapeHtml(getLogText(limit))}</pre>
  <footer><a href="/">back to dashboard</a></footer>
</main>
<script>
(function () {
  var el = document.getElementById('logs');
  var pinned = true;
  el.addEventListener('scroll', function () {
    pinned = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
  });
  function tick() {
    fetch('/logs?format=json&limit=300').then(function (r) { return r.json(); })
      .then(function (data) {
        if (!data || !data.logs) return;
        el.textContent = data.logs.join('\\n');
        if (pinned) el.scrollTop = el.scrollHeight;
      }).catch(function () {});
  }
  setInterval(tick, 5000);
})();
</script>
</body>
</html>`;
}

function renderTutorialPage(state) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(config.name || "AFK Bot")} — Setup</title>
<style>${BASE_CSS}
  .card h3{margin:0 0 8px;font-size:15px}
  code{background:#0a0e13;border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:12.5px}
  pre.code{background:#0a0e13;border:1px solid var(--line);border-radius:10px;padding:14px;
    font-family:ui-monospace,Menlo,monospace;font-size:12px;overflow:auto;color:#c3ced9;white-space:pre}
  ol{padding-left:20px;line-height:1.65;color:#cfd8e2;font-size:14px}
  ul{padding-left:20px;line-height:1.65;color:#cfd8e2;font-size:14px}
</style>
</head>
<body>
<main>
  <header>
    <div><h1>Setup</h1><p class="sub">Everything this bot needs, in order</p></div>
    <span class="badge">v${escapeHtml(VERSION)}</span>
  </header>
  <nav class="tabs"><a href="/">Dashboard</a><a href="/logs">Logs</a><a href="/light">Light</a></nav>

  <section class="card">
    <h3>1 · Point the bot at a server</h3>
    <ol>
      <li>Edit <code>settings.json</code>: set <code>server.ip</code> and <code>server.port</code>.</li>
      <li>Set <code>bot-account.username</code> (and <code>type</code> to <code>offline</code> or <code>microsoft</code>).</li>
      <li>Or override with env vars: <code>MC_SERVER_HOST</code>, <code>MC_SERVER_PORT</code>, <code>MC_USERNAME</code>.</li>
    </ol>
    <p class="sub">Current target: <strong>${escapeHtml(state.server.label)}</strong> as
    <strong>${escapeHtml(state.username)}</strong>.</p>
  </section>

  <section class="card">
    <h3>2 · Let it survive on a free host</h3>
    <ul>
      <li>Bind to <code>0.0.0.0</code> on the port the host gives you — already done
          (<code>PORT</code>, or <code>SERVER_PORT</code> on panel hosts like Botkeep).</li>
      <li>Set <code>PUBLIC_URL</code> so the self-ping keeps the service warm
          (or rely on <code>RENDER_EXTERNAL_URL</code> / <code>KOYEB_PUBLIC_DOMAIN</code> /
          <code>FLY_APP_NAME</code> / <code>RAILWAY_PUBLIC_DOMAIN</code> auto-detection).</li>
      <li>Change <code>SELF_PING_INTERVAL_MS</code> to tune the keep-alive cadence (default 4 min).</li>
    </ul>
    <pre class="code">SELF_PING_INTERVAL_MS=240000
PUBLIC_URL=https://your-app.onrender.com</pre>
  </section>

  <section class="card">
    <h3>3 · Wake the server (optional, supported API only)</h3>
    <p class="sub">The bot never drives a host's website — that breaks Aternos' Terms of Service §5.
    Use an official API instead. exaroton is supported out of the box:</p>
    <pre class="code">EXAROTON_TOKEN=...          # never stored in settings.json
EXAROTON_SERVER_ID=AbCd1234 # or settings.json → provider.exaroton-server-id
EXAROTON_BASE_URL=https://api.exaroton.com/v1</pre>
    <p class="sub">Without a token the dashboard's server buttons fall back to
    <em>reporting mode</em>: they explain what to do and never claim to have done it.</p>
  </section>

  <section class="card">
    <h3>4 · Run only one copy</h3>
    <p class="sub">Two instances with the same username kick each other forever. The bot
    takes a 60-second lease file in <code>/tmp</code> and refreshes it every 20s.</p>
    <pre class="code">BOT_LEASE_DIR=/tmp          # override the lease directory
BOT_MIRROR_URL=https://standby.example.com  # optional cross-machine failover</pre>
  </section>

  <section class="card">
    <h3>5 · Keep it inside the rules</h3>
    <ul>
      <li>No browser automation of Aternos, ever.</li>
      <li>No fake packets — the bot moves and looks like a normal client.</li>
      <li>A policy ban pauses reconnecting. <code>/start</code> is a deliberate retry, not a loop.</li>
      <li>Watchdogs: 90s silence, 120s spawn timeout, 10min no movement → nudge → reconnect.
          Tune under <code>utils.watchdog</code>.</li>
    </ul>
  </section>

  <footer><a href="/">back to dashboard</a></footer>
</main>
</body>
</html>`;
}

function renderLightPage(state) {
  const cls = state.connected ? "on" : state.policyBlocked ? "warn" : "off";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(config.name || "AFK Bot")} status</title>
<style>
body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:#0b0f14;color:#e8eef5;
  display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.box{display:flex;align-items:center;gap:12px;background:#131a22;border:1px solid #222c37;
  border-radius:12px;padding:16px 20px}
.dot{width:12px;height:12px;border-radius:50%}
.dot.on{background:#3fb950}.dot.off{background:#f85149}.dot.warn{background:#d29922}
.label{font-weight:700;font-size:15px}
.sub{color:#8b98a5;font-size:12px;margin-top:2px}
</style></head>
<body>
<div class="box">
  <div class="dot ${cls}"></div>
  <div>
    <div class="label">${escapeHtml(state.statusLabel)}</div>
    <div class="sub">${escapeHtml(state.sessionUptime)}${state.server ? ` · ${escapeHtml(state.server)}` : ""}${
      state.players ? ` · ${state.players.online} player(s)` : ""
    }</div>
  </div>
</div>
<script>
setTimeout(function () { location.reload(); }, 15000);
</script>
</body></html>`;
}

// ============================================================================
//  EXPRESS APP
// ============================================================================

// Endpoints a machine calls, not a browser: host health checks, the keep-alive
// self-ping and instance-to-instance mirror traffic. They stay reachable when
// DASHBOARD_PASSWORD is set, otherwise every platform health check would fail.
const DASHBOARD_PUBLIC_PATHS = new Set(["/ping", "/health", "/mirror/status"]);

/** Constant-time compare that does not leak the length. */
function secretsMatch(given, expected) {
  const a = Buffer.from(String(given || ""), "utf8");
  const b = Buffer.from(String(expected || ""), "utf8");
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch (_err) {
    return false;
  }
}

/**
 * Optional HTTP basic auth for the dashboard.
 *
 * A panel host exposes the assigned port on the public internet (plain HTTP,
 * no domain). Without this, anyone who finds the URL can press Stop, read the
 * logs, or run `/command` inside the Minecraft session. Off by default: with no
 * `DASHBOARD_PASSWORD` the dashboard behaves exactly as before.
 */
function dashboardAuth(env) {
  const password = String(env.DASHBOARD_PASSWORD || "").trim();
  if (!password) return null;
  const user = String(env.DASHBOARD_USER || "admin").trim();

  return (req, res, next) => {
    if (DASHBOARD_PUBLIC_PATHS.has(req.path)) return next();

    const header = String(req.headers.authorization || "");
    const match = /^Basic\s+(.+)$/i.exec(header);
    if (match) {
      const decoded = Buffer.from(match[1], "base64").toString("utf8");
      const split = decoded.indexOf(":");
      if (split > -1) {
        const givenUser = decoded.slice(0, split);
        const givenPass = decoded.slice(split + 1);
        if (safeEqualStr(givenUser, user) && secretsMatch(givenPass, password)) return next();
      }
    }

    res.set("WWW-Authenticate", 'Basic realm="Minecraft AFK Bot", charset="UTF-8"');
    res.status(401).type("text/plain").send("Authentication required");
  };
}

function safeEqualStr(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length) return false;
  try {
    return crypto.timingSafeEqual(left, right);
  } catch (_err) {
    return false;
  }
}

function createApp(options = {}) {
  const app = express();
  app.disable("x-powered-by");
  runtime.backendError = null;

  // ---- optional dashboard password ------------------------------------
  const auth = dashboardAuth(env);
  if (auth) app.use(auth);

  // ---- proxy passthrough ---------------------------------------------
  // When BOT_BACKEND_URL is set, every request is forwarded verbatim
  // and the backend's status code + body are preserved. Serverless
  // deployments use this to show the real bot's dashboard.
  //
  // This must be registered BEFORE the body parsers: once express has
  // consumed the request stream there is nothing left to forward.
  const proxyOption = options.proxy === undefined ? proxyInfo : options.proxy;
  if (proxyOption && proxyOption.proxy && proxyOption.backend) {
    app.use((req, res, next) => {
      if (req.path === "__proxy-health") return next();
      proxyToBackend(req, res, proxyOption.backend).catch((err) => {
        addLog(`[Proxy] ${req.method} ${req.path} failed: ${err.message}`);
        if (!res.headersSent) {
          res.status(502).type("html").send(
            `<h1>502 — backend unreachable</h1><p>Could not reach ${escapeHtml(proxyOption.backend)}: ${escapeHtml(err.message)}</p>`,
          );
        }
      });
    });
  }

  if (proxyOption && proxyOption.error) {
    addLog(`[Proxy] BOT_BACKEND_URL ignored: ${proxyOption.error}`);
    // Surface it in the dashboard instead of only in the console.
    runtime.backendError = proxyOption.error;
  }

  app.use(express.json({ limit: "256kb" }));
  app.use(express.urlencoded({ extended: false }));

  app.get("/", (req, res) => {
    res.type("html").send(renderDashboard(publicState()));
  });

  app.get("/logs", (req, res) => {
    const limit = clamp(Number(req.query.limit) || 300, 1, 2000);
    if (req.query.format === "json" || req.get("accept") === "application/json") {
      return res.json({ ok: true, count: getLogs().length, logs: getLogs(limit) });
    }
    res.type("html").send(renderLogsPage(limit));
  });

  app.get("/tutorial", (req, res) => {
    res.type("html").send(renderTutorialPage(publicState()));
  });

  app.get("/light", (req, res) => {
    res.type("html").send(renderLightPage(lightState()));
  });

  app.get("/health", (req, res) => {
    const state = publicState();
    res.json({
      ok: true,
      status: "healthy",
      version: VERSION,
      botStatus: state.status,
      connected: state.connected,
      sessionUptimeMs: state.sessionUptimeMs,
      processUptimeMs: state.processUptimeMs,
      uptimeSeconds: Math.floor(state.processUptimeMs / 1000),
      server: state.server.configured ? state.server.label : null,
      serverless: state.environment.serverless,
      proxy: state.environment.proxy,
      policyBlocked: state.policy.blocked,
      instanceId: state.instanceId,
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/ping", (req, res) => {
    res.type("text/plain").send("pong");
  });

  // ---- status ---------------------------------------------------------
  app.get("/status/light", (req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(lightState());
  });

  app.get("/status", (req, res) => {
    res.json(publicState());
  });

  app.get("/mirror/status", (req, res) => {
    res.set("Cache-Control", "no-store");
    const state = publicState();
    res.json(
      buildMirrorPayload({
        username,
        status: state.status,
        connected: state.connected,
        sessionUptimeMs: state.sessionUptimeMs,
        serverLabel: state.server.label,
        policyBlocked: state.policy.blocked,
        reconnectAttempts: state.reconnectAttempts,
      }),
    );
  });

  // A standby instance reports its own status here; we just record it.
  app.post("/mirror/status", (req, res) => {
    const normalized = normalizeMirrorPayload(req.body);
    if (!normalized.valid) {
      return res.status(400).json({ ok: false, error: normalized.error });
    }
    lastMirrorReport = { ...normalized.data, receivedAt: new Date().toISOString() };
    addLog(
      `[Mirror] ${normalized.data.role} ${normalized.data.hostname || "?"} reported ${normalized.data.status}`,
    );
    res.json({ ok: true, received: true, seenAt: new Date().toISOString() });
  });

  // ---- provider / server control --------------------------------------
  app.get("/server/status", async (req, res) => {
    const light = String(req.query.light || "") === "1" || String(req.query.light) === "true";
    const state = publicState();

    // Light mode is cache-only: never make the dashboard wait on an API.
    let providerResult;
    if (light) {
      providerResult = providerCache.result
        ? { ...providerCache.result, cached: true }
        : {
            ok: false,
            configured: provider.configured,
            cached: true,
            mode: provider.configured ? "unknown" : "reporting",
            error: provider.configured ? "no cached provider status yet" : provider.missingReason(),
          };
    } else {
      providerResult = await getProviderStatus();
    }

    if (!providerResult.configured && !providerResult.mode) providerResult.mode = "reporting";

    res.set("Cache-Control", "no-store");
    res.json({
      ok: true,
      bot: {
        status: state.status,
        connected: state.connected,
        sessionUptimeMs: state.sessionUptimeMs,
      },
      server: state.server,
      provider: providerResult,
    });
  });

  app.post("/server/start", async (req, res) => {
    const result = await startServer("http");
    res.status(result.ok ? 200 : result.configured === false ? 409 : 502).json(result);
  });

  app.post("/server/stop", async (req, res) => {
    const result = await stopServer("http");
    res.status(result.ok ? 200 : result.configured === false ? 409 : 502).json(result);
  });

  app.post("/server/restart", async (req, res) => {
    const result = await restartServer("http");
    res.status(result.ok ? 200 : result.configured === false ? 409 : 502).json(result);
  });

  app.post("/server/check", async (req, res) => {
    const probe = await runProbe({ cache: false });
    const providerResult = await getProviderStatus({ force: true });
    res.json({
      ok: true,
      probe: {
        status: probe.status,
        online: probe.online,
        ambiguous: Boolean(probe.ambiguous),
        detail: describeProbe(probe),
        latencyMs: probe.latencyMs,
        players: probe.players,
        versionName: probe.versionName,
        motd: probe.motd,
        checkedAt: probe.checkedAt,
      },
      provider: providerResult,
      server: publicState().server,
    });
  });

  app.get("/server/check", async (req, res) => {
    const probe = await runProbe({ cache: req.query.cache !== "0" });
    const providerResult = await getProviderStatus({ force: req.query.cache === "0" });
    res.json({
      ok: true,
      probe,
      detail: describeProbe(probe),
      provider: providerResult,
      server: publicState().server,
    });
  });

  // ---- bot control ----------------------------------------------------
  app.post("/start", (req, res) => {
    const wasPolicyBlocked = runtime.policyBlocked;
    const result = startBot(wasPolicyBlocked ? "dashboard retry after policy block" : "dashboard");
    if (result && result.leaseHeld) {
      return res.status(409).json({
        success: false,
        ok: false,
        msg: `Not starting: ${result.reason}. Only one bot may use this username.`,
      });
    }
    res.json({
      success: true,
      ok: true,
      msg: wasPolicyBlocked
        ? "Policy block cleared — retrying explicitly (no automatic loop)."
        : result.alreadyRunning
          ? "Already running."
          : "Starting the bot.",
      policyCleared: wasPolicyBlocked,
    });
  });

  app.post("/stop", (req, res) => {
    stopBot("dashboard");
    res.json({ success: true, ok: true, msg: "Stopping the bot." });
  });

  app.post("/chat", (req, res) => {
    const body = req.body || {};
    const wanted = typeof body.enabled === "boolean" ? body.enabled : !chatState().enabled;
    const result = setChatEnabled(wanted, "dashboard");
    res.json({ success: result.ok, ok: result.ok, msg: result.msg, enabled: result.enabled });
  });

  app.post("/command", async (req, res) => {
    const command = (req.body && req.body.command) || "";
    if (String(command).trim() === "/probe") {
      const probe = await runProbe({ cache: false });
      const msg = `Probe: ${describeProbe(probe)}`;
      addLog(`[Console] ${msg}`);
      return res.json({ success: true, ok: true, msg });
    }
    const result = sendConsoleCommand(command);
    res.json({ success: result.ok, ok: result.ok, msg: result.msg });
  });

  app.use((req, res) => {
    res.status(404).json({ ok: false, error: `Not found: ${req.method} ${req.path}` });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    addLog(`[HTTP] ${req.method} ${req.path} error: ${err.message}`);
    if (res.headersSent) return;
    res.status(err.status || 500).json({ ok: false, error: err.message });
  });

  return app;
}

let lastMirrorReport = null;

/** Forward one request to the always-on bot; keep status code and body. */
function proxyToBackend(req, res, backend) {
  return new Promise((resolve, reject) => {
    const target = `${backend}${req.originalUrl}`;
    let parsed;
    try {
      parsed = new URL(target);
    } catch (err) {
      reject(err);
      return;
    }

    const transport = parsed.protocol === "https:" ? https : http;
    const headers = { ...req.headers, host: parsed.host };
    delete headers["content-length"];

    const chunks = [];
    const bodyPromise = new Promise((resolveBody) => {
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => resolveBody(Buffer.concat(chunks)));
      req.on("error", () => resolveBody(Buffer.alloc(0)));
    });

    bodyPromise.then((body) => {
      if (body.length > 0) headers["content-length"] = body.length;

      const upstream = transport.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port || (parsed.protocol === "https:" ? 443 : 80),
          path: parsed.pathname + parsed.search,
          method: req.method,
          headers,
        },
        (upstreamRes) => {
          res.status(upstreamRes.statusCode || 502);
          for (const [key, value] of Object.entries(upstreamRes.headers)) {
            if (key === "transfer-encoding" || key === "connection") continue;
            if (value !== undefined) res.setHeader(key, value);
          }
          res.setHeader("x-proxied-to", backend);
          upstreamRes.pipe(res);
          upstreamRes.on("end", resolve);
        },
      );

      upstream.setTimeout(30000, () => upstream.destroy(new Error("backend timeout")));
      upstream.on("error", reject);
      if (body.length > 0) upstream.write(body);
      upstream.end();
    });
  });
}

// ============================================================================
//  STARTUP
// ============================================================================

let httpServer = null;
let leaseRenewTimer = null;
let mirrorTimer = null;
let keepAliveHandle = null;

/**
 * Take the single-instance lease. Returns true when this process may
 * run the bot. In proxy mode we never run a bot, so no lease is needed.
 */
function claimLease() {
  if (proxyInfo.proxy) {
    addLog("[Lease] Proxy mode — this instance will not run a bot, skipping the lease");
    return true;
  }

  const result = acquireLease({ username });
  runtime.lease = result;

  if (!result.acquired) {
    addLog(`[Lease] Another instance owns this username (${result.reason})`);
    addLog("[Lease] This process will serve the dashboard but will NOT log in.");
    setPhase("stopped", "Standby — another instance is running this username");
    return false;
  }

  addLog(`[Lease] Acquired ${result.file} (${result.reason})`);

  leaseRenewTimer = setInterval(() => {
    const renewed = renewLease(result.file, result.record);
    if (renewed.ok) {
      result.record = renewed.record;
    } else {
      addLog(`[Lease] Renewal failed: ${renewed.error}`);
    }
  }, LEASE_RENEW_MS);
  if (typeof leaseRenewTimer.unref === "function") leaseRenewTimer.unref();

  // If the lease file disappears or is taken over, stand down: two
  // copies fighting over one username is exactly what we must avoid.
  timers.leaseWatch = setInterval(() => {
    const current = readLease(result.file);
    if (!current || (result.record && current.token && current.token !== result.record.token)) {
      addLog("[Lease] Lost the lease to another instance — stopping the bot");
      stopBot("lease lost");
    }
  }, LEASE_RENEW_MS);
  if (typeof timers.leaseWatch.unref === "function") timers.leaseWatch.unref();

  return true;
}

function releaseLeaseOnExit() {
  if (leaseRenewTimer) clearInterval(leaseRenewTimer);
  if (timers.leaseWatch) clearInterval(timers.leaseWatch);
  if (runtime.lease && runtime.lease.acquired && runtime.lease.file) {
    const result = releaseLease(runtime.lease.file, runtime.lease.record);
    if (result.removed) addLog("[Lease] Released");
  }
}

/**
 * The port the dashboard should listen on.
 *
 * `PORT` is the convention on Render/Koyeb/Fly/Railway/Docker. Panel hosts
 * (Botkeep, Pterodactyl, some game panels) hand the port over as `SERVER_PORT`
 * instead and expect the process to bind exactly that one -- bind anything else
 * and the panel shows the app as offline. Falls back to 5000 locally.
 */
function resolveHttpPort(source = env) {
  const explicit = Number(source.PORT);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  const panel = Number(source.SERVER_PORT);
  if (Number.isFinite(panel) && panel > 0) return panel;
  return 5000;
}

function startHttpServer(port = resolveHttpPort(env)) {
  const app = createApp();
  httpServer = app.listen(port, "0.0.0.0", () => {
    const actual = httpServer.address();
    const shown = actual && typeof actual === "object" ? actual.port : port;
    addLog(`[Server] Dashboard listening on http://0.0.0.0:${shown}`);
    if (String(env.DASHBOARD_PASSWORD || "").trim()) {
      addLog("[Server] Dashboard password required (HTTP basic auth)");
    } else if (!proxyInfo.proxy && !serverlessInfo.serverless) {
      addLog("[Server] Dashboard is NOT password protected — set DASHBOARD_PASSWORD if the port is public");
    }
    const publicUrl = watcherModule.resolvePublicUrl(env);
    if (publicUrl) addLog(`[Server] Public URL: ${publicUrl}`);
  });
  httpServer.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      const fallback = (httpServer.address() && httpServer.address().port) || port;
      addLog(`[Server] Port ${port} in use — trying ${fallback + 1}`);
      setTimeout(() => startHttpServer(fallback + 1), 250);
      return;
    }
    addLog(`[Server] HTTP error: ${err.message}`);
  });
  return httpServer;
}

function startMirrorPush() {
  const mirrorUrl = resolveMirrorUrl(env);
  if (!mirrorUrl) return;

  const push = async () => {
    const state = publicState();
    const payload = buildMirrorPayload({
      username,
      status: state.status,
      connected: state.connected,
      sessionUptimeMs: state.sessionUptimeMs,
      serverLabel: state.server.label,
      policyBlocked: state.policy.blocked,
      reconnectAttempts: state.reconnectAttempts,
    });
    const result = await pushMirrorStatus(mirrorUrl, payload);
    if (!result.ok) addLog(`[Mirror] Push failed: ${result.error || result.statusCode}`);
  };

  mirrorTimer = setInterval(() => {
    push().catch((err) => addLog(`[Mirror] Push error: ${err.message}`));
  }, MIRROR_INTERVAL_MS);
  if (typeof mirrorTimer.unref === "function") mirrorTimer.unref();
  addLog(`[Mirror] Reporting to ${mirrorUrl} every ${MIRROR_INTERVAL_MS / 1000}s`);
  push().catch(() => {});
}

function startConsole() {
  if (!process.stdin || process.stdin.isTTY !== true) return;
  if (config.modules && config.modules["console-commands"] === false) return;
  const readline = require("readline");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed === "status") {
      const state = publicState();
      addLog(`[Console] ${state.statusLabel} — session ${formatDuration(state.sessionUptimeMs / 1000)}`);
      return;
    }
    sendConsoleCommand(trimmed);
  });
}

function printBanner() {
  addLog("=".repeat(58));
  addLog(`  ${config.name || "Minecraft AFK Bot"} — v${VERSION}`);
  addLog("=".repeat(58));
  addLog(`[Config] Server:  ${serverTarget.label}`);
  addLog(`[Config] Account: ${username} (${botAuthType(config)})`);
  addLog(`[Config] Reconnect: ${baseReconnectDelay()}ms base, capped at ${maxReconnectDelay()}ms`);
  if (serverlessInfo.serverless) {
    addLog(`[Config] Serverless runtime detected: ${serverlessInfo.platform}`);
  }
  if (proxyInfo.proxy) addLog(`[Config] Proxy mode -> ${proxyInfo.backend}`);
  if (!provider.configured) addLog(`[Config] Provider API: not configured (reporting mode)`);
  addLog("=".repeat(58));
}

async function boot() {
  printBanner();

  if (serverlessInfo.serverless && !proxyInfo.proxy) {
    addLog(
      `[Runtime] ${serverlessInfo.platform} functions cannot hold a Minecraft session — the dashboard will report this honestly instead of faking a connection`,
    );
    setPhase("stopped", `Serverless runtime (${serverlessInfo.platform}) — no bot can run here`);
  }

  const haveLease = claimLease();

  startHttpServer();

  keepAliveHandle = watcherModule.startKeepAlive({
    env,
    log: addLog,
    serverless: serverlessInfo.serverless,
    proxyMode: proxyInfo.proxy,
  });
  timers.keepAlive = keepAliveHandle;

  startMirrorPush();
  startConsole();

  if (!haveLease) {
    addLog("[Boot] Standing by — another instance is playing. Press Start to try anyway.");
    return;
  }

  if (proxyInfo.proxy) {
    addLog("[Boot] Proxy mode — requests are forwarded, no local bot will start");
    return;
  }

  if (serverlessInfo.serverless) {
    addLog("[Boot] No bot started (serverless). Set BOT_BACKEND_URL to proxy to an always-on bot.");
    return;
  }

  runtime.intent = "running";
  runCycle(false).catch((err) => {
    addLog(`[Boot] Initial connect failed: ${err.message}`);
    scheduleReconnect("boot-failure");
  });

  addLog("[Boot] Bot started");
}

/** Graceful shutdown: quit the bot, drop timers, release the lease. */
function shutdown(signal = "SIGTERM", exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  addLog(`[System] ${signal} received — shutting down gracefully`);

  runtime.intent = "stopped";
  if (timers.reconnect) {
    clearTimeout(timers.reconnect);
    timers.reconnect = null;
  }
  if (keepAliveHandle && typeof keepAliveHandle.stop === "function") keepAliveHandle.stop();
  if (mirrorTimer) clearInterval(mirrorTimer);
  if (leaseRenewTimer) clearInterval(leaseRenewTimer);
  if (timers.leaseWatch) clearInterval(timers.leaseWatch);

  const bot = runtime.bot;
  runtime.bot = null;
  if (watchdog) watchdog.stop();
  clearBotIntervals();

  if (bot) {
    try {
      bot.removeAllListeners();
    } catch (_err) {
      /* ignore */
    }
    try {
      bot.quit("bot shutting down");
    } catch (_err) {
      try {
        bot.end("bot shutting down");
      } catch (_err2) {
        /* ignore */
      }
    }
  }

  releaseLeaseOnExit();
  setPhase("stopped", `Shut down (${signal})`);

  const finish = () => {
    if (httpServer && httpServer.listening) {
      httpServer.close(() => process.exit(exitCode));
      setTimeout(() => process.exit(exitCode), 2000).unref?.();
    } else {
      process.exit(exitCode);
    }
  };
  // Give the quit packet a moment to flush before we exit.
  setTimeout(finish, bot ? 400 : 0).unref?.();
}

let handlersInstalled = false;

function installProcessHandlers() {
  if (handlersInstalled) return;
  handlersInstalled = true;

  process.on("uncaughtException", (err) => {
    addLog(`[FATAL] Uncaught exception: ${err && err.stack ? err.stack.split("\n")[0] : String(err)}`);
    runtime.lastError = err && err.message ? err.message : String(err);
    // Never exit on a bot-side error: the supervisor should reconnect.
    if (!shuttingDown) {
      try {
        destroyBot("uncaught-exception");
      } catch (_err) {
        /* ignore */
      }
      scheduleReconnect("uncaught-exception");
    }
  });

  process.on("unhandledRejection", (reason) => {
    const message = reason && reason.message ? reason.message : String(reason);
    addLog(`[FATAL] Unhandled rejection: ${message}`);
    runtime.lastError = message;
  });

  process.on("SIGTERM", () => shutdown("SIGTERM", 0));
  process.on("SIGINT", () => shutdown("SIGINT", 0));
}

// Signal + crash handlers are installed as soon as the module loads, so an
// embedded/test harness gets the same graceful shutdown guarantees.
installProcessHandlers();

// ============================================================================
//  SERVERLESS ENTRY (VERCEL / NETLIFY / LAMBDA)
//
//  A platform function must hand back a request handler, not a listening
//  socket. This factory does that without booting the bot:
//
//    * the Express app is reused across warm invocations;
//    * in proxy mode every request is forwarded to the always-on bot;
//    * with no backend the dashboard renders the honest
//      "serverless — no bot can run here" banner instead of a 500.
//
//  It never starts the Minecraft session: a function cannot hold a TCP
//  connection open, so pretending otherwise is exactly what we refuse to do.
//
//  NOTE: api/index.js imports these names. If they ever disappear again the
//  deployed function throws at load and Vercel answers 500 on every request,
//  which is why the entry point also has a dependency-free fallback.
// ============================================================================

let cachedHandler = null;

/** Mark this process as dashboard-only (serverless runtime). */
function markServerlessOnly() {
  if (runtime.serverlessOnly) return;
  runtime.serverlessOnly = true;
  const info = detectServerless(env);
  runtime.intent = "stopped";
  setPhase(
    "stopped",
    info.serverless
      ? `Serverless runtime (${info.platform}) — no bot can run here`
      : "Dashboard-only process — no bot is running here",
  );
}

function createServerlessHandler(options = {}) {
  if (cachedHandler && !options.fresh) return cachedHandler;
  const app = createApp(options);
  const handler = (req, res) => app(req, res);

  handler.app = app;
  handler.kind = "express-handler";
  // Platforms look for a default export; expose it without losing the extras.
  handler.default = handler;

  cachedHandler = handler;
  return handler;
}

/** Vercel/Netlify style adapter: `module.exports = makeServerlessHandler()`. */
function makeServerlessHandler(options = {}) {
  // A function invocation can never hold a Minecraft session: mark the runtime
  // so every status surface reports "stopped" with an explanation instead of
  // "starting" forever.
  markServerlessOnly();
  if (!options.silent) {
    addLog(
      `[Serverless] Request handler created (mode: ${resolveRunMode(env).mode}) — no Minecraft session is started here`,
    );
  }
  return createServerlessHandler({ ...options, silent: true });
}

/**
 * Normalise a Node handler for platforms that pass (event, context):
 * Vercel's Node runtime and Netlify both hand us an IncomingMessage /
 * ServerResponse pair, which express consumes directly.
 */
function toPlatformHandler(handler) {
  const wrapped = (req, res, next) => handler(req, res, next);
  wrapped.default = wrapped;
  wrapped.kind = "express-handler";
  return wrapped;
}

if (IS_MAIN) {
  boot().catch((err) => {
    addLog(`[Boot] Fatal startup error: ${err && err.message ? err.message : err}`);
    setTimeout(() => process.exit(1), 500).unref?.();
  });
}

const exported = {
  VERSION,
  config,
  runtime,
  // config helpers
  deepMerge,
  loadConfig,
  resolveServerTarget,
  resolveUsername,
  detectServerless,
  detectProxyMode,
  resolveRunMode,
  validateBackendUrl,
  // pure helpers (unit tested)
  chatGapMs,
  pickChatMessage,
  chatState,
  setChatEnabled,
  computeBackoff,
  computeDuplicateLoginDelay,
  shouldForceLogin,
  isProbeReady,
  describeProbe,
  flattenKickReason,
  detectPolicyBan,
  isDuplicateLoginKick,
  isThrottleKick,
  describeStatus,
  formatDuration,
  formatMs,
  escapeHtml,
  clamp,
  // lease
  LEASE_TTL_MS,
  LEASE_RENEW_MS,
  sanitiseLeaseName,
  resolveLeaseDir,
  resolveLeaseFile,
  isLeaseStale,
  acquireLease,
  renewLease,
  releaseLease,
  readLease,
  buildLeaseRecord,
  pidAlive,
  // mirror
  resolveMirrorUrl,
  buildMirrorPayload,
  normalizeMirrorPayload,
  pushMirrorStatus,
  fetchMirrorStatus,
  // http
  createApp,
  renderDashboard,
  renderLogsPage,
  renderTutorialPage,
  renderLightPage,
  httpJsonRequest,
  // lifecycle
  startBot,
  stopBot,
  startServer,
  stopServer,
  restartServer,
  sendConsoleCommand,
  publicState,
  lightState,
  scheduleReconnect,
  runCycle,
  runProbe,
  boot,
  shutdown,
  claimLease,
  releaseLeaseOnExit,
  startHttpServer,
  resolveHttpPort,
  attachLivenessSources,
  socketStateOf,
  dashboardAuth,
  provider,
  addLog,
  getLogs,
  getLogText,
  subscribe,
  // serverless
  createApp,
  createServerlessHandler,
  makeServerlessHandler,
  markServerlessOnly,
  toPlatformHandler,
  // re-exports for tests / advanced use
  probe: probeModule,
  watcher: watcherModule,
  providerModule,
};

// `module.exports` stays an object: that is the library surface the tests and
// the CLI use. Platforms get a handler from `makeServerlessHandler()`
// (see api/index.js), never from this object directly.
//
// The getter means `require("./index.js").default` is a real handler on a
// serverless runtime -- some adapters look for exactly that -- while staying
// undefined locally, where there is no handler to give.
Object.defineProperty(exported, "default", {
  enumerable: false,
  configurable: true,
  get() {
    return detectServerless(env).serverless ? makeServerlessHandler({ silent: true }) : undefined;
  },
});

module.exports = exported;
