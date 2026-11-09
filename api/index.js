"use strict";

// ============================================================
// Vercel serverless entry point.
//
// Vercel's Node runtime invokes the exported function with a normal
// (IncomingMessage, ServerResponse) pair, so WeChat-style adapters are
// unnecessary — express handles them directly.
//
// IMPORTANT: a serverless function cannot hold a Minecraft TCP session
// open. This entry point therefore NEVER starts the bot. It serves:
//
//   * proxy mode     — every request forwarded to BOT_BACKEND_URL,
//                      i.e. the always-on bot's real dashboard;
//   * no backend     — an honest dashboard that says no bot can run
//                      in a serverless runtime.
//
// The handler is cached at module scope, so a warm container reuses the
// same express app instead of rebuilding it on every invocation.
// ============================================================

const { makeServerlessHandler } = require("../index.js");

module.exports = makeServerlessHandler();
