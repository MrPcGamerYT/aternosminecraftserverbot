"use strict";

// ============================================================
// tests/test-envfile.js — variables without a Variables tab
//
//   npm run test:envfile   (7 tests)
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

run("envfile");
