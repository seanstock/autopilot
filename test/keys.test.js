'use strict';

// src/keys.js: provider keys storage, masking, cycle env injection, and
// detection from env / .env files. Everything runs against a temp home.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const keys = require('../src/keys');
const engines = require('../src/engines');

function tempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-keys-home-'));
  process.env.AUTOPILOT_HOME_OVERRIDE = dir;
  return dir;
}

test.afterEach(() => {
  delete process.env.AUTOPILOT_HOME_OVERRIDE;
});

test('load() with no file is empty; set/save/load round-trips; empty clears', () => {
  const home = tempHome();
  assert.deepEqual(keys.load(), { openai: null, stability: null, sources: {} });
  const rec = keys.load();
  keys.set(rec, 'openai', '  sk-proj-abcdefghijklmnop  ', 'settings');
  keys.set(rec, 'stability', 'sk-stab-123456789', 'settings');
  keys.save(rec);
  assert.ok(fs.existsSync(path.join(home, 'keys.json')), 'keys live in their own file, not projects.json');
  const back = keys.load();
  assert.equal(back.openai, 'sk-proj-abcdefghijklmnop');
  assert.equal(back.stability, 'sk-stab-123456789');
  assert.equal(back.sources.openai, 'settings');
  keys.set(back, 'openai', '', 'settings');
  keys.save(back);
  assert.equal(keys.load().openai, null);
  assert.equal(keys.load().sources.openai, undefined);
  keys.set(back, 'nonsense', 'x'); // unknown provider ignored
  assert.equal(back.nonsense, undefined);
});

test('summary() masks and never carries the key', () => {
  const rec = { openai: 'sk-proj-abcdefghijklmnop', stability: null, sources: { openai: 'detected:env:OPENAI_API_KEY' } };
  const s = keys.summary(rec);
  assert.deepEqual(s.openai, { set: true, masked: 'sk-pr...nop', source: 'detected:env:OPENAI_API_KEY' });
  assert.deepEqual(s.stability, { set: false, masked: null, source: null });
  assert.doesNotMatch(JSON.stringify(s), /abcdefghijklmnop/);
  assert.equal(keys.mask('short'), 'sh...');
});

test('cycleEnvVars: stored keys are injected; CODEX_API_KEY only for a signed-out codex engine', () => {
  const rec = { openai: 'sk-o', stability: 'sk-s', sources: {} };
  assert.deepEqual(keys.cycleEnvVars(rec, { engine: 'claude' }), { OPENAI_API_KEY: 'sk-o', STABILITY_API_KEY: 'sk-s' });
  assert.deepEqual(keys.cycleEnvVars(rec, { engine: 'codex', codexLoggedIn: true }), { OPENAI_API_KEY: 'sk-o', STABILITY_API_KEY: 'sk-s' });
  assert.deepEqual(keys.cycleEnvVars(rec, { engine: 'codex', codexLoggedIn: false }),
    { OPENAI_API_KEY: 'sk-o', CODEX_API_KEY: 'sk-o', STABILITY_API_KEY: 'sk-s' });
  assert.deepEqual(keys.cycleEnvVars(rec, { engine: 'codex', codexLoggedIn: null }), { OPENAI_API_KEY: 'sk-o', STABILITY_API_KEY: 'sk-s' },
    'unknown sign-in state does not force API billing');
  assert.deepEqual(keys.cycleEnvVars({ openai: null, stability: null, sources: {} }, { engine: 'codex', codexLoggedIn: false }), {});
});

test('engines.cycleEnv strips ambient keys, then injects only what it is given', () => {
  const env = engines.cycleEnv(
    { PATH: '/bin', OPENAI_API_KEY: 'ambient', STABILITY_API_KEY: 'ambient', ANTHROPIC_API_KEY: 'ambient' },
    { OPENAI_API_KEY: 'stored' }
  );
  assert.equal(env.OPENAI_API_KEY, 'stored');
  assert.equal(env.STABILITY_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'Anthropic keys are never injected');
  assert.equal(env.PATH, '/bin');
});

test('parseDotenv handles quotes, export, comments and blanks', () => {
  const parsed = keys.parseDotenv('# c\nexport OPENAI_API_KEY="sk-a"\nSTABILITY_API_KEY=\'sk-b\'\nEMPTY=\nJUNK LINE\n');
  assert.equal(parsed.OPENAI_API_KEY, 'sk-a');
  assert.equal(parsed.STABILITY_API_KEY, 'sk-b');
  assert.equal(parsed.EMPTY, '');
  assert.equal(parsed['JUNK LINE'], undefined);
});

test('detect(): env wins, then .env files up to two levels under home; dot-dirs and node_modules skipped', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-keys-fakehome-'));
  fs.mkdirSync(path.join(fakeHome, 'proj', 'backend'), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.hidden'), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, 'proj', 'backend', '.env'), 'STABILITY_API_KEY=sk-from-file\n');
  fs.writeFileSync(path.join(fakeHome, '.hidden', '.env'), 'OPENAI_API_KEY=sk-hidden\n');
  fs.writeFileSync(path.join(fakeHome, 'node_modules', 'x', '.env'), 'OPENAI_API_KEY=sk-nm\n');

  const found = keys.detect({ env: { OPENAI_API_KEY: 'sk-from-env' }, homeDir: fakeHome });
  assert.equal(found.openai.value, 'sk-from-env');
  assert.equal(found.openai.source, 'detected:env:OPENAI_API_KEY');
  assert.equal(found.stability.value, 'sk-from-file');
  assert.match(found.stability.source, /proj\/backend\/\.env$/);

  const none = keys.detect({ env: {}, homeDir: fakeHome });
  assert.equal(none.openai, null, 'dot-dirs and node_modules are not searched');
});

test('autofill() fills empty slots only and never overwrites a stored key', () => {
  tempHome();
  const rec = keys.load();
  keys.set(rec, 'openai', 'sk-typed-by-hand', 'settings');
  keys.save(rec);
  const r = keys.autofill({ env: { OPENAI_API_KEY: 'sk-env', STABILITY_API_KEY: 'sk-env-stab' }, files: [] });
  assert.deepEqual(r.filled, ['stability']);
  const back = keys.load();
  assert.equal(back.openai, 'sk-typed-by-hand');
  assert.equal(back.stability, 'sk-env-stab');
  assert.equal(back.sources.stability, 'detected:env:STABILITY_API_KEY');
  const again = keys.autofill({ env: { OPENAI_API_KEY: 'sk-env' }, files: [] });
  assert.deepEqual(again.filled, [], 'nothing left to fill');
});
