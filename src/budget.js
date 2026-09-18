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
  // The endpoint reports percentages (a 42% week arrives as 42), but has
  // historically also sent fractions, so a genuinely fractional value is still
  // scaled. The boundary must be STRICT: `<= 1` mapped a real 1% window to
  // 100% and halted the loop at the exact moment it had the most headroom.
  // Observed live: UI said 1% used, the meter reported 100%, cycles stopped.
  if (n < 1) return n * 100;
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

// macOS: Claude Code keeps its OAuth credentials in the login Keychain, not
// in ~/.claude/.credentials.json, so the file read above finds nothing there
// and the meter would sit in permanent "outage" (probe-gate mode, no ceiling
// protection) on every Mac. The Keychain item is a generic password whose
// secret is the same JSON blob the file holds elsewhere; `security` prints it
// with -w. Read-only, like the file path: this never adds, updates or deletes
// the item. Any failure (not darwin, item absent, user denied the keychain
// prompt, bad JSON) is null, same contract as readAccessToken.
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

function readKeychainToken(execImpl, platform) {
  if ((platform || process.platform) !== 'darwin') return null;
  const exec = execImpl || childProcess.execFileSync;
  let raw;
  try {
    raw = exec('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    });
  } catch (err) {
    return null;
  }
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
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
// Display labels for the windows the endpoint is known to send. `name` stays
// the raw key (the scheduler, events and tests key on it); `label` is what
// the UI shows, matching the codex meter's "codex week" wording.
const WINDOW_LABELS = { five_hour: 'claude 5h', seven_day: 'claude week' };

function windowLabel(key) {
  return WINDOW_LABELS[key] || `claude ${String(key).replace(/_/g, ' ')}`;
}

function extractWindows(data) {
  const windows = [];
  if (!data || typeof data !== 'object' || Array.isArray(data)) return windows;
  for (const [name, value] of Object.entries(data)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    if (!('utilization' in value)) continue;
    const pct = normalizePct(value.utilization);
    if (pct === null) continue;
    const resetsRaw = value.resets_at || value.reset_at || value.resetsAt || null;
    const resetsAt = typeof resetsRaw === 'string' ? resetsRaw : null;
    // The endpoint also carries a row of codename-keyed experiment slots
    // (nimbus_quill, tangelo, cinder_cove, ...; observed 2026-09-18), almost
    // all null and the odd one reading 0% with no reset. A real window
    // always has a reset time or a non-zero reading; a codename with
    // neither is noise, not a budget, and would only clutter the gauges.
    if (!(name in WINDOW_LABELS) && pct === 0 && !resetsAt) continue;
    windows.push({ name, label: windowLabel(name), pct, resetsAt });
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
    // Test-only: the platform and the `security` exec used by the macOS
    // Keychain fallback, so the darwin path is exercised from any host.
    this.platform = opts.platform || process.platform;
    this.execImpl = opts.execImpl || null;

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
    // How often a forced over-ceiling latch is re-verified against the real
    // meter. Without this the latch is trusted blind until its resets_at,
    // which can idle the loop for hours after the window has already rolled
    // over (observed: five_hour back to 1% at 17:05, latch held until 22:00).
    this.forcedRecheckMs = opts.forcedRecheckMs != null ? opts.forcedRecheckMs : 5 * 60 * 1000;
    this._forcedCheckedAt = 0; // ms epoch of the last forced-latch verification
    // Non-Anthropic engines have no meter: a usage-limit exit sleeps that
    // engine for this long, then the next cycle is the re-check (see
    // noteUsageLimitExit). codexRetryMs is the pre-openrouter name.
    this.engineRetryMs = opts.engineRetryMs != null ? opts.engineRetryMs
      : opts.codexRetryMs != null ? opts.codexRetryMs : 60 * 60 * 1000;
    this._engineLatchUntil = {}; // engine -> ms epoch
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
  //
  // engine (2026-09-15): 'claude' (default) latches the Anthropic meter as
  // before. Every other engine has no meter at all - nothing reports a
  // ChatGPT plan's utilization or an OpenRouter balance the way the
  // Anthropic endpoint does - so a usage-limit exit is the ONLY signal, and
  // it latches that engine for a fixed re-try window (engineRetryMs). When
  // it lapses the next cycle on that engine is the re-check: it either
  // works or exits usage_limit again within a minute or two, cheaply.
  noteUsageLimitExit(engine) {
    if (engine && engine !== 'claude') {
      this._engineLatchUntil[engine] = Date.now() + this.engineRetryMs;
      return;
    }
    const fallback = this._lastResult && this._lastResult.resetsAt;
    this._forcedUntilResetsAt = fallback || new Date(Date.now() + DEFAULT_FORCED_FALLBACK_MS).toISOString();
    // Start the re-verification clock now: the exit just proved we are over,
    // so there is nothing to learn from polling for another forcedRecheckMs.
    this._forcedCheckedAt = Date.now();
  }

  // Synchronous gate for engines that have no meter. Returns the same shape
  // as check() minus windows: {ok, reason, resetsAt}. Claude callers should
  // keep using check(); this exists so the scheduler can ask "may a codex /
  // openrouter cycle launch" without touching the Anthropic meter at all.
  engineOk(engine) {
    if (!engine || engine === 'claude') return { ok: true, reason: null, resetsAt: null };
    const until = this._engineLatchUntil[engine] || 0;
    if (until > Date.now()) {
      return { ok: false, reason: 'ceiling', resetsAt: new Date(until).toISOString() };
    }
    return { ok: true, reason: null, resetsAt: null };
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

  // detail: one plain sentence on WHY the meter has no reading this time
  // (rate limited, rejected token, network, unreadable shape). Surfaced in
  // the snapshot and the UI so an empty gauge row is never silent.
  _outageResult(checkedIso, detail) {
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
      detail: detail || null,
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
        // Answer from the latch, but re-verify against the real meter every
        // forcedRecheckMs. A usage_limit exit is evidence about the moment it
        // happened, not a promise about the next five hours: the window can
        // roll over early, and a transient limit can clear. Trusting the latch
        // blind until resets_at idles the loop long after the meter recovered.
        if (now - this._forcedCheckedAt < this.forcedRecheckMs) {
          return {
            ok: false,
            reason: 'ceiling',
            windows: this._lastResult ? this._lastResult.windows : [],
            resetsAt: this._forcedUntilResetsAt,
            checkedIso,
          };
        }
        // Due for verification: fall through to a real poll. The latch stays
        // set unless that poll comes back genuinely under ceiling (see below),
        // so a failed or over-ceiling poll changes nothing.
        this._forcedCheckedAt = now;
      } else {
        // resets_at has passed (or was unparsable): release the force and
        // fall through to attempt a fresh real poll.
        this._forcedUntilResetsAt = null;
      }
    }

    // Exponential backoff window from a prior 429.
    if (this._backoffUntil && now < this._backoffUntil) {
      const cached = this._resultFromCache(checkedIso);
      if (cached.reason === 'outage') cached.detail = `usage endpoint rate limited (429); next try ${new Date(this._backoffUntil).toISOString()}`;
      return cached;
    }

    // Minimum interval between real endpoint calls.
    if (this._lastAttemptAt && now - this._lastAttemptAt < this.minIntervalMs) {
      return this._resultFromCache(checkedIso);
    }

    this._lastAttemptAt = now;

    const token = readAccessToken(this.credPath) || readKeychainToken(this.execImpl, this.platform);
    if (!token) {
      // Missing/unreadable credentials: meter unavailable, fall to probe
      // gate (handled by the scheduler). On 401/expired the interactive CLI
      // (or a probe) will refresh the file for us; we never touch it.
      return this._outageResult(checkedIso, 'no Claude Code login token found (sign in on the Settings page)');
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
      return this._outageResult(checkedIso, `network: ${(err && err.message) || err}`);
    }

    if (resp && resp.status === 429) {
      this._backoffMs = this._backoffMs ? Math.min(this._backoffMs * 2, this.backoffCapMs) : this.backoffBaseMs;
      this._backoffUntil = now + this._backoffMs;
      return this._outageResult(checkedIso, `usage endpoint rate limited (429); next try ${new Date(this._backoffUntil).toISOString()}`);
    }

    if (!resp || resp.status === 401) {
      return this._outageResult(checkedIso, 'usage endpoint rejected the login token (401); sign in to Claude Code again');
    }
    if (resp.status < 200 || resp.status >= 300) {
      return this._outageResult(checkedIso, `usage endpoint answered HTTP ${resp.status}`);
    }

    // Success: any backoff in effect is over.
    this._backoffMs = 0;
    this._backoffUntil = 0;

    let data;
    try {
      data = await resp.json();
    } catch (err) {
      return this._outageResult(checkedIso, 'usage endpoint answered with unreadable JSON');
    }

    const windows = extractWindows(data);

    // I8 fix: a 2xx response that parses to zero recognizable windows means
    // the (explicitly hostile, schema-may-change) endpoint's shape drifted
    // out from under extractWindows() - not that usage is magically zero.
    // Treating that as ok:true would silently drop ceiling protection the
    // moment the schema changes. Fail closed instead: report an outage so
    // the scheduler falls to the probe gate, the designed degraded mode.
    if (windows.length === 0) {
      return this._outageResult(checkedIso, 'usage endpoint answered in an unrecognised shape (no utilization windows)');
    }

    this._lastResult = { windows, resetsAt: earliestResetsAt(windows) };
    this._lastResultAt = Date.now();

    const overWindows = windows.filter((w) => this.overCeiling([w]));
    const over = overWindows.length > 0;

    // A fresh reading is better evidence than the latch. If the meter now says
    // we are under ceiling, the window rolled over or the limit was transient:
    // release the latch instead of idling until its resets_at.
    if (!over && this._forcedUntilResetsAt) {
      this._forcedUntilResetsAt = null;
    }

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
      const cmd = util.claudeCommand();
      try {
        child = spawnFn(cmd[0], cmd.slice(1).concat(['-p', 'OK', '--model', 'claude-haiku-4-5-20251001']), {
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
  readAccessToken,
  readKeychainToken,
  KEYCHAIN_SERVICE,
};
