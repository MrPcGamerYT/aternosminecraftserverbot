"use strict";

// ============================================================
// tests/test-keepalive.js — public URL detection + self-ping
//
//   npm run test:keepalive   (18 tests)
//
// The self-ping is exercised against a real local HTTP server with
// a short interval, so the timing path is genuinely executed.
// ============================================================

const http = require("http");
const { test, run, assert, delay } = require("./harness");

const watcher = require("../watcher.js");
const index = require("../index.js");

const {
  resolvePublicUrl,
  normalisePublicUrl,
  resolveKeepAliveInterval,
  pingUrl,
  startKeepAlive,
} = watcher;

function startCountingServer() {
  return new Promise((resolve) => {
    const hits = [];
    const server = http.createServer((req, res) => {
      hits.push({ url: req.url, ua: req.headers["user-agent"] });
      if (req.url === "/missing") {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("nope");
        return;
      }
      if (req.url === "/boom") {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("boom");
        return;
      }
      if (req.url === "/slow") {
        setTimeout(() => {
          res.writeHead(200);
          res.end("late");
        }, 500);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("pong");
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        hits,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

// ------------------------------------------------------------
// URL detection
// ------------------------------------------------------------

test("1. PUBLIC_URL wins over every platform variable", () => {
  const url = resolvePublicUrl({
    PUBLIC_URL: "https://explicit.example.com",
    RENDER_EXTERNAL_URL: "https://render.example.com",
    KOYEB_PUBLIC_DOMAIN: "koyeb.example.com",
    FLY_APP_NAME: "myflyapp",
    RAILWAY_PUBLIC_DOMAIN: "railway.example.com",
  });
  assert.equal(url, "https://explicit.example.com");
});

test("2. RENDER_EXTERNAL_URL is auto-detected", () => {
  assert.equal(
    resolvePublicUrl({ RENDER_EXTERNAL_URL: "https://afk-bot.onrender.com" }),
    "https://afk-bot.onrender.com",
  );
});

test("3. KOYEB_PUBLIC_DOMAIN is auto-detected and given a scheme", () => {
  assert.equal(
    resolvePublicUrl({ KOYEB_PUBLIC_DOMAIN: "afk-bot.koyeb.app" }),
    "https://afk-bot.koyeb.app",
  );
});

test("4. FLY_APP_NAME becomes <app>.fly.dev", () => {
  assert.equal(resolvePublicUrl({ FLY_APP_NAME: "my-afk-bot" }), "https://my-afk-bot.fly.dev");
  // An explicit domain, if provided, is respected.
  assert.equal(
    resolvePublicUrl({ FLY_APP_NAME: "x", KOYEB_PUBLIC_DOMAIN: "" }),
    "https://x.fly.dev",
  );
});

test("5. RAILWAY_PUBLIC_DOMAIN is auto-detected", () => {
  assert.equal(
    resolvePublicUrl({ RAILWAY_PUBLIC_DOMAIN: "afk-production.up.railway.app" }),
    "https://afk-production.up.railway.app",
  );
});

test("6. with no public URL the keep-alive stays disabled", () => {
  assert.equal(resolvePublicUrl({}), null);
  assert.equal(resolvePublicUrl({ PUBLIC_URL: "", RENDER_EXTERNAL_URL: "" }), null);
  // Snowflake-style junk is rejected rather than pinged.
  assert.equal(resolvePublicUrl({ PUBLIC_URL: "http://" }), null);
});

test("7. URLs are normalised to a bare origin", () => {
  assert.equal(normalisePublicUrl("example.com"), "https://example.com");
  assert.equal(normalisePublicUrl("https://example.com/dashboard/?x=1"), "https://example.com");
  assert.equal(normalisePublicUrl("http://10.0.0.5:5000/"), "http://10.0.0.5:5000");
  assert.equal(normalisePublicUrl("   https://spaced.example.com   "), "https://spaced.example.com");
  assert.equal(normalisePublicUrl(""), null);
  assert.equal(normalisePublicUrl(null), null);
  assert.equal(normalisePublicUrl("not a url at all"), null);
});

// ------------------------------------------------------------
// Interval
// ------------------------------------------------------------

test("8. the default interval is 4 minutes and SELF_PING_INTERVAL_MS overrides it", () => {
  assert.equal(resolveKeepAliveInterval({}), 240000);
  assert.equal(watcher.KEEPALIVE_DEFAULTS.interval, 240000);
  assert.equal(resolveKeepAliveInterval({ SELF_PING_INTERVAL_MS: "60000" }), 60000);
  // Garbage / non-positive values fall back to the default.
  assert.equal(resolveKeepAliveInterval({ SELF_PING_INTERVAL_MS: "abc" }), 240000);
  assert.equal(resolveKeepAliveInterval({ SELF_PING_INTERVAL_MS: "0" }), 240000);
  assert.equal(resolveKeepAliveInterval({ SELF_PING_INTERVAL_MS: "-5" }), 240000);
});

// ------------------------------------------------------------
// Behaviour
// ------------------------------------------------------------

test("9. startKeepAlive pings the /ping endpoint of the public URL", async () => {
  const target = await startCountingServer();
  const handle = startKeepAlive({
    env: { PUBLIC_URL: target.url },
    log: () => {},
    intervalMs: 50,
  });

  try {
    assert.equal(handle.url, target.url);
    assert.equal(handle.intervalMs, 50);
    const result = await handle.ping();
    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 200);
    assert.equal(target.hits.length, 1);
    assert.equal(target.hits[0].url, "/ping");
    assert.match(target.hits[0].ua, /keepalive/);
  } finally {
    handle.stop();
    await target.close();
  }
});

test("10. the loop really repeats on its interval", async () => {
  const target = await startCountingServer();
  const handle = startKeepAlive({ env: { PUBLIC_URL: target.url }, log: () => {}, intervalMs: 40 });
  try {
    await delay(260);
    handle.stop();
    assert.ok(target.hits.length >= 3, `expected repeated pings, got ${target.hits.length}`);
  } finally {
    await target.close();
  }
});

test("11. stop() halts the loop immediately", async () => {
  const target = await startCountingServer();
  const handle = startKeepAlive({ env: { PUBLIC_URL: target.url }, log: () => {}, intervalMs: 30 });
  try {
    await delay(120);
    handle.stop();
    const afterStop = target.hits.length;
    await delay(150);
    assert.equal(target.hits.length, afterStop, "no pings may arrive after stop()");
  } finally {
    await target.close();
  }
});

test("12. proxy mode skips the self-ping", () => {
  const logs = [];
  const handle = startKeepAlive({
    env: { PUBLIC_URL: "https://bot.example.com", BOT_BACKEND_URL: "https://bot.example.com" },
    log: (m) => logs.push(m),
    proxyMode: true,
  });
  assert.equal(handle.skipped, "proxy/serverless mode");
  assert.ok(logs.some((l) => /Skipped/.test(l)));
});

test("13. serverless mode skips the self-ping", () => {
  const handle = startKeepAlive({
    env: { PUBLIC_URL: "https://bot.example.com", VERCEL: "1" },
    log: () => {},
    serverless: true,
  });
  assert.equal(handle.skipped, "proxy/serverless mode");
});

test("14. no public URL means no timer and no ping", async () => {
  const logs = [];
  const handle = startKeepAlive({ env: {}, log: (m) => logs.push(m), intervalMs: 20 });
  assert.equal(handle.skipped, "no public url");
  assert.equal(handle.url, null);
  assert.ok(logs.some((l) => /self-ping disabled/.test(l)));
  const result = await handle.ping();
  assert.equal(result.skipped, true);
  assert.equal(result.ok, false);
});

test("15. a failing ping is reported, not swallowed", async () => {
  const target = await startCountingServer();
  try {
    const notFound = await pingUrl(`${target.url}/missing`);
    assert.equal(notFound.ok, false);
    assert.equal(notFound.statusCode, 404);

    const serverError = await pingUrl(`${target.url}/boom`);
    assert.equal(serverError.ok, false);
    assert.equal(serverError.statusCode, 500);

    const invalid = await pingUrl("not-a-url");
    assert.equal(invalid.ok, false);
    assert.ok(invalid.error);
  } finally {
    await target.close();
  }
});

test("16. an unreachable host and a slow host both fail with an error", async () => {
  const target = await startCountingServer();
  const url = target.url;
  const slowUrl = `${target.url}/slow`;

  try {
    const timeout = await pingUrl(slowUrl, { timeoutMs: 60 });
    assert.equal(timeout.ok, false);
    assert.match(timeout.error, /timed out/);
  } finally {
    await target.close();
  }

  const refused = await pingUrl(`${url}/ping`, { timeoutMs: 500 });
  assert.equal(refused.ok, false);
  assert.ok(refused.error, "a closed port produces an error string");
});

test("17. keep-alive failures are logged and never throw out of the loop", async () => {
  const logs = [];
  // Reserve a port, then close it: the ping will be refused every time.
  const target = await startCountingServer();
  const deadUrl = target.url;
  await target.close();

  const handle = startKeepAlive({
    env: { PUBLIC_URL: deadUrl },
    log: (m) => logs.push(m),
    intervalMs: 30,
    timeoutMs: 300,
  });

  await delay(180);
  handle.stop();
  assert.ok(logs.some((l) => /Self-ping every/.test(l)), "the loop announces itself");
  assert.ok(logs.some((l) => /Ping failed/.test(l)), "failures must be logged");
  assert.ok(
    logs.some((l) => /in a row/.test(l)),
    "repeated failures are counted so a dying instance is visible",
  );
});

test("18. the running app exposes a cheap /ping endpoint for the keep-alive", async () => {
  const app = index.createApp({ proxy: { proxy: false, backend: null, error: null } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await pingUrl(`${url}/ping`, { timeoutMs: 2000 });
    assert.equal(result.ok, true);
    assert.equal(result.statusCode, 200);

    // The same helper drives startKeepAlive against the real app.
    const handle = startKeepAlive({ env: { PUBLIC_URL: url }, log: () => {}, intervalMs: 5000 });
    const pong = await handle.ping();
    handle.stop();
    assert.equal(pong.ok, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

run("keepalive");
