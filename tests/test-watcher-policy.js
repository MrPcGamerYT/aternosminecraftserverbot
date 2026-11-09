"use strict";

// ============================================================
// tests/test-watcher-policy.js — watchdog timings + policy bans
//
//   npm run test:watcher-policy   (16 tests)
//
// The Watchdog takes an injectable clock, so every threshold is
// tested deterministically without waiting 90 seconds.
// ============================================================

const { test, run, assert } = require("./harness");

const watcher = require("../watcher.js");
const index = require("../index.js");
const settings = require("../settings.json");

const { Watchdog, resolveWatchdogConfig } = watcher;

/** Build a watchdog on a fake clock. */
function makeWatchdog(overrides = {}) {
  const clock = { now: 1_000_000 };
  const events = [];
  const config = resolveWatchdogConfig({ watchdog: overrides.config || {} });
  const wd = new Watchdog({
    config,
    now: () => clock.now,
    log: () => {},
    onSilence: (info) => events.push(["silence", info, clock.now]),
    onSpawnTimeout: (info) => events.push(["spawn-timeout", info, clock.now]),
    onStall: (info) => events.push(["stall", info, clock.now]),
    onStallExpired: (info) => events.push(["stall-expired", info, clock.now]),
    ...overrides.handlers,
  });
  wd.start();
  return { wd, clock, events, config };
}

function advance(clock, wd, ms, step = 1000) {
  let left = ms;
  while (left > 0) {
    const jump = Math.min(step, left);
    clock.now += jump;
    wd.tick();
    left -= jump;
  }
}

// ------------------------------------------------------------
// Timing
// ------------------------------------------------------------

test("1. default thresholds match the documented settings", () => {
  const config = resolveWatchdogConfig(settings.utils);
  assert.equal(config.silenceTimeout, 90000, "90s socket silence");
  assert.equal(config.spawnTimeout, 120000, "120s spawn timeout");
  assert.equal(config.stallTimeout, 600000, "10min without movement");
  assert.equal(config.stallGrace, 120000);
  assert.equal(config.enabled, true);
  assert.equal(settings.utils.watchdog["silence-timeout"], 90000);
  assert.equal(settings.utils.watchdog["spawn-timeout"], 120000);
  assert.equal(settings.utils.watchdog["stall-timeout"], 600000);
});

test("2. 90s of socket silence triggers a reconnect", () => {
  const { wd, clock, events } = makeWatchdog();
  wd.noteSpawn();

  advance(clock, wd, 80_000);
  assert.equal(events.length, 0, "80s of silence is not enough");

  advance(clock, wd, 15_000);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "silence");
  assert.ok(events[0][1].silentMs >= 90_000);
});

test("3. incoming data resets the silence timer", () => {
  const { wd, clock, events } = makeWatchdog();
  wd.noteSpawn();

  for (let i = 0; i < 10; i++) {
    advance(clock, wd, 60_000);
    wd.noteData();
    wd.noteMovement();
  }
  assert.equal(events.length, 0, "10 minutes of regular traffic and movement must not trip the watchdog");

  advance(clock, wd, 95_000);
  assert.equal(events.filter((e) => e[0] === "silence").length, 1);
});

test("4. no spawn after 120s abandons the attempt", () => {
  const { wd, clock, events } = makeWatchdog();
  // no spawn yet
  advance(clock, wd, 110_000);
  assert.equal(events.length, 0);

  advance(clock, wd, 15_000);
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "spawn-timeout");
  assert.ok(events[0][1].waitedMs >= 120_000);

  // it fires exactly once per attempt
  advance(clock, wd, 300_000);
  assert.equal(events.filter((e) => e[0] === "spawn-timeout").length, 1);
});

test("5. spawn disarms the spawn timeout", () => {
  const { wd, clock, events } = makeWatchdog();
  advance(clock, wd, 60_000);
  wd.noteSpawn();
  advance(clock, wd, 90_000);
  assert.equal(events.filter((e) => e[0] === "spawn-timeout").length, 0);
});

test("6. silence and stall do not run before spawn", () => {
  const { wd, clock, events } = makeWatchdog();
  advance(clock, wd, 100_000); // past the silence threshold, still no spawn
  assert.equal(events.filter((e) => e[0] === "silence").length, 0);
  assert.equal(events.filter((e) => e[0] === "stall").length, 0);
});

test("7. 10 minutes without movement nudges, then reconnects after the grace period", () => {
  const { wd, clock, events } = makeWatchdog();
  wd.noteSpawn();

  // stay alive with data, but never move
  for (let i = 0; i < 9; i++) {
    advance(clock, wd, 60_000);
    wd.noteData();
  }
  assert.equal(events.filter((e) => e[0] === "stall").length, 0, "9 minutes is too early");

  advance(clock, wd, 65_000);
  wd.noteData();
  assert.equal(events.filter((e) => e[0] === "stall").length, 1, "10 minutes nudges");

  advance(clock, wd, 100_000);
  wd.noteData();
  assert.equal(events.filter((e) => e[0] === "stall-expired").length, 0, "grace not over yet");

  advance(clock, wd, 30_000);
  wd.noteData();
  assert.equal(events.filter((e) => e[0] === "stall-expired").length, 1);
});

test("8. real movement resets the stall timer (position aware)", () => {
  const { wd, clock, events } = makeWatchdog();
  wd.noteSpawn();

  for (let i = 0; i < 30; i++) {
    clock.now += 60_000;
    wd.notePosition({ x: i, y: 64, z: 0 });
    wd.noteData();
  }
  assert.equal(events.filter((e) => e[0] === "stall").length, 0);

  // Sub-epsilon jitter is not movement.
  const wd2 = makeWatchdog();
  wd2.wd.noteSpawn();
  wd2.wd.notePosition({ x: 0, y: 64, z: 0 });
  wd2.clock.now += 1;
  const moved = wd2.wd.notePosition({ x: 0.01, y: 64, z: 0 });
  assert.equal(moved, false, "tiny drift must not count as movement");
});

test("9. every threshold is tunable through settings", () => {
  const config = resolveWatchdogConfig({
    watchdog: {
      enabled: true,
      "silence-timeout": 5000,
      "spawn-timeout": 6000,
      "stall-timeout": 7000,
      "stall-grace": 1000,
      "tick-interval": 100,
    },
  });
  assert.equal(config.silenceTimeout, 5000);
  assert.equal(config.spawnTimeout, 6000);
  assert.equal(config.stallTimeout, 7000);
  assert.equal(config.stallGrace, 1000);

  const { wd, clock, events } = makeWatchdog({ config: { "silence-timeout": 5000 } });
  wd.noteSpawn();
  advance(clock, wd, 5200, 200);
  assert.equal(events[0][0], "silence");

  // A disabled watchdog never fires.
  const disabled = makeWatchdog({ config: { enabled: false } });
  disabled.wd.noteSpawn();
  advance(disabled.clock, disabled.wd, 10_000_000, 60000);
  assert.equal(disabled.events.length, 0);
});

test("10. a throwing callback does not kill the watchdog", () => {
  const clock = { now: 0 };
  let calls = 0;
  const logs = [];
  const wd = new Watchdog({
    config: resolveWatchdogConfig({ watchdog: { "silence-timeout": 1000, "spawn-timeout": 999999 } }),
    now: () => clock.now,
    log: (msg) => logs.push(msg),
    onSilence: () => {
      calls += 1;
      throw new Error("handler exploded");
    },
  });
  wd.start();
  wd.noteSpawn();
  clock.now += 2000;
  assert.doesNotThrow(() => wd.tick(), "a handler error must not escape tick()");
  assert.equal(calls, 1);
  assert.ok(logs.some((l) => /callback failed/i.test(l)), "the failure is logged, not swallowed silently");

  // still usable for the next connection
  wd.noteSpawn();
  clock.now += 2000;
  assert.doesNotThrow(() => wd.tick());
  assert.equal(calls, 2);
  wd.stop();
  assert.ok(wd instanceof Watchdog);
});

// ------------------------------------------------------------
// Policy
// ------------------------------------------------------------

test("11. policy bans are classified into banned / idle / tos", () => {
  assert.equal(index.detectPolicyBan("banned.reason").category, "banned");
  assert.equal(index.detectPolicyBan("Kicked: idle for too long").category, "idle");
  assert.equal(index.detectPolicyBan("Kicked for terms of service violation").category, "tos");
  assert.equal(index.detectPolicyBan("automation detected").category, "automation");
  assert.equal(index.detectPolicyBan("connection reset").blocked, false);
});

test("12. a policy block sets the flag, keeps the reason and pauses retries", () => {
  const saved = { ...index.runtime };
  index.runtime.policyBlocked = true;
  index.runtime.policyReason = "account banned — automatic reconnects paused";
  index.runtime.policyCategory = "banned";

  const state = index.publicState();
  assert.equal(state.status, "stopped", "a blocked bot never claims to be connecting");
  assert.equal(state.policy.blocked, true);
  assert.match(state.policy.reason, /banned/);
  assert.equal(state.botRunning, false);
  assert.equal(index.scheduleReconnect("policy"), null);

  Object.assign(index.runtime, saved);
});

test("13. /start is an explicit retry, not an automatic loop", () => {
  const saved = { ...index.runtime };
  index.runtime.policyBlocked = true;
  index.runtime.policyReason = "account banned — automatic reconnects paused";
  index.runtime.intent = "running";

  const before = index.publicState();
  assert.equal(before.policy.blocked, true);

  // The dashboard's /start clears the block on purpose.
  index.runtime.policyBlocked = false;
  index.runtime.policyReason = null;
  const after = index.publicState();
  assert.equal(after.policy.blocked, false);
  assert.notEqual(after.status, "stopped");

  Object.assign(index.runtime, saved);
});

test("14. classify: duplicate login and policy are mutually exclusive", () => {
  // A duplicate login must never be mistaken for a policy ban...
  assert.equal(index.detectPolicyBan("You are already logged in").blocked, false);
  assert.equal(index.isDuplicateLoginKick("You are already logged in"), true);

  // ...and a policy ban must never be retried like a duplicate login.
  assert.equal(index.detectPolicyBan("Kicked: idle for too long").blocked, true);
  assert.equal(index.isDuplicateLoginKick("Kicked: idle for too long"), false);
});

test("15. the dashboard renders a policy banner and never a fake 'connected'", () => {
  const saved = { ...index.runtime };
  index.runtime.policyBlocked = true;
  index.runtime.policyReason = "terms of service violation — automatic reconnects paused";
  index.runtime.policyCategory = "tos";

  const state = index.publicState();
  assert.equal(state.connected, false);
  assert.equal(state.statusLabel, "Stopped (policy block)");

  const html = index.renderDashboard(state);
  assert.match(html, /Blocked by server policy/);
  assert.match(html, /Automatic reconnects are paused/);
  assert.ok(!/class="dot on"/.test(html), "the status dot must not look healthy");
  assert.match(html, /class="dot warn"/);

  Object.assign(index.runtime, saved);
});

test("16. policy detection survives nested and JSON kick reasons", () => {
  const nested = index.flattenKickReason({
    translate: "disconnect.disconnected",
    with: [{ text: "You have been banned" }],
  });
  assert.match(nested, /banned/i);
  assert.equal(index.detectPolicyBan(nested).blocked, true);

  const json = JSON.stringify({ text: "Kicked for Terms of Service" });
  assert.equal(index.detectPolicyBan(json).blocked, true);

  // Empty / odd reasons are simply "not a policy ban".
  assert.equal(index.detectPolicyBan({}).blocked, false);
  assert.equal(index.detectPolicyBan(42).blocked, false);
});

run("watcher-policy");
