"use strict";

// ============================================================
// Vercel serverless entry point.
//
// Vercel's Node runtime invokes the exported function with a normal
// (IncomingMessage, ServerResponse) pair, so express handles it directly.
//
// A serverless function cannot hold a Minecraft TCP session open, so this
// entry point NEVER starts the bot:
//
//   * proxy mode — every request is forwarded to BOT_BACKEND_URL, i.e.
//     the always-on bot's real, live dashboard;
//   * no backend — an honest dashboard saying no bot can run here.
//
// Robustness rule (learned the hard way): a deployed function must never
// 500 just because the main module changed shape. We therefore
//   1. try the full app from ../index.js,
//   2. fall back to a dependency-free handler that explains the problem,
//   3. fall back again to plain `http` if express itself is unavailable.
//
// The handler is cached at module scope so a warm container reuses it.
// ============================================================

const http = require("http");

/** Last-resort renderer: no express, no project modules, still honest. */
function createMinimalHandler(reason, backend) {
  return function minimalHandler(req, res) {
    // With a backend configured, forward verbatim — that is always the
    // best answer, and it keeps the live dashboard reachable.
    if (backend) {
      forward(req, res, backend);
      return;
    }

    const body = JSON.stringify({
      ok: false,
      mode: "serverless",
      error: reason,
      hint: "This deployment is a serverless function: it cannot run a Minecraft bot. Deploy the bot on an always-on host and set BOT_BACKEND_URL here.",
      version: readVersion(),
      timestamp: new Date().toISOString(),
    });

    const wantsJson =
      req.url === "/health" ||
      req.url === "/status/light" ||
      req.url === "/mirror/status" ||
      String(req.headers.accept || "").includes("application/json");

    res.writeHead(wantsJson ? 200 : 200, {
      "Content-Type": wantsJson ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });

    if (wantsJson) {
      res.end(body);
      return;
    }

    res.end(
      `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AFK Bot — dashboard unavailable</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
background:#0b0f14;color:#e8eef5;font-family:ui-sans-serif,system-ui,sans-serif;padding:24px}
.card{max-width:560px;background:#131a22;border:1px solid #222c37;border-radius:12px;padding:24px}
h1{margin:0 0 8px;font-size:20px}p{color:#8b98a5;line-height:1.6;margin:0 0 12px;font-size:14px}
code{background:#0a0e13;border:1px solid #222c37;border-radius:6px;padding:2px 6px;font-size:13px}
.bad{color:#f0d68a}</style></head><body><div class="card">
<h1>⚠️ Dashboard unavailable in this runtime</h1>
<p class="bad">${escapeHtml(reason)}</p>
<p>A serverless function can only serve requests — it cannot hold a Minecraft
TCP session open, so no bot runs here.</p>
<p>Deploy the bot on an always-on host (Render, Koyeb, Fly, a VPS), then set
<code>BOT_BACKEND_URL</code> on this Vercel project to that host's URL and
redeploy. This page will then show the live session and controls.</p>
</div></body></html>`,
    );
  };
}

function readVersion() {
  try {
    return require("../package.json").version;
  } catch (_err) {
    return null;
  }
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Forward one request to the always-on bot, preserving status and body. */
function forward(req, res, backend) {
  let target;
  try {
    target = new URL(backend.replace(/\/+$/, "") + (req.url || "/"));
  } catch (err) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: `bad BOT_BACKEND_URL: ${err.message}` }));
    return;
  }

  const transport = target.protocol === "https:" ? require("https") : http;
  const headers = { ...req.headers, host: target.host };
  delete headers["content-length"];

  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstream.setTimeout(25000, () => upstream.destroy(new Error("backend timeout")));
  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        `<h1>502 — backend unreachable</h1><p>Could not reach ${escapeHtml(backend)}: ${escapeHtml(err.message)}</p>`,
      );
    }
  });

  req.pipe(upstream);
}

/** Build the handler, degrading gracefully at every step. */
function buildHandler() {
  const backend = (process.env.BOT_BACKEND_URL || "").trim() || null;

  try {
    // eslint-disable-next-line global-require
    const index = require("../index.js");
    if (typeof index.makeServerlessHandler === "function") {
      return index.makeServerlessHandler();
    }
    // index.js loaded but no longer exposes the serverless API: build the app
    // directly rather than failing the whole deployment.
    if (typeof index.createApp === "function") {
      index.markServerlessOnly?.();
      const app = index.createApp();
      const handler = (req, res) => app(req, res);
      handler.kind = "express-handler";
      handler.default = handler;
      return handler;
    }
    return createMinimalHandler(
      "index.js does not export a serverless handler (makeServerlessHandler/createApp missing).",
      backend,
    );
  } catch (err) {
    // Missing dependency, syntax error, anything: never let it become a bare 500.
    return createMinimalHandler(
      `The application module failed to load: ${err && err.message ? err.message : String(err)}`,
      backend,
    );
  }
}

const handler = buildHandler();
handler.default = handler;

module.exports = handler;
