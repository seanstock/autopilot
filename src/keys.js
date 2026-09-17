'use strict';

// Provider API keys (2026-09-16): OpenRouter and OpenAI.
// Zero npm dependencies, Node built-ins only, CommonJS.
//
// Stored in ~/.autopilot/keys.json, deliberately SEPARATE from projects.json
// so the registry can be copied, diffed and pasted into a chat without
// leaking a secret. Mode 0600 on POSIX (Windows ACLs already scope the home
// directory to the user).
//
// What the keys are for:
//   - openrouter: what the openrouter engine runs on. A cycle on that engine
//     gets ANTHROPIC_BASE_URL pointed at OpenRouter and the key as
//     ANTHROPIC_AUTH_TOKEN (OpenRouter's documented Claude Code setup), plus
//     the model-alias env vars pinned to the project's model so nothing
//     inside Claude Code falls back to an Anthropic id the router would
//     bill separately.
//   - openai: Codex's API-billed fallback (CODEX_API_KEY) when the Codex CLI
//     is NOT signed in to a ChatGPT account - never a silent replacement for
//     a subscription. Also passed as OPENAI_API_KEY for a project's own code.
// Autopilot itself never sends a key anywhere.
//
// Detection: the daemon fills EMPTY slots once at startup, and the Settings
// page has a "Detect" button, from (in order) the daemon's own environment
// and any .env file within two directory levels of the home directory. A
// slot the user set by hand is never overwritten by detection.

const fs = require('fs');
const os = require('os');
const path = require('path');

const util = require('./util');

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';
const KEYS_FILENAME = 'keys.json';
const PROVIDERS = ['openrouter', 'openai'];

// env var names recognised per provider, in priority order.
const ENV_NAMES = {
  openrouter: ['OPENROUTER_API_KEY', 'OPENROUTER_KEY'],
  openai: ['OPENAI_API_KEY'],
};

function keysFile() {
  return path.join(util.AUTOPILOT_HOME, KEYS_FILENAME);
}

function emptyRecord() {
  return { openrouter: null, openai: null, sources: {} };
}

function load() {
  const raw = util.readJson(keysFile(), null);
  const out = emptyRecord();
  if (!raw || typeof raw !== 'object') return out;
  for (const p of PROVIDERS) {
    if (typeof raw[p] === 'string' && raw[p].trim()) out[p] = raw[p].trim();
  }
  if (raw.sources && typeof raw.sources === 'object') out.sources = Object.assign({}, raw.sources);
  return out;
}

function save(rec) {
  const file = keysFile();
  util.writeJson(file, { openrouter: rec.openrouter || null, openai: rec.openai || null, sources: rec.sources || {} });
  if (process.platform !== 'win32') {
    try { fs.chmodSync(file, 0o600); } catch (err) { /* best effort */ }
  }
}

// Set one provider's key ('' or null clears). source: 'settings' (typed in
// the UI) or 'detected:<where>'.
function set(rec, provider, value, source) {
  if (!PROVIDERS.includes(provider)) return rec;
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v) {
    rec[provider] = null;
    delete rec.sources[provider];
  } else {
    rec[provider] = v;
    rec.sources[provider] = source || 'settings';
  }
  return rec;
}

// "sk-pr...k3f" - enough to recognise a key, never enough to use it.
function mask(value) {
  if (!value) return null;
  const s = String(value);
  if (s.length <= 10) return s.slice(0, 2) + '...';
  return `${s.slice(0, 5)}...${s.slice(-3)}`;
}

// What the UI sees: never the key itself.
function summary(rec) {
  const out = {};
  for (const p of PROVIDERS) {
    out[p] = { set: !!rec[p], masked: mask(rec[p]), source: rec.sources[p] || null };
  }
  return out;
}

// The env vars a cycle should receive. Returns a plain object to merge onto
// the (already stripped) cycle env.
//   engine 'openrouter' + model: Claude Code is pointed at OpenRouter and
//     every model alias Claude Code might resolve on its own (subagents,
//     the small/fast model, /model defaults) is pinned to the project's
//     model, so the whole cycle runs on the model the user picked.
//   engine 'codex' + codexLoggedIn false: the OpenAI key doubles as
//     CODEX_API_KEY (API-billed fallback).
function cycleEnvVars(rec, opts) {
  const o = opts || {};
  const vars = {};
  if (rec.openai) {
    vars.OPENAI_API_KEY = rec.openai;
    if (o.engine === 'codex' && o.codexLoggedIn === false) vars.CODEX_API_KEY = rec.openai;
  }
  if (rec.openrouter && o.engine === 'openrouter') {
    vars.ANTHROPIC_BASE_URL = OPENROUTER_BASE_URL;
    vars.ANTHROPIC_AUTH_TOKEN = rec.openrouter;
    if (o.model) {
      for (const alias of ['FABLE', 'OPUS', 'SONNET', 'HAIKU']) vars[`ANTHROPIC_DEFAULT_${alias}_MODEL`] = o.model;
      vars.CLAUDE_CODE_SUBAGENT_MODEL = o.model;
    }
  }
  return vars;
}

// ---- detection ---------------------------------------------------------------

function parseDotenv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// .env files at ~/.env, ~/*/.env and ~/*/*/.env (no deeper, no node_modules,
// no dot-directories). Cheap: at most a few hundred stats.
function dotenvCandidates(homeDir) {
  const home = homeDir || os.homedir();
  const files = [];
  const push = (f) => { try { if (fs.statSync(f).isFile()) files.push(f); } catch (err) { /* absent */ } };
  push(path.join(home, '.env'));
  let level1 = [];
  try {
    level1 = fs.readdirSync(home, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules' && d.name !== 'AppData')
      .map((d) => path.join(home, d.name));
  } catch (err) {
    level1 = [];
  }
  for (const d1 of level1) {
    push(path.join(d1, '.env'));
    let level2 = [];
    try {
      level2 = fs.readdirSync(d1, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules')
        .map((d) => path.join(d1, d.name));
    } catch (err) {
      level2 = [];
    }
    for (const d2 of level2) push(path.join(d2, '.env'));
  }
  return files;
}

// Returns {openai: {value, source}|null, stability: {...}|null} without
// touching the stored record. env first, then .env files in path order; the
// first non-empty value per provider wins.
function detect(opts) {
  const o = opts || {};
  const env = o.env || process.env;
  const found = { openrouter: null, openai: null };
  for (const p of PROVIDERS) {
    for (const name of ENV_NAMES[p]) {
      if (typeof env[name] === 'string' && env[name].trim()) {
        found[p] = { value: env[name].trim(), source: `detected:env:${name}` };
        break;
      }
    }
  }
  if (PROVIDERS.every((p) => found[p])) return found;
  const files = o.files || dotenvCandidates(o.homeDir);
  for (const f of files) {
    let parsed;
    try {
      parsed = parseDotenv(fs.readFileSync(f, 'utf8'));
    } catch (err) {
      continue;
    }
    for (const p of PROVIDERS) {
      if (found[p]) continue;
      for (const name of ENV_NAMES[p]) {
        if (typeof parsed[name] === 'string' && parsed[name].trim()) {
          found[p] = { value: parsed[name].trim(), source: `detected:${f.replace(/\\/g, '/')}` };
          break;
        }
      }
    }
    if (PROVIDERS.every((p) => found[p])) break;
  }
  return found;
}

// Fill EMPTY slots from detection and persist. Returns the list of
// providers that were filled. Never overwrites a key already stored.
function autofill(opts) {
  const rec = load();
  const found = detect(opts);
  const filled = [];
  for (const p of PROVIDERS) {
    if (!rec[p] && found[p]) {
      set(rec, p, found[p].value, found[p].source);
      filled.push(p);
    }
  }
  if (filled.length) save(rec);
  return { filled, record: rec };
}

module.exports = {
  PROVIDERS,
  ENV_NAMES,
  keysFile,
  load,
  save,
  set,
  mask,
  summary,
  cycleEnvVars,
  parseDotenv,
  dotenvCandidates,
  detect,
  autofill,
};
