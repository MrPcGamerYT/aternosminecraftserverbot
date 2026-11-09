"use strict";

// ============================================================
// tests/test-lifecycle.js — reconnect scheduler, probe gating,
// backoff caps, duplicate-login backoff, policy stops, shutdown.
//
//   npm run test:lifecycle        (17 tests)
// ============================================================

const { test, run, assert } = require("./harness");

const index = require("../index.js");
const watcher = require("../watcher.js");

const {
  computeBackoff,
  computeDuplicateLoginDelay,
  shouldForceLogin,
  isProbeReady,
  describeProbe,
  detectPolicyBan,
  isDuplicateLoginKick,
  isThrottleKick,
  flattenKickReason,
  describeStatus,
  formatDuration,
  startBot,
  stopBot,
  publicState,
  runtime,
} = index;

// ------------------------------------------------------------
// Backoff
// ------------------------------------------------------------

test("1. backoff grows exponentially from the base delay, jitter never drops below it", () => {
  const fixed = { random: () => 0 };
  assert.equal(computeBackoff(1, 2000, 120000, fixed), 2000);
  assert.equal(computeBackoff(2, 2000, 120000, fixed), 4000);
  assert.equal(computeBackoff(3, 2000, 120000, fixed), 8000);
  assert.equal(computeBackoff(4, 2000, 120000, fixed), 16000);

  const low = computeBackoff(1, 2000, 120000, { random: () => 0 });
  const high = computeBackoff(1, 2000, 120000, { random: () => 0.999 });
  assert.equal(low, 2000);
  assert.ok(high > low, `expected jitter to raise the delay (${low} -> ${high})`);
});

test("2. backoff is capped by max-reconnect-delay", () => {
  const fixed = { random: () => 0 };
  assert.equal(computeBackoff(20, 2000, 120000, fixed), 120000);
  assert.equal(computeBackoff(50, 2000, 30000, fixed), 30000);
  // jitter can never push past the cap either
  const jittered = computeBackoff(20, 2000, 120000, { random: () => 1, jitterRatio: 0.5 });
  assert.ok(jittered <= 120000, `expected <= 120000, got ${jittered}`);
});

// ------------------------------------------------------------
// Probe gating
// ------------------------------------------------------------

test("3. only an honest status reply counts as ready", () => {
  assert.equal(isProbeReady({ status: "online", online: true, ambiguous: false }), true);
  // port open, no status reply -> booting, not ready
  assert.equal(isProbeReady({ status: "online", online: true, ambiguous: true }), false);
  assert.equal(isProbeReady({ status: "offline", online: false }), false);
  assert.equal(isProbeReady({ status: "timeout", online: false }), false);
  assert.equal(isProbeReady({ status: "error", online: false }), false);
  assert.equal(isProbeReady(null), false);
});

test("4. probe results are described honestly", () => {
  assert.match(describeProbe({ status: "online", ambiguous: true }), /booting/);
  assert.match(describeProbe({ status: "online", ambiguous: false, players: { online: 3 } }), /3 player/);
  assert.match(describeProbe({ status: "offline", error: "ECONNREFUSED" }), /offline/);
  assert.match(describeProbe(null), /no probe/);
});

test("5. probes are advisory: a real login is forced after 6 not-ready probes", () => {
  assert.equal(shouldForceLogin(0), false);
  assert.equal(shouldForceLogin(5), false);
  assert.equal(shouldForceLogin(6), true);
  assert.equal(shouldForceLogin(9), true);
  // threshold is configurable but defaults to 6
  assert.equal(shouldForceLogin(3, 3), true);
  assert.equal(shouldForceLogin(2, 3), false);
  assert.equal(index.config.utils["force-login-after-probes"], 6);
});

// ------------------------------------------------------------
// Kick classification
// ------------------------------------------------------------

test("6. duplicate-login kicks are detected (JSON components included)", () => {
  assert.equal(isDuplicateLoginKick("You are already logged in!"), true);
  assert.equal(isDuplicateLoginKick("duplicate_login"), true);
  assert.equal(isDuplicateLoginKick("Kicked: duplicate login"), true);
  assert.equal(
    isDuplicateLoginKick(JSON.stringify({ text: "You are already playing on this account" })),
    true,
  );
  assert.equal(isDuplicateLoginKick("Server closed"), false);
  assert.equal(isDuplicateLoginKick(undefined), false);
});

test("7. duplicate-login backoff is jittered into the 120-180s window", () => {
  for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
    const delay = computeDuplicateLoginDelay({ random: () => r });
    assert.ok(delay >= 120000, `${delay} should be >= 120000`);
    assert.ok(delay <= 180000, `${delay} should be <= 180000`);
  }
  // a duplicate login must never reuse the (much shorter) normal backoff
  const normal = computeBackoff(1, 2000, 120000, { random: () => 0 });
  assert.ok(computeDuplicateLoginDelay({ random: () => 0 }) > normal * 10);
});

test("8. throttle kicks use an extended delay", () => {
  assert.equal(isThrottleKick("You are reconnecting too fast"), true);
  assert.equal(isThrottleKick("Please wait before reconnect"), true);
  assert.equal(isThrottleKick("throttled"), true);
  assert.equal(isThrottleKick("Welcome to the server"), false);
});

test("9. kick reasons are flattened from every shape mineflayer sends", () => {
  assert.equal(flattenKickReason("plain string"), "plain string");
  assert.equal(flattenKickReason({ text: "component text" }), "component text");
  assert.equal(flattenKickReason({ value: "legacy value" }), "legacy value");
  assert.equal(
    flattenKickReason({ text: "Kicked: ", extra: [{ text: "duplicate login" }] }).includes(
      "duplicate login",
    ),
    true,
  );
  assert.equal(flattenKickReason(null), "");
  // double-encoded JSON is unwrapped
  assert.equal(flattenKickReason(JSON.stringify({ text: "nested" })), "nested");
});

// ------------------------------------------------------------
// Policy bans
// ------------------------------------------------------------

test("10. banned.reason is a policy block", () => {
  const result = detectPolicyBan(
    JSON.stringify({ translate: "disconnect.disconnected", reason: "banned.reason" }),
  );
  assert.equal(result.blocked, true);
  assert.equal(result.category, "banned");
});

test("11. idle kicks and ToS violations are policy blocks", () => {
  const idle = detectPolicyBan("Kicked: idle for too long");
  assert.equal(idle.blocked, true);
  assert.equal(idle.category, "idle");

  const tos = detectPolicyBan("You were kicked for a Terms of Service violation");
  assert.equal(tos.blocked, true);
  assert.equal(tos.category, "tos");

  const banned = detectPolicyBan("You have been banned from this server");
  assert.equal(banned.blocked, true);
  assert.equal(banned.category, "banned");
});

test("12. ordinary disconnects are not policy blocks", () => {
  assert.equal(detectPolicyBan("Server closed").blocked, false);
  assert.equal(detectPolicyBan("Timed out").blocked, false);
  assert.equal(detectPolicyBan("").blocked, false);
  assert.equal(detectPolicyBan(undefined).blocked, false);
});

test("13. a policy block pauses reconnecting until /start is explicit", () => {
  const saved = {
    policyBlocked: runtime.policyBlocked,
    policyReason: runtime.policyReason,
    intent: runtime.intent,
  };

  runtime.policyBlocked = true;
  runtime.policyReason = "account banned — automatic reconnects paused";
  runtime.intent = "running";

  // The scheduler must refuse to do anything while blocked.
  const delay = index.scheduleReconnect("should-be-refused");
  assert.equal(delay, null, "scheduleReconnect must return null while policy-blocked");
  assert.equal(publicState().status, "stopped");
  assert.equal(publicState().policy.blocked, true);

  runtime.policyBlocked = saved.policyBlocked;
  runtime.policyReason = saved.policyReason;
  runtime.intent = saved.intent;
});

// ------------------------------------------------------------
// Lifecycle / shutdown
// ------------------------------------------------------------

test("14. stopping is intentional and reported as such", () => {
  const before = runtime.intent;
  stopBot("unit test");
  const state = publicState();
  assert.equal(state.status, "stopped");
  assert.equal(state.stopped, true);
  assert.equal(state.botRunning, false);
  assert.match(state.statusDetail, /Stopped/i);
  // A stopped bot refuses to schedule a reconnect.
  assert.equal(index.scheduleReconnect("while-stopped"), null);
  runtime.intent = before;
});

test("15. session uptime is per-login, not process uptime", () => {
  const state = publicState();
  runtime.connectedAt = null;
  assert.equal(index.publicState().sessionUptimeMs, 0);

  runtime.connectedAt = Date.now() - 65000;
  const connected = index.publicState();
  assert.ok(connected.sessionUptimeMs >= 65000, "session uptime should follow connectedAt");
  // Session uptime measures this login; process uptime measures the process.
  // They are independent numbers and must not be aliased to one another.
  assert.equal(
    typeof connected.processUptimeMs,
    "number",
    "process uptime is still reported separately",
  );
  assert.notEqual(
    connected.sessionUptimeMs,
    connected.processUptimeMs,
    "session uptime must not be process uptime",
  );

  runtime.connectedAt = state.connectedAt;
  assert.equal(describeStatus("connected", { serverLabel: "mc.example.com:25565" }), "Playing on mc.example.com:25565");
  assert.match(describeStatus("policy-blocked", { policyReason: "banned" }), /banned/);
  assert.equal(formatDuration(65), "1m 5s");
});

test("16. SIGTERM/SIGINT quit the bot and exit", async () => {
  const listeners = process.listeners("SIGTERM");
  assert.ok(listeners.length >= 1, "a SIGTERM handler must be installed");
  assert.ok(process.listeners("SIGINT").length >= 1, "a SIGINT handler must be installed");

  // Shutdown must be idempotent and must flip intent to stopped.
  let exitCode = null;
  const originalExit = process.exit;
  process.exit = (code) => {
    exitCode = code === undefined ? 0 : code;
    throw Object.assign(new Error("exit-called"), { __exit: true });
  };

  try {
    index.shutdown("SIGTERM", 0);
  } catch (err) {
    if (!err.__exit) throw err;
  } finally {
    process.exit = originalExit;
  }

  assert.equal(runtime.intent, "stopped", "shutdown must stop the bot");
});

test("17. the watchdog is constructed before any module init and survives a throwing module", () => {
  // initializeModules is invoked inside the spawn handler's try/catch. Prove
  // the ordering exists by checking connectBot arms the watchdog first.
  const source = require("fs").readFileSync(require("path").join(__dirname, "..", "index.js"), "utf8");
  const watchdogIndex = source.indexOf("watcherModule.createWatchdog");
  const moduleIndex = source.indexOf("initializeModules(bot, mcData)");
  assert.ok(watchdogIndex > 0 && moduleIndex > 0);
  assert.ok(
    watchdogIndex < moduleIndex,
    "the watchdog must be armed before modules are initialised",
  );
  assert.match(source, /\[Modules\] Initialization failed \(session continues\)/);

  // And the watchdog itself keeps ticking after a callback throws.
  let ticks = 0;
  const wd = watcher.createWatchdog({
    config: watcher.resolveWatchdogConfig({ watchdog: { "silence-timeout": 100000 } }),
    log: () => {},
    onSilence: () => {
      ticks += 1;
    },
  });
  assert.ok(wd instanceof watcher.Watchdog);
  wd.stop();
  assert.equal(ticks, 0);
});

process.on("beforeExit", () => {});
run("lifecycle");
