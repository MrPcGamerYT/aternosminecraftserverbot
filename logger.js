"use strict";

// ============================================================
// In-memory log ring buffer.
//
// Keeps the last MAX_LOGS lines so the dashboard (/logs) can show
// recent activity without touching disk. Also fans out to any
// subscriber (used by the process log + optional webhooks).
// ============================================================

const DEFAULT_MAX_LOGS = 500;

function resolveMaxLogs() {
  const fromEnv = Number.parseInt(process.env.LOG_BUFFER_SIZE || "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return DEFAULT_MAX_LOGS;
}

const MAX_LOGS = resolveMaxLogs();
const logs = [];
const subscribers = new Set();

function formatTime(date = new Date()) {
  return date.toLocaleTimeString("en-GB", { hour12: false });
}

function stringify(message) {
  if (typeof message === "string") return message;
  if (message instanceof Error) return message.stack || message.message;
  if (message === undefined) return "undefined";
  try {
    return JSON.stringify(message);
  } catch (_err) {
    return String(message);
  }
}

function addLog(message) {
  const timestamp = formatTime();
  const formatted = `[${timestamp}] ${stringify(message)}`;

  // Keep the platform log (Render/Koyeb/Fly) as the primary sink.
  // eslint-disable-next-line no-console
  console.log(formatted);

  logs.push(formatted);
  if (logs.length > MAX_LOGS) logs.splice(0, logs.length - MAX_LOGS);

  for (const fn of subscribers) {
    try {
      fn(formatted);
    } catch (_err) {
      // A broken subscriber must never break logging.
    }
  }

  return formatted;
}

function getLogs(limit) {
  if (!limit || limit <= 0) return logs.slice();
  return logs.slice(Math.max(0, logs.length - limit));
}

function getLogText(limit) {
  return getLogs(limit).join("\n");
}

function clearLogs() {
  logs.length = 0;
}

function subscribe(fn) {
  if (typeof fn !== "function") return () => {};
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

function logCount() {
  return logs.length;
}

module.exports = {
  MAX_LOGS,
  addLog,
  getLogs,
  getLogText,
  clearLogs,
  subscribe,
  logCount,
};
