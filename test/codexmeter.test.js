'use strict';

// src/codexmeter.js: the app-server handshake against a scripted fake child,
// the rate-limit parser, and the CodexMeter policy (ceiling / outage /
// caching). No real codex needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');

const cm = require('../src/codexmeter');

// A fake `codex app-server --stdio`: records what it is sent, answers each
// request id with the scripted reply (or nothing).
function fakeChild(script) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stdin = new PassThrough();
  child.received = [];
  child.killed = false;
  child.kill = () => { child.killed = true; child.emit('close', 0); };
  let buf = '';
  child.stdin.on('data', (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      const msg = JSON.parse(line);
      child.received.push(msg);
      const reply = script(msg);
      if (reply) setImmediate(() => child.stdout.write(`${JSON.stringify(reply)}\n`));
    }
  });
  return child;
}

const GOOD_RESULT = {
  rateLimits: {
    primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1788265323 },
    secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 1788765541 },
  },
  planType: 'plus',
};

test('parseRateLimits: both windows, names from duration, resetsAt seconds -> ISO, pct clamped', () => {
  const r = cm.parseRateLimits(GOOD_RESULT);
  assert.equal(r.planType, 'plus');
  assert.deepEqual(r.windows.map((w) => w.name), ['codex 5h', 'codex week']);
  assert.equal(r.windows[0].pct, 42);
  assert.equal(r.windows[0].resetsAt, new Date(1788265323 * 1000).toISOString());
  assert.equal(cm.parseRateLimits({ rateLimits: { primary: { usedPercent: 140, windowDurationMins: 300 } } }).windows[0].pct, 100);
  assert.equal(cm.parseRateLimits({ rateLimits: { primary: { usedPercent: 140, windowDurationMins: 300 } } }).windows[0].resetsAt, null);
});

test('parseRateLimits: one window, ms timestamps, and junk', () => {
  const one = cm.parseRateLimits({ rateLimits: { secondary: { usedPercent: 7, windowDurationMins: 10080, resetsAt: 1788765541000 } } });
  assert.equal(one.windows.length, 1);
  assert.equal(one.windows[0].name, 'codex week');
  assert.equal(one.windows[0].resetsAt, new Date(1788765541000).toISOString());
  assert.equal(cm.parseRateLimits(null), null);
  assert.equal(cm.parseRateLimits({}), null);
  assert.equal(cm.parseRateLimits({ rateLimits: {} }), null);
  assert.equal(cm.parseRateLimits({ rateLimits: { primary: { usedPercent: 'n/a' } } }), null);
  assert.equal(cm.windowName(1440), 'day');
  assert.equal(cm.windowName(90), '90m');
});

test('readRateLimits: initialize, initialized, then the read after the settle delay; answer parsed; child killed', async () => {
  let child;
  const spawnImpl = (bin, args) => {
    assert.ok(args.includes('app-server') && args.includes('--stdio'), args.join(' '));
    child = fakeChild((msg) => {
      if (msg.method === 'initialize') return { id: msg.id, result: { userAgent: 'codex' } };
      if (msg.method === 'account/rateLimits/read') return { id: msg.id, result: GOOD_RESULT };
      return null;
    });
    return child;
  };
  const r = await cm.readRateLimits({ spawnImpl, settleMs: 5, timeoutMs: 2000 });
  assert.equal(r.windows.length, 2);
  assert.deepEqual(child.received.map((m) => m.method), ['initialize', 'initialized', 'account/rateLimits/read']);
  assert.deepEqual(child.received[0].params.clientInfo, cm.CLIENT_INFO);
  assert.equal(child.received[0].id, 1);
  assert.equal(child.received[2].id, 2);
  assert.equal(child.killed, true);
});

test('readRateLimits: an error reply, a silent server, or a missing binary all resolve null', async () => {
  const errChild = () => fakeChild((msg) => (msg.method === 'account/rateLimits/read' ? { id: msg.id, error: { message: 'unauthorized' } } : null));
  assert.equal(await cm.readRateLimits({ spawnImpl: errChild, settleMs: 5, timeoutMs: 2000 }), null);
  const silent = () => fakeChild(() => null);
  assert.equal(await cm.readRateLimits({ spawnImpl: silent, settleMs: 5, timeoutMs: 60 }), null);
  const enoent = () => { throw new Error('spawn ENOENT'); };
  assert.equal(await cm.readRateLimits({ spawnImpl: enoent }), null);
});

test('CodexMeter.check: under ceiling ok, over ceiling sleeps until the earliest over-window reset', async () => {
  const meter = new cm.CodexMeter({ settings: { ceilingPct: 50 }, readImpl: async () => cm.parseRateLimits(GOOD_RESULT), minIntervalMs: 0 });
  const r = await meter.check(true);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'ceiling');
  assert.equal(r.resetsAt, new Date(1788765541 * 1000).toISOString(), 'only the weekly window (61%) is over 50');
  assert.equal(r.planType, 'plus');
  const loose = new cm.CodexMeter({ settings: { ceilingPct: 75 }, readImpl: async () => cm.parseRateLimits(GOOD_RESULT), minIntervalMs: 0 });
  const ok = await loose.check(true);
  assert.equal(ok.ok, true);
  assert.equal(ok.reason, null);
  assert.equal(ok.windows.length, 2);
});

test('CodexMeter.check: unreadable meter is an outage that never blocks; a recent reading answers for a dead server', async () => {
  let reads = 0;
  let answer = cm.parseRateLimits({ rateLimits: { primary: { usedPercent: 90, windowDurationMins: 300, resetsAt: 1788265323 } } });
  const meter = new cm.CodexMeter({ settings: { ceilingPct: 75 }, readImpl: async () => { reads += 1; return answer; }, minIntervalMs: 0, cacheTrustMs: 60000 });
  const first = await meter.check(true);
  assert.equal(first.ok, false);
  answer = null; // server goes quiet
  const second = await meter.check(true);
  assert.equal(second.ok, false, 'a fresh over-ceiling reading still answers');
  assert.equal(second.reason, 'ceiling');
  const cold = new cm.CodexMeter({ settings: { ceilingPct: 75 }, readImpl: async () => null, minIntervalMs: 0 });
  const out = await cold.check(true);
  assert.equal(out.ok, true);
  assert.equal(out.reason, 'outage');
  assert.deepEqual(out.windows, []);
});

test('CodexMeter.check: rate-limited to minIntervalMs and skipped entirely when disabled', async () => {
  let reads = 0;
  const meter = new cm.CodexMeter({ settings: { ceilingPct: 75 }, readImpl: async () => { reads += 1; return cm.parseRateLimits(GOOD_RESULT); }, minIntervalMs: 60000 });
  await meter.check(true);
  await meter.check(true);
  await meter.check(true);
  assert.equal(reads, 1, 'one spawn per interval');
  const off = new cm.CodexMeter({ settings: { ceilingPct: 75 }, readImpl: async () => { throw new Error('must not be called'); } });
  const r = await off.check(false);
  assert.equal(r.reason, 'outage');
});

// The shape actually observed live on 2026-09-17 (Pro plan): one weekly
// window as `primary`, `secondary` null, planType inside rateLimits.
test('parseRateLimits: the live Pro-plan shape (weekly primary, null secondary, planType nested)', () => {
  const live = {
    ordinaryUsageAllowed: true,
    rateLimits: {
      limitId: 'codex', limitName: null, normalModelSlug: null,
      primary: { usedPercent: 48, windowDurationMins: 10080, resetsAt: 1789974695 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      individualLimit: null, spendControlReached: false, planType: 'pro', rateLimitReachedType: null,
    },
    rateLimitsByLimitId: {},
  };
  const r = cm.parseRateLimits(live);
  assert.deepEqual(r.windows, [{ name: 'codex week', pct: 48, resetsAt: new Date(1789974695 * 1000).toISOString() }]);
  assert.equal(r.planType, 'pro');
  assert.equal(r.limitReached, false);

  const reached = JSON.parse(JSON.stringify(live));
  reached.rateLimits.rateLimitReachedType = 'primary';
  const rr = cm.parseRateLimits(reached);
  assert.equal(rr.limitReached, true);
  assert.equal(rr.windows[0].pct, 100, 'a reached limit reads as a full window');
});
