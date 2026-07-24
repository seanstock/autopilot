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
  webhook: null,
  port: 4680,
};

const PROJECT_DEFAULTS = {
  priority: 1,
  enabled: true,
  model: 'claude-sonnet-5',
  maxCycleMinutes: 120,
  criticRatio: 5,
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

  // I6 fix (server-side half): priority/maxCycleMinutes/criticRatio/
  // reviewGateCycles are numeric-expected fields with no prior type check -
  // POST /api/projects passes the request body straight through. A
  // non-numeric value here does not just misrender in the UI (the other,
  // client-side half of I6): stored verbatim in projects.json it becomes
  // reachable stored-XSS the next time the UI renders that project. Reject
  // (fall back to the default) rather than store an unvalidated value.
  const NUMERIC_KEYS = new Set(['priority', 'maxCycleMinutes', 'criticRatio', 'reviewGateCycles']);
  // v0.3: verifyCmd/workerModel are optional non-empty-string fields that
  // enable per-cycle gating / orchestration respectively when present.
  // Same stored-XSS concern as I6 above applies (projects.json renders back
  // into the UI) - a non-string or empty value is dropped rather than
  // stored, and since neither has a PROJECT_DEFAULTS entry, "dropped" means
  // the field stays absent (feature off), not reset to some default.
  const STRING_KEYS = new Set(['verifyCmd', 'workerModel']);
  for (const key of [
    'priority',
    'model',
    'maxCycleMinutes',
    'criticRatio',
    'reviewGateCycles',
    'containment',
    'enabled',
    'verifyCmd',
    'workerModel',
  ]) {
    if (options[key] === undefined) continue;
    if (NUMERIC_KEYS.has(key)) {
      const n = Number(options[key]);
      if (Number.isFinite(n)) project[key] = n;
      continue;
    }
    if (STRING_KEYS.has(key)) {
      if (typeof options[key] === 'string' && options[key].trim().length > 0) {
        project[key] = options[key];
      }
      continue;
    }
    project[key] = options[key];
  }

  stateObj.projects.push(project);
  return project;
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
  readRuntime,
  writeRuntime,
  readFatal,
  writeFatal,
  clearFatal,
};
