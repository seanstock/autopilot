'use strict';

// Budget manager: account-wide usage meter, ceiling policy, fatal latch.
// Zero npm dependencies, Node built-ins only, CommonJS.
//
// The credentials file is READ-ONLY here, always. This module never opens
// it for writing and never refreshes tokens (SPEC.md section 3): refresh
// tokens are single-use, and the interactive CLI rotates them on its own
// schedule. Autopilot only ever reads it to lift out an access token.

const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const util = require('./util');
const state = require('./state');

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const ANTHROPIC_BETA_HEADER = 'oauth-2025-04-20';

const DEFAULT_MIN_INTERVAL_MS = 60 * 1000; // SPEC: min 60s between real calls
const DEFAULT_BACKOFF_BASE_MS = 60 * 1000; // 60s -> 120s -> 240s ...
const DEFAULT_BACKOFF_CAP_MS = 15 * 60 * 1000; // capped at 15 min
const DEFAULT_FORCED_FALLBACK_MS = 15 * 60 * 1000; // poll cadence while sleeping

function defaultCredPath() {
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

// Normalize a reported utilization value to a 0-100 percentage.
//
// The endpoint is undocumented and gives no type tag distinguishing a
// fraction (0-1) from an already-scaled percentage (0-100). Heuristic used
// here: any value <= 1 is treated as a fraction and multiplied by 100;
// anything above 1 is assumed already a percentage and passed through.
//
// Documented, accepted edge case: a genuine "1%" utilization reported as the
// bare integer 1 is indistinguishable from a fractional 1.0 (100%) under
// this rule and resolves as 100. We pick this direction deliberately: it is
// far more consequential to under-report near-exhausted usage (silently
// treating a real 100% as 1%) than to occasionally over-report a true 1% as
// 100% for one poll (the ceiling policy fails toward stopping scheduling,
// which is the safe direction to be wrong in).
function normalizePct(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (!Number.isFinite(n)) return null;
  if (n <= 1) return n * 100;
  return n;
}

// Recursively search a parsed credentials JSON structure for any key named
// `accessToken` carrying a non-empty string. Defensive: the real shape is
// `{ claudeAiOauth: { accessToken, refreshToken, ... } }` but we do not rely
// on that nesting in case the CLI's on-disk format changes.
function findAccessToken(obj, depth) {
  if (depth > 8 || !obj || typeof obj !== 'object') return null;
  if (typeof obj.accessToken === 'string' && obj.accessToken.length > 0) {
    return obj.accessToken;
  }
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object') {
      const found = findAccessToken(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// Read (never write) the credentials file and pull out an access token.
// Any failure (missing file, bad JSON, no token present) resolves to null,
// which the caller treats as an outage, never a thrown error.
function readAccessToken(credPath) {
  let raw;
  try {
    raw = fs.readFileSync(credPath, 'utf8');
  } catch (err) {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return null;
  }
  return findAccessToken(parsed, 0);
}

// Defensively pull usage windows out of the endpoint's response. The
// endpoint is undocumented and hostile (schema may change): we scan the
// top-level entries of the response object and accept any entry whose value
// is itself an object carrying a `utilization` field. Entries that don't
// parse to a finite number are skipped rather than thrown on. `resets_at`
// is optional per-window; missing/unparseable resolves to null.
function extractWindows(data) {
  const windows = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return windows;
  for (const [name, value] of Object.entries(data)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (!('utilization' in value)) continue;
    const pct = normalizePct(value.utilization);
    if (pct === null) continue;
    const resetsRaw = value.resets_at || value.reset_at || value.resetsAt || null;
    windows.push({ name, pct, resetsAt: typeof resetsRaw === 'string' ? resetsRaw : null });
  }
  return windows;
}

// Earliest parseable resets_at among the given windows, as an ISO string,
// or null if none parse.
function earliestResetsAt(windows) {
  const times = windows
    .map((w) => w.resetsAt)
    .filter(Boolean)
    .map((s) => Date.parse(s))
    .filter((n) => !Number.isNaN(n));
  if (times.length === 0) return null;
  return new Date(Math.min(...times)).toISOString();
}

class BudgetManager {
  constructor(options) {
    const opts = options || {};
    this.settings = opts.settings || { ceilingPct: 75 };
    this.fetchImpl = opts.fetchImpl || fetch;
    this.credPath = opts.credPath || defaultCredPath();

    // Test-only, documented extensions: real callers never need to touch
    // these, but injecting small values lets tests exercise the rate-limit
    // and backoff logic without sleeping for real minutes.
    this.minIntervalMs = opts.minIntervalMs != null ? opts.minIntervalMs : DEFAULT_MIN_INTERVAL_MS;
    this.backoffBaseMs = opts.backoffBaseMs != null ? opts.backoffBaseMs : DEFAULT_BACKOFF_BASE_MS;
    this.backoffCapMs = opts.backoffCapMs != null ? opts.backoffCapMs : DEFAULT_BACKOFF_CAP_MS;

    this._lastAttemptAt = 0; // ms epoch of last real network attempt
    this._lastResult = null; // { windows, resetsAt }
    this._lastResultAt = 0; // ms epoch of the last SUCCESSFUL meter read
    // How long a good reading stays trustworthy when the meter is failing.
    this.cacheTrustMs = opts.cacheTrustMs != null ? opts.cacheTrustMs : 15 * 60 * 1000;
    this._backoffMs = 0; // current backoff duration, 0 = no backoff active
    this._backoffUntil = 0; // ms epoch until which we must not call the endpoint
    this._forcedUntilResetsAt = null; // set by noteUsageLimitExit()
  }

  overCeiling(windows) {
    const ceiling = this.settings && typeof this.settings.ceilingPct === 'number' ? this.settings.ceilingPct : 75;
    return (windows || []).some((w) => w.pct >= ceiling);
  }

  isFatal() {
    return state.readFatal() !== null;
  }

  clearFatal() {
    state.clearFatal();
  }

  // Tripwire only, not a boundary (SPEC.md section 3 / 5 honesty clause):
  // the real defense is the env strip in the runner. This just catches a
  // cooperative-but-confused cycle quoting the phrase back at us.
  scanForTripwire(text) {
    if (typeof text !== 'string') return false;
    if (/credit balance/i.test(text)) {
      state.writeFatal('credit_balance_tripwire');
      return true;
    }
    return false;
  }

  // A cycle that exits usage_limit already proved the account is over
  // ceiling; flip the manager immediately rather than waiting for the next
  // 60s-gated poll to (eventually) learn the same thing.
  noteUsageLimitExit() {
    const fallback = this._lastResult && this._lastResult.resetsAt;
    this._forcedUntilResetsAt = fallback || new Date(Date.now() + DEFAULT_FORCED_FALLBACK_MS).toISOString();
  }

  _resultFromCache(checkedIso) {
    if (!this._lastResult) {
      return { ok: false, reason: 'outage', windows: [], resetsAt: null, checkedIso };
    }
    const { windows } = this._lastResult;
    const over = this.overCeiling(windows);
    return {
      ok: !over,
      reason: over ? 'ceiling' : null,
      windows,
      resetsAt: over ? earliestResetsAt(windows.filter((w) => this.overCeiling([w]))) : null,
      checkedIso,
    };
  }

  _outageResult(checkedIso) {
    // A failed poll must not contradict what a recent good reading proved
    // - the alternative flaps. Observed live, twice, 2026-07-23:
    //  (a) cached OVER-ceiling + failed poll reported 'outage' -> the
    //      scheduler's probe gate "rescued" the budget (a probe only
    //      proves the service answers; claude runs fine at 90%
    //      utilization) -> sleep -> grace -> sleep every backoff window;
    //  (b) cached UNDER-ceiling + failed poll reported 'outage' -> sleep,
    //      while the very next tick served the ok cache -> not-ok -> ok
    //      transition, ONE TOAST PER BACKOFF WINDOW for 3.5 hours, and the
    //      queued toasts beeped through Action Center for hours after.
    // Rule: a good reading younger than cacheTrustMs answers for the dead
    // meter verbatim; an over-ceiling reading additionally answers until
    // its resets_at passes regardless of age (budget cannot ungrow).
    // 'outage' is reserved for genuinely knowing nothing.
    if (this._lastResult) {
      const windows = this._lastResult.windows;
      if (this.overCeiling(windows)) {
        // Over-ceiling answers until its resets_at passes, regardless of
        // age (budget cannot ungrow within a window). Once the reset has
        // passed, the reading can no longer answer - fall to outage.
        const resetsAt = earliestResetsAt(windows.filter((w) => this.overCeiling([w])));
        if (resetsAt && Date.parse(resetsAt) > Date.now()) {
          return { ok: false, reason: 'ceiling', windows, resetsAt, checkedIso };
        }
      } else if (Date.now() - this._lastResultAt < this.cacheTrustMs) {
        // A fresh under-ceiling reading answers verbatim for a dead meter.
        return this._resultFromCache(checkedIso);
      }
    }
    return {
      ok: false,
      reason: 'outage',
      windows: this._lastResult ? this._lastResult.windows : [],
      resetsAt: null,
      checkedIso,
    };
  }

  async check() {
    const checkedIso = util.nowIso();

    if (this.isFatal()) {
      return {
        ok: false,
        reason: 'fatal',
        windows: this._lastResult ? this._lastResult.windows : [],
        resetsAt: null,
        checkedIso,
      };
    }

    const now = Date.now();

    // Forced over-ceiling from a usage_limit cycle exit, effective
    // immediately, no network call required.
    if (this._forcedUntilResetsAt) {
      const resetsMs = Date.parse(this._forcedUntilResetsAt);
      if (!Number.isNaN(resetsMs) && now < resetsMs) {
        return {
          ok: false,
          reason: 'ceiling',
          windows: this._lastResult ? this._lastResult.windows : [],
          resetsAt: this._forcedUntilResetsAt,
          checkedIso,
        };
      }
      // resets_at has passed (or was unparsable): release the force and
      // fall through to attempt a fresh real poll.
      this._forcedUntilResetsAt = null;
    }

    // Exponential backoff window from a prior 429.
    if (this._backoffUntil && now < this._backoffUntil) {
      return this._resultFromCache(checkedIso);
    }

    // Minimum interval between real endpoint calls.
    if (this._lastAttemptAt && now - this._lastAttemptAt < this.minIntervalMs) {
      return this._resultFromCache(checkedIso);
    }

    this._lastAttemptAt = now;

    const token = readAccessToken(this.credPath);
    if (!token) {
      // Missing/unreadable credentials: meter unavailable, fall to probe
      // gate (handled by the scheduler). On 401/expired the interactive CLI
      // (or a probe) will refresh the file for us; we never touch it.
      return this._outageResult(checkedIso);
    }

    let resp;
    try {
      resp = await this.fetchImpl(USAGE_URL, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'anthropic-beta': ANTHROPIC_BETA_HEADER,
        },
      });
    } catch (err) {
      return this._outageResult(checkedIso);
    }

    if (resp && resp.status === 429) {
      this._backoffMs = this._backoffMs ? Math.min(this._backoffMs * 2, this.backoffCapMs) : this.backoffBaseMs;
      this._backoffUntil = now + this._backoffMs;
      return this._outageResult(checkedIso);
    }

    if (!resp || resp.status === 401 || resp.status < 200 || resp.status >= 300) {
      return this._outageResult(checkedIso);
    }

    // Success: any backoff in effect is over.
    this._backoffMs = 0;
    this._backoffUntil = 0;

    let data;
    try {
      data = await resp.json();
    } catch (err) {
      return this._outageResult(checkedIso);
    }

    const windows = extractWindows(data);

    // I8 fix: a 2xx response that parses to zero recognizable windows means
    // the (explicitly hostile, schema-may-change) endpoint's shape drifted
    // out from under extractWindows() - not that usage is magically zero.
    // Treating that as ok:true would silently drop ceiling protection the
    // moment the schema changes. Fail closed instead: report an outage so
    // the scheduler falls to the probe gate, the designed degraded mode.
    if (windows.length === 0) {
      return this._outageResult(checkedIso);
    }

    this._lastResult = { windows, resetsAt: earliestResetsAt(windows) };
    this._lastResultAt = Date.now();

    const overWindows = windows.filter((w) => this.overCeiling([w]));
    const over = overWindows.length > 0;
    return {
      ok: !over,
      reason: over ? 'ceiling' : null,
      windows,
      resetsAt: over ? earliestResetsAt(overWindows) : null,
      checkedIso,
    };
  }

  // Minimal probe: `claude -p "OK"` with a short model and stripped env,
  // used by the scheduler when the meter itself is in outage. Never throws;
  // resolves { ok:false } on any spawn error, non-zero exit, or timeout.
  async probeGate(spawnImpl) {
    const spawnFn = spawnImpl || childProcess.spawn;
    const env = Object.assign({}, process.env);
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;

    return new Promise((resolve) => {
      let settled = false;
      let child;
      try {
        child = spawnFn('claude', ['-p', 'OK', '--model', 'claude-haiku-4-5-20251001'], {
          windowsHide: true,
          env,
        });
      } catch (err) {
        resolve({ ok: false });
        return;
      }

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill();
        } catch (err) {
          // best effort
        }
        resolve({ ok: false });
      }, 2 * 60 * 1000);
      if (timer.unref) timer.unref();

      child.on('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false });
      });

      child.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: code === 0 });
      });
    });
  }
}

module.exports = {
  BudgetManager,
  normalizePct,
  extractWindows,
  earliestResetsAt,
  findAccessToken,
};
