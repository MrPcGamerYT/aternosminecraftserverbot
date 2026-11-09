"use strict";

// ============================================================
// tests/test-proxy.js — serverless awareness + BOT_BACKEND_URL
//
//   npm run test:proxy   (16 tests)
//
// Platform detection is pure. Proxy behaviour is exercised against
// a stub backend, asserting that status codes and bodies survive.
// ============================================================

const http = require("http");
const { test, run, assert } = require("./harness");

const index = require("../index.js");

function startBackend(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const call = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        calls.push(call);
        handler(req, res, call);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        calls,
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        base: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      }),
    );
  });
}

// ------------------------------------------------------------
// Detection
// ------------------------------------------------------------

test("1. VERCEL is detected as a serverless runtime", () => {
  const result = index.detectServerless({ VERCEL: "1" });
  assert.equal(result.serverless, true);
  assert.equal(result.platform, "vercel");
  assert.match(result.reason, /vercel/);
});

test("2. AWS Lambda markers are detected", () => {
  assert.equal(index.detectServerless({ AWS_LAMBDA_FUNCTION_NAME: "bot" }).platform, "lambda");
  assert.equal(index.detectServerless({ LAMBDA_TASK_ROOT: "/var/task" }).platform, "lambda");
});

test("3. NETLIFY and CF_PAGES are detected", () => {
  assert.equal(index.detectServerless({ NETLIFY: "true" }).platform, "netlify");
  assert.equal(index.detectServerless({ CF_PAGES: "1" }).platform, "cloudflare-pages");
});

test("4. a plain host is not serverless", () => {
  const result = index.detectServerless({ PATH: "/usr/bin", RENDER: "true" });
  assert.equal(result.serverless, false);
  assert.equal(result.platform, null);
  assert.equal(result.reason, null);
  // Empty / "0" markers do not count.
  assert.equal(index.detectServerless({ VERCEL: "" }).serverless, false);
  assert.equal(index.detectServerless({ VERCEL: "0" }).serverless, false);
  assert.equal(index.detectServerless({}).serverless, false);
});

test("5. BOT_BACKEND_URL is parsed and validated", () => {
  assert.equal(index.validateBackendUrl("").ok, false);
  assert.equal(index.validateBackendUrl("not-a-url").ok, false);
  assert.equal(index.validateBackendUrl("ftp://example.com").ok, false);
  assert.equal(index.validateBackendUrl("ftp://example.com").error.includes("http"), true);

  const good = index.validateBackendUrl("https://bot.example.com/");
  assert.equal(good.ok, true);
  assert.equal(good.backend, "https://bot.example.com");

  const withPath = index.validateBackendUrl("http://10.0.0.5:8080/afk");
  assert.equal(withPath.ok, true);
  assert.equal(withPath.backend, "http://10.0.0.5:8080/afk");
});

test("6. proxy mode requires a valid backend, otherwise it is off", () => {
  assert.equal(index.detectProxyMode({}).proxy, false);
  assert.equal(index.detectProxyMode({ BOT_BACKEND_URL: "https://bot.example.com" }).proxy, true);
  assert.equal(
    index.detectProxyMode({ BOT_BACKEND_URL: "https://bot.example.com" }).backend,
    "https://bot.example.com",
  );

  const bad = index.detectProxyMode({ BOT_BACKEND_URL: "gopher://nope" });
  assert.equal(bad.proxy, false);
  assert.ok(bad.error, "an invalid backend URL is reported, not silently used");
});

test("7. run mode resolves proxy > serverless > local", () => {
  assert.equal(index.resolveRunMode({}).mode, "local");
  assert.equal(index.resolveRunMode({}).canRunBot, true);

  const serverless = index.resolveRunMode({ VERCEL: "1" });
  assert.equal(serverless.mode, "serverless");
  assert.equal(serverless.canRunBot, false);
  assert.match(serverless.reason, /cannot hold a Minecraft session/);

  // A backend URL always wins: that deployment can serve the real state.
  const both = index.resolveRunMode({ VERCEL: "1", BOT_BACKEND_URL: "https://bot.example.com" });
  assert.equal(both.mode, "proxy");
  assert.equal(both.canRunBot, false);
  assert.equal(both.proxy.backend, "https://bot.example.com");
});

test("8. a serverless runtime refuses to start a bot", async () => {
  const saved = { ...index.runtime };
  const savedEnv = { ...process.env };
  process.env.VERCEL = "1";
  delete process.env.BOT_BACKEND_URL;

  try {
    index.runtime.intent = "running";
    index.runtime.policyBlocked = false;
    await index.runCycle(false);
    const state = index.publicState();
    assert.equal(state.connected, false, "serverless must never claim a connection");
    assert.equal(state.status, "stopped");
    assert.match(state.statusDetail, /Serverless/);
    assert.equal(state.environment.serverless, true);
    assert.equal(state.environment.platform, "vercel");
  } finally {
    delete process.env.VERCEL;
    for (const key of Object.keys(savedEnv)) {
      if (process.env[key] === undefined) process.env[key] = savedEnv[key];
    }
    Object.assign(index.runtime, saved);
  }
});

test("9. the serverless banner explains the truth instead of pretending", () => {
  const saved = { ...index.runtime };
  index.runtime.connectedAt = null;
  index.runtime.intent = "running";

  const state = index.publicState();
  // Simulate the environment block the way boot() would leave it.
  const simulated = {
    ...state,
    environment: { ...state.environment, serverless: true, platform: "vercel", proxy: false },
  };

  const html = index.renderDashboard(simulated);
  assert.match(html, /Serverless runtime detected/);
  assert.match(html, /cannot\s+hold a Minecraft TCP session/);
  assert.match(html, /BOT_BACKEND_URL/);
  assert.ok(!/class="dot on"/.test(html), "no green dot on a serverless deployment");

  Object.assign(index.runtime, saved);
});

test("10. the proxy banner names the backend", () => {
  const state = index.publicState();
  const simulated = {
    ...state,
    environment: {
      ...state.environment,
      proxy: true,
      serverless: true,
      backend: "https://bot.example.com",
    },
  };
  const html = index.renderDashboard(simulated);
  assert.match(html, /Proxy mode/);
  assert.match(html, /https:\/\/bot\.example\.com/);
});

// ------------------------------------------------------------
// Behaviour
// ------------------------------------------------------------

test("11. proxy mode forwards requests and preserves the status code", async () => {
  const backend = await startBackend((req, res) => {
    res.writeHead(201, { "Content-Type": "application/json", "X-Backend": "yes" });
    res.end(JSON.stringify({ ok: true, from: "backend", path: req.url }));
  });
  const app = index.createApp({ proxy: { proxy: true, backend: backend.url, error: null } });
  const local = await listen(app);

  try {
    const result = await index.httpJsonRequest({ url: `${local.base}/anything`, method: "GET" });
    assert.equal(result.statusCode, 201, "status codes pass through unchanged");
    assert.equal(result.body.from, "backend");
    assert.equal(result.body.path, "/anything");
    assert.equal(backend.calls[0].url, "/anything");
  } finally {
    await local.close();
    await backend.close();
  }
});

test("12. proxy mode preserves error status codes and bodies", async () => {
  const backend = await startBackend((req, res) => {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "backend is rebooting" }));
  });
  const app = index.createApp({ proxy: { proxy: true, backend: backend.url, error: null } });
  const local = await listen(app);

  try {
    const result = await index.httpJsonRequest({ url: `${local.base}/health`, method: "GET" });
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.error, "backend is rebooting");
  } finally {
    await local.close();
    await backend.close();
  }
});

test("13. proxy mode forwards request bodies (POST /command)", async () => {
  const backend = await startBackend((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, echoed: req.method }));
  });
  const app = index.createApp({ proxy: { proxy: true, backend: backend.url, error: null } });
  const local = await listen(app);

  try {
    const result = await index.httpJsonRequest({
      url: `${local.base}/command`,
      method: "POST",
      body: { command: "/list" },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.echoed, "POST");
    assert.equal(backend.calls.length, 1);
    assert.equal(backend.calls[0].method, "POST");
    assert.equal(backend.calls[0].body, JSON.stringify({ command: "/list" }));
    assert.match(backend.calls[0].headers["content-type"], /application\/json/);
  } finally {
    await local.close();
    await backend.close();
  }
});

test("14. an unreachable backend returns 502 instead of hanging", async () => {
  const backend = await startBackend((req, res) => res.end("ok"));
  const url = backend.url;
  await backend.close();

  const app = index.createApp({ proxy: { proxy: true, backend: url, error: null } });
  const local = await listen(app);
  try {
    const result = await index.httpJsonRequest({ url: `${local.base}/`, method: "GET" });
    assert.equal(result.statusCode, 502);
    assert.match(result.text, /backend unreachable/);
  } finally {
    await local.close();
  }
});

test("15. without BOT_BACKEND_URL the app serves its own routes", async () => {
  const app = index.createApp({ proxy: { proxy: false, backend: null, error: null } });
  const local = await listen(app);
  try {
    const ping = await index.httpJsonRequest({ url: `${local.base}/ping`, method: "GET" });
    assert.equal(ping.statusCode, 200);
    assert.equal(ping.text, "pong");

    const health = await index.httpJsonRequest({ url: `${local.base}/health`, method: "GET" });
    assert.equal(health.statusCode, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.proxy, false);

    const root = await index.httpJsonRequest({ url: `${local.base}/`, method: "GET" });
    assert.equal(root.statusCode, 200);
    assert.match(root.text, /Dashboard/);
  } finally {
    await local.close();
  }
});

test("16. serverless without a backend flags itself in /health and the dashboard", async () => {
  const savedEnv = { ...process.env };
  delete process.env.BOT_BACKEND_URL;
  const app = index.createApp({ proxy: { proxy: false, backend: null, error: null } });
  const local = await listen(app);

  try {
    const health = await index.httpJsonRequest({ url: `${local.base}/health`, method: "GET" });
    assert.equal(health.body.ok, true);
    // In a plain environment there is no backend and no serverless marker.
    assert.equal(health.body.proxy, false);
    assert.equal(health.body.serverless, index.detectServerless(process.env).serverless);

    // The dashboard always states the environment honestly.
    const root = await index.httpJsonRequest({ url: `${local.base}/`, method: "GET" });
    assert.equal(root.statusCode, 200);
    if (health.body.serverless) {
      assert.match(root.text, /Serverless runtime detected/);
    } else {
      assert.ok(!/Serverless runtime detected/.test(root.text));
    }
  } finally {
    for (const key of Object.keys(savedEnv)) {
      if (process.env[key] === undefined) process.env[key] = savedEnv[key];
    }
    await local.close();
  }
});

run("proxy");
