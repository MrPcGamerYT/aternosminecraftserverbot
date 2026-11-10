"use strict";

// ============================================================
// tests/test-envfile.js — variables without a Variables tab
//
//   npm run test:envfile   (9 tests)
//
// SillyDev's panel does not always expose environment variables,
// and a Pterodactyl startup tab is easy to lose. A `.env` file in
// the project root has to do the whole job then: parse sanely,
// never throw on junk, and never override a real panel variable.
// ============================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const { test, run, assert } = require("./harness");

const { parseEnv, loadEnvFile } = require("../envfile.js");
const index = require("../index.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "afk-env-"));

test("1. plain KEY=value lines are parsed", () => {
  const parsed = parseEnv("DASHBOARD_PATH=my-bot\nTZ=Asia/Kolkata\n");
  assert.equal(parsed.DASHBOARD_PATH, "my-bot");
  assert.equal(parsed.TZ, "Asia/Kolkata");
});

test("2. comments, blanks, export and quotes are handled", () => {
  const parsed = parseEnv(
    ["# a comment", "", "export DASHBOARD_PASSWORD=\"p@ss word\"", "NODE_OPTIONS='--max-old-space-size=192'", "TZ=UTC # trailing"].join("\n"),
  );
  assert.equal(parsed.DASHBOARD_PASSWORD, "p@ss word");
  assert.equal(parsed.NODE_OPTIONS, "--max-old-space-size=192");
  assert.equal(parsed.TZ, "UTC");
  assert.equal(Object.keys(parsed).length, 3);
});

test("3. junk lines are skipped, not fatal", () => {
  const parsed = parseEnv("this is not a variable\n=novalue\n9BAD=1\nGOOD=1\n");
  assert.equal(parsed.GOOD, "1");
  assert.equal(parsed["9BAD"], undefined);
  assert.deepEqual(parseEnv(""), {});
  assert.deepEqual(parseEnv(null), {});
  assert.deepEqual(parseEnv(undefined), {});
});

test("4. a real variable always beats the file", () => {
  const dir = tmp();
  const file = path.join(dir, ".env");
  fs.writeFileSync(file, "DASHBOARD_PATH=from-file\nTZ=Asia/Kolkata\n");
  const env = { DASHBOARD_PATH: "from-panel" };
  const result = loadEnvFile(file, env);
  assert.equal(env.DASHBOARD_PATH, "from-panel", "the panel wins");
  assert.equal(env.TZ, "Asia/Kolkata", "the file fills the gap");
  assert.equal(result.loaded, 1);
  assert.deepEqual(result.keys, ["TZ"]);
});

test("5. a missing or unreadable file is not an error", () => {
  const missing = loadEnvFile(path.join(tmp(), ".env"), {});
  assert.equal(missing.loaded, 0);
  const boom = {
    existsSync: () => true,
    readFileSync: () => {
      throw new Error("EACCES");
    },
  };
  assert.equal(loadEnvFile("/nope/.env", {}, boom).loaded, 0);
});

test("6. settings.json can carry the dashboard instead of env vars", () => {
  const saved = JSON.parse(JSON.stringify(index.config.dashboard || {}));
  try {
    index.config.dashboard = { path: "file-link-91", password: "", user: "boss" };
    const resolved = index.resolveDashboard({});
    assert.equal(resolved.path, "file-link-91");
    assert.equal(resolved.user, "boss");
    assert.equal(resolved.password, "");

    // env still wins when it exists
    assert.equal(index.resolveDashboard({ DASHBOARD_PATH: "env-link" }).path, "env-link");

    // and the guards are built from the file when there is no env
    assert.ok(index.dashboardPathGuard({}), "a guard should exist from settings.json");
    const req = { path: "/file-link-91", url: "/file-link-91" };
    let passed = false;
    index.dashboardPathGuard({})(req, { status: () => ({ type: () => ({ send: () => {} }) }) }, () => {
      passed = true;
    });
    assert.equal(passed, true);
  } finally {
    index.config.dashboard = saved;
  }
});

test("7. a password in settings.json still turns on basic auth", () => {
  const saved = JSON.parse(JSON.stringify(index.config.dashboard || {}));
  try {
    index.config.dashboard = { path: "", password: "from-file-pw", user: "admin" };
    assert.ok(index.dashboardAuth({}), "a password in settings.json must arm the middleware");

    // an env var of the same name still wins over the file
    index.config.dashboard = { password: "from-file" };
    assert.equal(index.resolveDashboard({ DASHBOARD_PASSWORD: "from-env" }).password, "from-env");

    // and no password anywhere keeps the dashboard open, as before
    index.config.dashboard = { password: "" };
    assert.equal(index.dashboardAuth({}), null);
  } finally {
    index.config.dashboard = saved;
  }
});

test("8. the dashboard port can be pinned in settings.json", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  // resolveHttpPort is exported; drive it directly rather than guessing.
  const index = require("../index.js");
  assert.equal(typeof index.resolveHttpPort, "function");

  const saved = JSON.parse(JSON.stringify(index.config.dashboard || {}));
  try {
    index.config.dashboard = { port: 10108 };
    assert.equal(index.resolveHttpPort({}), 10108, "settings.json is the last resort, not the first");

    assert.equal(index.resolveHttpPort({ SERVER_PORT: "7000" }), 7000, "the panel's port wins");
    assert.equal(index.resolveHttpPort({ PORT: "8080", SERVER_PORT: "7000" }), 8080, "PORT wins over SERVER_PORT");

    index.config.dashboard = {};
    assert.equal(index.resolveHttpPort({}), 5000, "no hint at all means 5000");
  } finally {
    index.config.dashboard = saved;
  }
  assert.ok(/fromSettings/.test(source) || /config\.dashboard/.test(source));
});

test("9. timezone from settings.json is applied before the first Date", () => {
  // Node caches the zone on first use, so this must happen at module load.
  const { execFileSync } = require("child_process");
  const path = require("path");
  const out = execFileSync(
    process.execPath,
    ["-e", "require('./index.js'); console.log(process.env.TZ + '|' + new Date().getTimezoneOffset());"],
    { cwd: path.join(__dirname, ".."), env: { ...process.env, TZ: "" }, encoding: "utf8" },
  ).trim();
  assert.equal(out, "Asia/Kolkata|-330", out);
});

run("envfile");
