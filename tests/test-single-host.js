"use strict";

// ============================================================
// tests/test-single-host.js — one host really is enough
//
//   npm run test:single-host   (19 tests)
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

const compose = read("docker-compose.yml");
const unit = read("deploy/minecraft-afk-bot.service");
const vmScript = read("deploy/vm-install.sh");
const termuxScript = read("deploy/termux-install.sh");
const freeHosts = read("deploy/free-hosts.md");

test("docker-compose is one auto-restarting container with a real healthcheck", () => {
  const services = compose.match(/^\s{2}[a-z0-9-]+:\s*$/gm) || [];
  assert.equal(services.length, 1, `expected 1 compose service, found ${services.length}`);
  assert.ok(/restart:\s*always/.test(compose), "restart: always is what makes a VM 24/7");
  assert.ok(/\/ping/.test(compose), "healthcheck should hit /ping");
  assert.ok(/"5000:5000"/.test(compose), "the dashboard port should be published");
  assert.ok(!/BOT_BACKEND_URL:/.test(compose), "a single-host deploy must not proxy");
});

test("systemd unit restarts forever and stops cleanly", () => {
  assert.ok(/^\[Unit\]/m.test(unit) && /^\[Service\]/m.test(unit) && /^\[Install\]/m.test(unit));
  assert.ok(/^Restart=always$/m.test(unit), "Restart=always missing");
  assert.ok(/^ExecStart=\/usr\/bin\/node index\.js$/m.test(unit), "ExecStart should run index.js");
  assert.ok(/^WorkingDirectory=\/opt\/minecraft-afk-bot$/m.test(unit));
  assert.ok(/^KillSignal=SIGTERM$/m.test(unit), "SIGTERM lets the bot quit the game");
});

test("vm-install.sh installs Node 20 and enables the unit", () => {
  assert.ok(/^#!\/usr\/bin\/env bash/.test(vmScript));
  assert.ok(/set -euo pipefail/.test(vmScript));
  assert.ok(/NODE_MAJOR="20"/.test(vmScript));
  assert.ok(/npm ci --omit=dev \|\| npm install --omit=dev/.test(vmScript));
  assert.ok(/systemctl enable --now minecraft-afk-bot/.test(vmScript));
});

test("termux-install.sh takes a wake-lock before it hands the bot over", () => {
  assert.ok(/com\.termux/.test(termuxScript), "shebang should be Termux's bash");
  assert.ok(/pkg install -y nodejs-lts/.test(termuxScript));
  assert.ok(/termux-wake-lock/.test(termuxScript), "without a wake-lock Android freezes the bot");
  assert.ok(/npm ci --omit=dev \|\| npm install --omit=dev/.test(termuxScript));
});

test("the free-host guide covers every supported shape and the suspension cause", () => {
  for (const host of ["bot panel", "Oracle", "Termux", "VPS"]) {
    assert.ok(new RegExp(host, "i").test(freeHosts), `free-hosts.md should cover ${host}`);
  }
  assert.ok(/spins? down|spin-down/i.test(freeHosts), "it should explain the spin-down trap");
  assert.ok(/second account|three accounts|ban evasion/i.test(freeHosts), "it should warn against multi-accounting");
  // Every artifact it points at must exist.
  for (const file of ["docker-compose.yml", "deploy/minecraft-afk-bot.service", "deploy/vm-install.sh", "deploy/termux-install.sh"]) {
    assert.ok(fs.existsSync(path.join(root, file)), `${file} is referenced but missing`);
  }
});

test("the app binds the port a panel host assigns (SERVER_PORT)", () => {
  const { resolveHttpPort } = require("../index.js");
  assert.equal(resolveHttpPort({ SERVER_PORT: "32728" }), 32728, "Botkeep/Pterodactyl pass SERVER_PORT");
  assert.equal(resolveHttpPort({ PORT: "8080" }), 8080);
  assert.equal(resolveHttpPort({ PORT: "3000", SERVER_PORT: "32728" }), 3000, "explicit PORT wins");
  assert.equal(resolveHttpPort({}), 5000, "local default");
  assert.equal(resolveHttpPort({ PORT: "nope", SERVER_PORT: "x" }), 5000, "garbage falls back");
});

test("the Botkeep guide matches what the panel actually needs", () => {
  assert.ok(/Botkeep/.test(freeHosts), "the guide should cover Botkeep");
  assert.ok(/SERVER_PORT/.test(freeHosts), "it should explain the assigned port");
  assert.ok(/npm start/.test(freeHosts), "start command the panel runs");
  assert.ok(/max-old-space-size/.test(freeHosts), "heap cap for the 512 MB pool");
  assert.ok(/package\.json at the archive root|package\.json`? at the archive root/i.test(freeHosts),
    "ZIP root requirement is what makes an upload fail silently");
});

run("single-host deploy");
