"use strict";

// ============================================================
// tests/harness.js — dependency-free test harness
//
//   const { test, run, assert } = require("./harness");
//   test("does a thing", () => { assert.equal(1, 1); });
//   run();            // exits non-zero on failure
//
// Deliberately tiny: node:assert + a counter + a summary. No
// framework, no config, no install step.
// ============================================================

const assert = require("assert");

const cases = [];
let onlyCase = null;

function test(name, fn, options = {}) {
  cases.push({ name, fn, timeoutMs: options.timeoutMs || 15000 });
}

test.only = (name, fn, options) => {
  onlyCase = name;
  test(name, fn, options);
};

async function run(label) {
  const selected = onlyCase ? cases.filter((c) => c.name === onlyCase) : cases;
  const title = label ? `${label} ` : "";
  console.log(`\n▶ ${title}(${selected.length} test${selected.length === 1 ? "" : "s"})\n`);

  let passed = 0;
  const failures = [];

  for (const testCase of selected) {
    const started = Date.now();
    try {
      await Promise.race([
        Promise.resolve().then(() => testCase.fn()),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error(`timed out after ${testCase.timeoutMs}ms`)),
            testCase.timeoutMs,
          ).unref?.(),
        ),
      ]);
      passed += 1;
      const took = Date.now() - started;
      console.log(`  ✓ ${testCase.name}${took > 50 ? `  (${took}ms)` : ""}`);
    } catch (err) {
      failures.push({ name: testCase.name, err });
      console.log(`  ✗ ${testCase.name}`);
      console.log(`      ${err && err.message ? err.message.split("\n").join("\n      ") : err}`);
    }
  }

  console.log(`\n${passed}/${selected.length} passed`);

  if (failures.length > 0) {
    console.log(`\n${failures.length} failure(s):`);
    for (const failure of failures) {
      console.log(`  • ${failure.name}`);
      if (failure.err && failure.err.stack) {
        console.log(
          failure.err.stack
            .split("\n")
            .slice(1, 4)
            .join("\n"),
        );
      }
    }
    process.exitCode = 1;
    return { passed, failed: failures.length, total: selected.length };
  }

  return { passed, failed: 0, total: selected.length };
}

/** Small sleep helper for async tests. */
function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
}


/**
 * Dashboard protection (secret path + password) comes from settings.json, which
 * on a real deployment has both. Suites that exercise routing should not depend
 * on whatever secrets the person running them happens to have in there: clear
 * the block for the duration of one createApp() call, then put it back.
 */
function openDashboard() {
  const index = require("../index.js");
  const saved = JSON.parse(JSON.stringify((index.config && index.config.dashboard) || {}));
  index.config.dashboard = Object.assign({}, saved, { path: "", password: "" });
  return () => {
    index.config.dashboard = saved;
  };
}

/** The same clearing, applied around one synchronous createApp() call. */
function buildApp(index, options) {
  const restore = openDashboard();
  try {
    return index.createApp(options);
  } finally {
    restore();
  }
}

module.exports = { test, run, assert, delay, openDashboard, buildApp };
