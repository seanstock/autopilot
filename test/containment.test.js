'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const containment = require('../src/containment');
const preambles = require('../src/preambles');
const util = require('../src/util');

function tempProjectDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'autopilot-containment-test-'));
}

function baseProject(overrides) {
  return Object.assign(
    {
      id: 'demo',
      dir: tempProjectDir(),
      prompt: 'Build the thing and keep it working.',
      priority: 1,
      model: 'claude-sonnet-5',
      maxCycleMinutes: 120,
      criticRatio: 5,
      reviewGateCycles: 0,
      containment: 'standard',
    },
    overrides
  );
}

function hookPayload(command) {
  return JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
  });
}

// Plain `bash` on PATH is NOT trustworthy on Windows: outside of a Git Bash
// shell it commonly resolves to the WindowsApps WSL stub
// (C:\Users\<u>\AppData\Local\Microsoft\WindowsApps\bash.exe, or
// C:\Windows\system32\bash.exe), which fails with
// "execvpe(/bin/bash) failed: No such file or directory" instead of running
// anything. Probe known Git-for-Windows install locations explicitly and
// verify each candidate actually runs a command before trusting it. Falls
// back to plain `bash` (and to POSIX `bash` unconditionally) last.
function findWorkingBash() {
  const candidates = [];
  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(
      path.join(programFiles, 'Git', 'bin', 'bash.exe'),
      path.join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
      path.join(programFilesX86, 'Git', 'bin', 'bash.exe'),
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe'
    );
  }
  candidates.push('bash');

  for (const candidate of candidates) {
    try {
      const out = execFileSync(candidate, ['-c', 'echo ok'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000,
      });
      if (out.trim() === 'ok') {
        return candidate;
      }
    } catch (err) {
      // try the next candidate
    }
  }
  return null;
}

const BASH = findWorkingBash();
const bashSkip = BASH ? false : 'no working bash executable found on this machine';
const ps1Skip = process.platform !== 'win32' ? 'guard.ps1 only runs under PowerShell (win32)' : false;

function runGuardPs1(guardPs1Path, stdinText) {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', guardPs1Path], {
      input: stdinText,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { code: 0, stdout: out, stderr: '' };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    };
  }
}

function runGuardSh(guardShPath, stdinText) {
  try {
    const out = execFileSync(BASH, [guardShPath], {
      input: stdinText,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { code: 0, stdout: out, stderr: '' };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? err.stdout.toString() : '',
      stderr: err.stderr ? err.stderr.toString() : '',
    };
  }
}

// ---------------------------------------------------------------------------

test('generated guard.ps1 is pure ASCII bytes', () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const guardPs1 = path.join(path.dirname(settingsPath), 'guard.ps1');
  const bytes = fs.readFileSync(guardPs1);
  assert.match(bytes.toString('latin1'), /^[\x00-\x7F]*$/);
  // Sanity: file is non-trivial and does not contain a UTF-8 BOM.
  assert.ok(bytes.length > 0);
  assert.notEqual(bytes[0], 0xef);
});

test('generated guard.sh is pure ASCII bytes', () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const guardSh = path.join(path.dirname(settingsPath), 'guard.sh');
  const bytes = fs.readFileSync(guardSh);
  assert.match(bytes.toString('latin1'), /^[\x00-\x7F]*$/);
});

test('I3: guard.sh blocks a command containing a double quote (quote-truncation bypass fixed)', { skip: bashSkip }, () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const guardSh = path.join(path.dirname(settingsPath), 'guard.sh');

  // Verified-empirically bypass from the review finding: the old naive
  // `grep -o '"command"...:..."[^"]*"'` extraction stopped at the first `"`
  // inside the command string (the first escaped quote), so this command
  // extracted as just `echo \` and slipped past the api.anthropic.com
  // check entirely. A real JSON parse (via node) sees the whole string.
  const result = runGuardSh(guardSh, hookPayload('echo "hi"; curl https://api.anthropic.com/v1'));
  assert.equal(result.code, 2, 'a command containing a quote must still be checked against the full blocklist');
  assert.match(result.stderr, /^BLOCKED:/);
});

test('I5(b): guard.sh blocks a Bash command that mentions the Autopilot home directory', { skip: bashSkip }, () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const guardSh = path.join(path.dirname(settingsPath), 'guard.sh');

  // permissions.deny only constrains the Write/Edit *tools* - a Bash
  // command can still write ~/.autopilot files directly. The guard must
  // block on content alone, regardless of the permission layer. The guard
  // is generated with the real resolved AUTOPILOT_HOME path baked in (not
  // the literal "~"), so the probe command must use that same path. Uses a
  // filename other than projects.json so this exercises the dedicated
  // home-directory check, not the separate "projects\.json" pattern.
  const homePath = util.AUTOPILOT_HOME.split(path.sep).join('/');
  const result = runGuardSh(guardSh, hookPayload(`cat ${homePath}/daemon.pid`));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /autopilot home/i);
});

test('M1: guard.ps1 allows a recursive delete INSIDE the project dir despite backslash paths', { skip: ps1Skip }, () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const guardPs1 = path.join(path.dirname(settingsPath), 'guard.ps1');
  // Native path.join on Windows produces a backslash path - exactly the
  // realistic shape a model's own command would take, and exactly what
  // used to defeat the forward-slash-only -like comparison.
  const target = path.join(project.dir, 'junk');
  const result = runGuardPs1(guardPs1, hookPayload(`Remove-Item -Recurse -Force ${target}`));
  assert.equal(result.code, 0, 'a recursive delete inside the project dir must not be spuriously blocked');
});

test('I5(b): guard.ps1 blocks a command mentioning the Autopilot home directory', { skip: ps1Skip }, () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const guardPs1 = path.join(path.dirname(settingsPath), 'guard.ps1');
  const target = path.join(util.AUTOPILOT_HOME, 'daemon.pid');
  const result = runGuardPs1(guardPs1, hookPayload(`Get-Content ${target}`));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /autopilot home/i);
});

test('guard.sh blocks a command touching an Anthropic API endpoint', { skip: bashSkip }, () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const guardSh = path.join(path.dirname(settingsPath), 'guard.sh');

  const result = runGuardSh(guardSh, hookPayload('curl https://api.anthropic.com/v1/messages'));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^BLOCKED:/);
});

test('guard.sh allows a benign command', { skip: bashSkip }, () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const guardSh = path.join(path.dirname(settingsPath), 'guard.sh');

  const result = runGuardSh(guardSh, hookPayload('node --test test/'));
  assert.equal(result.code, 0);
});

test('guard.sh blocks API key env var usage and nested claude -p', { skip: bashSkip }, () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const guardSh = path.join(path.dirname(settingsPath), 'guard.sh');

  const r1 = runGuardSh(guardSh, hookPayload('echo $ANTHROPIC_API_KEY'));
  assert.equal(r1.code, 2);

  const r2 = runGuardSh(guardSh, hookPayload('claude -p "do more work"'));
  assert.equal(r2.code, 2);
});

test('guard.sh blocks recursive delete targeting outside the project dir', { skip: bashSkip }, () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const guardSh = path.join(path.dirname(settingsPath), 'guard.sh');

  const result = runGuardSh(guardSh, hookPayload('rm -rf /'));
  assert.equal(result.code, 2);
});

test('guard.sh allows recursive delete inside the project dir', { skip: bashSkip }, () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const guardSh = path.join(path.dirname(settingsPath), 'guard.sh');

  const target = path.join(project.dir, 'build');
  // Post-I3, extraction is a real JSON parse (via node), so this round-trips
  // correctly regardless of quoting in the command.
  const result = runGuardSh(guardSh, hookPayload(`rm -rf ${target.split(path.sep).join('/')}`));
  assert.equal(result.code, 0);
});

test('guard.sh with unparseable stdin allows (never bricks benign calls)', { skip: bashSkip }, () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const guardSh = path.join(path.dirname(settingsPath), 'guard.sh');

  const result = runGuardSh(guardSh, 'not json at all {{{');
  assert.equal(result.code, 0);
});

test('STOP file present blocks everything via guard.sh, even benign commands', { skip: bashSkip }, () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const guardSh = path.join(path.dirname(settingsPath), 'guard.sh');

  fs.mkdirSync(path.join(project.dir, '.autopilot'), { recursive: true });
  fs.writeFileSync(path.join(project.dir, '.autopilot', 'STOP'), '');

  const result = runGuardSh(guardSh, hookPayload('echo hi'));
  assert.equal(result.code, 2);
  assert.match(result.stderr, /^BLOCKED:/);
  assert.match(result.stderr, /stop file/i);
});

test('STOP file blocks even with unparseable stdin', { skip: bashSkip }, () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const guardSh = path.join(path.dirname(settingsPath), 'guard.sh');

  fs.mkdirSync(path.join(project.dir, '.autopilot'), { recursive: true });
  fs.writeFileSync(path.join(project.dir, '.autopilot', 'STOP'), '');

  const result = runGuardSh(guardSh, 'garbage not json');
  assert.equal(result.code, 2);
});

test('STOP enforcement still applies when containment is off', { skip: bashSkip }, () => {
  const project = baseProject({ containment: 'off' });
  const { settingsPath, warning } = containment.ensureContainment(project);
  assert.equal(warning, 'containment off');
  const guardSh = path.join(path.dirname(settingsPath), 'guard.sh');

  fs.mkdirSync(path.join(project.dir, '.autopilot'), { recursive: true });
  fs.writeFileSync(path.join(project.dir, '.autopilot', 'STOP'), '');

  const result = runGuardSh(guardSh, hookPayload('echo hi'));
  assert.equal(result.code, 2);
});

test('containment off skips the content blocklist (only STOP enforced)', { skip: bashSkip }, () => {
  const project = baseProject({ containment: 'off' });
  const { settingsPath } = containment.ensureContainment(project);
  const guardSh = path.join(path.dirname(settingsPath), 'guard.sh');

  const result = runGuardSh(guardSh, hookPayload('curl https://api.anthropic.com/v1/messages'));
  assert.equal(result.code, 0);
});

// --- static fallback assertions -----------------------------------------
//
// The tests above actually execute guard.sh under bash to prove behavior
// end-to-end, but a working bash is not guaranteed on every machine this
// suite runs on (see findWorkingBash() above). These checks assert directly
// on the generated script *content* instead of executing it, so the suite
// still meaningfully covers the guard's logic - stringified patterns, not
// runtime behavior - when no usable bash is present. They always run
// (never skipped).

test('[static] guard.sh (standard) source contains the full content blocklist', () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const guardSh = fs.readFileSync(path.join(path.dirname(settingsPath), 'guard.sh'), 'utf8');

  assert.match(guardSh, /ANTHROPIC_API_KEY\|ANTHROPIC_AUTH_TOKEN\|x-api-key/);
  assert.match(guardSh, /api\\\.anthropic\\\.com\|console\\\.anthropic\\\.com/);
  assert.match(guardSh, /\\\.credentials\\\.json/);
  assert.match(guardSh, /\\\.claude/);
  assert.match(guardSh, /schtasks\|systemctl\|launchctl\|reg/);
  assert.match(guardSh, /guard\\\.\(ps1\|sh\)\|cycle_settings\\\.json\|autopilot\\\.js/);
  assert.match(guardSh, /claude\[\[:space:\]\]\+\(-p\|--print\)/);
  assert.match(guardSh, /rm\[\[:space:\]\]\+-rf\|Remove-Item\.\*-Recurse/);
  // The project directory is baked in for the outside-project-dir check.
  assert.ok(guardSh.includes(project.dir.split(path.sep).join('/')));
});

test('[static] guard.sh checks the STOP file before reading/parsing stdin', () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const guardSh = fs.readFileSync(path.join(path.dirname(settingsPath), 'guard.sh'), 'utf8');

  const stopIdx = guardSh.indexOf('stop_file=');
  const stdinReadIdx = guardSh.indexOf('input="$(cat)"');
  assert.ok(stopIdx > -1, 'expected a stop_file check in guard.sh');
  assert.ok(stdinReadIdx > -1, 'expected guard.sh to read stdin for the blocklist');
  assert.ok(stopIdx < stdinReadIdx, 'STOP check must run before stdin is parsed');
  assert.match(guardSh, /if \[ -e "\$stop_file" \]; then/);
});

test('[static] guard.sh (containment off) has the STOP check but no blocklist', () => {
  const project = baseProject({ containment: 'off' });
  const { settingsPath } = containment.ensureContainment(project);
  const guardSh = fs.readFileSync(path.join(path.dirname(settingsPath), 'guard.sh'), 'utf8');

  assert.match(guardSh, /stop_file=/);
  assert.match(guardSh, /if \[ -e "\$stop_file" \]; then/);
  assert.doesNotMatch(guardSh, /ANTHROPIC_API_KEY/);
  assert.doesNotMatch(guardSh, /api\\\.anthropic\\\.com/);
  assert.match(guardSh, /containment is off/i);
});

test('containment off produces settings with no permissions.deny list', () => {
  const project = baseProject({ containment: 'off' });
  const { settingsPath } = containment.ensureContainment(project);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  // "off" drops the deny walls but keeps the allow list (a headless cycle
  // with no allows cannot use shell/web/MCP at all) and the STOP hook.
  assert.equal(settings.permissions.deny, undefined);
  assert.ok(settings.permissions.allow.includes('Bash'));
  assert.ok(settings.hooks.PreToolUse.length > 0);
});

test('cycle_settings.json parses and denies writes/edits under project .claude/', () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  assert.ok(Array.isArray(settings.permissions.deny));
  const deny = settings.permissions.deny;

  const claudeDirDeny = containment.toDenyPath(path.join(project.dir, '.claude', '**'));
  assert.ok(deny.some((rule) => rule.includes(claudeDirDeny) && rule.startsWith('Write(')));
  assert.ok(deny.some((rule) => rule.includes(claudeDirDeny) && rule.startsWith('Edit(')));

  const autopilotDirDeny = containment.toDenyPath(path.join(project.dir, '.autopilot', '**'));
  assert.ok(deny.some((rule) => rule.includes(autopilotDirDeny) && rule.startsWith('Write(')));
  assert.ok(deny.some((rule) => rule.includes(autopilotDirDeny) && rule.startsWith('Edit(')));

  assert.ok(deny.some((rule) => rule.includes('.credentials.json')));

  assert.ok(deny.some((rule) => rule === 'Read(~/.claude/**)'));
});

// --- I4 / I5(a): deny-rule path syntax -----------------------------------
//
// Authoritative syntax per code.claude.com/docs/en/permissions.md: Windows
// paths are normalized to POSIX before matching, so an absolute deny-rule
// path must use the double-slash filesystem-root anchor with a lowercase
// drive letter ("//c/Users/x"), never a plain "C:/Users/x" or "C:\Users\x"
// form (both are silently inert - the actual I4 root cause). Home-relative
// rules use the literal "~/" form. A Read deny does not imply a Write deny
// (or vice versa), so every path that must not be modified needs both.

test('I4: no generated deny rule contains a backslash', () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  for (const rule of settings.permissions.deny) {
    assert.ok(!rule.includes('\\'), `deny rule contains a backslash: ${rule}`);
  }
});

test('I4: absolute (non-home) deny rules use the //<drive>/ POSIX-normalized anchor on Windows', { skip: process.platform !== 'win32' }, () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const deny = settings.permissions.deny;

  const absoluteRules = deny.filter((rule) => !rule.includes('~/'));
  assert.ok(absoluteRules.length > 0, 'expected at least one non-home-relative deny rule');
  for (const rule of absoluteRules) {
    if (rule.includes('**/.credentials.json')) continue; // any-location glob, no drive letter
    assert.match(rule, /\(\/\/[a-z]\//, `expected a //<lowercase-drive>/ anchor in: ${rule}`);
  }

  // Spot-check toDenyPath() directly against a known Windows path shape.
  assert.equal(containment.toDenyPath('C:\\Users\\alice\\proj\\.autopilot\\**'), '//c/Users/alice/proj/.autopilot/**');
  // Allow list: headless -p auto-denies unlisted tools, so cycles need an
  // explicit allow for shell/web/MCP (SPEC section 5); project.mcp names
  // become mcp__<name> allows; guard matcher must cover both shell tools.
  {
    const mdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-allow-'));
    const r = containment.ensureContainment({ id: 'allow-probe', dir: mdir, containment: 'standard', mcp: ['blender'] });
    const s = JSON.parse(fs.readFileSync(r.settingsPath, 'utf8'));
    assert.equal(s.permissions.defaultMode, 'acceptEdits');
    for (const t of ['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'mcp__blender']) {
      assert.ok(s.permissions.allow.includes(t), 'allow list missing ' + t);
    }
    assert.ok(Array.isArray(s.permissions.deny) && s.permissions.deny.length > 0, 'standard containment still carries deny rules');
    assert.equal(s.hooks.PreToolUse[0].matcher, 'Bash|PowerShell');
  }

  // NEW-1: POSIX absolute paths also need the double-slash root anchor
  // (a single leading slash is settings-file-relative in the rule grammar).
  assert.equal(containment.toDenyPath('/home/alice/proj/.autopilot/**'), '//home/alice/proj/.autopilot/**');
  // Already-anchored and ~-relative forms pass through untouched.
  assert.equal(containment.toDenyPath('//home/alice/x/**'), '//home/alice/x/**');
  assert.equal(containment.toDenyPath('~/.autopilot/**'), '~/.autopilot/**');
});

test('I4/I5: every deny target that must not be modified has BOTH Write(...) and Edit(...)', () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const deny = settings.permissions.deny;

  const writeTargets = deny.filter((r) => r.startsWith('Write(')).map((r) => r.slice('Write('.length, -1));
  const editTargets = deny.filter((r) => r.startsWith('Edit(')).map((r) => r.slice('Edit('.length, -1));
  assert.deepEqual(writeTargets.sort(), editTargets.sort(), 'every Write(...) target must have a matching Edit(...) and vice versa');
  assert.ok(writeTargets.length >= 5, 'expected home .claude, home .autopilot, project .autopilot, project .claude, install dir');
});

test('I5(a): ~/.autopilot (AUTOPILOT_HOME) is denied Write+Edit - a cycle must not rewrite projects.json', () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const deny = settings.permissions.deny;
  assert.ok(deny.includes('Write(~/.autopilot/**)'));
  assert.ok(deny.includes('Edit(~/.autopilot/**)'));
});

test('cycle_settings.json wires the PreToolUse Bash hook to the guard script', () => {
  const project = baseProject();
  const { settingsPath } = containment.ensureContainment(project);
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

  const preToolUse = settings.hooks.PreToolUse;
  assert.equal(preToolUse.length, 1);
  assert.equal(preToolUse[0].matcher, 'Bash|PowerShell');
  const command = preToolUse[0].hooks[0].command;
  assert.equal(preToolUse[0].hooks[0].type, 'command');
  if (process.platform === 'win32') {
    assert.match(command, /guard\.ps1/);
    assert.match(command, /powershell/i);
  } else {
    assert.match(command, /guard\.sh/);
  }
});

test('git repo is initialized in the project dir', () => {
  const project = baseProject();
  assert.equal(fs.existsSync(path.join(project.dir, '.git')), false);
  containment.ensureContainment(project);
  assert.equal(fs.existsSync(path.join(project.dir, '.git')), true);

  const head = execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: project.dir,
    encoding: 'utf8',
  }).trim();
  assert.equal(head, 'true');
});

test('gitignore is seeded only when absent', () => {
  const project = baseProject();
  containment.ensureContainment(project);
  const gitignorePath = path.join(project.dir, '.gitignore');
  assert.ok(fs.existsSync(gitignorePath));
  const seeded = fs.readFileSync(gitignorePath, 'utf8');
  assert.match(seeded, /node_modules/);

  // A pre-existing .gitignore must not be clobbered.
  const project2 = baseProject();
  fs.writeFileSync(path.join(project2.dir, '.gitignore'), 'custom-content\n');
  containment.ensureContainment(project2);
  const content2 = fs.readFileSync(path.join(project2.dir, '.gitignore'), 'utf8');
  assert.equal(content2, 'custom-content\n');
});

test('ensureContainment returns settingsPath under <dir>/.autopilot/cycle_settings.json', () => {
  const project = baseProject();
  const result = containment.ensureContainment(project);
  assert.equal(result.settingsPath, path.join(project.dir, '.autopilot', 'cycle_settings.json'));
  assert.equal(result.warning, undefined);
});

// --- v0.3: orchestrate settings variant + scout agent ------------------------

test('ensureContainment returns {settingsPath, orchestrateSettingsPath} shape (no warning when containment standard)', () => {
  const project = baseProject();
  const result = containment.ensureContainment(project);
  assert.equal(result.settingsPath, path.join(project.dir, '.autopilot', 'cycle_settings.json'));
  assert.equal(result.orchestrateSettingsPath, path.join(project.dir, '.autopilot', 'cycle_settings_orchestrate.json'));
  assert.equal(result.warning, undefined);
  assert.ok(fs.existsSync(result.settingsPath));
  assert.ok(fs.existsSync(result.orchestrateSettingsPath));
});

test('ensureContainment return shape carries warning + orchestrateSettingsPath when containment is off', () => {
  const project = baseProject({ containment: 'off' });
  const result = containment.ensureContainment(project);
  assert.equal(result.warning, 'containment off');
  assert.equal(result.orchestrateSettingsPath, path.join(project.dir, '.autopilot', 'cycle_settings_orchestrate.json'));
  assert.ok(fs.existsSync(result.orchestrateSettingsPath));
});

test('orchestrate settings variant allows Task while the base variant does not', () => {
  const project = baseProject();
  const { settingsPath, orchestrateSettingsPath } = containment.ensureContainment(project);
  const base = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const orchestrate = JSON.parse(fs.readFileSync(orchestrateSettingsPath, 'utf8'));

  assert.ok(!base.permissions.allow.includes('Task'), 'base settings must not allow Task');
  assert.ok(orchestrate.permissions.allow.includes('Task'), 'orchestrate settings must allow Task');

  // Orchestrate variant is otherwise the base variant (same deny walls,
  // same hook wiring) with Task added, not a divergent settings shape.
  assert.deepEqual(orchestrate.permissions.deny, base.permissions.deny);
  assert.deepEqual(orchestrate.hooks, base.hooks);
  assert.deepEqual(
    orchestrate.permissions.allow.filter((t) => t !== 'Task').sort(),
    base.permissions.allow.sort()
  );
});

test('orchestrate settings variant allows Task even when containment is off', () => {
  const project = baseProject({ containment: 'off' });
  const { orchestrateSettingsPath } = containment.ensureContainment(project);
  const orchestrate = JSON.parse(fs.readFileSync(orchestrateSettingsPath, 'utf8'));
  assert.ok(orchestrate.permissions.allow.includes('Task'));
  assert.equal(orchestrate.permissions.deny, undefined);
});

test('scout.md is NOT written when project.workerModel is absent', () => {
  const project = baseProject();
  containment.ensureContainment(project);
  const scoutPath = path.join(project.dir, '.claude', 'agents', 'scout.md');
  assert.equal(fs.existsSync(scoutPath), false);
});

test('scout.md is written under <dir>/.claude/agents/scout.md when project.workerModel is set', () => {
  const project = baseProject({ workerModel: 'claude-haiku' });
  containment.ensureContainment(project);
  const scoutPath = path.join(project.dir, '.claude', 'agents', 'scout.md');
  assert.ok(fs.existsSync(scoutPath));
});

test('scout.md is pure ASCII bytes', () => {
  const project = baseProject({ workerModel: 'claude-haiku' });
  containment.ensureContainment(project);
  const scoutPath = path.join(project.dir, '.claude', 'agents', 'scout.md');
  const bytes = fs.readFileSync(scoutPath);
  assert.match(bytes.toString('latin1'), /^[\x00-\x7F]*$/);
  assert.ok(bytes.length > 0);
});

test('scout.md frontmatter has name, description, the five read-only tools, and model: sonnet - no Edit/Write/Bash', () => {
  const project = baseProject({ workerModel: 'claude-haiku' });
  containment.ensureContainment(project);
  const scoutPath = path.join(project.dir, '.claude', 'agents', 'scout.md');
  const content = fs.readFileSync(scoutPath, 'utf8');

  assert.match(content, /^---\r?\n/);
  assert.match(content, /name:\s*scout/);
  assert.match(content, /description:\s*Read-only research and verification subagent\. Use for parallel exploration, auditing, and fact-checking\. Never edits files\./);
  assert.match(content, /model:\s*sonnet/);

  const toolsLine = /tools:\s*(.+)/.exec(content);
  assert.ok(toolsLine, 'expected a tools: line in scout.md frontmatter');
  const tools = toolsLine[1].split(',').map((t) => t.trim());
  assert.deepEqual(tools.sort(), ['Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch'].sort());
  assert.ok(!tools.includes('Edit'));
  assert.ok(!tools.includes('Write'));
  assert.ok(!tools.includes('Bash'));
});

// --- preambles --------------------------------------------------------------

test('workPreamble includes PLAN.md, UPDATES.md, never force-push, and the mission prompt', () => {
  const project = baseProject({ prompt: 'UNIQUE_MISSION_TEXT_12345' });
  const text = preambles.workPreamble(project);
  assert.match(text, /PLAN\.md/);
  assert.match(text, /UPDATES\.md/);
  assert.match(text, /never\s+force-push/i);
  assert.match(text, /UNIQUE_MISSION_TEXT_12345/);
  assert.match(text, /## Mission/);
  // Mission prompt must appear after the ## Mission heading, at the end.
  const missionIdx = text.indexOf('## Mission');
  const promptIdx = text.indexOf('UNIQUE_MISSION_TEXT_12345');
  assert.ok(missionIdx > -1 && promptIdx > missionIdx);
});

test('workPreamble honors reviewGateCycles conclude-option language', () => {
  const gated = preambles.workPreamble(baseProject({ reviewGateCycles: 5 }));
  assert.match(gated, /conclude/i);

  const ungated = preambles.workPreamble(baseProject({ reviewGateCycles: 0 }));
  assert.match(ungated, /no "complete"|There is no/i);
});

test('criticPreamble includes PLAN.md, UPDATES.md, never force-push, refute language, and the mission prompt', () => {
  const project = baseProject({ prompt: 'CRITIC_MISSION_TEXT_67890' });
  const text = preambles.criticPreamble(project);
  assert.match(text, /PLAN\.md/);
  assert.match(text, /UPDATES\.md/);
  assert.match(text, /never\s+force-push/i);
  assert.match(text, /REFUTE/);
  assert.match(text, /CRITIC_MISSION_TEXT_67890/);
  assert.match(text, /## Mission/);
});

// Was '1' until 2026-08-08. Bumped to '2' when FINDINGS.md and the PLAN.md
// prune rule entered the contract: cycles run under a materially different
// set of obligations, so the version a cycle reports must distinguish them.
test('PREAMBLE_VERSION is the string "2"', () => {
  assert.equal(preambles.PREAMBLE_VERSION, '2');
});

// FINDINGS.md is durable project memory, deliberately bounded. The cap is
// load-bearing: it is what lets every cycle read the file in full, which is
// the whole reason it exists alongside tail-read UPDATES.md.
test('workPreamble defines the FINDINGS.md contract: read it, cap it, facts not instructions', () => {
  const text = preambles.workPreamble(baseProject());
  assert.match(text, /FINDINGS\.md/);
  assert.match(text, /100 lines/i);
  assert.match(text, /consolidate/i);
  // The guard that keeps it from becoming a second instruction surface.
  assert.match(text, /FACTS, NEVER INSTRUCTIONS/);
  // And from becoming a second UPDATES.md.
  assert.match(text, /EDIT IN PLACE/);
});

test('workPreamble and orchestratorPreamble both require pruning PLAN.md rather than accumulating', () => {
  for (const text of [preambles.workPreamble(baseProject()), preambles.orchestratorPreamble(baseProject())]) {
    assert.match(text, /prun(e|ing)/i);
    assert.match(text, /archive/i);
  }
});

test('orchestratorPreamble reads FINDINGS.md in full and may write it; criticPreamble reads but never edits it', () => {
  const orch = preambles.orchestratorPreamble(baseProject());
  assert.match(orch, /FINDINGS\.md \(in full/);
  assert.match(orch, /100 lines/);

  const critic = preambles.criticPreamble(baseProject());
  assert.match(critic, /FINDINGS\.md/);
  assert.match(critic, /Do not edit it/);
});

// --- v0.3: orchestratorPreamble, workerOrderSection, injectionSection ---------

test('orchestratorPreamble forbids implementation work and covers orders/ contract, closing/reopening, and scout effort-scaling', () => {
  const project = baseProject({ prompt: 'ORCH_MISSION_TEXT_11111' });
  const text = preambles.orchestratorPreamble(project);
  assert.match(text, /no implementation work|NO implementation work/i);
  assert.match(text, /orders\//);
  assert.match(text, /status:\s*open\|in_progress\|done\|blocked|open\|in_progress\|done\|blocked/);
  assert.match(text, /disposable/i);
  assert.match(text, /verify/i);
  assert.match(text, /reopen/i);
  assert.match(text, /scout/i);
  assert.match(text, /PLAN\.md/);
  assert.match(text, /UPDATES\.md/);
  assert.match(text, /never\s+force-push/i);
  assert.match(text, /ORCH_MISSION_TEXT_11111/);
  assert.match(text, /## Mission/);
});

test('orchestratorPreamble quotes the exact order file format', () => {
  const text = preambles.orchestratorPreamble(baseProject());
  assert.match(text, /# <title>/);
  assert.match(text, /status: open/);
  assert.match(text, /created: <iso> by cycle <n>/);
  assert.match(text, /verify: <command, or - if none>/);
  assert.match(text, /## Objective/);
  assert.match(text, /## Acceptance criteria/);
  assert.match(text, /## Boundaries/);
});

test('workerOrderSection embeds the order verbatim and states the ONE-order rule', () => {
  const order = { id: '003-do-thing', content: '# Do the thing\nstatus: open\nUNIQUE_ORDER_BODY_99999' };
  const text = preambles.workerOrderSection(order);
  assert.match(text, /ONE work order/i);
  assert.match(text, /003-do-thing/);
  assert.match(text, /UNIQUE_ORDER_BODY_99999/);
  assert.match(text, /status: in_progress/);
  assert.match(text, /status: blocked/);
  assert.match(text, /verify/i);
  assert.match(text, /END the cycle/i);
});

test('injectionSection default (non-orchestrated) keeps the v0.2 "do the work" triage language', () => {
  const text = preambles.injectionSection('UNIQUE_DIRECTIVE_22222');
  assert.match(text, /UNIQUE_DIRECTIVE_22222/);
  assert.match(text, /break\s+it into PLAN tasks and start executing them/i);
});

test('injectionSection(text, true) routes "complex" to spec update + orders, not direct execution', () => {
  const text = preambles.injectionSection('UNIQUE_DIRECTIVE_33333', true);
  assert.match(text, /UNIQUE_DIRECTIVE_33333/);
  assert.match(text, /emit\s+(one\s+or\s+)?more\s+work\s+orders/i);
  assert.match(text, /orders\//);
  assert.doesNotMatch(text, /break\s+it into PLAN tasks and start executing them/i);
});
