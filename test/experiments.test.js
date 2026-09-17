'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { Scheduler } = require('../src/scheduler');
const util = require('../src/util');
const state = require('../src/state');
const events = require('../src/events');
const experiments = require('../src/experiments');

// ---------------------------------------------------------------------------
// helpers (mirrors test/scheduler.test.js conventions)
// ---------------------------------------------------------------------------

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-exp-home-'));
  process.env.AUTOPILOT_HOME_OVERRIDE = dir;
  return dir;
}

function tempExperimentsRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-exp-root-'));
  process.env.AUTOPILOT_EXPERIMENTS_DIR_OVERRIDE = dir;
  return dir;
}

function makeBudget(overrides) {
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
  return impl;
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

function makeScheduler(opts) {
  const o = opts || {};
  const stateObj = o.stateObj || { settings: { ceilingPct: 75, graceMinutes: 0, webhook: null, port: 4680 }, projects: [] };
  return new Scheduler({
    stateObj,
    budget: o.budget || makeBudget(),
    runCycleImpl: o.runCycleImpl || (async () => cleanResult()),
    notifyImpl: () => {},
    tickMs: o.tickMs != null ? o.tickMs : 999999, // never auto-tick unless a test wants it
  });
}

async function waitUntil(fn, timeoutMs = 1500, intervalMs = 15) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function basicBody(overrides) {
  return Object.assign(
    {
      name: 'The Robots Home v1',
      basePrompt: 'Build a website for therobotshome.com.',
      cycleCap: 5,
      defaults: {},
      variants: [{ label: 'sonnet-baseline', overrides: { model: 'claude-sonnet-5' }, promptSuffix: '' }],
    },
    overrides || {}
  );
}

test.beforeEach(() => {
  tempHome();
  tempExperimentsRoot();
});

test.afterEach(() => {
  delete process.env.AUTOPILOT_HOME_OVERRIDE;
  delete process.env.AUTOPILOT_EXPERIMENTS_DIR_OVERRIDE;
});

// ---------------------------------------------------------------------------
// createExperiment: happy path
// ---------------------------------------------------------------------------

test('createExperiment registers N projects with experimentId/experimentLabel/maxCycles, dirs git-inited', () => {
  const sched = makeScheduler();
  const body = basicBody({
    cycleCap: 5,
    variants: [
      { label: 'a', overrides: {}, promptSuffix: '' },
      { label: 'b', overrides: { model: 'claude-opus-5' }, promptSuffix: 'Use a bold red palette.' },
    ],
  });

  const record = experiments.createExperiment(sched, body);
  assert.equal(record.variants.length, 2);

  const projA = state.getProject(sched.stateObj, record.variants[0].projectId);
  const projB = state.getProject(sched.stateObj, record.variants[1].projectId);
  assert.equal(projA.experimentId, record.id);
  assert.equal(projA.experimentLabel, 'a');
  assert.equal(projA.maxCycles, 5);
  assert.equal(projA.prompt, body.basePrompt, 'no suffix -> prompt is basePrompt verbatim');

  assert.equal(projB.experimentId, record.id);
  assert.equal(projB.experimentLabel, 'b');
  assert.equal(projB.model, 'claude-opus-5');
  assert.equal(projB.prompt, `${body.basePrompt}\n\nUse a bold red palette.`);

  // persisted to projects.json
  const reloaded = state.load();
  assert.ok(reloaded.projects.some((p) => p.id === projA.id));
  assert.ok(reloaded.projects.some((p) => p.id === projB.id));
  const reloadedA = reloaded.projects.find((p) => p.id === projA.id);
  assert.equal(reloadedA.experimentId, record.id);
  assert.equal(reloadedA.experimentLabel, 'a');
  assert.equal(reloadedA.maxCycles, 5);

  // dirs created + git-inited
  const dirA = path.join(experiments.experimentsRoot(), record.id, 'a');
  const dirB = path.join(experiments.experimentsRoot(), record.id, 'b');
  assert.ok(fs.existsSync(path.join(dirA, '.git')));
  assert.ok(fs.existsSync(path.join(dirB, '.git')));
  assert.equal(projA.dir, dirA);
  assert.equal(projB.dir, dirB);
});

test('createExperiment applies overrides and fills defaults where a variant has none', () => {
  const sched = makeScheduler();
  const body = basicBody({
    defaults: { model: 'claude-sonnet-5', workerModel: 'claude-haiku-4-5-20251001', effort: 'high' },
    variants: [
      { label: 'default-all', overrides: {}, promptSuffix: '' },
      { label: 'override-model', overrides: { model: 'claude-opus-5' }, promptSuffix: '' },
    ],
  });

  const record = experiments.createExperiment(sched, body);
  const defAll = state.getProject(sched.stateObj, record.variants[0].projectId);
  const overrideModel = state.getProject(sched.stateObj, record.variants[1].projectId);

  assert.equal(defAll.model, 'claude-sonnet-5', 'defaults fill in when variant has no override');
  assert.equal(defAll.workerModel, 'claude-haiku-4-5-20251001');
  assert.equal(defAll.effort, 'high');

  assert.equal(overrideModel.model, 'claude-opus-5', 'per-variant override wins over defaults');
  assert.equal(overrideModel.workerModel, 'claude-haiku-4-5-20251001', 'unset fields still take the default');
});

test('A/A test: duplicate/blank labels are auto-uniquified (label, label-2)', () => {
  const sched = makeScheduler();
  const body = basicBody({
    variants: [
      { label: 'same', overrides: {}, promptSuffix: '' },
      { label: 'same', overrides: {}, promptSuffix: '' },
      { label: '', overrides: {}, promptSuffix: '' },
      { label: '', overrides: {}, promptSuffix: '' },
    ],
  });

  const record = experiments.createExperiment(sched, body);
  const labels = record.variants.map((v) => v.label);
  assert.deepEqual(labels, ['same', 'same-2', 'variant-3', 'variant-4']);
});

// ---------------------------------------------------------------------------
// createExperiment: validation
// ---------------------------------------------------------------------------

test('createExperiment validation: missing name/basePrompt, bad cycleCap, zero variants all 400 and write nothing', () => {
  const sched = makeScheduler();
  const root = experiments.experimentsRoot();

  const cases = [
    basicBody({ name: '' }),
    basicBody({ name: '   ' }),
    basicBody({ basePrompt: '' }),
    basicBody({ cycleCap: 0 }),
    basicBody({ cycleCap: -1 }),
    basicBody({ cycleCap: 1.5 }),
    basicBody({ cycleCap: 1001 }),
    basicBody({ cycleCap: 'lots' }),
    basicBody({ variants: [] }),
  ];

  for (const body of cases) {
    let threw = null;
    try {
      experiments.createExperiment(sched, body);
    } catch (err) {
      threw = err;
    }
    assert.ok(threw, `expected a throw for ${JSON.stringify(body)}`);
    assert.equal(threw.status, 400);
  }

  assert.equal(sched.stateObj.projects.length, 0, 'nothing added to the project registry');
  assert.equal(experiments.loadExperiments().length, 0, 'nothing written to experiments.json');
  assert.ok(!fs.existsSync(root) || fs.readdirSync(root).length === 0, 'no experiment dirs created');
});

test('createExperiment validation: more than 20 variants is rejected', () => {
  const sched = makeScheduler();
  const variants = Array.from({ length: 21 }, (_, i) => ({ label: `v${i}`, overrides: {}, promptSuffix: '' }));
  assert.throws(() => experiments.createExperiment(sched, basicBody({ variants })), (err) => err.status === 400);
});

// ---------------------------------------------------------------------------
// rollback on partial failure
// ---------------------------------------------------------------------------

test('rollback: failure on the second variant deregisters the first project and removes its dir', () => {
  const sched = makeScheduler();
  const body = basicBody({
    name: 'rollback-test',
    variants: [
      { label: 'first', overrides: {}, promptSuffix: '' },
      { label: 'second', overrides: {}, promptSuffix: '' },
    ],
  });

  // Pre-create the second variant's directory so createExperiment hits the
  // "directory already exists" guard partway through.
  const expId = 'rollback-test'; // slug of the name, first available since experiments.json is empty
  const secondDir = path.join(experiments.experimentsRoot(), expId, 'second');
  util.ensureDir(secondDir);

  let threw = null;
  try {
    experiments.createExperiment(sched, body);
  } catch (err) {
    threw = err;
  }
  assert.ok(threw, 'expected createExperiment to throw');

  assert.equal(sched.stateObj.projects.length, 0, 'first variant project must be deregistered');
  const firstDir = path.join(experiments.experimentsRoot(), expId, 'first');
  assert.equal(fs.existsSync(firstDir), false, 'first variant dir (created by this call) must be removed');
  // second dir pre-existed the call and was never created by it - should remain untouched
  assert.equal(fs.existsSync(secondDir), true);
  assert.equal(experiments.loadExperiments().length, 0, 'experiments.json must not gain a partial entry');
});

// ---------------------------------------------------------------------------
// cap enforcement (scheduler _computeRunnable)
// ---------------------------------------------------------------------------

test('cap enforcement: at cap the variant is not runnable, disabled, variant_complete stamped once, status complete', () => {
  const sched = makeScheduler();
  const body = basicBody({ cycleCap: 2, variants: [{ label: 'capped', overrides: {}, promptSuffix: '' }] });
  const record = experiments.createExperiment(sched, body);
  const project = state.getProject(sched.stateObj, record.variants[0].projectId);

  const runtime = state.readRuntime(project.dir);
  runtime.cycle = 2;
  state.writeRuntime(project.dir, runtime);

  let runnable = sched._computeRunnable();
  assert.equal(runnable.length, 0, 'capped variant must not be runnable');
  assert.equal(project.enabled, false, 'project.enabled flipped false');

  const reloaded = state.load();
  const reloadedProject = reloaded.projects.find((p) => p.id === project.id);
  assert.equal(reloadedProject.enabled, false, 'disabled state saved to disk');

  let evs = events.readEvents(project.dir, 50);
  const completions = evs.filter((e) => e.ev === 'variant_complete');
  assert.equal(completions.length, 1, 'variant_complete stamped exactly once');

  // second pass: must not duplicate the event
  runnable = sched._computeRunnable();
  assert.equal(runnable.length, 0);
  evs = events.readEvents(project.dir, 50);
  assert.equal(evs.filter((e) => e.ev === 'variant_complete').length, 1, 'no duplicate on second pass');

  const status = sched._projectStatus(project);
  assert.equal(status.status, 'complete');

  const snap = sched.snapshot();
  const snapProject = snap.projects.find((p) => p.id === project.id);
  assert.equal(snapProject.status, 'complete');
});

test('cap enforcement: below cap the variant remains runnable', () => {
  const sched = makeScheduler();
  const body = basicBody({ cycleCap: 5, variants: [{ label: 'not-capped', overrides: {}, promptSuffix: '' }] });
  const record = experiments.createExperiment(sched, body);
  const project = state.getProject(sched.stateObj, record.variants[0].projectId);

  const runtime = state.readRuntime(project.dir);
  runtime.cycle = 3;
  state.writeRuntime(project.dir, runtime);

  const runnable = sched._computeRunnable();
  assert.equal(runnable.length, 1);
  assert.equal(project.enabled, true);
});

// ---------------------------------------------------------------------------
// listExperiments
// ---------------------------------------------------------------------------

test('listExperiments joins snapshot data (cycle/status) and complete is true only when every variant is at cap', () => {
  const sched = makeScheduler();
  const body = basicBody({
    cycleCap: 3,
    variants: [
      { label: 'v1', overrides: {}, promptSuffix: '' },
      { label: 'v2', overrides: {}, promptSuffix: '' },
    ],
  });
  const record = experiments.createExperiment(sched, body);
  const p1 = state.getProject(sched.stateObj, record.variants[0].projectId);
  const p2 = state.getProject(sched.stateObj, record.variants[1].projectId);

  let list = experiments.listExperiments(sched);
  let exp = list.find((e) => e.id === record.id);
  assert.equal(exp.complete, false);
  assert.equal(exp.variants.find((v) => v.label === 'v1').cycle, 0);

  // v1 reaches cap
  const rt1 = state.readRuntime(p1.dir);
  rt1.cycle = 3;
  state.writeRuntime(p1.dir, rt1);
  sched._computeRunnable(); // trips the disable + variant_complete side effect

  list = experiments.listExperiments(sched);
  exp = list.find((e) => e.id === record.id);
  assert.equal(exp.complete, false, 'not complete until every variant is at cap');
  assert.equal(exp.variants.find((v) => v.label === 'v1').complete, true);
  assert.equal(exp.variants.find((v) => v.label === 'v2').complete, false);

  // v2 also reaches cap
  const rt2 = state.readRuntime(p2.dir);
  rt2.cycle = 3;
  state.writeRuntime(p2.dir, rt2);
  sched._computeRunnable();

  list = experiments.listExperiments(sched);
  exp = list.find((e) => e.id === record.id);
  assert.equal(exp.complete, true, 'complete once every variant is at cap');
});

// ---------------------------------------------------------------------------
// deleteExperiment
// ---------------------------------------------------------------------------

test('deleteExperiment removes projects and the experiments.json entry; deleteDirs removes the dir tree', () => {
  const sched = makeScheduler();
  const body = basicBody({ variants: [{ label: 'a', overrides: {}, promptSuffix: '' }, { label: 'b', overrides: {}, promptSuffix: '' }] });
  const record = experiments.createExperiment(sched, body);
  const expDir = path.join(experiments.experimentsRoot(), record.id);
  assert.ok(fs.existsSync(expDir));

  const result = experiments.deleteExperiment(sched, record.id, true);
  assert.equal(result.ok, true);
  assert.equal(sched.stateObj.projects.length, 0, 'both variant projects deregistered');
  assert.equal(experiments.getExperiment(record.id), null, 'experiments.json entry removed');
  assert.equal(fs.existsSync(expDir), false, 'deleteDirs=true removes the experiment dir tree');
});

test('deleteExperiment without deleteDirs keeps the dir tree but still deregisters', () => {
  const sched = makeScheduler();
  const body = basicBody({ variants: [{ label: 'a', overrides: {}, promptSuffix: '' }] });
  const record = experiments.createExperiment(sched, body);
  const expDir = path.join(experiments.experimentsRoot(), record.id);

  const result = experiments.deleteExperiment(sched, record.id, false);
  assert.equal(result.ok, true);
  assert.equal(sched.stateObj.projects.length, 0);
  assert.equal(fs.existsSync(expDir), true, 'dirs kept when deleteDirs is falsy');
});

test('deleteExperiment refuses when a variant is mid-cycle', () => {
  const sched = makeScheduler();
  const body = basicBody({ variants: [{ label: 'a', overrides: {}, promptSuffix: '' }] });
  const record = experiments.createExperiment(sched, body);

  sched._running.set(record.variants[0].projectId, {
    projectId: record.variants[0].projectId, cycle: 1, kind: 'work', startedIso: util.nowIso(),
  });

  const result = experiments.deleteExperiment(sched, record.id, true);
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.equal(sched.stateObj.projects.length, 1, 'nothing removed when refused');
  assert.ok(experiments.getExperiment(record.id), 'experiments.json entry untouched');
});

test('deleteExperiment unknown id returns ok:false', () => {
  const sched = makeScheduler();
  const result = experiments.deleteExperiment(sched, 'no-such-experiment', true);
  assert.equal(result.ok, false);
});

// ---------------------------------------------------------------------------
// resolvePreviewPath
// ---------------------------------------------------------------------------

test('resolvePreviewPath serves from site/ when present, else project root; directory -> index.html', () => {
  const sched = makeScheduler();
  const body = basicBody({ variants: [{ label: 'siteful', overrides: {}, promptSuffix: '' }, { label: 'rootonly', overrides: {}, promptSuffix: '' }] });
  const record = experiments.createExperiment(sched, body);
  const siteful = state.getProject(sched.stateObj, record.variants[0].projectId);
  const rootonly = state.getProject(sched.stateObj, record.variants[1].projectId);

  fs.mkdirSync(path.join(siteful.dir, 'site'), { recursive: true });
  fs.writeFileSync(path.join(siteful.dir, 'site', 'index.html'), '<h1>site</h1>');
  fs.writeFileSync(path.join(siteful.dir, 'index.html'), '<h1>root, should not be served</h1>');

  fs.writeFileSync(path.join(rootonly.dir, 'index.html'), '<h1>root</h1>');

  const p1 = experiments.resolvePreviewPath(record.id, 'siteful', '/');
  assert.equal(p1, path.resolve(path.join(siteful.dir, 'site', 'index.html')));

  const p2 = experiments.resolvePreviewPath(record.id, 'rootonly', '/');
  assert.equal(p2, path.resolve(path.join(rootonly.dir, 'index.html')));

  const p3 = experiments.resolvePreviewPath(record.id, 'rootonly', '');
  assert.equal(p3, path.resolve(path.join(rootonly.dir, 'index.html')), 'directory request (empty rest) resolves to index.html');
});

test('resolvePreviewPath returns null for unknown experiment, unknown label, or missing file', () => {
  const sched = makeScheduler();
  const body = basicBody({ variants: [{ label: 'v', overrides: {}, promptSuffix: '' }] });
  const record = experiments.createExperiment(sched, body);

  assert.equal(experiments.resolvePreviewPath('no-such-exp', 'v', '/'), null);
  assert.equal(experiments.resolvePreviewPath(record.id, 'no-such-label', '/'), null);
  assert.equal(experiments.resolvePreviewPath(record.id, 'v', '/nope.html'), null, 'missing file');
});

test('resolvePreviewPath guards against traversal and absolute-path escapes', () => {
  const sched = makeScheduler();
  const body = basicBody({ variants: [{ label: 'v', overrides: {}, promptSuffix: '' }] });
  const record = experiments.createExperiment(sched, body);
  const project = state.getProject(sched.stateObj, record.variants[0].projectId);
  fs.writeFileSync(path.join(project.dir, 'index.html'), '<h1>ok</h1>');

  // a decoded "../" segment reaching outside the variant root
  assert.equal(experiments.resolvePreviewPath(record.id, 'v', '/../../etc/passwd'), null);
  assert.equal(experiments.resolvePreviewPath(record.id, 'v', '../../../etc/passwd'), null);

  // an absolute path as `rest`
  const outsideFile = path.join(os.tmpdir(), 'autopilot-traversal-target.txt');
  fs.writeFileSync(outsideFile, 'should never be served');
  try {
    assert.equal(experiments.resolvePreviewPath(record.id, 'v', outsideFile), null);
  } finally {
    try { fs.unlinkSync(outsideFile); } catch (e) { /* best effort */ }
  }
});

// ---------------------------------------------------------------------------
// fanOut (stop/start)
// ---------------------------------------------------------------------------

test('fanOut(stop) touches STOP for every variant; fanOut(start) clears it; unknown experiment -> false', () => {
  const sched = makeScheduler();
  const body = basicBody({ variants: [{ label: 'a', overrides: {}, promptSuffix: '' }, { label: 'b', overrides: {}, promptSuffix: '' }] });
  const record = experiments.createExperiment(sched, body);

  assert.equal(experiments.fanOut(sched, 'nope', 'stop'), false);

  const ok = experiments.fanOut(sched, record.id, 'stop');
  assert.equal(ok, true);
  for (const v of record.variants) {
    const project = state.getProject(sched.stateObj, v.projectId);
    assert.ok(fs.existsSync(path.join(util.projectMeta(project.dir), 'STOP')));
  }

  experiments.fanOut(sched, record.id, 'start');
  for (const v of record.variants) {
    const project = state.getProject(sched.stateObj, v.projectId);
    assert.equal(fs.existsSync(path.join(util.projectMeta(project.dir), 'STOP')), false);
  }
});

// ---------------------------------------------------------------------------
// token-free scheduler-driven run: two variants, cycleCap 1, both complete
// ---------------------------------------------------------------------------

test('scheduler-driven run: 2-variant experiment with cycleCap 1 disables both variants after one cycle each, both variant_complete, experiment complete', async () => {
  const stateObj = { settings: { ceilingPct: 75, graceMinutes: 0, webhook: null, port: 4680 }, projects: [] };
  const runs = {};
  const sched = new Scheduler({
    stateObj,
    budget: makeBudget(),
    runCycleImpl: async ({ project }) => {
      runs[project.id] = (runs[project.id] || 0) + 1;
      return cleanResult();
    },
    notifyImpl: () => {},
    tickMs: 15,
  });

  const body = basicBody({
    cycleCap: 1,
    variants: [
      { label: 'v1', overrides: {}, promptSuffix: '' },
      { label: 'v2', overrides: {}, promptSuffix: '' },
    ],
  });
  const record = experiments.createExperiment(sched, body);
  const ids = record.variants.map((v) => v.projectId);

  sched.start();
  await waitUntil(() => (runs[ids[0]] || 0) >= 1 && (runs[ids[1]] || 0) >= 1);
  // give the scheduler a couple more ticks to notice the cap and actually
  // flip enabled=false on both variants (a tick after the cap-hitting cycle)
  await waitUntil(() => ids.every((id) => state.getProject(sched.stateObj, id).enabled === false));
  await sched.stopDaemon();

  assert.equal(runs[ids[0]], 1, 'variant 1 ran exactly one cycle');
  assert.equal(runs[ids[1]], 1, 'variant 2 ran exactly one cycle');

  for (const v of record.variants) {
    const project = state.getProject(sched.stateObj, v.projectId);
    assert.equal(project.enabled, false, `${v.label} disabled at cap`);
    const evs = events.readEvents(project.dir, 50);
    assert.equal(evs.filter((e) => e.ev === 'variant_complete').length, 1, `${v.label} stamped variant_complete once`);
  }

  const list = experiments.listExperiments(sched);
  const exp = list.find((e) => e.id === record.id);
  assert.equal(exp.complete, true);
});

// ---------------------------------------------------------------------------
// server experiments (local Docker, KISS v1): port leases + templating +
// container teardown
// ---------------------------------------------------------------------------

test('portBase leases sequential ports, names containers, substitutes {{PORT}}/{{LABEL}}/{{CONTAINER}}', () => {
  tempHome();
  tempExperimentsRoot();
  const sched = makeScheduler();
  const record = experiments.createExperiment(
    sched,
    basicBody({
      portBase: 8200,
      basePrompt: 'Serve on {{PORT}} as {{CONTAINER}} ({{LABEL}}).',
      defaults: { verifyCmd: 'curl -sf http://127.0.0.1:{{PORT}}/healthz' },
      variants: [
        { label: 'a', overrides: {}, promptSuffix: 'You are {{LABEL}}.' },
        { label: 'b', overrides: {}, promptSuffix: '' },
      ],
    })
  );

  assert.equal(record.portBase, 8200);
  assert.equal(record.variants[0].port, 8200);
  assert.equal(record.variants[1].port, 8201);
  assert.equal(record.variants[0].container, `exp-${record.id}-a`);
  assert.equal(record.variants[1].container, `exp-${record.id}-b`);

  const p0 = state.getProject(sched.stateObj, record.variants[0].projectId);
  assert.equal(p0.prompt, `Serve on 8200 as exp-${record.id}-a (a).\n\nYou are a.`);
  assert.equal(p0.verifyCmd, 'curl -sf http://127.0.0.1:8200/healthz');
  const p1 = state.getProject(sched.stateObj, record.variants[1].projectId);
  assert.equal(p1.verifyCmd, 'curl -sf http://127.0.0.1:8201/healthz');

  const list = experiments.listExperiments(sched);
  const exp = list.find((e) => e.id === record.id);
  assert.equal(exp.portBase, 8200);
  assert.equal(exp.variants[0].port, 8200);
  assert.equal(exp.variants[1].container, `exp-${record.id}-b`);
});

test('static experiments (no portBase) leave placeholders untouched and ports null', () => {
  tempHome();
  tempExperimentsRoot();
  const sched = makeScheduler();
  const record = experiments.createExperiment(
    sched,
    basicBody({ basePrompt: 'Literal {{PORT}} stays.' })
  );
  assert.equal(record.portBase, null);
  assert.equal(record.variants[0].port, null);
  assert.equal(record.variants[0].container, null);
  const p = state.getProject(sched.stateObj, record.variants[0].projectId);
  assert.equal(p.prompt, 'Literal {{PORT}} stays.');
});

test('invalid portBase is rejected with 400 and nothing written', () => {
  tempHome();
  const root = tempExperimentsRoot();
  const sched = makeScheduler();
  for (const bad of [80, 'abc', 99999, 12.5]) {
    assert.throws(
      () => experiments.createExperiment(sched, basicBody({ portBase: bad })),
      (err) => err.status === 400,
      `portBase ${bad} rejected`
    );
  }
  assert.equal(sched.stateObj.projects.length, 0);
  assert.equal(fs.readdirSync(root).length, 0);
  assert.equal(experiments.loadExperiments().length, 0);
});

test('teardownPlan returns only strictly-valid exp-* container names', () => {
  const exp = {
    variants: [
      { container: 'exp-robots-a' },
      { container: 'exp-robots-b-2' },
      { container: null },
      { container: 'not-exp-name' },
      { container: 'exp-robots-a; rm -rf /' },
      { container: 'exp--double' },
      { container: 'exp-UPPER' },
    ],
  };
  assert.deepEqual(experiments.teardownPlan(exp), ['exp-robots-a', 'exp-robots-b-2']);
  assert.deepEqual(experiments.teardownPlan(null), []);
});

test('teardownContainers invokes the runner once per valid container, tolerating failures', () => {
  const calls = [];
  experiments.teardownContainers(
    { variants: [{ container: 'exp-x-a' }, { container: 'exp-x-b' }, { container: 'bad name' }] },
    (args) => {
      calls.push(args);
      return args[2] === 'exp-x-b' ? { status: 1, stderr: 'no such container' } : { status: 0 };
    }
  );
  assert.deepEqual(calls, [
    ['rm', '-f', 'exp-x-a'],
    ['rm', '-f', 'exp-x-b'],
  ]);
});

test('deleteExperiment with removeContainers runs docker teardown for server experiments only', () => {
  tempHome();
  tempExperimentsRoot();
  const sched = makeScheduler();
  const record = experiments.createExperiment(sched, basicBody({ portBase: 8300 }));
  // Not asserting real docker here: prove the wiring by checking the flag
  // path doesn't throw with docker likely absent (teardown is best-effort)
  // and the registry cleanup still completes.
  const result = experiments.deleteExperiment(sched, record.id, false, true);
  assert.equal(result.ok, true);
  assert.equal(experiments.loadExperiments().length, 0);
  assert.equal(sched.stateObj.projects.length, 0);
});

// ---------------------------------------------------------------------------
// addVariant: late additions to an existing experiment
// ---------------------------------------------------------------------------

test('addVariant inherits basePrompt/cap/defaults, leases the next port, templates placeholders', () => {
  tempHome();
  tempExperimentsRoot();
  const sched = makeScheduler();
  const record = experiments.createExperiment(
    sched,
    basicBody({
      portBase: 8400,
      basePrompt: 'Run on {{PORT}} as {{CONTAINER}}.',
      cycleCap: 3,
      defaults: { model: 'claude-sonnet-5', verifyCmd: 'curl http://127.0.0.1:{{PORT}}/healthz' },
      variants: [{ label: 'a', overrides: {}, promptSuffix: '' }],
    })
  );

  const v = experiments.addVariant(sched, record.id, {
    label: 'new-model',
    overrides: { model: 'claude-opus-5' },
  });

  assert.equal(v.port, 8401, 'next port in the lease block');
  assert.equal(v.container, `exp-${record.id}-new-model`);
  const p = state.getProject(sched.stateObj, v.projectId);
  assert.equal(p.model, 'claude-opus-5', 'explicit override wins');
  assert.equal(p.verifyCmd, 'curl http://127.0.0.1:8401/healthz', 'default verifyCmd inherited + templated');
  assert.equal(p.prompt, `Run on 8401 as exp-${record.id}-new-model.`);
  assert.equal(p.maxCycles, 3, 'cap inherited');
  assert.equal(p.experimentId, record.id);
  assert.ok(fs.existsSync(path.join(experiments.experimentsRoot(), record.id, 'new-model', '.git')));

  const listed = experiments.listExperiments(sched).find((e) => e.id === record.id);
  assert.equal(listed.variants.length, 2);
  assert.equal(listed.complete, false, 'newcomer at 0 cycles reopens the experiment');
});

test('addVariant uniquifies clashing labels and rejects unknown experiments', () => {
  tempHome();
  tempExperimentsRoot();
  const sched = makeScheduler();
  const record = experiments.createExperiment(sched, basicBody({ variants: [{ label: 'a', overrides: {}, promptSuffix: '' }] }));

  const v = experiments.addVariant(sched, record.id, { label: 'a', overrides: {} });
  assert.equal(v.label, 'a-2');
  assert.equal(v.port, null, 'static experiment stays portless');

  assert.throws(() => experiments.addVariant(sched, 'nope', {}), (err) => err.status === 400);
});

test('addVariant rolls back on failure and leaves the experiment untouched', () => {
  tempHome();
  const root = tempExperimentsRoot();
  const sched = makeScheduler();
  const record = experiments.createExperiment(sched, basicBody({ variants: [{ label: 'a', overrides: {}, promptSuffix: '' }] }));

  // Pre-create the target dir so addVariant fails its existence check.
  fs.mkdirSync(path.join(root, record.id, 'boom'), { recursive: true });
  assert.throws(() => experiments.addVariant(sched, record.id, { label: 'boom' }), (err) => err.status === 400);

  assert.equal(sched.stateObj.projects.length, 1, 'no project added');
  const listed = experiments.getExperiment(record.id);
  assert.equal(listed.variants.length, 1, 'record unchanged');
});
