'use strict';

// Experiments: run one mission N times as sibling "variant" projects with
// per-variant setting overrides (model, effort, prompt suffix), each capped
// at a fixed number of cycles, compared side by side in the UI.
// Spec: docs/superpowers/specs/2026-08-07-experiments-design.md.
// Zero npm dependencies, Node built-ins only, CommonJS.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const util = require('./util');

const EXPERIMENTS_FILENAME = 'experiments.json';

// Same override convention as util.AUTOPILOT_HOME_OVERRIDE: tests point
// this at a temp dir; real runs use ~/AutopilotExperiments.
function experimentsRoot() {
  return process.env.AUTOPILOT_EXPERIMENTS_DIR_OVERRIDE || path.join(os.homedir(), 'AutopilotExperiments');
}

function experimentsFile() {
  return path.join(util.AUTOPILOT_HOME, EXPERIMENTS_FILENAME);
}

function loadExperiments() {
  const raw = util.readJson(experimentsFile(), null);
  const list = raw && Array.isArray(raw.experiments) ? raw.experiments : [];
  return list.filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && Array.isArray(e.variants));
}

function saveExperiments(list) {
  util.writeJson(experimentsFile(), { experiments: list });
}

function getExperiment(id) {
  return loadExperiments().find((e) => e.id === id) || null;
}

// Labels double as directory names and URL path segments (preview route),
// so they are restricted to a slug charset - never stored raw.
function slug(input) {
  return String(input == null ? '' : input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function gitInit(dir) {
  const r = spawnSync('git', ['init'], { cwd: dir, windowsHide: true });
  if (r.error || r.status !== 0) {
    const detail = r.error ? r.error.message : String(r.stderr || '').trim();
    throw new Error(`git init failed in ${dir}: ${detail}`);
  }
}

// The per-variant setting overrides a creator may supply. Everything else
// (containment, criticRatio, ...) keeps project defaults - variants are
// deliberately ordinary, boring projects. Validation of each value happens
// in state.addProject via the same EDITABLE_KEYS path the add-project form
// uses; invalid values are dropped there, never stored.
const OVERRIDE_KEYS = ['model', 'workerModel', 'effort', 'workerEffort', 'verifyCmd'];

// Create an experiment: dirs + git init + register one ordinary project per
// variant. All-or-nothing: any failure rolls back projects already
// registered and removes any directory THIS call created (never a
// pre-existing one). experiments.json is written last, so a half-created
// experiment can never appear in the store.
//
// Server experiments (local Docker, KISS v1): an optional integer portBase
// leases port portBase+i to variant i and names its container
// exp-<expId>-<label>. {{PORT}}, {{LABEL}} and {{CONTAINER}} placeholders in
// the mission prompt, suffix and verifyCmd are substituted per variant at
// creation, so the fences (own port, own container name, 127.0.0.1 bind)
// arrive in the literal text the agent reads. Without portBase nothing is
// substituted and the experiment is a plain static one.
function applyTemplate(text, vars) {
  return String(text)
    .replace(/\{\{PORT\}\}/g, String(vars.port))
    .replace(/\{\{LABEL\}\}/g, vars.label)
    .replace(/\{\{CONTAINER\}\}/g, vars.container);
}

// body: { name, basePrompt, cycleCap, portBase?, defaults: {model,...},
//        variants: [{ label, promptSuffix, overrides: {model,...} }, ...] }
function createExperiment(scheduler, body) {
  const b = body && typeof body === 'object' ? body : {};
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  const basePrompt = typeof b.basePrompt === 'string' ? b.basePrompt.trim() : '';
  const cycleCap = Number(b.cycleCap);
  const variants = Array.isArray(b.variants) ? b.variants : [];
  const defaults = b.defaults && typeof b.defaults === 'object' ? b.defaults : {};
  const hasPortBase = b.portBase !== undefined && b.portBase !== null && b.portBase !== '';
  const portBase = hasPortBase ? Number(b.portBase) : null;

  if (!name) throw badRequest('name is required');
  if (!basePrompt) throw badRequest('basePrompt is required');
  if (!Number.isInteger(cycleCap) || cycleCap < 1 || cycleCap > 1000) {
    throw badRequest('cycleCap must be an integer between 1 and 1000');
  }
  if (variants.length < 1 || variants.length > 20) {
    throw badRequest('between 1 and 20 variants required');
  }
  if (hasPortBase && (!Number.isInteger(portBase) || portBase < 1024 || portBase > 64000)) {
    throw badRequest('portBase must be an integer between 1024 and 64000');
  }

  const experiments = loadExperiments();
  const id = uniqueSlug(slug(name) || 'experiment', new Set(experiments.map((e) => e.id)));

  // Validate every variant before touching disk.
  const seen = new Set();
  const prepared = variants.map((v, i) => {
    const raw = v && typeof v === 'object' ? v : {};
    const label = slug(raw.label) || `variant-${i + 1}`;
    // A/A tests legitimately submit identical rows; disambiguate silently.
    const unique = uniqueSlug(label, seen);
    seen.add(unique);
    const overrides = {};
    const src = raw.overrides && typeof raw.overrides === 'object' ? raw.overrides : {};
    for (const key of OVERRIDE_KEYS) {
      const value = src[key] !== undefined && src[key] !== '' ? src[key] : defaults[key];
      if (value !== undefined && value !== '') overrides[key] = value;
    }
    const promptSuffix = typeof raw.promptSuffix === 'string' ? raw.promptSuffix.trim() : '';
    return { label: unique, overrides, promptSuffix, port: null, container: null };
  });

  if (portBase !== null) {
    prepared.forEach((v, i) => {
      v.port = portBase + i;
      v.container = `exp-${id}-${v.label}`;
      const vars = { port: v.port, label: v.label, container: v.container };
      if (v.overrides.verifyCmd) v.overrides.verifyCmd = applyTemplate(v.overrides.verifyCmd, vars);
    });
  }

  const expDir = path.join(experimentsRoot(), id);
  const createdDirs = [];
  const addedProjectIds = [];

  try {
    for (const variant of prepared) {
      const dir = path.join(expDir, variant.label);
      if (fs.existsSync(dir)) throw badRequest(`directory already exists: ${dir}`);
      util.ensureDir(dir);
      createdDirs.push(dir);
      gitInit(dir);

      let prompt = variant.promptSuffix ? `${basePrompt}\n\n${variant.promptSuffix}` : basePrompt;
      if (variant.port !== null) {
        prompt = applyTemplate(prompt, { port: variant.port, label: variant.label, container: variant.container });
      }
      const project = scheduler.addProject(
        Object.assign({ dir, prompt, enabled: true }, variant.overrides)
      );
      addedProjectIds.push(project.id);
      variant.projectId = project.id;

      // Experiment identity + cap live on the project entry. Assigned
      // directly (not via EDITABLE_KEYS) because they are set-at-creation
      // identity, except maxCycles which is also an editable numeric.
      scheduler.updateProject(project.id, { maxCycles: cycleCap });
      const entry = scheduler.stateObj.projects.find((p) => p.id === project.id);
      entry.experimentId = id;
      entry.experimentLabel = variant.label;
    }
    // Persist the experimentId/Label assignments made above.
    scheduler.updateSettings({});
  } catch (err) {
    for (const pid of addedProjectIds) {
      try {
        scheduler.removeProject(pid);
      } catch (e2) {
        // best effort rollback
      }
    }
    for (const dir of createdDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (e2) {
        // best effort rollback
      }
    }
    throw err;
  }

  const record = {
    id,
    name,
    basePrompt,
    cycleCap,
    portBase,
    created: util.nowIso(),
    variants: prepared.map((v) => ({
      label: v.label,
      projectId: v.projectId,
      overrides: v.overrides,
      promptSuffix: v.promptSuffix,
      port: v.port,
      container: v.container,
    })),
  };
  experiments.push(record);
  saveExperiments(experiments);
  return record;
}

function uniqueSlug(base, taken) {
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// List experiments joined with live per-variant status from the
// scheduler's snapshot (cycle counts, totals, verify, status).
function listExperiments(scheduler) {
  let snapProjects = [];
  try {
    snapProjects = (scheduler.snapshot().projects || []);
  } catch (err) {
    // snapshot is best effort here; fall through with bare records
  }
  const byId = new Map(snapProjects.map((p) => [p.id, p]));

  return loadExperiments().map((exp) => {
    const variants = exp.variants.map((v) => {
      const p = byId.get(v.projectId) || null;
      const cycle = p ? p.cycle || 0 : 0;
      return {
        label: v.label,
        projectId: v.projectId,
        overrides: v.overrides || {},
        promptSuffix: v.promptSuffix || '',
        port: v.port != null ? v.port : null,
        container: v.container || null,
        present: !!p,
        status: p ? p.status : 'missing',
        statusDetail: p ? p.statusDetail : 'project no longer registered',
        cycle,
        complete: cycle >= exp.cycleCap,
        totals: p ? p.totals || null : null,
        lastExit: p ? p.lastExit || null : null,
        lastVerify: p ? p.lastVerify != null ? p.lastVerify : null : null,
      };
    });
    const complete = variants.length > 0 && variants.every((v) => !v.present || v.complete);
    return {
      id: exp.id,
      name: exp.name,
      basePrompt: exp.basePrompt,
      cycleCap: exp.cycleCap,
      portBase: exp.portBase != null ? exp.portBase : null,
      created: exp.created,
      complete,
      variants,
    };
  });
}

// Container names eligible for teardown: exactly the exp-<id>-<label> names
// this experiment leased, re-validated against a strict slug charset so a
// corrupted store entry can never smuggle docker CLI arguments. Pure
// function, unit-testable without docker.
const CONTAINER_NAME_RE = /^exp-[a-z0-9][a-z0-9-]*$/;

function teardownPlan(exp) {
  if (!exp || !Array.isArray(exp.variants)) return [];
  return exp.variants
    .map((v) => v.container)
    .filter((c) => typeof c === 'string' && CONTAINER_NAME_RE.test(c));
}

// Best-effort local docker teardown (Docker Desktop). A dead docker daemon
// or missing container is logged, never fatal: the registry cleanup must
// proceed regardless.
function teardownContainers(exp, runner) {
  const names = teardownPlan(exp);
  if (names.length === 0) return;
  const run = runner || ((args) => spawnSync('docker', args, { windowsHide: true, timeout: 60000 }));
  for (const name of names) {
    try {
      const r = run(['rm', '-f', name]);
      if (r.error || r.status !== 0) {
        util.log('experiments: docker rm -f', name, 'failed:', r.error ? r.error.message : String(r.stderr || '').trim());
      }
    } catch (err) {
      util.log('experiments: docker teardown threw for', name, String(err && err.message));
    }
  }
}

// Stop (STOP file) or start every variant of an experiment.
function fanOut(scheduler, expId, action) {
  const exp = getExperiment(expId);
  if (!exp) return false;
  for (const v of exp.variants) {
    try {
      if (action === 'stop') scheduler.stopProject(v.projectId);
      else scheduler.startProject(v.projectId);
    } catch (err) {
      util.log('experiments: fanOut', action, 'failed for', v.projectId, String(err && err.message));
    }
  }
  return true;
}

// Delete an experiment: deregister every variant project, optionally delete
// the experiment directory tree. Refuses (returns {ok:false}) if any
// variant is mid-cycle, before touching anything. Directory deletion only
// ever targets <experimentsRoot>/<expId> - never an arbitrary project dir.
function deleteExperiment(scheduler, expId, deleteDirs, removeContainers) {
  const experiments = loadExperiments();
  const exp = experiments.find((e) => e.id === expId);
  if (!exp) return { ok: false, error: 'unknown experiment' };

  const current = scheduler._current;
  if (current && exp.variants.some((v) => v.projectId === current.projectId)) {
    return { ok: false, error: 'a variant is mid-cycle; stop the experiment first' };
  }

  for (const v of exp.variants) {
    try {
      scheduler.removeProject(v.projectId);
    } catch (err) {
      util.log('experiments: removeProject failed for', v.projectId, String(err && err.message));
    }
  }

  if (removeContainers) teardownContainers(exp);

  if (deleteDirs) {
    const expDir = path.join(experimentsRoot(), expId);
    const resolved = path.resolve(expDir);
    const root = path.resolve(experimentsRoot());
    if (resolved.startsWith(root + path.sep)) {
      try {
        fs.rmSync(resolved, { recursive: true, force: true });
      } catch (err) {
        util.log('experiments: dir delete failed for', resolved, String(err && err.message));
      }
    }
  }

  saveExperiments(experiments.filter((e) => e.id !== expId));
  return { ok: true };
}

// Resolve a preview request to an absolute file path inside the variant's
// serve root (<dir>/site if it exists, else <dir>), or null if the request
// escapes the root, the variant is unknown, or the file is absent.
// `rest` is the already-decoded path remainder after /preview/<exp>/<label>/.
function resolvePreviewPath(expId, label, rest) {
  const exp = getExperiment(expId);
  if (!exp) return null;
  const variant = exp.variants.find((v) => v.label === label);
  if (!variant) return null;

  const dir = path.join(experimentsRoot(), expId, variant.label);
  const siteDir = path.join(dir, 'site');
  let root;
  try {
    root = fs.statSync(siteDir).isDirectory() ? siteDir : dir;
  } catch (err) {
    root = dir;
  }
  root = path.resolve(root);

  const cleaned = String(rest == null ? '' : rest).replace(/^\/+/, '');
  let target = path.resolve(root, cleaned || '.');
  if (target !== root && !target.startsWith(root + path.sep)) return null;

  try {
    if (fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
    if (!fs.statSync(target).isFile()) return null;
  } catch (err) {
    return null;
  }
  // Re-check after the index.html append.
  if (target !== root && !path.resolve(target).startsWith(root + path.sep)) return null;
  return target;
}

module.exports = {
  applyTemplate,
  teardownPlan,
  teardownContainers,
  loadExperiments,
  saveExperiments,
  getExperiment,
  createExperiment,
  listExperiments,
  fanOut,
  deleteExperiment,
  resolvePreviewPath,
  experimentsRoot,
};
