'use strict';

// Scheduler: the daemon's main loop. Owns priorities, gates, budget-driven
// sleep, grace, and the cycle-slot invariant. Zero npm dependencies, Node
// built-ins only, CommonJS.
//
// Concurrency (2026-08-07, user directive): settings.concurrency (default
// 1, max 8) is the number of cycle slots. The tick loop launches cycles
// WITHOUT awaiting them, up to the slot count, and tracks them in
// this._running (projectId -> info) + this._cyclePromises. Two invariants
// survive from the original serial design: a given PROJECT never has two
// cycles in flight (its git repo and order queue are single-writer - the
// runnable computation excludes running projects), and every global gate
// (FATAL, pause, budget, grace) stops NEW launches only; in-flight cycles
// always finish under their own STOP/usage-limit handling, exactly as an
// in-flight cycle behaved under the serial loop. With concurrency 1 the
// behavior is byte-identical to the original one-cycle-at-a-time loop.
// The budget ceiling check runs per tick, so N concurrent cycles can
// overshoot the ceiling by up to N-1 cycles' spend before the next check
// bites - the default 75% ceiling headroom absorbs this; raising
// concurrency while running at a 95%+ ceiling is on the user.
//
// Precedence (docs/plans/2026-07-23-autopilot-build.md, Task 6): the FATAL
// latch is checked FIRST, before pause, before budget, before any
// per-project bookkeeping (cooldown, review gate). When fatal is latched
// everything idles regardless of per-project state.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const util = require('./util');
const state = require('./state');
const events = require('./events');
const runner = require('./runner');
const notifyModule = require('./notify');
const localmodel = require('./localmodel');
const enginesModule = require('./engines');
const keysModule = require('./keys');

const DAEMON_PID_FILENAME = 'daemon.pid';
const VERSION = '0.2.0';

// SPEC.md section 3: probe the meter-unavailable fallback at most every 15
// minutes; poll cadence while sleeping is every 15 minutes or resetsAt,
// whichever is sooner.
const PROBE_INTERVAL_MS = 15 * 60 * 1000;
const SLEEP_FALLBACK_MS = 15 * 60 * 1000;

// docs/plans Task 6: 3 crashes within 15 min -> project cooldown 15 min.
const CRASH_WINDOW_MS = 15 * 60 * 1000;
const CRASH_LIMIT = 3;
const COOLDOWN_MS = 15 * 60 * 1000;

// I2 fix: bounded window graceful shutdown gives an in-flight cycle to
// finish (via the runner's own STOP kill-path) before the daemon process
// exits, rather than orphaning an unmonitored claude child.
const SHUTDOWN_GRACE_MS = 30 * 1000;

// Minimum gap between two "Autopilot resuming" toasts. Transitions are
// still stamped as events every time; only the toast is debounced.
const NOTIFY_DEBOUNCE_MS = 30 * 60 * 1000;

// Consecutive worker dispatches of the same order before a grooming
// orchestrate cycle is forced (I1, v0.3 review: breaks the stuck-order
// livelock where a worker exits clean without advancing the status).
const STUCK_ORDER_LIMIT = 3;

function pidFilePath() {
  return path.join(util.AUTOPILOT_HOME, DAEMON_PID_FILENAME);
}

function stopFilePath(dir) {
  return path.join(util.projectMeta(dir), 'STOP');
}

function injectFilePath(dir) {
  return path.join(util.projectMeta(dir), 'INJECT.md');
}

// Compact "key=value, key=value" summary of a config patch for the
// human-readable ACTIVITY line. Values are model ids / effort levels /
// small numbers, never secrets.
function summarizePatch(patch) {
  if (!patch || typeof patch !== 'object') return '(none)';
  const parts = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    parts.push(`${k}=${v === '' || v === null ? '(cleared)' : v}`);
  }
  return parts.length ? parts.join(', ') : '(none)';
}

// Token/model/cost accounting. Durable running totals live in each
// project's runtime state.json (rotation-proof; events.jsonl is capped),
// accumulated per cycle_end and seeded once by backfill from whatever
// events.jsonl still holds. costUsd is the CLI-reported total_cost_usd,
// i.e. what the same work would have cost at API prices - the meter for
// "cost invested" on a subscription.
function emptyTotals() {
  return { in: 0, out: 0, costUsd: 0, cycles: 0, byModel: {} };
}

// When the runner captured a per-model breakdown (stream-json modelUsage,
// which includes subagent activity - e.g. a Fable orchestrate cycle whose
// sonnet scouts burned most of the tokens), attribute per actual model:
// one cycle overall, each participating model's bucket credited with its
// own tokens/cost and one cycle of participation. Falls back to
// single-model attribution when no breakdown exists.
function addCycleUsage(totals, effectiveModel, result) {
  const mu = result && result.modelUsage;
  if (mu && typeof mu === 'object' && Object.keys(mu).length) {
    totals.cycles += 1;
    for (const [model, u] of Object.entries(mu)) {
      const inTok = Number(u.in) || 0;
      const outTok = Number(u.out) || 0;
      const cost = Number(u.costUsd) || 0;
      totals.in += inTok;
      totals.out += outTok;
      totals.costUsd += cost;
      const m = totals.byModel[model] || (totals.byModel[model] = { in: 0, out: 0, costUsd: 0, cycles: 0 });
      m.in += inTok;
      m.out += outTok;
      m.costUsd += cost;
      m.cycles += 1;
    }
    return;
  }
  addCycleToTotals(totals, effectiveModel, result && result.tokens, result && result.costUsd);
}

function addCycleToTotals(totals, model, tokens, costUsd) {
  const t = tokens || {};
  const inTok = Number(t.in) || 0;
  const outTok = Number(t.out) || 0;
  const cost = Number(costUsd) || 0;
  totals.in += inTok;
  totals.out += outTok;
  totals.costUsd += cost;
  totals.cycles += 1;
  const key = model || 'unknown';
  const m = totals.byModel[key] || (totals.byModel[key] = { in: 0, out: 0, costUsd: 0, cycles: 0 });
  m.in += inTok;
  m.out += outTok;
  m.costUsd += cost;
  m.cycles += 1;
}

function reviewedFilePath(dir) {
  return path.join(util.projectMeta(dir), 'REVIEWED');
}

// ---- v0.3 orders/ (docs/plans/2026-07-24-goal-loop.md Shared contracts) ----
// Orders are disposable, model-written project files living in
// <project>/orders/*.md. Parsing rule everywhere: scan the first 10 lines
// for /^status:\s*(open|in_progress|done|blocked)\b/. Sort by filename
// (zero-padded NNN-slug.md keeps that lexical order == creation order).
const ORDER_STATUS_RE = /^status:\s*(open|in_progress|done|blocked)\b/;

function ordersDirPath(dir) {
  return path.join(dir, 'orders');
}

function parseOrderStatus(content) {
  const lines = String(content).split(/\r?\n/).slice(0, 10);
  for (const line of lines) {
    const m = ORDER_STATUS_RE.exec(line);
    if (m) return m[1];
  }
  return null;
}

// Malformed order files (no parseable status line in the first 10 lines)
// default to 'open' - matching the server's readOrders, so the scheduler
// and the UI never disagree about the same file. Fail-open into
// VISIBILITY: an order the planner wrote slightly off-format becomes
// assignable work the next worker (or orchestrator grooming pass) will
// see and normalize, instead of silently vanishing from both the queue
// and the snapshot counts.
function listOrders(dir) {
  let files;
  try {
    files = fs.readdirSync(ordersDirPath(dir)).filter((f) => /\.md$/i.test(f));
  } catch (err) {
    return [];
  }
  files.sort();
  const out = [];
  for (const f of files) {
    let content;
    try {
      content = fs.readFileSync(path.join(ordersDirPath(dir), f), 'utf8');
    } catch (err) {
      continue;
    }
    const status = parseOrderStatus(content) || 'open';
    out.push({ id: f.replace(/\.md$/i, ''), filename: f, status, content });
  }
  return out;
}

function findLowestOpenOrder(dir) {
  const orders = listOrders(dir);
  for (const o of orders) {
    if (o.status === 'open') return o;
  }
  return null;
}

function orderCounts(dir) {
  const counts = { open: 0, inProgress: 0, done: 0, blocked: 0 };
  for (const o of listOrders(dir)) {
    if (o.status === 'open') counts.open += 1;
    else if (o.status === 'in_progress') counts.inProgress += 1;
    else if (o.status === 'done') counts.done += 1;
    else if (o.status === 'blocked') counts.blocked += 1;
  }
  return counts;
}

// EPERM means a process with that pid exists but signal permission was
// denied (still alive); ESRCH (the default thrown error on most platforms
// for a nonexistent pid) means it is not.
function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

class Scheduler extends EventEmitter {
  constructor(opts) {
    super();
    const o = opts || {};
    this.stateObj = o.stateObj || { settings: {}, projects: [] };
    this.budget = o.budget;
    this.runCycleImpl = o.runCycleImpl || runner.runCycle;
    this.notifyImpl = o.notifyImpl || notifyModule.notify;
    // Availability of a locally-served model, surfaced in snapshot() so the UI
    // can offer it as a worker model only while it can actually be reached.
    // Injectable for tests; real callers get the shared cached probe.
    this.localModel = o.localModel || localmodel.shared();
    // Installed/signed-in state of each engine CLI, for the settings page.
    // Injectable for tests; real callers get the shared cached probe.
    this.engines = o.engines || enginesModule.shared();
    this.tickMs = o.tickMs != null ? o.tickMs : 5000;
    // Test-only, documented extension (same pattern as budget.js's
    // minIntervalMs/backoffBaseMs): lets I1 tests observe the sticky-probe
    // rescue crossing multiple probe intervals without waiting 15 real
    // minutes. Real callers never set this.
    this.probeIntervalMs = o.probeIntervalMs != null ? o.probeIntervalMs : PROBE_INTERVAL_MS;

    this.paused = false;
    this._orderAttempts = {}; // projectId -> {orderId, count} | null (I1)

    this._startedIso = null;
    this._started = false;
    this._stopped = true;
    this._timer = null;

    this._running = new Map(); // projectId -> {projectId, cycle, kind, startedIso}
    this._cyclePromises = new Set(); // in-flight _runOneCycle chains (launch wrappers)
    this._lastBudget = { ok: true, reason: null, checkedIso: null, windows: [] };
    this._budgetWasOk = null; // null = not yet observed, then true/false
    this._effectiveBudgetOk = true; // budget.check() ok, possibly rescued by probeGate
    this._inGrace = false;
    this._graceUntil = 0;
    this._currentSleepReason = null; // dedupe repeated sleep events
    this._lastProbeAt = 0;
    this._probeOkUntil = 0; // I1 fix: sticky probe-rescue window, see _tickOnce
    this._lastPickedId = null; // round-robin cursor among equal priorities
    this._lastCycleInfo = {}; // projectId -> {lastExit, lastCommit}
    this._lastSnapshotJson = null;
    this._currentTickPromise = null; // I2 fix: let stopDaemon() await the in-flight tick
  }

  // ---- lifecycle ---------------------------------------------------------

  start() {
    if (this._started) return;
    const pidFile = pidFilePath();
    const existing = util.readJson(pidFile, null);
    if (existing && existing.pid && existing.pid !== process.pid && isPidAlive(existing.pid)) {
      const err = new Error(`autopilot daemon already running (pid ${existing.pid})`);
      err.code = 'ALREADY_RUNNING';
      throw err;
    }

    util.ensureDir(util.AUTOPILOT_HOME);
    this._startedIso = util.nowIso();
    util.writeJson(pidFile, { pid: process.pid, startedIso: this._startedIso });

    this._started = true;
    this._stopped = false;
    this._scheduleTick(0);
  }

  // I2 fix: graceful shutdown must not orphan an in-flight cycle (the daemon
  // exiting does not kill the spawned claude tree on its own on Windows).
  // Rather than duplicating the runner's tree-kill/classify/auto-commit
  // logic here, this reuses the exact mechanism a hand-touched STOP file
  // already uses end-to-end: it creates the current project's
  // `.autopilot/STOP` (if not already present), waits for the in-flight
  // tick to actually finish (bounded to SHUTDOWN_GRACE_MS - the runner
  // polls for STOP and tree-kills, classifies 'stopped', the scheduler
  // stamps cycle_end and auto-commit already runs inside runCycle), then
  // removes the STOP file it created so the project resumes normally next
  // time the daemon starts.
  async stopDaemon() {
    this._stopped = true;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    await this._waitForInFlightCycle();

    try {
      const pidFile = pidFilePath();
      const existing = util.readJson(pidFile, null);
      if (existing && existing.pid === process.pid) {
        fs.unlinkSync(pidFile);
      }
    } catch (err) {
      // best effort - nothing to clean up if it's already gone
    }
  }

  // Concurrency-aware shutdown: every project with a cycle in flight gets a
  // STOP file (the runner's own kill-path), then we wait for ALL in-flight
  // cycle chains (plus any tick) up to the deadline. STOP files we created
  // are removed for projects whose cycles actually finished; a project whose
  // cycle is still alive at the deadline keeps its STOP (NEW-2, unchanged).
  async _waitForInFlightCycle() {
    if (!this._currentTickPromise && this._cyclePromises.size === 0) return;

    const deadline = Date.now() + SHUTDOWN_GRACE_MS;
    const stoppedDirs = new Set(); // dirs whose STOP file WE created

    while ((this._currentTickPromise || this._cyclePromises.size > 0) && Date.now() < deadline) {
      for (const info of this._running.values()) {
        const project = state.getProject(this.stateObj, info.projectId);
        if (!project || stoppedDirs.has(project.dir)) continue;
        try {
          util.ensureDir(util.projectMeta(project.dir));
          const stopPath = stopFilePath(project.dir);
          if (!fs.existsSync(stopPath)) {
            fs.writeFileSync(stopPath, '');
            stoppedDirs.add(project.dir);
          }
        } catch (err) {
          util.log('scheduler: shutdown STOP write failed for', project.id, String(err && err.message));
        }
      }

      const remaining = Math.max(0, deadline - Date.now());
      const pending = [...this._cyclePromises];
      if (this._currentTickPromise) pending.push(this._currentTickPromise);
      try {
        await Promise.race([Promise.all(pending), new Promise((resolve) => setTimeout(resolve, Math.min(200, remaining)))]);
      } catch (err) {
        // cycle chains and the tick promise never reject (both catch
        // internally); nothing to do either way.
      }
    }

    const stillRunningDirs = new Set();
    for (const info of this._running.values()) {
      const project = state.getProject(this.stateObj, info.projectId);
      if (project) stillRunningDirs.add(project.dir);
    }
    for (const dir of stoppedDirs) {
      if (stillRunningDirs.has(dir)) {
        // NEW-2: shutdown deadline hit with this cycle still in flight. The
        // STOP file is the last brake on that possibly-orphaned child (its
        // guard blocks every tool call while STOP exists), so leave it in
        // place; the human clears it by starting the project again.
        util.log('scheduler: shutdown timed out with a cycle still in flight; leaving STOP in place for', dir);
      } else {
        try {
          fs.unlinkSync(stopFilePath(dir));
        } catch (err) {
          // best effort - already gone, or never existed
        }
      }
    }
  }

  _scheduleTick(delayMs) {
    if (this._stopped) return;
    this._timer = setTimeout(() => {
      this._tick();
    }, delayMs);
    if (this._timer.unref) this._timer.unref();
  }

  async _tick() {
    if (this._stopped) return;
    this._currentTickPromise = this._tickOnce();
    try {
      await this._currentTickPromise;
    } catch (err) {
      util.log('scheduler: tick error', String((err && err.stack) || err));
    } finally {
      this._currentTickPromise = null;
    }
    this._scheduleTick(this.tickMs);
  }

  // ---- main loop ----------------------------------------------------------

  async _tickOnce() {
    // 1. FATAL latch, checked first, before anything else (see file header).
    const fatal = state.readFatal();
    if (fatal) {
      this._effectiveBudgetOk = false;
      this._emitStatusIfChanged();
      return;
    }

    // 2. Global pause.
    if (this.paused) {
      this._emitStatusIfChanged();
      return;
    }

    // 3. Budget check (ceiling / outage / recovery / grace).
    const budgetResult = await this.budget.check();
    this._lastBudget = budgetResult;

    let effectiveOk = budgetResult.ok;

    if (budgetResult.ok) {
      // Real recovery: any earlier probe-rescue window is stale now, clear
      // it so a later outage does not inherit a sticky "ok" from long ago.
      this._probeOkUntil = 0;
    } else if (budgetResult.reason === 'outage' && typeof this.budget.probeGate === 'function') {
      const now = Date.now();

      // I1 fix: a successful probe used to rescue only the single tick it
      // ran on - every tick in between probes (the overwhelming majority,
      // since probes are rate-limited to once per PROBE_INTERVAL_MS) saw
      // the still-down meter, reasserted not-ok, and flip-flopped
      // _budgetWasOk. That refired notify + grace_start on every probe
      // interval and meant graceMinutes (default 30, longer than the probe
      // interval) never got a single continuous "ok" window long enough to
      // actually elapse in - outage mode never ran a cycle. Fix: treat a
      // successful probe as sticky-ok for a full PROBE_INTERVAL_MS window,
      // and only refire the recovery/grace transition once, on entry into
      // that state (via the existing _budgetWasOk state machine below).
      if (now - this._lastProbeAt >= this.probeIntervalMs) {
        this._lastProbeAt = now;
        let probe;
        try {
          probe = await this.budget.probeGate();
        } catch (err) {
          probe = { ok: false };
        }
        this._probeOkUntil = probe && probe.ok ? now + this.probeIntervalMs : 0;
      }
      if (this._probeOkUntil && now < this._probeOkUntil) {
        effectiveOk = true;
      }
    }

    // The Anthropic meter, grace and recovery bookkeeping below gate CLAUDE
    // cycles only. A Codex project has no meter (src/budget.js engineOk):
    // it keeps running while the Anthropic windows are exhausted, and
    // sleeps on its own latch after a usage-limit exit of its own. With
    // only Claude projects registered the tick is byte-identical to before.
    let claudeOk = effectiveOk;

    if (!effectiveOk) {
      const reason = budgetResult.reason || 'outage';
      if (this._currentSleepReason !== reason) {
        const until = budgetResult.resetsAt || new Date(Date.now() + SLEEP_FALLBACK_MS).toISOString();
        this._appendGlobalEvent('sleep', { reason, until }, 'claude');
        this._currentSleepReason = reason;
      }
      this._budgetWasOk = false;
      this._effectiveBudgetOk = false;
      this._inGrace = false;
    } else {
      this._currentSleepReason = null;
      this._effectiveBudgetOk = true;

      // Transition not-ok -> ok: notify + grace_start + wait graceMinutes
      // before the first cycle. This is the budget-recovery grace only -
      // manual pauseAll()/resumeAll() never touch _budgetWasOk, so a manual
      // resume never incurs this wait (see pauseAll/resumeAll below).
      if (this._budgetWasOk === false) {
        this._budgetWasOk = true;
        const graceMinutes = (this.stateObj.settings && this.stateObj.settings.graceMinutes) || 0;
        // Toast debounce, belt-and-braces: the budget fix (see
        // budget._outageResult) removed the known flap sources, but a toast
        // storm is a miserable failure mode for the human (hundreds of
        // queued beeping notifications, observed live 2026-07-23), so the
        // recovery toast itself is also rate-limited. Events keep stamping
        // every transition - only the toast is suppressed.
        const now = Date.now();
        if (now - (this._lastRecoveryNotifyAt || 0) >= NOTIFY_DEBOUNCE_MS) {
          this._lastRecoveryNotifyAt = now;
          try {
            this.notifyImpl('Autopilot resuming', 'Usage budget is runnable again', this.stateObj.settings);
          } catch (err) {
            util.log('scheduler: notifyImpl threw', String(err && err.message));
          }
        }
        this._appendGlobalEvent('grace_start', { minutes: graceMinutes }, 'claude');
        this._graceUntil = Date.now() + graceMinutes * 60000;
        this._inGrace = graceMinutes > 0;
      } else if (this._budgetWasOk === null) {
        this._budgetWasOk = true; // initial state: not a recovery, no grace
      }

      if (this._graceUntil && Date.now() < this._graceUntil) {
        this._inGrace = true;
        claudeOk = false;
      } else {
        this._graceUntil = 0;
        this._inGrace = false;
      }
    }

    const gates = { claude: claudeOk, codex: this._engineGate('codex').ok };

    // 4/5. Fill free cycle slots. Launches are NOT awaited: each cycle
    // chain tracks itself in _running/_cyclePromises and the tick returns
    // as soon as the slots are full (or nothing is runnable). Runnable is
    // recomputed after each launch so a just-launched project is excluded.
    const slots = this._concurrency();
    while (this._running.size < slots) {
      const runnable = this._computeRunnable(gates);
      if (runnable.length === 0) break;

      const minPriority = Math.min(...runnable.map((r) => r.project.priority));
      const tier = runnable.filter((r) => r.project.priority === minPriority);
      const picked = this._pickFromTier(tier);
      this._lastPickedId = picked.project.id;
      this._launchCycle(picked.project, picked.runtime);
    }
    this._emitStatusIfChanged();
  }

  _concurrency() {
    const raw = Number(this.stateObj.settings && this.stateObj.settings.concurrency);
    if (!Number.isInteger(raw)) return 1;
    return Math.max(1, Math.min(8, raw));
  }

  // Fire-and-track a cycle chain. The chain itself (via _runOneCycle) owns
  // its _running entry; this wrapper only guards the scheduler loop against
  // a throw and maintains the promise set used by shutdown.
  _launchCycle(project, runtime) {
    const chain = this._runOneCycle(project, runtime)
      .catch((err) => {
        util.log('scheduler: cycle chain threw (contract violation)', String((err && err.stack) || err));
      })
      .finally(() => {
        this._cyclePromises.delete(chain);
        this._emitStatusIfChanged();
      });
    this._cyclePromises.add(chain);
  }

  // Per-engine launch gate, for engines that have no meter. Fake budgets in
  // older tests do not implement engineOk; treat that as "no gate".
  _engineGate(engine) {
    if (!this.budget || typeof this.budget.engineOk !== 'function') return { ok: true, reason: null, resetsAt: null };
    try {
      return this.budget.engineOk(engine) || { ok: true, reason: null, resetsAt: null };
    } catch (err) {
      return { ok: true, reason: null, resetsAt: null };
    }
  }

  // gates: {claude: bool, codex: bool} - which engines may launch this tick.
  // Absent (older callers/tests) means every engine may.
  _computeRunnable(gates) {
    const now = Date.now();
    const runnable = [];
    for (const project of this.stateObj.projects || []) {
      if (!project.enabled) continue;
      if (gates && gates[enginesModule.normalizeEngine(project.engine)] === false) continue;
      // A project never has two cycles in flight (single-writer git repo /
      // order queue); with concurrency > 1 other projects fill the slots.
      if (this._running.has(project.id)) continue;
      if (fs.existsSync(stopFilePath(project.dir))) continue;

      const runtime = state.readRuntime(project.dir);

      // Cycle cap (experiments spec 2026-08-07): runtime.cycle is the
      // persisted, crash-safe counter (only incremented after cycle_end),
      // so the cap can never over-run across restarts. At cap: disable the
      // project, stamp variant_complete once, and never dispatch again.
      if (project.maxCycles > 0 && runtime.cycle >= project.maxCycles) {
        if (project.enabled) {
          project.enabled = false;
          state.save(this.stateObj);
          try {
            events.appendEvent(project.dir, project.id, 'variant_complete', {
              cycles: runtime.cycle,
              maxCycles: project.maxCycles,
            });
            events.activity(project.dir, `cycle cap reached (${runtime.cycle}/${project.maxCycles}); variant complete`, 'daemon');
          } catch (err) {
            // best effort
          }
        }
        continue;
      }

      if (runtime.cooldownUntil && Date.parse(runtime.cooldownUntil) > now) continue;

      if (project.reviewGateCycles > 0 && runtime.sinceReview >= project.reviewGateCycles) {
        // Review gate: pauses at N until markReviewed() (server/CLI) or a
        // hand-touched REVIEWED file. Consume+delete it here so a project
        // left running with the daemon down still resumes on next tick.
        const reviewedPath = reviewedFilePath(project.dir);
        if (fs.existsSync(reviewedPath)) {
          try {
            fs.unlinkSync(reviewedPath);
          } catch (err) {
            // best effort
          }
          runtime.sinceReview = 0;
          state.writeRuntime(project.dir, runtime);
          try {
            events.appendEvent(project.dir, project.id, 'reviewed', {});
          } catch (err) {
            // best effort
          }
        } else {
          continue;
        }
      }

      runnable.push({ project, runtime });
    }
    return runnable;
  }

  // Round-robin among equal priorities: remembers the last picked project
  // id across ticks and advances to the next id in the current tier
  // (falls back to index 0 whenever the last pick isn't in this tier -
  // e.g. it just went into cooldown or the priority set changed).
  _pickFromTier(tier) {
    if (tier.length === 1) return tier[0];
    const ids = tier.map((t) => t.project.id);
    const lastIdx = ids.indexOf(this._lastPickedId);
    const nextIdx = lastIdx === -1 ? 0 : (lastIdx + 1) % ids.length;
    return tier[nextIdx];
  }

  async _runOneCycle(project, runtime, forcedKind) {
    const cycleNumber = (runtime.cycle || 0) + 1;
    const criticRatio = project.criticRatio || 0;
    // v0.3 kind-selection priority (docs/plans/2026-07-24-goal-loop.md Shared
    // contracts, "Kind selection"), in exact order:
    //   1. forcedKind (wrapup) wins.
    //   2. Pending INJECT.md -> orchestrate if orchestration is enabled
    //      (project.workerModel set), else work (v0.2 behavior) - only work
    //      cycles without an order consume injections; an orchestrated
    //      project instead lets the planner triage the directive.
    //   3. Critic cadence -> critic, unchanged, applies in orchestrated
    //      projects too.
    //   4. Enabled + at least one open order -> work with the lowest-filename
    //      open order, effective model = workerModel.
    //   5. Enabled + zero open orders -> orchestrate (project.model).
    //   6. Not enabled -> work (v0.2 behavior, byte-identical).
    const orchestrationEnabled = !!project.workerModel;
    const injectPending = !forcedKind && fs.existsSync(injectFilePath(project.dir));

    let kind;
    let order = null;
    let effectiveModel = project.model;

    if (forcedKind) {
      kind = forcedKind;
    } else if (injectPending) {
      kind = orchestrationEnabled ? 'orchestrate' : 'work';
    } else if (criticRatio > 0 && cycleNumber % criticRatio === 0) {
      kind = 'critic';
    } else if (orchestrationEnabled) {
      const openOrder = findLowestOpenOrder(project.dir);
      if (openOrder) {
        // I1 fix (v0.3 review): a worker that exits without advancing its
        // order's status would otherwise be re-dispatched against the same
        // order forever, and the orchestrate cycle that could groom the
        // stuck order only ran at zero open orders. Cap consecutive
        // dispatches of the SAME order at STUCK_ORDER_LIMIT, then force a
        // grooming orchestrate cycle (which resets the counter). The
        // counter is in-memory: a daemon restart re-grants the order fresh
        // attempts, which is acceptable - the cap exists to break
        // livelocks, not to be an exact count.
        const prev = this._orderAttempts[project.id];
        const attempts = prev && prev.orderId === openOrder.id ? prev.count : 0;
        if (attempts >= STUCK_ORDER_LIMIT) {
          kind = 'orchestrate';
          this._orderAttempts[project.id] = null;
        } else {
          kind = 'work';
          order = openOrder;
          effectiveModel = project.workerModel;
          this._orderAttempts[project.id] = { orderId: openOrder.id, count: attempts + 1 };
        }
      } else {
        kind = 'orchestrate';
        this._orderAttempts[project.id] = null;
      }
    } else {
      kind = 'work';
    }

    // Seed totals BEFORE this cycle's cycle_end lands in events.jsonl, or
    // the backfill would double-count it.
    this._ensureTotals(project, runtime);

    this._running.set(project.id, { projectId: project.id, cycle: cycleNumber, kind, startedIso: util.nowIso() });
    this._emitStatusIfChanged();

    try {
      events.appendEvent(project.dir, project.id, 'cycle_start', { cycle: cycleNumber, kind });
    } catch (err) {
      util.log('scheduler: appendEvent cycle_start failed', String(err && err.message));
    }

    // Effective model + effort routing (docs/plans Task S): a work cycle
    // carrying an order runs against workerModel, not project.model - the
    // scheduler passes `{...project, model: effectiveModel}` down, so
    // everything downstream (the runner's spawn, and this function's own
    // totals/cycle_end stamping) sees the model actually used. Effort
    // follows the same rule: a worker uses workerEffort when set, else it
    // inherits the project's effort; orchestrate/critic/plain-work cycles
    // keep project.effort unchanged.
    let cycleProject = project;
    if (order) {
      const workerEffort = project.workerEffort || project.effort;
      cycleProject = Object.assign({}, project, { model: effectiveModel, effort: workerEffort });
    }

    // Provider keys are re-read per cycle (cheap; a key saved on the
    // Settings page reaches the very next cycle) and Codex's sign-in state
    // decides whether the OpenAI key doubles as CODEX_API_KEY.
    let providerKeys;
    try {
      providerKeys = keysModule.load();
    } catch (err) {
      providerKeys = { openai: null, stability: null, sources: {} };
    }
    let codexLoggedIn = null;
    try {
      const es = this.engines.current();
      codexLoggedIn = es && es.codex ? es.codex.loggedIn : null;
    } catch (err) {
      codexLoggedIn = null;
    }

    let result;
    try {
      result = await this.runCycleImpl({
        project: cycleProject,
        kind,
        order: order ? { id: order.id, content: order.content } : null,
        cycleNumber,
        budget: this.budget,
        claudeCmd: project.claudeCmd,
        notes: this.stateObj.settings.notes || '',
        providerKeys,
        codexLoggedIn,
        defaultImageModel: this.stateObj.settings.imageModel || null,
      });
    } catch (err) {
      // runCycle's contract is "never rejects"; guard anyway so a broken
      // injected fake cannot take down the scheduler loop itself.
      util.log('scheduler: runCycleImpl threw (contract violation)', String(err && err.message));
      result = {
        exit: 'crash',
        code: null,
        minutes: 0,
        tokens: { in: 0, out: 0 },
        costUsd: null,
        commit: null,
        gitDiff: { files: 0, ins: 0, del: 0 },
        verify: null,
      };
    }

    try {
      events.appendEvent(project.dir, project.id, 'cycle_end', {
        cycle: cycleNumber,
        kind,
        model: effectiveModel,
        order: order ? order.id : null,
        verify: result.verify != null ? result.verify : null,
        modelUsage: result.modelUsage || undefined,
        minutes: result.minutes,
        exit: result.exit,
        code: result.code,
        tokens: result.tokens,
        costUsd: result.costUsd,
        gitDiff: result.gitDiff,
        commit: result.commit,
      });
    } catch (err) {
      util.log('scheduler: appendEvent cycle_end failed', String(err && err.message));
    }

    // A usage_limit exit already proved the account is over ceiling; flip
    // the budget manager immediately rather than waiting for the next
    // 60s-gated poll (SPEC.md section 3). The real runner already calls
    // this too - calling it again here is a harmless idempotent duplicate,
    // and is what makes this work even with an injected fake runCycleImpl
    // that never touches the budget object itself.
    if (result.exit === 'usage_limit' && this.budget && typeof this.budget.noteUsageLimitExit === 'function') {
      try {
        this.budget.noteUsageLimitExit(enginesModule.normalizeEngine(project.engine));
      } catch (err) {
        util.log('scheduler: noteUsageLimitExit threw', String(err && err.message));
      }
    }

    runtime.cycle = cycleNumber;
    runtime.sinceReview = (runtime.sinceReview || 0) + 1;
    addCycleUsage(runtime.totals, effectiveModel, result);

    if (result.exit === 'crash') {
      const now = Date.now();
      const kept = (runtime.failTimes || []).filter((t) => {
        const ms = Date.parse(t);
        return Number.isFinite(ms) && now - ms < CRASH_WINDOW_MS;
      });
      kept.push(util.nowIso());
      runtime.failTimes = kept;
      if (kept.length >= CRASH_LIMIT) {
        runtime.cooldownUntil = new Date(now + COOLDOWN_MS).toISOString();
        runtime.failTimes = [];
        try {
          events.appendEvent(project.dir, project.id, 'sleep', { reason: 'cooldown', until: runtime.cooldownUntil });
        } catch (err) {
          // best effort
        }
      }
    } else if (result.exit === 'clean') {
      runtime.failTimes = [];
    }

    state.writeRuntime(project.dir, runtime);
    this._lastCycleInfo[project.id] = {
      lastExit: result.exit,
      lastCommit: result.commit,
      lastVerify: result.verify != null ? result.verify : null,
    };
    this._running.delete(project.id);

    // Cap summary (user directive 2026-07-23): when a chain dies of usage
    // exhaustion, its per-checkpoint UPDATES entries can still end
    // mid-thought - run ONE short wrapup cycle whose only job is a
    // plain-English summary entry in UPDATES.md. This deliberately runs
    // slightly over the cap (accepted by the user; disable with
    // settings.capSummary = false). A wrapup's own exit can never trigger
    // another wrapup, so it cannot chain.
    const capSummary = !this.stateObj.settings || this.stateObj.settings.capSummary !== false;
    if (result.exit === 'usage_limit' && kind !== 'wrapup' && capSummary) {
      const freshRuntime = state.readRuntime(project.dir);
      const wrapProject = Object.assign({}, project, {
        maxCycleMinutes: Math.min(10, project.maxCycleMinutes || 10),
      });
      await this._runOneCycle(wrapProject, freshRuntime, 'wrapup');
    }
  }

  // Some events (sleep for ceiling/outage/paused, grace_start) are global
  // budget-manager concepts, not per-project ones, but events.jsonl only
  // exists inside each project's own .autopilot/ directory (SPEC.md
  // section 4) - there is no separate global log. We replicate these
  // events into every known project's log so each project's own audit
  // trail explains why it wasn't running.
  // engine (optional): replicate only into projects of that engine - the
  // Anthropic meter's sleep/grace events would be false explanations in a
  // Codex project's log, which never waits on that meter.
  _appendGlobalEvent(ev, fields, engine) {
    for (const project of this.stateObj.projects || []) {
      if (engine && enginesModule.normalizeEngine(project.engine) !== engine) continue;
      try {
        events.appendEvent(project.dir, project.id, ev, fields);
      } catch (err) {
        util.log('scheduler: appendEvent (global)', ev, 'failed for', project.id, String(err && err.message));
      }
    }
  }

  // ---- status --------------------------------------------------------------

  _projectStatus(project) {
    const runtime = state.readRuntime(project.dir);
    const now = Date.now();
    const stopped = !project.enabled || fs.existsSync(stopFilePath(project.dir));
    const inCooldown = !!(runtime.cooldownUntil && Date.parse(runtime.cooldownUntil) > now);
    const inReview =
      project.reviewGateCycles > 0 &&
      runtime.sinceReview >= project.reviewGateCycles &&
      !fs.existsSync(reviewedFilePath(project.dir));
    const runningInfo = this._running.get(project.id) || null;
    const isCurrent = !!runningInfo;

    const atCap = project.maxCycles > 0 && runtime.cycle >= project.maxCycles;

    let status;
    let statusDetail;
    if (atCap) {
      status = 'complete';
      statusDetail = `cycle cap reached (${runtime.cycle}/${project.maxCycles})`;
    } else if (stopped) {
      status = 'stopped';
      statusDetail = project.enabled ? 'STOP file present' : 'disabled';
    } else if (inReview) {
      status = 'awaiting-review';
      statusDetail = `awaiting review (${runtime.sinceReview}/${project.reviewGateCycles})`;
    } else if (inCooldown) {
      status = 'cooldown';
      statusDetail = `cooldown until ${runtime.cooldownUntil}`;
    } else if (isCurrent) {
      status = 'running';
      statusDetail = `cycle ${runningInfo.cycle} (${runningInfo.kind})`;
    } else if (this.paused) {
      status = 'sleeping';
      statusDetail = 'paused';
    } else if (enginesModule.normalizeEngine(project.engine) === 'codex') {
      // Codex projects never wait on the Anthropic meter; only on their
      // own usage-limit latch.
      const gate = this._engineGate('codex');
      if (!gate.ok) {
        status = 'sleeping';
        statusDetail = `codex usage limit, retry ${gate.resetsAt || 'soon'}`;
      } else {
        status = 'queued';
        statusDetail = 'queued';
      }
    } else if (!this._effectiveBudgetOk || this._inGrace) {
      status = 'sleeping';
      statusDetail = this._inGrace
        ? 'grace period'
        : (this._lastBudget && this._lastBudget.reason) || 'sleeping';
    } else {
      status = 'queued';
      statusDetail = 'queued';
    }

    if (!runtime.totals) {
      // First status render since the totals feature landed: seed from
      // events.jsonl once and persist, so it never re-scans.
      this._ensureTotals(project, runtime);
      state.writeRuntime(project.dir, runtime);
    }

    const info = this._lastCycleInfo[project.id] || {};
    let pendingInject = false;
    try {
      pendingInject = fs.existsSync(injectFilePath(project.dir));
    } catch (err) {
      // best effort
    }
    // v0.3 snapshot additions: orders counts are null when orchestration is
    // disabled for the project (no workerModel); lastVerify mirrors the most
    // recent cycle_end's verify field, kept in _lastCycleInfo alongside
    // lastExit/lastCommit.
    let orders = null;
    if (project.workerModel) {
      try {
        orders = orderCounts(project.dir);
      } catch (err) {
        orders = { open: 0, inProgress: 0, done: 0, blocked: 0 };
      }
    }
    return {
      status,
      statusDetail,
      cycle: runtime.cycle,
      sinceReview: runtime.sinceReview,
      lastExit: info.lastExit || null,
      lastCommit: info.lastCommit || null,
      lastVerify: info.lastVerify || null,
      pendingInject,
      totals: runtime.totals,
      orders,
    };
  }

  // Status snapshot (docs/plans Shared contracts): the exact shape the
  // already-built UI codes against. Field names matter.
  snapshot() {
    const fatalRecord = state.readFatal();

    const projects = (this.stateObj.projects || []).map((project) => {
      const base = Object.assign({}, project);
      if (fatalRecord) {
        const runtime = state.readRuntime(project.dir);
        const info = this._lastCycleInfo[project.id] || {};
        let orders = null;
        if (project.workerModel) {
          try {
            orders = orderCounts(project.dir);
          } catch (err) {
            orders = { open: 0, inProgress: 0, done: 0, blocked: 0 };
          }
        }
        return Object.assign(base, {
          status: 'fatal',
          statusDetail: 'fatal latched',
          cycle: runtime.cycle,
          sinceReview: runtime.sinceReview,
          lastExit: info.lastExit || null,
          lastCommit: info.lastCommit || null,
          lastVerify: info.lastVerify || null,
          orders,
        });
      }
      return Object.assign(base, this._projectStatus(project));
    });

    return {
      daemon: {
        pid: process.pid,
        startedIso: this._startedIso,
        version: VERSION,
        paused: this.paused,
        // Lets the UI hide Windows-only affordances (the native folder
        // picker) instead of offering a button that can only fail.
        platform: process.platform,
      },
      fatal: fatalRecord,
      localModel: this.localModel.current(),
      engines: this.engines.current(),
      // Model catalog (one source of truth for every dropdown) and the
      // masked provider-key summary for the Settings page. Never the keys.
      models: enginesModule.MODEL_CATALOG,
      keys: this._keysSummary(),
      budget: {
        ok: this._lastBudget.ok,
        reason: this._lastBudget.reason,
        checkedIso: this._lastBudget.checkedIso,
        windows: this._lastBudget.windows || [],
      },
      settings: {
        ceilingPct: this.stateObj.settings.ceilingPct,
        graceMinutes: this.stateObj.settings.graceMinutes,
        webhook: this.stateObj.settings.webhook,
        notes: this.stateObj.settings.notes || '',
        concurrency: this._concurrency(),
        projectsRoot: this.stateObj.settings.projectsRoot || null,
        imageModel: this.stateObj.settings.imageModel || null,
      },
      // `current` is kept for UI/API compat: the oldest in-flight cycle, or
      // null. `running` is the full slot list (concurrency-aware).
      current: fatalRecord ? null : (this._running.values().next().value || null),
      running: fatalRecord ? [] : [...this._running.values()],
      concurrency: this._concurrency(),
      totals: (() => {
        const g = emptyTotals();
        for (const p of projects) {
          const t = p.totals;
          if (!t) continue;
          g.in += t.in || 0;
          g.out += t.out || 0;
          g.costUsd += t.costUsd || 0;
          g.cycles += t.cycles || 0;
          for (const [model, m] of Object.entries(t.byModel || {})) {
            const gm = g.byModel[model] || (g.byModel[model] = { in: 0, out: 0, costUsd: 0, cycles: 0 });
            gm.in += m.in || 0;
            gm.out += m.out || 0;
            gm.costUsd += m.costUsd || 0;
            gm.cycles += m.cycles || 0;
          }
        }
        return g;
      })(),
      projects,
    };
  }

  _ensureTotals(project, runtime) {
    if (runtime.totals) return;
    const totals = emptyTotals();
    try {
      for (const e of events.readEvents(project.dir, 100000)) {
        if (e && e.ev === 'cycle_end') {
          addCycleUsage(totals, e.model || project.model, e);
        }
      }
    } catch (err) {
      // no events yet - totals start at zero
    }
    runtime.totals = totals;
  }

  _emitStatusIfChanged() {
    const snap = this.snapshot();
    const json = JSON.stringify(snap);
    if (json !== this._lastSnapshotJson) {
      this._lastSnapshotJson = json;
      this.emit('status', snap);
    }
    return snap;
  }

  // ---- commands (used by server.js) ---------------------------------------

  // Launch the local inference server + router. Returns {ok} / {ok:false,error}
  // immediately; readiness shows up later via localModel.available.
  startLocalModel() {
    const r = this.localModel.start();
    if (r.ok) this._emitStatusIfChanged(); // flip the UI to "starting" at once
    return r;
  }

  // Engine sign-in (settings page): launches the CLI's browser login flow
  // from the daemon's desktop session. Result shows up on the next probe.
  startEngineLogin(engine) {
    return this.engines.login(engine);
  }

  // ---- provider keys (settings page) --------------------------------------

  _keysSummary() {
    try {
      return keysModule.summary(keysModule.load());
    } catch (err) {
      return keysModule.summary({ openai: null, stability: null, sources: {} });
    }
  }

  // patch: {openai?: string, stability?: string}; '' clears. Returns the
  // masked summary. The key itself never enters the snapshot or a log.
  setProviderKeys(patch) {
    const rec = keysModule.load();
    for (const p of keysModule.PROVIDERS) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, p)) keysModule.set(rec, p, patch[p], 'settings');
    }
    keysModule.save(rec);
    this._emitStatusIfChanged();
    return keysModule.summary(rec);
  }

  // Fill empty key slots from the environment / nearby .env files.
  detectProviderKeys() {
    const r = keysModule.autofill();
    this._emitStatusIfChanged();
    return { filled: r.filled, keys: keysModule.summary(r.record) };
  }

  async refreshEngines() {
    const r = await this.engines.refresh();
    this._emitStatusIfChanged();
    return r;
  }

  pauseAll() {
    if (!this.paused) {
      this.paused = true;
      this._appendGlobalEvent('sleep', { reason: 'paused', until: null });
    }
    this._emitStatusIfChanged();
  }

  // Manual resume deliberately does not touch _budgetWasOk/_graceUntil: the
  // budget-recovery grace period is a separate gate from the global pause,
  // so a human manually unpausing never incurs it (docs/plans Task 6: grace
  // is "skipped when resume was manual").
  resumeAll() {
    this.paused = false;
    this._emitStatusIfChanged();
  }

  startProject(id) {
    const project = state.getProject(this.stateObj, id);
    if (!project) return false;
    project.enabled = true;
    try {
      fs.unlinkSync(stopFilePath(project.dir));
    } catch (err) {
      // already absent
    }
    state.save(this.stateObj);
    this._emitStatusIfChanged();
    return true;
  }

  stopProject(id) {
    const project = state.getProject(this.stateObj, id);
    if (!project) return false;
    util.ensureDir(util.projectMeta(project.dir));
    fs.writeFileSync(stopFilePath(project.dir), '');
    try {
      events.appendEvent(project.dir, project.id, 'sleep', { reason: 'stop', until: null });
    } catch (err) {
      // best effort
    }
    this._emitStatusIfChanged();
    return true;
  }

  // Injection commands (SPEC "Injection"): the daemon owns INJECT.md; the
  // next work cycle consumes it via the runner. Multiple injections before
  // that cycle stack in arrival order.
  addInjection(id, text) {
    const project = state.getProject(this.stateObj, id);
    if (!project) return false;
    const clean = String(text == null ? '' : text).trim();
    if (!clean) return false;
    util.ensureDir(util.projectMeta(project.dir));
    const p = injectFilePath(project.dir);
    const existing = fs.existsSync(p) ? String(fs.readFileSync(p, 'utf8')) : '';
    fs.writeFileSync(p, existing ? `${existing.replace(/\s+$/, '')}\n\n${clean}\n` : `${clean}\n`);
    try {
      events.activity(project.dir, `user directive queued for next cycle: ${clean.slice(0, 160)}`, 'daemon');
    } catch (err) {
      // best effort
    }
    this._emitStatusIfChanged();
    return true;
  }

  getInjection(id) {
    const project = state.getProject(this.stateObj, id);
    if (!project) return null;
    const p = injectFilePath(project.dir);
    try {
      return fs.existsSync(p) ? String(fs.readFileSync(p, 'utf8')) : '';
    } catch (err) {
      return '';
    }
  }

  clearInjection(id) {
    const project = state.getProject(this.stateObj, id);
    if (!project) return false;
    try {
      fs.unlinkSync(injectFilePath(project.dir));
    } catch (err) {
      // already absent
    }
    this._emitStatusIfChanged();
    return true;
  }

  markReviewed(id) {
    const project = state.getProject(this.stateObj, id);
    if (!project) return false;
    const runtime = state.readRuntime(project.dir);
    runtime.sinceReview = 0;
    state.writeRuntime(project.dir, runtime);
    try {
      fs.unlinkSync(reviewedFilePath(project.dir));
    } catch (err) {
      // already absent
    }
    try {
      events.appendEvent(project.dir, project.id, 'reviewed', {});
    } catch (err) {
      // best effort
    }
    this._emitStatusIfChanged();
    return true;
  }

  setPriority(id, n) {
    const project = state.getProject(this.stateObj, id);
    if (!project) return false;
    // I6 fix (server-side half): reject a non-numeric priority rather than
    // storing it verbatim - projects.json is rendered back into the UI's
    // DOM (see I6/ui/index.html), so an unvalidated value here is reachable
    // stored-XSS, not just a display glitch.
    const num = Number(n);
    if (!Number.isFinite(num)) return false;
    project.priority = num;
    state.save(this.stateObj);
    this._emitStatusIfChanged();
    return true;
  }

  // Apply a validated config patch to a project (model, workerModel,
  // effort, workerEffort, verifyCmd, criticRatio, etc. - see
  // state.updateProject's EDITABLE_KEYS). Takes effect on the NEXT cycle:
  // an in-flight cycle already spawned with the old model/effort runs to
  // completion. Returns false for an unknown project.
  updateProject(id, patch) {
    const updated = state.updateProject(this.stateObj, id, patch);
    if (!updated) return false;
    state.save(this.stateObj);
    try {
      events.activity(updated.dir, `config updated (applies next cycle): ${summarizePatch(patch)}`, 'daemon');
    } catch (err) {
      // best effort
    }
    this._emitStatusIfChanged();
    return true;
  }

  addProject(cfg) {
    const project = state.addProject(this.stateObj, cfg);
    state.save(this.stateObj);
    this._emitStatusIfChanged();
    return project;
  }

  // Deregister a project. Refuses while it is mid-cycle: the runner holds the
  // directory and would keep writing to a project the registry no longer knows
  // about. Never touches the directory itself.
  isMidCycle(id) {
    return this._running.has(id);
  }

  removeProject(id) {
    if (this._running.has(id)) return false;
    const removed = state.removeProject(this.stateObj, id);
    if (!removed) return false;
    state.save(this.stateObj);
    this._emitStatusIfChanged();
    return true;
  }

  updateSettings(patch) {
    const clean = Object.assign({}, patch || {});
    // concurrency is a live scheduler knob: validated here (int 1..8; the
    // getter clamps again defensively). Lowering it never kills in-flight
    // cycles - slots drain naturally as cycles finish.
    if (Object.prototype.hasOwnProperty.call(clean, 'concurrency')) {
      const n = Number(clean.concurrency);
      if (!Number.isInteger(n) || n < 1 || n > 8) delete clean.concurrency;
      else clean.concurrency = n;
    }
    // imageModel: a safe-charset model id, or null/'' to clear.
    if (Object.prototype.hasOwnProperty.call(clean, 'imageModel')) {
      const v = clean.imageModel;
      if (v === null || v === '') clean.imageModel = null;
      else if (typeof v === 'string' && /^[a-z0-9][a-z0-9.\-]{0,63}$/i.test(v.trim())) clean.imageModel = v.trim();
      else delete clean.imageModel;
    }
    // projectsRoot: an existing absolute directory, or null/'' to clear.
    if (Object.prototype.hasOwnProperty.call(clean, 'projectsRoot')) {
      const v = clean.projectsRoot;
      if (v === null || v === '') {
        clean.projectsRoot = null;
      } else if (typeof v === 'string' && path.isAbsolute(v) && fs.existsSync(v) && fs.statSync(v).isDirectory()) {
        clean.projectsRoot = path.resolve(v);
      } else {
        delete clean.projectsRoot;
      }
    }
    Object.assign(this.stateObj.settings, clean);
    state.save(this.stateObj);
    this._emitStatusIfChanged();
    return this.stateObj.settings;
  }

  clearFatal() {
    state.clearFatal();
    if (this.budget && typeof this.budget.clearFatal === 'function') {
      try {
        this.budget.clearFatal();
      } catch (err) {
        // best effort
      }
    }
    this._emitStatusIfChanged();
  }
}

module.exports = { Scheduler };
