'use strict';

// Cycle runner: spawns one headless `claude -p` cycle, parses its
// stream-json output, classifies how it ended, and auto-commits the
// result. Zero npm dependencies, Node built-ins only, CommonJS.
//
// Behavior contract (docs/plans/2026-07-23-autopilot-build.md, Task 4):
// runCycle() never throws. Every failure mode (containment generation,
// spawn, parsing, git) is caught and folded into the returned object so
// the scheduler can always stamp a cycle_end event. The runner does not
// stamp events itself (SPEC.md section 4: only the daemon's own clock
// writes events.jsonl) - it returns data only; the caller (scheduler)
// stamps cycle_start/cycle_end.

const fs = require('fs');
const path = require('path');
const { spawn, execFileSync, spawnSync } = require('child_process');

const util = require('./util');
const events = require('./events');
const preambles = require('./preambles');
const containment = require('./containment');

// Exit-condition regexes (SPEC.md section 4: never guess from exit codes
// alone - context-full and usage-limit both return nonzero, and message
// strings change between CLI versions, so these are best-effort text
// classification, checked in a fixed order against the full captured
// stdout+stderr text).
const USAGE_LIMIT_RE = /usage limit|rate limit|hit your limit|out of extended usage/i;
const CONTEXT_FULL_RE = /context window|prompt is too long|context low|ran out of context/i;

// Valid claude --effort levels; an out-of-set project.effort is ignored
// (the CLI default applies) rather than passed through blindly.
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// A cycle that errors out this fast with no structured result line reads as
// a crash (bad flags, missing binary, immediate CLI failure) rather than a
// real work attempt that happened to fail.
const CRASH_WINDOW_MS = 120 * 1000;

// Production kill-check cadence (SPEC.md/plan: poll for STOP + timeout).
// Tests use fractional maxCycleMinutes (e.g. 0.05 = 3s), so the interval is
// derived from maxCycleMinutes and capped at this production value rather
// than being fixed - see checkIntervalFor() below.
const PROD_CHECK_INTERVAL_MS = 5000;
const MIN_CHECK_INTERVAL_MS = 50;

// Only the first N characters of each assistant text block are mirrored
// into ACTIVITY.log - the model's own narration is color, not ground truth
// (SPEC.md section 1), and unbounded text blocks would flood the log.
const ACTIVITY_TEXT_CHARS = 400;

function defaultClaudeCmd() {
  return process.platform === 'win32' ? ['cmd', '/c', 'claude'] : ['claude'];
}

function stopFilePath(dir) {
  return path.join(util.projectMeta(dir), 'STOP');
}

// Kill-check interval: 5s in production is too slow to observe in tests
// that use a maxCycleMinutes of a few seconds, so the interval scales down
// with the cycle's own budget (capped below at MIN_CHECK_INTERVAL_MS so a
// pathological maxCycleMinutes of 0 cannot busy-loop).
function checkIntervalFor(maxCycleMs) {
  return Math.max(MIN_CHECK_INTERVAL_MS, Math.min(PROD_CHECK_INTERVAL_MS, maxCycleMs / 3));
}

function gitRevParseHead(dir) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: dir,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (err) {
    // No commits yet (unborn HEAD) or git unavailable.
    return null;
  }
}

function gitShortHead(dir) {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: dir,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (err) {
    return null;
  }
}

// Stages everything and commits regardless of what the cycle did (SPEC.md
// section 5: "daemon auto-commit after EVERY cycle ... regardless of what
// the cycle did"). Skips the commit (returns null) when nothing is staged,
// rather than creating an empty commit. Never throws: any git failure logs
// and resolves to null.
function gitAutoCommit(dir, cycleNumber) {
  try {
    execFileSync('git', ['add', '-A'], { cwd: dir, windowsHide: true, stdio: 'ignore' });
  } catch (err) {
    util.log('runner: git add -A failed for', dir, String(err && err.message));
    return null;
  }

  try {
    // Exit 0 = no staged changes (diff is empty) -> nothing to commit.
    execFileSync('git', ['diff', '--cached', '--quiet'], { cwd: dir, windowsHide: true, stdio: 'ignore' });
    return null;
  } catch (diffErr) {
    // Nonzero exit = staged changes exist; fall through to commit.
  }

  try {
    execFileSync('git', ['commit', '-m', `cycle ${cycleNumber} auto-commit [autopilot]`], {
      cwd: dir,
      windowsHide: true,
      stdio: 'ignore',
    });
  } catch (err) {
    util.log('runner: git commit failed for', dir, String(err && err.message));
    return null;
  }

  return gitShortHead(dir);
}

// Summed file/insertion/deletion counts between preHead and HEAD. Per the
// Task 4 contract this is all zeros when there was no preHead (unborn repo)
// or no new commit landed - a diff against a phantom base is not
// meaningful, and "nothing changed" is the honest answer in both cases.
function gitDiffStat(dir, preHead, postCommit) {
  const zero = { files: 0, ins: 0, del: 0 };
  if (!preHead || !postCommit) return zero;

  let out;
  try {
    out = execFileSync('git', ['diff', '--numstat', `${preHead}..HEAD`], {
      cwd: dir,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    return zero;
  }

  let files = 0;
  let ins = 0;
  let del = 0;
  for (const line of out.split('\n')) {
    if (!line) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    files += 1;
    const a = parseInt(parts[0], 10);
    const d = parseInt(parts[1], 10);
    // Binary files report "-" for both columns; leave them uncounted
    // rather than NaN-poisoning the sum.
    if (Number.isFinite(a)) ins += a;
    if (Number.isFinite(d)) del += d;
  }
  return { files, ins, del };
}

// win32: taskkill /T kills the whole process tree. posix: the child is
// spawned detached so its pid is also its process group id, and a negative
// pid targets the whole group. Both are best-effort synchronous calls;
// actual termination is confirmed later by awaiting the child's 'close'
// event, never by this function's return.
function treeKillSync(child) {
  if (!child || child.pid == null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (err) {
      // Already dead, or taskkill unavailable; best effort.
    }
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch (err) {
      try {
        child.kill('SIGKILL');
      } catch (err2) {
        // best effort
      }
    }
  }
}

function safeEnsureContainment(project) {
  try {
    return containment.ensureContainment(project);
  } catch (err) {
    util.log('runner: ensureContainment failed for', project && project.dir, String(err && err.message));
    return { settingsPath: null, orchestrateSettingsPath: null };
  }
}

function buildPreamble(project, kind, order) {
  try {
    if (kind === 'critic') return preambles.criticPreamble(project);
    if (kind === 'wrapup') return preambles.wrapupPreamble(project);
    if (kind === 'orchestrate') return preambles.orchestratorPreamble(project);
    let base = preambles.workPreamble(project);
    if (order) {
      base = `${base}\n${preambles.workerOrderSection(order)}`;
    }
    return base;
  } catch (err) {
    util.log('runner: preamble build failed', String(err && err.message));
    return '';
  }
}

// Runs project.verifyCmd (if set) after the cycle's child has exited and
// BEFORE auto-commit (Shared contracts: "Verify gate"). cwd is the project
// dir, env is stripped the same way as the cycle's own child, 10-minute
// timeout by default (overridable via project.verifyTimeoutMs, test-only),
// `cmd /c` on win32 / `sh -c` on posix. Never throws; a timeout counts as
// {ok:false, code:null}; absent verifyCmd returns null.
function runVerifyGate(project) {
  const cmdStr = project && project.verifyCmd;
  if (!cmdStr) return null;

  const timeoutMs =
    typeof project.verifyTimeoutMs === 'number' && project.verifyTimeoutMs > 0
      ? project.verifyTimeoutMs
      : 10 * 60 * 1000;

  const env = Object.assign({}, process.env);
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const bin = process.platform === 'win32' ? 'cmd' : 'sh';
  // /d /s /c plus windowsVerbatimArguments: cmd.exe's own quote-stripping
  // rules otherwise collide with Node's array-arg auto-escaping and mangle
  // any verifyCmd containing embedded double quotes (e.g. `node -e "..."`).
  // The extra outer quotes matter: with /s, cmd.exe strips exactly one
  // outer quote pair from the whole command line - without them, a
  // verifyCmd that BEGINS with a quoted path (`"C:\Program Files\..." -e
  // ...`) loses its first and last quote chars and breaks. With them,
  // every shape (bare `npm test`, embedded quotes, leading quoted path)
  // survives verbatim.
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', `"${cmdStr}"`] : ['-c', cmdStr];

  try {
    const res = spawnSync(bin, args, {
      cwd: project.dir,
      windowsHide: true,
      env,
      timeout: timeoutMs,
      stdio: 'ignore',
      windowsVerbatimArguments: process.platform === 'win32',
    });
    if (res.error) {
      // Includes ETIMEDOUT and spawn failures alike - both are "verify did
      // not succeed", not a reason to throw.
      return { cmd: cmdStr, ok: false, code: null };
    }
    const code = typeof res.status === 'number' ? res.status : null;
    return { cmd: cmdStr, ok: code === 0, code };
  } catch (err) {
    util.log('runner: verifyCmd execution failed for', project && project.dir, String(err && err.message));
    return { cmd: cmdStr, ok: false, code: null };
  }
}

// User directive injection: <dir>/.autopilot/INJECT.md is written by the
// daemon (UI/CLI) between cycles. Only WORK cycles consume it (critic does
// no new work; wrapup must stay minimal - the scheduler additionally
// forces the next cycle to be work while an injection is pending). On
// consumption the text is archived to .autopilot/injections.log and the
// file is cleared, so a directive is delivered exactly once.
function consumeInjection(project, kind, cycleNumber, order) {
  // C1 fix (v0.3 review): injections are consumed by orchestrate cycles
  // (orchestrated projects - the planner triages directives) and by plain
  // work cycles (non-orchestrated projects). A worker cycle carrying an
  // order never consumes - backstop for the scheduler's routing. The
  // original guard (`kind !== 'work' || order`) made orchestrated
  // injections undeliverable: the scheduler routed them to orchestrate
  // cycles which then refused them, looping big-model cycles forever.
  const consumes = kind === 'orchestrate' || (kind === 'work' && !order);
  if (!consumes) return null;
  const injectPath = path.join(util.projectMeta(project.dir), 'INJECT.md');
  let text = null;
  try {
    if (fs.existsSync(injectPath)) {
      text = String(fs.readFileSync(injectPath, 'utf8')).trim();
    }
  } catch (err) {
    util.log('runner: reading INJECT.md failed', String(err && err.message));
    return null;
  }
  if (!text) return null;
  try {
    const logPath = path.join(util.projectMeta(project.dir), 'injections.log');
    fs.appendFileSync(logPath, `=== ${util.nowIso()} -> cycle ${cycleNumber} ===\n${text}\n\n`);
    fs.unlinkSync(injectPath);
  } catch (err) {
    util.log('runner: archiving INJECT.md failed', String(err && err.message));
  }
  try {
    events.appendEvent(project.dir, project.id, 'inject', {
      cycle: cycleNumber,
      chars: text.length,
      preview: text.slice(0, 120),
    });
    events.activity(project.dir, `user directive injected into cycle ${cycleNumber}: ${text.slice(0, 160)}`, 'daemon');
  } catch (err) {
    // best effort
  }
  return text;
}

function extractAssistantTexts(parsedLine) {
  const content =
    parsedLine && parsedLine.message && Array.isArray(parsedLine.message.content)
      ? parsedLine.message.content
      : [];
  const texts = [];
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') {
      texts.push(block.text);
    }
  }
  return texts;
}

function resultInfoFrom(parsedLine) {
  const usage = (parsedLine && parsedLine.usage) || {};
  const inputTokens =
    (usage.input_tokens || 0) +
    (usage.cache_read_input_tokens || 0) +
    (usage.cache_creation_input_tokens || 0);
  return {
    subtype: parsedLine.subtype || null,
    isError: parsedLine.is_error === true,
    tokens: { in: inputTokens, out: usage.output_tokens || 0 },
    costUsd: typeof parsedLine.total_cost_usd === 'number' ? parsedLine.total_cost_usd : null,
    modelUsage: normalizeModelUsage(parsedLine.modelUsage),
  };
}

// stream-json's result line carries a per-model usage/cost breakdown that
// INCLUDES subagent activity (verified empirically 2026-07-24: a Task
// subagent's turns and cost appear in the parent's usage/modelUsage).
// Normalize it to our shape so orchestrate cycles that fan out to scout
// subagents attribute cost to the models that actually ran, not just the
// configured one. Parsed defensively - absent/foreign shapes yield null
// and the caller falls back to whole-cycle single-model attribution.
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

/**
 * Run one headless claude cycle.
 *
 * @param {object} opts
 * @param {object} opts.project - project config (dir, model, prompt, maxCycleMinutes, ...).
 * @param {'work'|'critic'|'wrapup'|'orchestrate'} opts.kind
 * @param {number} opts.cycleNumber - used only in the auto-commit message.
 * @param {object} opts.budget - only .scanForTripwire(text) and
 *   .noteUsageLimitExit() are called; inject a mock in tests.
 * @param {{id:string, content:string}|null} [opts.order] - the scheduler
 *   ALWAYS passes this (null when absent); a work cycle with an order gets
 *   the order section appended to its preamble instead of PLAN.md triage,
 *   and does not consume a pending INJECT.md this cycle.
 * @param {string[]} [opts.claudeCmd] - command + leading args, e.g.
 *   ['cmd','/c','claude'] or [process.execPath, 'test/fake-claude.js'].
 *   Defaults to ['cmd','/c','claude'] on win32, ['claude'] elsewhere.
 * @returns {Promise<{exit:string, code:number|null, minutes:number,
 *   tokens:{in:number,out:number}, costUsd:number|null,
 *   commit:string|null, gitDiff:{files:number,ins:number,del:number},
 *   verify:{cmd:string, ok:boolean, code:number|null}|null}>}
 *   Never rejects/throws - every failure folds into this return shape.
 */
async function runCycle(opts) {
  const { project, kind, cycleNumber, budget } = opts || {};
  const order = opts && opts.order ? opts.order : null;
  const dir = project.dir;
  const startedAt = Date.now();

  const { settingsPath, orchestrateSettingsPath } = safeEnsureContainment(project);
  // Settings selection by kind: orchestrate and critic cycles run with the
  // orchestrate variant (Task tool allowed), falling back to the base
  // settings if containment generation didn't produce one; work/wrapup
  // always use the base variant.
  // I2 fix (v0.3 review): the Task-allowing variant is reserved for
  // orchestrated projects (workerModel set). A critic in a plain v0.2
  // project keeps the v0.2 settings - it gains no subagents just because
  // the variant file exists on disk.
  const orchestrated = !!project.workerModel;
  const effectiveSettingsPath =
    (kind === 'orchestrate' || (kind === 'critic' && orchestrated))
      ? orchestrateSettingsPath || settingsPath
      : settingsPath;
  const preHead = gitRevParseHead(dir);
  let preamble = buildPreamble(project, kind, order);
  const injection = consumeInjection(project, kind, cycleNumber, order);
  if (injection) {
    preamble = `${preamble}\n${preambles.injectionSection(injection, !!project.workerModel)}`;
  }

  const cmd = opts.claudeCmd && opts.claudeCmd.length ? opts.claudeCmd : defaultClaudeCmd();
  const bin = cmd[0];
  const args = cmd.slice(1).concat(['-p', '--model', project.model]);
  // Reasoning effort (code.claude.com/docs/en/model-config): passed via the
  // --effort CLI flag so it can differ per cycle (the scheduler routes the
  // orchestrator's effort to orchestrate cycles and workerEffort to worker
  // cycles by swapping project.effort). Omitted entirely when unset, so the
  // CLI default (high on current models) applies. Validated against the
  // known level set to keep an unexpected value from reaching the CLI.
  if (EFFORT_LEVELS.has(project.effort)) {
    args.push('--effort', project.effort);
  }
  args.push(
    '--permission-mode',
    'acceptEdits',
    '--settings',
    effectiveSettingsPath,
    '--output-format',
    'stream-json',
    '--verbose'
  );

  const env = Object.assign({}, process.env);
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  const maxCycleMinutes = typeof project.maxCycleMinutes === 'number' && project.maxCycleMinutes > 0
    ? project.maxCycleMinutes
    : 120;
  const maxCycleMs = maxCycleMinutes * 60 * 1000;
  const checkIntervalMs = checkIntervalFor(maxCycleMs);

  let child = null;
  let spawnError = null;
  try {
    child = spawn(bin, args, {
      cwd: dir,
      windowsHide: true,
      env,
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    spawnError = err;
  }

  let rawOutput = '';
  let resultInfo = null;
  let killReason = null; // 'timeout' | 'stopped'

  const waitForExit = new Promise((resolve) => {
    if (spawnError || !child) {
      resolve({ code: null });
      return;
    }

    let stdoutBuf = '';
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      rawOutput += text;
      stdoutBuf += text;
      let idx = stdoutBuf.indexOf('\n');
      while (idx !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line) handleStdoutLine(line);
        idx = stdoutBuf.indexOf('\n');
      }
    });

    child.stderr.on('data', (chunk) => {
      rawOutput += chunk.toString('utf8');
    });

    function handleStdoutLine(line) {
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch (err) {
        // Tolerate non-JSON lines (SPEC.md section 4): they still count
        // toward rawOutput for text classification, just not structured
        // extraction.
        return;
      }
      if (parsed && parsed.type === 'assistant') {
        for (const text of extractAssistantTexts(parsed)) {
          try {
            events.activity(dir, text.slice(0, ACTIVITY_TEXT_CHARS), 'model');
          } catch (err) {
            util.log('runner: activity() failed for', dir, String(err && err.message));
          }
        }
      } else if (parsed && parsed.type === 'result') {
        resultInfo = resultInfoFrom(parsed);
      }
    }

    let settled = false;

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      spawnError = err;
      resolve({ code: null });
    });

    // 'close' (not 'exit') so stdio streams have fully drained into
    // rawOutput/resultInfo before classification runs.
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      resolve({ code: typeof code === 'number' ? code : null });
    });

    try {
      child.stdin.write(preamble);
      child.stdin.end();
    } catch (err) {
      // Child may already be gone; classification below handles that.
    }
  });

  let killed = false;
  let pollTimer = null;
  if (child && !spawnError) {
    const stopPath = stopFilePath(dir);
    pollTimer = setInterval(() => {
      if (killed) return;
      if (fs.existsSync(stopPath)) {
        killed = true;
        killReason = 'stopped';
        treeKillSync(child);
      } else if (Date.now() - startedAt >= maxCycleMs) {
        killed = true;
        killReason = 'timeout';
        treeKillSync(child);
      }
    }, checkIntervalMs);
    if (pollTimer.unref) pollTimer.unref();
  }

  const { code } = await waitForExit;
  if (pollTimer) clearInterval(pollTimer);

  const minutes = (Date.now() - startedAt) / 60000;

  try {
    if (budget && typeof budget.scanForTripwire === 'function') {
      budget.scanForTripwire(rawOutput);
    }
  } catch (err) {
    util.log('runner: scanForTripwire threw', String(err && err.message));
  }

  let exit;
  if (killReason) {
    exit = killReason;
  } else if (resultInfo && resultInfo.isError === false) {
    exit = 'clean';
  } else if (USAGE_LIMIT_RE.test(rawOutput)) {
    exit = 'usage_limit';
    try {
      if (budget && typeof budget.noteUsageLimitExit === 'function') {
        budget.noteUsageLimitExit();
      }
    } catch (err) {
      util.log('runner: noteUsageLimitExit threw', String(err && err.message));
    }
  } else if (CONTEXT_FULL_RE.test(rawOutput)) {
    exit = 'context_full';
  } else if (spawnError || (minutes * 60 * 1000 < CRASH_WINDOW_MS && code !== 0 && !resultInfo)) {
    exit = 'crash';
  } else {
    exit = 'unknown';
  }

  let verify = null;
  try {
    verify = runVerifyGate(project);
  } catch (err) {
    util.log('runner: verify gate failed for', dir, String(err && err.message));
    verify = null;
  }

  let commit = null;
  let gitDiff = { files: 0, ins: 0, del: 0 };
  try {
    commit = gitAutoCommit(dir, cycleNumber);
    gitDiff = gitDiffStat(dir, preHead, commit);
  } catch (err) {
    util.log('runner: auto-commit step failed for', dir, String(err && err.message));
  }

  return {
    exit,
    code: code === undefined ? null : code,
    minutes,
    tokens: resultInfo ? resultInfo.tokens : { in: 0, out: 0 },
    costUsd: resultInfo ? resultInfo.costUsd : null,
    modelUsage: resultInfo ? resultInfo.modelUsage : null,
    commit,
    gitDiff,
    verify,
  };
}

module.exports = { runCycle };
