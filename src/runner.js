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
const { spawn, execFileSync } = require('child_process');

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
    return { settingsPath: null };
  }
}

function buildPreamble(project, kind) {
  try {
    if (kind === 'critic') return preambles.criticPreamble(project);
    if (kind === 'wrapup') return preambles.wrapupPreamble(project);
    return preambles.workPreamble(project);
  } catch (err) {
    util.log('runner: preamble build failed', String(err && err.message));
    return '';
  }
}

// User directive injection: <dir>/.autopilot/INJECT.md is written by the
// daemon (UI/CLI) between cycles. Only WORK cycles consume it (critic does
// no new work; wrapup must stay minimal - the scheduler additionally
// forces the next cycle to be work while an injection is pending). On
// consumption the text is archived to .autopilot/injections.log and the
// file is cleared, so a directive is delivered exactly once.
function consumeInjection(project, kind, cycleNumber) {
  if (kind !== 'work') return null;
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
  };
}

/**
 * Run one headless claude cycle.
 *
 * @param {object} opts
 * @param {object} opts.project - project config (dir, model, prompt, maxCycleMinutes, ...).
 * @param {'work'|'critic'} opts.kind
 * @param {number} opts.cycleNumber - used only in the auto-commit message.
 * @param {object} opts.budget - only .scanForTripwire(text) and
 *   .noteUsageLimitExit() are called; inject a mock in tests.
 * @param {string[]} [opts.claudeCmd] - command + leading args, e.g.
 *   ['cmd','/c','claude'] or [process.execPath, 'test/fake-claude.js'].
 *   Defaults to ['cmd','/c','claude'] on win32, ['claude'] elsewhere.
 * @returns {Promise<{exit:string, code:number|null, minutes:number,
 *   tokens:{in:number,out:number}, costUsd:number|null,
 *   commit:string|null, gitDiff:{files:number,ins:number,del:number}}>}
 *   Never rejects/throws - every failure folds into this return shape.
 */
async function runCycle(opts) {
  const { project, kind, cycleNumber, budget } = opts || {};
  const dir = project.dir;
  const startedAt = Date.now();

  const { settingsPath } = safeEnsureContainment(project);
  const preHead = gitRevParseHead(dir);
  let preamble = buildPreamble(project, kind);
  const injection = consumeInjection(project, kind, cycleNumber);
  if (injection) {
    preamble = `${preamble}\n${preambles.injectionSection(injection)}`;
  }

  const cmd = opts.claudeCmd && opts.claudeCmd.length ? opts.claudeCmd : defaultClaudeCmd();
  const bin = cmd[0];
  const args = cmd.slice(1).concat([
    '-p',
    '--model',
    project.model,
    '--permission-mode',
    'acceptEdits',
    '--settings',
    settingsPath,
    '--output-format',
    'stream-json',
    '--verbose',
  ]);

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
    commit,
    gitDiff,
  };
}

module.exports = { runCycle };
