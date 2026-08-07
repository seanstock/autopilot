'use strict';

// Foundation module: ~/.autopilot/projects.json + per-project runtime state.
// Zero npm dependencies, Node built-ins only, CommonJS.

const fs = require('fs');
const path = require('path');

const util = require('./util');

const PROJECTS_FILENAME = 'projects.json';
const FATAL_FILENAME = 'fatal.json';
const RUNTIME_FILENAME = 'state.json';

const DEFAULT_SETTINGS = {
  ceilingPct: 75,
  graceMinutes: 30,
  notes: '',
  webhook: null,
  port: 4680,
};

const PROJECT_DEFAULTS = {
  priority: 1,
  enabled: true,
  model: 'claude-sonnet-5',
  maxCycleMinutes: 120,
  // Off by default. The critic reads the loop's own WORKLOG/UPDATES narration
  // and tries to refute it, filing every discrepancy as backlog. Refutation
  // always succeeds - every claim is incomplete somewhere - so it manufactures
  // an endless supply of defensible, low-value work and rewards the very
  // bookkeeping it needs as input. Measured on two real projects: 155 findings
  // over 28 passes on one, and a self-audit cycle on a project whose entire
  // prompt was three words. Opt in per project if you want it.
  criticRatio: 0,
  reviewGateCycles: 0,
  containment: 'standard',
};

const RUNTIME_DEFAULTS = {
  cycle: 0,
  sinceReview: 0,
  failTimes: [],
  cooldownUntil: null,
};

// util.AUTOPILOT_HOME is accessed fresh inside these functions (never
// destructured/cached at module load) so AUTOPILOT_HOME_OVERRIDE set by a
// test after this module is required still takes effect.
function projectsFile() {
  return path.join(util.AUTOPILOT_HOME, PROJECTS_FILENAME);
}

function fatalFile() {
  return path.join(util.AUTOPILOT_HOME, FATAL_FILENAME);
}

function runtimeFile(dir) {
  return path.join(util.projectMeta(dir), RUNTIME_FILENAME);
}

function kebabCase(input) {
  const slug = String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}

// dir must exist and be absolute; anything else is dropped.
function isValidDir(dir) {
  if (typeof dir !== 'string' || dir.length === 0) return false;
  if (!path.isAbsolute(dir)) return false;
  try {
    return fs.statSync(dir).isDirectory();
  } catch (err) {
    return false;
  }
}

function validateProjectEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  if (typeof entry.id !== 'string' || entry.id.length === 0) return false;
  if (!isValidDir(entry.dir)) return false;
  return true;
}

// I5(c) fix: `claudeCmd` is an in-memory test hook only (the e2e/scheduler
// test harnesses set it on a project object AFTER load() to point at
// test/fake-claude.js) - it is not a real config field, and the scheduler
// passes it straight through to the runner's spawn (src/scheduler.js
// `claudeCmd: project.claudeCmd`). Without this strip, a cycle that managed
// to write an attacker-chosen claudeCmd into projects.json (I5's Bash/Write
// bypass of the permissions layer) would get the daemon to spawn an
// arbitrary command on its own next cycle - closing that half of I5
// requires this regardless of how well the deny list/guard hold up.
// Stripped on the way IN from disk only: a project object that already has
// claudeCmd set in memory (e.g. by test/e2e.js right after addProject(),
// before any save/load round-trip) is untouched.
function stripClaudeCmd(entry) {
  if (entry && Object.prototype.hasOwnProperty.call(entry, 'claudeCmd')) {
    const { claudeCmd, ...rest } = entry;
    return rest;
  }
  return entry;
}

function load() {
  const raw = util.readJson(projectsFile(), null);
  const base = raw && typeof raw === 'object' ? raw : {};

  const settings = Object.assign({}, DEFAULT_SETTINGS, base.settings || {});

  const rawProjects = Array.isArray(base.projects) ? base.projects : [];
  const projects = [];
  for (const entry of rawProjects) {
    if (!validateProjectEntry(entry)) {
      util.log(
        'state.load: dropping invalid project entry',
        entry && typeof entry === 'object' ? entry.id || '(no id)' : '(malformed)'
      );
      continue;
    }
    projects.push(Object.assign({}, PROJECT_DEFAULTS, stripClaudeCmd(entry)));
  }

  return { settings, projects };
}

function save(stateObj) {
  util.writeJson(projectsFile(), stateObj);
}

function getProject(stateObj, id) {
  const projects = (stateObj && stateObj.projects) || [];
  return projects.find((p) => p.id === id) || null;
}

function addProject(stateObj, opts) {
  const options = opts || {};
  const dir = options.dir;
  if (typeof dir !== 'string' || dir.length === 0 || !path.isAbsolute(dir)) {
    throw new Error('addProject: dir must be an absolute path');
  }

  if (!stateObj.projects) stateObj.projects = [];
  const existingIds = new Set(stateObj.projects.map((p) => p.id));

  const base = kebabCase(path.basename(dir));
  let id = base;
  let suffix = 2;
  while (existingIds.has(id)) {
    id = `${base}-${suffix}`;
    suffix += 1;
  }

  const project = Object.assign({}, PROJECT_DEFAULTS, {
    id,
    dir,
    prompt: options.prompt || '',
  });

  for (const key of EDITABLE_KEYS) applyProjectField(project, key, options[key], false);

  stateObj.projects.push(project);
  return project;
}

// The set of project-config fields a caller (add form / update endpoint /
// CLI) may set. id/dir/prompt are handled separately (id/dir are identity,
// never editable here). Order is irrelevant.
const EDITABLE_KEYS = [
  'prompt',
  'priority',
  'model',
  'workerModel',
  'effort',
  'workerEffort',
  'maxCycleMinutes',
  'criticRatio',
  'reviewGateCycles',
  'containment',
  'verifyCmd',
  'enabled',
  // Experiments (2026-08-07 spec): hard cycle cap; the scheduler disables
  // the project when runtime.cycle reaches it. 0/absent = uncapped.
  'maxCycles',
];

const NUMERIC_KEYS = new Set(['priority', 'maxCycleMinutes', 'criticRatio', 'reviewGateCycles', 'maxCycles']);
// claude --effort levels (shared via util so state + runner never drift).
// max is accepted because Autopilot passes effort via the `--effort` CLI
// flag, not the settings file (settings-file effortLevel forbids max).
const EFFORT_LEVELS = util.EFFORT_LEVELS;
// A model id is a safe-charset token. Validating it (rather than storing
// the request body verbatim) closes the same stored-XSS hole the I6 fix
// closed for the numeric fields: model renders straight into the UI DOM.
const MODEL_RE = /^[a-z0-9][a-z0-9.\-]{0,63}$/i;

// Validate-and-assign a single field onto a project object. Invalid values
// are dropped, never stored (stored-XSS defense: every one of these renders
// back into the UI). allowClear=true (update path) lets an explicit null/''
// REMOVE an optional field - workerModel:'' turns orchestration off,
// effort:'' reverts to the CLI default, verifyCmd:'' removes the gate.
// model is never clearable (it always has a value) and enabled/containment
// are not clearable (they have defaults).
function applyProjectField(target, key, value, allowClear) {
  if (value === undefined) return;
  const isClear = value === null || value === '';

  if (NUMERIC_KEYS.has(key)) {
    const n = Number(value);
    if (Number.isFinite(n)) target[key] = n;
    return;
  }
  if (key === 'enabled') {
    if (typeof value === 'boolean') target[key] = value;
    return;
  }
  if (key === 'containment') {
    if (value === 'standard' || value === 'off') target[key] = value;
    return;
  }
  if (key === 'model' || key === 'workerModel') {
    if (typeof value === 'string' && MODEL_RE.test(value.trim())) {
      target[key] = value.trim();
    } else if (allowClear && isClear && key === 'workerModel') {
      delete target[key];
    }
    return;
  }
  if (key === 'effort' || key === 'workerEffort') {
    if (typeof value === 'string' && EFFORT_LEVELS.has(value.trim().toLowerCase())) {
      target[key] = value.trim().toLowerCase();
    } else if (allowClear && isClear) {
      delete target[key];
    }
    return;
  }
  if (key === 'prompt') {
    // The mission prompt is the single surface a human edits. It is free text,
    // so the only rule is that it must be a non-empty string - clearing it
    // would leave cycles with no instructions at all.
    if (typeof value === 'string' && value.trim().length > 0) {
      target[key] = value;
    }
    return;
  }
  if (key === 'verifyCmd') {
    if (typeof value === 'string' && value.trim().length > 0) {
      target[key] = value;
    } else if (allowClear && isClear) {
      delete target[key];
    }
  }
}

// Apply a partial config patch to an existing project in place (validated,
// clear-capable). Returns the project, or null if the id is unknown.
function updateProject(stateObj, id, patch) {
  const project = getProject(stateObj, id);
  if (!project || !patch || typeof patch !== 'object') return null;
  for (const key of EDITABLE_KEYS) applyProjectField(project, key, patch[key], true);
  return project;
}

// Remove a project from the registry. Deregisters only: the project's own
// directory, git history and work product are never touched, because they are
// the user's, not ours. Returns true if something was removed.
function removeProject(stateObj, id) {
  const before = (stateObj.projects || []).length;
  stateObj.projects = (stateObj.projects || []).filter((p) => p.id !== id);
  return stateObj.projects.length < before;
}

function readRuntime(dir) {
  const raw = util.readJson(runtimeFile(dir), null);
  return Object.assign({}, RUNTIME_DEFAULTS, raw && typeof raw === 'object' ? raw : {});
}

function writeRuntime(dir, obj) {
  util.writeJson(runtimeFile(dir), obj);
}

function readFatal() {
  return util.readJson(fatalFile(), null);
}

function writeFatal(reason) {
  util.writeJson(fatalFile(), { reason, t: util.nowIso() });
}

function clearFatal() {
  try {
    fs.unlinkSync(fatalFile());
  } catch (err) {
    // already absent; nothing to clear
  }
}

module.exports = {
  load,
  save,
  getProject,
  addProject,
  updateProject,
  removeProject,
  readRuntime,
  writeRuntime,
  readFatal,
  writeFatal,
  clearFatal,
};
