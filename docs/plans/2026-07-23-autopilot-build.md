# Autopilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Autopilot v1 per SPEC.md v0.2: a single Node daemon that runs autonomous Claude Code cycles against registered project directories, governed by an account-wide usage budget, observable from a localhost UI.

**Architecture:** One Node process = scheduler + HTTP/SSE server + cycle runner. State is flat files (`~/.autopilot/projects.json` + per-project files). The runner spawns `claude -p` headless cycles with `--output-format stream-json` and stamps ground-truth events; the UI is a static HTML page fed by REST + SSE. No database, no build step, zero npm dependencies.

**Tech Stack:** Node 22 (CommonJS, built-in `node:test`, `node:http`, `node:child_process`). Windows-first (PowerShell 5.1 constraints apply to generated scripts). Git for the audit trail.

## Global Constraints

- Zero npm dependencies. Node built-ins only. No build step. CommonJS (`require`).
- Read SPEC.md (repo root) before implementing. It is the product spec; this plan is the module contract.
- Windows-first: all spawned children use `windowsHide: true`; generated `.ps1` files must be pure ASCII (PS 5.1 em-dash parse bug); process-tree kill uses `taskkill /PID <pid> /T /F`.
- Autopilot NEVER writes `~/.claude/.credentials.json` (read-only; single-use refresh tokens).
- The runner strips `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from every child env, even with containment off.
- Daemon port: **4680**, bind `127.0.0.1` only, reject requests whose Host header is not `localhost:4680` / `127.0.0.1:4680`.
- All daemon-stamped timestamps come from `util.nowIso()` (local time with offset).
- Every module gets `node:test` tests in `test/<module>.test.js`. Run with `node --test test/`.
- Commit after each task: `git add -A && git commit -m "<task>: <summary>"`.
- File layout (repo root = the Autopilot checkout):

```
autopilot.js        CLI entry + daemon bootstrap
src/util.js         paths, atomic writes, time, logging
src/state.js        projects.json + per-project runtime state
src/events.js       events.jsonl + ACTIVITY.log append/read
src/preambles.js    cycle contract + critic preamble text
src/containment.js  settings/guard generation, git init
src/budget.js       usage meter, ceiling policy, fatal latch
src/notify.js       Windows toast + webhook (best effort)
src/runner.js       one cycle: spawn, parse, classify, commit
src/scheduler.js    main loop, priorities, gates, grace
src/server.js       HTTP + SSE + static UI
ui/index.html       the real UI (adapted from ui-mockup.html)
test/*.test.js      node:test suites
test/fake-claude.js stream-json emitter for runner tests
```

### Shared contracts (every task reads this)

**Paths:** `AUTOPILOT_HOME = ~/.autopilot`. Per project: `<dir>/.autopilot/` holds `events.jsonl`, `state.json`, `cycle_settings.json`, `guard.ps1`, `guard.sh`, `STOP`, `REVIEWED`. Human files at project root: `PLAN.md`, `WORKLOG.md`, `UPDATES.md`, `ACTIVITY.log`.

**`~/.autopilot/projects.json`** (atomic writes, created on demand):
```json
{
  "settings": { "ceilingPct": 75, "graceMinutes": 30, "webhook": null, "port": 4680 },
  "projects": [ { "id": "spacestation", "dir": "C:/abs/path", "prompt": "...",
    "priority": 1, "enabled": true, "model": "claude-sonnet-5",
    "maxCycleMinutes": 120, "criticRatio": 5, "reviewGateCycles": 0,
    "containment": "standard" } ]
}
```

**`<dir>/.autopilot/state.json`** (owned by state.js helpers, written by scheduler):
```json
{ "cycle": 41, "sinceReview": 3, "failTimes": ["iso", "iso"], "cooldownUntil": null }
```

**`~/.autopilot/fatal.json`**: `{ "reason": "credit_balance_tripwire", "t": "iso" }` — presence = FATAL latched; deleted only by explicit clear.

**Exit classifications** (string enum used everywhere): `clean | context_full | usage_limit | timeout | crash | stopped | unknown`.

**Event vocabulary** (events.jsonl lines; `t`, `project` stamped automatically): `cycle_start {cycle, kind}`, `cycle_end {cycle, kind, minutes, exit, code, tokens:{in,out}, costUsd, gitDiff:{files,ins,del}, commit}`, `budget {windows:[{name,pct,resetsAt}]}`, `sleep {reason: ceiling|outage|stop|review_gate|paused|cooldown, until}`, `grace_start {minutes}`, `fatal {reason}`, `reviewed {}`.

**Status snapshot** (scheduler → server → UI; shape the UI codes against):
```json
{ "daemon": { "pid": 123, "startedIso": "...", "version": "0.2.0", "paused": false },
  "fatal": null,
  "budget": { "ok": true, "reason": null, "checkedIso": "...",
              "windows": [{ "name": "five_hour", "pct": 42.1, "resetsAt": "iso" }] },
  "settings": { "ceilingPct": 75, "graceMinutes": 30, "webhook": null },
  "current": { "projectId": "spacestation", "cycle": 41, "kind": "work", "startedIso": "..." },
  "projects": [ { ...projectConfig, "status": "running|queued|sleeping|awaiting-review|stopped|cooldown|fatal",
                  "statusDetail": "cycle 41 (work)", "cycle": 41, "sinceReview": 3,
                  "lastExit": "clean", "lastCommit": "abc1234" } ] }
```

**HTTP API** (server.js implements, ui + cli consume):
- `GET /` → `ui/index.html`; `GET /api/status` → snapshot above.
- `GET /api/stream` → SSE; events: `status` (full snapshot JSON, sent on any change and every 5 s), `activity` (`{"project":"id","line":"..."}` per appended ACTIVITY line).
- `GET /api/projects/:id/activity?lines=200` → `{ lines: ["..."] }`.
- `GET /api/projects/:id/events?limit=100` → `{ events: [...] }` (parsed events.jsonl, newest last).
- `GET /api/projects/:id/file?name=PLAN.md|UPDATES.md|WORKLOG.md` → `{ name, content }` (whitelist only).
- `POST /api/projects` body = project config minus id (id derived from dir basename, deduped).
- `POST /api/projects/:id/start | stop | reviewed` ; `POST /api/projects/:id/priority {priority}`.
- `POST /api/pause` / `POST /api/resume` (global); `POST /api/settings {ceilingPct?, graceMinutes?, webhook?}`; `POST /api/fatal/clear`.
- All POSTs return the fresh status snapshot. Non-localhost Host header → 403.

---

### Task 1: Foundation — util, state, events

**Files:** Create `src/util.js`, `src/state.js`, `src/events.js`, `test/util.test.js`, `test/state.test.js`, `test/events.test.js`.

**Produces (exact exports):**
- util: `AUTOPILOT_HOME`, `nowIso()` (ISO 8601 with local offset, e.g. `2026-07-23T07:45:53-07:00`), `ensureDir(dir)`, `atomicWrite(file, str)` (tmp+rename), `readJson(file, fallback)`, `writeJson(file, obj)` (atomic, 2-space), `log(...args)` (stamped stderr), `projectMeta(dir)` → `path.join(dir, '.autopilot')`.
- state: `load()` → full projects.json object (defaults filled, validated: dir must exist and be absolute; bad entries dropped with a log line), `save(stateObj)`, `getProject(stateObj, id)`, `addProject(stateObj, {dir, prompt, priority, model, criticRatio, reviewGateCycles, containment})` → new project (id = kebab-cased dir basename, `-2` suffix on collision; defaults: priority 1, model `claude-sonnet-5`, maxCycleMinutes 120, criticRatio 5, reviewGateCycles 0, containment `standard`), `readRuntime(dir)` → state.json with defaults `{cycle:0, sinceReview:0, failTimes:[], cooldownUntil:null}`, `writeRuntime(dir, obj)`, `readFatal()` / `writeFatal(reason)` / `clearFatal()`.
- events: `appendEvent(dir, projectId, ev, fields)` (stamps `t`, `project`, appends JSONL, creates dirs), `readEvents(dir, limit=100)` (tolerates corrupt lines), `activity(dir, line, who='daemon')` (appends `[<iso>] [<who>] <line>\n`), `tailActivity(dir, lines=200)`, `onActivity(cb)` / emitted for every `activity()` call (module-level EventEmitter; runner pipes model lines through `activity()` with who='model').

- [ ] Write failing tests: atomicWrite survives partial write (write, read back), nowIso matches `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/`, addProject id collision → `-2`, readRuntime defaults, appendEvent stamps t/project, readEvents skips a corrupt line, activity emits via onActivity. Use temp dirs (`fs.mkdtempSync`), never touch real `~/.autopilot` (support env override `AUTOPILOT_HOME_OVERRIDE` in util).
- [ ] Run `node --test test/` → FAIL. Implement. Run → PASS. Commit `task1: foundation modules`.

### Task 2: Preambles + containment generator

**Files:** Create `src/preambles.js`, `src/containment.js`, `test/containment.test.js`.

**Consumes:** util (`atomicWrite`, `projectMeta`).
**Produces:**
- preambles: `PREAMBLE_VERSION` (string `"1"`), `workPreamble(project)` → full injected preamble implementing SPEC §2 cycle contract items 1-6 verbatim in intent (PLAN.md queue + refill by weakest-link audit, honor reviewGateCycles conclude-option, checkpoint after each task, WORKLOG line + ACTIVITY lines + prepend dated UPDATES.md entry before ending, real clock timestamps only, verify before claiming, commit at checkpoints, never force-push / rewrite history / touch `.autopilot/`, obey BLOCKED), then the user's mission prompt under a `## Mission` heading. `criticPreamble(project)` → refute-recent-claims contract (no new work; re-derive and try to REFUTE recent WORKLOG/UPDATES claims and artifacts; file discrepancies as PLAN.md items; commit only PLAN/UPDATES edits).
- containment: `ensureContainment(project)` → generates into `<dir>/.autopilot/`: (a) `cycle_settings.json` — Claude Code settings JSON: `permissions.deny` covering `Read(<home>/.claude/**)`, `Read(**/.credentials.json)`, `Write|Edit(<home>/.claude/**)`, `Write|Edit(<dir>/.autopilot/**)`, `Write|Edit(<dir>/.claude/**)`, `Write|Edit(<repo autopilot install dir>/**)`; `hooks.PreToolUse` matcher `Bash` → command `powershell -NoProfile -ExecutionPolicy Bypass -File <dir>/.autopilot/guard.ps1` on win32 (guard.sh via bash otherwise); (b) `guard.ps1` + `guard.sh` — read hook JSON from stdin, extract `.tool_input.command`, block (exit 2, reason on stderr prefixed `BLOCKED:`) when it matches: STOP file exists (block ALL commands), `ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|x-api-key`, `api.anthropic.com|console.anthropic.com`, `\.credentials\.json|\.claude[/\\]`, recursive delete targeting outside the project dir (`rm -rf /`, `Remove-Item -Recurse` on paths not under the project), `schtasks|systemctl|launchctl|reg add`, edits to `guard\.(ps1|sh)|cycle_settings\.json|autopilot\.js`, `claude\s+(-p|--print)`; ASCII only, PS 5.1 compatible; (c) git init if no `.git`, seed `.gitignore` (`*.blend1`, `renders/`, `output/`, `*.tmp`, `node_modules/`) only if absent; (d) returns `{settingsPath}`. `containment: "off"` → settings with hooks + guard STOP check ONLY (STOP enforcement is never optional), no deny list, and the function returns `{settingsPath, warning: "containment off"}`.

- [ ] Failing tests: generated guard.ps1 is ASCII (`/^[\x00-\x7F]*$/` on file bytes); guard.sh blocks `curl api.anthropic.com` (spawn `bash guard.sh` with hook JSON on stdin where available, else assert regex list); STOP file → guard blocks `echo hi`; settings JSON parses and denies `.claude` writes; git repo initialized in temp dir; preambles contain the strings `PLAN.md`, `UPDATES.md`, `never force-push`, and the mission prompt.
- [ ] Implement, pass, commit `task2: preambles + containment`.

### Task 3: Budget manager + notify

**Files:** Create `src/budget.js`, `src/notify.js`, `test/budget.test.js`.

**Consumes:** util, state (`readFatal`/`writeFatal`/`clearFatal`).
**Produces:**
- budget: `class BudgetManager { constructor({settings, fetchImpl, credPath}) }` (injectable fetch + credential path for tests; defaults: global fetch, `~/.claude/.credentials.json`). Methods: `async check()` → `{ ok, reason: null|'ceiling'|'outage'|'fatal', windows, resetsAt, checkedIso }` — reads access token (parse credentials defensively: find any `accessToken` string; on missing/401 → outage), GETs `https://api.anthropic.com/api/oauth/usage` with `Authorization: Bearer` + `anthropic-beta: oauth-2025-04-20`, parses defensively: any object entries carrying `utilization` (0-100 or 0-1, normalize to pct) and `resets_at`; min 60 s between real calls (cache result), exponential backoff on 429 (60s→120s→240s… cap 15 min). NEVER writes the credential file. `overCeiling(windows)` → true if any window pct >= settings.ceilingPct. `noteUsageLimitExit()` → force `ok:false, reason:'ceiling'` until next successful poll past `resetsAt`. `scanForTripwire(text)` → if `/credit balance/i` → `writeFatal('credit_balance_tripwire')`, returns boolean. `isFatal()` / `clearFatal()`. `async probeGate(spawnImpl)` → spawns `claude -p "OK" --model claude-haiku-4-5-20251001` (2 min timeout, stripped env) → `{ok}`; used by scheduler at most every 15 min when meter is in outage.
- notify: `notify(title, body, settings)` → fire-and-forget: win32 toast via `powershell -NoProfile -Command` WinRT ToastNotificationManager (swallow all errors), plus `POST settings.webhook` JSON `{title, body, t}` if set.

- [ ] Failing tests with injected fetch: normalizes `utilization: 0.42` and `42` both → 42; ceiling at exactly 75 with ceilingPct 75 → over; 429 → backoff grows, no second real call within window; missing credentials → `{ok:false, reason:'outage'}`; `noteUsageLimitExit` forces not-ok; `scanForTripwire('Credit balance too low')` latches fatal (readFatal non-null) and stays latched across new instance; clearFatal releases. Assert the credentials file is never opened for writing (inject credPath to a temp file, check mtime/content unchanged).
- [ ] Implement, pass, commit `task3: budget + notify`.

### Task 4: Cycle runner

**Files:** Create `src/runner.js`, `test/fake-claude.js`, `test/runner.test.js`.

**Consumes:** util, events (`appendEvent`, `activity`), preambles, containment (`ensureContainment`), budget instance (only `scanForTripwire` + `noteUsageLimitExit`).
**Produces:** `async runCycle({project, kind, cycleNumber, budget, claudeCmd})` → `{ exit, code, minutes, tokens: {in, out}, costUsd, commit, gitDiff: {files, ins, del} }`.

Behavior contract:
1. `ensureContainment(project)`; record `preHead = git rev-parse HEAD` (null if unborn).
2. Build preamble (`kind === 'critic' ? criticPreamble : workPreamble`).
3. Spawn — `claudeCmd` default `['cmd','/c','claude']` on win32, `['claude']` posix (injectable for tests as `['node', 'test/fake-claude.js', ...]`): args `-p --model <project.model> --permission-mode acceptEdits --settings <settingsPath> --output-format stream-json --verbose`, prompt written to child **stdin** then stdin ended (avoids arg quoting/length limits), `cwd: project.dir`, `windowsHide: true`, `env`: process.env minus `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`.
4. Parse stdout as NDJSON, tolerate non-JSON lines. `type:"assistant"` → extract text blocks → `activity(dir, text, 'model')` (first 400 chars per block). `type:"result"` → capture `subtype`, `is_error`, `usage.input_tokens/output_tokens` (+ cache reads into `in`), `total_cost_usd`. Feed ALL text (stdout+stderr) through `budget.scanForTripwire`.
5. Kill conditions, checked every 5 s: `maxCycleMinutes` elapsed → tree-kill → exit `timeout`; `<dir>/.autopilot/STOP` exists → tree-kill → exit `stopped`. Tree-kill: win32 `taskkill /PID <pid> /T /F`, posix `process.kill(-pid, 'SIGKILL')` (spawn detached on posix).
6. Classify (in order): killed→timeout/stopped as above; result with `is_error:false` → `clean`; combined output matches `/usage limit|rate limit|hit your limit|out of extended usage/i` → `usage_limit` (also call `budget.noteUsageLimitExit()`); matches `/context window|prompt is too long|context low|ran out of context/i` → `context_full`; spawn error or exited <120 s with nonzero and no result line → `crash`; else `unknown`.
7. Auto-commit regardless of exit: `git add -A; git commit -m "cycle <N> auto-commit [autopilot]"` (skip if nothing staged); `commit` = new short HEAD or null; `gitDiff` from `git diff --numstat <preHead>..HEAD` summed (all zeros when preHead null or no commit).
8. Caller (scheduler) stamps cycle_start/cycle_end events; runner returns data only. All git/spawn failures are caught and folded into the return value, never thrown.

`test/fake-claude.js`: reads stdin, then emits scripted stream-json lines based on env `FAKE_MODE` = `clean|usage_limit|context_full|hang|credit`: clean → assistant line + result success with usage `{input_tokens: 1000, output_tokens: 200}`; usage_limit → text "You've hit your limit" then exit 1; context_full → "prompt is too long" exit 1; hang → sleep 600 s (for timeout/STOP tests, short maxCycleMinutes); credit → prints "Credit balance is too low" exit 1.

- [ ] Failing tests (git available in temp dirs; init a repo, one seed commit): clean mode → exit clean, tokens.in 1000, a commit exists containing a file the fake wrote? (fake writes `out.txt` in cwd before result) and gitDiff.files >= 1; usage_limit mode → exit usage_limit and budget mock's noteUsageLimitExit called; context_full classified; hang + maxCycleMinutes tiny (inject `maxCycleMs` override for tests: runner accepts `project.maxCycleMinutes` fractional) → timeout, process actually dead; STOP file created mid-run → stopped; credit mode → budget.scanForTripwire fired (mock returns true) and cycle still returns; env passed to child lacks ANTHROPIC_API_KEY (fake echoes env to a file).
- [ ] Implement, pass, commit `task4: cycle runner + fake claude`.

### Task 5: UI

**Files:** Create `ui/index.html` (adapt `ui-mockup.html` — keep its visual design, tokens, theme switcher with blue light-mode accent, layout, cards, exactly).

**Consumes:** HTTP API + SSE contract from Shared contracts. No frameworks, no build, single file.

Wiring contract: on load `GET /api/status` → render; open `EventSource('/api/stream')`; `status` event → re-render header gauges, project list, statuses (preserve selected project + scroll); `activity` event → if it matches selected project, append to tail (cap 500 lines, autoscroll unless user scrolled up). Detail pane fetches on select: `/activity`, `/events`, `/file?name=UPDATES.md`, `/file?name=PLAN.md`. Buttons POST to the API and rerender from the returned snapshot: start/stop/Reviewed/priority, global pause/resume, ceiling slider (`/api/settings` on change end), grace input, FATAL banner with Clear button (`/api/fatal/clear`). Add-project modal POSTs `/api/projects`; directory field is a plain text path input (browsers cannot pick native dirs). Empty states: no projects → centered hint with the CLI add command. Render UPDATES.md/PLAN.md as escaped text with minimal md rendering (headings bold, `- [x]` checkboxes) — no innerHTML of raw file content (XSS: file content is model-written).

- [ ] Verify by serving statically against a hand-written mock JSON (include a tiny `ui/mock-status.json` used only when `location.search` contains `?mock=1`, fetch falls back to it). Open in browser, both themes, all states visible. Commit `task5: live UI`.

### Task 6: Scheduler

**Files:** Create `src/scheduler.js`, `test/scheduler.test.js`.

**Consumes:** state, events, budget (instance), runner (`runCycle` injectable), notify.
**Produces:** `class Scheduler { constructor({stateObj, budget, runCycleImpl, notifyImpl, tickMs=5000}) }`; `start()` / `async stopDaemon()`; EventEmitter emitting `status` (snapshot) on every change; `snapshot()` → Status snapshot (Shared contracts); command methods used by server: `pauseAll/resumeAll/startProject(id)/stopProject(id)/markReviewed(id)/setPriority(id,n)/addProject(cfg)/updateSettings(patch)/clearFatal()`.

Loop contract (single async loop, never two cycles at once):
1. If fatal latched → status fatal for all, idle (no cycles) until `clearFatal`.
2. If paused → idle. If a project's `.autopilot/STOP` exists → status stopped (and `stopProject` creates STOP; `startProject` deletes STOP).
3. `budget.check()`; not ok → `sleep` event (reason ceiling/outage, until = resetsAt or +15 min), poll cadence per SPEC §3; on outage use `probeGate` at most every 15 min. On transition not-ok → ok: `notify()`, `grace_start` event, wait graceMinutes before first cycle (skipped when resume was manual).
4. Runnable = enabled, no STOP, not awaiting-review, cooldownUntil past. Review gate: `reviewGateCycles > 0 && sinceReview >= reviewGateCycles` → awaiting-review until `markReviewed` or `.autopilot/REVIEWED` file exists (consume+delete it). Pick lowest priority number; round-robin among equals (persist rotation index in memory).
5. Run cycle: cycle N = runtime.cycle + 1; kind = critic when `criticRatio > 0 && N % criticRatio === 0`; stamp `cycle_start`, await runCycle, stamp `cycle_end` with its result, update runtime (cycle++, sinceReview++, failTimes push on crash — 3 crashes within 15 min → cooldownUntil now+15 min, `sleep {reason:'cooldown'}`, NOT a global stop; clear failTimes on clean).
6. Overlap lock: `~/.autopilot/daemon.pid` written at start; on boot, if pid alive → refuse to start second daemon (CLI reports "already running"); stale pid → overwrite.

- [ ] Failing tests with injected fake runCycle/budget/notify (tickMs 20): one-at-a-time (two projects, slow fake runCycle, assert no overlap flag), priority order + round-robin among equals, critic every Nth, review gate pauses at N and Reviewed resumes, crash-loop cooldown after 3 fast crashes while OTHER project keeps running, ceiling → sleep event and no runCycle calls, usage_limit exit → immediate sleep next tick, fatal from budget → everything idles, grace wait after recovery (assert notify called + delay observed with fake timers or tiny graceMinutes).
- [ ] Implement, pass, commit `task6: scheduler`.

### Task 7: Server + CLI + daemon bootstrap

**Files:** Create `src/server.js`, `autopilot.js`, `package.json` (`{"name":"autopilot","version":"0.2.0","bin":{"autopilot":"./autopilot.js"},"private":true}`), `test/server.test.js`.

**Consumes:** scheduler instance (all command methods + `snapshot()` + `status` event), events (`onActivity`, `tailActivity`, `readEvents`), state.
**Produces:**
- server: `startServer({scheduler, port})` → binds `127.0.0.1`, implements the full HTTP API from Shared contracts. SSE: heartbeat comment every 15 s, `status` on scheduler event + every 5 s, `activity` from `events.onActivity`. Host-header check → 403. Static: `/` and `/index.html` from `ui/`. 404 JSON otherwise. Returns `{server, close()}`.
- autopilot.js CLI (`node autopilot.js <cmd>`; also works via `npm link` bin):
  - no args → if daemon not running (GET /api/status fails), spawn detached hidden `node autopilot.js daemon` (stdio ignore, unref), wait for /api/status (10 s), then `start http://127.0.0.1:4680` (win32 `cmd /c start`), print status line.
  - `daemon` → run scheduler + server in foreground (this is what the spawn and boot-task run).
  - `add <dir> [--prompt "..."] [--priority n] [--model m] [--critic n] [--gate n] [--containment standard|off]` → POST to daemon if up, else edit projects.json directly via state. Missing prompt → read multiline from stdin ("End with Ctrl+Z newline on Windows").
  - `list` → one line per project: `id  status  prio  cycle  lastExit` (from /api/status; daemon down → read files, status `daemon-down`).
  - `stop [id]` → with id: POST stop, fallback touch `<dir>/.autopilot/STOP`; no id: POST /api/shutdown (add endpoint: graceful stop daemon) fallback kill pid from daemon.pid.
  - `logs <id>` → print `tailActivity` then poll-append every 2 s (Ctrl+C to quit).
  - `boot on|off` → win32 `schtasks /Create /TN Autopilot /TR "\"<node>\" \"<abs autopilot.js>\" daemon" /SC ONLOGON /RL LIMITED /F` / `schtasks /Delete /TN Autopilot /F`; non-win32 → print "not implemented for this OS".
- [ ] Failing tests (real server on ephemeral port, injected minimal fake scheduler): /api/status returns snapshot; bad Host header → 403; POST /api/projects/:id/start calls scheduler method; SSE stream delivers a status event (read a chunk, assert `event: status`); /api/projects/:id/file rejects `name=../../secret` and non-whitelisted names.
- [ ] Implement, pass, commit `task7: server + cli`.

### Task 8: Integration verification (orchestrator-led)

- [ ] `node --test test/` all green.
- [ ] End-to-end with fake claude: temp project dir, projects.json pointing at it, `runCycleImpl` default but `claudeCmd` overridden to fake-claude clean mode; start daemon on test port; assert: cycle runs, events.jsonl has cycle_start/cycle_end, auto-commit exists, /api/status shows it, SSE emits, STOP file stops it.
- [ ] Real-environment smoke (SPEC §8: "verify in the daemon's actual environment"): scratch project, trivial one-task prompt, `maxCycleMinutes: 5`, real `claude` — one real cycle end-to-end; verify auth path, encoding, UPDATES.md written, commit exists.
- [ ] Final commit + update SPEC.md milestone checkboxes.

## Self-Review (done)

Spec coverage: §2 concepts→tasks 1/2/6; §3 budget→task 3 (+usage_limit fast-flip in 4/6); §4 events→tasks 1/4/6; §5 containment→task 2; §6 UI→task 5; §7 CLI→task 7; §8 notes→global constraints + task 8. Type consistency: exit enum, snapshot shape, and API paths pinned once in Shared contracts and referenced everywhere.
