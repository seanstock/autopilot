# Autopilot

A local-first token furnace: one daemon that runs autonomous Claude Code
work cycles against any number of project directories, governed by a global
usage budget, observable from a single localhost page.

You give it a project directory and a mission prompt. It runs fresh-context
`claude -p` cycles against that project back to back while your subscription
has headroom, sleeps when it doesn't, commits everything to git, and writes
plain-English progress notes you can read over coffee.

Zero npm dependencies. Node built-ins only. No build step. State is flat
files. Windows-first (POSIX mostly works; `boot` autostart is Windows-only).

## Requirements

- Node 22+
- git
- [Claude Code](https://claude.com/claude-code) CLI, logged in with a
  subscription account (Autopilot reads the usage meter; it never spends
  API credits and strips `ANTHROPIC_API_KEY` from every cycle)

## Quickstart

```
git clone <this repo> autopilot
cd autopilot
node autopilot.js add C:/path/to/your-project
node autopilot.js
```

The last command starts the daemon (detached) and opens the UI at
http://127.0.0.1:4680. On Windows, point a shortcut at `launcher.vbs` for a
double-clickable launcher with no console flash (`autopilot.ico` included).

## CLI

```
autopilot                  start daemon (if not running) + open UI
autopilot daemon           run in the foreground
autopilot add <dir>        register a project (or use the UI's Add form)
autopilot list             projects + status, one line each
autopilot stop [id]        stop one project, or the daemon with no id
autopilot logs <id>        tail a project's ACTIVITY.log
autopilot inject <id> <t>  queue a user directive for the next work cycle
autopilot boot on|off      autostart the daemon at login (Windows)
```

Kill switch that works even with the daemon dead: create
`<project>/.autopilot/STOP`. The permission guard blocks every tool call of
a running cycle the moment that file exists.

## How it works

- **Budget manager** polls the account usage meter and schedules cycles only
  while every usage window is under a ceiling (default 75%), leaving the
  rest for your own interactive work. Over ceiling it sleeps until the
  window resets, sends one toast, waits a grace period, and resumes.
- **Cycles** are headless fresh-context Claude Code runs. A versioned
  preamble makes them work a rolling `PLAN.md` queue, checkpoint after every
  task, write dated plain-English entries to `UPDATES.md`, never fabricate
  timestamps, and never claim unverified work.
- **Critic cycles** (every Nth) do no new work: they independently try to
  refute recent claims and file discrepancies back into the plan.
- **Injection**: queue a directive between cycles (UI box, CLI, or
  `<project>/.autopilot/INJECT.md`). The next work cycle triages it: simple
  means just do it; complex means update the project's spec first.
- **Containment**: generated per project - permission deny rules plus a
  PreToolUse guard hook that blocks credential access, Anthropic endpoints,
  nested `claude -p`, system-config changes, and out-of-project recursive
  deletes. Treat it as a tripwire against a confused model, not a security
  boundary against a determined one.
- **Ground truth**: the daemon stamps `events.jsonl` per project with its
  own clock (cycle start/end, exit class, tokens, diff stats, commits).
  Model narration is color, never truth. The daemon also auto-commits after
  every cycle, whatever happened.

All Autopilot state lives in `~/.autopilot/` (registry, settings, daemon
log) and `<project>/.autopilot/` (events, runtime state, generated
containment). Nothing machine-specific lives in this repo.

## Configuration

`~/.autopilot/projects.json`:

```json
{
  "settings": { "ceilingPct": 75, "graceMinutes": 30, "capSummary": true,
                "webhook": null, "port": 4680 },
  "projects": [ { "id": "my-project", "dir": "C:/Users/you/my-project",
    "prompt": "the mission text every cycle reads",
    "priority": 1, "enabled": true, "model": "claude-sonnet-5",
    "maxCycleMinutes": 120, "criticRatio": 5, "reviewGateCycles": 0,
    "containment": "standard", "mcp": [] } ]
}
```

`reviewGateCycles: N` pauses the project every N cycles until you click
Reviewed. `mcp` lists MCP server names cycles may use (servers themselves
come from your own Claude Code config). `capSummary` runs one short
over-cap wrapup cycle when usage runs out mid-chain, so you always get a
final summary entry.

## Tests

```
npm test           # unit suite (serial on purpose)
node test/e2e.js   # end-to-end against a scripted fake claude (no tokens)
node test/smoke.js # one REAL minimal cycle (spends a few cents of usage)
```

## Caveats

- The usage meter endpoint is undocumented and treated as hostile: parsed
  defensively, rate-limited, and backed by a probe fallback. It can change.
- The full design rationale, including the incidents each rule was paid
  for by, is in [SPEC.md](SPEC.md).
