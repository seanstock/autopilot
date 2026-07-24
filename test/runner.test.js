'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const { runCycle } = require('../src/runner');

const FAKE_CLAUDE_PATH = path.join(__dirname, 'fake-claude.js');

function tempAutopilotHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-runner-home-'));
  process.env.AUTOPILOT_HOME_OVERRIDE = dir;
  return dir;
}

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, windowsHide: true, encoding: 'utf8' });
}

// One temp git repo per test, with a single seed commit, so preHead is a
// real, known commit rather than an unborn HEAD.
function tempProjectRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-runner-proj-'));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'autopilot-test@example.com']);
  git(dir, ['config', 'user.name', 'Autopilot Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-m', 'seed commit']);
  return dir;
}

function baseProject(dir, overrides) {
  return Object.assign(
    {
      id: 'demo',
      dir,
      prompt: 'Do the mission.',
      priority: 1,
      model: 'claude-sonnet-5',
      maxCycleMinutes: 120,
      criticRatio: 5,
      reviewGateCycles: 0,
      containment: 'standard',
    },
    overrides
  );
}

// Environment lesson from Task 2: plain `bash` on Windows PATH resolves to
// a broken WSL stub. Never rely on shell resolution here - spawn node
// (process.execPath) directly against the absolute path to the fake.
function fakeCmd() {
  return [process.execPath, FAKE_CLAUDE_PATH];
}

function mockBudget() {
  const calls = { scanForTripwire: [], noteUsageLimitExit: 0 };
  return {
    calls,
    scanForTripwire(text) {
      calls.scanForTripwire.push(text);
      return /credit balance/i.test(String(text));
    },
    noteUsageLimitExit() {
      calls.noteUsageLimitExit += 1;
    },
  };
}

let fakeModeStack = [];
function withFakeMode(mode, fn) {
  const prev = process.env.FAKE_MODE;
  process.env.FAKE_MODE = mode;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env.FAKE_MODE;
      else process.env.FAKE_MODE = prev;
    });
}

test.beforeEach(() => {
  tempAutopilotHome();
});

test.afterEach(() => {
  delete process.env.AUTOPILOT_HOME_OVERRIDE;
});

// ---------------------------------------------------------------------------
// clean mode
// ---------------------------------------------------------------------------

test('clean mode: exit clean, tokens captured, commit created, gitDiff non-empty', async () => {
  const dir = tempProjectRepo();
  const project = baseProject(dir);
  const budget = mockBudget();

  const result = await withFakeMode('clean', () =>
    runCycle({ project, kind: 'work', cycleNumber: 1, budget, claudeCmd: fakeCmd() })
  );

  assert.equal(result.exit, 'clean');
  assert.equal(result.tokens.in, 1000);
  assert.equal(result.tokens.out, 200);
  assert.equal(result.costUsd, 0.05);
  assert.ok(result.commit, 'expected a commit hash to be returned');
  assert.ok(result.gitDiff.files >= 1, 'expected at least one changed file');

  const log = git(dir, ['log', '--name-only', '-1']);
  assert.match(log, /out\.txt/);
});

test('clean mode with kind "critic" uses the critic preamble (REFUTE language reaches the child)', async () => {
  const dir = tempProjectRepo();
  const project = baseProject(dir, { prompt: 'CRITIC_MISSION_MARKER' });
  const budget = mockBudget();

  await withFakeMode('clean', () =>
    runCycle({ project, kind: 'critic', cycleNumber: 1, budget, claudeCmd: fakeCmd() })
  );

  const received = fs.readFileSync(path.join(dir, 'received_prompt.txt'), 'utf8');
  assert.match(received, /REFUTE/);
  assert.match(received, /CRITIC_MISSION_MARKER/);
});

// ---------------------------------------------------------------------------
// preamble injection (proves stdin, not argv)
// ---------------------------------------------------------------------------

test('prompt is written to child stdin and contains PLAN.md (proves preamble injection)', async () => {
  const dir = tempProjectRepo();
  const project = baseProject(dir);
  const budget = mockBudget();

  await withFakeMode('clean', () =>
    runCycle({ project, kind: 'work', cycleNumber: 1, budget, claudeCmd: fakeCmd() })
  );

  const received = fs.readFileSync(path.join(dir, 'received_prompt.txt'), 'utf8');
  assert.match(received, /PLAN\.md/);
  assert.match(received, /Do the mission\./);
});

// ---------------------------------------------------------------------------
// user directive injection (INJECT.md)
// ---------------------------------------------------------------------------

test('work cycle consumes INJECT.md: directive reaches the child, file archived + cleared, event stamped', async () => {
  const dir = tempProjectRepo();
  const project = baseProject(dir);
  const budget = mockBudget();

  const meta = path.join(dir, '.autopilot');
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, 'INJECT.md'), 'Please add a star field to the project.\n');

  await withFakeMode('clean', () =>
    runCycle({ project, kind: 'work', cycleNumber: 3, budget, claudeCmd: fakeCmd() })
  );

  const received = fs.readFileSync(path.join(dir, 'received_prompt.txt'), 'utf8');
  assert.match(received, /USER DIRECTIVE/);
  assert.match(received, /star field/);
  assert.match(received, /transcribe it into PLAN\.md/);
  assert.match(received, /update the project's living spec/);

  assert.equal(fs.existsSync(path.join(meta, 'INJECT.md')), false, 'INJECT.md must be cleared after consumption');
  const archive = fs.readFileSync(path.join(meta, 'injections.log'), 'utf8');
  assert.match(archive, /star field/);
  assert.match(archive, /cycle 3/);

  const evLines = fs.readFileSync(path.join(meta, 'events.jsonl'), 'utf8').trim().split('\n');
  const inject = evLines.map((l) => JSON.parse(l)).find((e) => e.ev === 'inject');
  assert.ok(inject, 'expected an inject event');
  assert.match(inject.preview, /star field/);
});

test('critic cycle leaves INJECT.md untouched', async () => {
  const dir = tempProjectRepo();
  const project = baseProject(dir);
  const budget = mockBudget();

  const meta = path.join(dir, '.autopilot');
  fs.mkdirSync(meta, { recursive: true });
  fs.writeFileSync(path.join(meta, 'INJECT.md'), 'Please add a star field to the project.\n');

  await withFakeMode('clean', () =>
    runCycle({ project, kind: 'critic', cycleNumber: 1, budget, claudeCmd: fakeCmd() })
  );

  const received = fs.readFileSync(path.join(dir, 'received_prompt.txt'), 'utf8');
  assert.doesNotMatch(received, /star field/);
  assert.equal(fs.existsSync(path.join(meta, 'INJECT.md')), true, 'critic must not consume the injection');
});

// ---------------------------------------------------------------------------
// exit classification
// ---------------------------------------------------------------------------

test('usage_limit mode: exit usage_limit and budget.noteUsageLimitExit is called', async () => {
  const dir = tempProjectRepo();
  const project = baseProject(dir);
  const budget = mockBudget();

  const result = await withFakeMode('usage_limit', () =>
    runCycle({ project, kind: 'work', cycleNumber: 2, budget, claudeCmd: fakeCmd() })
  );

  assert.equal(result.exit, 'usage_limit');
  assert.equal(budget.calls.noteUsageLimitExit, 1);
});

test('context_full mode: exit context_full', async () => {
  const dir = tempProjectRepo();
  const project = baseProject(dir);
  const budget = mockBudget();

  const result = await withFakeMode('context_full', () =>
    runCycle({ project, kind: 'work', cycleNumber: 3, budget, claudeCmd: fakeCmd() })
  );

  assert.equal(result.exit, 'context_full');
  assert.equal(budget.calls.noteUsageLimitExit, 0);
});

test('credit mode: budget.scanForTripwire fires on the captured output and the cycle still returns normally', async () => {
  const dir = tempProjectRepo();
  const project = baseProject(dir);
  const budget = mockBudget();

  const result = await withFakeMode('credit', () =>
    runCycle({ project, kind: 'work', cycleNumber: 4, budget, claudeCmd: fakeCmd() })
  );

  assert.ok(
    budget.calls.scanForTripwire.some((t) => /credit balance/i.test(t)),
    'expected scanForTripwire to have been called with text matching the credit-balance tripwire'
  );
  assert.ok(result.exit, 'runCycle must still resolve with a classification, never throw');
});

// ---------------------------------------------------------------------------
// timeout / STOP kill paths
// ---------------------------------------------------------------------------

test('hang mode + tiny maxCycleMinutes -> timeout, and the child is actually dead before returning', async () => {
  const dir = tempProjectRepo();
  const project = baseProject(dir, { maxCycleMinutes: 0.05 }); // 3s
  const budget = mockBudget();

  const startedAt = Date.now();
  const result = await withFakeMode('hang', () =>
    runCycle({ project, kind: 'work', cycleNumber: 5, budget, claudeCmd: fakeCmd() })
  );
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.exit, 'timeout');
  // The fake sleeps for 10 minutes; returning in well under that proves the
  // tree-kill fired rather than the promise waiting out the hang. runCycle
  // resolves only after the child's 'close' event, which node fires only
  // once the OS has actually reaped the process - see runner.js waitForExit.
  assert.ok(elapsedMs < 15000, `expected a fast timeout kill, took ${elapsedMs}ms`);
});

test('STOP file created mid-run -> stopped', async () => {
  const dir = tempProjectRepo();
  // Long enough that the timeout path cannot win the race against STOP.
  const project = baseProject(dir, { maxCycleMinutes: 0.2 }); // 12s, checked every ~4s
  const budget = mockBudget();

  const runPromise = withFakeMode('hang', () =>
    runCycle({ project, kind: 'work', cycleNumber: 6, budget, claudeCmd: fakeCmd() })
  );

  setTimeout(() => {
    const stopDir = path.join(dir, '.autopilot');
    fs.mkdirSync(stopDir, { recursive: true });
    fs.writeFileSync(path.join(stopDir, 'STOP'), '');
  }, 500);

  const result = await runPromise;
  assert.equal(result.exit, 'stopped');
});

// ---------------------------------------------------------------------------
// env stripping (hard rule: never leak API key/token env vars to the child)
// ---------------------------------------------------------------------------

test('child env lacks ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN even when set in the parent', async () => {
  const dir = tempProjectRepo();
  const project = baseProject(dir);
  const budget = mockBudget();

  process.env.ANTHROPIC_API_KEY = 'sk-should-be-stripped';
  process.env.ANTHROPIC_AUTH_TOKEN = 'auth-should-be-stripped';
  try {
    await withFakeMode('clean', () =>
      runCycle({ project, kind: 'work', cycleNumber: 7, budget, claudeCmd: fakeCmd() })
    );
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
  }

  const seen = JSON.parse(fs.readFileSync(path.join(dir, 'env_seen.json'), 'utf8'));
  assert.equal(seen.ANTHROPIC_API_KEY, null);
  assert.equal(seen.ANTHROPIC_AUTH_TOKEN, null);
});

// ---------------------------------------------------------------------------
// never throws
// ---------------------------------------------------------------------------

test('runCycle never throws even when claudeCmd points at a nonexistent binary', async () => {
  const dir = tempProjectRepo();
  const project = baseProject(dir, { maxCycleMinutes: 1 });
  const budget = mockBudget();

  await assert.doesNotReject(async () => {
    const result = await runCycle({
      project,
      kind: 'work',
      cycleNumber: 8,
      budget,
      claudeCmd: [path.join(os.tmpdir(), 'definitely-does-not-exist-claude-binary.exe')],
    });
    assert.ok(result.exit, 'expected a classification even on spawn failure');
    assert.equal(result.exit, 'crash');
  });
});
