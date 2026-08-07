# Experiments Framework — Design

Date: 2026-08-07. Status: approved verbally, pending Sean's review of this doc.

## Purpose

Run the same mission N times with per-run setting variations (model, worker
model, effort, prompt tweaks) and compare the results, entirely from the UI.
First use case: 5 variants each building a website for therobotshome.com,
capped at 5 cycles per variant. A/A tests (identical variants) must be as
easy as A/B tests.

## Non-goals

- No statistical analysis, scoring, or auto-judging (a judge pass can be a
  later addition; nothing here should preclude it).
- No new cycle mechanics: variants run as ordinary projects under all
  existing budget, containment, STOP, and logging rules.
- No cloud, no domain purchase, no deployment. The domain exists only as
  prompt text.

## Concepts

**Experiment.** A named group of variant projects sharing a base mission
prompt and a per-variant cycle cap. Stored in `~/.autopilot/experiments.json`:

```json
{
  "id": "robots-home-1",
  "name": "The Robots' Home v1",
  "basePrompt": "…mission text…",
  "cycleCap": 5,
  "created": "2026-08-07T…",
  "variants": [
    {
      "label": "sonnet-baseline",
      "projectId": "exp-robots-home-1-sonnet-baseline",
      "overrides": { "model": "claude-sonnet-5" },
      "promptSuffix": ""
    }
  ]
}
```

**Variant.** One ordinary project in `projects.json`, created by the
experiment, with two extra fields: `experimentId` and `maxCycles`. Its
prompt is `basePrompt + "\n\n" + promptSuffix` (suffix optional). Its dir is
`~/AutopilotExperiments/<expId>/<label>/`, git-initialized at creation.
Overrides may set: `model`, `workerModel`, `effort`, `workerEffort`,
`verifyCmd`. Anything not overridden uses the experiment form's defaults.

## Behavior

**Creation (UI).** A "New Experiment" button opens a form: name, base
prompt (prefilled with the therobotshome mission template), cycle cap
(default 5), experiment-wide default model settings, and a variant table.
Each row: label + optional overrides + optional prompt suffix. A
duplicate-row button clones a row (A/A test = duplicate 4×, change
nothing). Submit → `POST /api/experiments` → dirs created, git init,
projects registered enabled. Validation reuses the existing project-config
validators; labels must be unique and slug-safe.

**Running.** The scheduler sees only ordinary projects. The runner, before
launching a cycle for a project with `maxCycles`, counts completed cycles
(from the project's existing event log); at cap it disables the project and
stamps an `experiment-variant-complete` event instead of running. An
experiment is "complete" when all its variants are disabled-at-cap.

**Prompt template (domain fiction).** The default mission prompt states the
owner *will purchase* therobotshome.com once the site is worth it and to
build as if it will be live there. It never claims the domain currently
resolves, so agents don't burn cycles on DNS checks or deploy attempts.

**Experiment card (UI).** A new Experiments section: one card per
experiment showing status (running/complete), and one row per variant with:
override diffs from base only, cycles used / cap, tokens + cost (from
existing per-cycle accounting), latest verify result, links "Preview" and
"Log", and pause/stop controls. Whole-experiment pause/stop/delete on the
card. Delete removes the variants via the existing project-delete path and
asks (confirm) whether to also delete the dirs; experiments.json entry is
removed either way.

**Previews.** Daemon serves `GET /preview/<expId>/<label>/…` statically
from the variant's `site/` subdirectory if it exists, else the project
root. Read-only, path-traversal guarded (resolve + prefix check), no
directory listing beyond an index.html fallback, localhost-only like the
rest of the UI.

## API

- `POST /api/experiments` — create (name, basePrompt, cycleCap, defaults, variants[]).
- `GET /api/experiments` — list with per-variant live stats (joined from projects/events).
- `POST /api/experiments/:id/stop` / `pause` — fan out to variants.
- `DELETE /api/experiments/:id?dirs=1` — delete.
- Per-variant control reuses existing `/api/projects/:id/*` endpoints.

## Error handling

- Partial creation failure (e.g. dir exists, git init fails): roll back the
  variants already registered, delete created dirs, return the error;
  experiments.json is written last.
- Missing variant dir at preview time → 404, card shows "no output yet".
- Cap counting is derived from events, not a mutable counter, so crashes or
  manual restarts can't over- or under-run the cap.

## Testing

- Unit (serial `npm test`): experiment creation (registry entries, dir
  layout, prompt assembly, rollback on failure), cap enforcement in the
  runner, preview route traversal guard, delete fan-out.
- e2e (fake-claude fixture, no tokens): create a 2-variant experiment, run
  until both variants disable at cap, assert completion events and
  experiment status "complete".
- No real-token smoke: mechanics are model-independent.

## Budget note

5 concurrent large-model variants can exhaust the usage window quickly; the
form's experiment-wide defaults exist so cheap models (e.g. sonnet workers)
are one field, not five edits. The global 75% ceiling applies unchanged.
