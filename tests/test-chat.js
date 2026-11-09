"use strict";

// ============================================================
// tests/test-chat.js — chat that reads like a person, not a cron
//
//   npm run test:chat   (5 tests)
//
// A fixed 120s timer sending the same list in the same order is the
// clearest "this is a bot" signature a server can see. These tests pin
// the two rules that replace it:
//
//   - every gap is 60-140% of the configured delay (never below 5s)
//   - the same line never goes out twice in a row while others exist
// ============================================================

const { test, run, assert } = require("./harness");
const index = require("../index.js");

test("1. gaps are jittered within 60-140% of the delay", () => {
  for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
    const gap = index.chatGapMs(420000, () => r);
    assert.ok(gap >= 0.6 * 420000 - 1, `too short at r=${r}: ${gap}`);
    assert.ok(gap <= 1.4 * 420000 + 1, `too long at r=${r}: ${gap}`);
  }
});

test("2. a silly small delay is floored, so it can never spam", () => {
  const gap = index.chatGapMs(1000, () => 0); // 5s floor * 0.6
  assert.ok(gap >= 3000, `expected >= 3000ms, got ${gap}`);
  assert.equal(index.chatGapMs(0, () => 0.5), 5000);
  assert.equal(index.chatGapMs("nonsense", () => 0.5), 5000);
});

test("3. the same line never repeats back to back", () => {
  const messages = ["a", "b", "c"];
  let random = 0; // always picks index 0 on the first draw
  const seq = [];
  let last = "";
  for (let i = 0; i < 20; i += 1) {
    random = 0; // tries "a" every time
    last = index.pickChatMessage(messages, last, () => random);
    seq.push(last);
    random += 0.01;
  }
  for (let i = 1; i < seq.length; i += 1) {
    assert.ok(seq[i] !== seq[i - 1] || messages.length === 1, `repeat at ${i}: ${seq.join(",")}`);
  }
});

test("4. a one-line list still speaks, an empty one does not crash", () => {
  assert.equal(index.pickChatMessage(["only"], "only"), "only");
  assert.equal(index.pickChatMessage([], "x"), "");
  assert.equal(index.pickChatMessage(null, "x"), "");
  assert.equal(index.pickChatMessage(["", null, "real"], ""), "real");
});

test("5. 420s with jitter means a message every 4-10 minutes, not every 2", () => {
  const gaps = Array.from({ length: 200 }, () => index.chatGapMs(420000));
  const min = Math.min(...gaps);
  const max = Math.max(...gaps);
  assert.ok(min >= 252000 && max <= 588000, `range ${min}-${max}`);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  assert.ok(avg > 380000 && avg < 460000, `average drifted: ${avg}`);
});

run("chat");
