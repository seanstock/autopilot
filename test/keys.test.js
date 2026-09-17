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
  assert.deepEqual(keys.load(), { openrouter: null, openai: null, sources: {} });
  const rec = keys.load();
  keys.set(rec, 'openai', '  sk-proj-abcdefghijklmnop  ', 'settings');
  keys.set(rec, 'openrouter', 'sk-or-123456789', 'settings');
  keys.save(rec);
  assert.ok(fs.existsSync(path.join(home, 'keys.json')), 'keys live in their own file, not projects.json');
  const back = keys.load();
  assert.equal(back.openai, 'sk-proj-abcdefghijklmnop');
  assert.equal(back.openrouter, 'sk-or-123456789');
  assert.equal(back.sources.openai, 'settings');
  keys.set(back, 'openai', '', 'settings');
  keys.save(back);
  assert.equal(keys.load().openai, null);
  assert.equal(keys.load().sources.openai, undefined);
  keys.set(back, 'nonsense', 'x'); // unknown provider ignored
  assert.equal(back.nonsense, undefined);
});

test('summary() masks and never carries the key', () => {
  const rec = { openai: 'sk-proj-abcdefghijklmnop', openrouter: null, sources: { openai: 'detected:env:OPENAI_API_KEY' } };
  const s = keys.summary(rec);
  assert.deepEqual(s.openai, { set: true, masked: 'sk-pr...nop', source: 'detected:env:OPENAI_API_KEY' });
  assert.deepEqual(s.openrouter, { set: false, masked: null, source: null });
  assert.doesNotMatch(JSON.stringify(s), /abcdefghijklmnop/);
  assert.equal(keys.mask('short'), 'sh...');
});

test('cycleEnvVars: OpenAI key for codex (CODEX_API_KEY only when signed out); OpenRouter key routes claude code', () => {
  const rec = { openai: 'sk-o', openrouter: 'sk-or', sources: {} };
  assert.deepEqual(keys.cycleEnvVars(rec, { engine: 'claude' }), { OPENAI_API_KEY: 'sk-o' }, 'a claude cycle never sees the OpenRouter key');
  assert.deepEqual(keys.cycleEnvVars(rec, { engine: 'codex', codexLoggedIn: true }), { OPENAI_API_KEY: 'sk-o' });
  assert.deepEqual(keys.cycleEnvVars(rec, { engine: 'codex', codexLoggedIn: false }), { OPENAI_API_KEY: 'sk-o', CODEX_API_KEY: 'sk-o' });
  assert.deepEqual(keys.cycleEnvVars(rec, { engine: 'codex', codexLoggedIn: null }), { OPENAI_API_KEY: 'sk-o' },
    'unknown sign-in state does not force API billing');
  const or = keys.cycleEnvVars(rec, { engine: 'openrouter', model: 'qwen/qwen3-coder-plus' });
  assert.equal(or.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
  assert.equal(or.ANTHROPIC_AUTH_TOKEN, 'sk-or');
  assert.equal(or.ANTHROPIC_API_KEY, undefined, 'never an Anthropic key');
  for (const a of ['FABLE', 'OPUS', 'SONNET', 'HAIKU']) assert.equal(or[`ANTHROPIC_DEFAULT_${a}_MODEL`], 'qwen/qwen3-coder-plus', a);
  assert.equal(or.CLAUDE_CODE_SUBAGENT_MODEL, 'qwen/qwen3-coder-plus');
  assert.deepEqual(keys.cycleEnvVars({ openai: null, openrouter: null, sources: {} }, { engine: 'openrouter', model: 'x/y' }), {});
});

test('engines.cycleEnv strips ambient keys, then injects only what it is given', () => {
  const env = engines.cycleEnv(
    { PATH: '/bin', OPENAI_API_KEY: 'ambient', OPENROUTER_API_KEY: 'ambient', ANTHROPIC_BASE_URL: 'ambient', ANTHROPIC_API_KEY: 'ambient' },
    { OPENAI_API_KEY: 'stored' }
  );
  assert.equal(env.OPENAI_API_KEY, 'stored');
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, 'ambient', 'an ambient endpoint passes through (only the openrouter engine overrides it)');
  assert.equal(env.ANTHROPIC_API_KEY, undefined, 'Anthropic keys are never injected');
  assert.equal(env.PATH, '/bin');
});

test('parseDotenv handles quotes, export, comments and blanks', () => {
  const parsed = keys.parseDotenv('# c\nexport OPENAI_API_KEY="sk-a"\nOPENROUTER_API_KEY=\'sk-b\'\nEMPTY=\nJUNK LINE\n');
  assert.equal(parsed.OPENAI_API_KEY, 'sk-a');
  assert.equal(parsed.OPENROUTER_API_KEY, 'sk-b');
  assert.equal(parsed.EMPTY, '');
  assert.equal(parsed['JUNK LINE'], undefined);
});

test('detect(): env wins, then .env files up to two levels under home; dot-dirs and node_modules skipped', () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-keys-fakehome-'));
  fs.mkdirSync(path.join(fakeHome, 'proj', 'backend'), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, '.hidden'), { recursive: true });
  fs.mkdirSync(path.join(fakeHome, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(fakeHome, 'proj', 'backend', '.env'), 'OPENROUTER_API_KEY=sk-from-file\n');
  fs.writeFileSync(path.join(fakeHome, '.hidden', '.env'), 'OPENAI_API_KEY=sk-hidden\n');
  fs.writeFileSync(path.join(fakeHome, 'node_modules', 'x', '.env'), 'OPENAI_API_KEY=sk-nm\n');

  const found = keys.detect({ env: { OPENAI_API_KEY: 'sk-from-env' }, homeDir: fakeHome });
  assert.equal(found.openai.value, 'sk-from-env');
  assert.equal(found.openai.source, 'detected:env:OPENAI_API_KEY');
  assert.equal(found.openrouter.value, 'sk-from-file');
  assert.match(found.openrouter.source, /proj\/backend\/\.env$/);

  const none = keys.detect({ env: {}, homeDir: fakeHome });
  assert.equal(none.openai, null, 'dot-dirs and node_modules are not searched');
});

test('autofill() fills empty slots only and never overwrites a stored key', () => {
  tempHome();
  const rec = keys.load();
  keys.set(rec, 'openai', 'sk-typed-by-hand', 'settings');
  keys.save(rec);
  const r = keys.autofill({ env: { OPENAI_API_KEY: 'sk-env', OPENROUTER_API_KEY: 'sk-env-or' }, files: [] });
  assert.deepEqual(r.filled, ['openrouter']);
  const back = keys.load();
  assert.equal(back.openai, 'sk-typed-by-hand');
  assert.equal(back.openrouter, 'sk-env-or');
  assert.equal(back.sources.openrouter, 'detected:env:OPENROUTER_API_KEY');
  const again = keys.autofill({ env: { OPENAI_API_KEY: 'sk-env' }, files: [] });
  assert.deepEqual(again.filled, [], 'nothing left to fill');
});
