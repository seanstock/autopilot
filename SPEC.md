# Autopilot - Specification v0.2

A standalone, local-first token furnace: one daemon that runs autonomous
Claude Code work cycles against any number of project directories, governed
by a global usage budget, observable from a single localhost page.

Origin: generalization of the SpaceStations harness (2026-07-20 to 07-23).
Every design rule here that looks paranoid was paid for.

v0.2 (2026-07-23): review pass. Structured CLI output instead of text
scraping, no self-refresh of OAuth tokens, runner-enforced STOP, per-cycle
token accounting, containment honesty clause, misc hardening.

---

## 1. Goals / non-goals

Goals:
- `autopilot` in a terminal -> daemon starts -> browser opens localhost UI.
- Add a project: directory + prompt + priority. Start/stop/pause it.
- Global budget: use subscription capacity up to a ceiling (default 75% of
  any usage window), always leaving headroom for ad hoc human work.
- Standardized, trustworthy logs: the runner stamps structured events; the
  model's own narration is color, never ground truth.
- Safe by default: containment profile, git audit trail, kill switches that
  work even when the daemon is dead.
- Survives everything: reboots, crashed cycles, exhausted usage windows,
  closed browsers. Idle costs zero tokens.

Non-goals (v1): multiple machines, multiple users, databases, cloud anything,
chat-with-a-cycle, plugin systems, editing the cycle preamble per project,
tokens/hour pacing (the ceiling + window resets express everything).

---

## 2. Concepts

**Daemon.** One process = scheduler + web server + cycle runner. The UI is a
view; closing it changes nothing. Optional "start on boot" registers the
daemon itself with the OS (Task Scheduler / launchd / systemd) - that is the
ONLY OS-level scheduling in the system.

**Project.** An entry in `~/.autopilot/projects.json`:
```json
{
  "id": "spacestation",
  "dir": "C:/Users/you/Blender/SpaceStations",
  "prompt": "user's mission prompt (the 'Prime Directive' text)",
  "priority": 1,
  "enabled": true,
  "model": "claude-fable-5",
  "maxCycleMinutes": 120,
  "criticRatio": 5,
  "reviewGateCycles": 0,
  "containment": "standard",
  "mcp": ["blender"]
}
```
`mcp` lists the MCP server names the project's cycles may use (allowed as
`mcp__<name>` in the generated settings; the servers themselves come from
the user's own Claude Code config).
Per-project state lives IN the project directory (portable, survives
Autopilot itself): `PLAN.md`, `WORKLOG.md`, `UPDATES.md`, `ACTIVITY.log`,
`.autopilot/events.jsonl`, `.autopilot/STOP` (kill switch), git repo.

`UPDATES.md` is the plain-English channel: dated entries written by the
cycle for the human (what happened, what's next, what's uncertain), a few
sentences each, newest first. WORKLOG is terse bookkeeping, ACTIVITY is the
firehose; UPDATES is what you actually read over coffee. Like all model
output it is narration, not ground truth.

Entries are written at EVERY checkpoint, not at cycle end - cycles
routinely die without warning (context, caps, timeouts) and an entry never
written is work the human never hears about (learned live, 2026-07-23).
When a chain dies of usage exhaustion, the scheduler runs one short
**wrapup cycle** whose only job is a summary UPDATES entry; it knowingly
runs slightly over the cap (user-accepted; `settings.capSummary: false`
disables).

**Budget manager.** Owns the account-wide meter. Usage windows (5h/7d) are
per-account, not per-project, so ALL projects share one budget. Scheduling
rule: while every window is under `ceilingPct` and at least one project is
runnable, run exactly one cycle at a time for the highest-priority runnable
project. Round-robin among equal priorities. One cycle at a time, globally -
parallel cycles double burn without doubling insight and wreck attribution.

**Cycle.** One fresh-context headless run: `claude -p <preamble + prompt>
--model <m> --permission-mode acceptEdits --settings <generated profile>`,
cwd = project dir. Expected endings, all normal: clean finish, context-full
death, usage-limit death, timeout kill at `maxCycleMinutes`.

**Cycle contract (the injected preamble).** Fixed text, versioned with
Autopilot, not user-editable in v1. Requires the cycle to:
1. Read `PLAN.md` (rolling queue; refill it when empty by weakest-link
   audit against the mission prompt - "there is no complete" is optional per
   project: if `reviewGateCycles` > 0 the queue may instead conclude).
2. Work task after task; checkpoint after each (save artifacts, tick PLAN,
   one WORKLOG line, append human-readable ACTIVITY lines). Before ending,
   prepend a dated plain-English entry to `UPDATES.md`.
3. Never write a timestamp it did not obtain from the clock in the same task.
4. Never claim completion of work it did not verify.
5. Commit at meaningful checkpoints with a descriptive message; never
   force-push, rewrite history, or touch `.autopilot/` internals.
6. On a BLOCKED tool call, comply with the stated reason - never route
   around the guard.

**Injection.** The human steering the mission between cycles: text queued
via the UI's Inject box or `autopilot inject <id> "<text>"` lands in
`<dir>/.autopilot/INJECT.md` (daemon-owned; cycles cannot write it). The
next WORK cycle consumes it - the scheduler forces the next cycle to be
work if the critic cadence would land there - with mandatory triage: first
transcribe the directive into PLAN.md as top-priority [user directive]
tasks (survives early death), then either just do it (simple) or update
the project's living spec first and then do it (complex: multi-task or
scope/architecture implications). Consumed injections are archived to
`.autopilot/injections.log`, stamped as an `inject` event, and noted in
UPDATES.md. Multiple injections stack until consumed.

**Critic cycle.** If `criticRatio` = N > 0, every Nth cycle gets the critic
preamble instead: do no new work; independently re-derive and try to REFUTE
recent claims and artifacts; file discrepancies as PLAN items; commit
nothing else. This is the immune system against confident self-consistent
nonsense (fabricated-timeline incident, 2026-07-20).

**Review gate.** If `reviewGateCycles` = N > 0, after N cycles the project
pauses with status `awaiting-review` until the human clicks Reviewed in the
UI (or touches `.autopilot/REVIEWED`). Converts the furnace from fire-and-
forget into compounding, human-checked work.

---

## 3. Budget manager detail

- Meter: `GET https://api.anthropic.com/api/oauth/usage`, Bearer token read
  from `~/.claude/.credentials.json`. READ-ONLY: Autopilot never refreshes
  tokens and never writes that file. Refresh tokens are single-use; the
  interactive CLI rotates them on its own schedule, and two clients racing
  the same refresh token leaves one of them (possibly the human's session)
  holding a dead credential. On 401/expired, treat the meter as unavailable
  and fall to the probe gate - the next `claude` run (probe or interactive)
  refreshes the file for us. Treat the endpoint as hostile: undocumented,
  429s under polling (min 60 s between calls, exponential backoff), schema
  may change (parse defensively).
- Policy: `ceilingPct` (default 75) applies to EVERY reported window
  (five_hour, seven_day, seven_day_opus...). Over ceiling -> stop scheduling,
  record earliest `resets_at`, sleep. Poll cadence while sleeping: every 15
  minutes OR at `resets_at`, whichever is sooner. A cycle that exits
  `usage_limit` flips the manager to over-ceiling immediately - never wait
  for the next poll to learn what the exit already proved.
- Recovery: on transition from over-ceiling (or meter-dead outage) back to
  runnable, notify (OS toast + optional webhook) and wait `graceMinutes`
  (default 30) before the first cycle - the human's window to object.
- Fallback when the meter is unavailable: probe gate - one minimal
  `claude -p "OK"` at most every 15 minutes; success = runnable, failure =
  sleep. Meter recovery is retried alongside. A probe success proves the
  service answers, NOT that budget exists (claude runs fine at 90%
  utilization): a meter outage while the last good reading is over ceiling
  with `resets_at` still in the future stays classified `ceiling`, never
  `outage` - otherwise the probe "rescues" the budget and the scheduler
  flaps sleep -> grace -> sleep on every backoff window (observed live,
  2026-07-23).
- Hard rule inherited from the API-credit incident: the runner strips
  `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from every child environment,
  and any cycle output containing "Credit balance" sets a global FATAL stop
  (all projects) requiring manual clearance in the UI. The env strip is the
  real defense; the string match is a tripwire only (the message text may
  change between CLI versions, and a cycle merely quoting it trips a false
  FATAL - safe, annoying, acceptable).

---

## 4. Event log (runner-stamped ground truth)

`<project>/.autopilot/events.jsonl`, one JSON object per line, written ONLY
by the daemon with its own clock. The model cannot fabricate these.

```
{"t":"2026-07-23T07:45:53-07:00","ev":"cycle_start","cycle":41,"kind":"work|critic","project":"spacestation"}
{"t":"...","ev":"cycle_end","cycle":41,"kind":"work","model":"claude-sonnet-5","minutes":34.2,"exit":"clean|context_full|usage_limit|timeout|crash|unknown","code":1,"tokens":{"in":1183000,"out":92000},"costUsd":15.32,"gitDiff":{"files":12,"ins":410,"del":55},"commit":"abc1234"}
{"t":"...","ev":"budget","fiveHourPct":42.1,"sevenDayPct":18.0}
{"t":"...","ev":"sleep","reason":"ceiling|outage|stop|review_gate","until":"..."}
{"t":"...","ev":"grace_start","minutes":30}
{"t":"...","ev":"fatal","reason":"credit_balance_tripwire"}
```

Cycles run with `--output-format stream-json`: exit classification and token
counts come from the structured result event, never from scraped text or
exit codes alone (exit codes lie: context-full and usage-limit both return
nonzero; message strings change between CLI versions). If the stream is
unparseable, fall back to text + duration and classify `unknown` rather
than guess. Per-cycle `tokens` is the one attribution the account-wide
meter cannot give: summed across cycles it separates Autopilot burn from
the human's own work.
`ACTIVITY.log` remains the human-readable feed (daemon lines + model lines);
the UI tails it but charts only from events.jsonl.

---

## 5. Containment profile ("standard")

Generated per project at add-time into `<project>/.autopilot/`:
- `cycle_settings.json`: allow file tools, shell, web search/fetch, and MCP
  servers the project declares; deny reads of credential files, writes to
  `~/.claude`, writes to Autopilot's own files, the project's `.autopilot/`
  internals, and the project's own `.claude/` (a cycle must not be able to
  grant future cycles extra permissions or hooks).
- `guard.ps1` / `guard.sh` PreToolUse hook on shell tools, blocking by
  content: API-key usage, Anthropic endpoints, credential paths, recursive
  deletes outside the project dir, OS scheduler/system-config changes,
  edits to harness/guard files, spawning nested `claude -p`. The guard also
  blocks every tool call once `<project>/.autopilot/STOP` exists: STOP is
  runner-enforced, not a contract request, and the hook path covers the
  daemon-crashed-but-cycle-alive case. The daemon additionally kills the
  process tree when STOP appears.
- Honesty clause: content blocklists are tripwires, not boundaries. They
  stop a cooperative-but-confused model; a determined one routes around
  them (write script, run script). The real boundary is OS-level
  sandboxing, out of scope for v1 - do not oversell "standard" containment.
- Git: `git init` if absent, `.gitignore` seeded (locks, large render
  output dirs by pattern), daemon auto-commit after EVERY cycle
  ("cycle N auto-commit") regardless of what the cycle did.
- Optional per-project pins: user-designated read-only files (filesystem
  attribute, not instructions).
`containment: "off"` skips all of it, prints a red warning in the UI, and
still strips API keys (that one is not optional).

---

## 6. UI (one page, localhost, SSE)

Header: usage gauges (each window: % used, ceiling marker, reset countdown),
an "invested" tile (account-wide API-price cost + token totals across all
cycles ever run), budget ceiling slider, grace input, global pause, FATAL
banner when tripped.

Token/cost accounting: `costUsd` is the CLI-reported `total_cost_usd` -
what the same work would have cost at API prices, the natural meter for
"cost invested" on a subscription. Durable running totals (overall and
per model) live in each project's `.autopilot/state.json`, accumulated per
cycle_end and seeded once by backfill from events.jsonl (totals must
survive event-log rotation). The detail pane shows a per-model breakdown
table per project.

Project list: name, status (running cycle N / queued / sleeping until X /
awaiting-review / stopped / fatal), priority drag, start/stop/pause,
Reviewed button, links: open dir, open latest commit diff.

Detail pane per project: UPDATES.md rendered read-only (newest first, the
first thing you see), live ACTIVITY tail (SSE), cycle history table from
events.jsonl (cycle, kind, minutes, exit, diff stats, commit link), PLAN.md
rendered read-only. Light/dark theme toggle, dark default.

Add-project form: directory picker, prompt textarea, priority, model,
critic ratio, review gate, containment toggle. That is the whole form.

No auth in v1; bind 127.0.0.1 only, and reject any request whose Host
header is not localhost (DNS rebinding reaches 127.0.0.1 with the user's
browser as the proxy, and this page has pause/review controls).

---

## 7. CLI

```
autopilot                  start daemon (if not running) + open UI
autopilot add <dir>        interactive add (or --prompt, --priority flags)
autopilot list             projects + status, one line each
autopilot stop [id]        stop one project, or the daemon with no id
autopilot logs <id>        tail ACTIVITY.log
autopilot inject <id> <t>  queue a user directive for the next work cycle
autopilot boot on|off      register/unregister daemon autostart with the OS
```
`autopilot stop` must also work by hand with the daemon dead: document that
touching `<project>/.autopilot/STOP` stops that project (the guard hook
blocks all tool calls once it exists, the daemon kills the running cycle
and checks it before scheduling).

---

## 8. Implementation notes

- Single process, minimal deps. Node (single file + one static HTML) or
  Python (FastAPI + one static HTML). SSE, not websockets. No build step
  for the UI.
- State: `~/.autopilot/projects.json` + per-project files. No DB.
- Rotate `events.jsonl` and `ACTIVITY.log` (size cap ~10 MB, keep a few
  archives); both grow forever otherwise.
- The runner is a port of harness.ps1's chain loop with the lessons kept:
  stale-PID overlap lock; crash-loop guard (3 fast failures -> project
  cooldown 15 min, not a global stop); timeout kill at maxCycleMinutes
  (kill process tree, classify "timeout", commit whatever landed).
- Windows: anything executed by PowerShell 5.1 must be ASCII or UTF-8 with
  BOM (em-dash parse bug, 2026-07-20). Spawn hidden (no console flash).
- Verify end-to-end in the daemon's actual environment before calling any
  piece done: auth path, encoding, first real cycle. "Should work" caused
  every failure this spec descends from.

## 9. Milestones

- M1 (walking skeleton): daemon + one project + meter/ceiling + cycle loop
  + events.jsonl + auto-commit + plain-text status page. No form, config by
  editing projects.json. This alone replaces harness.ps1.
- M2: full UI (gauges, tail, history, add form), toasts, grace flow,
  critic cycles, review gate.
- M3: containment generator, boot registration, probe fallback, FATAL flow,
  multi-project priorities. Migrate SpaceStations onto it and retire the
  bespoke harness.
