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
  assert.ok(config.functions["api/index.js"], "the function is declared with a time budget");
  assert.ok(config.functions["api/index.js"].maxDuration > 0);
  // Only public/ is published as static output, so source files have no URL.
  assert.equal(config.outputDirectory, "public");
});

test("2b. vercel.json contains nothing Vercel warns about", () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  const fn = config.functions["api/index.js"];
  // "Provided `memory` setting in `vercel.json` is ignored on Active CPU billing."
  assert.equal(fn.memory, undefined, "memory is Vercel-plan dependent: it warns, and silently does nothing");
  // maxDuration is honoured on every plan, so it stays.
  assert.equal(fn.maxDuration, 30);
  // No stray properties that only exist to satisfy a plan we can't detect.
  assert.deepEqual(Object.keys(fn).sort(), ["maxDuration"]);
});

test("2c. engines pins the Node major instead of an open-ended range", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const range = pkg.engines && pkg.engines.node;
  assert.ok(range, "engines.node must be set");
  // ">=18" makes Vercel warn and auto-upgrade majors under us.
  assert.ok(!/^>=?\s*\d+(\.\d+)*$/.test(range.trim()), `"${range}" auto-upgrades to future majors`);
  assert.match(range, /<\d+/, "the range needs an upper bound");
  // ...but it must still allow a modern LTS the bot is tested on.
  const [lower, upper] = range.replace(/[><=]/g, " ").trim().split(/\s+/);
  assert.ok(Number(lower) >= 18, `${lower} is below the documented minimum`);
  assert.ok(Number(upper) >= 22, `the ceiling (${upper.split(".")[0]}) is too low for current LTS`);
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

// ------------------------------------------------------------
// Resilience: the deployed function must never 500 again
//
// Commit a289ff6 removed the serverless exports from index.js while
// api/index.js still imported them, and the live site answered
// FUNCTION_INVOCATION_FAILED on every request. These tests pin the
// degraded paths so that class of breakage can't reach production.
// ------------------------------------------------------------

const os = require("os");

function makeSandbox(indexSource) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afk-serverless-"));
  fs.mkdirSync(path.join(dir, "api"), { recursive: true });
  fs.copyFileSync(path.join(ROOT, "api", "index.js"), path.join(dir, "api", "index.js"));
  fs.copyFileSync(path.join(ROOT, "package.json"), path.join(dir, "package.json"));
  if (indexSource !== null) fs.writeFileSync(path.join(dir, "index.js"), indexSource);
  // Reuse the real dependencies so only the code path under test differs.
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"), "dir");
  return dir;
}

function loadFrom(dir, env = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, { VERCEL: "1", ...env });
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(dir)) delete require.cache[key];
  }
  try {
    return require(path.join(dir, "api", "index.js"));
  } finally {
    process.env = saved;
  }
}

test("13. a stripped index.js still serves a readable page, never a 500", async () => {
  // Exactly the shape of commit a289ff6: index.js without the serverless API.
  const dir = makeSandbox(
    '"use strict";\nmodule.exports = { VERSION: "2.11.0-crippled", runtime: {} };\n',
  );
  const handler = loadFrom(dir);
  const local = await serve(handler);
  try {
    const home = await get(local.base + "/");
    assert.equal(home.statusCode, 200, "no FUNCTION_INVOCATION_FAILED");
    assert.match(home.body, /Dashboard unavailable|cannot hold a Minecraft/i);

    const health = await get(local.base + "/health");
    assert.equal(health.statusCode, 200);
    const body = JSON.parse(health.body);
    assert.equal(body.mode, "serverless");
    assert.match(body.error, /does not export a serverless handler/);
    assert.match(body.hint, /BOT_BACKEND_URL/);
  } finally {
    await local.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("14. a module that throws on load degrades to an explanation, not a 500", async () => {
  const dir = makeSandbox('"use strict";\nthrow new Error("Cannot find module \'mineflayer\'");\n');
  const handler = loadFrom(dir);
  const local = await serve(handler);
  try {
    const res = await get(local.base + "/health");
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.match(body.error, /failed to load: Cannot find module 'mineflayer'/);
    assert.equal(body.ok, false);
    assert.ok(body.version, "still reports a version so the deploy is identifiable");
  } finally {
    await local.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("15. with a backend configured, a broken index.js still shows the live bot", async () => {
  const backend = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ realBot: true, path: req.url }));
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendUrl = `http://127.0.0.1:${backend.address().port}`;

  const dir = makeSandbox('"use strict";\nthrow new Error("boom");\n');
  const handler = loadFrom(dir, { BOT_BACKEND_URL: backendUrl });
  const local = await serve(handler);

  try {
    const res = await get(local.base + "/status/light");
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.realBot, true, "the live dashboard stays reachable through any failure");
    assert.equal(body.path, "/status/light");
  } finally {
    await local.close();
    await new Promise((resolve) => backend.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("16. api/index.js never imports a name index.js does not export", () => {
  const index = require(path.join(ROOT, "index.js"));
  const source = fs.readFileSync(path.join(ROOT, "api", "index.js"), "utf8");
  const destructured = [...source.matchAll(/const\s*\{([^}]+)\}\s*=\s*require\("\.\.\/index\.js"\)/g)]
    .flatMap((m) => m[1].split(",").map((n) => n.trim()).filter(Boolean));
  for (const name of destructured) {
    assert.equal(
      typeof index[name],
      "function",
      `api/index.js imports ${name}, which index.js no longer exports — the deployment would 500`,
    );
  }
});

// ------------------------------------------------------------
// Static-deployment safety
//
// aternosminecraftserverbot.vercel.app was a *static* project: with no
// function and no index.html, "/" resolved to index.js and the whole
// source was served as text. These tests make sure the repo can never
// present itself that way again.
// ------------------------------------------------------------

test("17. a static deployment shows a page, never source code", async () => {
  const html = fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8");
  assert.ok(html.includes("/status/light"), "it must try the live API first");
  assert.match(html, /static|serverless/i, "and explain itself when there is none");
  assert.match(html, /BOT_BACKEND_URL/);
  // Self-contained: no build step, no CDN, no missing assets in a bare deploy.
  assert.ok(!/<script[^>]+src=/i.test(html), "no external scripts");
  assert.ok(!/<link[^>]+href="http/i.test(html), "no external stylesheets");
  // It must never look like a JS file.
  assert.ok(!/^\s*("use strict"|const |function \w+\()/.test(html));
});

test("18. a root-served static deployment gets the page too", () => {
  // Vercel can serve the repository root directly (no outputDirectory honoured)
  // when a project was created as a static site. Without a root index.html,
  // "/" resolves to the first file alphabetically -- index.js.
  const rootPage = path.join(ROOT, "index.html");
  assert.ok(fs.existsSync(rootPage), "the repo root needs an index.html for static hosting");
  assert.equal(
    fs.readFileSync(rootPage, "utf8"),
    fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8"),
    "root and public/ copies must not drift",
  );
  const html = fs.readFileSync(rootPage, "utf8");
  assert.ok(!/<script[^>]+src=/i.test(html), "no external scripts");
  assert.ok(html.includes("/status/light"), "it queries the live API");
});

test("19. nothing at the web root can serve a source file", () => {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));

  // The static output directory must exist and contain ONLY the shell page.
  // Everything else in the repo (index.js, settings.json, ...) then has no URL
  // at all -- this is what stops the old "raw index.js at /" behaviour.
  assert.equal(config.outputDirectory, "public");
  const published = fs.readdirSync(path.join(ROOT, "public"));
  assert.deepEqual(published, ["index.html"], `public/ must stay a single page, found ${published.join(", ")}`);
  // ...and the root copy is the same file, so neither can be replaced by source.
  assert.equal(
    fs.readFileSync(path.join(ROOT, "index.html"), "utf8"),
    fs.readFileSync(path.join(ROOT, "public", "index.html"), "utf8"),
  );

  // No source file or config may live there.
  const forbidden = ["index.js", "settings.json", "package.json", "api", "tests", "node_modules", ".env"];
  for (const name of forbidden) {
    assert.ok(
      !published.includes(name),
      `public/${name} would be downloadable by anyone`,
    );
  }

  // And the function stays declared: a static-only project has no rewrite at
  // all, which is exactly how the old deployment broke.
  assert.ok(config.functions["api/index.js"], "the function must be declared");
  assert.equal(config.framework, null, "framework:null keeps Vercel from guessing a static build");
});

run("serverless");
