'use strict';

// Engines: the headless coding CLIs Autopilot can run a cycle through.
// Zero npm dependencies, Node built-ins only, CommonJS.
//
//   claude     - Claude Code, `claude -p --output-format stream-json`, billed
//                to an Anthropic subscription. The original and default engine.
//   codex      - OpenAI Codex CLI, `codex exec --json`, billed to a ChatGPT
//                subscription. Added 2026-09-15.
//   openrouter - Claude Code again, pointed at OpenRouter's Anthropic-
//                compatible endpoint (ANTHROPIC_BASE_URL + bearer key), so
//                any OpenRouter model id (google/, x-ai/, qwen/, deepseek/,
//                ...) runs a cycle with the same hooks, guard and parsing as
//                the claude engine. Billed to OpenRouter credits. Added
//                2026-09-16. Anthropic and OpenAI models are deliberately
//                NOT offered through it: those run on their own engines.
//
// Everything engine-specific that the runner needs is a pure function here
// (command, args, env, line parsing) so both engines are unit-testable from
// any host without either CLI installed. The only impure part is the status
// probe (installed? version? logged in?), which is cached the same way
// src/localmodel.js caches its probe, because snapshot() is synchronous.
//
// What Codex does NOT get, and why it is documented in the UI:
//   - No PreToolUse hook, so no guard script: STOP is enforced only by the
//     daemon's kill poll (a few seconds), and the blocklist tripwires do not
//     exist. Codex's own sandbox (`--sandbox workspace-write`) is the
//     containment layer instead - writes stay inside the project directory.
//   - No usage meter: there is no endpoint to read a ChatGPT plan's
//     utilization, so a Codex project runs until a cycle exits on a usage
//     limit, then sleeps for a fixed re-try window (src/budget.js).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const util = require('./util');

const ENGINE_IDS = ['claude', 'codex', 'openrouter'];
const DEFAULT_ENGINE = 'claude';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';

// Engines that Claude Code executes (same CLI, same argv, same guard hook).
function runsOnClaudeCode(engine) {
  const e = normalizeEngine(engine);
  return e === 'claude' || e === 'openrouter';
}

// Codex's `model_reasoning_effort` accepts minimal|low|medium|high|xhigh.
// Autopilot's effort set is claude's (low..max); `max` has no Codex
// equivalent, so it maps to the top Codex level.
const CODEX_EFFORT = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' };

// The model value meaning "whatever Codex is configured to use" - Codex has
// a configured default and the catalog changes often, so Autopilot does not
// force a choice.
const CODEX_DEFAULT_MODEL = 'default';

function normalizeEngine(value) {
  return ENGINE_IDS.includes(value) ? value : DEFAULT_ENGINE;
}

// The model catalog the UI offers (2026-09-16). One source of truth, shipped
// in the status snapshot so every dropdown (add form, config card,
// experiment defaults and variants) draws from the same list. Anything not
// listed can still be typed in as a custom id.
//   anthropic  - claude engine (subscription); ids verified 2026-09-16
//   openai     - codex engine (subscription); ids verified 2026-09-16
//   openrouter - openrouter engine; the curated picker from sean.wiki/chat
//                minus its Anthropic and OpenAI entries (those belong on
//                their own engines, never via a third party - user rule).
const MODEL_CATALOG = {
  text: {
    anthropic: ['claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5', 'claude-haiku-4-5'],
    openai: ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    openrouter: [
      'google/gemini-3.7-flash',
      'x-ai/grok-4.6',
      'moonshotai/kimi-k3',
      'moonshotai/kimi-k2.7-code',
      'qwen/qwen3.8-max',
      'qwen/qwen3.8-2.4t-a95b',
      'qwen/qwen3.8-27b',
      'qwen/qwen3.8-flash',
      'qwen/qwen3-coder-plus',
      'z-ai/glm-5.3',
      'z-ai/glm-5.3-flash',
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-flash',
    ],
  },
};

// OpenRouter ids for Anthropic and OpenAI models are refused everywhere a
// model is set (state validation): those vendors run on their own engines.
const THIRD_PARTY_VENDOR_RE = /^(anthropic|openai)\//i;

// Which engine a model id implies: claude-* runs on Claude Code, an OpenAI
// id on Codex, a vendor/model id on OpenRouter, and anything else (a local
// model, a custom id) keeps whatever engine the project already has
// (null = no opinion).
function engineForModel(model) {
  if (typeof model !== 'string') return null;
  if (/^claude-/i.test(model)) return 'claude';
  if (/^(gpt-|o\d|codex)/i.test(model)) return 'codex';
  if (model.includes('/')) return 'openrouter';
  return null;
}

// Command + leading args for the engine's CLI. On Windows an npm-installed
// CLI is a .cmd shim that Node's spawn() cannot run without a shell.
function command(engine, platform) {
  const bin = runsOnClaudeCode(engine) ? 'claude' : 'codex';
  return (platform || process.platform) === 'win32' ? ['cmd', '/c', bin] : [bin];
}

// Pure: the argv (after the command) for one cycle.
//   claude: -p --model M [--effort E] --permission-mode acceptEdits
//           --settings <path> --output-format stream-json --verbose
//   codex:  exec --json -C <dir> --skip-git-repo-check --ephemeral
//           [-m M] [-c model_reasoning_effort=E] <sandbox flags> -
// Both read the preamble from stdin (`-` is Codex's explicit stdin sentinel).
function cycleArgs({ engine, model, effort, settingsPath, dir, containment }) {
  if (normalizeEngine(engine) === 'codex') {
    const args = ['exec', '--json', '-C', dir, '--skip-git-repo-check', '--ephemeral'];
    if (model && model !== CODEX_DEFAULT_MODEL) args.push('-m', model);
    if (CODEX_EFFORT[effort]) args.push('-c', `model_reasoning_effort="${CODEX_EFFORT[effort]}"`);
    if (containment === 'off') {
      args.push('--dangerously-bypass-approvals-and-sandbox');
    } else {
      // workspace-write confines edits to the project dir; network is off in
      // that mode by default, which would take away web research, so it is
      // re-enabled explicitly. Approvals never: nobody is watching.
      args.push('--sandbox', 'workspace-write', '-a', 'never',
        '-c', 'sandbox_workspace_write.network_access=true');
    }
    args.push('-');
    return args;
  }
  const args = ['-p', '--model', model];
  if (util.EFFORT_LEVELS.has(effort)) args.push('--effort', effort);
  args.push('--permission-mode', 'acceptEdits', '--settings', settingsPath,
    '--output-format', 'stream-json', '--verbose');
  return args;
}

// Subscription-only by default, for every engine: any API key sitting in
// the daemon's ambient environment would silently move billing from the
// subscription to pay-as-you-go credits (SPEC.md section 3), so all of them
// are stripped from every cycle regardless of which engine it runs.
//
// The exception is deliberate: keys the user stored on the Settings page
// (src/keys.js) are injected back AFTER the strip, because storing one there
// is an explicit decision to let cycles use it - the OpenRouter key is what
// the openrouter engine runs on, and the OpenAI key is Codex's API-billed
// fallback when it has no ChatGPT login. Anthropic keys are never injected:
// Claude cycles stay on the subscription, always.
// ANTHROPIC_BASE_URL is NOT stripped: an ambient endpoint (a gateway, Claude
// Desktop's own setting) passes through to claude cycles unchanged, as it
// always has; only the openrouter engine overrides it, explicitly.
const STRIPPED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENROUTER_API_KEY'];

function cycleEnv(baseEnv, injected) {
  const env = Object.assign({}, baseEnv || process.env);
  for (const k of STRIPPED_ENV) delete env[k];
  if (injected && typeof injected === 'object') {
    for (const [k, v] of Object.entries(injected)) if (typeof v === 'string' && v) env[k] = v;
  }
  return env;
}

// Pure: interpret one parsed JSON line of the engine's stdout.
// Returns { texts: string[], result: object|null } where result, when
// present, is the runner's resultInfo shape:
//   { subtype, isError, tokens:{in,out}, costUsd, modelUsage }
function parseLine(engine, parsed) {
  const out = { texts: [], result: null };
  if (!parsed || typeof parsed !== 'object') return out;

  if (normalizeEngine(engine) === 'codex') {
    // Codex JSONL: item.completed{item:{type:'agent_message',text}},
    // turn.completed{usage:{input_tokens,cached_input_tokens,output_tokens}},
    // turn.failed{error:{message}} / error{message}.
    if (parsed.type === 'item.completed' && parsed.item && parsed.item.type === 'agent_message'
        && typeof parsed.item.text === 'string') {
      out.texts.push(parsed.item.text);
    } else if (parsed.type === 'turn.completed') {
      const u = parsed.usage || {};
      out.result = {
        subtype: 'success',
        isError: false,
        // input_tokens already includes the cached portion in Codex's
        // accounting (cached_input_tokens is a sub-count, not an addend).
        tokens: { in: Number(u.input_tokens) || 0, out: Number(u.output_tokens) || 0 },
        costUsd: null,
        modelUsage: null,
      };
    } else if (parsed.type === 'turn.failed' || parsed.type === 'error') {
      out.result = { subtype: 'error', isError: true, tokens: { in: 0, out: 0 }, costUsd: null, modelUsage: null };
    }
    return out;
  }

  // Claude stream-json.
  if (parsed.type === 'assistant') {
    const content = parsed.message && Array.isArray(parsed.message.content) ? parsed.message.content : [];
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') out.texts.push(block.text);
    }
  } else if (parsed.type === 'result') {
    const usage = parsed.usage || {};
    const inputTokens = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0);
    out.result = {
      subtype: parsed.subtype || null,
      isError: parsed.is_error === true,
      tokens: { in: inputTokens, out: usage.output_tokens || 0 },
      costUsd: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
      modelUsage: normalizeModelUsage(parsed.modelUsage),
    };
  }
  return out;
}

// stream-json's result line carries a per-model usage/cost breakdown that
// INCLUDES subagent activity (verified empirically 2026-07-24). Normalized
// to Autopilot's shape; absent/foreign shapes yield null and the caller
// falls back to whole-cycle single-model attribution.
function normalizeModelUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const [model, u] of Object.entries(raw)) {
    if (!u || typeof u !== 'object') continue;
    out[model] = {
      in: (Number(u.inputTokens) || 0) + (Number(u.cacheReadInputTokens) || 0) + (Number(u.cacheCreationInputTokens) || 0),
      out: Number(u.outputTokens) || 0,
      costUsd: Number(u.costUSD) || 0,
    };
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// status probe: installed / version / logged in
// ---------------------------------------------------------------------------

const PROBE_TTL_MS = 60 * 1000;
const PROBE_TIMEOUT_MS = 15 * 1000;

const ENGINE_LABELS = {
  claude: 'Claude Code (Anthropic)',
  codex: 'Codex CLI (OpenAI)',
  openrouter: 'OpenRouter (via Claude Code)',
};

function runCapture(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    try {
      execFile(cmd, args, { windowsHide: true, encoding: 'utf8', timeout: timeoutMs, env: cycleEnv() },
        (err, stdout, stderr) => {
          finish({ code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
            stdout: String(stdout || ''), stderr: String(stderr || ''), error: err && err.code === 'ENOENT' ? 'ENOENT' : null });
        });
    } catch (err) {
      finish({ code: null, stdout: '', stderr: '', error: 'ENOENT' });
    }
  });
}

// Default probe implementation. Resolves one status object, never rejects.
//   { id, label, installed, version, loggedIn, detail, checkedIso }
async function probeEngine(engine, runImpl) {
  const run = runImpl || runCapture;
  const id = normalizeEngine(engine);
  const cmd = command(id);
  const base = { id, label: ENGINE_LABELS[id] };

  // OpenRouter is not a CLI: it is Claude Code plus a stored key. "Signed
  // in" means the key exists (src/keys.js); "installed" means claude is.
  if (id === 'openrouter') {
    const claudeStatus = await probeEngine('claude', runImpl);
    let keySet = false;
    try {
      keySet = !!require('./keys').load().openrouter;
    } catch (err) {
      keySet = false;
    }
    return Object.assign(base, {
      installed: claudeStatus.installed,
      version: claudeStatus.version,
      loggedIn: claudeStatus.installed && keySet,
      detail: !claudeStatus.installed ? 'needs Claude Code on PATH' : keySet ? 'key set' : 'no OpenRouter key (Settings > Provider API keys)',
      checkedIso: util.nowIso(),
    });
  }

  const v = await run(cmd[0], cmd.slice(1).concat(['--version']), PROBE_TIMEOUT_MS);
  if (v.error === 'ENOENT' || (v.code !== 0 && !v.stdout.trim())) {
    return Object.assign(base, { installed: false, version: null, loggedIn: false,
      detail: `${id} is not on the daemon's PATH`, checkedIso: util.nowIso() });
  }
  // "codex-cli 0.99.0" / "2.1.270 (Claude Code)" -> the bare version token.
  const firstLine = v.stdout.trim().split('\n')[0] || '';
  const vm = /(\d+\.\d+[\w.\-]*)/.exec(firstLine);
  const version = vm ? vm[1] : (firstLine.trim() || null);

  if (id === 'codex') {
    // `codex login status` exits 0 when authenticated.
    const s = await run(cmd[0], cmd.slice(1).concat(['login', 'status']), PROBE_TIMEOUT_MS);
    const loggedIn = s.code === 0;
    return Object.assign(base, { installed: true, version, loggedIn,
      detail: loggedIn ? 'signed in' : 'not signed in', checkedIso: util.nowIso() });
  }

  // `claude auth status` prints JSON {loggedIn, authMethod, ...}. A stored
  // OAuth token also counts: the status command reports loggedIn:false in
  // some nested/CI environments where cycles nonetheless run fine.
  const s = await run(cmd[0], cmd.slice(1).concat(['auth', 'status']), PROBE_TIMEOUT_MS);
  let statusJson = null;
  try { statusJson = JSON.parse(s.stdout); } catch (err) { statusJson = null; }
  let tokenPresent = false;
  try {
    const budget = require('./budget');
    tokenPresent = !!(budget.readAccessToken(path.join(os.homedir(), '.claude', '.credentials.json'))
      || budget.readKeychainToken());
  } catch (err) {
    tokenPresent = false;
  }
  const loggedIn = !!(statusJson && statusJson.loggedIn) || tokenPresent;
  const method = statusJson && statusJson.authMethod && statusJson.authMethod !== 'none' ? statusJson.authMethod : null;
  return Object.assign(base, { installed: true, version, loggedIn,
    detail: loggedIn ? `signed in${method ? ' (' + method + ')' : ''}` : 'not signed in',
    checkedIso: util.nowIso() });
}

// Where an interactive login's output goes, so a login that silently fails
// leaves a trail (same reasoning as localmodel-start.log).
function loginLogPath() {
  return path.join(util.AUTOPILOT_HOME, 'engine-login.log');
}

// Launch the engine's browser-based sign-in flow, detached, from the
// daemon's desktop session. Both CLIs open the system browser and complete
// on their own; Codex additionally prints a device code to its stdout,
// which lands in the log for the "browser did not open" case.
function defaultLoginSpawn(engine) {
  const id = normalizeEngine(engine);
  const cmd = command(id);
  const args = cmd.slice(1).concat(id === 'codex' ? ['login'] : ['auth', 'login', '--claudeai']);
  let out = null;
  try {
    const p = loginLogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    out = fs.openSync(p, 'a');
    fs.writeSync(out, `\n=== ${id} login requested ${new Date().toISOString()} ===\n`);
  } catch (err) {
    out = null;
  }
  const child = spawn(cmd[0], args, {
    // See localmodel.js: `detached` on a console-less Windows daemon kills
    // console children instantly. unref() is enough there.
    detached: process.platform !== 'win32',
    stdio: ['ignore', out === null ? 'ignore' : out, out === null ? 'ignore' : out],
    windowsHide: true,
    env: cycleEnv(),
  });
  child.unref();
  return child;
}

class EngineStatus {
  constructor(opts) {
    const o = opts || {};
    this._probe = o.probeImpl || probeEngine;
    this._loginSpawn = o.loginSpawnImpl || defaultLoginSpawn;
    this._now = o.now || (() => Date.now());
    this._ttlMs = typeof o.ttlMs === 'number' ? o.ttlMs : PROBE_TTL_MS;
    this._state = {};
    this._checkedAt = -Infinity;
    this._inFlight = null;
  }

  // Synchronous, for snapshot(): returns the cached map and kicks off a
  // background refresh when stale. Before the first probe completes every
  // engine reads as unchecked rather than as absent.
  current() {
    if (this._now() - this._checkedAt >= this._ttlMs) this.refresh();
    const out = {};
    for (const id of ENGINE_IDS) {
      out[id] = this._state[id] || { id, label: ENGINE_LABELS[id],
        installed: null, version: null, loggedIn: null, detail: 'checking...', checkedIso: null };
    }
    return out;
  }

  async refresh() {
    if (this._inFlight) return this._inFlight;
    this._inFlight = (async () => {
      const next = {};
      for (const id of ENGINE_IDS) {
        try {
          next[id] = await this._probe(id);
        } catch (err) {
          next[id] = { id, installed: false, version: null, loggedIn: false,
            detail: `probe failed: ${err && err.message}`, checkedIso: util.nowIso() };
        }
      }
      this._state = next;
      this._checkedAt = this._now();
      this._inFlight = null;
      return next;
    })();
    return this._inFlight;
  }

  // Start a sign-in flow. Returns {ok} or {ok:false, error}. The result of
  // the login shows up on the next probe; callers force one with refresh().
  login(engine) {
    const id = normalizeEngine(engine);
    if (id === 'openrouter') return { ok: false, error: 'OpenRouter has no sign-in: paste its API key under Provider API keys' };
    const st = this._state[id];
    if (st && st.installed === false) return { ok: false, error: `${id} is not installed on this machine` };
    try {
      this._loginSpawn(id);
    } catch (err) {
      return { ok: false, error: `could not launch ${id} login: ${err.message}` };
    }
    this._checkedAt = -Infinity; // re-probe promptly so the UI flips once it lands
    return { ok: true };
  }
}

let sharedInstance = null;
function shared() {
  if (!sharedInstance) sharedInstance = new EngineStatus();
  return sharedInstance;
}

module.exports = {
  ENGINE_IDS,
  DEFAULT_ENGINE,
  CODEX_DEFAULT_MODEL,
  CODEX_EFFORT,
  STRIPPED_ENV,
  MODEL_CATALOG,
  THIRD_PARTY_VENDOR_RE,
  OPENROUTER_BASE_URL,
  ENGINE_LABELS,
  engineForModel,
  runsOnClaudeCode,
  normalizeEngine,
  command,
  cycleArgs,
  cycleEnv,
  parseLine,
  normalizeModelUsage,
  probeEngine,
  EngineStatus,
  shared,
  defaultLoginSpawn,
};
