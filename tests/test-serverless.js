"use strict";

// ============================================================
// tests/test-serverless.js — the Vercel/Lambda entry point
//
//   npm run test:serverless   (12 tests)
//
// This is the suite that would have caught the deployed 500:
// FUNCTION_INVOCATION_FAILED because nothing exported a request
// handler. Every test drives api/index.js through a real HTTP
// listener, exactly how Vercel's Node runtime invokes it.
// ============================================================

const fs = require("fs");
const path = require("path");
const http = require("http");
const { test, run, assert } = require("./harness");

const ROOT = path.join(__dirname, "..");

/** Serve a handler the way a platform does: app(req, res). */
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        base: `http://127.0.0.1:${server.address().port}`,
        hits: () => server.connections,
        close: () => new Promise((done) => server.close(done)),
      }),
    );
  });
}

function get(url) {
  return new Promise((resolve) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (c) => {
          body += c;
        });
        res.on("end", () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
      })
      .on("error", (err) => resolve({ statusCode: 0, headers: {}, body: "", error: err.message }));
  });
}

// ------------------------------------------------------------
// The deployment contract
// ------------------------------------------------------------

test("1. api/index.js exports a callable request handler", () => {
  // eslint-disable-next-line global-require
  const handler = require(path.join(ROOT, "api", "index.js"));
  assert.equal(typeof handler, "function", "Vercel invokes the export directly");
  assert.equal(handler.kind, "express-handler");
  assert.equal(typeof handler.default, "function", "adapters look for a default export");
});

test("2. vercel.json routes everything into that function", () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  assert.deepEqual(config.rewrites, [{ source: "/(.*)", destination: "/api/index.js" }]);
  assert.equal(config.framework, null);
  assert.ok(config.functions["api/index.js"], "the function is declared with a memory/time budget");
  assert.ok(config.functions["api/index.js"].maxDuration > 0);
});

test("3. no bot is started by the serverless entry (it cannot be)", () => {
  const index = require(path.join(ROOT, "index.js"));
  assert.equal(index.runtime.serverlessOnly, true, "the runtime is marked dashboard-only");
  assert.equal(index.runtime.bot, null, "no mineflayer bot may exist in a function");
  assert.equal(index.publicState().botRunning, false);

  const state = index.publicState();
  assert.equal(state.connected, false);
  assert.equal(state.status, "stopped");
  assert.equal(state.sessionUptimeMs, 0);
});

test("4. the deployed page returns 200 instead of 500", async () => {
  const handler = require(path.join(ROOT, "api", "index.js"));
  const local = await serve(handler);
  try {
    for (const route of ["/", "/health", "/ping", "/status/light", "/light", "/logs", "/tutorial"]) {
      const res = await get(local.base + route);
      assert.equal(res.statusCode, 200, `${route} must not fail`);
      assert.ok(res.body.length > 0, `${route} must return a body`);
    }
  } finally {
    await local.close();
  }
});

test("5. the dashboard is honest: stopped, no green dot, banner explains why", async () => {
  const handler = require(path.join(ROOT, "api", "index.js"));
  const local = await serve(handler);
  try {
    const res = await get(local.base + "/");
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /Stopped/, "the status card says Stopped");
    assert.match(res.body, /Serverless runtime detected/);
    assert.match(res.body, /BOT_BACKEND_URL/, "it tells the operator how to get a real bot");
    assert.ok(!/class="dot on"/.test(res.body), "never a green 'connected' dot");
    assert.ok(!/Starting up/.test(res.body), "no phantom 'starting' state");
    assert.match(res.headers["content-type"], /text\/html/);
  } finally {
    await local.close();
  }
});

test("6. /health and /status/light report the serverless mode", async () => {
  const handler = require(path.join(ROOT, "api", "index.js"));
  const local = await serve(handler);
  try {
    const health = await get(local.base + "/health");
    const body = JSON.parse(health.body);
    assert.equal(body.ok, true);
    assert.equal(body.connected, false);
    assert.equal(body.botStatus, "stopped");
    assert.equal(body.serverless, true);
    assert.equal(body.proxy, false);

    const light = await get(local.base + "/status/light");
    const lightBody = JSON.parse(light.body);
    assert.equal(lightBody.connected, false);
    assert.equal(lightBody.status, "stopped");
    assert.match(light.headers["cache-control"], /no-store/, "a cached status would lie");
  } finally {
    await local.close();
  }
});

test("7. the handler is cached across invocations (warm container reuse)", () => {
  const index = require(path.join(ROOT, "index.js"));
  const first = index.makeServerlessHandler({ silent: true });
  const second = index.makeServerlessHandler({ silent: true });
  assert.strictEqual(first, second, "rebuilding the app on every request wastes cold-start budget");
  assert.equal(first.kind, "express-handler");
});

test("8. POST bodies still work in a function (start/stop/command)", async () => {
  const handler = require(path.join(ROOT, "api", "index.js"));
  const local = await serve(handler);
  try {
    const result = await new Promise((resolve) => {
      const payload = JSON.stringify({ command: "/status" });
      const req = http.request(
        `${local.base}/command`,
        { method: "POST", headers: { "Content-Type": "application/json", "Content-Length": payload.length } },
        (res) => {
          let body = "";
          res.on("data", (c) => {
            body += c;
          });
          res.on("end", () => resolve({ statusCode: res.statusCode, body }));
        },
      );
      req.on("error", (err) => resolve({ statusCode: 0, body: err.message }));
      req.write(payload);
      req.end();
    });
    assert.equal(result.statusCode, 200);
    assert.match(result.body, /Stopped|Session/);
  } finally {
    await local.close();
  }
});

test("9. proxy mode in a function forwards to the always-on bot", async () => {
  // A stub playing the real bot's dashboard.
  const backend = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, realBot: true, path: req.url }));
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));

  const index = require(path.join(ROOT, "index.js"));
  const app = index.createApp({
    proxy: { proxy: true, backend: `http://127.0.0.1:${backend.address().port}`, error: null },
  });
  const local = await serve(index.toPlatformHandler((req, res) => app(req, res)));

  try {
    const res = await get(local.base + "/status/light");
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.realBot, true, "the function must serve the real bot's data");
    assert.equal(body.path, "/status/light");
  } finally {
    await local.close();
    await new Promise((resolve) => backend.close(resolve));
  }
});

test("10. an unreachable backend in a function is a 502, not a crash", async () => {
  const backend = http.createServer();
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const dead = `http://127.0.0.1:${backend.address().port}`;
  await new Promise((resolve) => backend.close(resolve));

  const index = require(path.join(ROOT, "index.js"));
  const app = index.createApp({ proxy: { proxy: true, backend: dead, error: null } });
  const local = await serve(app);
  try {
    const res = await get(local.base + "/");
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /backend unreachable/);
  } finally {
    await local.close();
  }
});

test("11. an invalid BOT_BACKEND_URL is refused, not fatal", async () => {
  const index = require(path.join(ROOT, "index.js"));
  const app = index.createApp({
    proxy: { proxy: false, backend: null, error: "BOT_BACKEND_URL must start with http:// or https://" },
  });
  const local = await serve(app);
  try {
    const res = await get(local.base + "/");
    assert.equal(res.statusCode, 200, "the dashboard still renders");
    assert.match(res.body, /Backend URL problem/, "and explains what is wrong");
  } finally {
    await local.close();
  }
});

test("12. every route the dashboard links to resolves inside the function", async () => {
  const handler = require(path.join(ROOT, "api", "index.js"));
  const local = await serve(handler);
  try {
    const root = await get(local.base + "/");
    const links = [...root.body.matchAll(/href="([^"]+)"/g)]
      .map((m) => m[1])
      .filter((href) => href.startsWith("/") && !href.startsWith("//"));
    assert.ok(links.length >= 4, `expected the nav links, found ${links.length}`);
    for (const link of new Set(links)) {
      const res = await get(local.base + link);
      assert.equal(res.statusCode, 200, `${link} is linked from the dashboard but returned ${res.statusCode}`);
    }
  } finally {
    await local.close();
  }
});

run("serverless");
