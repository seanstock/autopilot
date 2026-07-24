// Real-environment orchestration smoke (v0.3): one REAL orchestrate cycle
// (creates work orders from the mission) + one REAL worker cycle (executes
// the first open order). Haiku both roles to keep the burn small.
// Spends real usage (~$0.2-0.4). Run explicitly; never part of npm test.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const results = [];
function check(name, ok, extra) {
  results.push([name, ok]);
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' :: ' + extra : ''));
}

const ORDER_STATUS_RE = /^status:\s*(open|in_progress|done|blocked)\b/;
function listOrders(dir) {
  const od = path.join(dir, 'orders');
  if (!fs.existsSync(od)) return [];
  return fs.readdirSync(od).filter((f) => /\.md$/i.test(f)).sort().map((f) => {
    const content = fs.readFileSync(path.join(od, f), 'utf8');
    let status = 'open';
    for (const line of content.split(/\r?\n/).slice(0, 10)) {
      const m = ORDER_STATUS_RE.exec(line);
      if (m) { status = m[1]; break; }
    }
    return { id: f.replace(/\.md$/i, ''), status, content };
  });
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-orch-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-orch-proj-'));
  process.env.AUTOPILOT_HOME_OVERRIDE = home;
  delete process.env.FAKE_MODE;

  const { runCycle } = require(REPO + '/src/runner.js');

  const project = {
    id: 'orch-smoke',
    dir: proj,
    prompt: 'The entire mission: a file named greeting.txt must exist in the project root containing exactly the word: hello\nNothing else is in scope. This is a tiny smoke-test project; do not invent extra work beyond 1-2 small orders.',
    priority: 1,
    enabled: true,
    model: 'claude-haiku-4-5-20251001',
    workerModel: 'claude-haiku-4-5-20251001',
    verifyCmd: `"${process.execPath}" -e "process.exit(require('fs').existsSync('greeting.txt')?0:1)"`,
    maxCycleMinutes: 6,
    criticRatio: 0,
    reviewGateCycles: 0,
    containment: 'standard',
  };
  const budget = { scanForTripwire: () => false, noteUsageLimitExit: () => {} };

  console.log('cycle 1: REAL orchestrate (haiku, max 6 min)...');
  const r1 = await runCycle({ project, kind: 'orchestrate', cycleNumber: 1, budget, order: null });
  console.log('  -> ' + JSON.stringify({ exit: r1.exit, minutes: +r1.minutes.toFixed(1), costUsd: r1.costUsd, verify: r1.verify && r1.verify.ok }));
  check('orchestrate exits clean', r1.exit === 'clean', r1.exit);
  const orders1 = listOrders(proj);
  check('orchestrate created work orders', orders1.length >= 1, orders1.map((o) => o.id + ':' + o.status).join(', '));
  check('orchestrate did NOT do the work itself', !fs.existsSync(path.join(proj, 'greeting.txt')), 'greeting.txt must not exist yet');
  check('verify gate correctly fails before work', r1.verify && r1.verify.ok === false, JSON.stringify(r1.verify));
  check('modelUsage captured', !!r1.modelUsage, r1.modelUsage && Object.keys(r1.modelUsage).join(','));

  const open = orders1.find((o) => o.status === 'open');
  check('an open order exists for the worker', !!open);
  if (!open) return finish();

  console.log('cycle 2: REAL worker on order ' + open.id + ' (haiku, max 6 min)...');
  const r2 = await runCycle({
    project: Object.assign({}, project, { model: project.workerModel }),
    kind: 'work',
    cycleNumber: 2,
    budget,
    order: { id: open.id, content: open.content },
  });
  console.log('  -> ' + JSON.stringify({ exit: r2.exit, minutes: +r2.minutes.toFixed(1), costUsd: r2.costUsd, verify: r2.verify && r2.verify.ok }));
  check('worker exits clean', r2.exit === 'clean', r2.exit);
  check('worker did the work (greeting.txt)', fs.existsSync(path.join(proj, 'greeting.txt')) && /hello/.test(fs.readFileSync(path.join(proj, 'greeting.txt'), 'utf8')));
  check('verify gate passes after work', r2.verify && r2.verify.ok === true, JSON.stringify(r2.verify));
  const after = listOrders(proj).find((o) => o.id === open.id);
  check('worker advanced the order status', !!after && after.status !== 'open', after && after.status);
  let gitLog = '';
  try { gitLog = execFileSync('git', ['-C', proj, 'log', '--oneline'], { encoding: 'utf8' }); } catch (e) { gitLog = ''; }
  check('commits exist', gitLog.trim().length > 0, gitLog.trim().split('\n').length + ' commit(s)');

  finish();
  function finish() {
    const failed = results.filter(([, ok]) => !ok);
    console.log('\n' + (results.length - failed.length) + '/' + results.length + ' orchestration smoke checks passed');
    console.log('scratch project kept: ' + proj);
    process.exit(failed.length ? 1 : 0);
  }
}

main().catch((e) => { console.error('SMOKE HARNESS ERROR', e); process.exit(2); });
