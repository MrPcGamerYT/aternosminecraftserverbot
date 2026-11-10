"use strict";

// ============================================================
// envfile.js — read variables from `.env` next to the bot
//
//   SillyDev's panel has no "Variables" tab on every plan, and a
//   Pterodactyl startup tab is easy to lose. A `.env` file in the
//   project root works everywhere: upload it once with the file
//   manager and every variable the app reads is available.
//
//   Rules, deliberately boring:
//     * KEY=value, one per line
//     * `export KEY=value` is accepted
//     * # and blank lines are ignored
//     * surrounding quotes are stripped
//     * a real process variable always wins over the file
// ============================================================

const fs = require("fs");
const path = require("path");

/** Parse `.env` text into a plain object. Never throws. */
function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    // A trailing ` # comment` outside quotes is dropped.
    const comment = value.indexOf(" #");
    if (comment > -1 && !value.startsWith("#")) value = value.slice(0, comment).trim();
    out[key] = value;
  }
  return out;
}

/**
 * Load a `.env` file into `env`.
 *
 * Real environment variables are never overwritten — a panel variable must beat
 * a stale file the user forgot about.
 */
function loadEnvFile(file, env = process.env, fsImpl = fs) {
  let text;
  try {
    if (!fsImpl.existsSync(file)) return { loaded: 0, keys: [], file };
    text = fsImpl.readFileSync(file, "utf8");
  } catch (_err) {
    return { loaded: 0, keys: [], file };
  }
  const parsed = parseEnv(text);
  const keys = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined || env[key] === "") {
      env[key] = value;
      keys.push(key);
    }
  }
  return { loaded: keys.length, keys, file };
}

module.exports = { parseEnv, loadEnvFile };
