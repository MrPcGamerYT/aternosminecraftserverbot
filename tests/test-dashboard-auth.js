"use strict";

// ============================================================
// tests/test-dashboard-auth.js — optional password on the dashboard
//
//   npm run test:dashboard-auth   (6 tests)
//
// A panel host publishes the assigned port on the plain internet,
// so the dashboard is one URL away from anyone: Stop, logs, and
// `/command` inside the Minecraft session. DASHBOARD_PASSWORD
// turns on HTTP basic auth; leaving it unset keeps the old
// behaviour, so nothing changes for local/Render use.
// ============================================================

const { test, run, assert } = require("./harness");

const { dashboardAuth } = require("../index.js");

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

run("dashboard auth");
