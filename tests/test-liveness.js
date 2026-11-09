"use strict";

// ============================================================
// tests/test-liveness.js — what counts as "the server is alive"
//
//   npm run test:liveness   (6 tests)
//
// Regression suite for the loop that hits panel hosts (SillyDev,
// Pterodactyl, any container where `socket` is not emitted):
//
//   [Bot] Spawned in ... (version 1.21.1)
//   [Watchdog] Socket silent for 92s — reconnecting
//
// The watchdog was fed only by `bot.on("socket")`, so a perfectly
// healthy session looked dead 90s after spawn and reconnected
// forever. Parsed packets are a better signal: they keep arriving
// for as long as the connection works.
// ============================================================

const { EventEmitter } = require("events");
const { test, run, assert } = require("./harness");

const watcher = require("../watcher.js");
const index = require("../index.js");

const { Watchdog, resolveWatchdogConfig } = watcher;
const { attachLivenessSources, socketStateOf } = index;

/** A bot-shaped object: events + a minecraft-protocol client. */
function fakeBot({ withClient = true } = {}) {
  const bot = new EventEmitter();
  if (withClient) bot._client = new EventEmitter();
  return bot;
}

function makeWatchdog() {
  const clock = { now: 1_000_000 };
  const events = [];
  const wd = new Watchdog({
    config: resolveWatchdogConfig({ watchdog: {} }),
    now: () => clock.now,
    log: () => {},
    onSilence: (info) => events.push(["silence", info]),
  });
  wd.start();
  return { wd, clock, events };
}

/** Advance the fake clock in steps, ticking the watchdog each time. */
function advance(clock, wd, ms, step = 1000) {
  let left = ms;
  while (left > 0) {
    const jump = Math.min(step, left);
    clock.now += jump;
    wd.tick();
    left -= jump;
  }
}

test("1. parsed packets alone keep the session alive (the 90s loop)", () => {
  const { wd, clock, events } = makeWatchdog();
  const bot = fakeBot();
  attachLivenessSources(bot, wd);

  wd.noteSpawn(); // silence is measured from spawn
  // Five minutes of a healthy connection, in 15s keepalives. Note: the raw
  // socket never emits anything here — exactly the panel case.
  for (let i = 0; i < 20; i += 1) {
    advance(clock, wd, 15_000);
    bot._client.emit("packet", { name: "keep_alive" }, {});
  }

  assert.equal(events.length, 0, "a session with packets must not be reconnected");
});

test("2. raw socket bytes still count as liveness", () => {
  const { wd, clock, events } = makeWatchdog();
  const bot = fakeBot();
  attachLivenessSources(bot, wd);

  const socket = new EventEmitter();
  socket.readyState = "open";
  bot.emit("socket", socket);
  wd.noteSpawn();

  for (let i = 0; i < 20; i += 1) {
    advance(clock, wd, 15_000);
    socket.emit("data", Buffer.from([0x01]));
  }

  assert.equal(events.length, 0);
});

test("3. chat keeps a quiet-but-connected session alive", () => {
  const { wd, clock, events } = makeWatchdog();
  const bot = fakeBot({ withClient: false });
  attachLivenessSources(bot, wd);

  wd.noteSpawn();
  for (let i = 0; i < 20; i += 1) {
    advance(clock, wd, 15_000);
    bot.emit("messagestr", "someone said hi");
  }

  assert.equal(events.length, 0);
});

test("4. silence still reconnects when nothing arrives at all", () => {
  const { wd, clock, events } = makeWatchdog();
  const bot = fakeBot();
  attachLivenessSources(bot, wd);

  wd.noteSpawn();
  advance(clock, wd, 95_000);

  assert.equal(events.length, 1, "a genuinely dead connection must reconnect");
  assert.equal(events[0][0], "silence");
});

test("5. detach removes every listener it added", () => {
  const { wd, clock, events } = makeWatchdog();
  const bot = fakeBot();
  const detach = attachLivenessSources(bot, wd);

  wd.noteSpawn();
  detach();

  // Emitting after detach must not count as data any more.
  for (let i = 0; i < 7; i += 1) {
    advance(clock, wd, 15_000);
    bot._client.emit("packet", {}, {});
  }

  assert.equal(events.length, 1, "after detach the watchdog sees silence again");
});

test("6. a bot without a client is handled, and socketStateOf is honest", () => {
  const { wd } = makeWatchdog();
  const bare = new EventEmitter(); // no _client at all
  assert.doesNotThrow(() => attachLivenessSources(bare, wd));
  assert.doesNotThrow(() => attachLivenessSources(null, wd));
  assert.doesNotThrow(() => attachLivenessSources({}, null));

  assert.equal(socketStateOf(null), "none");
  assert.equal(socketStateOf({}), "none");
  assert.equal(socketStateOf({ _client: { socket: { readyState: "open" } } }), "open");
  assert.equal(socketStateOf({ _client: { socket: { readyState: "closed" } } }), "closed");

  // A throwing getter must not take the process down.
  const hostile = {};
  Object.defineProperty(hostile, "_client", {
    get() {
      throw new Error("boom");
    },
  });
  assert.equal(socketStateOf(hostile), "unknown");
});

run("liveness");
