"use strict";

// ============================================================
// probe.js — is the target Minecraft server actually up?
//
// Two layers:
//   1. raw TCP connect  — "is anything listening on this port?"
//   2. Minecraft status ping (Server List Ping) — "is the world
//      really loaded and accepting players?"
//
// Why this exists: Aternos (and most free hosts) will accept the
// TCP connection long before the world is ready, then drop the
// player during login. Logging in too early burns a reconnect and
// looks like a duplicate login from the server's point of view.
//
// Classification:
//   online  — status ping replied with a player list
//   offline — TCP refused / DNS failure / reset (nothing listening)
//   timeout — nothing came back in the time budget
//   error   — anything else (weird protocol data, socket errors)
//
// If TCP connects but no valid status reply arrives we return
// `online` with `ambiguous: true`. Aternos' lobby proxy does this
// while the world is still booting: the port is open but there is
// no real server behind it yet. Callers must NOT treat ambiguous
// as proof of a dead server — probes are advisory.
// ============================================================

const net = require("net");
const { performance } = require("perf_hooks");

const DEFAULT_PORT = 25565;
const DEFAULT_TIMEOUT_MS = 6000;
const MAX_PACKET_BYTES = 1024 * 1024; // 1 MiB sanity cap

// ------------------------------------------------------------
// VarInt helpers (Minecraft protocol flavour)
// ------------------------------------------------------------

function encodeVarInt(value) {
  let v = value | 0;
  const bytes = [];
  for (let i = 0; i < 5; i++) {
    if ((v & ~0x7f) === 0) {
      bytes.push(v);
      return Buffer.from(bytes);
    }
    bytes.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  return Buffer.from(bytes);
}

/**
 * Read a VarInt from `buffer` starting at `offset`.
 * Returns { value, bytes } or null when more data is needed.
 */
function readVarInt(buffer, offset = 0) {
  let value = 0;
  let position = 0;
  for (let i = 0; i < 5; i++) {
    const index = offset + i;
    if (index >= buffer.length) return null; // need more bytes
    const byte = buffer[index];
    value |= (byte & 0x7f) << (7 * i);
    position++;
    if ((byte & 0x80) === 0) {
      return { value: value | 0, bytes: position };
    }
  }
  throw new Error("VarInt is too big");
}

function encodeString(str) {
  const body = Buffer.from(str, "utf8");
  return Buffer.concat([encodeVarInt(body.length), body]);
}

function encodePort(port) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(port & 0xffff, 0);
  return buf;
}

// ------------------------------------------------------------
// Packet builders
// ------------------------------------------------------------

function withLength(payload) {
  return Buffer.concat([encodeVarInt(payload.length), payload]);
}

function buildHandshake(host, port, protocolVersion = -1, nextState = 1) {
  return withLength(
    Buffer.concat([
      encodeVarInt(0x00), // packet id: handshake
      encodeVarInt(protocolVersion),
      encodeString(host),
      encodePort(port),
      encodeVarInt(nextState), // 1 = status
    ]),
  );
}

function buildStatusRequest() {
  return withLength(
    Buffer.concat([
      encodeVarInt(0x00), // packet id: status request
      Buffer.alloc(0),
    ]),
  );
}

function parseStatusPayload(jsonText) {
  const data = JSON.parse(jsonText);
  const players = data.players || {};
  let onlineCount = typeof players.online === "number" ? players.online : null;
  let maxCount = typeof players.max === "number" ? players.max : null;
  const sample = Array.isArray(players.sample)
    ? players.sample.map((p) => (typeof p === "string" ? p : p && p.name))
    : [];

  const version = data.version || {};
  let motd = "";
  if (typeof data.description === "string") {
    motd = data.description;
  } else if (data.description && typeof data.description === "object") {
    motd = flattenChat(data.description);
  }

  return {
    onlineCount,
    maxCount,
    sample: sample.filter(Boolean).slice(0, 20),
    versionName: version.name || null,
    protocol: typeof version.protocol === "number" ? version.protocol : null,
    motd: motd.trim(),
  };
}

function flattenChat(component) {
  if (!component || typeof component !== "object") return "";
  let text = typeof component.text === "string" ? component.text : "";
  if (Array.isArray(component.extra)) {
    text += component.extra.map(flattenChat).join("");
  }
  return text;
}

// ------------------------------------------------------------
// Raw status ping over an already-open socket
// ------------------------------------------------------------

function requestStatus(socket, opts = {}) {
  const host = opts.host || "localhost";
  const port = opts.port || DEFAULT_PORT;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  return new Promise((resolve) => {
    let buffer = Buffer.alloc(0);
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners("data");
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      try {
        socket.destroy();
      } catch (_err) {
        /* noop */
      }
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: false, reason: "timeout", ambiguous: true });
    }, timeoutMs);
    if (typeof timer.unref === "function") timer.unref();

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_PACKET_BYTES) {
        finish({ ok: false, reason: "packet too large", ambiguous: true });
        return;
      }

      let result;
      try {
        result = tryParseStatus(buffer);
      } catch (err) {
        finish({
          ok: false,
          reason: `protocol error: ${err.message}`,
          ambiguous: true,
        });
        return;
      }

      if (result.needsMore) return;
      if (result.error) {
        finish({ ok: false, reason: result.error, ambiguous: true });
        return;
      }
      finish({ ok: true, ...result });
    });

    socket.on("error", (err) => {
      finish({ ok: false, reason: err.code || err.message, ambiguous: false });
    });

    socket.on("close", () => {
      finish({ ok: false, reason: "closed before status reply", ambiguous: true });
    });

    try {
      socket.write(buildHandshake(host, port));
      socket.write(buildStatusRequest());
    } catch (err) {
      finish({ ok: false, reason: err.message, ambiguous: false });
    }
  });
}

function tryParseStatus(buffer) {
  const lengthField = readVarInt(buffer, 0);
  if (!lengthField) return { needsMore: true };

  const payloadStart = lengthField.bytes;
  const payloadEnd = payloadStart + lengthField.value;
  if (buffer.length < payloadEnd) return { needsMore: true };

  const payload = buffer.subarray(payloadStart, payloadEnd);
  const packetId = readVarInt(payload, 0);
  if (!packetId) return { needsMore: true };
  if (packetId.value !== 0x00) {
    return { error: `unexpected packet id ${packetId.value}` };
  }

  const strLen = readVarInt(payload, packetId.bytes);
  if (!strLen) return { needsMore: true };

  const jsonStart = packetId.bytes + strLen.bytes;
  const jsonEnd = jsonStart + strLen.value;
  if (payload.length < jsonEnd) return { needsMore: true };

  const jsonText = payload.subarray(jsonStart, jsonEnd).toString("utf8");
  return parseStatusPayload(jsonText);
}

// ------------------------------------------------------------
// Public API
// ------------------------------------------------------------

/**
 * Full probe: TCP connect, then status ping.
 *
 * @param {object} options
 * @param {string} options.host
 * @param {number} [options.port]
 * @param {number} [options.timeoutMs]
 * @param {boolean} [options.status] set false to skip layer 2
 * @returns {Promise<object>} probe result
 */
function probeServer(options = {}) {
  const host = options.host;
  const port = Number(options.port) || DEFAULT_PORT;
  const timeoutMs = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
  const wantStatus = options.status !== false;

  if (!host) {
    return Promise.resolve({
      host,
      port,
      status: "error",
      online: false,
      ambiguous: false,
      error: "no host configured",
      latencyMs: 0,
      checkedAt: Date.now(),
    });
  }

  const started = performance.now();

  return new Promise((resolve) => {
    let settled = false;
    const socket = new net.Socket();

    const settle = (result) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch (_err) {
        /* noop */
      }
      resolve({
        host,
        port,
        checkedAt: Date.now(),
        latencyMs: Math.max(0, Math.round(performance.now() - started)),
        players: null,
        versionName: null,
        motd: "",
        ...result,
      });
    };

    const connectTimer = setTimeout(() => {
      settle({
        status: "timeout",
        online: false,
        ambiguous: false,
        error: `tcp connect timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    if (typeof connectTimer.unref === "function") connectTimer.unref();

    socket.setNoDelay(true);

    socket.once("error", (err) => {
      clearTimeout(connectTimer);
      const code = err.code || "";
      const refused = [
        "ECONNREFUSED",
        "ENOTFOUND",
        "EHOSTUNREACH",
        "ENETUNREACH",
      ].includes(code);
      settle({
        status: refused ? "offline" : "error",
        online: false,
        ambiguous: false,
        error: code || err.message,
      });
    });

    socket.once("connect", async () => {
      clearTimeout(connectTimer);

      if (!wantStatus) {
        settle({ status: "online", online: true, ambiguous: false, tcpOnly: true });
        return;
      }

      const status = await requestStatus(socket, { host, port, timeoutMs });
      if (status.ok) {
        settle({
          status: "online",
          online: true,
          ambiguous: false,
          players: {
            online: status.onlineCount,
            max: status.maxCount,
            sample: status.sample,
          },
          versionName: status.versionName,
          protocol: status.protocol,
          motd: status.motd,
        });
        return;
      }

      // TCP said "something is listening" but no real status reply.
      // Port open + no world yet = classic booting Aternos server.
      settle({
        status: "online",
        online: true,
        ambiguous: true,
        error: status.reason || "no status reply",
      });
    });

    try {
      socket.connect({ host, port });
    } catch (err) {
      clearTimeout(connectTimer);
      settle({
        status: "error",
        online: false,
        ambiguous: false,
        error: err.message,
      });
    }
  });
}

/**
 * Cheap reachability check (TCP only, no protocol data).
 */
function probeTcp(options = {}) {
  return probeServer({ ...options, status: false });
}

module.exports = {
  probeServer,
  probeTcp,
  DEFAULT_PORT,
  DEFAULT_TIMEOUT_MS,
  // exported for tests / reuse
  encodeVarInt,
  readVarInt,
  encodeString,
  encodePort,
  buildHandshake,
  buildStatusRequest,
  parseStatusPayload,
  flattenChat,
  tryParseStatus,
  requestStatus,
};
