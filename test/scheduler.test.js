'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const { Scheduler } = require('../src/scheduler');
const util = require('../src/util');
const state = require('../src/state');
const events = require('../src/events');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-sched-home-'));
  process.env.AUTOPILOT_HOME_OVERRIDE = dir;
  return dir;
}

function tempProjectDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `autopilot-sched-${prefix}-`));
}

let counter = 0;
function makeProject(overrides) {
  counter += 1;
  const dir = tempProjectDir(`p${counter}`);
  return Object.assign(
    {
      id: `proj-${counter}`,
      dir,
      prompt: 'do work',
      priority: 1,
      enabled: true,
      model: 'claude-sonnet-5',
      maxCycleMinutes: 120,
      criticRatio: 0,
      reviewGateCycles: 0,
      containment: 'off',
    },
    overrides || {}
  );
}

function makeStateObj(projects, settingsOverrides) {
  return {
    settings: Object.assign({ ceilingPct: 75, graceMinutes: 0, webhook: null, port: 4680 }, settingsOverrides || {}),
    projects,
  };
}

// Wraps a partial budget implementation with call counters, so tests don't
// need to re-implement counting in every override.
function makeBudget(overrides) {
  const calls = { check: 0, noteUsageLimitExit: 0, probeGate: 0, clearFatal: 0 };
  const impl = Object.assign(
    {
      async check() {
        return { ok: true, reason: null, windows: [], resetsAt: null, checkedIso: util.nowIso() };
      },
      noteUsageLimitExit() {},
      async probeGate() {
        return { ok: false };
      },
      isFatal() {
        return false;
      },
      clearFatal() {},
    },
    overrides || {}
  );
  return {
    calls,
    async check(...args) {
      calls.check += 1;
      return impl.check(...args);
    },
    noteUsageLimitExit(...args) {
      calls.noteUsageLimitExit += 1;
      return impl.noteUsageLimitExit(...args);
    },
    async probeGate(...args) {
      calls.probeGate += 1;
      return impl.probeGate(...args);
    },
    isFatal(...args) {
      return impl.isFatal(...args);
    },
    clearFatal(...args) {
      calls.clearFatal += 1;
      return impl.clearFatal(...args);
    },
  };
}

function cleanResult(overrides) {
  return Object.assign(
    {
      exit: 'clean',
      code: 0,
      minutes: 0.01,
      tokens: { in: 10, out: 5 },
      costUsd: 0.001,
      commit: 'abc1234',
      gitDiff: { files: 1, ins: 1, del: 0 },
    },
    overrides || {}
  );
}

async function waitUntil(fn, timeoutMs = 1500, intervalMs = 15) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

test.beforeEach(() => {
  tempHome();
  // Never spawn the real `codex app-server` from a suite (see src/codexmeter.js).
  process.env.AUTOPILOT_CODEX_METER_OVERRIDE = 'off';
});

test.afterEach(async () => {
  delete process.env.AUTOPILOT_HOME_OVERRIDE;
});

// ---------------------------------------------------------------------------
// one-cycle-at-a-time invariant
// ---------------------------------------------------------------------------

test('never runs two cycles at once (single async loop invariant)', async () => {
  const p1 = makeProject({ priority: 1 });
  const p2 = makeProject({ priority: 1 });
  const stateObj = makeStateObj([p1, p2]);
  const budget = makeBudget();

  let active = 0;
  let maxActive = 0;
  let totalRuns = 0;
  const runCycleImpl = async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 60));
    active -= 1;
    totalRuns += 1;
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget, runCycleImpl, notifyImpl: () => {}, tickMs: 20 });
  sched.start();
  await waitUntil(() => totalRuns >= 4);
  await sched.stopDaemon();

  assert.equal(maxActive, 1, 'expected at most one concurrent cycle');
});

// ---------------------------------------------------------------------------
// priority + round robin
// ---------------------------------------------------------------------------

test('picks lowest priority number first, round-robins among equal priorities', async () => {
  const lowA = makeProject({ id: 'low-a', priority: 1 });
  const lowB = makeProject({ id: 'low-b', priority: 1 });
  const high = makeProject({ id: 'high', priority: 5 });
  const stateObj = makeStateObj([lowA, lowB, high]);
  const budget = makeBudget();

  const seen = [];
  const runCycleImpl = async ({ project }) => {
    seen.push(project.id);
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget, runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => seen.length >= 6);
  await sched.stopDaemon();

  assert.ok(!seen.includes('high'), 'higher-priority-number project must not run while priority-1 projects are runnable');

  const firstSix = seen.slice(0, 6);
  const countA = firstSix.filter((id) => id === 'low-a').length;
  const countB = firstSix.filter((id) => id === 'low-b').length;
  assert.ok(Math.abs(countA - countB) <= 1, `expected roughly alternating picks, got ${JSON.stringify(firstSix)}`);
});

// ---------------------------------------------------------------------------
// critic modulo
// ---------------------------------------------------------------------------

test('critic kind fires every Nth cycle per criticRatio', async () => {
  const project = makeProject({ criticRatio: 3 });
  const stateObj = makeStateObj([project]);
  const budget = makeBudget();

  const kinds = {};
  const runCycleImpl = async ({ kind, cycleNumber }) => {
    kinds[cycleNumber] = kind;
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget, runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => kinds[6] !== undefined);
  await sched.stopDaemon();

  assert.equal(kinds[1], 'work');
  assert.equal(kinds[2], 'work');
  assert.equal(kinds[3], 'critic');
  assert.equal(kinds[4], 'work');
  assert.equal(kinds[5], 'work');
  assert.equal(kinds[6], 'critic');
});

// ---------------------------------------------------------------------------
// review gate
// ---------------------------------------------------------------------------

test('review gate pauses at reviewGateCycles and Reviewed resumes it', async () => {
  const project = makeProject({ reviewGateCycles: 2 });
  const stateObj = makeStateObj([project]);
  const budget = makeBudget();

  let runs = 0;
  const runCycleImpl = async () => {
    runs += 1;
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget, runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => runs >= 2);
  await new Promise((r) => setTimeout(r, 150)); // several more ticks - must NOT run a 3rd
  assert.equal(runs, 2, 'must stop at the review gate, not run a 3rd cycle');

  const snap = sched.snapshot();
  const projSnap = snap.projects.find((p) => p.id === project.id);
  assert.equal(projSnap.status, 'awaiting-review');

  sched.markReviewed(project.id);
  await waitUntil(() => runs >= 3);
  await sched.stopDaemon();
  assert.ok(runs >= 3);
});

test('a hand-touched REVIEWED file also resumes an awaiting-review project', async () => {
  const project = makeProject({ reviewGateCycles: 1 });
  const stateObj = makeStateObj([project]);
  const budget = makeBudget();

  let runs = 0;
  const runCycleImpl = async () => {
    runs += 1;
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget, runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => runs >= 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(runs, 1);

  util.ensureDir(util.projectMeta(project.dir));
  fs.writeFileSync(path.join(util.projectMeta(project.dir), 'REVIEWED'), '');

  await waitUntil(() => runs >= 2);
  await sched.stopDaemon();
  assert.ok(runs >= 2);
  assert.equal(fs.existsSync(path.join(util.projectMeta(project.dir), 'REVIEWED')), false, 'REVIEWED must be consumed');
});

// ---------------------------------------------------------------------------
// crash-loop cooldown
// ---------------------------------------------------------------------------

test('3 fast crashes cool down that project but the other project keeps running', async () => {
  const crasher = makeProject({ id: 'crasher', priority: 1 });
  const steady = makeProject({ id: 'steady', priority: 1 });
  const stateObj = makeStateObj([crasher, steady]);
  const budget = makeBudget();

  let crasherRuns = 0;
  let steadyRuns = 0;
  const runCycleImpl = async ({ project }) => {
    if (project.id === 'crasher') {
      crasherRuns += 1;
      return cleanResult({ exit: 'crash' });
    }
    steadyRuns += 1;
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget, runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => crasherRuns >= 3);
  const crasherRunsAtCooldown = crasherRuns;

  await waitUntil(() => steadyRuns >= 4, 1500);
  await sched.stopDaemon();

  assert.equal(crasherRuns, crasherRunsAtCooldown, 'crasher must stop running once cooldown trips');

  const runtime = state.readRuntime(crasher.dir);
  assert.ok(runtime.cooldownUntil, 'expected cooldownUntil to be set');

  const snap = sched.snapshot();
  const crasherSnap = snap.projects.find((p) => p.id === 'crasher');
  assert.equal(crasherSnap.status, 'cooldown');
});

// ---------------------------------------------------------------------------
// budget: ceiling / outage
// ---------------------------------------------------------------------------

test('over ceiling: no cycles run, a sleep event is stamped', async () => {
  const project = makeProject();
  const stateObj = makeStateObj([project]);
  const budget = makeBudget({
    async check() {
      return {
        ok: false,
        reason: 'ceiling',
        windows: [],
        resetsAt: new Date(Date.now() + 3600000).toISOString(),
        checkedIso: util.nowIso(),
      };
    },
  });

  let runs = 0;
  const runCycleImpl = async () => {
    runs += 1;
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget, runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await new Promise((r) => setTimeout(r, 200));
  await sched.stopDaemon();

  assert.equal(runs, 0);
  const evs = events.readEvents(project.dir, 50);
  assert.ok(evs.some((e) => e.ev === 'sleep' && e.reason === 'ceiling'));

  const snap = sched.snapshot();
  assert.equal(snap.projects[0].status, 'sleeping');
});

test('usage_limit exit flips to sleep immediately, on the very next tick', async () => {
  const project = makeProject();
  const stateObj = makeStateObj([project]);

  let limited = false;
  const budget = makeBudget({
    async check() {
      if (limited) {
        return { ok: false, reason: 'ceiling', windows: [], resetsAt: null, checkedIso: util.nowIso() };
      }
      return { ok: true, reason: null, windows: [], resetsAt: null, checkedIso: util.nowIso() };
    },
    noteUsageLimitExit() {
      limited = true;
    },
  });

  let runs = 0;
  const kinds = [];
  const runCycleImpl = async ({ kind }) => {
    runs += 1;
    kinds.push(kind);
    // wrapup also dies of usage_limit here - must not chain another wrapup
    return cleanResult({ exit: 'usage_limit' });
  };

  const sched = new Scheduler({ stateObj, budget, runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => runs >= 1);
  await new Promise((r) => setTimeout(r, 150));
  await sched.stopDaemon();

  // Exactly one work cycle + its one cap-summary wrapup; never a third.
  assert.deepEqual(kinds, ['work', 'wrapup'], 'usage_limit triggers exactly one wrapup and no further cycles');
  assert.ok(budget.calls.noteUsageLimitExit >= 1);

  const evs = events.readEvents(project.dir, 50);
  const wrapEnd = evs.find((e) => e.ev === 'cycle_end' && e.kind === 'wrapup');
  assert.ok(wrapEnd, 'wrapup cycle stamped its own cycle_start/cycle_end events');
});

test('token/cost totals accumulate per model, stamp cycle_end, and reach the snapshot', async () => {
  const project = makeProject();
  const stateObj = makeStateObj([project]);

  let runs = 0;
  const runCycleImpl = async () => {
    runs += 1;
    return cleanResult({ tokens: { in: 1000, out: 100 }, costUsd: 0.5 });
  };

  const sched = new Scheduler({ stateObj, budget: makeBudget(), runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => runs >= 2);
  await sched.stopDaemon();

  const runtime = state.readRuntime(project.dir);
  assert.ok(runtime.totals.cycles >= 2);
  assert.equal(runtime.totals.in, runtime.totals.cycles * 1000);
  assert.equal(runtime.totals.out, runtime.totals.cycles * 100);
  assert.ok(Math.abs(runtime.totals.costUsd - runtime.totals.cycles * 0.5) < 1e-9);
  const m = runtime.totals.byModel['claude-sonnet-5'];
  assert.equal(m.cycles, runtime.totals.cycles);

  const evs = events.readEvents(project.dir, 50);
  const end = evs.find((e) => e.ev === 'cycle_end');
  assert.equal(end.model, 'claude-sonnet-5');

  const snap = sched.snapshot();
  assert.equal(snap.projects[0].totals.cycles, runtime.totals.cycles);
  assert.equal(snap.totals.in, runtime.totals.in, 'global totals sum project totals');
});

test('worker cycle routes workerModel + workerEffort (inherits effort when workerEffort unset)', async () => {
  const project = makeProject({ model: 'claude-opus-5', effort: 'high', workerModel: 'claude-sonnet-5' });
  const stateObj = makeStateObj([project]);
  const ordersDir = path.join(project.dir, 'orders');
  fs.mkdirSync(ordersDir, { recursive: true });
  fs.writeFileSync(path.join(ordersDir, '001-a.md'), '# A\nstatus: open\n');

  const seen = [];
  const runCycleImpl = async ({ project: cp, kind, order }) => {
    seen.push({ kind, model: cp.model, effort: cp.effort, order: order && order.id });
    if (order) { try { fs.unlinkSync(path.join(ordersDir, '001-a.md')); } catch (e) {} } // let it finish
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget: makeBudget(), runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => seen.some((s) => s.kind === 'work'));
  await sched.stopDaemon();

  const worker = seen.find((s) => s.kind === 'work');
  assert.equal(worker.model, 'claude-sonnet-5', 'worker runs on workerModel');
  assert.equal(worker.effort, 'high', 'worker inherits project.effort when workerEffort is unset');
});

test('worker cycle uses workerEffort override when set', async () => {
  const project = makeProject({ model: 'claude-opus-5', effort: 'high', workerModel: 'claude-sonnet-5', workerEffort: 'low' });
  const stateObj = makeStateObj([project]);
  const ordersDir = path.join(project.dir, 'orders');
  fs.mkdirSync(ordersDir, { recursive: true });
  fs.writeFileSync(path.join(ordersDir, '001-a.md'), '# A\nstatus: open\n');

  let workerEffort = null;
  const runCycleImpl = async ({ project: cp, order }) => {
    if (order) { workerEffort = cp.effort; try { fs.unlinkSync(path.join(ordersDir, '001-a.md')); } catch (e) {} }
    return cleanResult();
  };
  const sched = new Scheduler({ stateObj, budget: makeBudget(), runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => workerEffort !== null);
  await sched.stopDaemon();
  assert.equal(workerEffort, 'low');
});

test('updateProject command validates, persists, and applies to the next cycle', async () => {
  const project = makeProject({ model: 'claude-sonnet-5' });
  const stateObj = makeStateObj([project]);
  const sched = new Scheduler({ stateObj, budget: makeBudget(), runCycleImpl: async () => cleanResult(), notifyImpl: () => {}, tickMs: 999999 });

  assert.equal(sched.updateProject('nope', { model: 'x' }), false, 'unknown project -> false');
  assert.equal(sched.updateProject(project.id, { model: 'claude-opus-5', effort: 'xhigh' }), true);

  // persisted to projects.json and reflected in the snapshot
  const reloaded = state.getProject(state.load(), project.id);
  assert.equal(reloaded.model, 'claude-opus-5');
  assert.equal(reloaded.effort, 'xhigh');
  const snap = sched.snapshot();
  assert.equal(snap.projects[0].model, 'claude-opus-5');
  assert.equal(snap.projects[0].effort, 'xhigh');
});

test('stuck order: same order re-dispatched at most 3 times, then a grooming orchestrate cycle (I1)', async () => {
  const project = makeProject({ workerModel: 'claude-sonnet-5', criticRatio: 0 });
  const stateObj = makeStateObj([project]);

  const ordersDir = path.join(project.dir, 'orders');
  fs.mkdirSync(ordersDir, { recursive: true });
  // A worker that never advances the status - the livelock scenario.
  fs.writeFileSync(path.join(ordersDir, '001-stuck.md'), '# Stuck\nstatus: open\n\n## Objective\nx\n');

  const kinds = [];
  const runCycleImpl = async ({ kind }) => {
    kinds.push(kind);
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget: makeBudget(), runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => kinds.length >= 5);
  await sched.stopDaemon();

  assert.deepEqual(kinds.slice(0, 4), ['work', 'work', 'work', 'orchestrate'],
    'three attempts at the stuck order, then a forced grooming orchestrate');
  assert.equal(kinds[4], 'work', 'after grooming, the still-open order gets fresh attempts');
});

test('modelUsage breakdown attributes totals per actual model (subagent fan-out)', async () => {
  const project = makeProject({ workerModel: 'claude-sonnet-5', model: 'claude-fable-5-1' });
  const stateObj = makeStateObj([project]);

  let runs = 0;
  const runCycleImpl = async () => {
    runs += 1;
    return cleanResult({
      tokens: { in: 5000, out: 500 },
      costUsd: 3.0,
      modelUsage: {
        'claude-fable-5-1': { in: 1000, out: 100, costUsd: 2.0 },
        'claude-sonnet-5': { in: 4000, out: 400, costUsd: 1.0 },
      },
    });
  };

  const sched = new Scheduler({ stateObj, budget: makeBudget(), runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => runs >= 1);
  await sched.stopDaemon();

  const runtime = state.readRuntime(project.dir);
  const firstCycle = { cycles: runtime.totals.cycles };
  assert.ok(firstCycle.cycles >= 1);
  // Per-cycle invariants (checked proportionally since >1 cycle may run):
  assert.equal(runtime.totals.in, firstCycle.cycles * 5000, 'overall in = sum of per-model in');
  assert.ok(Math.abs(runtime.totals.costUsd - firstCycle.cycles * 3.0) < 1e-9);
  assert.equal(runtime.totals.byModel['claude-fable-5-1'].in, firstCycle.cycles * 1000);
  assert.equal(runtime.totals.byModel['claude-sonnet-5'].in, firstCycle.cycles * 4000);
  assert.equal(runtime.totals.byModel['claude-fable-5-1'].cycles, firstCycle.cycles, 'each participating model counts the cycle');
  assert.equal(runtime.totals.byModel['claude-sonnet-5'].cycles, firstCycle.cycles);

  const evs = events.readEvents(project.dir, 50);
  const end = evs.find((e) => e.ev === 'cycle_end');
  assert.ok(end.modelUsage, 'cycle_end stamps the modelUsage breakdown');
  assert.equal(end.modelUsage['claude-sonnet-5'].out, 400);
});

test('totals backfill seeds once from existing events.jsonl', async () => {
  const project = makeProject();
  const stateObj = makeStateObj([project]);

  events.appendEvent(project.dir, project.id, 'cycle_end', {
    cycle: 1, kind: 'work', model: 'claude-fable-5-1', tokens: { in: 7000, out: 300 }, costUsd: 2.25,
  });
  events.appendEvent(project.dir, project.id, 'cycle_end', {
    cycle: 2, kind: 'work', model: 'claude-fable-5-1', tokens: { in: 3000, out: 200 }, costUsd: 0.75,
  });

  const sched = new Scheduler({ stateObj, budget: makeBudget(), runCycleImpl: async () => cleanResult(), notifyImpl: () => {}, tickMs: 15 });
  const snap = sched.snapshot(); // no cycle has run; snapshot triggers backfill

  const t = snap.projects[0].totals;
  assert.equal(t.cycles, 2);
  assert.equal(t.in, 10000);
  assert.equal(t.out, 500);
  assert.ok(Math.abs(t.costUsd - 3.0) < 1e-9);
  assert.equal(t.byModel['claude-fable-5-1'].cycles, 2);

  const persisted = state.readRuntime(project.dir);
  assert.equal(persisted.totals.cycles, 2, 'backfill persists so it never re-scans');
});

test('pending injection forces the next cycle to be work even on critic cadence', async () => {
  const project = makeProject({ criticRatio: 1 }); // every cycle would be critic
  const stateObj = makeStateObj([project]);

  const meta = path.join(project.dir, '.autopilot');
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, 'INJECT.md'), 'Please add a star field.\n');

  const kinds = [];
  const runCycleImpl = async ({ kind }) => {
    kinds.push(kind);
    if (kinds.length === 1) {
      // the real runner consumes the file on the first work cycle
      try { fs.unlinkSync(path.join(meta, 'INJECT.md')); } catch (e) {}
    }
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget: makeBudget(), runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => kinds.length >= 2);
  await sched.stopDaemon();

  assert.equal(kinds[0], 'work', 'injection pending -> forced work cycle');
  assert.equal(kinds[1], 'critic', 'critic cadence resumes once the injection is consumed');
});

test('recovery toast is debounced even when transitions flap', async () => {
  const project = makeProject();
  const stateObj = makeStateObj([project]);
  stateObj.settings.graceMinutes = 999; // grace blocks cycles; we only watch notify

  // Budget alternates not-ok/ok every check - the pathological flap.
  let flip = false;
  const budget = makeBudget({
    async check() {
      flip = !flip;
      return flip
        ? { ok: false, reason: 'ceiling', windows: [], resetsAt: null, checkedIso: util.nowIso() }
        : { ok: true, reason: null, windows: [], resetsAt: null, checkedIso: util.nowIso() };
    },
  });

  let notifies = 0;
  const sched = new Scheduler({
    stateObj,
    budget,
    runCycleImpl: async () => cleanResult(),
    notifyImpl: () => {
      notifies += 1;
    },
    tickMs: 10,
  });
  sched.start();
  await new Promise((r) => setTimeout(r, 400)); // ~40 ticks, ~20 not-ok->ok transitions
  await sched.stopDaemon();

  assert.equal(notifies, 1, 'flapping transitions must produce at most one toast per debounce window');
});

test('capSummary=false disables the usage-cap wrapup cycle', async () => {
  const project = makeProject();
  const stateObj = makeStateObj([project]);
  stateObj.settings.capSummary = false;

  let limited = false;
  const budget = makeBudget({
    async check() {
      if (limited) {
        return { ok: false, reason: 'ceiling', windows: [], resetsAt: null, checkedIso: util.nowIso() };
      }
      return { ok: true, reason: null, windows: [], resetsAt: null, checkedIso: util.nowIso() };
    },
    noteUsageLimitExit() {
      limited = true;
    },
  });

  let runs = 0;
  const runCycleImpl = async () => {
    runs += 1;
    return cleanResult({ exit: 'usage_limit' });
  };

  const sched = new Scheduler({ stateObj, budget, runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => runs >= 1);
  await new Promise((r) => setTimeout(r, 150));
  await sched.stopDaemon();

  assert.equal(runs, 1, 'no wrapup when capSummary is false');
});

// ---------------------------------------------------------------------------
// fatal latch precedence
// ---------------------------------------------------------------------------

test('fatal latch: everything idles regardless of budget or per-project state', async () => {
  const project = makeProject();
  const stateObj = makeStateObj([project]);
  const budget = makeBudget();

  state.writeFatal('test_fatal_reason');

  let runs = 0;
  const runCycleImpl = async () => {
    runs += 1;
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget, runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await new Promise((r) => setTimeout(r, 200));
  await sched.stopDaemon();

  assert.equal(runs, 0);
  const snap = sched.snapshot();
  assert.ok(snap.fatal);
  assert.equal(snap.fatal.reason, 'test_fatal_reason');
  for (const p of snap.projects) assert.equal(p.status, 'fatal');
});

test('clearFatal releases the latch and cycles resume', async () => {
  const project = makeProject();
  const stateObj = makeStateObj([project]);
  const budget = makeBudget();
  state.writeFatal('test_fatal_reason');

  let runs = 0;
  const runCycleImpl = async () => {
    runs += 1;
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget, runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(runs, 0);

  sched.clearFatal();
  await waitUntil(() => runs >= 1);
  await sched.stopDaemon();
  assert.ok(runs >= 1);
});

// ---------------------------------------------------------------------------
// grace period after recovery
// ---------------------------------------------------------------------------

test('grace period: notify fires on recovery and the first cycle waits graceMinutes', async () => {
  const project = makeProject();
  const stateObj = makeStateObj([project], { graceMinutes: 0.01 }); // ~0.6s

  let ok = false;
  const budget = makeBudget({
    async check() {
      if (!ok) return { ok: false, reason: 'outage', windows: [], resetsAt: null, checkedIso: util.nowIso() };
      return { ok: true, reason: null, windows: [], resetsAt: null, checkedIso: util.nowIso() };
    },
  });

  let notifyCalls = 0;
  let runs = 0;
  const runCycleImpl = async () => {
    runs += 1;
    return cleanResult();
  };

  const sched = new Scheduler({
    stateObj,
    budget,
    runCycleImpl,
    notifyImpl: () => {
      notifyCalls += 1;
    },
    tickMs: 15,
  });
  sched.start();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(runs, 0, 'still in outage, must not run yet');

  const recoveredAt = Date.now();
  ok = true;
  await waitUntil(() => notifyCalls >= 1, 500);
  assert.equal(runs, 0, 'must not run immediately on the recovery tick, grace must gate it');

  await waitUntil(() => runs >= 1, 1500);
  const elapsed = Date.now() - recoveredAt;
  await sched.stopDaemon();

  assert.ok(elapsed >= 550, `expected the ~600ms grace wait to be honored, only waited ${elapsed}ms`);
});

test('I1: sticky probe rescue stays runnable across multiple probe intervals; notify/grace fire exactly once', async () => {
  const project = makeProject();
  const stateObj = makeStateObj([project], { graceMinutes: 0 });

  let probeCount = 0;
  const budget = makeBudget({
    async check() {
      return { ok: false, reason: 'outage', windows: [], resetsAt: null, checkedIso: util.nowIso() };
    },
    async probeGate() {
      probeCount += 1;
      // First probe attempt fails (establishes the not-ok state via the
      // normal sleep path); every probe after that succeeds.
      return { ok: probeCount > 1 };
    },
  });

  let notifyCalls = 0;
  let runs = 0;
  const runCycleImpl = async () => {
    runs += 1;
    return cleanResult();
  };

  const sched = new Scheduler({
    stateObj,
    budget,
    runCycleImpl,
    notifyImpl: () => {
      notifyCalls += 1;
    },
    tickMs: 15,
    probeIntervalMs: 150,
  });
  sched.start();

  // Before the I1 fix, effectiveOk was only true on the single tick a probe
  // happened to run on - every tick in between (the vast majority) saw the
  // still-down real meter and reasserted not-ok, so the loop never ran a
  // cycle and notify/grace_start refired on every probe interval. Wait long
  // enough to cross at least two probe-interval boundaries.
  await waitUntil(() => runs >= 1, 3000);
  await new Promise((r) => setTimeout(r, 400)); // cross another probe interval boundary
  await sched.stopDaemon();

  assert.ok(runs >= 1, 'a cycle must actually run once the probe-rescued sticky window is in effect');
  assert.equal(notifyCalls, 1, 'notify must fire exactly once across the whole rescued streak, not per probe interval');

  const evs = events.readEvents(project.dir, 200);
  const graceStarts = evs.filter((e) => e.ev === 'grace_start');
  assert.equal(graceStarts.length, 1, 'grace_start must be stamped exactly once, not once per probe interval');
});

test('I2: stopDaemon waits (bounded) for an in-flight cycle via the STOP mechanism, then removes STOP', async () => {
  const project = makeProject();
  const stateObj = makeStateObj([project]);
  const budget = makeBudget();

  const stopPath = path.join(util.projectMeta(project.dir), 'STOP');
  let started = false;
  let sawStopDuring = false;
  const runCycleImpl = async () => {
    started = true;
    // Mimic the real runner's own contract: poll for STOP and, once it
    // appears, classify 'stopped' (runner.js already tree-kills + classifies
    // this way; the scheduler's shutdown path is supposed to trigger it via
    // the STOP file rather than duplicating the kill logic).
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(stopPath) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    sawStopDuring = fs.existsSync(stopPath);
    return cleanResult({ exit: 'stopped' });
  };

  const sched = new Scheduler({ stateObj, budget, runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => started);

  const stoppedAt = Date.now();
  await sched.stopDaemon();
  const elapsed = Date.now() - stoppedAt;

  assert.ok(sawStopDuring, 'the in-flight cycle must observe the STOP file stopDaemon() creates');
  assert.equal(fs.existsSync(stopPath), false, 'stopDaemon() must remove the STOP file it created once the cycle finishes');
  assert.ok(elapsed < 5000, `stopDaemon must not hang past the bounded shutdown window, took ${elapsed}ms`);

  const evs = events.readEvents(project.dir, 50);
  assert.ok(
    evs.some((e) => e.ev === 'cycle_end' && e.exit === 'stopped'),
    'cycle_end must still be stamped for the gracefully-stopped cycle'
  );
});

test('pauseAll idles the loop; resumeAll continues without the budget-recovery grace wait', async () => {
  const project = makeProject();
  const stateObj = makeStateObj([project], { graceMinutes: 30 }); // large - must never apply here
  const budget = makeBudget();

  let runs = 0;
  const runCycleImpl = async () => {
    runs += 1;
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget, runCycleImpl, notifyImpl: () => {}, tickMs: 15 });

  sched.pauseAll();
  sched.start();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(runs, 0);

  const beforeResume = Date.now();
  sched.resumeAll();
  await waitUntil(() => runs >= 1, 500);
  const elapsed = Date.now() - beforeResume;
  await sched.stopDaemon();

  assert.ok(elapsed < 400, `manual resume should not incur the budget-recovery grace wait, took ${elapsed}ms`);
});

// ---------------------------------------------------------------------------
// STOP / start project
// ---------------------------------------------------------------------------

test('stopProject creates STOP (status stopped, no cycles); startProject clears it', async () => {
  const project = makeProject();
  const stateObj = makeStateObj([project]);
  const budget = makeBudget();

  let runs = 0;
  const runCycleImpl = async () => {
    runs += 1;
    return cleanResult();
  };
  const sched = new Scheduler({ stateObj, budget, runCycleImpl, notifyImpl: () => {}, tickMs: 15 });

  sched.stopProject(project.id);
  sched.start();
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(runs, 0);

  let snap = sched.snapshot();
  assert.equal(snap.projects[0].status, 'stopped');

  sched.startProject(project.id);
  await waitUntil(() => runs >= 1);
  await sched.stopDaemon();
  assert.ok(runs >= 1);
});

// ---------------------------------------------------------------------------
// I6: setPriority rejects non-numeric values (server-side half)
// ---------------------------------------------------------------------------

test('I6: setPriority rejects a non-numeric priority and leaves the stored value untouched', async () => {
  const project = makeProject({ priority: 2 });
  const stateObj = makeStateObj([project]);
  const budget = makeBudget();
  const sched = new Scheduler({ stateObj, budget, runCycleImpl: async () => cleanResult(), notifyImpl: () => {}, tickMs: 1000 });

  const ok = sched.setPriority(project.id, '<script>alert(1)</script>');
  assert.equal(ok, false);
  assert.equal(project.priority, 2, 'priority must be unchanged after a rejected update');

  const okNumeric = sched.setPriority(project.id, '5');
  assert.equal(okNumeric, true);
  assert.equal(project.priority, 5, 'a numeric string must still be accepted and coerced');
});

// ---------------------------------------------------------------------------
// daemon pid lock
// ---------------------------------------------------------------------------

test('start() overwrites a stale pid file (recorded pid is not alive)', async () => {
  const stateObj = makeStateObj([]);
  const budget = makeBudget();
  util.writeJson(path.join(util.AUTOPILOT_HOME, 'daemon.pid'), { pid: 999999999, startedIso: util.nowIso() });

  const sched = new Scheduler({ stateObj, budget, runCycleImpl: async () => cleanResult(), notifyImpl: () => {}, tickMs: 1000 });
  assert.doesNotThrow(() => sched.start());
  await sched.stopDaemon();
});

test('start() refuses when the recorded pid belongs to a live, different process', async () => {
  const stateObj = makeStateObj([]);
  const budget = makeBudget();

  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { windowsHide: true });
  try {
    await new Promise((resolve) => {
      if (child.pid) resolve();
      else child.once('spawn', resolve);
    });
    util.writeJson(path.join(util.AUTOPILOT_HOME, 'daemon.pid'), { pid: child.pid, startedIso: util.nowIso() });

    const sched = new Scheduler({
      stateObj,
      budget,
      runCycleImpl: async () => cleanResult(),
      notifyImpl: () => {},
      tickMs: 1000,
    });
    assert.throws(() => sched.start(), /already running/);
  } finally {
    child.kill();
  }
});

// ---------------------------------------------------------------------------
// snapshot shape
// ---------------------------------------------------------------------------

test('snapshot matches the shared status contract shape', async () => {
  const project = makeProject();
  const stateObj = makeStateObj([project]);
  const budget = makeBudget();
  const sched = new Scheduler({
    stateObj,
    budget,
    runCycleImpl: async () => cleanResult(),
    notifyImpl: () => {},
    tickMs: 1000,
  });

  const snap = sched.snapshot();
  // 'localModel' joined this list when Autopilot learned to run cycles against
  // a model served on this machine. The original list was deliberately exact so
  // that a field added to the snapshot has to be justified here rather than
  // appearing silently; that reasoning still holds, hence the edit rather than
  // a loosened assertion. See src/localmodel.js for why availability is a
  // probe plus an ANTHROPIC_BASE_URL check rather than just a probe.
  assert.deepEqual(Object.keys(snap).sort(), ['budget', 'concurrency', 'current', 'daemon', 'engines', 'fatal', 'keys', 'localModel', 'models', 'projects', 'running', 'settings', 'totals'].sort());
  assert.deepEqual(Object.keys(snap.localModel).sort(),
    ['available', 'canStart', 'id', 'label', 'reason', 'starting', 'startError'].sort());
  // 'platform' was added 2026-09-15 so the UI can hide the Windows-only
  // native folder picker on macOS/Linux rather than show a button that 501s.
  assert.deepEqual(Object.keys(snap.daemon).sort(), ['pid', 'startedIso', 'version', 'paused', 'platform'].sort());
  assert.equal(snap.daemon.platform, process.platform);
  // 'codex' (2026-09-17): the ChatGPT-plan meter read through the Codex app
  // server, alongside the Anthropic windows.
  assert.deepEqual(Object.keys(snap.budget).sort(), ['ok', 'reason', 'checkedIso', 'windows', 'codex'].sort());
  assert.deepEqual(Object.keys(snap.budget.codex).sort(), ['ok', 'reason', 'checkedIso', 'resetsAt', 'planType', 'windows'].sort());
  // 'notes' is the shared "things to know" prepended to every project's
  // mission. It rides in settings so the UI can edit it in one place.
  assert.deepEqual(Object.keys(snap.settings).sort(),
    ['ceilingPct', 'graceMinutes', 'webhook', 'notes', 'concurrency', 'projectsRoot'].sort());

  const p = snap.projects[0];
  for (const key of ['status', 'statusDetail', 'cycle', 'sinceReview', 'lastExit', 'lastCommit', 'lastVerify', 'pendingInject', 'totals', 'orders']) {
    assert.ok(key in p, `missing ${key} on project snapshot`);
  }
  assert.equal(p.orders, null, 'orders must be null when the project has no workerModel');
  assert.ok(
    ['running', 'queued', 'sleeping', 'awaiting-review', 'stopped', 'cooldown', 'fatal'].includes(p.status),
    `unexpected status ${p.status}`
  );
});

// ---------------------------------------------------------------------------
// v0.3: orchestration kind selection, order routing, verify/order stamping
// ---------------------------------------------------------------------------

function writeOrder(projectDir, filename, status, extra) {
  const dir = path.join(projectDir, 'orders');
  fs.mkdirSync(dir, { recursive: true });
  const body =
    `# ${filename}\n` +
    `status: ${status}\n` +
    `created: 2026-07-24T00:00:00-07:00 by cycle 1\n` +
    `verify: ${(extra && extra.verify) || '-'}\n\n` +
    `## Objective\ndo the thing\n\n` +
    `## Acceptance criteria\n- [ ] done\n\n` +
    `## Boundaries\nsrc/\n`;
  fs.writeFileSync(path.join(dir, filename), body);
}

test('no workerModel: v0.2 behavior - work kind, no order, project.model passed through unchanged', async () => {
  const project = makeProject({ criticRatio: 0 });
  const stateObj = makeStateObj([project]);

  const received = [];
  const runCycleImpl = async (args) => {
    received.push(args);
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget: makeBudget(), runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => received.length >= 1);
  await sched.stopDaemon();

  assert.equal(received[0].kind, 'work');
  assert.equal(received[0].order, null);
  assert.equal(received[0].project.model, 'claude-sonnet-5');
});

test('orchestration enabled + one open order: work kind, correct order id, effective model is workerModel', async () => {
  const project = makeProject({ criticRatio: 0, workerModel: 'claude-haiku-4-5-20251001' });
  writeOrder(project.dir, '001-first.md', 'open');
  writeOrder(project.dir, '002-second.md', 'open');
  const stateObj = makeStateObj([project]);

  const received = [];
  const runCycleImpl = async (args) => {
    received.push(args);
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget: makeBudget(), runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => received.length >= 1);
  await sched.stopDaemon();

  assert.equal(received[0].kind, 'work');
  assert.ok(received[0].order, 'expected an order to be passed');
  assert.equal(received[0].order.id, '001-first', 'must pick the lowest-filename open order');
  assert.match(received[0].order.content, /^# 001-first\.md/);
  assert.equal(received[0].project.model, 'claude-haiku-4-5-20251001', 'effective model must be workerModel');
});

test('orchestration enabled + zero open orders: orchestrate kind, project.model (big model)', async () => {
  const project = makeProject({ criticRatio: 0, workerModel: 'claude-haiku-4-5-20251001', model: 'claude-fable-5-1' });
  writeOrder(project.dir, '001-done.md', 'done');
  writeOrder(project.dir, '002-blocked.md', 'blocked');
  const stateObj = makeStateObj([project]);

  const received = [];
  const runCycleImpl = async (args) => {
    received.push(args);
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget: makeBudget(), runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => received.length >= 1);
  await sched.stopDaemon();

  assert.equal(received[0].kind, 'orchestrate');
  assert.equal(received[0].order, null);
  assert.equal(received[0].project.model, 'claude-fable-5-1', 'orchestrate cycles use the big model, not workerModel');
});

test('critic cadence still fires ahead of order-based work even when orchestration is enabled', async () => {
  const project = makeProject({ criticRatio: 2, workerModel: 'claude-haiku-4-5-20251001' });
  writeOrder(project.dir, '001-open.md', 'open');
  const stateObj = makeStateObj([project]);

  const kinds = [];
  const runCycleImpl = async ({ kind }) => {
    kinds.push(kind);
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget: makeBudget(), runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => kinds.length >= 2);
  await sched.stopDaemon();

  assert.equal(kinds[0], 'work');
  assert.equal(kinds[1], 'critic', 'critic cadence must still win over the open order');
});

test('pending injection forces orchestrate (not work) when orchestration is enabled', async () => {
  const project = makeProject({ criticRatio: 0, workerModel: 'claude-haiku-4-5-20251001' });
  writeOrder(project.dir, '001-open.md', 'open');
  const stateObj = makeStateObj([project]);

  const meta = path.join(project.dir, '.autopilot');
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, 'INJECT.md'), 'Please replan.\n');

  const kinds = [];
  const runCycleImpl = async ({ kind }) => {
    kinds.push(kind);
    return cleanResult();
  };

  const sched = new Scheduler({ stateObj, budget: makeBudget(), runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => kinds.length >= 1);
  await sched.stopDaemon();

  assert.equal(kinds[0], 'orchestrate', 'injection must force orchestrate, not work, when orchestration is enabled');
});

test('cycle_end carries order id and verify verbatim from the fake runCycleImpl result', async () => {
  const project = makeProject({ criticRatio: 0, workerModel: 'claude-haiku-4-5-20251001' });
  writeOrder(project.dir, '005-widget.md', 'open');
  const stateObj = makeStateObj([project]);

  const runCycleImpl = async () => cleanResult({ verify: { cmd: 'npm test', ok: true, code: 0 } });

  const sched = new Scheduler({ stateObj, budget: makeBudget(), runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => {
    const evs = events.readEvents(project.dir, 50);
    return evs.some((e) => e.ev === 'cycle_end');
  });
  await sched.stopDaemon();

  const evs = events.readEvents(project.dir, 50);
  const end = evs.find((e) => e.ev === 'cycle_end');
  assert.equal(end.order, '005-widget');
  assert.deepEqual(end.verify, { cmd: 'npm test', ok: true, code: 0 });
  assert.equal(end.model, 'claude-haiku-4-5-20251001');
});

test('cycle_end verify is null when the fake result omits it', async () => {
  const project = makeProject({ criticRatio: 0 });
  const stateObj = makeStateObj([project]);
  const runCycleImpl = async () => cleanResult();

  const sched = new Scheduler({ stateObj, budget: makeBudget(), runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => {
    const evs = events.readEvents(project.dir, 50);
    return evs.some((e) => e.ev === 'cycle_end');
  });
  await sched.stopDaemon();

  const evs = events.readEvents(project.dir, 50);
  const end = evs.find((e) => e.ev === 'cycle_end');
  assert.equal(end.order, null);
  assert.equal(end.verify, null);
});

test('totals attribute the effective model (workerModel) for order-driven work cycles', async () => {
  const project = makeProject({ criticRatio: 0, workerModel: 'claude-haiku-4-5-20251001', model: 'claude-fable-5-1' });
  writeOrder(project.dir, '001-open.md', 'open');
  const stateObj = makeStateObj([project]);

  const runCycleImpl = async () => cleanResult({ tokens: { in: 500, out: 50 }, costUsd: 0.1 });

  const sched = new Scheduler({ stateObj, budget: makeBudget(), runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => {
    const rt = state.readRuntime(project.dir);
    return (rt.totals && rt.totals.cycles) >= 1;
  });
  await sched.stopDaemon();

  const runtime = state.readRuntime(project.dir);
  assert.equal(runtime.totals.byModel['claude-haiku-4-5-20251001'].cycles, 1);
  assert.equal(runtime.totals.byModel['claude-fable-5-1'], undefined, 'the big model must not be credited for a worker cycle');
});

test('snapshot orders counts reflect a temp orders/ dir, null when orchestration disabled', async () => {
  const orchestrated = makeProject({ workerModel: 'claude-haiku-4-5-20251001', priority: 1 });
  writeOrder(orchestrated.dir, '001-a.md', 'open');
  writeOrder(orchestrated.dir, '002-b.md', 'open');
  writeOrder(orchestrated.dir, '003-c.md', 'in_progress');
  writeOrder(orchestrated.dir, '004-d.md', 'done');
  writeOrder(orchestrated.dir, '005-e.md', 'blocked');

  const plain = makeProject({ priority: 1 });

  const stateObj = makeStateObj([orchestrated, plain]);
  const sched = new Scheduler({
    stateObj,
    budget: makeBudget(),
    runCycleImpl: async () => cleanResult(),
    notifyImpl: () => {},
    tickMs: 1000,
  });

  const snap = sched.snapshot();
  const orchSnap = snap.projects.find((p) => p.id === orchestrated.id);
  const plainSnap = snap.projects.find((p) => p.id === plain.id);

  assert.deepEqual(orchSnap.orders, { open: 2, inProgress: 1, done: 1, blocked: 1 });
  assert.equal(plainSnap.orders, null);
});

// ---------------------------------------------------------------------------
// concurrency (2026-08-07): settings.concurrency cycle slots
// ---------------------------------------------------------------------------

test('concurrency 2 runs two different projects overlapped, never the same project twice', async () => {
  const dirA = tempProjectDir();
  const dirB = tempProjectDir();
  const stateObj = makeStateObj([
    makeProject({ id: 'proj-a', dir: dirA }),
    makeProject({ id: 'proj-b', dir: dirB }),
  ]);
  stateObj.settings.concurrency = 2;

  let inFlight = 0;
  let maxInFlight = 0;
  const perProjectOverlap = new Set();
  const running = new Set();
  const sched = new Scheduler({
    stateObj,
    budget: makeBudget(),
    notifyImpl: () => {},
    tickMs: 10,
    runCycleImpl: async ({ project }) => {
      if (running.has(project.id)) perProjectOverlap.add(project.id);
      running.add(project.id);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 120));
      inFlight -= 1;
      running.delete(project.id);
      return cleanResult();
    },
  });

  sched.start();
  const overlapped = await waitUntil(() => maxInFlight >= 2, 3000);
  await sched.stopDaemon();

  assert.equal(overlapped, true, 'two cycles were in flight at once');
  assert.equal(perProjectOverlap.size, 0, 'no project ever ran two cycles concurrently');
});

test('concurrency 1 (default) stays strictly serial', async () => {
  const stateObj = makeStateObj([
    makeProject({ id: 'proj-a', dir: tempProjectDir() }),
    makeProject({ id: 'proj-b', dir: tempProjectDir() }),
  ]);
  let inFlight = 0;
  let maxInFlight = 0;
  let cycles = 0;
  const sched = new Scheduler({
    stateObj,
    budget: makeBudget(),
    notifyImpl: () => {},
    tickMs: 10,
    runCycleImpl: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 40));
      inFlight -= 1;
      cycles += 1;
      return cleanResult();
    },
  });
  sched.start();
  await waitUntil(() => cycles >= 4, 3000);
  await sched.stopDaemon();
  assert.equal(maxInFlight, 1, 'never more than one cycle in flight');
});

test('updateSettings validates concurrency and snapshot reports running slots', () => {
  const stateObj = makeStateObj([makeProject({ id: 'proj-a', dir: tempProjectDir() })]);
  const sched = new Scheduler({ stateObj, budget: makeBudget(), notifyImpl: () => {}, tickMs: 999999 });

  sched.updateSettings({ concurrency: 3 });
  assert.equal(stateObj.settings.concurrency, 3);
  sched.updateSettings({ concurrency: 'nope' });
  assert.equal(stateObj.settings.concurrency, 3, 'invalid value ignored');
  sched.updateSettings({ concurrency: 99 });
  assert.equal(stateObj.settings.concurrency, 3, 'out-of-range ignored');

  sched._running.set('proj-a', { projectId: 'proj-a', cycle: 2, kind: 'work', startedIso: util.nowIso() });
  const snap = sched.snapshot();
  assert.equal(snap.concurrency, 3);
  assert.equal(snap.running.length, 1);
  assert.equal(snap.current.projectId, 'proj-a', 'current stays populated for compat');
  const p = snap.projects.find((x) => x.id === 'proj-a');
  assert.equal(p.status, 'running');
  assert.match(p.statusDetail, /cycle 2 \(work\)/);
});

test('stopDaemon waits for ALL concurrent cycles and STOPs each running project', async () => {
  const dirs = [tempProjectDir(), tempProjectDir()];
  const stateObj = makeStateObj([
    makeProject({ id: 'proj-a', dir: dirs[0] }),
    makeProject({ id: 'proj-b', dir: dirs[1] }),
  ]);
  stateObj.settings.concurrency = 2;

  let started = 0;
  let finished = 0;
  const sched = new Scheduler({
    stateObj,
    budget: makeBudget(),
    notifyImpl: () => {},
    tickMs: 10,
    runCycleImpl: async () => {
      started += 1;
      await new Promise((r) => setTimeout(r, 300));
      finished += 1;
      return cleanResult();
    },
  });
  sched.start();
  await waitUntil(() => started >= 2, 3000);
  await sched.stopDaemon();

  assert.equal(finished >= 2, true, 'stopDaemon returned only after both in-flight cycles finished');
  assert.equal(sched._running.size, 0, 'no cycles left registered');
  for (const dir of dirs) {
    assert.equal(fs.existsSync(path.join(dir, '.autopilot', 'STOP')), false, `shutdown STOP cleaned up in ${dir}`);
  }
});

// ---------------------------------------------------------------------------
// engines (2026-09-15): codex projects are gated by their own latch, never
// by the Anthropic meter
// ---------------------------------------------------------------------------

test('a codex project keeps running while the Anthropic meter is over ceiling; a claude project sleeps', async () => {
  const claudeP = makeProject({ id: 'claude-p', engine: 'claude' });
  const codexP = makeProject({ id: 'codex-p', engine: 'codex', model: 'default' });
  const stateObj = makeStateObj([claudeP, codexP], { graceMinutes: 0 });
  const budget = makeBudget({
    async check() {
      return { ok: false, reason: 'ceiling', windows: [], resetsAt: null, checkedIso: util.nowIso() };
    },
  });
  budget.engineOk = (engine) => ({ ok: true, reason: null, resetsAt: null });

  const seen = [];
  const runCycleImpl = async ({ project }) => {
    seen.push(project.id);
    return cleanResult();
  };
  const sched = new Scheduler({ stateObj, budget, runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => seen.length >= 3);
  const snap = sched.snapshot();
  await sched.stopDaemon();

  assert.ok(seen.every((id) => id === 'codex-p'), `only codex cycles expected, got ${JSON.stringify(seen)}`);
  const byId = Object.fromEntries(snap.projects.map((p) => [p.id, p]));
  assert.equal(byId['claude-p'].status, 'sleeping');
  assert.equal(byId['claude-p'].statusDetail, 'ceiling');
  assert.notEqual(byId['codex-p'].status, 'sleeping');
});

test('a codex usage-limit exit latches only codex; the sleep event is stamped into claude projects only', async () => {
  const claudeP = makeProject({ id: 'claude-q', engine: 'claude' });
  const codexP = makeProject({ id: 'codex-q', engine: 'codex', model: 'default' });
  // capSummary off: otherwise the usage-limit exit also triggers the wrapup
  // cycle, which exits usage_limit again under this fake and notes twice.
  const stateObj = makeStateObj([claudeP, codexP], { graceMinutes: 0, capSummary: false });
  let codexLatched = false;
  const notes = [];
  const budget = makeBudget({
    noteUsageLimitExit(engine) { notes.push(engine); if (engine === 'codex') codexLatched = true; },
  });
  budget.engineOk = (engine) => (engine === 'codex' && codexLatched
    ? { ok: false, reason: 'ceiling', resetsAt: '2099-01-01T00:00:00Z' }
    : { ok: true, reason: null, resetsAt: null });

  const seen = [];
  const runCycleImpl = async ({ project }) => {
    seen.push(project.id);
    if (project.id === 'codex-q') return cleanResult({ exit: 'usage_limit', commit: null });
    return cleanResult();
  };
  const sched = new Scheduler({ stateObj, budget, runCycleImpl, notifyImpl: () => {}, tickMs: 15 });
  sched.start();
  await waitUntil(() => seen.filter((id) => id === 'claude-q').length >= 3);
  const snap = sched.snapshot();
  await sched.stopDaemon();

  assert.deepEqual(notes, ['codex']);
  assert.equal(seen.filter((id) => id === 'codex-q').length, 1, 'codex ran once, then its latch held it');
  const byId = Object.fromEntries(snap.projects.map((p) => [p.id, p]));
  assert.equal(byId['codex-q'].status, 'sleeping');
  assert.match(byId['codex-q'].statusDetail, /codex usage limit/);
  assert.notEqual(byId['claude-q'].status, 'sleeping');
});

test('_appendGlobalEvent with an engine filter skips the other engine\'s projects', () => {
  const claudeP = makeProject({ engine: 'claude' });
  const codexP = makeProject({ engine: 'codex', model: 'default' });
  const sched = new Scheduler({ stateObj: makeStateObj([claudeP, codexP]), budget: makeBudget(), runCycleImpl: async () => cleanResult(), notifyImpl: () => {} });
  sched._appendGlobalEvent('sleep', { reason: 'ceiling', until: null }, 'claude');
  assert.equal(events.readEvents(claudeP.dir).filter((e) => e.ev === 'sleep').length, 1);
  assert.equal(events.readEvents(codexP.dir).filter((e) => e.ev === 'sleep').length, 0);
  sched._appendGlobalEvent('sleep', { reason: 'paused', until: null });
  assert.equal(events.readEvents(codexP.dir).filter((e) => e.ev === 'sleep').length, 1, 'no filter: every project');
});

test('snapshot carries engines status and settings.projectsRoot', () => {
  const fakeEngines = {
    current: () => ({ claude: { id: 'claude', installed: true, loggedIn: true }, codex: { id: 'codex', installed: false, loggedIn: false } }),
    refresh: async () => ({}),
    login: () => ({ ok: true }),
  };
  const sched = new Scheduler({ stateObj: makeStateObj([], { projectsRoot: null }), budget: makeBudget(), runCycleImpl: async () => cleanResult(), notifyImpl: () => {}, engines: fakeEngines });
  const snap = sched.snapshot();
  assert.equal(snap.engines.codex.installed, false);
  assert.equal(snap.settings.projectsRoot, null);
  assert.equal(sched.startEngineLogin('codex').ok, true);
});

test('updateSettings validates projectsRoot: existing absolute dir kept, junk dropped, empty clears', () => {
  const sched = new Scheduler({ stateObj: makeStateObj([]), budget: makeBudget(), runCycleImpl: async () => cleanResult(), notifyImpl: () => {} });
  const dir = tempProjectDir('root');
  assert.equal(sched.updateSettings({ projectsRoot: dir }).projectsRoot, path.resolve(dir));
  assert.equal(sched.updateSettings({ projectsRoot: 'relative/nope' }).projectsRoot, path.resolve(dir), 'invalid value ignored');
  assert.equal(sched.updateSettings({ projectsRoot: path.join(dir, 'does-not-exist') }).projectsRoot, path.resolve(dir));
  assert.equal(sched.updateSettings({ projectsRoot: '' }).projectsRoot, null);
});

test('setProviderKeys / detectProviderKeys persist to keys.json and surface masked in the snapshot', () => {
  const sched = new Scheduler({ stateObj: makeStateObj([]), budget: makeBudget(), runCycleImpl: async () => cleanResult(), notifyImpl: () => {} });
  const s = sched.setProviderKeys({ openai: 'sk-proj-1234567890abc' });
  assert.equal(s.openai.set, true);
  assert.equal(s.openai.masked, 'sk-pr...abc');
  assert.equal(sched.snapshot().keys.openai.set, true);
  assert.doesNotMatch(JSON.stringify(sched.snapshot()), /1234567890/, 'the key never enters the snapshot');
  sched.setProviderKeys({ openai: '' });
  assert.equal(sched.snapshot().keys.openai.set, false);
});

test('runCycleImpl receives providerKeys and codexLoggedIn', async () => {
  const project = makeProject();
  const stateObj = makeStateObj([project]);
  const fakeEngines = { current: () => ({ claude: { loggedIn: true }, codex: { loggedIn: false } }), refresh: async () => ({}), login: () => ({ ok: true }) };
  let received = null;
  const sched = new Scheduler({ stateObj, budget: makeBudget(), notifyImpl: () => {}, tickMs: 15, engines: fakeEngines,
    runCycleImpl: async (opts) => { received = opts; return cleanResult(); } });
  sched.setProviderKeys({ openrouter: 'sk-or' });
  sched.start();
  await waitUntil(() => received !== null);
  await sched.stopDaemon();
  assert.equal(received.providerKeys.openrouter, 'sk-or');
  assert.equal(received.codexLoggedIn, false);
});

// ---------------------------------------------------------------------------
// codex meter (2026-09-17): the ChatGPT-plan windows gate codex launches
// ---------------------------------------------------------------------------

function fakeCodexMeter(result) {
  return { calls: 0, async check(enabled) { this.calls += 1; this.lastEnabled = enabled; return typeof result === 'function' ? result() : result; } };
}

test('codex meter over ceiling: codex projects sleep with a reset time; claude projects keep running', async () => {
  const claudeP = makeProject({ id: 'c-meter', engine: 'claude' });
  const codexP = makeProject({ id: 'x-meter', engine: 'codex', model: 'default' });
  const stateObj = makeStateObj([claudeP, codexP], { graceMinutes: 0 });
  const budget = makeBudget();
  budget.engineOk = () => ({ ok: true, reason: null, resetsAt: null });
  const meter = fakeCodexMeter({ ok: false, reason: 'ceiling', windows: [{ name: 'codex 5h', pct: 91, resetsAt: '2099-01-01T00:00:00.000Z' }], resetsAt: '2099-01-01T00:00:00.000Z', planType: 'plus', checkedIso: util.nowIso() });
  const seen = [];
  const sched = new Scheduler({ stateObj, budget, codexMeter: meter, notifyImpl: () => {}, tickMs: 15,
    runCycleImpl: async ({ project }) => { seen.push(project.id); return cleanResult(); } });
  sched.start();
  await waitUntil(() => seen.length >= 3);
  const snap = sched.snapshot();
  await sched.stopDaemon();

  assert.ok(seen.every((id) => id === 'c-meter'), `only claude cycles expected, got ${JSON.stringify(seen)}`);
  const byId = Object.fromEntries(snap.projects.map((p) => [p.id, p]));
  assert.equal(byId['x-meter'].status, 'sleeping');
  assert.match(byId['x-meter'].statusDetail, /codex ceiling, resets 2099/);
  assert.equal(snap.budget.codex.reason, 'ceiling');
  assert.equal(snap.budget.codex.windows[0].name, 'codex 5h');
  assert.equal(meter.lastEnabled, true, 'a codex project exists, so the meter is read');
  const sleeps = events.readEvents(codexP.dir).filter((e) => e.ev === 'sleep' && e.reason === 'ceiling');
  assert.equal(sleeps.length, 1, 'one sleep event stamped into the codex project, not one per tick');
  assert.equal(events.readEvents(claudeP.dir).filter((e) => e.ev === 'sleep').length, 0, 'claude projects are not told the codex meter slept');
});

test('codex meter outage is no opinion: codex projects run on the latch alone', async () => {
  const codexP = makeProject({ id: 'x-outage', engine: 'codex', model: 'default' });
  const stateObj = makeStateObj([codexP], { graceMinutes: 0 });
  const budget = makeBudget();
  budget.engineOk = () => ({ ok: true, reason: null, resetsAt: null });
  const meter = fakeCodexMeter({ ok: true, reason: 'outage', windows: [], resetsAt: null, planType: null, checkedIso: util.nowIso() });
  let runs = 0;
  const sched = new Scheduler({ stateObj, budget, codexMeter: meter, notifyImpl: () => {}, tickMs: 15,
    runCycleImpl: async () => { runs += 1; return cleanResult(); } });
  sched.start();
  await waitUntil(() => runs >= 2);
  await sched.stopDaemon();
  assert.ok(runs >= 2);
  assert.equal(sched.snapshot().budget.codex.reason, 'outage');
});

test('the codex meter is not read when nothing needs it (no codex project, codex signed out)', async () => {
  const claudeP = makeProject({ engine: 'claude' });
  const fakeEngines = { current: () => ({ claude: { loggedIn: true }, codex: { loggedIn: false } }), refresh: async () => ({}), login: () => ({ ok: true }) };
  const meter = fakeCodexMeter({ ok: true, reason: 'outage', windows: [], resetsAt: null, planType: null, checkedIso: util.nowIso() });
  let runs = 0;
  const sched = new Scheduler({ stateObj: makeStateObj([claudeP]), budget: makeBudget(), codexMeter: meter, engines: fakeEngines, notifyImpl: () => {}, tickMs: 15,
    runCycleImpl: async () => { runs += 1; return cleanResult(); } });
  sched.start();
  await waitUntil(() => runs >= 1);
  await sched.stopDaemon();
  assert.equal(meter.lastEnabled, false);
});
