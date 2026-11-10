"use strict";

// ============================================================
// tests/test-human.js — behaviour that does not look like a cron
//
//   npm run test:human   (18 tests)
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

test("10. the first action after a join comes within 5-15s, not 90s", () => {
  const first = Array.from({ length: 200 }, () => index.firstAntiAfkDelayMs());
  assert.ok(Math.min(...first) >= 5000, `too early: ${Math.min(...first)}`);
  assert.ok(Math.max(...first) <= 15000, `too late: ${Math.max(...first)}`);
  // and it must hand over to the slower beat afterwards
  assert.ok(index.nextAntiAfkDelayMs(() => 0) >= 20000);
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const antiAfk = source.slice(source.indexOf("function setupAntiAfk"), source.indexOf("function setupHumanSchedule"));
  assert.ok(/firstAntiAfkDelayMs\(\)/.test(antiAfk), "the first delay must be the short one");
});

test("11. a panel that pins Etc/UTC does not defeat settings.json", () => {
  const { execFileSync } = require("child_process");
  const path = require("path");
  const run = (tz) =>
    execFileSync(process.execPath, ["-e", "require('./index.js'); console.log(process.env.TZ);"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, TZ: tz },
      encoding: "utf8",
    }).trim();
  assert.equal(run("Etc/UTC"), "Asia/Kolkata", "the panel's generic UTC loses");
  assert.equal(run("UTC"), "Asia/Kolkata");
  assert.equal(run("America/New_York"), "America/New_York", "a real choice from the panel wins");
});

test("12. lite mode skips the modules that cost CPU and quiets the actions", () => {
  const saved = JSON.parse(JSON.stringify(index.config.performance || {}));
  try {
    index.config.performance = { enabled: true, physics: false, "view-distance": "tiny", "quiet-actions": true };
    const perf = index.performanceConfig();
    assert.equal(perf.enabled, true);
    assert.equal(perf.physics, false);
    assert.equal(perf.viewDistance, "tiny");
    assert.deepEqual(index.disabledModulesFor(perf), ["movement", "position", "combat", "beds"]);

    // an unknown view distance falls back to the cheapest one
    index.config.performance = { enabled: true, "view-distance": "enormous" };
    assert.equal(index.performanceConfig().viewDistance, "tiny");

    // off means the old behaviour, nothing skipped
    index.config.performance = { enabled: false };
    assert.deepEqual(index.disabledModulesFor(), []);
  } finally {
    index.config.performance = saved;
  }
});

test("13. lite mode actions land every 60-150s, still jittered", () => {
  const gaps = Array.from({ length: 300 }, () => index.nextLightAntiAfkDelayMs());
  assert.ok(Math.min(...gaps) >= 60000, `too frequent: ${Math.min(...gaps)}`);
  assert.ok(Math.max(...gaps) <= 150000, `too sparse: ${Math.max(...gaps)}`);
  assert.ok(new Set(gaps).size > 50, "gaps are too regular");

  // the source must actually wire the light beat in
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const antiAfk = source.slice(source.indexOf("function setupAntiAfk"), source.indexOf("function setupHumanSchedule"));
  assert.ok(/nextLightAntiAfkDelayMs/.test(antiAfk), "lite mode is not wired into anti-AFK");
  assert.ok(/action === "jump" \|\| action === "sneak"/.test(antiAfk), "body-moving actions must be filtered");
});

test("14. lite activity only ever picks actions that cost a packet or two", () => {
  const allowed = new Set(["look", "micro-step", "swing", "hotbar", "jump", "idle"]);
  const seen = new Set();
  for (let i = 0; i < 3000; i += 1) {
    const action = index.pickHumanAction();
    assert.ok(allowed.has(action), `unexpected action: ${action}`);
    seen.add(action);
  }
  assert.equal(seen.size, 6, `not all actions reachable: ${[...seen].join(",")}`);

  // deterministic weights: the head turn dominates, walking is rare
  assert.equal(index.pickHumanAction(() => 0), "look");
  assert.equal(index.pickHumanAction(() => 0.99), "idle");

  // the table must not grow a pathfinding entry
  const source = require("fs").readFileSync(require("path").join(__dirname, "..", "index.js"), "utf8");
  const table = source.slice(source.indexOf("HUMAN_ACTION_WEIGHTS"), source.indexOf("function pickHumanAction"));
  assert.ok(!/pathfinder|circle|GoalBlock/.test(table), "lite activity must never pathfind");
});

test("15. bursts, gaps and key taps stay inside cheap bounds", () => {
  const bursts = Array.from({ length: 300 }, () => index.humanBurstSize());
  assert.equal(Math.min(...bursts), 1);
  assert.equal(Math.max(...bursts), 4);

  const gaps = Array.from({ length: 300 }, () => index.humanBurstGapMs());
  assert.ok(Math.min(...gaps) >= 1200 && Math.max(...gaps) <= 5500, "burst gap out of range");

  const steps = Array.from({ length: 300 }, () => index.microStepMs());
  assert.ok(Math.min(...steps) >= 250 && Math.max(...steps) <= 850, "key tap out of range");
});

test("16. micro-steps stop at the chunk we already loaded", () => {
  assert.equal(index.shouldMicroStep(0.4, true), true);
  assert.equal(index.shouldMicroStep(index.MICRO_STEP_DRIFT_LIMIT, true), true);
  assert.equal(index.shouldMicroStep(index.MICRO_STEP_DRIFT_LIMIT + 0.1, true), false);
  assert.equal(index.shouldMicroStep(0.4, false), false, "no physics, no walking");
  assert.equal(index.shouldMicroStep(NaN, true), true, "no anchor yet is harmless");

  // lite mode must hand anti-AFK over to the human script, not the old metronome
  const source = require("fs").readFileSync(require("path").join(__dirname, "..", "index.js"), "utf8");
  const antiAfk = source.slice(source.indexOf("function setupAntiAfk"), source.indexOf("function setupLiteHumanActivity"));
  assert.ok(/setupLiteHumanActivity\(bot\)/.test(antiAfk), "lite mode is not wired into anti-AFK");
  const lite = source.slice(source.indexOf("function setupLiteHumanActivity"), source.indexOf("function setupHumanSchedule"));
  assert.ok(/bot\.on\("chat"/.test(lite) && /bot\.on\("playerJoined"/.test(lite), "reactions missing");
});

test("17. walks are minutes apart and measured in blocks, not pathfinding", () => {
  const cfg = index.liteWalkConfig();
  assert.equal(cfg.enabled, true, "walking ships on");
  assert.ok(cfg.minGap >= 30000, "a walk every 30s is not a slow clock");
  assert.ok(cfg.maxGap >= cfg.minGap);

  const blocks = Array.from({ length: 300 }, () => index.pickWalkBlocks(cfg));
  assert.ok(Math.min(...blocks) >= cfg.minBlocks);
  assert.ok(Math.max(...blocks) <= cfg.maxBlocks);

  const gaps = Array.from({ length: 300 }, () => index.nextWalkGapMs(cfg));
  assert.ok(Math.min(...gaps) >= cfg.minGap && Math.max(...gaps) <= cfg.maxGap);
  assert.ok(new Set(gaps).size > 50, "gaps are too regular");

  // A walk is a held key for a computed time, capped so it cannot become
  // minutes of chunk loading.
  assert.equal(index.walkPlanMs(1) >= 400, true);
  assert.ok(index.walkPlanMs(99) <= 6250, `plan not capped: ${index.walkPlanMs(99)}`);
  assert.ok(index.walkPlanMs(10) > index.walkPlanMs(3), "more blocks must mean more time");
  assert.ok(Math.abs(index.walkPlanMs(4.3, () => 0) - 1000) <= 1, "4.3 blocks should be about a second");

  // Bad config cannot turn it into a marathon.
  const saved = JSON.parse(JSON.stringify(index.config.performance || {}));
  try {
    index.config.performance = { enabled: true, walk: { enabled: true, "min-blocks": 0, "max-blocks": -5, "min-gap-ms": 1, "max-gap-ms": 2 } };
    const clamped = index.liteWalkConfig();
    assert.equal(clamped.minBlocks, 1);
    assert.equal(clamped.maxBlocks >= clamped.minBlocks, true);
    assert.ok(clamped.minGap >= 30000);

    index.config.performance = { enabled: true, walk: { enabled: false } };
    assert.equal(index.liteWalkConfig().enabled, false, "walking can be switched off");
  } finally {
    index.config.performance = saved;
  }
});

test("18. the wander is wired in and never calls the pathfinder", () => {
  const fs = require("fs");
  const path = require("path");
  const source = fs.readFileSync(path.join(__dirname, "..", "index.js"), "utf8");
  const lite = source.slice(source.indexOf("function setupLiteHumanActivity"), source.indexOf("function setupHumanSchedule"));

  assert.ok(/const takeWalk = /.test(lite), "no walk function");
  assert.ok(/nextWalkGapMs\(walk\)/.test(lite), "walks are not on their own clock");
  assert.ok(/setControlState\("forward", true\)/.test(lite), "a walk must be a held key");
  assert.ok(/setControlState\("forward", false\)/.test(lite), "a walk must always stop");
  assert.ok(!/bot\.pathfinder|GoalBlock|GoalNear/.test(lite), "lite mode must not pathfind");
  // stuck detection: a walk into a wall has to end early
  assert.ok(/moved < 0\.4/.test(lite), "no stuck check");
});

run("human");
