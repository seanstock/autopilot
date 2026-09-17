'use strict';
// Cross-platform command construction.
//
// Autopilot already branched on process.platform in most places (containment
// generates both guard.ps1 and guard.sh, runner picks cmd/sh, the daemon opens
// a browser per-OS). The two things that were Windows-only were desktop
// notifications and run-at-login.
//
// Those are now pure functions returning a command/plan, so every platform's
// behaviour is testable from any single host OS. That matters here: this
// project is developed on Windows and there is no macOS or Linux box in the
// loop, so without these tests the non-Windows paths would ship unexecuted.
//
// What these tests DO prove: the right binary and arguments are constructed,
// and unsupported platforms degrade to null rather than throwing.
// What they do NOT prove: that osascript, notify-send, launchctl or systemctl
// actually behave as expected on a real machine. That still needs a real Mac
// or Linux box.

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const { buildToastCommand } = require('../src/notify');
const { buildBootPlan } = require('../autopilot');

// ---- notifications ---------------------------------------------------------

test('windows toast uses powershell and embeds the text', () => {
  const cmd = buildToastCommand('win32', 'Title', 'Body');
  assert.equal(cmd.bin, 'powershell');
  assert.ok(cmd.args.includes('-NoProfile'));
  const script = cmd.args[cmd.args.length - 1];
  assert.match(script, /Title/);
  assert.match(script, /Body/);
});

test('macos toast uses osascript with a display notification script', () => {
  const cmd = buildToastCommand('darwin', 'Cycle done', 'razzle finished');
  assert.equal(cmd.bin, 'osascript');
  assert.deepEqual(cmd.args.slice(0, 1), ['-e']);
  assert.match(cmd.args[1], /^display notification "razzle finished" with title "Cycle done"$/);
});

test('linux toast uses notify-send with args, not a shell string', () => {
  const cmd = buildToastCommand('linux', 'Cycle done', 'razzle finished');
  assert.equal(cmd.bin, 'notify-send');
  assert.deepEqual(cmd.args, ['--app-name=Autopilot', 'Cycle done', 'razzle finished']);
});

// Quoting is where a notification turns into a command-injection bug, so it is
// pinned per platform rather than assumed.
test('macos toast escapes quotes and backslashes in the applescript literal', () => {
  const cmd = buildToastCommand('darwin', 'He said "hi"', 'path C:\\temp');
  assert.match(cmd.args[1], /He said \\"hi\\"/);
  assert.match(cmd.args[1], /path C:\\\\temp/);
});

test('windows toast escapes single quotes for the powershell literal', () => {
  const cmd = buildToastCommand('win32', "it's", "o'clock");
  const script = cmd.args[cmd.args.length - 1];
  assert.match(script, /it''s/);
  assert.match(script, /o''clock/);
});

test('linux toast passes text through untouched because args bypass the shell', () => {
  const cmd = buildToastCommand('linux', 'a"b', "c'd; rm -rf /");
  assert.equal(cmd.args[1], 'a"b');
  assert.equal(cmd.args[2], "c'd; rm -rf /");
});

test('an unknown platform yields no toast command rather than throwing', () => {
  assert.equal(buildToastCommand('sunos', 'a', 'b'), null);
  assert.equal(buildToastCommand('aix', 'a', 'b'), null);
});

// ---- run at login ----------------------------------------------------------

const NODE = '/usr/bin/node';
const SCRIPT = '/opt/autopilot/autopilot.js';
const HOME = '/home/someone';

test('windows boot on registers an ONLOGON scheduled task', () => {
  const p = buildBootPlan('win32', 'on', NODE, SCRIPT, HOME);
  assert.equal(p.bin, 'schtasks');
  assert.ok(p.args.includes('/Create'));
  assert.ok(p.args.includes('ONLOGON'));
  assert.ok(p.args.join(' ').includes('daemon'));
});

test('windows boot off deletes the scheduled task', () => {
  const p = buildBootPlan('win32', 'off', NODE, SCRIPT, HOME);
  assert.equal(p.bin, 'schtasks');
  assert.ok(p.args.includes('/Delete'));
});

test('macos boot on writes a LaunchAgents plist and loads it', () => {
  const p = buildBootPlan('darwin', 'on', NODE, SCRIPT, HOME);
  assert.equal(p.bin, 'launchctl');
  assert.deepEqual(p.args, ['load', p.write]);
  assert.equal(p.write, path.join(HOME, 'Library', 'LaunchAgents', 'com.autopilot.daemon.plist'));
  assert.match(p.content, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(p.content, /<string>\/usr\/bin\/node<\/string>/);
  assert.match(p.content, /<string>daemon<\/string>/);
});

test('macos boot off unloads and removes the plist', () => {
  const p = buildBootPlan('darwin', 'off', NODE, SCRIPT, HOME);
  assert.equal(p.bin, 'launchctl');
  assert.deepEqual(p.args, ['unload', p.remove]);
  assert.ok(p.remove.endsWith('com.autopilot.daemon.plist'));
  assert.equal(p.write, undefined, 'removal must not also write a file');
});

test('linux boot on writes a systemd user unit and enables it', () => {
  const p = buildBootPlan('linux', 'on', NODE, SCRIPT, HOME);
  assert.equal(p.bin, 'systemctl');
  assert.deepEqual(p.args, ['--user', 'enable', '--now', 'autopilot.service']);
  assert.equal(p.write, path.join(HOME, '.config', 'systemd', 'user', 'autopilot.service'));
  assert.match(p.content, /ExecStart=\/usr\/bin\/node \/opt\/autopilot\/autopilot\.js daemon/);
  assert.match(p.content, /WantedBy=default\.target/);
});

test('linux boot off disables and removes the unit', () => {
  const p = buildBootPlan('linux', 'off', NODE, SCRIPT, HOME);
  assert.equal(p.bin, 'systemctl');
  assert.deepEqual(p.args, ['--user', 'disable', 'autopilot.service']);
  assert.ok(p.remove.endsWith('autopilot.service'));
  assert.equal(p.write, undefined, 'removal must not also write a file');
});

test('an unknown platform yields no boot plan rather than throwing', () => {
  assert.equal(buildBootPlan('sunos', 'on', NODE, SCRIPT, HOME), null);
});

test('an invalid action yields no plan on every platform', () => {
  for (const plat of ['win32', 'darwin', 'linux']) {
    assert.equal(buildBootPlan(plat, 'sideways', NODE, SCRIPT, HOME), null, plat);
  }
});

// Every non-Windows plan writes into the user's own home, never a system path
// needing root. A boot command that silently demands sudo is worse than one
// that is unsupported.
test('no boot plan touches a path outside the user home', () => {
  // path.join uses the HOST separator, so this test runs on Windows against
  // paths built with backslashes even though the branch under test only ever
  // executes on macOS/Linux. Normalise before comparing, or the assertion
  // fails for a reason that has nothing to do with the code.
  const norm = (s) => s.split(path.sep).join('/');
  for (const plat of ['darwin', 'linux']) {
    for (const action of ['on', 'off']) {
      const p = buildBootPlan(plat, action, NODE, SCRIPT, HOME);
      const target = p.write || p.remove;
      assert.ok(norm(target).startsWith(norm(HOME)),
        `${plat}/${action} wrote outside home: ${target}`);
    }
  }
});

// ---- PATH baked into the login entry ---------------------------------------
//
// launchd and systemd --user start the daemon with a bare system PATH, so a
// daemon registered at login could not find `claude`, `git`, or `node` (the
// guard hook's JSON parser) when they live in Homebrew, ~/.local/bin or nvm.
// The registering shell's PATH is captured into the entry so the daemon sees
// what the user sees.

const USER_PATH = '/opt/homebrew/bin:/home/someone/.local/bin:/usr/bin:/bin';

test('macos boot on bakes the registering PATH into the plist', () => {
  const p = buildBootPlan('darwin', 'on', NODE, SCRIPT, HOME, USER_PATH);
  assert.match(p.content, /<key>EnvironmentVariables<\/key>\s*<dict>\s*<key>PATH<\/key>\s*<string>\/opt\/homebrew\/bin:[^<]*<\/string>\s*<\/dict>/);
});

test('linux boot on bakes the registering PATH into the unit', () => {
  const p = buildBootPlan('linux', 'on', NODE, SCRIPT, HOME, USER_PATH);
  assert.match(p.content, /^Environment=PATH=\/opt\/homebrew\/bin:/m);
});

test('an absent PATH leaves the entries without an environment block', () => {
  assert.doesNotMatch(buildBootPlan('darwin', 'on', NODE, SCRIPT, HOME).content, /EnvironmentVariables/);
  assert.doesNotMatch(buildBootPlan('linux', 'on', NODE, SCRIPT, HOME).content, /^Environment=/m);
});

test('plist values are XML-escaped', () => {
  const p = buildBootPlan('darwin', 'on', '/opt/a&b/node', SCRIPT, HOME, '/x<y:/bin');
  assert.match(p.content, /<string>\/opt\/a&amp;b\/node<\/string>/);
  assert.match(p.content, /<string>\/x&lt;y:\/bin<\/string>/);
  assert.doesNotMatch(p.content, /a&b|x<y/);
});

// ---- the claude CLI invocation ----------------------------------------------

const util = require('../src/util');

test('claudeCommand goes through cmd /c on windows and is bare elsewhere', () => {
  assert.deepEqual(util.claudeCommand('win32'), ['cmd', '/c', 'claude']);
  assert.deepEqual(util.claudeCommand('darwin'), ['claude']);
  assert.deepEqual(util.claudeCommand('linux'), ['claude']);
});
