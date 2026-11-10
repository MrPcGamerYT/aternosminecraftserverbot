"use strict";

// ============================================================
// tests/test-chat.js — chat that reads like a person, not a cron
//
//   npm run test:chat   (11 tests)
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

test("6. plain text is chat, and /say strips the prefix", () => {
  const sent = [];
  const savedBot = index.runtime.bot;
  const savedIntent = index.runtime.intent;
  index.runtime.bot = { username: "u", chat: (message) => sent.push(message) };
  index.runtime.intent = "running";
  try {
    const plain = index.sendConsoleCommand("hello there");
    const said = index.sendConsoleCommand("/say hi");
    assert.equal(plain.ok, true);
    assert.equal(said.ok, true);
    assert.deepEqual(sent, ["hello there", "hi"]);
  } finally {
    index.runtime.bot = savedBot;
    index.runtime.intent = savedIntent;
  }
});

test("7. shell commands are refused with an explanation, not 'not connected'", () => {
  const savedBot = index.runtime.bot;
  index.runtime.bot = null;
  try {
    for (const cmd of ["npm install", "node doctor.js", "git pull", "ls"]) {
      const result = index.sendConsoleCommand(cmd);
      assert.equal(result.ok, false, cmd);
      assert.ok(/shell command/.test(result.msg), `${cmd} -> ${result.msg}`);
      assert.ok(!/not connected/.test(result.msg), `${cmd} -> ${result.msg}`);
      assert.ok(/MAIN_FILE=doctor\.js/.test(result.msg), `${cmd} -> ${result.msg}`);
    }
    // A real Minecraft command that happens to start with a slash still works.
    index.runtime.bot = { username: "u", chat: () => {} };
    const list = index.sendConsoleCommand("/list");
    assert.equal(list.ok, true, list.msg);
  } finally {
    index.runtime.bot = savedBot;
  }
});

test("8. with no bot, chat says which state it is in", () => {
  const savedBot = index.runtime.bot;
  const savedIntent = index.runtime.intent;
  index.runtime.bot = null;
  index.runtime.intent = "running";
  try {
    assert.ok(/not connected yet/.test(index.sendConsoleCommand("hi").msg));
    index.runtime.intent = "stopped";
    assert.ok(/stopped/.test(index.sendConsoleCommand("hi").msg));
  } finally {
    index.runtime.bot = savedBot;
    index.runtime.intent = savedIntent;
  }
});

test("9. /help explains that the box is not a shell", () => {
  const help = index.sendConsoleCommand("/help");
  assert.equal(help.ok, true);
  assert.ok(/not a shell/.test(help.msg), help.msg);
  assert.ok(/\/say <text>/.test(help.msg), help.msg);
});

test("10. setChatEnabled(false) is a hard stop, not a shorter delay", () => {
  const was = index.chatState().enabled;
  try {
    const off = index.setChatEnabled(false);
    assert.equal(off.ok, true);
    assert.equal(off.enabled, false);
    assert.equal(index.chatState().enabled, false);
    assert.equal(index.config.utils["chat-messages"].enabled, false);
    assert.ok(/silent/i.test(off.msg), off.msg);

    const on = index.setChatEnabled(true);
    assert.equal(on.enabled, true);
    assert.equal(index.chatState().enabled, true);
    assert.ok(/420s/.test(on.msg), on.msg);
  } finally {
    index.setChatEnabled(was);
  }
});

test("11. /chat reports and flips the same switch the dashboard uses", () => {
  const was = index.chatState().enabled;
  try {
    index.sendConsoleCommand("/chat on");
    assert.ok(/Chat is ON/.test(index.sendConsoleCommand("/chat").msg));
    const off = index.sendConsoleCommand("/chat off");
    assert.equal(off.ok, true);
    assert.ok(/Chat is OFF/.test(index.sendConsoleCommand("/chat").msg), index.sendConsoleCommand("/chat").msg);
    assert.equal(index.sendConsoleCommand("/chat on").enabled, true);
    // unknown argument just reports, it does not toggle
    const before = index.chatState().enabled;
    index.sendConsoleCommand("/chat maybe");
    assert.equal(index.chatState().enabled, before);
  } finally {
    index.setChatEnabled(was);
  }
});

run("chat");
