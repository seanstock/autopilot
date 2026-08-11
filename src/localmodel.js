'use strict';
// Local-model availability.
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
// Deliberately NOT read from the environment: runner.js injects the router
// address per-cycle for local-model cycles only (see runner.js). That keeps
// this working across reboots and daemon restarts no matter how the daemon
// was launched, and keeps Claude-model cycles talking straight to Anthropic
// so a dead router cannot break them.
//
// The probe is cached and refreshed in the background because snapshot() is
// synchronous and runs on every status poll and SSE tick.

const http = require('http');
const https = require('https');
const net = require('net');

const DEFAULTS = {
  id: 'muse-glimmer',
  label: 'Muse Glimmer 30B (local)',
  healthUrl: 'http://127.0.0.1:8080/health',
  routerUrl: 'http://127.0.0.1:8787',
};

const TTL_MS = 15000;
const PROBE_TIMEOUT_MS = 1500;

function readConfig(envOverride) {
  const e = envOverride || process.env;
  return {
    id: e.AUTOPILOT_LOCAL_MODEL || DEFAULTS.id,
    label: e.AUTOPILOT_LOCAL_MODEL_LABEL || DEFAULTS.label,
    healthUrl: e.AUTOPILOT_LOCAL_MODEL_HEALTH || DEFAULTS.healthUrl,
    routerUrl: e.AUTOPILOT_LOCAL_MODEL_ROUTER || DEFAULTS.routerUrl,
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

class LocalModel {
  constructor(opts) {
    const o = opts || {};
    this._env = o.env || null;              // null => read process.env per probe
    this._now = o.now || (() => Date.now());
    this._httpProbe = o.httpProbe || httpProbe;
    this._tcpProbe = o.tcpProbe || tcpProbe;
    this._ttlMs = typeof o.ttlMs === 'number' ? o.ttlMs : TTL_MS;
    this._timeoutMs = typeof o.timeoutMs === 'number' ? o.timeoutMs : PROBE_TIMEOUT_MS;
    this._state = null;
    this._checkedAt = -Infinity;
    this._inFlight = false;
  }

  // Synchronous, for snapshot(). Never blocks; kicks off a background refresh
  // when the cached value is stale so the next caller sees fresh data.
  current() {
    if (this._state === null) {
      const cfg = readConfig(this._env);
      this._state = { id: cfg.id, label: cfg.label, available: false, reason: 'unchecked' };
    }
    if (this._now() - this._checkedAt >= this._ttlMs) {
      this.refresh(); // fire and forget; refresh() swallows its own errors
    }
    return this._state;
  }

  async refresh() {
    if (this._inFlight) return this._state;
    this._inFlight = true;
    const cfg = readConfig(this._env);
    let next;
    try {
      const routerUp = await this._tcpProbe(cfg.routerUrl, this._timeoutMs);
      if (!routerUp) {
        next = { id: cfg.id, label: cfg.label, available: false, reason: 'router-down' };
      } else {
        const modelUp = await this._httpProbe(cfg.healthUrl, this._timeoutMs);
        next = modelUp
          ? { id: cfg.id, label: cfg.label, available: true, reason: null }
          : { id: cfg.id, label: cfg.label, available: false, reason: 'unreachable' };
      }
    } catch (err) {
      next = { id: cfg.id, label: cfg.label, available: false, reason: 'unreachable' };
    } finally {
      this._checkedAt = this._now();
      this._inFlight = false;
    }
    this._state = next;
    return next;
  }
}

let sharedInstance = null;
function shared() {
  if (!sharedInstance) sharedInstance = new LocalModel();
  return sharedInstance;
}

module.exports = { LocalModel, shared, readConfig, httpProbe, tcpProbe, DEFAULTS, TTL_MS };
