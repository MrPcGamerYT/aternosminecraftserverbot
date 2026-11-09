"use strict";

// ============================================================
// tests/test-doctor.js — the pre-flight check itself
//
//   npm run test:doctor   (8 tests)
//
// doctor.js is what a user runs when "it did not start" and the
// only feedback is a panel console. Every failure mode it claims
// to detect is exercised here against a throwaway directory, so
// the advice cannot rot into a lie.
// ============================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const { test, run, assert } = require("./harness");

const { runChecks, format, nodeMajor, REQUIRED_FILES } = require("../doctor.js");

const root = path.join(__dirname, "..");

/** A temp project root, optionally populated. */
function sandbox(files = {}, dirs = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "afk-doctor-"));
  for (const name of dirs) fs.mkdirSync(path.join(dir, name), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const GOOD_SETTINGS = JSON.stringify({
  "bot-account": { username: "OfflinePlayer", type: "offline" },
  server: { ip: "example.aternos.me", port: 39033, version: "1.21.1" },
  utils: { watchdog: { enabled: true, "silence-timeout": 90000, "spawn-timeout": 120000 } },
});

const ALL_FILES = Object.fromEntries(REQUIRED_FILES.map((name) => [name, name === "settings.json" ? GOOD_SETTINGS : ""]));

const statusOf = (result, name) =>
  result.checks.filter((check) => check.name === name).map((check) => check.status);

test("1. the real checkout passes its own pre-flight", () => {
  const result = runChecks({ root });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  assert.equal(statusOf(result, "Dependencies")[0], "ok", "run npm install first");
  assert.equal(statusOf(result, "Minecraft target")[0], "ok");
  assert.equal(statusOf(result, "Account")[0], "ok");
});

test("2. a ZIP that unzipped into an extra folder is explained, not just rejected", () => {
  const dir = sandbox({ "aternosminecraftserverbot-main/package.json": "{}" });
  const result = runChecks({ root: dir });
  assert.equal(result.ok, false);
  const details = result.checks.map((c) => `${c.name}: ${c.detail}`).join("\n");
  assert.ok(/flatten it/.test(details), details);
  assert.ok(/aternosminecraftserverbot-main/.test(details));
});

test("3. missing node_modules points at the exact command", () => {
  const dir = sandbox(ALL_FILES);
  const result = runChecks({ root: dir });
  const deps = result.checks.find((c) => c.name === "Dependencies");
  assert.equal(deps.status, "fail");
  assert.ok(/npm install --omit=dev/.test(deps.detail), deps.detail);
});

test("4. broken settings.json and a dead target are both reported", () => {
  const badJson = sandbox({ ...ALL_FILES, "settings.json": "{ not json" });
  const broken = runChecks({ root: badJson });
  assert.ok(broken.checks.some((c) => c.name === "settings.json" && /invalid JSON/.test(c.detail)));

  const noTarget = sandbox({
    ...ALL_FILES,
    "settings.json": JSON.stringify({ "bot-account": { username: "x", type: "offline" }, server: {} }),
  });
  const empty = runChecks({ root: noTarget });
  assert.equal(empty.ok, false);
  assert.ok(empty.checks.some((c) => c.name === "Minecraft target" && c.status === "fail"));
  assert.ok(empty.checks.some((c) => c.name === "Account" && c.status === "ok"));
});

test("5. Node 18 fails, Node 25 warns, Node 20-22 pass", () => {
  const dir = sandbox(ALL_FILES);
  const detail = (version) => runChecks({ root: dir, nodeVersion: version }).checks.find((c) => c.name === "Node version");

  assert.equal(detail("v18.19.0").status, "fail");
  assert.equal(detail("v20.11.0").status, "ok");
  assert.equal(detail("v22.22.0").status, "ok");
  assert.equal(detail("v25.9.0").status, "warn");
  assert.equal(nodeMajor("v22.22.0"), 22);
  assert.ok(Number.isNaN(nodeMajor("nope")));
});

test("6. the panel's SERVER_PORT is the port it reports", () => {
  const dir = sandbox(ALL_FILES);
  const panel = runChecks({ root: dir, env: { SERVER_PORT: "6158" } });
  const port = panel.checks.find((c) => c.name === "Dashboard port");
  assert.ok(/6158/.test(port.detail), port.detail);
  assert.ok(/SERVER_PORT/.test(port.detail));

  const local = runChecks({ root: dir, env: {} });
  assert.ok(/5000/.test(local.checks.find((c) => c.name === "Dashboard port").detail));
});

test("7. Vercel without a backend is a hard failure, and the summary says so", () => {
  // The real checkout, so "dependencies resolved" is not what fails here.
  const vercel = runChecks({ root, env: { VERCEL: "1" } });
  assert.equal(vercel.ok, false);
  assert.ok(/BOT_BACKEND_URL/.test(vercel.checks.find((c) => c.name === "Host").detail));

  const proxied = runChecks({ root, env: { VERCEL: "1", BOT_BACKEND_URL: "https://bot.example.com" } });
  assert.equal(proxied.ok, true);

  assert.ok(/problem/.test(format(vercel)), "a failing run must say what to do");
  assert.ok(/Ready to start/.test(format(runChecks({ root }))));
});

test("8. a half-written install is caught at load time, not at login", () => {
  // Resolving a package only proves the folder exists. This reproduces the
  // real failure: minecraft-data missing a data file, mineflayer throwing on
  // require, discovered only after the bot tries to log in.
  const stub = (body) => JSON.stringify({ name: "stub", version: "1.0.0", main: "index.js" });
  const dir = sandbox(
    {
      ...ALL_FILES,
      "node_modules/express/package.json": stub(),
      "node_modules/express/index.js": "module.exports = {};",
      "node_modules/minecraft-data/package.json": stub(),
      "node_modules/minecraft-data/index.js": "module.exports = {};",
      "node_modules/mineflayer/package.json": stub(),
      "node_modules/mineflayer/index.js":
        "throw new Error(\"Cannot find module '../minecraft-data/data/pc/common/features.json'\");",
    },
  );

  const result = runChecks({ root: dir });
  const deps = result.checks.find((c) => c.name === "Dependencies");
  const loads = result.checks.find((c) => c.name === "Mineflayer loads");
  assert.equal(deps.status, "ok", "the folder exists, so this check passes");
  assert.equal(loads.status, "fail", "but requiring it must fail");
  assert.ok(/features\.json/.test(loads.detail), loads.detail);
  assert.ok(/npm run repair/.test(loads.detail), loads.detail);
  assert.equal(result.ok, false);
});

run("doctor");
