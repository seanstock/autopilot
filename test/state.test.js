'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const util = require('../src/util');
const state = require('../src/state');

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-home-test-'));
  process.env.AUTOPILOT_HOME_OVERRIDE = dir;
  return dir;
}

function tempProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-project-test-'));
}

test.beforeEach(() => {
  tempHome();
});

test.afterEach(() => {
  delete process.env.AUTOPILOT_HOME_OVERRIDE;
});

test('load() with no projects.json returns default settings and empty projects', () => {
  const result = state.load();
  assert.deepEqual(result.projects, []);
  assert.equal(result.settings.ceilingPct, 75);
  assert.equal(result.settings.graceMinutes, 30);
  assert.equal(result.settings.webhook, null);
  assert.equal(result.settings.port, 4680);
});

test('load() drops invalid entries (missing dir, relative dir, nonexistent dir) with a log', () => {
  const home = process.env.AUTOPILOT_HOME_OVERRIDE;
  const goodDir = tempProjectDir();
  util.writeJson(path.join(home, 'projects.json'), {
    settings: {},
    projects: [
      { id: 'good', dir: goodDir, prompt: 'x' },
      { id: 'no-dir-field', prompt: 'x' },
      { id: 'relative', dir: 'relative/path', prompt: 'x' },
      { id: 'missing-on-disk', dir: path.join(goodDir, 'does-not-exist'), prompt: 'x' },
    ],
  });

  const logged = [];
  const origLog = util.log;
  // capture without permanently altering module (best-effort spy via stderr)
  const chunks = [];
  const origWrite = process.stderr.write;
  process.stderr.write = (chunk) => { chunks.push(chunk); return true; };
  let result;
  try {
    result = state.load();
  } finally {
    process.stderr.write = origWrite;
  }

  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].id, 'good');
  assert.ok(chunks.length >= 3, 'expected a log line per dropped invalid entry');
});

test('load() fills project defaults', () => {
  const home = process.env.AUTOPILOT_HOME_OVERRIDE;
  const dir = tempProjectDir();
  util.writeJson(path.join(home, 'projects.json'), {
    projects: [{ id: 'p1', dir, prompt: 'do things' }],
  });
  const result = state.load();
  const p = result.projects[0];
  assert.equal(p.priority, 1);
  assert.equal(p.enabled, true);
  assert.equal(p.model, 'claude-sonnet-5');
  assert.equal(p.maxCycleMinutes, 120);
  assert.equal(p.criticRatio, 5);
  assert.equal(p.reviewGateCycles, 0);
  assert.equal(p.containment, 'standard');
});

test('save() then load() round trips a project', () => {
  const dir = tempProjectDir();
  const s = state.load();
  state.addProject(s, { dir, prompt: 'hello' });
  state.save(s);
  const reloaded = state.load();
  assert.equal(reloaded.projects.length, 1);
  assert.equal(reloaded.projects[0].dir, dir);
});

test('getProject finds by id, returns null when absent', () => {
  const dir = tempProjectDir();
  const s = state.load();
  const added = state.addProject(s, { dir, prompt: 'hi' });
  assert.equal(state.getProject(s, added.id), added);
  assert.equal(state.getProject(s, 'nope'), null);
});

test('addProject: id is kebab-cased dir basename', () => {
  const parent = tempProjectDir();
  const dir = path.join(parent, 'My Cool Project');
  fs.mkdirSync(dir);
  const s = state.load();
  const p = state.addProject(s, { dir, prompt: 'x' });
  assert.equal(p.id, 'my-cool-project');
});

test('addProject: id collision gets -2 suffix', () => {
  const parent = tempProjectDir();
  const dirA = path.join(parent, 'same-name');
  const dirB = path.join(parent, 'nested', 'same-name');
  fs.mkdirSync(dirA);
  fs.mkdirSync(dirB, { recursive: true });

  const s = state.load();
  const first = state.addProject(s, { dir: dirA, prompt: 'x' });
  const second = state.addProject(s, { dir: dirB, prompt: 'y' });

  assert.equal(first.id, 'same-name');
  assert.equal(second.id, 'same-name-2');
});

test('addProject: applies defaults and honors overrides', () => {
  const dir = tempProjectDir();
  const s = state.load();
  const p = state.addProject(s, { dir, prompt: 'x', priority: 3, model: 'claude-haiku-4-5-20251001' });
  assert.equal(p.priority, 3);
  assert.equal(p.model, 'claude-haiku-4-5-20251001');
  assert.equal(p.maxCycleMinutes, 120);
  assert.equal(p.criticRatio, 5);
  assert.equal(p.reviewGateCycles, 0);
  assert.equal(p.containment, 'standard');
});

test('readRuntime defaults when state.json absent', () => {
  const dir = tempProjectDir();
  const rt = state.readRuntime(dir);
  assert.deepEqual(rt, { cycle: 0, sinceReview: 0, failTimes: [], cooldownUntil: null });
});

test('writeRuntime + readRuntime round trip', () => {
  const dir = tempProjectDir();
  state.writeRuntime(dir, { cycle: 41, sinceReview: 3, failTimes: ['2026-07-23T00:00:00-07:00'], cooldownUntil: null });
  const rt = state.readRuntime(dir);
  assert.equal(rt.cycle, 41);
  assert.equal(rt.sinceReview, 3);
  assert.deepEqual(rt.failTimes, ['2026-07-23T00:00:00-07:00']);
  assert.equal(rt.cooldownUntil, null);
  // lives under <dir>/.autopilot/state.json
  assert.ok(fs.existsSync(path.join(dir, '.autopilot', 'state.json')));
});

test('readFatal returns null when unset, writeFatal/clearFatal round trip', () => {
  assert.equal(state.readFatal(), null);
  state.writeFatal('credit_balance_tripwire');
  const f = state.readFatal();
  assert.equal(f.reason, 'credit_balance_tripwire');
  assert.match(f.t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  state.clearFatal();
  assert.equal(state.readFatal(), null);
});

test('clearFatal is a no-op when no fatal file exists', () => {
  assert.doesNotThrow(() => state.clearFatal());
});

// ---------------------------------------------------------------------------
// I5(c): claudeCmd is an in-memory test hook only - stripped on load()
// ---------------------------------------------------------------------------

test('I5(c): load() strips a persisted claudeCmd field (test-hook, not a real config field)', () => {
  const home = process.env.AUTOPILOT_HOME_OVERRIDE;
  const dir = tempProjectDir();
  util.writeJson(path.join(home, 'projects.json'), {
    projects: [
      {
        id: 'p1',
        dir,
        prompt: 'x',
        // Simulates a cycle (via Bash/Write, bypassing the permissions
        // layer) writing an attacker-chosen claudeCmd straight into
        // projects.json so the daemon spawns it on a future cycle.
        claudeCmd: ['cmd', '/c', 'evil.exe'],
      },
    ],
  });
  const result = state.load();
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].claudeCmd, undefined, 'claudeCmd must never survive a projects.json round trip');
});

test('I5(c): an in-memory claudeCmd set after addProject() (the e2e test-harness pattern) is untouched until a save/load round trip', () => {
  const dir = tempProjectDir();
  const s = state.load();
  const project = state.addProject(s, { dir, prompt: 'x' });
  project.claudeCmd = [process.execPath, 'test/fake-claude.js'];
  assert.deepEqual(project.claudeCmd, [process.execPath, 'test/fake-claude.js']);

  // Persisting and reloading from disk is where the strip applies.
  state.save(s);
  const reloaded = state.load();
  assert.equal(reloaded.projects[0].claudeCmd, undefined);
});

// ---------------------------------------------------------------------------
// I6: numeric-expected fields are rejected (not stored verbatim) when
// non-numeric - projects.json is rendered back into the UI's DOM, so an
// unvalidated value here is reachable stored-XSS, not just a display bug.
// ---------------------------------------------------------------------------

test('I6: addProject rejects non-numeric priority/criticRatio/reviewGateCycles/maxCycleMinutes, keeping defaults', () => {
  const dir = tempProjectDir();
  const s = state.load();
  const p = state.addProject(s, {
    dir,
    prompt: 'x',
    priority: '<img onerror=alert(1)>',
    criticRatio: '"><script>1</script>',
    reviewGateCycles: {},
    maxCycleMinutes: 'NaN-ish',
  });
  assert.equal(p.priority, 1, 'must fall back to the default priority, not store the garbage value');
  assert.equal(p.criticRatio, 5);
  assert.equal(p.reviewGateCycles, 0);
  assert.equal(p.maxCycleMinutes, 120);
});

test('I6: addProject accepts and coerces numeric-string values', () => {
  const dir = tempProjectDir();
  const s = state.load();
  const p = state.addProject(s, { dir, prompt: 'x', priority: '3', criticRatio: '7' });
  assert.equal(p.priority, 3);
  assert.equal(p.criticRatio, 7);
});

test('load() tolerates a dir stored with forward slashes on Windows', () => {
  const home = process.env.AUTOPILOT_HOME_OVERRIDE;
  const dir = tempProjectDir();
  const forwardSlashDir = dir.split(path.sep).join('/');
  util.writeJson(path.join(home, 'projects.json'), {
    projects: [{ id: 'fwd', dir: forwardSlashDir, prompt: 'x' }],
  });
  const result = state.load();
  assert.equal(result.projects.length, 1);
});
