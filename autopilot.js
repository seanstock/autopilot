#!/usr/bin/env node
'use strict';

// Autopilot CLI + daemon bootstrap (SPEC.md section 7). CommonJS, zero npm
// dependencies, Node built-ins only.
//
//   autopilot                  start daemon (if not running) + open UI
//   autopilot daemon           run scheduler + server in the foreground
//   autopilot add <dir>        register a project
//   autopilot list             projects + status, one line each
//   autopilot stop [id]        stop one project, or the daemon with no id
//   autopilot logs <id>        tail ACTIVITY.log
//   autopilot inject <id> <t>  queue a user directive for the next work cycle
//   autopilot boot on|off      register/unregister daemon autostart with the OS
//
// `autopilot stop` (and every other daemon-down fallback here) must also
// work by hand with the daemon dead: touching <project>/.autopilot/STOP
// stops that project even with no daemon running (the guard hook blocks
// all tool calls once it exists; the daemon, next time it starts, also
// checks it before scheduling).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const util = require('./src/util');
const state = require('./src/state');
const events = require('./src/events');

const DEFAULT_PORT = 4680;

// ---------------------------------------------------------------------------
// tiny arg parsing (no deps)
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// small HTTP client helpers for talking to our own daemon
// ---------------------------------------------------------------------------

function getPort() {
  const stateObj = state.load();
  return (stateObj.settings && stateObj.settings.port) || DEFAULT_PORT;
}

function httpJson(method, pathName, port, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const headers = { Host: `127.0.0.1:${port}` };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request(
      { host: '127.0.0.1', port, path: pathName, method, headers, timeout: timeoutMs || 4000 },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let parsed = null;
          try {
            parsed = data ? JSON.parse(data) : null;
          } catch (err) {
            parsed = null;
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function isDaemonUp(port) {
  try {
    const res = await httpJson('GET', '/api/status', port, undefined, 1500);
    return res.status === 200;
  } catch (err) {
    return false;
  }
}

async function waitForDaemon(port, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isDaemonUp(port)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function readStdinAll() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data.replace(/\x1a$/, '').trim())); // strip a trailing Ctrl+Z (\x1a)
  });
}

function spawnDetachedDaemon() {
  const child = spawn(process.execPath, [__filename, 'daemon'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

async function cmdDefault() {
  const port = getPort();
  const up = await isDaemonUp(port);
  if (!up) {
    console.log('autopilot: daemon not running, starting it...');
    spawnDetachedDaemon();
    const ready = await waitForDaemon(port, 10000);
    if (!ready) {
      console.error(
        `autopilot: daemon did not become ready within 10s - check ${path.join(util.AUTOPILOT_HOME, 'daemon.log')}`
      );
      process.exitCode = 1;
      return;
    }
  }
  const url = `http://127.0.0.1:${port}`;
  openBrowser(url);
  console.log(`autopilot: daemon up at ${url}`);
}

// This is what the detached spawn above (and the `boot on` scheduled task)
// runs: scheduler + server in the foreground of this process.
function cmdDaemon() {
  util.ensureDir(util.AUTOPILOT_HOME);

  // Keep it simple (Task 7 note): tee stdout/stderr into
  // ~/.autopilot/daemon.log as well as the original streams, so a
  // detached/hidden daemon still leaves a readable trail. Best effort -
  // if this fails for any reason the daemon still runs, just unlogged to
  // disk.
  try {
    // I7 fix (SPEC.md section 8): daemon.log grew forever otherwise, same
    // gap as events.jsonl/ACTIVITY.log - reuse events.js's size-capped
    // rotation helper (checked on every write here, same "rename to .1"
    // policy). Rotating the file out from under an already-open
    // WriteStream needs the stream itself swapped for a fresh one pointed
    // at the (now-recreated) path.
    const eventsModule = require('./src/events');
    const logPath = path.join(util.AUTOPILOT_HOME, 'daemon.log');
    let logStream = fs.createWriteStream(logPath, { flags: 'a' });
    function statSizeSafe(p) {
      try {
        return fs.statSync(p).size;
      } catch (err) {
        return 0;
      }
    }
    function writeToLog(chunk, encoding) {
      try {
        const before = statSizeSafe(logPath);
        eventsModule.rotateIfNeeded(logPath);
        const after = statSizeSafe(logPath);
        if (after < before) {
          try {
            logStream.end();
          } catch (err) {
            // best effort
          }
          logStream = fs.createWriteStream(logPath, { flags: 'a' });
        }
        logStream.write(chunk, typeof encoding === 'string' ? encoding : undefined);
      } catch (err) {
        // best effort - never let logging break the daemon
      }
    }
    for (const streamName of ['stdout', 'stderr']) {
      const original = process[streamName].write.bind(process[streamName]);
      process[streamName].write = (chunk, encoding, cb) => {
        writeToLog(chunk, encoding);
        return original(chunk, encoding, cb);
      };
    }
  } catch (err) {
    // best effort
  }

  const budgetModule = require('./src/budget');
  const notifyModule = require('./src/notify');
  const { Scheduler } = require('./src/scheduler');
  const { startServer } = require('./src/server');

  const stateObj = state.load();
  const port = (stateObj.settings && stateObj.settings.port) || DEFAULT_PORT;

  // Provider keys: fill EMPTY slots once from the daemon's environment and
  // nearby .env files, so a machine that already has OPENAI_API_KEY set
  // needs no typing on the Settings page. Never overwrites a stored key.
  try {
    const keysModule = require('./src/keys');
    const r = keysModule.autofill();
    if (r.filled.length) util.log(`provider keys detected: ${r.filled.join(', ')}`);
  } catch (err) {
    util.log('provider key detection failed', String((err && err.message) || err));
  }

  const budget = new budgetModule.BudgetManager({ settings: stateObj.settings });
  const scheduler = new Scheduler({
    stateObj,
    budget,
    notifyImpl: notifyModule.notify,
    // runCycleImpl intentionally omitted: Scheduler defaults to the real
    // src/runner.js runCycle.
  });

  try {
    scheduler.start();
  } catch (err) {
    if (err && err.code === 'ALREADY_RUNNING') {
      console.error(String(err.message));
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const handle = startServer({ scheduler, port });
  util.log(`autopilot daemon started (pid ${process.pid}, port ${port})`);

  let shuttingDown = false;
  function gracefulStop(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    util.log(`autopilot daemon: received ${signal}, stopping`);
    Promise.resolve()
      .then(() => scheduler.stopDaemon())
      .catch((err) => util.log('autopilot daemon: stopDaemon() failed', String((err && err.message) || err)))
      .then(() => {
        handle.close(() => process.exit(0));
        // Safety net in case server.close()'s callback never fires (e.g. a
        // socket that refuses to end) - do not hang a Ctrl+C forever.
        setTimeout(() => process.exit(0), 3000).unref();
      });
  }
  process.on('SIGINT', () => gracefulStop('SIGINT'));
  process.on('SIGTERM', () => gracefulStop('SIGTERM'));
}

async function cmdAdd(args) {
  const dir = args._[0];
  if (!dir) {
    console.error('usage: autopilot add <dir> [--prompt "..."] [--priority n] [--model m] [--critic n] [--gate n] [--containment standard|off]');
    process.exitCode = 1;
    return;
  }
  const absDir = path.resolve(dir);
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    console.error(`autopilot add: not a directory: ${absDir}`);
    process.exitCode = 1;
    return;
  }

  let prompt = typeof args.prompt === 'string' ? args.prompt : '';
  if (!prompt) {
    console.log("Enter the mission prompt. End with Ctrl+Z then Enter on Windows (Ctrl+D on Unix/macOS):");
    prompt = await readStdinAll();
  }

  const cfg = { dir: absDir, prompt };
  if (args.priority !== undefined) cfg.priority = Number(args.priority);
  if (args.model !== undefined) cfg.model = args.model;
  if (args.effort !== undefined) cfg.effort = args.effort;
  if (args.worker !== undefined) cfg.workerModel = args.worker;
  if (args['worker-effort'] !== undefined) cfg.workerEffort = args['worker-effort'];
  if (args.verify !== undefined) cfg.verifyCmd = args.verify;
  if (args.critic !== undefined) cfg.criticRatio = Number(args.critic);
  if (args.gate !== undefined) cfg.reviewGateCycles = Number(args.gate);
  if (args.containment !== undefined) cfg.containment = args.containment;

  const port = getPort();
  if (await isDaemonUp(port)) {
    const res = await httpJson('POST', '/api/projects', port, cfg);
    const added = res.body && res.body.projects ? res.body.projects.find((p) => p.dir === absDir) : null;
    console.log(`added: ${added ? added.id : '(unknown - check autopilot list)'}`);
  } else {
    const stateObj = state.load();
    const project = state.addProject(stateObj, cfg);
    state.save(stateObj);
    console.log(`added (daemon down, wrote projects.json directly): ${project.id}`);
  }
}

async function cmdList() {
  const port = getPort();
  if (await isDaemonUp(port)) {
    const res = await httpJson('GET', '/api/status', port);
    const projects = (res.body && res.body.projects) || [];
    if (projects.length === 0) {
      console.log('(no projects - use `autopilot add <dir>`)');
      return;
    }
    for (const p of projects) {
      console.log(`${p.id}\t${p.status}\tprio=${p.priority}\tcycle=${p.cycle}\tlastExit=${p.lastExit || '-'}`);
    }
  } else {
    const stateObj = state.load();
    if (!stateObj.projects || stateObj.projects.length === 0) {
      console.log('(no projects - use `autopilot add <dir>`; daemon is down)');
      return;
    }
    for (const p of stateObj.projects) {
      const runtime = state.readRuntime(p.dir);
      console.log(`${p.id}\tdaemon-down\tprio=${p.priority}\tcycle=${runtime.cycle}\tlastExit=-`);
    }
  }
}

// Queue a user directive for the project's next work cycle (SPEC
// "Injection"). Prefers the daemon API; with the daemon down, appends to
// <dir>/.autopilot/INJECT.md directly so the directive is waiting when the
// daemon comes back.
async function cmdInject(id, text) {
  if (!id || !text || !text.trim()) {
    console.error('usage: autopilot inject <id> <text>');
    process.exitCode = 1;
    return;
  }
  const port = getPort();
  if (await isDaemonUp(port)) {
    await httpJson('POST', `/api/projects/${encodeURIComponent(id)}/inject`, port, { text });
    console.log(`queued for ${id}'s next work cycle`);
    return;
  }
  const stateObj = state.load();
  const project = state.getProject(stateObj, id);
  if (!project) {
    console.error(`autopilot: unknown project: ${id}`);
    process.exitCode = 1;
    return;
  }
  const meta = util.projectMeta(project.dir);
  util.ensureDir(meta);
  const p = path.join(meta, 'INJECT.md');
  const existing = fs.existsSync(p) ? String(fs.readFileSync(p, 'utf8')).replace(/\s+$/, '') + '\n\n' : '';
  fs.writeFileSync(p, existing + text.trim() + '\n');
  console.log(`daemon down - queued in ${p}`);
}

// Edit an existing project's config (model, effort, worker model/effort,
// verify command, critic/gate). Takes effect on the project's next cycle.
async function cmdConfig(id, args) {
  const patch = {};
  if (args.model !== undefined) patch.model = args.model;
  if (args.effort !== undefined) patch.effort = args.effort;
  if (args.worker !== undefined) patch.workerModel = args.worker;
  if (args['worker-effort'] !== undefined) patch.workerEffort = args['worker-effort'];
  if (args.verify !== undefined) patch.verifyCmd = args.verify;
  if (args.critic !== undefined) patch.criticRatio = Number(args.critic);
  if (args.gate !== undefined) patch.reviewGateCycles = Number(args.gate);
  if (!id || Object.keys(patch).length === 0) {
    console.error('usage: autopilot config <id> [--model m] [--effort low|medium|high|xhigh|max] [--worker m] [--worker-effort e] [--verify "cmd"] [--critic n] [--gate n]');
    console.error('  (clear a field by passing an empty value, e.g. --worker "")');
    process.exitCode = 1;
    return;
  }
  const port = getPort();
  if (await isDaemonUp(port)) {
    await httpJson('POST', `/api/projects/${encodeURIComponent(id)}/config`, port, patch);
    console.log(`updated ${id} (applies next cycle): ${Object.keys(patch).join(', ')}`);
    return;
  }
  const stateObj = state.load();
  const updated = state.updateProject(stateObj, id, patch);
  if (!updated) {
    console.error(`autopilot: unknown project: ${id}`);
    process.exitCode = 1;
    return;
  }
  state.save(stateObj);
  console.log(`updated ${id} (daemon down, wrote projects.json directly)`);
}

async function cmdStop(id) {
  const port = getPort();
  const up = await isDaemonUp(port);

  if (id) {
    if (up) {
      await httpJson('POST', `/api/projects/${encodeURIComponent(id)}/stop`, port, {});
      console.log(`stopped ${id}`);
      return;
    }
    const stateObj = state.load();
    const project = state.getProject(stateObj, id);
    if (!project) {
      console.error(`autopilot stop: unknown project id: ${id}`);
      process.exitCode = 1;
      return;
    }
    util.ensureDir(util.projectMeta(project.dir));
    fs.writeFileSync(path.join(util.projectMeta(project.dir), 'STOP'), '');
    console.log(`stopped ${id} (daemon down, touched .autopilot/STOP directly)`);
    return;
  }

  // No id: stop the daemon itself.
  if (up) {
    try {
      await httpJson('POST', '/api/shutdown', port, {});
      console.log('autopilot: daemon shutdown requested');
    } catch (err) {
      console.error(`autopilot stop: shutdown request failed (${err.message})`);
      process.exitCode = 1;
    }
    return;
  }
  const pidFile = path.join(util.AUTOPILOT_HOME, 'daemon.pid');
  const rec = util.readJson(pidFile, null);
  if (rec && rec.pid) {
    try {
      process.kill(rec.pid, 'SIGTERM');
      console.log(`autopilot: sent SIGTERM to daemon pid ${rec.pid}`);
      return;
    } catch (err) {
      // fall through - pid stale
    }
  }
  console.log('autopilot: daemon is not running');
}

async function cmdLogs(id) {
  if (!id) {
    console.error('usage: autopilot logs <id>');
    process.exitCode = 1;
    return;
  }
  const stateObj = state.load();
  const project = state.getProject(stateObj, id);
  if (!project) {
    console.error(`autopilot logs: unknown project id: ${id}`);
    process.exitCode = 1;
    return;
  }

  let lastCount = 0;
  const initial = events.tailActivity(project.dir, 200);
  for (const line of initial) console.log(line);
  lastCount = initial.length;

  console.log('-- tailing ACTIVITY.log, Ctrl+C to quit --');
  const timer = setInterval(() => {
    const all = events.tailActivity(project.dir, 100000);
    if (all.length > lastCount) {
      for (const line of all.slice(lastCount)) console.log(line);
      lastCount = all.length;
    }
  }, 2000);
  timer.unref(); // still allow Ctrl+C (SIGINT) to end the process normally

  await new Promise(() => {}); // run until Ctrl+C
}

// Pure: platform + action -> a plan for registering/removing a run-at-login
// entry, or null when this platform has no supported mechanism. Split out from
// cmdBoot so all three platforms are unit-testable from any one of them.
//
//   win32  - schtasks, ONLOGON scheduled task
//   darwin - a launchd user agent plist in ~/Library/LaunchAgents, loaded with
//            launchctl. RunAtLoad is the launchd equivalent of ONLOGON.
//   linux  - a systemd user unit in ~/.config/systemd/user, enabled with
//            `systemctl --user enable`. Covers mainstream desktop distros;
//            systems without systemd get a clear message rather than silence.
//
// pathEnv: the registering shell's PATH, baked into the launchd/systemd
// entry. Both launch the daemon with a bare system PATH (launchd:
// /usr/bin:/bin:/usr/sbin:/sbin) that does not contain Homebrew, ~/.local/bin
// or nvm, so a daemon started at login could not find `claude`, `git` or
// `node` for the guard hook and every cycle crashed. Windows' scheduled
// task inherits the user's environment on its own and needs nothing.
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildBootPlan(platform, action, nodeExe, scriptPath, homeDir, pathEnv) {
  const path = require('path');
  if (action !== 'on' && action !== 'off') return null;

  if (platform === 'win32') {
    const tr = `"${nodeExe}" "${scriptPath}" daemon`;
    return action === 'off'
      ? { kind: 'exec', bin: 'schtasks', args: ['/Delete', '/TN', 'Autopilot', '/F'] }
      : {
        kind: 'exec',
        bin: 'schtasks',
        args: ['/Create', '/TN', 'Autopilot', '/TR', tr, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F'],
      };
  }

  if (platform === 'darwin') {
    const label = 'com.autopilot.daemon';
    const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
    if (action === 'off') {
      return { kind: 'file+exec', remove: plistPath, bin: 'launchctl', args: ['unload', plistPath] };
    }
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '  <key>Label</key>',
      `  <string>${label}</string>`,
      '  <key>ProgramArguments</key>',
      '  <array>',
      `    <string>${xmlEscape(nodeExe)}</string>`,
      `    <string>${xmlEscape(scriptPath)}</string>`,
      '    <string>daemon</string>',
      '  </array>',
      '  <key>RunAtLoad</key>',
      '  <true/>',
      ...(pathEnv
        ? [
          '  <key>EnvironmentVariables</key>',
          '  <dict>',
          '    <key>PATH</key>',
          `    <string>${xmlEscape(pathEnv)}</string>`,
          '  </dict>',
        ]
        : []),
      '</dict>',
      '</plist>',
      '',
    ].join('\n');
    return { kind: 'file+exec', write: plistPath, content: plist, bin: 'launchctl', args: ['load', plistPath] };
  }

  if (platform === 'linux') {
    const unitPath = path.join(homeDir, '.config', 'systemd', 'user', 'autopilot.service');
    if (action === 'off') {
      return { kind: 'file+exec', remove: unitPath, bin: 'systemctl', args: ['--user', 'disable', 'autopilot.service'] };
    }
    const unit = [
      '[Unit]',
      'Description=Autopilot daemon',
      '',
      '[Service]',
      `ExecStart=${nodeExe} ${scriptPath} daemon`,
      ...(pathEnv ? [`Environment=PATH=${pathEnv}`] : []),
      'Restart=on-failure',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    return { kind: 'file+exec', write: unitPath, content: unit, bin: 'systemctl', args: ['--user', 'enable', '--now', 'autopilot.service'] };
  }

  return null;
}

function cmdBoot(onOff) {
  if (onOff !== 'on' && onOff !== 'off') {
    console.error('usage: autopilot boot on|off');
    process.exitCode = 1;
    return;
  }

  const plan = buildBootPlan(
    process.platform, onOff, process.execPath, path.resolve(__filename), os.homedir(), process.env.PATH
  );
  if (!plan) {
    console.log(`autopilot boot: not supported on ${process.platform}`);
    return;
  }

  // Write or remove the unit/plist first, so the loader has something to act on.
  try {
    if (plan.write) {
      fs.mkdirSync(path.dirname(plan.write), { recursive: true });
      fs.writeFileSync(plan.write, plan.content, 'utf8');
    }
  } catch (err) {
    console.error(`autopilot boot ${onOff}: could not write ${plan.write}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const r = spawnSync(plan.bin, plan.args, { windowsHide: true, encoding: 'utf8' });

  // Removal happens after the unloader has run, so it is not yanked mid-command.
  if (plan.remove) {
    try { fs.unlinkSync(plan.remove); } catch (err) { /* already gone */ }
  }

  if (r.status === 0) {
    console.log(onOff === 'on'
      ? 'autopilot boot on: registered to run at login'
      : 'autopilot boot off: login entry removed');
  } else {
    const detail = (r.stderr || r.stdout || r.error?.message || '').trim();
    console.error(`autopilot boot ${onOff}: ${plan.bin} failed: ${detail}`);
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const args = parseArgs(argv.slice(1));

  switch (cmd) {
    case undefined:
      await cmdDefault();
      break;
    case 'daemon':
      cmdDaemon();
      break;
    case 'add':
      await cmdAdd(args);
      break;
    case 'list':
      await cmdList();
      break;
    case 'stop':
      await cmdStop(args._[0]);
      break;
    case 'logs':
      await cmdLogs(args._[0]);
      break;
    case 'inject':
      await cmdInject(args._[0], args._.slice(1).join(' '));
      break;
    case 'config':
      await cmdConfig(args._[0], args);
      break;
    case 'boot':
      cmdBoot(args._[0]);
      break;
    default:
      console.error(`autopilot: unknown command: ${cmd}`);
      console.error('usage: autopilot [add <dir>|list|stop [id]|logs <id>|inject <id> <text>|config <id> --model/--effort/...|boot on|off|daemon]');
      process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('autopilot: fatal error', (err && err.stack) || err);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, getPort, buildBootPlan };
