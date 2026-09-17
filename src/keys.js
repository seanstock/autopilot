'use strict';

// Provider API keys (2026-09-16): OpenAI and Stability AI.
// Zero npm dependencies, Node built-ins only, CommonJS.
//
// Stored in ~/.autopilot/keys.json, deliberately SEPARATE from projects.json
// so the registry can be copied, diffed and pasted into a chat without
// leaking a secret. Mode 0600 on POSIX (Windows ACLs already scope the home
// directory to the user).
//
// What the keys are for:
//   - injected into every cycle's environment (OPENAI_API_KEY,
//     STABILITY_API_KEY) so a project's own code and the image helper
//     (image.js) can call those APIs;
//   - a Codex cycle also gets CODEX_API_KEY from the OpenAI key when the
//     Codex CLI is NOT signed in to a ChatGPT account, so API billing is a
//     fallback, never a silent replacement for a subscription.
// Autopilot itself never sends a key anywhere except to those providers on
// the user's behalf through image.js.
//
// Detection: the daemon fills EMPTY slots once at startup, and the Settings
// page has a "Detect" button, from (in order) the daemon's own environment
// and any .env file within two directory levels of the home directory. A
// slot the user set by hand is never overwritten by detection.

const fs = require('fs');
const os = require('os');
const path = require('path');

const util = require('./util');

const KEYS_FILENAME = 'keys.json';
const PROVIDERS = ['openai', 'stability'];

// env var names recognised per provider, in priority order.
const ENV_NAMES = {
  openai: ['OPENAI_API_KEY'],
  stability: ['STABILITY_API_KEY', 'STABILITY_KEY', 'STABILITYAI_API_KEY'],
};

function keysFile() {
  return path.join(util.AUTOPILOT_HOME, KEYS_FILENAME);
}

function emptyRecord() {
  return { openai: null, stability: null, sources: {} };
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
  util.writeJson(file, { openai: rec.openai || null, stability: rec.stability || null, sources: rec.sources || {} });
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
// the (already stripped) cycle env. codexLoggedIn: when false and an OpenAI
// key exists, Codex gets it as CODEX_API_KEY (API-billed fallback).
function cycleEnvVars(rec, opts) {
  const o = opts || {};
  const vars = {};
  if (rec.openai) {
    vars.OPENAI_API_KEY = rec.openai;
    if (o.engine === 'codex' && o.codexLoggedIn === false) vars.CODEX_API_KEY = rec.openai;
  }
  if (rec.stability) vars.STABILITY_API_KEY = rec.stability;
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
  const found = { openai: null, stability: null };
  for (const p of PROVIDERS) {
    for (const name of ENV_NAMES[p]) {
      if (typeof env[name] === 'string' && env[name].trim()) {
        found[p] = { value: env[name].trim(), source: `detected:env:${name}` };
        break;
      }
    }
  }
  if (found.openai && found.stability) return found;
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
    if (found.openai && found.stability) break;
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
