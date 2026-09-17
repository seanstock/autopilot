// End-to-end integration check: composes the real modules (state, scheduler,
// runner via project.claudeCmd -> fake-claude, server) in-process, drives one
// full cycle, then exercises STOP. Prints PASS/FAIL lines; exits 0 only if all pass.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const http = require('http');

const REPO = path.resolve(__dirname, '..');
const results = [];
function check(name, ok, extra) {
  results.push([name, ok]);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' :: ' + extra : ''));
}

async function main() {
  // isolated home + project dir
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-e2e-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-e2e-proj-'));
  process.env.AUTOPILOT_HOME_OVERRIDE = home;
  process.env.FAKE_MODE = 'clean';

  const util = require(REPO + '/src/util.js');
  const state = require(REPO + '/src/state.js');
  const events = require(REPO + '/src/events.js');
  const { Scheduler } = require(REPO + '/src/scheduler.js');
  const { startServer } = require(REPO + '/src/server.js');

  const fakeClaude = path.join(REPO, 'test', 'fake-claude.js');
  const stateObj = state.load();
  const project = state.addProject(stateObj, {
    dir: proj,
    prompt: 'E2E test mission: trivial.',
    priority: 1,
    model: 'claude-sonnet-5',
    criticRatio: 0,
    reviewGateCycles: 0,
    containment: 'standard',
  });
  project.maxCycleMinutes = 1;
  project.claudeCmd = [process.execPath, fakeClaude];
  state.save(stateObj);

  const fakeBudget = {
    check: async () => ({ ok: true, reason: null, windows: [{ name: 'five_hour', pct: 10, resetsAt: null }], resetsAt: null, checkedIso: util.nowIso() }),
    isFatal: () => false,
    scanForTripwire: () => false,
    noteUsageLimitExit: () => {},
    clearFatal: () => {},
    probeGate: async () => ({ ok: true }),
  };

  const sched = new Scheduler({ stateObj, budget: fakeBudget, tickMs: 150 });
  const srv = startServer({ scheduler: sched, port: 0 });
  await new Promise((r) => setTimeout(r, 100));
  const port = srv.server.address().port;

  const get = (p) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p, headers: { Host: '127.0.0.1:' + port } }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    }).on('error', reject);
  });

  // SSE: subscribe before starting the loop, collect event names
  const sseEvents = new Set();
  const sseReq = http.get({ host: '127.0.0.1', port, path: '/api/stream', headers: { Host: '127.0.0.1:' + port } }, (res) => {
    res.on('data', (c) => {
      String(c).split('\n').forEach((l) => { if (l.startsWith('event: ')) sseEvents.add(l.slice(7).trim()); });
    });
  });
  sseReq.on('error', () => {});

  sched.start();

  // wait for first cycle_end (max 60 s)
  const evFile = path.join(proj, '.autopilot', 'events.jsonl');
  const deadline = Date.now() + 60000;
  let evs = [];
  while (Date.now() < deadline) {
    if (fs.existsSync(evFile)) {
      evs = fs.readFileSync(evFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (evs.some((e) => e.ev === 'cycle_end')) break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  const end = evs.find((e) => e.ev === 'cycle_end');
  check('cycle_start stamped', evs.some((e) => e.ev === 'cycle_start'));
  check('cycle_end stamped', !!end, end ? 'exit=' + end.exit : 'timed out');
  check('cycle_end exit clean', !!end && end.exit === 'clean');
  check('cycle_end has tokens', !!end && end.tokens && end.tokens.in > 0, end && JSON.stringify(end.tokens));

  // auto-commit exists in project git
  let gitLog = '';
  try { gitLog = execFileSync('git', ['-C', proj, 'log', '--oneline'], { encoding: 'utf8' }); } catch (e) { gitLog = 'GIT ERR ' + e.message; }
  check('auto-commit in project repo', /auto-commit/.test(gitLog), gitLog.split('\n')[0]);

  // containment artifacts
  check('cycle_settings.json generated', fs.existsSync(path.join(proj, '.autopilot', 'cycle_settings.json')));
  check('guard.ps1 generated + ASCII', (() => {
    const g = path.join(proj, '.autopilot', 'guard.ps1');
    if (!fs.existsSync(g)) return false;
    return /^[\x00-\x7F]*$/.test(fs.readFileSync(g, 'latin1'));
  })());

  // ACTIVITY.log got model lines
  const act = path.join(proj, 'ACTIVITY.log');
  check('ACTIVITY.log has model line', fs.existsSync(act) && /\[model\]/.test(fs.readFileSync(act, 'utf8')));

  // API
  const st = await get('/api/status');
  const snap = JSON.parse(st.body);
  const p = (snap.projects || []).find((x) => x.id === project.id);
  check('/api/status 200 + project present', st.status === 200 && !!p);
  check('snapshot cycle >= 1', !!p && p.cycle >= 1, p && 'cycle=' + p.cycle + ' status=' + p.status);
  const evApi = await get('/api/projects/' + project.id + '/events?limit=50');
  check('/api/.../events returns cycle_end', /cycle_end/.test(evApi.body));
  const badHost = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/status', headers: { Host: 'evil.example:80' } }, (res) => resolve(res.statusCode)).on('error', reject);
  });
  check('bad Host header -> 403', badHost === 403);

  // STOP: touch it, project should go stopped and no new cycles start
  const cyclesBefore = evs.filter((e) => e.ev === 'cycle_start').length;
  fs.writeFileSync(path.join(proj, '.autopilot', 'STOP'), '');
  await new Promise((r) => setTimeout(r, 1500));
  const st2 = JSON.parse((await get('/api/status')).body);
  const p2 = (st2.projects || []).find((x) => x.id === project.id);
  check('STOP file -> status stopped', !!p2 && p2.status === 'stopped', p2 && p2.status);
  const evs2 = fs.readFileSync(evFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  // allow a cycle that was already in flight when STOP landed; require growth to stop after
  await new Promise((r) => setTimeout(r, 1000));
  const evs3 = fs.readFileSync(evFile, 'utf8').trim().split('\n').filter(Boolean).length;
  check('no new cycles after STOP settles', evs3 === fs.readFileSync(evFile, 'utf8').trim().split('\n').filter(Boolean).length);

  check('SSE delivered status event', sseEvents.has('status'), Array.from(sseEvents).join(','));

  // --- orchestrated project leg (v0.3): worker consumes the open order,
  // verify gate stamps, empty queue flips to an orchestrate cycle ---
  const proj2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-e2e-orch-'));
  const orchProj = state.addProject(stateObj, {
    dir: proj2,
    prompt: 'Orchestrated e2e project.',
    priority: 1,
    model: 'claude-fable-5-1',
    criticRatio: 0,
    reviewGateCycles: 0,
    containment: 'standard',
  });
  orchProj.workerModel = 'claude-sonnet-5';
  orchProj.verifyCmd = `"${process.execPath}" -e "process.exit(0)"`;
  orchProj.maxCycleMinutes = 1;
  orchProj.claudeCmd = [process.execPath, fakeClaude];
  fs.mkdirSync(path.join(proj2, 'orders'), { recursive: true });
  const orderPath = path.join(proj2, 'orders', '001-first.md');
  fs.writeFileSync(orderPath, '# First order\nstatus: open\ncreated: seed by cycle 0\nverify: -\n\n## Objective\nDo the thing.\n');
  state.save(stateObj);

  const evFile2 = path.join(proj2, '.autopilot', 'events.jsonl');
  const readEvs2 = () => {
    if (!fs.existsSync(evFile2)) return [];
    return fs.readFileSync(evFile2, 'utf8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  };
  let wend = null;
  const deadline2 = Date.now() + 60000;
  while (Date.now() < deadline2) {
    wend = readEvs2().find((e) => e.ev === 'cycle_end' && e.kind === 'work');
    if (wend) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check('worker cycle consumed the open order', !!wend && wend.order === '001-first', wend && JSON.stringify({ order: wend.order, model: wend.model }));
  check('worker ran with workerModel', !!wend && wend.model === 'claude-sonnet-5', wend && wend.model);
  check('verify gate ran and passed', !!wend && wend.verify && wend.verify.ok === true, wend && JSON.stringify(wend.verify));
  check('worker prompt carried the order', fs.existsSync(path.join(proj2, 'received_prompt.txt')) && /ONE work order|First order/.test(fs.readFileSync(path.join(proj2, 'received_prompt.txt'), 'utf8')));

  fs.writeFileSync(orderPath, '# First order\nstatus: done\ncreated: seed by cycle 0\nverify: -\n\n## Objective\nDo the thing.\n');
  let orch = null;
  const deadline3 = Date.now() + 60000;
  while (Date.now() < deadline3) {
    orch = readEvs2().find((e) => e.ev === 'cycle_start' && e.kind === 'orchestrate');
    if (orch) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check('empty queue flips to orchestrate cycle', !!orch);
  fs.writeFileSync(path.join(proj2, '.autopilot', 'STOP'), '');
  await new Promise((r) => setTimeout(r, 500));

  // --- experiments leg: 2-variant experiment, cycleCap 1, via the real API,
  // driven by the fake-claude runner (token-free) ---
  const expRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-e2e-exp-root-'));
  process.env.AUTOPILOT_EXPERIMENTS_DIR_OVERRIDE = expRoot;

  const post = (p, body) => new Promise((resolve, reject) => {
    const payload = JSON.stringify(body || {});
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'POST', headers: { Host: '127.0.0.1:' + port, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      }
    );
    req.on('error', reject);
    req.write(payload);
    req.end();
  });

  const expBody = {
    name: 'E2E Experiment',
    basePrompt: 'E2E experiment mission: trivial.',
    cycleCap: 1,
    defaults: {},
    variants: [
      { label: 'v1', overrides: {}, promptSuffix: '' },
      { label: 'v2', overrides: {}, promptSuffix: '' },
    ],
  };
  // Pause the loop while creating the experiment so the scheduler cannot
  // pick a freshly-registered variant and spawn the REAL claude binary
  // (project.claudeCmd only exists in-memory; the scheduler ticks
  // independently every 150ms, so without this pause it can win the race).
  sched.pauseAll();
  const expCreated = await post('/api/experiments', expBody);
  let expRecord = null;
  try { expRecord = JSON.parse(expCreated.body).experiment; } catch (e) { /* checked below */ }
  check('POST /api/experiments 200 + record', expCreated.status === 200 && !!expRecord, expCreated.body);

  if (expRecord) {
    // scheduler.addProject strips claudeCmd on load, but these entries were
    // just added in-memory (never round-tripped through disk yet) - set
    // claudeCmd directly on the live stateObj project entries so the
    // scheduler's own runner spawn uses fake-claude, same as the first leg.
    for (const v of expRecord.variants) {
      const proj = state.getProject(stateObj, v.projectId);
      if (proj) proj.claudeCmd = [process.execPath, fakeClaude];
    }
    sched.resumeAll();

    const variantEventsFile = (label) => {
      const v = expRecord.variants.find((x) => x.label === label);
      const proj = state.getProject(stateObj, v.projectId);
      return path.join(proj.dir, '.autopilot', 'events.jsonl');
    };
    const readVariantEvents = (label) => {
      const f = variantEventsFile(label);
      if (!fs.existsSync(f)) return [];
      return fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    };

    const expDeadline = Date.now() + 60000;
    let bothComplete = false;
    while (Date.now() < expDeadline) {
      const v1complete = readVariantEvents('v1').some((e) => e.ev === 'variant_complete');
      const v2complete = readVariantEvents('v2').some((e) => e.ev === 'variant_complete');
      if (v1complete && v2complete) { bothComplete = true; break; }
      await new Promise((r) => setTimeout(r, 250));
    }
    check('both experiment variants stamp variant_complete', bothComplete);

    const listRes = await get('/api/experiments');
    let expList = null;
    try { expList = JSON.parse(listRes.body).experiments; } catch (e) { /* checked below */ }
    const listedExp = expList && expList.find((e) => e.id === expRecord.id);
    check('GET /api/experiments shows complete:true', !!listedExp && listedExp.complete === true, listedExp && JSON.stringify({ complete: listedExp.complete }));
  } else {
    sched.resumeAll();
  }

  sseReq.destroy();
  await sched.stopDaemon();
  srv.close();

  const failed = results.filter(([, ok]) => !ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' e2e checks passed');
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('E2E HARNESS ERROR', e); process.exit(2); });
