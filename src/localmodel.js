'use strict';
// Local-model availability, and starting it on demand.
//
// Autopilot can run cycles against a model served on this machine (llama.cpp's
// llama-server, behind a small router that dispatches by model name). Two
// processes have to be up for that to work:
//
//   - the inference server, which actually holds the weights, and
//   - the router, which is what the CLI is pointed at; it sends the local
//     model id to the inference server and forwards everything else to
//     Anthropic.
//
// Both are probed here, because either one being down makes the model
// unusable, and an option in the UI that can only fail is worse than no
// option at all.
//
// Availability deliberately does NOT read ANTHROPIC_BASE_URL from the
// environment: runner.js injects the router address per cycle for local-model
// cycles only. That keeps this working across reboots and every daemon launch
// path, and keeps Claude-model cycles talking straight to Anthropic so a dead
// router cannot break them.
//
// The probe is cached and refreshed in the background because snapshot() is
// synchronous and runs on every status poll and SSE tick.

const http = require('http');
const https = require('https');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Where the muse-glimmer install lives. The weights are 16 GB, so the install
// moved to the data drive on 2026-09-18; the home-dir location is where it
// started and stays as a fallback for a machine without a D: drive. The first
// candidate that exists wins. When none does, the first is reported so the
// "start script not found" error names the expected place.
const START_CANDIDATES = [
  path.normalize('D:/muse-glimmer/start-all.ps1'),
  path.join(os.homedir(), 'muse-glimmer', 'start-all.ps1'),
];

function defaultStartCommand() {
  for (const c of START_CANDIDATES) {
    try { if (fs.existsSync(c)) return c; } catch (err) { /* treat as absent */ }
  }
  return START_CANDIDATES[0];
}

const DEFAULTS = {
  id: 'muse-glimmer',
  label: 'Muse Glimmer 30B (local)',
  healthUrl: 'http://127.0.0.1:8080/health',
  routerUrl: 'http://127.0.0.1:8787',
  // Script that brings up both processes. The start button only appears when
  // this file actually exists, so an install without it simply has no button
  // rather than a button that fails.
  startCommand: defaultStartCommand(),
};

const TTL_MS = 15000;
const PROBE_TIMEOUT_MS = 1500;
// How long after a start request to keep reporting "starting". Loading tens of
// GB of weights is slow, and the window has to outlast a cold read from disk.
const START_WINDOW_MS = 180000;

function readConfig(envOverride) {
  const e = envOverride || process.env;
  return {
    id: e.AUTOPILOT_LOCAL_MODEL || DEFAULTS.id,
    label: e.AUTOPILOT_LOCAL_MODEL_LABEL || DEFAULTS.label,
    healthUrl: e.AUTOPILOT_LOCAL_MODEL_HEALTH || DEFAULTS.healthUrl,
    routerUrl: e.AUTOPILOT_LOCAL_MODEL_ROUTER || DEFAULTS.routerUrl,
    startCommand: e.AUTOPILOT_LOCAL_MODEL_START || DEFAULTS.startCommand,
  };
}

// Resolves true/false, never rejects. A dead port, a DNS failure and a 500 are
// all just "not available".
function httpProbe(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    let req;
    try {
      const mod = url.startsWith('https:') ? https : http;
      req = mod.get(url, (res) => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        res.resume(); // drain so the socket can close
        finish(ok);
      });
    } catch (err) {
      finish(false);
      return;
    }
    req.on('error', () => finish(false));
    req.setTimeout(timeoutMs, () => {
      try { req.destroy(); } catch (err) { /* already gone */ }
      finish(false);
    });
  });
}

// The router proxies unknown paths onward to Anthropic, so probing it with a
// GET would fire a real outbound request just to answer "is it listening".
// A TCP connect answers exactly that and nothing else.
function tcpProbe(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    let parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      finish(false);
      return;
    }
    const port = Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80);
    const sock = new net.Socket();
    const done = (v) => { try { sock.destroy(); } catch (e) { /* noop */ } finish(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
    try {
      sock.connect(port, parsed.hostname);
    } catch (err) {
      done(false);
    }
  });
}

// Where the launcher's own output goes. Discarding it makes a launcher that
// starts nothing indistinguishable from one that works, which cost real time
// to debug once already.
function startLogPath() {
  const home = process.env.AUTOPILOT_HOME_OVERRIDE || path.join(os.homedir(), '.autopilot');
  return path.join(home, 'localmodel-start.log');
}

// Detached on purpose: the servers must outlive both this request and the
// daemon itself, and the HTTP call must return immediately rather than block
// for the length of a model load.
function defaultSpawn(command) {
  let out = null;
  try {
    const p = startLogPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    out = fs.openSync(p, 'a');
    fs.writeSync(out, `\n=== start requested ${new Date().toISOString()} ===\n`);
  } catch (err) {
    out = null; // fall back to discarding rather than failing the start
  }
  const stdio = out === null ? 'ignore' : ['ignore', out, out];

  // NOT detached on Windows. The daemon runs without a console, and `detached`
  // asks Windows to give the child its own console, which PowerShell cannot set
  // up from a console-less parent: it dies instantly, silently, exit 0. unref()
  // is enough - it stops us waiting on the child, and on Windows the child
  // outlives the parent anyway since there is no job-object kill.
  const detached = process.platform !== 'win32';
  const isPowershell = /\.ps1$/i.test(command);
  const child = isPowershell
    ? spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', command],
      { detached, stdio, windowsHide: true })
    : spawn(command, [], { detached, stdio, windowsHide: true, shell: true });
  child.unref();
  return child;
}

class LocalModel {
  constructor(opts) {
    const o = opts || {};
    this._env = o.env || null;              // null => read process.env per probe
    this._now = o.now || (() => Date.now());
    this._httpProbe = o.httpProbe || httpProbe;
    this._tcpProbe = o.tcpProbe || tcpProbe;
    this._spawnImpl = o.spawnImpl || defaultSpawn;
    this._existsImpl = o.existsImpl || fs.existsSync;
    this._ttlMs = typeof o.ttlMs === 'number' ? o.ttlMs : TTL_MS;
    this._timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : PROBE_TIMEOUT_MS;
    this._startWindowMs = typeof o.startWindowMs === 'number' ? o.startWindowMs : START_WINDOW_MS;
    this._state = null;
    this._checkedAt = -Infinity;
    this._inFlight = false;
    this._startedAt = 0;
    this._startError = null;
  }

  canStart() {
    const cfg = readConfig(this._env);
    if (!cfg.startCommand) return false;
    try {
      return !!this._existsImpl(cfg.startCommand);
    } catch (err) {
      return false;
    }
  }

  // True from a start request until the servers answer or the window lapses,
  // so the UI can show progress instead of an unchanged dead button.
  isStarting() {
    if (!this._startedAt) return false;
    if (this._state && this._state.available) return false;
    return (this._now() - this._startedAt) < this._startWindowMs;
  }

  start() {
    // Refuse "already running" only on a FRESH probe. The cached value can be
    // up to a TTL stale, and refusing on stale data means a server that died
    // seconds ago cannot be restarted until the cache catches up. The launcher
    // is idempotent (it skips whatever is already listening), so erring toward
    // running it is both safe and the more useful failure direction.
    const stateIsFresh = (this._now() - this._checkedAt) < this._ttlMs;
    if (stateIsFresh && this._state && this._state.available) {
      return { ok: false, error: 'already running' };
    }
    if (this.isStarting()) return { ok: false, error: 'already starting' };
    if (!this.canStart()) {
      const cfg = readConfig(this._env);
      return { ok: false, error: `start script not found: ${cfg.startCommand}` };
    }
    const cfg = readConfig(this._env);
    this._startError = null;
    let child;
    try {
      child = this._spawnImpl(cfg.startCommand);
    } catch (err) {
      return { ok: false, error: `could not launch: ${err.message}` };
    }
    // A failed spawn on Windows surfaces asynchronously as an 'error' event,
    // not a throw. Without this the UI sat on "starting..." for the full window
    // for a launch that never happened, reporting nothing.
    if (child && typeof child.on === 'function') {
      child.on('error', (err) => {
        this._startError = `could not launch: ${err.message}`;
        this._startedAt = 0; // stop claiming "starting"; put the button back
      });
      child.on('exit', (code) => {
        if (code) {
          this._startError = `launcher exited with code ${code}`;
          this._startedAt = 0;
        }
      });
    }
    this._startedAt = this._now();
    this._checkedAt = -Infinity; // probe again promptly rather than sit on a stale "down"
    return { ok: true };
  }

  // Synchronous, for snapshot(). Never blocks; kicks off a background refresh
  // when the cached value is stale so the next caller sees fresh data.
  current() {
    if (this._state === null) {
      const cfg = readConfig(this._env);
      this._state = {
        id: cfg.id, label: cfg.label, available: false, reason: 'unchecked', canStart: this.canStart(),
      };
    }
    if (this._now() - this._checkedAt >= this._ttlMs) {
      this.refresh(); // fire and forget; refresh() swallows its own errors
    }
    return Object.assign({}, this._state, {
      starting: this.isStarting(),
      startError: this._startError || null,
    });
  }

  async refresh() {
    if (this._inFlight) return this._state;
    this._inFlight = true;
    const cfg = readConfig(this._env);
    const canStart = this.canStart();
    let next;
    try {
      const routerUp = await this._tcpProbe(cfg.routerUrl, this._timeoutMs);
      if (!routerUp) {
        next = { id: cfg.id, label: cfg.label, available: false, reason: 'router-down', canStart };
      } else {
        const modelUp = await this._httpProbe(cfg.healthUrl, this._timeoutMs);
        next = modelUp
          ? { id: cfg.id, label: cfg.label, available: true, reason: null, canStart }
          : { id: cfg.id, label: cfg.label, available: false, reason: 'unreachable', canStart };
      }
    } catch (err) {
      next = { id: cfg.id, label: cfg.label, available: false, reason: 'unreachable', canStart };
    } finally {
      this._checkedAt = this._now();
      this._inFlight = false;
    }
    this._state = next;
    if (next.available) {
      this._startedAt = 0;   // start finished; stop reporting "starting"
      this._startError = null;
    }
    return next;
  }
}

let sharedInstance = null;
function shared() {
  if (!sharedInstance) sharedInstance = new LocalModel();
  return sharedInstance;
}

module.exports = {
  LocalModel, shared, readConfig, httpProbe, tcpProbe, defaultSpawn, DEFAULTS, TTL_MS, START_WINDOW_MS,
};
