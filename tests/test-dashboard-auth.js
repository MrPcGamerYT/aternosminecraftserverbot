"use strict";

// ============================================================
// tests/test-dashboard-auth.js — optional password on the dashboard
//
//   npm run test:dashboard-auth   (9 tests)
//
// A panel host publishes the assigned port on the plain internet,
// so the dashboard is one URL away from anyone: Stop, logs, and
// `/command` inside the Minecraft session. DASHBOARD_PASSWORD
// turns on HTTP basic auth; leaving it unset keeps the old
// behaviour, so nothing changes for local/Render use.
// ============================================================

const { test, run, assert } = require("./harness");

const { dashboardAuth, dashboardPathGuard } = require("../index.js");

/** Minimal express req/res doubles. */
function fakeReq(path, authorization) {
  return { path, headers: authorization ? { authorization } : {} };
}

function fakeRes() {
  const res = {
    statusCode: null,
    headers: {},
    body: null,
    set(key, value) {
      this.headers[key.toLowerCase()] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    type() {
      return this;
    },
    send(body) {
      this.body = body;
      return this;
    },
  };
  return res;
}

/** Run the middleware; returns what happened. */
function call(middleware, req) {
  const res = fakeRes();
  let passed = false;
  middleware(req, res, (...args) => {
    if (args.length === 0) passed = true;
  });
  return { res, passed };
}

const basic = (user, pass) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;

test("1. no DASHBOARD_PASSWORD means no middleware at all", () => {
  assert.equal(dashboardAuth({}), null);
  assert.equal(dashboardAuth({ DASHBOARD_PASSWORD: "   " }), null, "whitespace is not a password");
});

test("2. a protected dashboard challenges, then accepts the right password", () => {
  const mw = dashboardAuth({ DASHBOARD_PASSWORD: "s3cret" });

  const denied = call(mw, fakeReq("/"));
  assert.equal(denied.passed, false);
  assert.equal(denied.res.statusCode, 401);
  assert.ok(/^Basic realm=/.test(denied.res.headers["www-authenticate"]), "the browser needs a challenge");

  const allowed = call(mw, fakeReq("/", basic("admin", "s3cret")));
  assert.equal(allowed.passed, true);
  assert.equal(allowed.res.statusCode, null);
});

test("3. the wrong password, the wrong user, and garbage all stay 401", () => {
  const mw = dashboardAuth({ DASHBOARD_PASSWORD: "s3cret" });

  assert.equal(call(mw, fakeReq("/", basic("admin", "wrong"))).passed, false);
  assert.equal(call(mw, fakeReq("/", basic("root", "s3cret"))).passed, false);
  assert.equal(call(mw, fakeReq("/", "Basic not-base64!!")).passed, false);
  assert.equal(call(mw, fakeReq("/", "Bearer s3cret")).passed, false, "only basic auth counts");
  // base64 that decodes to something without a colon
  assert.equal(call(mw, fakeReq("/", `Basic ${Buffer.from("nocolon").toString("base64")}`)).passed, false);
});

test("4. DASHBOARD_USER changes the user name", () => {
  const mw = dashboardAuth({ DASHBOARD_PASSWORD: "pw", DASHBOARD_USER: "afk" });
  assert.equal(call(mw, fakeReq("/", basic("afk", "pw"))).passed, true);
  assert.equal(call(mw, fakeReq("/", basic("admin", "pw"))).passed, false);
});

test("5. health, ping and mirror stay open so the host and peers keep working", () => {
  const mw = dashboardAuth({ DASHBOARD_PASSWORD: "s3cret" });
  for (const path of ["/ping", "/health", "/mirror/status"]) {
    const { passed, res } = call(mw, fakeReq(path));
    assert.equal(passed, true, `${path} must not require a password`);
    assert.equal(res.statusCode, null);
  }
  // ...but the pages behind it do
  for (const path of ["/", "/logs", "/tutorial", "/status/light"]) {
    assert.equal(call(mw, fakeReq(path)).passed, false, `${path} must be protected`);
  }
});

test("6. tricky passwords work, and surrounding whitespace is trimmed", () => {
  for (const pass of ["a:b", "pässwörd", "🔒🔒"]) {
    const mw = dashboardAuth({ DASHBOARD_PASSWORD: pass });
    assert.equal(call(mw, fakeReq("/", basic("admin", pass))).passed, true, `failed for ${pass}`);
  }
  // Env vars pick up stray spaces easily; trimming is the friendlier default,
  // and the docs say so.
  const mw = dashboardAuth({ DASHBOARD_PASSWORD: "  spaced  " });
  assert.equal(call(mw, fakeReq("/", basic("admin", "spaced"))).passed, true);
  assert.equal(call(mw, fakeReq("/", basic("admin", "  spaced  "))).passed, false);
});

test("7. a secret path hides the dashboard and rewrites the real route", () => {
  const guard = dashboardPathGuard({ DASHBOARD_PATH: "my-bot-7f3a" });
  assert.ok(guard, "a path was configured, so a guard must exist");

  const root = call(guard, { path: "/", url: "/" });
  assert.equal(root.passed, false, "the root must not serve the dashboard");
  assert.equal(root.res.statusCode, 404);
  assert.equal(root.res.body, "Not found", "no hint about what lives here");

  const wrong = call(guard, { path: "/admin", url: "/admin" });
  assert.equal(wrong.res.statusCode, 404);

  const right = { path: "/my-bot-7f3a/status", url: "/my-bot-7f3a/status?light=1" };
  const okCall = call(guard, right);
  assert.equal(okCall.passed, true);
  assert.equal(right.url, "/status?light=1", "the prefix is stripped, the query survives");

  const bare = { path: "/my-bot-7f3a", url: "/my-bot-7f3a" };
  call(guard, bare);
  assert.equal(bare.url, "/", "the bare link is the dashboard");
});

test("8. health endpoints stay at the root so panels keep working", () => {
  const guard = dashboardPathGuard({ DASHBOARD_PATH: "secret4" });
  for (const path of ["/health", "/ping", "/mirror/status"]) {
    const result = call(guard, { path, url: path });
    assert.equal(result.passed, true, `${path} must not be hidden`);
  }
});

test("9. no path configured means no guard, and slashes are normalised", () => {
  assert.equal(dashboardPathGuard({}), null);
  assert.equal(dashboardPathGuard({ DASHBOARD_PATH: "   " }), null);
  assert.equal(dashboardPathGuard({ DASHBOARD_PATH: "/" }), null, "a bare slash is not a secret");

  const guard = dashboardPathGuard({ DASHBOARD_PATH: "/deep/link/" });
  const right = { path: "/deep/link", url: "/deep/link" };
  assert.equal(call(guard, right).passed, true);
  assert.equal(right.url, "/");
  assert.equal(call(guard, { path: "/deep", url: "/deep" }).res.statusCode, 404);
});

run("dashboard auth");
