# Goal-loop orchestration for Autopilot (design note, 2026-07-24)

How Autopilot could adopt the orchestrator + worker pattern: a top-tier
model (Fable 5) steering work against a standing goal, cheaper models
executing it. Grounded in Anthropic's published guidance, community
goal-loop practice (Ralph loop, Beads/Gas Town, refined playbooks), and
the build of Autopilot itself, which was constructed by exactly this
pattern. Sources: `.superpowers/research-official.md`,
`.superpowers/research-community.md`.

## 1. Where Autopilot already stands

Autopilot IS a goal loop - specifically, a Ralph loop with every
refinement the community converged on after the naive version failed:
true fresh context per cycle (not the lossy in-session Stop-hook
variant), state in files and git rather than context, runner-stamped
ground truth, adversarial critic cycles, budget governance, human review
gates, and mid-loop steering (injection). What it is NOT yet:

- No orchestrator role. Every cycle is a monolithic worker that plans,
  executes, and grades itself with the whole project in context.
- No model tiering. A project runs one model for everything; Fable does
  the typing that Haiku could do.
- Verification is cadence-based (critic every Nth cycle), not gate-based
  per unit of work.
- Goal state is PLAN.md prose, which the community reports degrades
  under sustained agent maintenance (Yegge's argument for structured
  issue DAGs).
- Cycles cannot spawn subagents at all: the containment allow list
  deliberately omits the Task tool.

## 2. What the research pins down

1. **Big model plans, small model executes.** Anthropic's lead+subagent
   split beat single-agent top-model by 90.2% on their research eval;
   the tiering recurs in every serious community system.
2. **Multi-agent costs ~15x chat tokens** and pays off only where work
   is decomposable and parallelizable; token spend explains most of the
   performance variance. Don't multi-agent serial deep work.
3. **The failure modes are prompt failures, not architecture failures:**
   over-spawning, vague briefs, duplicated work. Fixes: effort-scaling
   rules (1 agent for simple, 2-4 for compare, 10+ only for genuinely
   parallel work) and detailed work orders (objective, boundaries,
   output format, tool budget).
4. **Deterministic gates first, LLM judgment second.** Unanimous:
   tests/build/lint decide "done"; a model saying "done" decides
   nothing. Anthropic's own Ralph plugin doc says completion-string
   matching is unreliable.
5. **Plans are disposable.** When the plan file drifts, regenerate it
   from the spec instead of patching it (paddo.dev playbook); or move
   goal state to structured records (Beads).
6. **Headless mechanics all exist:** subagents work under `claude -p`,
   per-subagent model selection via agent frontmatter, subagents
   inherit the parent's permission rules (containment holds). Workflows
   run headless but do NOT survive process restarts - which is exactly
   the survival property Autopilot's file-based loop provides.
7. **Unconfirmed and load-bearing:** whether subagent tokens roll up
   into the parent's stream-json `total_cost_usd`. The invested tracker
   depends on it. Needs a one-off empirical probe before any of this
   ships.
8. **Cautionary economics:** Gas Town's 20-30 parallel agents run
   ~$100/hour with self-reported auto-merged failing tests. Parallel
   swarms are the expensive, failure-prone end; restraint wins.

## 3. Two adaptation shapes

**A. In-cycle orchestration.** Allow the Task tool; the project's model
becomes the orchestrator (Fable), and the preamble teaches it to
decompose the current objective and dispatch worker subagents (Sonnet/
Haiku via daemon-generated agent definitions) with scoped briefs, then
verify before ticking PLAN. Smallest diff; matches Anthropic's proven
shape; workers parallelize inside one cycle. But: a timeout or context
death kills orchestrator and workers together (all progress inside the
cycle), parallel workers mutating one repo need file-ownership briefs to
avoid conflicts, and cost attribution collapses into the parent cycle.

**B. Cross-cycle orchestration.** New cycle kind `orchestrate` (Fable):
does no implementation work; reads GOAL/spec/state, maintains a durable
work-order queue (each order: objective, acceptance criteria, a
deterministic verify command, file boundaries), and closes or reopens
orders by running their gates. Worker cycles (Sonnet) take exactly ONE
order each, with a preamble scoped to that order rather than the whole
mission - small context, cheap model, precise brief. Critic unchanged.
Scheduler cadence: orchestrate when the queue is empty, stale, or every
N cycles; workers otherwise. Config: `orchestratorModel` +
`workerModel` per project. Everything is files, so it survives death by
design (the property Workflows lack), the one-cycle-at-a-time invariant
stands, and the per-model invested tracker attributes Fable-planning vs
Sonnet-execution costs out of the box.

## 4. Recommendation: B as the spine, A as a bounded boost

Option B is the Autopilot-shaped evolution: it converts the pattern's
weakest point (orchestration state living in a process) into files,
which is the bet the whole project is built on. Adopt A only inside
orchestrate/critic cycles and only for READ-ONLY subagents (research,
audit, verification fan-out) - parallel reads can't conflict, and it is
precisely where Anthropic's 90.2% result lives. Mutating work stays
serial, one order per worker cycle.

Order of shipping (each step independently valuable):

1. **Gates first (no orchestration needed):** per-project `verifyCmd`
   (e.g. `npm test`); the RUNNER executes it after every cycle and
   stamps pass/fail into cycle_end. Ground truth stops depending on the
   model's claims. This is the community's single strongest lesson and
   costs an afternoon.
2. **Empirical probe:** one cheap cycle with a subagent, check whether
   `total_cost_usd`/usage includes the subagent. Decides how totals are
   recorded for everything below.
3. **v0.3 orchestration:** work-order queue (`orders/` at project root,
   one file per order - structured, disposable, regenerable from
   GOAL.md), `orchestrate` kind + preamble, `workerModel`, scheduler
   cadence, per-order events. UI: orders column in the detail pane.
4. **v0.4 read-only fan-out:** allow Task in orchestrate/critic cycles;
   daemon-generated read-only agent definitions; effort-scaling rules
   in the orchestrator preamble (borrowed verbatim from Anthropic's).

## 5. What deliberately does not change

One cycle at a time globally. The ceiling and grace flow. Containment
(subagents inherit it; nested `claude -p` stays blocked). Fresh context
per cycle. The runner as sole source of ground truth. Review gates as
the only authority that a goal is DONE - a goal loop's exit condition
is a human plus green gates, never the model's own assessment.
