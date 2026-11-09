"use strict";

// ============================================================
// tests/test-single-host.js — one host really is enough
//
//   npm run test:single-host   (12 tests)
//
// The README promises that an always-on host runs the whole app:
// dashboard, controls and bot in ONE process, with nothing else to
// deploy. These tests check the deployment files actually describe
// that, so a future edit cannot quietly reintroduce a mandatory
// second service (or a paid plan where a free one works).
// ============================================================

const fs = require("fs");
const path = require("path");
const { test, run, assert } = require("./harness");

const root = path.join(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

const renderYaml = read("render.yaml");
const procfile = read("Procfile");
const dockerfile = read("Dockerfile");
const nixpacks = read("nixpacks.toml");
const pkg = JSON.parse(read("package.json"));

// Strip comments so prose about Render's limits never satisfies a check.
const renderBody = renderYaml
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

/** Value of a top-level-ish `key: value` line in a YAML service block. */
function yamlValue(body, key) {
  const match = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "m").exec(body);
  return match ? match[1].replace(/^["']|["']$/g, "") : null;
}

test("render.yaml declares exactly one service", () => {
  const services = renderBody.match(/^\s*-\s*type:\s*web\s*$/gm) || [];
  assert.equal(services.length, 1, `expected 1 web service, found ${services.length}`);
  // No background workers / cron jobs: the bot is the web process.
  assert.ok(!/^\s*(type:\s*worker|type:\s*cron)/m.test(renderBody), "no extra service types");
});

test("render.yaml stays on the free plan", () => {
  assert.equal(yamlValue(renderBody, "plan"), "free");
});

test("render.yaml runs one instance", () => {
  assert.equal(yamlValue(renderBody, "numInstances"), "1");
});

test("render.yaml starts the same process that serves the dashboard", () => {
  const start = yamlValue(renderBody, "startCommand");
  assert.ok(start, "startCommand missing");
  assert.ok(/node\s+index\.js/.test(start), `startCommand is ${start}`);
  // package.json's start script must agree, so a platform that ignores
  // startCommand still gets the single-process app.
  assert.ok(/node\s+index\.js/.test(pkg.scripts.start));
});

test("render.yaml does not require a second host", () => {
  assert.ok(/BOT_BACKEND_URL/.test(renderBody), "BOT_BACKEND_URL should be documented in the blueprint");
  // Every BOT_BACKEND_URL entry must be explicitly empty.
  const entries = renderBody.split(/-\s*key:\s*/).filter((chunk) => chunk.startsWith("BOT_BACKEND_URL"));
  assert.ok(entries.length >= 1, "BOT_BACKEND_URL entry missing");
  for (const entry of entries) {
    const value = /value:\s*(.*)/.exec(entry);
    assert.ok(value, "BOT_BACKEND_URL has no value line");
    assert.equal(value[1].trim().replace(/^["']|["']$/g, ""), "", "BOT_BACKEND_URL must be empty on a single-host deploy");
  }
});

test("render.yaml caps the V8 heap below the 512 MB free instance", () => {
  const match = /NODE_OPTIONS[^\n]*\n\s*value:\s*"([^"]+)"/.exec(renderBody);
  assert.ok(match, "NODE_OPTIONS not set");
  const heap = /--max-old-space-size=(\d+)/.exec(match[1]);
  assert.ok(heap, `no heap cap in ${match[1]}`);
  const mb = Number(heap[1]);
  assert.ok(mb >= 256 && mb < 512, `heap cap ${mb} MB should leave headroom inside 512 MB`);
});

test("render.yaml pings itself faster than Render's 15-minute spin-down", () => {
  const match = /SELF_PING_INTERVAL_MS[^\n]*\n\s*value:\s*"([^"]+)"/.exec(renderBody);
  assert.ok(match, "SELF_PING_INTERVAL_MS not set");
  const interval = Number(match[1]);
  assert.ok(Number.isFinite(interval), "interval is not a number");
  assert.ok(interval > 0 && interval < 15 * 60_000, `${interval}ms must be under 900000ms`);
});

test("render.yaml health-checks a real endpoint", () => {
  assert.equal(yamlValue(renderBody, "healthCheckPath"), "/health");
});

test("Procfile and nixpacks both run the single process", () => {
  assert.ok(/^web:\s*node\s+index\.js\s*$/m.test(procfile), procfile.trim());
  const cmd = /\[start\][\s\S]*?cmd\s*=\s*"([^"]+)"/.exec(nixpacks);
  assert.ok(cmd, "nixpacks [start] cmd missing");
  assert.ok(/node\s+index\.js/.test(cmd[1]), cmd[1]);
});

test("Dockerfile exposes the port the app actually binds", () => {
  const exposed = /EXPOSE\s+(\d+)/.exec(dockerfile);
  assert.ok(exposed, "EXPOSE missing");
  assert.ok(/node/i.test(/CMD\s*(\[[^\]]+\]|.+)/.exec(dockerfile)[1]), "CMD should run node");
  // index.js falls back to 5000 when PORT is unset; the image sets PORT.
  const envPort = /ENV[\s\S]*?PORT=(\d+)/.exec(dockerfile);
  assert.ok(envPort, "PORT not set in the image");
  assert.equal(envPort[1], exposed[1], "EXPOSE and PORT disagree");
  assert.equal(exposed[1], "5000");
});

test("Dockerfile health check hits the keep-alive endpoint", () => {
  assert.ok(/HEALTHCHECK[\s\S]*?\/ping/.test(dockerfile), "HEALTHCHECK should use /ping");
});

test("serverless remains optional, never required", () => {
  const vercel = JSON.parse(read("vercel.json"));
  // Vercel is a dashboard-only entry point: it must not claim to run a bot.
  assert.ok(vercel.rewrites.some((rule) => /api\/index\.js/.test(rule.destination)));
  const entry = read("api/index.js");
  assert.ok(!/runCycle\(|createBot\(/.test(entry), "api/index.js must not start a bot");
});

run("single-host deploy");
