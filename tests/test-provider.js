"use strict";

// ============================================================
// tests/test-provider.js — provider.js (exaroton) contract
//
//   npm run test:provider   (21 tests)
//
// A stub HTTP server plays api.exaroton.com so the real request
// code path runs. Nothing here touches the network.
// ============================================================

const http = require("http");
const { test, run, assert } = require("./harness");

const providerModule = require("../provider.js");

const TOKEN = "exaroton-SECRET-TOKEN-abc123";

function startApi(handler) {
  return new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        calls.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: body ? JSON.parse(body) : null,
        });
        handler(req, res, calls[calls.length - 1]);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        server,
        calls,
        port,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function json(res, code, payload) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

const SERVER_PAYLOAD = {
  success: true,
  data: {
    id: "AbCd1234",
    name: "My Server",
    status: 1,
    address: "my-server.exaroton.me",
    software: { id: "paper", name: "Paper" },
    version: { id: "1.21.1", name: "1.21.1" },
    players: { count: 3, max: 20, list: ["Alice", "Bob", "Carol"], port: 25565 },
  },
};

// ------------------------------------------------------------
// Status mapping
// ------------------------------------------------------------

test("1. every exaroton status code 0..10 maps to a label", () => {
  const expected = {
    0: "Offline",
    1: "Online",
    2: "Starting",
    3: "Stopping",
    4: "Restarting",
    5: "Saving",
    6: "Loading",
    7: "Crashed",
    8: "Pending",
    9: "Transferring",
    10: "Preparing",
  };
  for (const [code, label] of Object.entries(expected)) {
    assert.equal(providerModule.statusToLabel(Number(code)), label, `status ${code}`);
  }
});

test("2. unknown statuses degrade gracefully", () => {
  assert.equal(providerModule.statusToLabel(99), "Status 99");
  assert.equal(providerModule.statusToLabel(null), "Unknown");
  assert.equal(providerModule.statusToLabel(undefined), "Unknown");
  assert.equal(providerModule.statusToLabel("nonsense"), "Unknown");
});

test("3. running / transitional classification", () => {
  assert.equal(providerModule.isRunning(1), true);
  assert.equal(providerModule.isRunning(0), false);
  assert.equal(providerModule.isRunning(7), false);

  for (const code of [2, 3, 4, 5, 6, 8, 9, 10]) {
    assert.equal(providerModule.isTransitional(code), true, `status ${code} should be transitional`);
  }
  assert.equal(providerModule.isTransitional(0), false);
  assert.equal(providerModule.isTransitional(1), false);
});

// ------------------------------------------------------------
// Configuration & secrets
// ------------------------------------------------------------

test("4. the token is read from EXAROTON_TOKEN only", () => {
  assert.equal(providerModule.getToken({ EXAROTON_TOKEN: TOKEN }), TOKEN);
  assert.equal(providerModule.getToken({}), null);
  assert.equal(providerModule.getToken({ EXAROTON_TOKEN: "   " }), null);

  // a token placed in settings.json is ignored — it must never live there
  const config = { provider: { "exaroton-token": "settings-token-must-be-ignored" } };
  const client = providerModule.createProvider(config, { EXAROTON_SERVER_ID: "AbCd1234" });
  assert.equal(client.configured, false);
  assert.match(client.missingReason(), /EXAROTON_TOKEN/);
});

test("5. the server id comes from settings or env, env wins", () => {
  const config = { provider: { "exaroton-server-id": "FromSettings" } };
  assert.equal(providerModule.getServerId(config, {}), "FromSettings");
  assert.equal(providerModule.getServerId(config, { EXAROTON_SERVER_ID: "FromEnv" }), "FromEnv");
  assert.equal(providerModule.getServerId({}, {}), null);
  assert.equal(providerModule.getServerId({ provider: { "exaroton-server-id": "  " } }, {}), null);
});

test("6. EXAROTON_BASE_URL is honoured as written (http stays http)", () => {
  assert.equal(providerModule.getBaseUrl({}), "https://api.exaroton.com/v1");
  assert.equal(
    providerModule.getBaseUrl({ EXAROTON_BASE_URL: "http://localhost:8080/v1/" }),
    "http://localhost:8080/v1",
  );
  assert.equal(
    providerModule.getBaseUrl({ EXAROTON_BASE_URL: "https://eu.api.exaroton.com/v1" }),
    "https://eu.api.exaroton.com/v1",
  );
});

test("7. tokens are scrubbed from arbitrary text", () => {
  const scrubbed = providerModule.scrubSecrets(`failed with ${TOKEN} oops`, TOKEN);
  assert.ok(!scrubbed.includes(TOKEN));
  assert.match(scrubbed, /\[redacted\]/);

  assert.match(providerModule.scrubSecrets("Authorization: Bearer abc.def-ghi", TOKEN), /\[redacted\]/);
  assert.match(providerModule.scrubSecrets("https://x/y?token=hunter2", TOKEN), /token=\[redacted\]/);
  assert.equal(providerModule.scrubSecrets(null, TOKEN), "");
});

// ------------------------------------------------------------
// Unconfigured behaviour
// ------------------------------------------------------------

test("8. an unconfigured provider reports that honestly", async () => {
  const client = providerModule.createProvider({ provider: {} }, {});
  assert.equal(client.configured, false);
  assert.equal(client.enabled, true);
  assert.match(client.missingReason(), /EXAROTON_TOKEN/);

  const status = await client.getStatus();
  assert.equal(status.ok, false);
  assert.equal(status.configured, false);
  assert.equal(status.server, null);
  assert.ok(status.error);

  const start = await client.start();
  assert.equal(start.ok, false);
  assert.equal(start.configured, false);
});

test("9. provider.enabled=false disables the client", async () => {
  const client = providerModule.createProvider(
    { provider: { enabled: false, "exaroton-server-id": "AbCd1234" } },
    { EXAROTON_TOKEN: TOKEN },
  );
  assert.equal(client.configured, false);
  assert.match(client.missingReason(), /disabled/);
});

test("10. the manual fallback is reporting mode and never claims success", () => {
  const fallback = providerModule.reportingFallback("start", { provider: {} }, {});
  assert.equal(fallback.ok, false);
  assert.equal(fallback.mode, "reporting");
  assert.equal(fallback.configured, false);
  assert.equal(fallback.operation, "start");
  assert.match(fallback.error, /start the server/i);
});

// ------------------------------------------------------------
// Live-ish HTTP behaviour against the stub
// ------------------------------------------------------------

test("11. getStatus() calls GET /servers/{id} with a bearer token", async () => {
  const api = await startApi((req, res) => json(res, 200, SERVER_PAYLOAD));
  try {
    const client = providerModule.createProvider(
      { provider: { "exaroton-server-id": "AbCd1234" } },
      { EXAROTON_TOKEN: TOKEN, EXAROTON_BASE_URL: api.baseUrl },
    );
    assert.equal(client.configured, true);

    const result = await client.getStatus();
    assert.equal(result.ok, true);
    assert.equal(api.calls.length, 1);
    assert.equal(api.calls[0].method, "GET");
    assert.equal(api.calls[0].url, "/v1/servers/AbCd1234");
    assert.equal(api.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  } finally {
    await api.close();
  }
});

test("12. getStatus() normalises status, players, address and version", async () => {
  const api = await startApi((req, res) => json(res, 200, SERVER_PAYLOAD));
  try {
    const client = providerModule.createProvider(
      { provider: { "exaroton-server-id": "AbCd1234" } },
      { EXAROTON_TOKEN: TOKEN, EXAROTON_BASE_URL: api.baseUrl },
    );
    const { server } = await client.getStatus();

    assert.equal(server.id, "AbCd1234");
    assert.equal(server.name, "My Server");
    assert.equal(server.status, 1);
    assert.equal(server.statusLabel, "Online");
    assert.equal(server.running, true);
    assert.equal(server.address, "my-server.exaroton.me");
    assert.equal(server.port, 25565);
    assert.equal(server.players.online, 3);
    assert.equal(server.players.max, 20);
    assert.deepEqual(server.players.list, ["Alice", "Bob", "Carol"]);
    assert.equal(server.software.name, "Paper");
    assert.equal(server.version.name, "1.21.1");
  } finally {
    await api.close();
  }
});

test("13. the settings address is used when the API omits one", async () => {
  const api = await startApi((req, res) =>
    json(res, 200, { data: { id: "AbCd1234", status: 0 } }),
  );
  try {
    const client = providerModule.createProvider(
      {
        provider: {
          "exaroton-server-id": "AbCd1234",
          "exaroton-server-address": "fallback.exaroton.me",
        },
      },
      { EXAROTON_TOKEN: TOKEN, EXAROTON_BASE_URL: api.baseUrl },
    );
    const result = await client.getStatus();
    assert.equal(result.ok, true);
    assert.equal(result.server.address, "fallback.exaroton.me");
    assert.equal(result.address, "fallback.exaroton.me");
  } finally {
    await api.close();
  }
});

test("14. start / stop / restart hit POST with the right paths", async () => {
  const api = await startApi((req, res) => json(res, 200, SERVER_PAYLOAD));
  try {
    const client = providerModule.createProvider(
      { provider: { "exaroton-server-id": "AbCd1234" } },
      { EXAROTON_TOKEN: TOKEN, EXAROTON_BASE_URL: api.baseUrl },
    );

    for (const action of ["start", "stop", "restart"]) {
      const result = await client[action]();
      assert.equal(result.ok, true, `${action} should succeed`);
      assert.equal(result.action, action);
    }

    assert.deepEqual(
      api.calls.map((c) => `${c.method} ${c.url}`),
      [
        "POST /v1/servers/AbCd1234/start",
        "POST /v1/servers/AbCd1234/stop",
        "POST /v1/servers/AbCd1234/restart",
      ],
    );
  } finally {
    await api.close();
  }
});

test("15. an API error is surfaced, not swallowed", async () => {
  const api = await startApi((req, res) =>
    json(res, 403, { success: false, error: "Invalid API key" }),
  );
  try {
    const client = providerModule.createProvider(
      { provider: { "exaroton-server-id": "AbCd1234" } },
      { EXAROTON_TOKEN: TOKEN, EXAROTON_BASE_URL: api.baseUrl },
    );

    const status = await client.getStatus();
    assert.equal(status.ok, false);
    assert.equal(status.configured, true);
    assert.equal(status.statusCode, 403);
    assert.equal(status.error, "Invalid API key");
    assert.equal(status.server, null);

    const start = await client.start();
    assert.equal(start.ok, false);
    assert.equal(start.error, "Invalid API key");
  } finally {
    await api.close();
  }
});

test("16. connection failures and timeouts are reported as errors", async () => {
  const api = await startApi((req, res) => json(res, 200, SERVER_PAYLOAD));
  const baseUrl = api.baseUrl;
  await api.close(); // nothing is listening any more

  const client = providerModule.createProvider(
    { provider: { "exaroton-server-id": "AbCd1234" } },
    { EXAROTON_TOKEN: TOKEN, EXAROTON_BASE_URL: baseUrl },
  );
  const result = await client.getStatus();
  assert.equal(result.ok, false);
  assert.equal(result.server, null);
  assert.ok(result.error, "a dead endpoint must produce an error string");
});

test("17. the token never appears in a response body or an error message", async () => {
  // A hostile API that echoes the Authorization header back in its error.
  const api = await startApi((req, res) =>
    json(res, 401, { success: false, error: `bad token: ${req.headers.authorization}` }),
  );
  try {
    const client = providerModule.createProvider(
      { provider: { "exaroton-server-id": "AbCd1234" } },
      { EXAROTON_TOKEN: TOKEN, EXAROTON_BASE_URL: api.baseUrl },
    );
    const result = await client.getStatus();
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes(TOKEN), "the token must be scrubbed from errors");
    assert.match(result.error, /\[redacted\]/);
  } finally {
    await api.close();
  }
});

test("18. a non-JSON response body does not crash the client", async () => {
  const api = await startApi((req, res) => {
    res.writeHead(502, { "Content-Type": "text/html" });
    res.end("<html>bad gateway</html>");
  });
  try {
    const client = providerModule.createProvider(
      { provider: { "exaroton-server-id": "AbCd1234" } },
      { EXAROTON_TOKEN: TOKEN, EXAROTON_BASE_URL: api.baseUrl },
    );
    const result = await client.getStatus();
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 502);
    assert.match(result.error, /HTTP 502/);
  } finally {
    await api.close();
  }
});

test("19. a plain (non-wrapped) server payload is still understood", () => {
  const server = providerModule.normaliseServer({
    id: "plain1",
    status: 2,
    address: "plain.exaroton.me",
    players: { online: 1, max: 8 },
  });
  assert.equal(server.id, "plain1");
  assert.equal(server.status, 2);
  assert.equal(server.statusLabel, "Starting");
  assert.equal(server.running, false);
  assert.equal(server.transitional, true);
  assert.equal(server.players.online, 1);
  assert.equal(server.players.max, 8);

  // Missing fields degrade to nulls instead of throwing.
  const empty = providerModule.normaliseServer({});
  assert.equal(empty.status, null);
  assert.equal(empty.running, false);
  assert.equal(empty.address, null);
});

test("20. EXAROTON_SERVER_ID overrides settings.json and the id is URL-encoded", async () => {
  const api = await startApi((req, res) => json(res, 200, SERVER_PAYLOAD));
  try {
    const client = providerModule.createProvider(
      { provider: { "exaroton-server-id": "FromSettings" } },
      {
        EXAROTON_TOKEN: TOKEN,
        EXAROTON_SERVER_ID: "weird id/with slash",
        EXAROTON_BASE_URL: api.baseUrl,
      },
    );
    assert.equal(client.serverId, "weird id/with slash");
    await client.getStatus();
    assert.equal(api.calls[0].url, "/v1/servers/weird%20id%2Fwith%20slash");
  } finally {
    await api.close();
  }
});

test("21. the provider is wired into the HTTP endpoints without leaking the token", async () => {
  const api = await startApi((req, res) => json(res, 200, SERVER_PAYLOAD));
  const previous = { ...process.env };
  process.env.EXAROTON_TOKEN = TOKEN;
  process.env.EXAROTON_SERVER_ID = "AbCd1234";
  process.env.EXAROTON_BASE_URL = api.baseUrl;

  const index = require("../index.js");
  const app = index.createApp({ proxy: { proxy: false } });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  // A settings.json with a dashboard path/password locks every endpoint, which
  // is the point of it. Reach the API the way a browser would: secret path plus
  // basic auth taken from whatever this checkout is configured with.
  const dash = index.resolveDashboard();
  const prefix = dash.path ? `/${String(dash.path).replace(/^\/+|\/+$/g, "")}` : "";
  const headers = dash.password
    ? { authorization: `Basic ${Buffer.from(`${dash.user}:${dash.password}`).toString("base64")}` }
    : {};

  try {
    const check = await index.httpJsonRequest({ url: `${base}${prefix}/server/check`, method: "GET", headers });
    assert.equal(check.ok, true);
    assert.match(JSON.stringify(check.body), /AbCd1234/);
    assert.ok(!JSON.stringify(check.body).includes(TOKEN), "the token must never reach a client");

    const status = await index.httpJsonRequest({ url: `${base}${prefix}/server/status`, method: "GET", headers });
    assert.equal(status.ok, true);
    assert.ok(!JSON.stringify(status.body).includes(TOKEN));

    const started = await index.httpJsonRequest({ url: `${base}${prefix}/server/start`, method: "POST", headers });
    assert.equal(started.statusCode, 200);
    assert.equal(started.body.ok, true);
    assert.ok(!JSON.stringify(started.body).includes(TOKEN));

    // The provider API really was called, with a bearer token, and the
    // dashboard never sees the credential.
    assert.ok(api.calls.some((c) => c.url.endsWith("/start") && c.method === "POST"));
    assert.equal(api.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  } finally {
    index.stopBot("test cleanup");
    delete process.env.EXAROTON_TOKEN;
    delete process.env.EXAROTON_SERVER_ID;
    delete process.env.EXAROTON_BASE_URL;
    for (const key of Object.keys(previous)) {
      if (process.env[key] === undefined) delete process.env[key];
    }
    await new Promise((resolve) => server.close(resolve));
    await api.close();
  }
});

run("provider");
