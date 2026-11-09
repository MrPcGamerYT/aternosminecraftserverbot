"use strict";

// ============================================================
// provider.js — optional server-host control (exaroton)
//
// Lets the dashboard start/stop/restart the Minecraft server
// through the host's own API. This is the *supported* way to
// boot a server: we never drive Aternos' website with a browser
// automation, because that breaks Aternos' Terms of Service §5.
//
// exaroton API surface used:
//   GET  {base}/servers/{id}            -> current status
//   POST {base}/servers/{id}/start
//   POST {base}/servers/{id}/stop
//   POST {base}/servers/{id}/restart
//
// Token handling (deliberately strict):
//   * read ONLY from process.env.EXAROTON_TOKEN
//   * never from settings.json, never logged, never echoed in
//     an HTTP response body
//   * any error text that might embed the token is scrubbed
//
// Server id: settings.json provider.exaroton-server-id, or the
// EXAROTON_SERVER_ID environment variable. Env wins, as always.
// EXAROTON_BASE_URL overrides the API host; the scheme is taken
// literally (http:// stays http://) — we never silently upgrade
// to https because that would break local mocks.
// ============================================================

const https = require("https");
const http = require("http");
const { URL } = require("url");

const DEFAULT_BASE_URL = "https://api.exaroton.com/v1";
const DEFAULT_TIMEOUT_MS = 15000;

// exaroton numeric status -> human label
const STATUS_LABELS = {
  "-1": "Unknown",
  0: "Offline",
  1: "Online",
  2: "Starting",
  3: "Stopping",
  4: "Restarting",
  5: "Saving",
  6: "Loading",
  7: "Crashed",
  8: "Pending",
  9: "Transferring",
  10: "Preparing",
};

const STATUS_CODES = {
  offline: 0,
  online: 1,
  starting: 2,
  stopping: 3,
  restarting: 4,
  saving: 5,
  loading: 6,
  crashed: 7,
  pending: 8,
  transferring: 9,
  preparing: 10,
};

function statusToLabel(status) {
  if (status === null || status === undefined) return "Unknown";
  const key = typeof status === "number" ? status : Number(status);
  if (!Number.isFinite(key)) return "Unknown";
  return STATUS_LABELS[key] || `Status ${key}`;
}

function isRunning(status) {
  return Number(status) === STATUS_CODES.online;
}

function isTransitional(status) {
  const code = Number(status);
  return [
    STATUS_CODES.starting,
    STATUS_CODES.stopping,
    STATUS_CODES.restarting,
    STATUS_CODES.saving,
    STATUS_CODES.loading,
    STATUS_CODES.pending,
    STATUS_CODES.preparing,
    STATUS_CODES.transferring,
  ].includes(code);
}

// ------------------------------------------------------------
// Secret handling
// ------------------------------------------------------------

/** Scrub anything that looks like the token out of arbitrary text. */
function scrubSecrets(text, token) {
  if (text === null || text === undefined) return "";
  let out = String(text);
  if (token) {
    out = out.split(token).join("[redacted]");
  }
  // Generic bearer / token patterns as a second line of defence.
  out = out.replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1[redacted]");
  out = out.replace(/([?&](?:token|api_?key)=)[^&\s]+/gi, "$1[redacted]");
  return out;
}

/** Resolve the API token. Env only — settings.json is never consulted. */
function getToken(env = process.env) {
  const token = (env.EXAROTON_TOKEN || "").trim();
  return token || null;
}

/** Resolve the base URL, preserving the caller's scheme. */
function getBaseUrl(env = process.env) {
  const raw = (env.EXAROTON_BASE_URL || "").trim();
  if (!raw) return DEFAULT_BASE_URL;
  return raw.replace(/\/+$/, "");
}

/** Resolve the server id: env first, then settings.json. */
function getServerId(config, env = process.env) {
  const fromEnv = (env.EXAROTON_SERVER_ID || "").trim();
  if (fromEnv) return fromEnv;
  const provider = (config && config.provider) || {};
  const fromSettings = provider["exaroton-server-id"];
  if (typeof fromSettings === "string" && fromSettings.trim() !== "") {
    return fromSettings.trim();
  }
  return null;
}

function getAddress(config, env = process.env) {
  const provider = (config && config.provider) || {};
  const fromEnv = (env.EXAROTON_SERVER_ADDRESS || "").trim();
  if (fromEnv) return fromEnv;
  const fromSettings = provider["exaroton-server-address"];
  if (typeof fromSettings === "string" && fromSettings.trim() !== "") {
    return fromSettings.trim();
  }
  return null;
}

// ------------------------------------------------------------
// HTTP plumbing (no third-party deps)
// ------------------------------------------------------------

function selectTransport(url) {
  return url.startsWith("https:") ? https : http;
}

function request(options) {
  const {
    baseUrl = DEFAULT_BASE_URL,
    path,
    method = "GET",
    token = null,
    body = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(baseUrl.replace(/\/+$/, "") + path);
    } catch (err) {
      resolve({
        ok: false,
        statusCode: 0,
        error: `invalid url: ${err.message}`,
        body: null,
      });
      return;
    }

    const transport = selectTransport(target.protocol);
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;

    const headers = {
      Accept: "application/json",
      "User-Agent": "minecraft-afk-bot/2.11 (+exaroton)",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = payload.length;
    }

    const req = transport.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: target.pathname + target.search,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          if (raw.trim() !== "") {
            try {
              parsed = JSON.parse(raw);
            } catch (_err) {
              parsed = null;
            }
          }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            statusCode: res.statusCode,
            body: parsed,
            raw: raw.trim() === "" ? "" : scrubSecrets(raw.slice(0, 500), token),
            error: null,
          });
        });
        res.on("error", (err) => {
          resolve({
            ok: false,
            statusCode: res.statusCode || 0,
            body: null,
            error: scrubSecrets(err.message, token),
          });
        });
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`));
    });

    req.on("error", (err) => {
      resolve({
        ok: false,
        statusCode: 0,
        body: null,
        error: scrubSecrets(err.message, token),
      });
    });

    if (payload) req.write(payload);
    req.end();
  });
}

// ------------------------------------------------------------
// Response normalisation
// ------------------------------------------------------------

function normaliseServer(payload, fallbackId) {
  const data = (payload && (payload.data || payload.server)) || payload || {};
  const rawStatus = data.status;
  const numericStatus = Number.isFinite(Number(rawStatus))
    ? Number(rawStatus)
    : null;

  const players = data.players || {};
  const address =
    (typeof data.address === "string" && data.address) ||
    (typeof data.ip === "string" && data.ip) ||
    null;

  return {
    id: data.id || fallbackId || null,
    name: data.name || null,
    status: numericStatus,
    statusLabel:
      (typeof data.status === "string" && data.status) ||
      statusToLabel(numericStatus),
    running: isRunning(numericStatus),
    transitional: isTransitional(numericStatus),
    address,
    port:
      typeof players.port === "number"
        ? players.port
        : typeof data.port === "number"
          ? data.port
          : null,
    players: {
      online:
        typeof players.count === "number"
          ? players.count
          : typeof players.online === "number"
            ? players.online
            : null,
      max: typeof players.max === "number" ? players.max : null,
      list: Array.isArray(players.list) ? players.list : [],
    },
    software: data.software || null,
    version: data.version || null,
    motd: typeof data.motd === "string" ? data.motd : null,
  };
}

function safeErrorMessage(result, token) {
  const message = errorMessage(result);
  return token ? scrubSecrets(message, token) : message;
}

function errorMessage(result) {
  const body = result.body;
  if (body && typeof body.error === "string") return body.error;
  if (body && typeof body.message === "string") return body.message;
  if (result.error) return result.error;
  if (result.statusCode) return `HTTP ${result.statusCode}`;
  return "unknown error";
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

/**
 * Build a provider client. Never throws — when it is not
 * configured, every call resolves with { ok:false, configured:false }.
 */
function createProvider(config = {}, env = process.env) {
  const token = getToken(env);
  const baseUrl = getBaseUrl(env);
  const serverId = getServerId(config, env);
  const settingsAddress = getAddress(config, env);
  const providerConfig = config.provider || {};
  const enabled = providerConfig.enabled !== false;

  const configured = Boolean(token && serverId && enabled);

  function missingReason() {
    if (!enabled) return "provider disabled in settings.json";
    if (!token) return "EXAROTON_TOKEN is not set";
    if (!serverId) return "no exaroton server id configured";
    return null;
  }

  async function call(path, method = "GET") {
    if (!configured) {
      return {
        ok: false,
        configured: false,
        error: missingReason(),
        statusCode: 0,
        body: null,
      };
    }
    const result = await request({ baseUrl, path, method, token });
    return { ...result, configured: true };
  }

  /** GET /servers/{id} — current status, players, address. */
  async function getStatus() {
    if (!configured) {
      return {
        ok: false,
        configured: false,
        error: missingReason(),
        server: null,
        address: settingsAddress,
      };
    }

    const result = await call(`/servers/${encodeURIComponent(serverId)}`);
    if (!result.ok) {
      return {
        ok: false,
        configured: true,
        error: safeErrorMessage(result, token),
        statusCode: result.statusCode,
        server: null,
        address: settingsAddress,
      };
    }

    const server = normaliseServer(result.body, serverId);
    if (!server.address) server.address = settingsAddress;

    return {
      ok: true,
      configured: true,
      error: null,
      server,
      address: server.address || settingsAddress,
    };
  }

  async function action(name) {
    if (!configured) {
      return {
        ok: false,
        configured: false,
        action: name,
        error: missingReason(),
        server: null,
        mode: "reporting",
      };
    }

    const result = await call(
      `/servers/${encodeURIComponent(serverId)}/${name}`,
      "POST",
    );

    if (!result.ok) {
      return {
        ok: false,
        configured: true,
        action: name,
        error: safeErrorMessage(result, token),
        statusCode: result.statusCode,
        server: null,
      };
    }

    const server = normaliseServer(result.body, serverId);
    if (!server.address) server.address = settingsAddress;

    return {
      ok: true,
      configured: true,
      action: name,
      error: null,
      server,
    };
  }

  return {
    enabled,
    configured,
    baseUrl,
    serverId,
    address: settingsAddress,
    getStatus,
    start: () => action("start"),
    stop: () => action("stop"),
    restart: () => action("restart"),
    missingReason,
  };
}

/**
 * Reporting-mode fallback: when no API token exists we can still
 * describe what the *operator* should do, without pretending we
 * did anything. Never claims success.
 */
function reportingFallback(operation, config = {}, env = process.env) {
  const address = getAddress(config, env);
  const providerConfig = config.provider || {};
  return {
    ok: false,
    configured: false,
    mode: "reporting",
    operation: operation || "status",
    address,
    error:
      providerConfig["manual-start-hint"] ||
      "No provider API configured — start the server yourself, then the bot will join automatically.",
  };
}

module.exports = {
  createProvider,
  reportingFallback,
  getToken,
  getBaseUrl,
  getServerId,
  getAddress,
  statusToLabel,
  isRunning,
  isTransitional,
  normaliseServer,
  errorMessage,
  safeErrorMessage,
  scrubSecrets,
  request,
  STATUS_LABELS,
  STATUS_CODES,
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
};
