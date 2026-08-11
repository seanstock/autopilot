'use strict';
// Tests for src/localmodel.js - availability of a model served on this machine.
//
// The behaviour that matters: the UI offers the local model ONLY when a cycle
// spawned against it would actually work. That needs BOTH the inference server
// (holds the weights) and the router (what the CLI is pointed at) to be up.
//
// Availability deliberately does NOT depend on ANTHROPIC_BASE_URL being set in
// the daemon's environment. runner.js injects the router address per cycle, so
// the option's presence tracks "are the servers running" and nothing else -
// including across reboots and daemon restarts.

const test = require('node:test');
const assert = require('node:assert');

const { LocalModel, readConfig, DEFAULTS } = require('../src/localmodel');

const ENV = {
  AUTOPILOT_LOCAL_MODEL: 'muse-glimmer',
  AUTOPILOT_LOCAL_MODEL_LABEL: 'Muse Glimmer 30B (local)',
  AUTOPILOT_LOCAL_MODEL_HEALTH: 'http://127.0.0.1:8080/health',
  AUTOPILOT_LOCAL_MODEL_ROUTER: 'http://127.0.0.1:8787',
};

function makeLm(routerUp, modelUp, opts) {
  const o = opts || {};
  const calls = { tcp: 0, http: 0 };
  const lm = new LocalModel({
    env: o.env || ENV,
    tcpProbe: async () => { calls.tcp += 1; return routerUp; },
    httpProbe: async () => { calls.http += 1; return modelUp; },
    now: o.now,
    ttlMs: o.ttlMs,
  });
  return { lm, calls };
}

test('readConfig falls back to defaults when nothing is set', () => {
  const cfg = readConfig({});
  assert.equal(cfg.id, DEFAULTS.id);
  assert.equal(cfg.label, DEFAULTS.label);
  assert.equal(cfg.healthUrl, DEFAULTS.healthUrl);
  assert.equal(cfg.routerUrl, DEFAULTS.routerUrl);
});

test('readConfig honours env overrides', () => {
  const cfg = readConfig({
    AUTOPILOT_LOCAL_MODEL: 'other-model',
    AUTOPILOT_LOCAL_MODEL_LABEL: 'Other',
    AUTOPILOT_LOCAL_MODEL_HEALTH: 'http://127.0.0.1:9999/up',
    AUTOPILOT_LOCAL_MODEL_ROUTER: 'http://127.0.0.1:7777',
  });
  assert.equal(cfg.id, 'other-model');
  assert.equal(cfg.label, 'Other');
  assert.equal(cfg.healthUrl, 'http://127.0.0.1:9999/up');
  assert.equal(cfg.routerUrl, 'http://127.0.0.1:7777');
});

test('available when both the router and the model answer', async () => {
  const { lm } = makeLm(true, true);
  const s = await lm.refresh();
  assert.equal(s.available, true);
  assert.equal(s.reason, null);
  assert.equal(s.id, 'muse-glimmer');
  assert.equal(s.label, 'Muse Glimmer 30B (local)');
});

test('unavailable when the model server is down', async () => {
  const { lm } = makeLm(true, false);
  const s = await lm.refresh();
  assert.equal(s.available, false);
  assert.equal(s.reason, 'unreachable');
});

test('unavailable when the router is down, and the model is not probed', async () => {
  const { lm, calls } = makeLm(false, true);
  const s = await lm.refresh();
  assert.equal(s.available, false);
  assert.equal(s.reason, 'router-down');
  assert.equal(calls.http, 0, 'no point asking the model when nothing can route to it');
});

// Regression guard for the whole point of the runner.js change: availability
// must not depend on the daemon's environment, or the option would vanish
// after any reboot or restart that did not set ANTHROPIC_BASE_URL.
test('availability does not depend on ANTHROPIC_BASE_URL in the environment', async () => {
  const bare = {}; // no ANTHROPIC_BASE_URL, no AUTOPILOT_* overrides
  const { lm } = makeLm(true, true, { env: bare });
  const s = await lm.refresh();
  assert.equal(s.available, true, 'servers up is sufficient; env is irrelevant');
  assert.equal(s.id, DEFAULTS.id);
});

test('a probe that throws is treated as unavailable, not an error', async () => {
  const lm = new LocalModel({
    env: ENV,
    tcpProbe: async () => { throw new Error('boom'); },
    httpProbe: async () => true,
  });
  const s = await lm.refresh();
  assert.equal(s.available, false);
  assert.equal(s.reason, 'unreachable');
});

test('current() is synchronous and reports unchecked before the first probe', () => {
  const { lm } = makeLm(true, true);
  const s = lm.current();
  assert.equal(s.available, false);
  assert.equal(s.reason, 'unchecked');
  assert.equal(s.id, 'muse-glimmer', 'id/label come from config, not the probe');
});

test('current() serves cache within the TTL and refreshes after it', async () => {
  let clock = 1000;
  const { lm, calls } = makeLm(true, true, { now: () => clock, ttlMs: 5000 });

  lm.current();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.tcp, 1);
  assert.equal(lm.current().available, true);

  clock += 1000;                 // inside TTL
  lm.current();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.tcp, 1, 'no re-probe inside the TTL');

  clock += 10000;                // past TTL
  lm.current();
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.tcp, 2, 're-probes once stale');
});

test('availability flips back to false when the model goes away', async () => {
  let up = true;
  const lm = new LocalModel({
    env: ENV,
    tcpProbe: async () => true,
    httpProbe: async () => up,
    ttlMs: 0,
  });
  assert.equal((await lm.refresh()).available, true);
  up = false;
  assert.equal((await lm.refresh()).available, false);
});

test('concurrent refreshes collapse into one probe', async () => {
  let calls = 0;
  const lm = new LocalModel({
    env: ENV,
    tcpProbe: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return true;
    },
    httpProbe: async () => true,
  });
  await Promise.all([lm.refresh(), lm.refresh(), lm.refresh()]);
  assert.equal(calls, 1, 'in-flight probe must not be duplicated by status polls');
});

// ---- starting the model on demand ------------------------------------------

function startable(opts) {
  const o = opts || {};
  const spawned = [];
  const lm = new LocalModel({
    env: Object.assign({ AUTOPILOT_LOCAL_MODEL_START: '/fake/start-all.ps1' }, ENV),
    tcpProbe: async () => o.routerUp !== false,
    httpProbe: async () => o.modelUp === true,
    existsImpl: () => o.scriptExists !== false,
    spawnImpl: (cmd) => { spawned.push(cmd); },
    now: o.now,
    startWindowMs: o.startWindowMs,
  });
  return { lm, spawned };
}

test('canStart is false when the start script is missing', () => {
  const { lm } = startable({ scriptExists: false });
  assert.equal(lm.canStart(), false);
  const r = lm.start();
  assert.equal(r.ok, false);
  assert.match(r.error, /start script not found/);
});

test('start() launches the configured script', () => {
  const { lm, spawned } = startable({});
  assert.equal(lm.canStart(), true);
  const r = lm.start();
  assert.equal(r.ok, true);
  assert.deepEqual(spawned, ['/fake/start-all.ps1']);
});

test('start() refuses while already starting, so double-clicks do not spawn twice', () => {
  const { lm, spawned } = startable({});
  assert.equal(lm.start().ok, true);
  const second = lm.start();
  assert.equal(second.ok, false);
  assert.match(second.error, /already starting/);
  assert.equal(spawned.length, 1);
});

test('start() refuses when the model is already running', async () => {
  const { lm, spawned } = startable({ modelUp: true });
  await lm.refresh();
  const r = lm.start();
  assert.equal(r.ok, false);
  assert.match(r.error, /already running/);
  assert.equal(spawned.length, 0);
});

test('isStarting() clears once the model answers', async () => {
  let modelUp = false;
  const lm = new LocalModel({
    env: Object.assign({ AUTOPILOT_LOCAL_MODEL_START: '/fake/start-all.ps1' }, ENV),
    tcpProbe: async () => true,
    httpProbe: async () => modelUp,
    existsImpl: () => true,
    spawnImpl: () => {},
  });
  await lm.refresh();
  assert.equal(lm.start().ok, true);
  assert.equal(lm.isStarting(), true);

  modelUp = true;
  await lm.refresh();
  assert.equal(lm.isStarting(), false, 'a running model is not still "starting"');
});

test('isStarting() lapses after the start window so the button comes back', () => {
  let clock = 1000;
  const { lm } = startable({ now: () => clock, startWindowMs: 5000 });
  assert.equal(lm.start().ok, true);
  assert.equal(lm.isStarting(), true);
  clock += 6000;
  assert.equal(lm.isStarting(), false, 'a failed start must not wedge the UI forever');
});

test('current() exposes canStart and starting for the UI', () => {
  const { lm } = startable({});
  const s = lm.current();
  assert.equal(s.canStart, true);
  assert.equal(s.starting, false);
  lm.start();
  assert.equal(lm.current().starting, true);
});

// Regression: start() used to refuse on a STALE "available", so a server that
// died seconds ago could not be restarted until the cache caught up. The
// launcher is idempotent, so a stale cache must not block a start request.
test('start() is allowed when the cached "available" has gone stale', async () => {
  let clock = 1000;
  let modelUp = true;
  const spawned = [];
  const lm = new LocalModel({
    env: Object.assign({ AUTOPILOT_LOCAL_MODEL_START: '/fake/start-all.ps1' }, ENV),
    tcpProbe: async () => true,
    httpProbe: async () => modelUp,
    existsImpl: () => true,
    spawnImpl: (c) => { spawned.push(c); },
    now: () => clock,
    ttlMs: 5000,
  });

  await lm.refresh();
  assert.equal(lm.start().ok, false, 'fresh + available still refuses');

  modelUp = false;      // servers die...
  clock += 10000;       // ...and the cached value goes stale
  const r = lm.start();
  assert.equal(r.ok, true, 'a stale cache must not block a restart');
  assert.equal(spawned.length, 1);
});

// Regression: a failed spawn surfaces asynchronously on Windows, so start()
// reported ok and the UI sat on "starting..." for the whole window in silence.
test('an async spawn failure clears "starting" and is reported', async () => {
  const { EventEmitter } = require('node:events');
  const fake = new EventEmitter();
  const lm = new LocalModel({
    env: Object.assign({ AUTOPILOT_LOCAL_MODEL_START: '/fake/start-all.ps1' }, ENV),
    tcpProbe: async () => false,
    httpProbe: async () => false,
    existsImpl: () => true,
    spawnImpl: () => fake,
  });

  assert.equal(lm.start().ok, true);
  assert.equal(lm.isStarting(), true);

  fake.emit('error', new Error('ENOENT powershell'));
  assert.equal(lm.isStarting(), false, 'must not claim to be starting after a failed launch');
  assert.match(lm.current().startError, /could not launch: ENOENT powershell/);
});

test('a non-zero launcher exit is reported instead of silently hanging', () => {
  const { EventEmitter } = require('node:events');
  const fake = new EventEmitter();
  const lm = new LocalModel({
    env: Object.assign({ AUTOPILOT_LOCAL_MODEL_START: '/fake/start-all.ps1' }, ENV),
    tcpProbe: async () => false,
    httpProbe: async () => false,
    existsImpl: () => true,
    spawnImpl: () => fake,
  });

  assert.equal(lm.start().ok, true);
  fake.emit('exit', 1);
  assert.equal(lm.isStarting(), false);
  assert.match(lm.current().startError, /launcher exited with code 1/);
});

test('a clean launcher exit (0) is normal and does not report an error', () => {
  const { EventEmitter } = require('node:events');
  const fake = new EventEmitter();
  const lm = new LocalModel({
    env: Object.assign({ AUTOPILOT_LOCAL_MODEL_START: '/fake/start-all.ps1' }, ENV),
    tcpProbe: async () => false,
    httpProbe: async () => false,
    existsImpl: () => true,
    spawnImpl: () => fake,
  });

  assert.equal(lm.start().ok, true);
  fake.emit('exit', 0);   // launcher hands off and exits; servers still loading
  assert.equal(lm.isStarting(), true, 'handing off is not failing');
  assert.equal(lm.current().startError, null);
});
