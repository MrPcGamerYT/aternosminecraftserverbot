"use strict";

// ============================================================
// tests/test-mirror.js — BOT_MIRROR_URL cross-machine failover
//
//   npm run test:mirror   (6 tests)
//
// A throwaway HTTP server plays the remote instance, so the real
// POST/GET code paths in index.js are exercised end to end.
// ============================================================

const http = require("http");
const { test, run, assert } = require("./harness");

const index = require("../index.js");

function startStubServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("1. the mirror payload is public-safe and self-describing", () => {
  const payload = index.buildMirrorPayload({
    username: "AFKBot",
    status: "connected",
    connected: true,
    sessionUptimeMs: 123456,
    serverLabel: "mc.example.com:25565",
    policyBlocked: false,
    reconnectAttempts: 2,
  });

  assert.equal(payload.ok, true);
  assert.equal(payload.role, "primary");
  assert.equal(payload.status, "connected");
  assert.equal(payload.connected, true);
  assert.equal(payload.sessionUptimeMs, 123456);
  assert.equal(payload.server, "mc.example.com:25565");
  assert.equal(payload.reconnectAttempts, 2);
  assert.ok(payload.updatedAt, "payloads are timestamped so staleness is detectable");
  assert.equal(typeof payload.hostname, "string");

  // No coordinates, no chat, no secrets leak into the mirror snapshot.
  const json = JSON.stringify(payload);
  for (const forbidden of ["coords", "password", "token", "EXAROTON"]) {
    assert.ok(!json.includes(forbidden), `mirror payload must not contain ${forbidden}`);
  }
});

test("2. a valid inbound report is accepted and normalised", async () => {
  const app = index.createApp({ proxy: { proxy: false } });
  const { server, port } = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () =>
      resolve({ server: s, port: s.address().port }),
    );
  });

  try {
    const result = await index.httpJsonRequest({
      url: `http://127.0.0.1:${port}/mirror/status`,
      method: "POST",
      body: {
        role: "standby",
        hostname: "standby-1",
        status: "connected",
        connected: true,
        sessionUptimeMs: 4200,
        updatedAt: new Date().toISOString(),
      },
    });

    assert.equal(result.ok, true, `expected 2xx, got ${result.statusCode} ${result.text}`);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.received, true);

    // The receiver echoes an acknowledgement but does not rebroadcast.
    assert.equal(typeof result.body.seenAt, "string");

    const normalized = index.normalizeMirrorPayload({
      status: "connected",
      connected: true,
      updatedAt: new Date().toISOString(),
    });
    assert.equal(normalized.valid, true);
    assert.equal(normalized.data.status, "connected");
  } finally {
    await stopServer(server);
  }
});

test("3. a malformed inbound report is rejected with 400", async () => {
  const app = index.createApp({ proxy: { proxy: false } });
  const { server, port } = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
  });

  try {
    const result = await index.httpJsonRequest({
      url: `http://127.0.0.1:${port}/mirror/status`,
      method: "POST",
      body: "not an object",
    });
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.ok, false);
    assert.match(result.body.error, /not an object/);

    assert.equal(index.normalizeMirrorPayload(null).valid, false);
    assert.equal(index.normalizeMirrorPayload("nope").valid, false);

    // Valid JSON that is not an object is rejected on content, not by the parser.
    const stringBody = await index.httpJsonRequest({
      url: `http://127.0.0.1:${port}/mirror/status`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify("just a string"),
    });
    assert.equal(stringBody.statusCode, 400);
    assert.equal(stringBody.body.ok, false);
  } finally {
    await stopServer(server);
  }
});

test("4. GET /mirror/status exposes this instance's snapshot", async () => {
  const app = index.createApp({ proxy: { proxy: false } });
  const { server, port } = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve({ server: s, port: s.address().port }));
  });

  try {
    const result = await index.httpJsonRequest({
      url: `http://127.0.0.1:${port}/mirror/status`,
      method: "GET",
    });
    assert.equal(result.ok, true);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.role, "primary");
    assert.equal(result.body.version, index.VERSION);
    assert.equal(typeof result.body.connected, "boolean");
    assert.ok(result.body.updatedAt);
  } finally {
    await stopServer(server);
  }
});

test("5. BOT_MIRROR_URL is parsed strictly and the client round-trips", async () => {
  assert.equal(index.resolveMirrorUrl({}), null);
  assert.equal(index.resolveMirrorUrl({ BOT_MIRROR_URL: "   " }), null);
  assert.equal(index.resolveMirrorUrl({ BOT_MIRROR_URL: "ftp://mirror.example.com" }), null);
  assert.equal(index.resolveMirrorUrl({ BOT_MIRROR_URL: "not a url" }), null);
  assert.equal(
    index.resolveMirrorUrl({ BOT_MIRROR_URL: "https://mirror.example.com/" }),
    "https://mirror.example.com",
  );

  const received = [];
  const { server, url } = await startStubServer((req, res) => {
    if (req.method === "POST") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        received.push({ path: req.url, method: req.method, body: JSON.parse(body) });
        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        role: "primary",
        status: "connected",
        connected: true,
        sessionUptimeMs: 9000,
        updatedAt: new Date().toISOString(),
      }),
    );
  });

  try {
    const payload = index.buildMirrorPayload({ username: "AFKBot", status: "connected", connected: true });
    const pushed = await index.pushMirrorStatus(url, payload);
    assert.equal(pushed.ok, true);
    assert.equal(pushed.statusCode, 202);
    assert.equal(received.length, 1);
    assert.equal(received[0].path, "/mirror/status");
    assert.equal(received[0].method, "POST");
    assert.equal(received[0].body.username, "AFKBot");

    const fetched = await index.fetchMirrorStatus(url);
    assert.equal(fetched.ok, true);
    assert.equal(fetched.mirror.status, "connected");
    assert.equal(fetched.mirror.sessionUptimeMs, 9000);
    assert.equal(typeof fetched.mirror.ageMs, "number");
  } finally {
    await stopServer(server);
  }
});

test("6. an unreachable mirror fails loudly instead of pretending", async () => {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await stopServer(server);

  const push = await index.pushMirrorStatus(`http://127.0.0.1:${port}`, index.buildMirrorPayload({}), {
    timeoutMs: 1500,
  });
  assert.equal(push.ok, false);
  assert.ok(push.error, "a failed push reports an error");

  const fetch = await index.fetchMirrorStatus(`http://127.0.0.1:${port}`, { timeoutMs: 1500 });
  assert.equal(fetch.ok, false);
  assert.equal(fetch.mirror, null);
  assert.ok(fetch.error);

  // A 5xx from the peer is also a failure, not a silent success.
  const bad = await startStubServer((req, res) => {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "boom" }));
  });
  try {
    const result = await index.fetchMirrorStatus(bad.url);
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 500);
  } finally {
    await stopServer(bad.server);
  }
});

run("mirror");
