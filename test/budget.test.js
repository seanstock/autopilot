'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const util = require('../src/util');
const state = require('../src/state');
const { BudgetManager } = require('../src/budget');
const { notify } = require('../src/notify');

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-home-test-'));
  process.env.AUTOPILOT_HOME_OVERRIDE = dir;
  return dir;
}

function tempCredFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-cred-test-'));
  const credPath = path.join(dir, '.credentials.json');
  fs.writeFileSync(credPath, typeof contents === 'string' ? contents : JSON.stringify(contents));
  return credPath;
}

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

test.beforeEach(() => {
  tempHome();
});

test.afterEach(() => {
  delete process.env.AUTOPILOT_HOME_OVERRIDE;
});

// ---------------------------------------------------------------------------
// Utilization normalization
// ---------------------------------------------------------------------------

test('normalizes utilization: 0.42 and 42 both -> 42', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok-1' } });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, {
      five_hour: { utilization: 0.42, resets_at: '2026-07-23T12:00:00Z' },
    });
  };
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath });
  const result = await mgr.check();
  assert.equal(calls, 1);
  const five = result.windows.find((w) => w.name === 'five_hour');
  assert.equal(five.pct, 42);

  const credPath2 = tempCredFile({ claudeAiOauth: { accessToken: 'tok-2' } });
  const fetchImpl2 = async () =>
    jsonResponse(200, { five_hour: { utilization: 42, resets_at: '2026-07-23T12:00:00Z' } });
  const mgr2 = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl: fetchImpl2, credPath: credPath2 });
  const result2 = await mgr2.check();
  const five2 = result2.windows.find((w) => w.name === 'five_hour');
  assert.equal(five2.pct, 42);
});

test('normalizePct edge cases: exactly 1 resolves as 1%, not 100%', () => {
  const { normalizePct } = require('../src/budget');
  assert.equal(normalizePct(0.75), 75);
  assert.equal(normalizePct(75), 75);
  assert.equal(normalizePct(0.01), 1);
  // This previously resolved to 100, reasoning that a raw 1 cannot be told
  // apart from "100% as a fraction" and that over-estimating usage fails safe.
  // Live evidence settled the ambiguity: the endpoint reports percentages (a
  // 42% week arrives as 42, a full five-hour window as 100), so a raw 1 is 1%.
  //
  // It also failed unsafe rather than safe in practice. 1% is what a window
  // reads just after it rolls over - the moment of MAXIMUM headroom - so the
  // old rule halted the loop for a whole window precisely when it should have
  // been running. Observed 2026-08-05: the UI showed 1% used, the meter
  // reported 100%, and cycles stopped for hours.
  assert.equal(normalizePct(1), 1);
  assert.equal(normalizePct(0), 0);
  assert.equal(normalizePct('not a number'), null);
  assert.equal(normalizePct(NaN), null);
});

test('defensive parsing: malformed window entries are skipped, not thrown', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  const fetchImpl = async () =>
    jsonResponse(200, {
      five_hour: { utilization: 10, resets_at: '2026-07-23T12:00:00Z' },
      bogus_window: { utilization: 'banana' },
      no_resets: { utilization: 5 },
      not_an_object: 'whatever',
      also_null: null,
    });
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath });
  const result = await mgr.check();
  const names = result.windows.map((w) => w.name).sort();
  assert.deepEqual(names, ['five_hour', 'no_resets']);
  const noResets = result.windows.find((w) => w.name === 'no_resets');
  assert.equal(noResets.resetsAt, null);
});

// ---------------------------------------------------------------------------
// Ceiling policy
// ---------------------------------------------------------------------------

test('ceiling at exactly 75 with ceilingPct 75 -> over', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  const fetchImpl = async () =>
    jsonResponse(200, { five_hour: { utilization: 75, resets_at: '2026-07-23T12:00:00Z' } });
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath });
  const result = await mgr.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ceiling');
  assert.equal(result.resetsAt, '2026-07-23T12:00:00.000Z');
});

test('under ceiling -> ok true, reason null, resetsAt null', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  const fetchImpl = async () =>
    jsonResponse(200, { five_hour: { utilization: 74, resets_at: '2026-07-23T12:00:00Z' } });
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath });
  const result = await mgr.check();
  assert.equal(result.ok, true);
  assert.equal(result.reason, null);
  assert.equal(result.resetsAt, null);
});

test('meter outage after an over-ceiling reading stays ceiling until resets_at passes', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  let fail = false;
  const fetchImpl = async () => {
    if (fail) throw new Error('network down');
    return jsonResponse(200, { five_hour: { utilization: 90, resets_at: future } });
  };
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath, minIntervalMs: 0 });
  const r1 = await mgr.check();
  assert.equal(r1.reason, 'ceiling');
  fail = true;
  const r2 = await mgr.check();
  // The probe gate only fires on 'outage'; a probe succeeding at 90% usage
  // must never rescue a still-valid ceiling reading (live flap, 2026-07-23).
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, 'ceiling');
  assert.equal(r2.resetsAt, new Date(Date.parse(future)).toISOString());
});

test('meter outage with a fresh UNDER-ceiling reading stays ok (no toast-storm flap)', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  let fail = false;
  const fetchImpl = async () => {
    if (fail) throw new Error('network down');
    return jsonResponse(200, { five_hour: { utilization: 10, resets_at: future } });
  };
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath, minIntervalMs: 0 });
  const r1 = await mgr.check();
  assert.equal(r1.ok, true);
  fail = true;
  // A failed poll must agree with the fresh cached reading - alternating
  // ok/outage here produced one recovery toast per backoff window, live.
  const r2 = await mgr.check();
  assert.equal(r2.ok, true);
  assert.equal(r2.reason, null);
});

test('meter outage with an EXPIRED over-ceiling reading degrades to outage', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  const past = new Date(Date.now() - 60 * 1000).toISOString();
  let fail = false;
  const fetchImpl = async () => {
    if (fail) throw new Error('network down');
    return jsonResponse(200, { five_hour: { utilization: 90, resets_at: past } });
  };
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath, minIntervalMs: 0 });
  await mgr.check();
  fail = true;
  const r2 = await mgr.check();
  assert.equal(r2.reason, 'outage');
});

test('overCeiling() is a standalone helper over a windows array', () => {
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 } });
  assert.equal(mgr.overCeiling([{ name: 'a', pct: 74 }]), false);
  assert.equal(mgr.overCeiling([{ name: 'a', pct: 75 }]), true);
  assert.equal(mgr.overCeiling([{ name: 'a', pct: 10 }, { name: 'b', pct: 90 }]), true);
});

// ---------------------------------------------------------------------------
// Rate limiting + backoff
// ---------------------------------------------------------------------------

test('minimum interval between real calls: second check() within window returns cache, no new fetch', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, { five_hour: { utilization: 10, resets_at: '2026-07-23T12:00:00Z' } });
  };
  const mgr = new BudgetManager({
    settings: { ceilingPct: 75 },
    fetchImpl,
    credPath,
    minIntervalMs: 60000,
  });
  const first = await mgr.check();
  const second = await mgr.check();
  assert.equal(calls, 1);
  assert.equal(first.ok, second.ok);
  assert.deepEqual(first.windows, second.windows);
});

test('429 -> backoff, no second real call within backoff window', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(429, {});
  };
  const mgr = new BudgetManager({
    settings: { ceilingPct: 75 },
    fetchImpl,
    credPath,
    minIntervalMs: 5,
    backoffBaseMs: 5000,
    backoffCapMs: 900000,
  });
  const first = await mgr.check();
  assert.equal(calls, 1);
  assert.equal(first.ok, false);
  assert.equal(first.reason, 'outage');
  const second = await mgr.check();
  assert.equal(calls, 1, 'second check within backoff window must not call fetchImpl again');
});

test('429 backoff grows across consecutive failures, capped', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  const fetchImpl = async () => jsonResponse(429, {});
  // Test-only small backoff constants (documented extension) so the test
  // does not need to sleep for real minutes to observe growth + cap.
  const mgr = new BudgetManager({
    settings: { ceilingPct: 75 },
    fetchImpl,
    credPath,
    minIntervalMs: 1,
    backoffBaseMs: 10,
    backoffCapMs: 35,
  });
  await mgr.check();
  assert.equal(mgr._backoffMs, 10);
  await new Promise((r) => setTimeout(r, 15));
  await mgr.check();
  assert.equal(mgr._backoffMs, 20);
  await new Promise((r) => setTimeout(r, 25));
  await mgr.check();
  assert.equal(mgr._backoffMs, 35, 'must cap rather than keep doubling');
  await new Promise((r) => setTimeout(r, 40));
  await mgr.check();
  assert.equal(mgr._backoffMs, 35, 'stays capped');
});

test('successful poll after a 429 resets backoff', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  let mode = 429;
  const fetchImpl = async () =>
    mode === 429
      ? jsonResponse(429, {})
      : jsonResponse(200, { five_hour: { utilization: 10, resets_at: '2026-07-23T12:00:00Z' } });
  const mgr = new BudgetManager({
    settings: { ceilingPct: 75 },
    fetchImpl,
    credPath,
    minIntervalMs: 1,
    backoffBaseMs: 10,
    backoffCapMs: 900000,
  });
  await mgr.check();
  assert.equal(mgr._backoffMs, 10);
  mode = 200;
  await new Promise((r) => setTimeout(r, 15));
  const result = await mgr.check();
  assert.equal(result.ok, true);
  assert.equal(mgr._backoffMs, 0);
});

// ---------------------------------------------------------------------------
// Credentials: read-only, defensive
// ---------------------------------------------------------------------------

test('missing credentials -> {ok:false, reason:"outage"}, fetch never called', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-cred-missing-'));
  const credPath = path.join(dir, 'does-not-exist.json');
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, {});
  };
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath });
  const result = await mgr.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'outage');
  assert.equal(calls, 0);
});

test('malformed credentials json -> outage, not a throw', async () => {
  const credPath = tempCredFile('{ not valid json');
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl: async () => jsonResponse(200, {}), credPath });
  const result = await mgr.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'outage');
});

test('401 from endpoint -> outage (expired token, fall to probe gate)', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'stale' } });
  const fetchImpl = async () => jsonResponse(401, {});
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath });
  const result = await mgr.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'outage');
});

test('credentials file is never opened for writing: content and mtime unchanged after check()', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok-untouched' } });
  const before = fs.readFileSync(credPath, 'utf8');
  const statBefore = fs.statSync(credPath);
  const fetchImpl = async () =>
    jsonResponse(200, { five_hour: { utilization: 10, resets_at: '2026-07-23T12:00:00Z' } });
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath });
  await mgr.check();
  const after = fs.readFileSync(credPath, 'utf8');
  const statAfter = fs.statSync(credPath);
  assert.equal(after, before);
  assert.equal(statAfter.mtimeMs, statBefore.mtimeMs);
});

test('finds accessToken nested arbitrarily deep, defensively', async () => {
  const credPath = tempCredFile({ some: { nested: { shape: { accessToken: 'deep-tok' } } } });
  let seenAuth = null;
  const fetchImpl = async (url, opts) => {
    seenAuth = opts && opts.headers && opts.headers.Authorization;
    return jsonResponse(200, {});
  };
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath });
  await mgr.check();
  assert.equal(seenAuth, 'Bearer deep-tok');
});

test('sends required headers: Authorization Bearer + anthropic-beta', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'abc123' } });
  let seenHeaders = null;
  let seenUrl = null;
  const fetchImpl = async (url, opts) => {
    seenUrl = url;
    seenHeaders = opts.headers;
    return jsonResponse(200, {});
  };
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath });
  await mgr.check();
  assert.equal(seenUrl, 'https://api.anthropic.com/api/oauth/usage');
  assert.equal(seenHeaders.Authorization, 'Bearer abc123');
  assert.equal(seenHeaders['anthropic-beta'], 'oauth-2025-04-20');
});

// ---------------------------------------------------------------------------
// I8: fail closed on schema drift (2xx, zero recognizable windows)
// ---------------------------------------------------------------------------

test('I8: a 2xx response that parses to zero recognizable windows -> {ok:false, reason:"outage"} (fail closed)', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  // Simulates the endpoint's documented-hostile schema drift: a 200 body
  // with no entries extractWindows() recognizes as a usage window at all.
  const fetchImpl = async () => jsonResponse(200, { some_new_field: 'unexpected-shape', nested: { no_utilization_key: true } });
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath });
  const result = await mgr.check();
  assert.equal(result.ok, false, 'zero windows must never resolve to ok:true - that silently drops ceiling protection');
  assert.equal(result.reason, 'outage');
});

test('I8: a genuinely empty 200 body ({}) also fails closed, not open', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  const fetchImpl = async () => jsonResponse(200, {});
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath });
  const result = await mgr.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'outage');
});

// ---------------------------------------------------------------------------
// M2: noteUsageLimitExit's real-resetsAt path (was dead code - _lastResult
// never carried resetsAt, so the forced-ceiling window always used the
// 15-min fallback even when a real resets_at was known).
// ---------------------------------------------------------------------------

test('M2: noteUsageLimitExit uses the real resets_at from the last successful poll, not just the 15-min fallback', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  const futureResetsAt = new Date(Date.now() + 3600000).toISOString();
  const fetchImpl = async () => jsonResponse(200, { five_hour: { utilization: 10, resets_at: futureResetsAt } });
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath });
  await mgr.check(); // populates _lastResult.resetsAt
  mgr.noteUsageLimitExit();
  const result = await mgr.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ceiling');
  assert.equal(result.resetsAt, new Date(futureResetsAt).toISOString());
});

test('a genuine 1% utilization is not scaled to 100% and does not stop the loop', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  const fetchImpl = async () => jsonResponse(200, {
    five_hour: { utilization: 1, resets_at: new Date(Date.now() + 3600000).toISOString() },
    seven_day: { utilization: 42, resets_at: new Date(Date.now() + 86400000).toISOString() },
  });
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath });
  const r = await mgr.check();
  assert.equal(r.windows.find((w) => w.name === 'five_hour').pct, 1, '1 means 1%, not 100%');
  assert.equal(r.windows.find((w) => w.name === 'seven_day').pct, 42);
  assert.equal(r.ok, true, 'must not halt at 1% used');
});

test('a fractional utilization below 1 is still scaled to a percentage', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  const fetchImpl = async () => jsonResponse(200, { five_hour: { utilization: 0.8, resets_at: null } });
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath });
  const r = await mgr.check();
  assert.equal(r.windows[0].pct, 80);
  assert.equal(r.ok, false);
});

// ---------------------------------------------------------------------------
// Forced-latch re-verification: a usage_limit exit is evidence about the
// moment it happened, not a promise about the whole window. Observed live:
// five_hour was back to 1% at 17:05 but the latch held the loop idle until
// its 22:00 resets_at - about four hours of dead time.
// ---------------------------------------------------------------------------

test('forced ceiling releases early once the real meter reports headroom', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  const farFuture = new Date(Date.now() + 5 * 3600000).toISOString();
  let util = 100;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, { five_hour: { utilization: util, resets_at: farFuture } });
  };
  // forcedRecheckMs 0 => every check re-verifies.
  const mgr = new BudgetManager({
    settings: { ceilingPct: 75 }, fetchImpl, credPath,
    minIntervalMs: 0, forcedRecheckMs: 0,
  });
  await mgr.check();
  mgr.noteUsageLimitExit();

  // Still genuinely over: the latch must hold.
  let r = await mgr.check();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ceiling');

  // Window rolled over. The latch must NOT outlive the evidence.
  util = 10;
  r = await mgr.check();
  assert.equal(r.ok, true, 'must resume once the meter shows headroom');
  assert.equal(r.reason, null);
  assert.ok(calls >= 2, 'must actually re-poll rather than answer from the latch');
});

test('forced ceiling is not re-polled before forcedRecheckMs has elapsed', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  const farFuture = new Date(Date.now() + 5 * 3600000).toISOString();
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, { five_hour: { utilization: 10, resets_at: farFuture } });
  };
  const mgr = new BudgetManager({
    settings: { ceilingPct: 75 }, fetchImpl, credPath,
    minIntervalMs: 0, forcedRecheckMs: 60000,
  });
  await mgr.check();
  const before = calls;
  mgr.noteUsageLimitExit();
  const r = await mgr.check();
  assert.equal(r.ok, false, 'latch answers immediately inside the recheck window');
  assert.equal(r.reason, 'ceiling');
  assert.equal(calls, before, 'must not hit the endpoint inside the recheck window');
});

// ---------------------------------------------------------------------------
// noteUsageLimitExit
// ---------------------------------------------------------------------------

test('noteUsageLimitExit forces not-ok immediately, without waiting for a poll', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return jsonResponse(200, { five_hour: { utilization: 10, resets_at: '2026-07-23T12:00:00Z' } });
  };
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath });
  mgr.noteUsageLimitExit();
  const result = await mgr.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'ceiling');
  assert.equal(calls, 0, 'forced state must not require a network call to take effect');
});

test('noteUsageLimitExit force clears once resetsAt has passed, allowing a fresh poll', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  const fetchImpl = async () =>
    jsonResponse(200, { five_hour: { utilization: 10, resets_at: '2026-07-23T12:00:00Z' } });
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath });
  // Force with a resetsAt already in the past -> should immediately fall
  // through to a real poll rather than staying latched forever.
  mgr._forcedUntilResetsAt = new Date(Date.now() - 1000).toISOString();
  const result = await mgr.check();
  assert.equal(result.ok, true);
});

// ---------------------------------------------------------------------------
// Fatal latch (credit balance tripwire)
// ---------------------------------------------------------------------------

test('scanForTripwire matches /credit balance/i, latches fatal via state.writeFatal, persists across instances', () => {
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 } });
  assert.equal(mgr.scanForTripwire('some normal output'), false);
  assert.equal(state.readFatal(), null);

  const tripped = mgr.scanForTripwire('Error: Credit balance too low to continue');
  assert.equal(tripped, true);
  const fatal = state.readFatal();
  assert.ok(fatal);
  assert.equal(fatal.reason, 'credit_balance_tripwire');

  // Latches across a brand new BudgetManager instance (daemon-restart case).
  const mgr2 = new BudgetManager({ settings: { ceilingPct: 75 } });
  assert.equal(mgr2.isFatal(), true);
});

test('scanForTripwire is case-insensitive and ignores non-string input safely', () => {
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 } });
  assert.equal(mgr.scanForTripwire('CREDIT BALANCE is zero'), true);
  assert.doesNotThrow(() => mgr.scanForTripwire(null));
  assert.doesNotThrow(() => mgr.scanForTripwire(undefined));
  assert.doesNotThrow(() => mgr.scanForTripwire(12345));
});

test('clearFatal releases the latch', () => {
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 } });
  mgr.scanForTripwire('Credit balance exhausted');
  assert.equal(mgr.isFatal(), true);
  mgr.clearFatal();
  assert.equal(mgr.isFatal(), false);
  assert.equal(state.readFatal(), null);
});

test('check() reports reason "fatal" once latched, regardless of usage windows', async () => {
  const credPath = tempCredFile({ claudeAiOauth: { accessToken: 'tok' } });
  const fetchImpl = async () => jsonResponse(200, { five_hour: { utilization: 1, resets_at: null } });
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, fetchImpl, credPath });
  mgr.scanForTripwire('Credit balance too low');
  const result = await mgr.check();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'fatal');
});

// ---------------------------------------------------------------------------
// probeGate
// ---------------------------------------------------------------------------

test('probeGate resolves {ok:true} on clean exit and strips API key env vars', async () => {
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 } });
  let seenEnv = null;
  let seenArgs = null;
  const fakeSpawn = (cmd, args, opts) => {
    seenArgs = args;
    seenEnv = opts.env;
    const { EventEmitter } = require('events');
    const child = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => child.emit('exit', 0));
    return child;
  };
  process.env.ANTHROPIC_API_KEY = 'should-be-stripped';
  const result = await mgr.probeGate(fakeSpawn);
  delete process.env.ANTHROPIC_API_KEY;
  assert.equal(result.ok, true);
  assert.ok(seenArgs.includes('-p'));
  assert.equal(seenEnv.ANTHROPIC_API_KEY, undefined);
});

test('probeGate resolves {ok:false} on nonzero exit', async () => {
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 } });
  const fakeSpawn = () => {
    const { EventEmitter } = require('events');
    const child = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => child.emit('exit', 1));
    return child;
  };
  const result = await mgr.probeGate(fakeSpawn);
  assert.equal(result.ok, false);
});

test('probeGate resolves {ok:false} on spawn error event', async () => {
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 } });
  const fakeSpawn = () => {
    const { EventEmitter } = require('events');
    const child = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => child.emit('error', new Error('ENOENT')));
    return child;
  };
  const result = await mgr.probeGate(fakeSpawn);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// notify.js
// ---------------------------------------------------------------------------

test('notify() never throws even with no webhook and returns promptly', () => {
  const start = Date.now();
  assert.doesNotThrow(() => notify('Title', 'Body', { webhook: null }));
  assert.ok(Date.now() - start < 1000);
});

test('notify() posts to webhook when settings.webhook is set', async () => {
  const http = require('http');
  let received = null;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      received = raw;
      res.writeHead(200);
      res.end('ok');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    notify('Recovery', 'Budget is runnable again', { webhook: `http://127.0.0.1:${port}/hook` });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(received, 'webhook should have received a POST body');
    const parsed = JSON.parse(received);
    assert.equal(parsed.title, 'Recovery');
    assert.equal(parsed.body, 'Budget is runnable again');
    assert.ok(parsed.t);
  } finally {
    server.close();
  }
});

test('notify() does not throw when webhook URL is invalid', () => {
  assert.doesNotThrow(() => notify('T', 'B', { webhook: 'not a url at all' }));
});

// ---------------------------------------------------------------------------
// macOS Keychain fallback
// ---------------------------------------------------------------------------
//
// Claude Code on macOS keeps its OAuth credentials in the login Keychain, not
// in ~/.claude/.credentials.json. Without this fallback a Mac never reads the
// meter and lives in probe-gate mode with no ceiling, which is the opposite of
// what the budget manager is for. `security` is read-only here: -w prints the
// secret, nothing is added, updated or deleted.

const { readKeychainToken, KEYCHAIN_SERVICE } = require('../src/budget');

test('readKeychainToken parses the JSON blob security prints on darwin', () => {
  let seen = null;
  const exec = (bin, args) => {
    seen = { bin, args };
    return JSON.stringify({ claudeAiOauth: { accessToken: 'kc-tok', refreshToken: 'never-used' } }) + '\n';
  };
  assert.equal(readKeychainToken(exec, 'darwin'), 'kc-tok');
  assert.equal(seen.bin, 'security');
  assert.deepEqual(seen.args, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']);
});

test('readKeychainToken is null off darwin, never even calling security', () => {
  let called = 0;
  const exec = () => { called += 1; return '{"accessToken":"x"}'; };
  assert.equal(readKeychainToken(exec, 'win32'), null);
  assert.equal(readKeychainToken(exec, 'linux'), null);
  assert.equal(called, 0);
});

test('readKeychainToken is null when the item is absent, denied, or not JSON', () => {
  assert.equal(readKeychainToken(() => { throw new Error('item not found'); }, 'darwin'), null);
  assert.equal(readKeychainToken(() => '', 'darwin'), null);
  assert.equal(readKeychainToken(() => 'not json', 'darwin'), null);
  assert.equal(readKeychainToken(() => '{"nothing":"here"}', 'darwin'), null);
});

test('check() falls back to the Keychain token when the credentials file has none', async () => {
  const credPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-nocred-')), 'missing.json');
  let authHeader = null;
  const fetchImpl = async (url, opts) => {
    authHeader = opts.headers.Authorization;
    return { status: 200, json: async () => ({ five_hour: { utilization: 10 } }) };
  };
  const mgr = new BudgetManager({
    settings: { ceilingPct: 75 },
    fetchImpl,
    credPath,
    platform: 'darwin',
    execImpl: () => JSON.stringify({ claudeAiOauth: { accessToken: 'kc-tok' } }),
  });
  const result = await mgr.check();
  assert.equal(result.ok, true);
  assert.equal(authHeader, 'Bearer kc-tok');
});

test('probeGate spawns the CLI through the platform wrapper, not a bare name', async () => {
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 } });
  let seen = null;
  const fakeSpawn = (cmd, args) => {
    seen = { cmd, args };
    const { EventEmitter } = require('events');
    const child = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => child.emit('exit', 0));
    return child;
  };
  await mgr.probeGate(fakeSpawn);
  const expected = require('../src/util').claudeCommand();
  assert.equal(seen.cmd, expected[0]);
  assert.deepEqual(seen.args.slice(0, expected.length - 1), expected.slice(1));
  assert.ok(seen.args.includes('-p'));
});

// ---------------------------------------------------------------------------
// codex engine latch (2026-09-15)
// ---------------------------------------------------------------------------
//
// Codex has no usage-meter endpoint. A usage-limit exit from a codex cycle
// sleeps that engine for codexRetryMs, and the next codex cycle after that
// is the re-check. The Anthropic meter must be untouched by it either way.

test('noteUsageLimitExit("codex") latches only the codex gate, for codexRetryMs', async () => {
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 }, engineRetryMs: 50 });
  assert.equal(mgr.engineOk('codex').ok, true);
  assert.equal(mgr.engineOk('claude').ok, true, 'claude never uses engineOk gating');

  mgr.noteUsageLimitExit('codex');
  const gate = mgr.engineOk('codex');
  assert.equal(gate.ok, false);
  assert.equal(gate.reason, 'ceiling');
  assert.ok(gate.resetsAt);
  assert.equal(mgr._forcedUntilResetsAt, null, 'the Anthropic forced latch is not set by a codex exit');

  assert.equal(mgr.engineOk('openrouter').ok, true, 'each engine has its own latch');
  mgr.noteUsageLimitExit('openrouter');
  assert.equal(mgr.engineOk('openrouter').ok, false);
  await new Promise((r) => setTimeout(r, 70));
  assert.equal(mgr.engineOk('codex').ok, true, 'latch lapses on its own');
  assert.equal(mgr.engineOk('openrouter').ok, true);
});

test('noteUsageLimitExit() with no engine keeps the original claude behaviour', () => {
  const mgr = new BudgetManager({ settings: { ceilingPct: 75 } });
  mgr.noteUsageLimitExit();
  assert.ok(mgr._forcedUntilResetsAt);
  assert.equal(mgr.engineOk('codex').ok, true);
});
