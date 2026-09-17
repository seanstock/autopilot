'use strict';

// Codex (ChatGPT plan) usage meter, 2026-09-17. Zero npm dependencies.
//
// The Anthropic meter (src/budget.js) reads an HTTP endpoint with the
// stored OAuth token. Codex has no equivalent endpoint that Autopilot can
// call itself, but the CLI's own app server will answer on its behalf:
//
//   codex app-server --stdio
//   > {"method":"initialize","id":1,"params":{"clientInfo":{...}}}
//   > {"method":"initialized"}
//   > {"method":"account/rateLimits/read","id":2}
//   < {"id":2,"result":{"rateLimits":{"primary":{usedPercent,windowDurationMins,resetsAt},
//                                       "secondary":{...}},"planType":"..."}}
//
// Newline-delimited JSON, no "jsonrpc" field, ids matched by hand. Codex
// owns the auth (it uses its ChatGPT login), so no key ever passes through
// here. primary/secondary are whatever windows the plan has (observed live
// 2026-09-17 on a Pro plan: primary = the weekly window, secondary null;
// windowDurationMins says which is which), resetsAt is Unix seconds,
// planType sits inside rateLimits, and rateLimitReachedType /
// spendControlReached flag a hard stop. Field names can drift with CLI
// versions - parsed defensively, an unreadable answer is an outage, never
// a throw.
//
// Policy mirrors the Anthropic meter: over the shared ceilingPct on any
// window means the codex engine does not launch until the earliest reset.
// Outage (codex missing, signed out, app server too old) means "no
// opinion": the scheduler then relies on the usage-limit latch alone, which
// is exactly the pre-meter behaviour.

const { spawn, execFile } = require('child_process');

const util = require('./util');
const engines = require('./engines');

// On Windows the CLI runs behind `cmd /c codex` (an npm .cmd shim); killing
// cmd alone orphans the app server underneath it, and orphans pile up one
// per read. taskkill /T takes the whole tree. Best-effort, async.
function killTree(child) {
  if (!child) return;
  if (process.platform === 'win32' && child.pid != null) {
    try {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } catch (err) {
      // fall through to a plain kill
    }
  }
  try { if (typeof child.kill === 'function') child.kill(); } catch (err) { /* already gone */ }
}

const DEFAULT_MIN_INTERVAL_MS = 60 * 1000;
const DEFAULT_TIMEOUT_MS = 20 * 1000;
const DEFAULT_CACHE_TRUST_MS = 15 * 60 * 1000;
const HANDSHAKE_SETTLE_MS = 500; // calling rateLimits too soon after initialize returns empty data

const CLIENT_INFO = { name: 'autopilot', title: 'Autopilot', version: '0.3.0' };

// Human window name from its length: 300 -> "5h", 10080 -> "week".
function windowName(mins) {
  const m = Number(mins);
  if (!Number.isFinite(m) || m <= 0) return 'window';
  if (m % 10080 === 0) return m === 10080 ? 'week' : `${m / 10080}w`;
  if (m % 1440 === 0) return m === 1440 ? 'day' : `${m / 1440}d`;
  if (m % 60 === 0) return `${m / 60}h`;
  return `${m}m`;
}

// Pure: the app server's `result` object -> Autopilot windows, or null when
// nothing usable is in it. Window shape matches budget.js so the scheduler
// and UI treat both meters alike: {name, pct, resetsAt (ISO|null)}.
function parseRateLimits(result) {
  if (!result || typeof result !== 'object') return null;
  const rl = result.rateLimits;
  if (!rl || typeof rl !== 'object') return null;
  const windows = [];
  for (const key of ['primary', 'secondary']) {
    const w = rl[key];
    if (!w || typeof w !== 'object') continue;
    const pct = Number(w.usedPercent);
    if (!Number.isFinite(pct)) continue;
    const resetsRaw = Number(w.resetsAt);
    const resetsAt = Number.isFinite(resetsRaw) && resetsRaw > 0
      ? new Date(resetsRaw < 1e12 ? resetsRaw * 1000 : resetsRaw).toISOString()
      : null;
    windows.push({ name: `codex ${windowName(w.windowDurationMins)}`, pct: Math.max(0, Math.min(100, pct)), resetsAt });
  }
  if (!windows.length) return null;
  // The plan says it is out regardless of the percentages: treat every
  // window as full so the ceiling policy sleeps until the earliest reset.
  const limitReached = !!(rl.rateLimitReachedType || rl.spendControlReached);
  if (limitReached) for (const w of windows) w.pct = 100;
  const planType = typeof rl.planType === 'string' ? rl.planType : typeof result.planType === 'string' ? result.planType : null;
  return { windows, planType, limitReached };
}

// Spawn the app server, run the handshake, read one rate-limit answer,
// kill it. Resolves parseRateLimits(...) or null; never rejects.
function readRateLimits(opts) {
  const o = opts || {};
  const spawnImpl = o.spawnImpl || spawn;
  const timeoutMs = o.timeoutMs != null ? o.timeoutMs : DEFAULT_TIMEOUT_MS;
  const settleMs = o.settleMs != null ? o.settleMs : HANDSHAKE_SETTLE_MS;
  const cmd = engines.command('codex');

  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    let timer = null;
    let settleTimer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (settleTimer) clearTimeout(settleTimer);
      // Close stdin first (the app server exits on EOF), then take the tree.
      try { if (child && child.stdin) child.stdin.end(); } catch (err) { /* ignore */ }
      killTree(child);
      resolve(value);
    };

    try {
      child = spawnImpl(cmd[0], cmd.slice(1).concat(['app-server', '--stdio']), {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
        env: engines.cycleEnv(),
      });
    } catch (err) {
      finish(null);
      return;
    }
    if (!child || !child.stdout || !child.stdin) {
      finish(null);
      return;
    }

    // Not unref'd: a pending read is bounded by timeoutMs and must keep the
    // loop alive until it settles (a fake child in tests has no process).
    timer = setTimeout(() => finish(null), timeoutMs);

    // A closed pipe surfaces as an 'error' on stdin; without a listener it
    // would be an uncaught exception in the daemon.
    child.stdin.on('error', () => finish(null));

    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let idx = buf.indexOf('\n');
      while (idx !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        idx = buf.indexOf('\n');
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch (err) { continue; }
        if (!msg || typeof msg !== 'object') continue;
        if (msg.id === 2) {
          if (msg.error || !msg.result) finish(null);
          else finish(parseRateLimits(msg.result));
        }
      }
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));

    const write = (obj) => {
      try { child.stdin.write(`${JSON.stringify(obj)}\n`); } catch (err) { finish(null); }
    };
    write({ method: 'initialize', id: 1, params: { clientInfo: CLIENT_INFO } });
    write({ method: 'initialized' });
    settleTimer = setTimeout(() => write({ method: 'account/rateLimits/read', id: 2, params: {} }), settleMs);
  });
}

class CodexMeter {
  constructor(options) {
    const o = options || {};
    this.settings = o.settings || { ceilingPct: 75 };
    this.readImpl = o.readImpl || readRateLimits;
    this.minIntervalMs = o.minIntervalMs != null ? o.minIntervalMs : DEFAULT_MIN_INTERVAL_MS;
    this.cacheTrustMs = o.cacheTrustMs != null ? o.cacheTrustMs : DEFAULT_CACHE_TRUST_MS;
    this._lastAttemptAt = 0;
    this._lastResult = null; // {windows, planType}
    this._lastResultAt = 0;
    this._inFlight = null;
  }

  _ceiling() {
    return this.settings && typeof this.settings.ceilingPct === 'number' ? this.settings.ceilingPct : 75;
  }

  _fromWindows(windows, checkedIso, planType) {
    const ceiling = this._ceiling();
    const over = windows.filter((w) => w.pct >= ceiling);
    const resets = over.map((w) => w.resetsAt).filter(Boolean).map((s) => Date.parse(s)).filter((n) => !Number.isNaN(n));
    return {
      ok: over.length === 0,
      reason: over.length ? 'ceiling' : null,
      windows,
      resetsAt: resets.length ? new Date(Math.min(...resets)).toISOString() : null,
      planType: planType || null,
      checkedIso,
    };
  }

  _outage(checkedIso) {
    // A recent good reading keeps answering while the app server is flaky;
    // otherwise "outage" = no opinion (the scheduler falls back to the latch).
    if (this._lastResult && Date.now() - this._lastResultAt < this.cacheTrustMs) {
      return this._fromWindows(this._lastResult.windows, checkedIso, this._lastResult.planType);
    }
    return { ok: true, reason: 'outage', windows: [], resetsAt: null, planType: null, checkedIso };
  }

  // enabled=false: skip the (process-spawning) read entirely and report
  // outage - used when no codex project exists and codex is not signed in.
  // AUTOPILOT_CODEX_METER_OVERRIDE=off does the same unconditionally: the
  // test suites set it so a scheduler under test never spawns the real
  // app server (same convention as AUTOPILOT_HOME_OVERRIDE).
  async check(enabled) {
    const checkedIso = util.nowIso();
    if (enabled === false || process.env.AUTOPILOT_CODEX_METER_OVERRIDE === 'off') return this._outage(checkedIso);
    const now = Date.now();
    if (this._lastAttemptAt && now - this._lastAttemptAt < this.minIntervalMs) {
      return this._lastResult ? this._fromWindows(this._lastResult.windows, checkedIso, this._lastResult.planType) : this._outage(checkedIso);
    }
    this._lastAttemptAt = now;
    if (!this._inFlight) {
      this._inFlight = Promise.resolve()
        .then(() => this.readImpl())
        .catch(() => null)
        .then((r) => { this._inFlight = null; return r; });
    }
    const read = await this._inFlight;
    if (!read || !read.windows || !read.windows.length) return this._outage(checkedIso);
    this._lastResult = read;
    this._lastResultAt = Date.now();
    return this._fromWindows(read.windows, checkedIso, read.planType);
  }
}

module.exports = { CodexMeter, readRateLimits, parseRateLimits, windowName, CLIENT_INFO };
