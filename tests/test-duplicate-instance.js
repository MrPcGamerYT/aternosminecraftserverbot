"use strict";

// ============================================================
// tests/test-duplicate-instance.js — single-instance lease
//
//   npm run test:duplicate-instance   (5 tests)
//
// Every test gets its own directory under os.tmpdir() so a real
// lease on the machine cannot influence the result.
// ============================================================

const fs = require("fs");
const os = require("os");
const path = require("path");
const { test, run, assert } = require("./harness");

const index = require("../index.js");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "afk-lease-test-"));
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_err) {
    /* ignore */
  }
}

test("1. a fresh username gets the lease (60s TTL)", () => {
  const dir = tempDir();
  try {
    const lease = index.acquireLease({ username: "lease_fresh", dir });
    assert.equal(lease.acquired, true);
    assert.equal(lease.tookOver, false);
    assert.equal(lease.file, path.join(dir, "minecraft-afk-bot-lease_fresh.lease"));
    assert.equal(index.LEASE_TTL_MS, 60000);

    const written = JSON.parse(fs.readFileSync(lease.file, "utf8"));
    assert.equal(written.username, "lease_fresh");
    assert.equal(written.pid, process.pid);
    assert.equal(written.hostname, os.hostname());
    assert.ok(written.token, "records carry a token so ownership can be verified");
  } finally {
    cleanup(dir);
  }
});

test("2. a live lease blocks the second copy (no duplicate logins)", () => {
  const dir = tempDir();
  try {
    // Pretend another process on this host owns it: a real, live pid.
    const other = index.buildLeaseRecord({ username: "lease_busy" });
    other.pid = 1; // init/launchd — always alive, never us
    fs.writeFileSync(path.join(dir, "minecraft-afk-bot-lease_busy.lease"), JSON.stringify(other));

    const lease = index.acquireLease({ username: "lease_busy", dir });
    assert.equal(lease.acquired, false);
    assert.equal(lease.tookOver, false);
    assert.equal(lease.owner.pid, 1);
    assert.match(lease.reason, /already held by pid 1/);
  } finally {
    cleanup(dir);
  }
});

test("3. an expired lease is taken over", () => {
  const dir = tempDir();
  try {
    const stale = index.buildLeaseRecord({ username: "lease_stale", now: Date.now() });
    stale.renewedAt = Date.now() - 90_000; // older than the 60s TTL
    stale.pid = 1; // owner alive, but the TTL still wins
    fs.writeFileSync(path.join(dir, "minecraft-afk-bot-lease_stale.lease"), JSON.stringify(stale));

    assert.equal(
      index.isLeaseStale(stale, { now: Date.now(), ttlMs: index.LEASE_TTL_MS }),
      true,
    );

    const lease = index.acquireLease({ username: "lease_stale", dir });
    assert.equal(lease.acquired, true);
    assert.equal(lease.tookOver, true);
    assert.equal(JSON.parse(fs.readFileSync(lease.file, "utf8")).pid, process.pid);
  } finally {
    cleanup(dir);
  }
});

test("4. TTL / pid liveness rules behave", () => {
  const now = Date.now();
  assert.equal(index.isLeaseStale(null), true, "no record = stale");
  assert.equal(index.isLeaseStale({ hostname: "other-host", pid: 999999, renewedAt: now }), false);
  assert.equal(
    index.isLeaseStale({ hostname: os.hostname(), pid: 999999, renewedAt: now }),
    true,
    "a dead pid on this host is stale",
  );
  assert.equal(
    index.isLeaseStale({ hostname: os.hostname(), pid: process.pid, renewedAt: now }),
    false,
  );
  assert.equal(index.pidAlive(process.pid), true);
  assert.equal(index.pidAlive(999999), false);
});

test("5. renewal keeps the lease, release frees it, BOT_LEASE_DIR is honoured", () => {
  const dir = tempDir();
  try {
    const lease = index.acquireLease({ username: "lease_renew", dir });
    assert.equal(lease.acquired, true);

    const renewed = index.renewLease(lease.file, lease.record, { now: Date.now() + 5000 });
    assert.equal(renewed.ok, true);
    assert.ok(renewed.record.renewedAt > lease.record.renewedAt, "renewal bumps renewedAt");

    // A second *process* still cannot take it after renewal. (Same pid means
    // "this process re-claimed its own lease", so we simulate another pid.)
    fs.writeFileSync(lease.file, JSON.stringify({ ...renewed.record, pid: 1 }));
    const second = index.acquireLease({ username: "lease_renew", dir });
    assert.equal(second.acquired, false);
    assert.equal(second.owner.pid, 1);

    // A foreign token must not be able to delete someone else's lease.
    const foreign = index.releaseLease(lease.file, { token: "not-ours" });
    assert.equal(foreign.ok, false);
    assert.ok(fs.existsSync(lease.file), "the lease survives a foreign release attempt");

    const released = index.releaseLease(lease.file, renewed.record);
    assert.equal(released.ok, true);
    assert.equal(released.removed, true);
    assert.equal(fs.existsSync(lease.file), false);

    // With the file gone, anyone may claim it again.
    assert.equal(index.acquireLease({ username: "lease_renew", dir }).acquired, true);

    // Directory resolution honours BOT_LEASE_DIR, and names are sanitised.
    assert.equal(index.resolveLeaseDir({ BOT_LEASE_DIR: "/var/tmp/bots" }), "/var/tmp/bots");
    assert.equal(index.resolveLeaseDir({}), os.tmpdir());
    assert.match(index.resolveLeaseFile({ env: { BOT_LEASE_DIR: dir }, username: "a/b c" }), /a_b_c/);
  } finally {
    cleanup(dir);
  }
});

run("duplicate-instance");
