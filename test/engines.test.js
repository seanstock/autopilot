'use strict';

// src/engines.js: the per-engine pure functions (command, argv, env, line
// parsing) and the cached status probe. Neither CLI is required - the
// probe takes an injected runner and the argv/parse functions are pure -
// so both engines are covered from any host.

const test = require('node:test');
const assert = require('node:assert/strict');

const engines = require('../src/engines');

// ---- identity ---------------------------------------------------------------

test('normalizeEngine defaults anything unknown to claude', () => {
  assert.equal(engines.normalizeEngine('codex'), 'codex');
  assert.equal(engines.normalizeEngine('claude'), 'claude');
  assert.equal(engines.normalizeEngine(undefined), 'claude');
  assert.equal(engines.normalizeEngine('gemini'), 'claude');
});

test('command goes through cmd /c on windows for both engines', () => {
  assert.deepEqual(engines.command('codex', 'win32'), ['cmd', '/c', 'codex']);
  assert.deepEqual(engines.command('codex', 'darwin'), ['codex']);
  assert.deepEqual(engines.command('claude', 'win32'), ['cmd', '/c', 'claude']);
  assert.deepEqual(engines.command('claude', 'linux'), ['claude']);
});

// ---- argv -------------------------------------------------------------------

test('claude argv is the original -p stream-json shape, effort only when valid', () => {
  const a = engines.cycleArgs({ engine: 'claude', model: 'claude-sonnet-5', effort: 'xhigh', settingsPath: '/s.json', dir: '/p' });
  assert.deepEqual(a, ['-p', '--model', 'claude-sonnet-5', '--effort', 'xhigh', '--permission-mode', 'acceptEdits',
    '--settings', '/s.json', '--output-format', 'stream-json', '--verbose']);
  const b = engines.cycleArgs({ engine: 'claude', model: 'claude-sonnet-5', effort: 'bogus', settingsPath: '/s.json', dir: '/p' });
  assert.ok(!b.includes('--effort'));
});

test('codex argv: exec --json, cwd via -C, stdin prompt, workspace-write sandbox with network', () => {
  const a = engines.cycleArgs({ engine: 'codex', model: 'gpt-5.6-terra', effort: 'high', dir: '/p', containment: 'standard' });
  assert.equal(a[0], 'exec');
  assert.ok(a.includes('--json'));
  assert.deepEqual(a.slice(a.indexOf('-C'), a.indexOf('-C') + 2), ['-C', '/p']);
  assert.ok(a.includes('--skip-git-repo-check'));
  assert.deepEqual(a.slice(a.indexOf('-m'), a.indexOf('-m') + 2), ['-m', 'gpt-5.6-terra']);
  assert.ok(a.includes('model_reasoning_effort="high"'));
  assert.deepEqual(a.slice(a.indexOf('--sandbox'), a.indexOf('--sandbox') + 2), ['--sandbox', 'workspace-write']);
  assert.deepEqual(a.slice(a.indexOf('-a'), a.indexOf('-a') + 2), ['-a', 'never']);
  assert.ok(a.includes('sandbox_workspace_write.network_access=true'));
  assert.equal(a[a.length - 1], '-', 'prompt is read from stdin, like claude');
  assert.ok(!a.includes('--dangerously-bypass-approvals-and-sandbox'));
});

test('codex argv: "default" model sends no -m; max effort maps to xhigh; containment off drops the sandbox', () => {
  const a = engines.cycleArgs({ engine: 'codex', model: 'default', effort: 'max', dir: '/p', containment: 'off' });
  assert.ok(!a.includes('-m'));
  assert.ok(a.includes('model_reasoning_effort="xhigh"'));
  assert.ok(a.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(!a.includes('--sandbox'));
  const b = engines.cycleArgs({ engine: 'codex', model: 'default', effort: undefined, dir: '/p' });
  assert.ok(!b.some((x) => /model_reasoning_effort/.test(x)));
});

// ---- env --------------------------------------------------------------------

test('cycleEnv strips every provider API key so cycles bill the subscription', () => {
  const env = engines.cycleEnv({ PATH: '/bin', ANTHROPIC_API_KEY: 'a', ANTHROPIC_AUTH_TOKEN: 'b', OPENAI_API_KEY: 'c', CODEX_API_KEY: 'd', KEEP: '1' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.KEEP, '1');
  for (const k of engines.STRIPPED_ENV) assert.equal(env[k], undefined, k);
});

// ---- parsing ----------------------------------------------------------------

test('parseLine(codex): agent_message text is activity, turn.completed is the result with usage', () => {
  const msg = engines.parseLine('codex', { type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'hello' } });
  assert.deepEqual(msg.texts, ['hello']);
  assert.equal(msg.result, null);

  const other = engines.parseLine('codex', { type: 'item.completed', item: { id: 'i', type: 'command_execution', command: 'ls' } });
  assert.deepEqual(other.texts, []);

  const done = engines.parseLine('codex', { type: 'turn.completed', usage: { input_tokens: 24763, cached_input_tokens: 24448, output_tokens: 122, reasoning_output_tokens: 0 } });
  assert.equal(done.result.isError, false);
  assert.deepEqual(done.result.tokens, { in: 24763, out: 122 });
  assert.equal(done.result.costUsd, null, 'a subscription-billed engine reports no dollar cost');
  assert.equal(done.result.modelUsage, null);

  const failed = engines.parseLine('codex', { type: 'turn.failed', error: { message: 'x' } });
  assert.equal(failed.result.isError, true);
});

test('parseLine(claude): assistant text and result usage including cache reads and modelUsage', () => {
  const a = engines.parseLine('claude', { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use' }] } });
  assert.deepEqual(a.texts, ['hi']);
  const r = engines.parseLine('claude', {
    type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.5,
    usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 7 },
    modelUsage: { 'claude-sonnet-5': { inputTokens: 1, cacheReadInputTokens: 2, cacheCreationInputTokens: 3, outputTokens: 4, costUSD: 0.1 } },
  });
  assert.deepEqual(r.result.tokens, { in: 35, out: 7 });
  assert.equal(r.result.costUsd, 0.5);
  assert.deepEqual(r.result.modelUsage, { 'claude-sonnet-5': { in: 6, out: 4, costUsd: 0.1 } });
});

test('parseLine tolerates junk', () => {
  assert.deepEqual(engines.parseLine('codex', null), { texts: [], result: null });
  assert.deepEqual(engines.parseLine('claude', 'str'), { texts: [], result: null });
  assert.deepEqual(engines.parseLine('codex', { type: 'weird' }), { texts: [], result: null });
});

// ---- probe ------------------------------------------------------------------

function fakeRun(table) {
  // table: map of "<bin> <args joined>" -> {code, stdout, stderr, error}
  return async (bin, args) => {
    const key = `${bin} ${args.join(' ')}`;
    for (const [pattern, resp] of Object.entries(table)) {
      if (key.endsWith(pattern)) return Object.assign({ code: 0, stdout: '', stderr: '', error: null }, resp);
    }
    return { code: null, stdout: '', stderr: '', error: 'ENOENT' };
  };
}

test('probeEngine(codex): version + login status exit code', async () => {
  const st = await engines.probeEngine('codex', fakeRun({
    'codex --version': { stdout: 'codex-cli 0.99.0\n' },
    'codex login status': { code: 0, stdout: 'Logged in using ChatGPT\n' },
  }));
  assert.equal(st.installed, true);
  assert.equal(st.version, '0.99.0');
  assert.equal(st.loggedIn, true);

  const out = await engines.probeEngine('codex', fakeRun({
    'codex --version': { stdout: 'codex-cli 0.99.0\n' },
    'codex login status': { code: 1, stderr: 'Not logged in\n' },
  }));
  assert.equal(out.loggedIn, false);
  assert.match(out.detail, /not signed in/);
});

test('probeEngine: a missing binary is installed:false, never a throw', async () => {
  const st = await engines.probeEngine('codex', fakeRun({}));
  assert.equal(st.installed, false);
  assert.equal(st.loggedIn, false);
  assert.match(st.detail, /not on the daemon's PATH/);
});

test('probeEngine(claude): auth status JSON drives loggedIn', async () => {
  const st = await engines.probeEngine('claude', fakeRun({
    'claude --version': { stdout: '2.1.270 (Claude Code)\n' },
    'claude auth status': { code: 0, stdout: '{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}\n' },
  }));
  assert.equal(st.installed, true);
  assert.equal(st.loggedIn, true);
  assert.match(st.detail, /claude\.ai/);
});

test('EngineStatus caches, refreshes when stale, and reports unchecked before the first probe', async () => {
  let probes = 0;
  let now = 1000;
  const es = new engines.EngineStatus({
    now: () => now,
    ttlMs: 500,
    probeImpl: async (id) => { probes += 1; return { id, installed: true, version: '1', loggedIn: id === 'claude', detail: 'x', checkedIso: 't' }; },
  });
  const first = es.current();
  assert.equal(first.codex.installed, null, 'unchecked until the probe lands');
  assert.equal(first.codex.detail, 'checking...');
  await es.refresh();
  assert.equal(probes, 2, 'one probe per engine');
  assert.equal(es.current().claude.loggedIn, true);
  assert.equal(es.current().codex.loggedIn, false);
  es.current();
  assert.equal(probes, 2, 'fresh: no re-probe');
  now += 600;
  es.current();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(probes, 4, 'stale: background re-probe kicked off');
});

test('EngineStatus.login spawns the engine login and forces a re-probe; refuses when not installed', async () => {
  const spawned = [];
  const es = new engines.EngineStatus({
    probeImpl: async (id) => ({ id, installed: id === 'claude', version: '1', loggedIn: false, detail: 'x', checkedIso: 't' }),
    loginSpawnImpl: (id) => { spawned.push(id); return {}; },
  });
  await es.refresh();
  assert.deepEqual(es.login('codex'), { ok: false, error: 'codex is not installed on this machine' });
  assert.equal(es.login('claude').ok, true);
  assert.deepEqual(spawned, ['claude']);
});
