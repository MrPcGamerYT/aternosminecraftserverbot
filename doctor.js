#!/usr/bin/env node
"use strict";

// ============================================================
// doctor.js — "is this copy ready to run?"
//
//   npm run doctor        # or: node doctor.js
//
// Prints one line per check, fails loudly on anything that
// would stop the bot, and exits non-zero so a host can gate on
// it. Written for panel hosts (SillyDev, Botkeep, Pterodactyl)
// where the only feedback is a console and "it did not start"
// has a dozen possible causes: files in a subfolder, npm never
// run, Node 25, settings.json still pointing at another server,
// or the port the panel assigned being ignored.
//
// No dependencies, no network, no side effects.
// ============================================================

const fs = require("fs");
const path = require("path");

const REQUIRED_FILES = [
  "package.json",
  "index.js",
  "settings.json",
  "probe.js",
  "watcher.js",
  "provider.js",
  "leaveRejoin.js",
  "logger.js",
];

const REQUIRED_MODULES = ["express", "mineflayer", "minecraft-data"];

const MIN_NODE = 20;
const MAX_NODE_EXCLUSIVE = 23;

/** Major version of a `node -v` style string, or NaN. */
function nodeMajor(version) {
  const match = /^v?(\d+)/.exec(String(version || "").trim());
  return match ? Number(match[1]) : NaN;
}

/**
 * Run every check without touching the filesystem beyond reading.
 *
 * @param {object} [options]
 * @param {string} [options.root]   project root (defaults to this file's directory)
 * @param {object} [options.env]    environment to inspect (defaults to process.env)
 * @param {string} [options.nodeVersion] version string override for tests
 */
function runChecks(options = {}) {
  const root = options.root || __dirname;
  const env = options.env || process.env;
  const nodeVersion = options.nodeVersion || process.version;
  const checks = [];

  const add = (name, status, detail) => checks.push({ name, status, detail });
  const fail = (name, detail) => add(name, "fail", detail);
  const ok = (name, detail) => add(name, "ok", detail);
  const warn = (name, detail) => add(name, "warn", detail);

  // ---- 1. Node version -------------------------------------------------
  const major = nodeMajor(nodeVersion);
  if (!Number.isFinite(major)) {
    warn("Node version", "could not parse the version");
  } else if (major < MIN_NODE) {
    fail("Node version", `${nodeVersion} is too old — this repo needs ${MIN_NODE}-${MAX_NODE_EXCLUSIVE - 1}`);
  } else if (major >= MAX_NODE_EXCLUSIVE) {
    warn(
      "Node version",
      `${nodeVersion} is outside the supported >=${MIN_NODE} <${MAX_NODE_EXCLUSIVE} range — ` +
        "it usually runs, but pick Node 22 on the panel if the session misbehaves",
    );
  } else {
    ok("Node version", nodeVersion);
  }

  // ---- 2. Files in the right place ------------------------------------
  const present = REQUIRED_FILES.filter((file) => fs.existsSync(path.join(root, file)));
  const missing = REQUIRED_FILES.filter((file) => !present.includes(file));
  if (missing.length === 0) {
    ok("Files", `${REQUIRED_FILES.length} required files at the project root`);
  } else {
    fail("Files", `missing: ${missing.join(", ")}`);
    // The single most common panel mistake: an extra folder from the ZIP.
    const nested = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .find((dir) => fs.existsSync(path.join(root, dir, "package.json")));
    if (nested) {
      add(
        "Files",
        "fail",
        `found package.json inside "${nested}/" — flatten it: mv ${nested}/* . && rmdir ${nested}`,
      );
    }
  }

  // ---- 3. Dependencies installed --------------------------------------
  const unresolved = [];
  for (const mod of REQUIRED_MODULES) {
    try {
      require.resolve(mod, { paths: [root] });
    } catch (_err) {
      unresolved.push(mod);
    }
  }
  if (unresolved.length === 0) {
    ok("Dependencies", `${REQUIRED_MODULES.join(", ")} resolved`);
  } else {
    fail("Dependencies", `not installed: ${unresolved.join(", ")} — run: npm install --omit=dev`);
  }

  // Resolving a package proves the folder exists, not that the download was
  // complete. A half-written `minecraft-data` install (interrupted npm, full
  // disk, two installs at once) loads fine until the first packet, then dies
  // with 'Cannot find module ../minecraft-data/data/pc/common/features.json'.
  let mineflayerError = null;
  if (unresolved.length === 0) {
    try {
      require(require.resolve("mineflayer", { paths: [root] }));
    } catch (err) {
      mineflayerError = err && err.message ? err.message : String(err);
    }
  }
  if (unresolved.length > 0) {
    add("Mineflayer loads", "fail", "skipped — dependencies are not installed");
  } else if (mineflayerError) {
    fail(
      "Mineflayer loads",
      `${mineflayerError} — the install is incomplete; delete node_modules and reinstall (npm run repair)`,
    );
  } else {
    ok("Mineflayer loads", "the client and its game data import cleanly");
  }

  // ---- 4. settings.json ------------------------------------------------
  let config = null;
  const settingsPath = path.join(root, "settings.json");
  if (fs.existsSync(settingsPath)) {
    try {
      config = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    } catch (err) {
      fail("settings.json", `invalid JSON: ${err.message}`);
    }
  }

  if (config) {
    const server = config.server || {};
    const host = String(env.MC_SERVER_HOST || server.ip || "").trim();
    const port = Number(env.MC_SERVER_PORT || server.port);
    const account = config["bot-account"] || {};
    const username = String(env.MC_USERNAME || account.username || "").trim();
    const version = String(server.version || "").trim();

    if (host && Number.isFinite(port) && port > 0 && port < 65536) {
      ok("Minecraft target", `${host}:${port}${version ? ` (${version})` : ""}`);
    } else {
      fail("Minecraft target", `server.ip / server.port are not usable (${host || "no host"}:${server.port || "no port"})`);
    }

    if (username) {
      const type = account.type || "offline";
      ok("Account", `${username} (${type})`);
      if (type !== "offline" && !account.password && !env.MC_PASSWORD) {
        warn("Account", `${type} account has no password in settings.json or MC_PASSWORD`);
      }
    } else {
      fail("Account", "bot-account.username is empty");
    }

    // Chat is how a bot looks human to a server, but hosts' policies call fast
    // repeating chat "spam" and threats get accounts banned. Judge both.
    const chat = (config.utils && config.utils["chat-messages"]) || {};
    const chatMessages = Array.isArray(chat.messages) ? chat.messages.filter(Boolean) : [];
    const repeatEvery = Number(chat["repeat-delay"]) || 120; // seconds in settings.json
    const THREAT = /\b(ban|banned|kick|report|hack|ip ?log|ddos)\w*/i;
    const threats = chatMessages.filter((m) => THREAT.test(String(m)));
    if (chat.enabled !== true) {
      ok("Chat automation", "off (no automated chat)");
    } else if (chatMessages.length === 0) {
      warn("Chat automation", "enabled but the message list is empty, so nothing is sent");
    } else if (chat.repeat === true && repeatEvery < 120) {
      warn(
        "Chat automation",
        `repeating ${chatMessages.length} message(s) every ${repeatEvery}s — hosts call this spam; use 300s or more`,
      );
    } else if (threats.length > 0) {
      warn("Chat automation", `message looks like a threat: "${threats[0]}" — servers ban for this`);
    } else if (chat.repeat === true) {
      ok(
        "Chat automation",
        `${chatMessages.length} random message(s) every ~${repeatEvery}s with jitter` +
          (chat["only-when-players-online"] === true ? ", only when someone else is online" : ""),
      );
    } else {
      ok("Chat automation", `${chatMessages.length} message(s) once after joining`);
    }

    const watchdog = (config.utils && config.utils.watchdog) || {};
    ok(
      "Watchdog",
      `silence ${Math.round((watchdog["silence-timeout"] || 90000) / 1000)}s, ` +
        `spawn ${Math.round((watchdog["spawn-timeout"] || 120000) / 1000)}s, ` +
        `${watchdog.enabled === false ? "disabled" : "enabled"}`,
    );
  }

  // ---- 5. The port the dashboard will use ------------------------------
  const explicit = Number(env.PORT);
  const panel = Number(env.SERVER_PORT);
  const httpPort = explicit > 0 ? explicit : panel > 0 ? panel : 5000;
  const portSource = explicit > 0 ? "PORT" : panel > 0 ? "SERVER_PORT (panel)" : "default";
  ok("Dashboard port", `${httpPort} from ${portSource}` + (explicit > 0 && panel > 0 && explicit !== panel
    ? ` — note: SERVER_PORT is ${panel}, the panel expects that one`
    : ""));

  // ---- 6. Host hints ---------------------------------------------------
  const hints = [];
  if (env.SERVER_PORT) hints.push("panel host (SERVER_PORT)");
  if (env.RENDER_EXTERNAL_URL) hints.push("Render");
  if (env.VERCEL) hints.push("Vercel (dashboard only — no bot can run here)");
  if (env.BOT_BACKEND_URL) hints.push(`proxy mode -> ${env.BOT_BACKEND_URL}`);
  if (env.PUBLIC_URL) hints.push(`self-ping -> ${env.PUBLIC_URL}`);
  if (hints.length === 0) {
    ok("Host", "no platform variables — plain process (VM, VPS, Docker, local)");
  } else {
    const serverless = Boolean(env.VERCEL) && !env.BOT_BACKEND_URL;
    add(
      "Host",
      serverless ? "fail" : "ok",
      serverless
        ? "VERCEL without BOT_BACKEND_URL — a function cannot hold a Minecraft session, set BOT_BACKEND_URL"
        : hints.join("; "),
    );
  }

  const failures = checks.filter((c) => c.status === "fail");
  return { checks, ok: failures.length === 0, failures };
}

function format({ checks }) {
  const marks = { ok: "[ ok ]", warn: "[warn]", fail: "[FAIL]" };
  const lines = checks.map((c) => `${marks[c.status]} ${c.name}: ${c.detail}`);
  const fails = checks.filter((c) => c.status === "fail").length;
  const warns = checks.filter((c) => c.status === "warn").length;
  lines.push("");
  lines.push(
    fails === 0
      ? `Ready to start${warns ? ` (${warns} warning${warns === 1 ? "" : "s"})` : ""}. Run: npm start`
      : `${fails} problem${fails === 1 ? "" : "s"} to fix before the bot can connect.`,
  );
  return lines.join("\n");
}

if (require.main === module) {
  const result = runChecks();
  console.log(format(result));
  process.exit(result.ok ? 0 : 1);
}

module.exports = { runChecks, format, nodeMajor, REQUIRED_FILES, REQUIRED_MODULES };
