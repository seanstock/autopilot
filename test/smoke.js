// Real-environment smoke (SPEC section 8): one REAL claude cycle in a scratch
// project. Verifies auth path, encoding, stream-json parsing, containment
// generation, preamble contract, auto-commit — in the daemon's actual environment.
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

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-smoke-home-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-smoke-proj-'));
  process.env.AUTOPILOT_HOME_OVERRIDE = home;
  delete process.env.FAKE_MODE;

  const { runCycle } = require(REPO + '/src/runner.js');

  const project = {
    id: 'smoke',
    dir: proj,
    prompt: 'The entire mission: ensure a file named hello.txt exists in the project root containing exactly the word: hello\nWhen it exists and is verified, the mission is complete. Keep PLAN.md accurate. This is a tiny smoke-test project; do not invent extra work.',
    priority: 1,
    enabled: true,
    model: 'claude-haiku-4-5-20251001',
    maxCycleMinutes: 5,
    criticRatio: 0,
    reviewGateCycles: 1,
    containment: 'standard',
  };

  const tripwire = [];
  const fakeBudget = {
    scanForTripwire: (t) => { if (/credit balance/i.test(String(t))) tripwire.push(1); return false; },
    noteUsageLimitExit: () => {},
  };

  console.log('running one REAL cycle (haiku, max 5 min)...');
  const t0 = Date.now();
  const res = await runCycle({ project, kind: 'work', cycleNumber: 1, budget: fakeBudget });
  console.log('cycle returned in ' + Math.round((Date.now() - t0) / 1000) + 's: ' + JSON.stringify({ exit: res.exit, code: res.code, minutes: res.minutes, tokens: res.tokens, costUsd: res.costUsd, commit: res.commit, gitDiff: res.gitDiff }));

  check('exit clean', res.exit === 'clean', res.exit);
  check('tokens counted', res.tokens && res.tokens.in > 0 && res.tokens.out > 0, JSON.stringify(res.tokens));
  check('hello.txt written by cycle', fs.existsSync(path.join(proj, 'hello.txt')) && /hello/.test(fs.readFileSync(path.join(proj, 'hello.txt'), 'utf8')));
  check('PLAN.md exists', fs.existsSync(path.join(proj, 'PLAN.md')));
  check('UPDATES.md entry written', fs.existsSync(path.join(proj, 'UPDATES.md')) && fs.readFileSync(path.join(proj, 'UPDATES.md'), 'utf8').trim().length > 20);
  check('WORKLOG.md exists', fs.existsSync(path.join(proj, 'WORKLOG.md')));
  check('ACTIVITY.log has model lines', fs.existsSync(path.join(proj, 'ACTIVITY.log')) && /\[model\]/.test(fs.readFileSync(path.join(proj, 'ACTIVITY.log'), 'utf8')));
  let gitLog = '';
  try { gitLog = execFileSync('git', ['-C', proj, 'log', '--oneline'], { encoding: 'utf8' }); } catch (e) { gitLog = 'GIT ERR'; }
  check('commits exist (auto-commit and/or cycle commits)', /auto-commit|./.test(gitLog) && gitLog.trim().length > 0, gitLog.trim().split('\n').length + ' commit(s)');
  check('no credit tripwire', tripwire.length === 0);

  const failed = results.filter(([, ok]) => !ok);
  console.log('\n' + (results.length - failed.length) + '/' + results.length + ' smoke checks passed');
  console.log('scratch project kept for inspection: ' + proj);
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error('SMOKE HARNESS ERROR', e); process.exit(2); });
