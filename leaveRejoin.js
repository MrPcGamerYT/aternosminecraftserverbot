"use strict";

// ============================================================
// leaveRejoin.js — optional "leave on a timer, come back" cycle
//
// Some servers idle-kick after a fixed period. Rather than being
// kicked mid-session, the bot can leave politely and rejoin on its
// own schedule. That is the only thing this module does:
//
//   spawn -> wait a random stay window -> bot.quit()
//
// It deliberately does NOT reconnect. index.js owns exactly one
// reconnect scheduler, and a second one here used to cause
// duplicate logins (which look like botting to the server).
//
// Options (all optional):
//   log        function(message)     log sink, defaults to console.log
//   minStayMs  number                minimum time to stay connected
//   maxStayMs  number                maximum time to stay connected
//   onLeave    function()            called just before quitting
//
// `createBot` is accepted for API compatibility with older versions
// of this file and is never invoked — the scheduler handles rejoins.
// ============================================================

const DEFAULT_MIN_STAY_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_MAX_STAY_MS = 15 * 60 * 1000; // 15 minutes

function randomInt(min, max) {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return lo;
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}

function setupLeaveRejoin(bot, createBot, options = {}) {
  const log = typeof options.log === "function" ? options.log : (msg) => console.log(msg);

  const minStay = Number(options.minStayMs) > 0 ? Number(options.minStayMs) : DEFAULT_MIN_STAY_MS;
  const maxStay = Number(options.maxStayMs) > minStay ? Number(options.maxStayMs) : Math.max(minStay, DEFAULT_MAX_STAY_MS);

  let leaveTimer = null;
  let stopped = false;
  let lastLogAt = 0;

  function logThrottled(msg, minGapMs = 2000) {
    const now = Date.now();
    if (now - lastLogAt < minGapMs) return;
    lastLogAt = now;
    log(msg);
  }

  function cleanup() {
    if (leaveTimer) clearTimeout(leaveTimer);
    leaveTimer = null;
  }

  function scheduleLeave() {
    cleanup();
    if (stopped) return;

    const stay = randomInt(minStay, maxStay);
    logThrottled(`[LeaveRejoin] Leaving in ${Math.round(stay / 1000)}s`);

    leaveTimer = setTimeout(() => {
      leaveTimer = null;
      if (stopped) return;
      logThrottled("[LeaveRejoin] Leaving the server now");
      cleanup();
      if (typeof options.onLeave === "function") {
        try {
          options.onLeave();
        } catch (err) {
          log(`[LeaveRejoin] onLeave failed: ${err.message}`);
        }
      }
      try {
        if (bot && typeof bot.quit === "function") bot.quit("scheduled leave");
      } catch (_err) {
        // Already closed — nothing to do.
      }
    }, stay);

    if (leaveTimer && typeof leaveTimer.unref === "function") leaveTimer.unref();
  }

  bot.on("spawn", () => {
    stopped = false;
    scheduleLeave();
  });

  // Any teardown cancels the pending leave. We never reconnect here.
  const stop = () => {
    stopped = true;
    cleanup();
  };

  bot.on("end", stop);
  bot.on("kicked", stop);
  bot.on("error", stop);

  return {
    stop,
    get scheduled() {
      return Boolean(leaveTimer);
    },
  };
}

module.exports = setupLeaveRejoin;
module.exports.setupLeaveRejoin = setupLeaveRejoin;
module.exports.randomInt = randomInt;
module.exports.DEFAULT_MIN_STAY_MS = DEFAULT_MIN_STAY_MS;
module.exports.DEFAULT_MAX_STAY_MS = DEFAULT_MAX_STAY_MS;
