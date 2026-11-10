"use strict";

// ============================================================
// tests/test-human.js — behaviour that does not look like a cron
//
//   npm run test:human   (9 tests)
//
// A ternos (and every other server) notices regularity: one action
// every 45s, forever, is not something a person does. These tests
// pin the replacement: jittered gaps, weighted random actions,
// quiet hours that really take the bot offline, and breaks after a
// session.
// ============================================================

const { test, run, assert } = require("./harness");
const index = require("../index.js");

test("1. pickRandomInt is inclusive and never leaves the bounds", () => {
  assert.equal(index.pickRandomInt(5, 9, () => 0), 5);
  assert.equal(index.pickRandomInt(5, 9, () => 0.999999), 9);
  for (let i = 0; i < 500; i += 1) {
    const n = index.pickRandomInt(20, 30);
    assert.ok(n >= 20 && n <= 30, `out of range: ${n}`);
    assert.equal(n, Math.floor(n), "not an integer");
  }
  // Degenerate input must not throw.
  assert.equal(index.pickRandomInt(7, 7), 7);
  assert.equal(index.pickRandomInt("x", "y", () => 0.5), 0);
});

test("2. anti-AFK gaps are 20-90s and actually vary", () => {
  const gaps = Array.from({ length: 300 }, () => index.nextAntiAfkDelayMs());
  assert.ok(Math.min(...gaps) >= 20000, `too short: ${Math.min(...gaps)}`);
  assert.ok(Math.max(...gaps) <= 90000, `too long: ${Math.max(...gaps)}`);
  const unique = new Set(gaps).size;
  assert.ok(unique > 50, `gaps barely vary (${unique} distinct values in 300)`);
  // The old loop was exactly 45s every time; make sure nothing like that is left.
  assert.ok(unique > 1, "fixed interval came back");
});

test("3. actions are weighted and always valid", () => {
  const valid = new Set(["swing", "look", "hotbar", "idle", "sneak", "jump"]);
  assert.equal(index.pickAntiAfkAction(() => 0), "swing");
  assert.equal(index.pickAntiAfkAction(() => 0.999999), "jump");
  for (let i = 0; i < 300; i += 1) {
    const action = index.pickAntiAfkAction();
    assert.ok(valid.has(action), `unexpected action: ${action}`);
  }
  // Looking around and swinging should dominate: they are invisible to others.
  const counts = {};
  for (let i = 0; i < 4000; i += 1) {
    const action = index.pickAntiAfkAction();
    counts[action] = (counts[action] || 0) + 1;
  }
  assert.ok(counts.look + counts.swing > counts.jump + counts.sneak, JSON.stringify(counts));
});

test("4. quiet hours handle normal and midnight-wrapping windows", () => {
  const at = (hour, minute = 0) => new Date(2026, 10, 9, hour, minute);
  assert.equal(index.isQuietHour(at(3), 1, 8), true);
  assert.equal(index.isQuietHour(at(1), 1, 8), true); // start inclusive
  assert.equal(index.isQuietHour(at(8), 1, 8), false); // end exclusive
  assert.equal(index.isQuietHour(at(9), 1, 8), false);
  assert.equal(index.isQuietHour(at(23), 22, 6), true);
  assert.equal(index.isQuietHour(at(5, 30), 22, 6), true);
  assert.equal(index.isQuietHour(at(12), 22, 6), false);
  assert.equal(index.isQuietHour(at(12), 7, 7), false, "empty window is never quiet");
  assert.equal(index.isQuietHour(at(12), NaN, 8), false);
});

test("5. breaks are 10-40 min by default and respect configured bounds", () => {
  const breaks = Array.from({ length: 200 }, () => index.pickRestMs(600000, 2400000));
  assert.ok(Math.min(...breaks) >= 600000, `too short: ${Math.min(...breaks)}`);
  assert.ok(Math.max(...breaks) <= 2400000, `too long: ${Math.max(...breaks)}`);
  // Missing/absurd bounds fall back to 10-40 min instead of throwing.
  const fallback = index.pickRestMs(0, 0, () => 0.5);
  assert.ok(fallback >= 600000 && fallback <= 2400000, `fallback out of range: ${fallback}`);
  assert.equal(index.pickRestMs(600000, 100, () => 0), 600000);
});

test("6. human mode is on by default, quiet hours opt-in", () => {
  const saved = JSON.parse(JSON.stringify(index.config.utils["human-mode"] || {}));
  try {
    delete index.config.utils["human-mode"];
    const defaults = index.humanModeConfig();
    assert.equal(defaults.enabled, true);
    assert.equal(defaults.quiet.enabled, false);

    index.config.utils["human-mode"] = { enabled: true, "quiet-hours": { enabled: true, "start-hour": 23, "end-hour": 7 } };
    const configured = index.humanModeConfig();
    assert.equal(configured.quiet.enabled, true);
    assert.equal(configured.quiet.startHour, 23);
    assert.equal(configured.quiet.endHour, 7);
  } finally {
    index.config.utils["human-mode"] = saved;
  }
});

test("7. the scheduled checkout left fixed anti-AFK timers behind", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const antiAfk = source.slice(source.indexOf("function setupAntiAfk"), source.indexOf("function setupHumanSchedule"));
  assert.ok(!/}, 45000\)/.test(antiAfk), "45s swing timer is back");
  assert.ok(!/}, 60000\)/.test(antiAfk), "60s hotbar timer is back");
  assert.ok(/nextAntiAfkDelayMs/.test(antiAfk), "anti-AFK no longer jitters");
});

test("8. every module the spawn handler arms is actually defined", () => {
  // This is the bug a live SillyDev log caught: an edit that removed
  // setupMovement/setupPosition/setupCombat/setupBeds/setupLeaveRejoinModule
  // still started, connected and said "Modules ready" — while silently arming
  // nothing, so the bot stood still and was idle-kicked.
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const init = source.slice(source.indexOf("function initializeModules"), source.indexOf("function buildMovements"));
  const arms = [...init.matchAll(/guard\("([\w-]+)",\s*\(\)\s*=>\s*(\w+)\(/g)].map((m) => ({
    module: m[1],
    fn: m[2],
  }));
  assert.ok(arms.length >= 9, `expected the full module list, found ${arms.length}`);
  for (const { module, fn } of arms) {
    assert.ok(new RegExp(`function ${fn}\\s*\\(`).test(source), `${module} arms ${fn}() but ${fn} is not defined`);
  }
});

test("9. the modules that move and defend the bot are in the file", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  for (const name of ["setupMovement", "setupPosition", "setupCombat", "setupBeds", "setupLeaveRejoinModule", "setupAutoAuth", "setupChatMessages", "setupAntiAfk", "setupChatResponder"]) {
    assert.ok(new RegExp(`function ${name}\\s*\\(`).test(source), `${name} is missing from index.js`);
  }
});

run("human");
