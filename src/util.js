'use strict';

// Foundation module: paths, atomic writes, time, logging.
// Zero npm dependencies, Node built-ins only, CommonJS.

const fs = require('fs');
const os = require('os');
const path = require('path');

// AUTOPILOT_HOME is resolved lazily (as a getter, see module.exports below)
// so that tests can point it at a temp directory per-test via the
// AUTOPILOT_HOME_OVERRIDE env var without ever touching the real
// ~/.autopilot. Consumers must access it as `util.AUTOPILOT_HOME`
// (property access) rather than destructuring it at require-time, or the
// override will not take effect.
function resolveAutopilotHome() {
  return process.env.AUTOPILOT_HOME_OVERRIDE || path.join(os.homedir(), '.autopilot');
}

// ISO 8601 with local UTC offset, e.g. 2026-07-23T07:45:53-07:00
function nowIso() {
  const d = new Date();
  const pad2 = (n) => String(n).padStart(2, '0');

  const year = d.getFullYear();
  const month = pad2(d.getMonth() + 1);
  const day = pad2(d.getDate());
  const hours = pad2(d.getHours());
  const minutes = pad2(d.getMinutes());
  const seconds = pad2(d.getSeconds());

  const offsetMinutesTotal = -d.getTimezoneOffset(); // getTimezoneOffset is UTC-local, invert
  const sign = offsetMinutesTotal >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutesTotal);
  const offsetHours = pad2(Math.floor(absOffset / 60));
  const offsetMinutes = pad2(absOffset % 60);

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offsetHours}:${offsetMinutes}`;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Atomic write: write to a uniquely-named temp file in the same directory,
// then rename over the destination. Rename is atomic on both NTFS and
// POSIX filesystems, so readers never observe a partially-written file.
function atomicWrite(file, str) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  fs.writeFileSync(tmp, str);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return fallback;
  }
}

function writeJson(file, obj) {
  atomicWrite(file, JSON.stringify(obj, null, 2));
}

function log(...args) {
  const rendered = args
    .map((a) => (typeof a === 'string' ? a : safeStringify(a)))
    .join(' ');
  process.stderr.write(`[${nowIso()}] ${rendered}\n`);
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch (err) {
    return String(value);
  }
}

function projectMeta(dir) {
  return path.join(dir, '.autopilot');
}

// Valid `claude --effort` reasoning levels (code.claude.com/docs/en/
// model-config). Shared here so state (config validation) and runner
// (spawn-arg guard) cannot drift out of agreement.
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

module.exports = {
  get AUTOPILOT_HOME() {
    return resolveAutopilotHome();
  },
  nowIso,
  ensureDir,
  atomicWrite,
  readJson,
  writeJson,
  log,
  projectMeta,
  EFFORT_LEVELS,
};
