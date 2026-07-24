'use strict';

// Containment generator: per-project cycle_settings.json + guard.ps1/guard.sh
// PreToolUse hook + git init/gitignore seed (SPEC.md section 5).
// Zero npm dependencies, Node built-ins only, CommonJS.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const util = require('./util');

// The directory this file lives in is <install>/src, so one level up is the
// Autopilot install/repo root - the harness's own code, distinct from both
// the user's real ~/.claude and the per-project .autopilot/ internals.
const INSTALL_DIR = path.resolve(__dirname, '..');

const GITIGNORE_LINES = ['*.blend1', 'renders/', 'output/', '*.tmp', 'node_modules/'];

function forwardSlash(p) {
  return p.split(path.sep).join('/');
}

// I4 fix: Claude Code's permission engine normalizes Windows paths to POSIX
// before matching a deny rule's glob (code.claude.com/docs/en/permissions.md)
// - an absolute path must be written with a double-slash filesystem-root
// anchor and a lowercase drive letter, e.g. "C:\Users\x" -> "//c/Users/x".
// Plain "C:/Users/x" (what path.join + forwardSlash alone produce) does not
// match anything - this was the actual I4 root cause: the whole
// permissions.deny layer was silently inert on Windows, the primary
// platform. POSIX absolute paths need the same treatment (NEW-1): a single
// leading slash means "relative to the settings file's directory" under
// this rule grammar, so "/home/x/proj/**" must also be written with the
// double-slash filesystem-root anchor, "//home/x/proj/**".
function toDenyPath(p) {
  const slash = forwardSlash(p);
  const m = /^([A-Za-z]):\/(.*)$/.exec(slash);
  if (m) {
    return `//${m[1].toLowerCase()}/${m[2]}`;
  }
  if (slash.startsWith('/') && !slash.startsWith('//')) {
    return '/' + slash;
  }
  return slash;
}

// --- guard.ps1 -------------------------------------------------------------

function buildGuardPs1({ projectDir, includeBlocklist, autopilotHome }) {
  const stopFile = forwardSlash(path.join(projectDir, '.autopilot', 'STOP'));
  const dirEscaped = forwardSlash(projectDir).replace(/'/g, "''");
  const homeEscaped = forwardSlash(autopilotHome || '').replace(/'/g, "''");

  const lines = [];
  lines.push('# Autopilot PreToolUse guard (generated, do not edit by hand).');
  lines.push('# Pure ASCII, PowerShell 5.1 compatible. Runs on every Bash tool call.');
  lines.push('');
  lines.push('$stopFile = ' + "'" + stopFile + "'");
  lines.push('if (Test-Path -LiteralPath $stopFile) {');
  lines.push('  [Console]::Error.WriteLine("BLOCKED: stop file present, all tool calls are blocked")');
  lines.push('  exit 2');
  lines.push('}');
  lines.push('');

  if (!includeBlocklist) {
    lines.push('# Containment is off for this project: only the STOP check above is');
    lines.push('# enforced (STOP enforcement is never optional). No content blocklist.');
    lines.push('exit 0');
    lines.push('');
    return lines.join('\r\n');
  }

  lines.push('$raw = [Console]::In.ReadToEnd()');
  lines.push('if (-not $raw) { exit 0 }');
  lines.push('');
  lines.push('$hookData = $null');
  lines.push('try {');
  lines.push('  $hookData = $raw | ConvertFrom-Json -ErrorAction Stop');
  lines.push('} catch {');
  lines.push('  exit 0');
  lines.push('}');
  lines.push('');
  lines.push('$command = $null');
  lines.push('try {');
  lines.push('  if ($hookData.tool_input.command) { $command = [string]$hookData.tool_input.command }');
  lines.push('} catch {');
  lines.push('  $command = $null');
  lines.push('}');
  lines.push('if (-not $command) { exit 0 }');
  lines.push('');
  lines.push('$patterns = @(');
  lines.push('  "ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|x-api-key",');
  lines.push('  "api\\.anthropic\\.com|console\\.anthropic\\.com",');
  lines.push('  "\\.credentials\\.json",');
  lines.push('  "\\.claude[/\\\\]",');
  lines.push('  "schtasks|systemctl|launchctl|reg\\s+add",');
  lines.push('  "guard\\.(ps1|sh)|cycle_settings\\.json|autopilot\\.js",');
  lines.push('  "claude\\s+(-p|--print)",');
  lines.push('  "\\.autopilot[/\\\\]+projects\\.json"');
  lines.push(')');
  lines.push('');
  lines.push('foreach ($p in $patterns) {');
  lines.push('  if ($command -match $p) {');
  lines.push('    [Console]::Error.WriteLine("BLOCKED: command matches blocked pattern: " + $p)');
  lines.push('    exit 2');
  lines.push('  }');
  lines.push('}');
  lines.push('');
  // M1 fix: $command commonly contains backslash-separated Windows paths
  // (e.g. "Remove-Item -Recurse C:\proj\junk"), but $projectDir is baked in
  // forward-slash form, so the -like check below always missed a legitimate
  // in-project recursive delete and blocked it (fails safe, but spuriously).
  // Normalize both sides to forward slashes before comparing. The same
  // normalized copy also backs the I5(b) Autopilot-home check right below.
  lines.push('$commandNorm = $command -replace \'\\\\\', \'/\'');
  lines.push('$projectDir = ' + "'" + dirEscaped + "'");
  lines.push('$isRecursiveDelete = ($command -match "rm\\s+-rf") -or (($command -match "Remove-Item") -and ($command -match "-Recurse"))');
  lines.push('if ($isRecursiveDelete -and (-not ($commandNorm -like ("*" + $projectDir + "*")))) {');
  lines.push('  [Console]::Error.WriteLine("BLOCKED: recursive delete outside the project directory")');
  lines.push('  exit 2');
  lines.push('}');
  lines.push('');
  // I5(b): the permissions.deny layer only constrains the Write/Edit
  // *tools*; a Bash command can still write ~/.autopilot/projects.json
  // directly (e.g. flip containment to "off" or set claudeCmd for a future
  // cycle - SPEC.md section 5's "a cycle must not be able to grant future
  // cycles extra permissions or hooks"). Block any Bash command that even
  // mentions the Autopilot home directory - blunt, consistent with the
  // existing ".claude" blanket pattern above (tripwire, not a boundary).
  if (homeEscaped) {
    lines.push('$autopilotHome = ' + "'" + homeEscaped + "'");
    lines.push('if ($commandNorm -like ("*" + $autopilotHome + "*")) {');
    lines.push('  [Console]::Error.WriteLine("BLOCKED: command touches the Autopilot home directory")');
    lines.push('  exit 2');
    lines.push('}');
  }
  lines.push('');
  lines.push('exit 0');
  lines.push('');
  return lines.join('\r\n');
}

// --- guard.sh ----------------------------------------------------------------

// I3 fix: the previous extraction (`grep -o '"command"...:..."[^"]*"'`)
// stops at the first `"` inside the JSON string, i.e. at the first escaped
// quote of the command itself - any command containing a double quote
// (the common case, not an evasion) truncated silently and slipped past
// every blocklist check. Node is guaranteed present wherever the daemon
// runs (it IS the daemon's runtime), so parse the hook JSON properly with
// it instead of a hand-rolled regex. No single quotes appear in this
// script - it is safe to wrap whole in the shell's single-quoted `node -e`
// argument below.
const NODE_COMMAND_EXTRACTOR =
  'let d="";process.stdin.on("data",function(c){d+=c;});' +
  'process.stdin.on("end",function(){' +
  'try{var j=JSON.parse(d);var c=j&&j.tool_input&&j.tool_input.command;' +
  'if(typeof c==="string"){process.stdout.write(c);}}catch(e){}});';

function buildGuardSh({ projectDir, includeBlocklist, autopilotHome }) {
  const stopFile = path.join(projectDir, '.autopilot', 'STOP');
  const dirForMatch = forwardSlash(projectDir);
  const homeForMatch = autopilotHome ? forwardSlash(autopilotHome) : '';

  const lines = [];
  lines.push('#!/bin/bash');
  lines.push('# Autopilot PreToolUse guard (generated, do not edit by hand).');
  lines.push('');
  lines.push('stop_file="' + stopFile.replace(/\\/g, '/') + '"');
  lines.push('if [ -e "$stop_file" ]; then');
  lines.push('  echo "BLOCKED: stop file present, all tool calls are blocked" >&2');
  lines.push('  exit 2');
  lines.push('fi');
  lines.push('');

  if (!includeBlocklist) {
    lines.push('# Containment is off for this project: only the STOP check above is');
    lines.push('# enforced (STOP enforcement is never optional). No content blocklist.');
    lines.push('exit 0');
    lines.push('');
    return lines.join('\n');
  }

  lines.push('input="$(cat)"');
  lines.push('');
  // Primary extraction: a real JSON parse via node (see NODE_COMMAND_EXTRACTOR
  // above) - no quote-truncation, no regex guessing. node_status reflects
  // node's own exit code (0 = ran fine, including "no command field found",
  // which is a normal empty result handled by the blank check below; nonzero
  // = node missing/crashed, the ONLY case that falls back to the naive
  // regex extraction, kept solely as a last resort per the fail-open
  // contract on truly unparseable/no-node environments).
  lines.push('command=$(printf \'%s\' "$input" | node -e \'' + NODE_COMMAND_EXTRACTOR + '\' 2>/dev/null)');
  lines.push('node_status=$?');
  lines.push('if [ "$node_status" != "0" ]; then');
  lines.push(
    '  command=$(printf \'%s\' "$input" | grep -o \'"command"[[:space:]]*:[[:space:]]*"[^"]*"\' | sed -E \'s/.*"command"[[:space:]]*:[[:space:]]*"(.*)"/\\1/\')'
  );
  lines.push('fi');
  lines.push('');
  lines.push('if [ -z "$command" ]; then');
  lines.push('  exit 0');
  lines.push('fi');
  lines.push('');
  lines.push('block() {');
  lines.push('  echo "BLOCKED: command matches blocked pattern: $1" >&2');
  lines.push('  exit 2');
  lines.push('}');
  lines.push('');
  lines.push('check() {');
  lines.push('  if printf \'%s\' "$command" | grep -Eiq "$1"; then');
  lines.push('    block "$1"');
  lines.push('  fi');
  lines.push('}');
  lines.push('');
  lines.push('check \'ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|x-api-key\'');
  lines.push('check \'api\\.anthropic\\.com|console\\.anthropic\\.com\'');
  lines.push('check \'\\.credentials\\.json\'');
  lines.push('check \'\\.claude[/\\\\]\'');
  lines.push('check \'schtasks|systemctl|launchctl|reg[[:space:]]+add\'');
  lines.push('check \'guard\\.(ps1|sh)|cycle_settings\\.json|autopilot\\.js\'');
  lines.push('check \'claude[[:space:]]+(-p|--print)\'');
  lines.push('check \'\\.autopilot[/\\\\]+projects\\.json\'');
  lines.push('');
  lines.push(
    'if printf \'%s\' "$command" | grep -Eiq \'rm[[:space:]]+-rf|Remove-Item.*-Recurse\'; then'
  );
  lines.push('  if ! printf \'%s\' "$command" | grep -Fq "' + dirForMatch + '"; then');
  lines.push('    echo "BLOCKED: recursive delete outside the project directory" >&2');
  lines.push('    exit 2');
  lines.push('  fi');
  lines.push('fi');
  lines.push('');
  // I5(b): permissions.deny only constrains the Write/Edit *tools* - a Bash
  // command can still write ~/.autopilot/projects.json directly (flip
  // containment to "off", set claudeCmd for a future cycle - SPEC.md
  // section 5). Block any Bash command that even mentions the Autopilot
  // home directory, blunt and consistent with the .claude blanket check
  // above (tripwire, not a boundary).
  if (homeForMatch) {
    lines.push('if printf \'%s\' "$command" | grep -Fq "' + homeForMatch + '"; then');
    lines.push('  echo "BLOCKED: command touches the Autopilot home directory" >&2');
    lines.push('  exit 2');
    lines.push('fi');
    lines.push('');
  }
  lines.push('exit 0');
  lines.push('');
  return lines.join('\n');
}

// --- cycle_settings.json ------------------------------------------------------

function buildSettings({ projectDir, guardPs1Path, guardShPath, standard, mcpNames, allowTask }) {
  const guardCommand =
    process.platform === 'win32'
      ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${guardPs1Path}"`
      : `bash "${guardShPath}"`;

  // Headless `claude -p` auto-denies any tool the settings do not allow, so
  // without an explicit allow list a cycle gets file tools only (acceptEdits
  // default) - no shell, no web, no MCP. SPEC section 5: allow file tools,
  // shell, web search/fetch, and the MCP servers the project declares
  // (project.mcp, e.g. ["blender"] -> "mcp__blender"). The allow list is not
  // containment - it is what makes a cycle able to work at all - so it is
  // present for containment "off" too.
  const mcpAllows = (mcpNames || []).map((n) => 'mcp__' + String(n));
  const baseAllow = [
    'Read',
    'Glob',
    'Grep',
    'Edit',
    'Write',
    'TodoWrite',
    'ToolSearch',
    'WebSearch',
    'WebFetch',
    'Bash',
    'PowerShell',
  ].concat(mcpAllows);
  // v0.3: the orchestrate settings variant additionally allows the Task
  // tool (read-only scout subagent fan-out from orchestrate/critic
  // cycles - docs/plans/2026-07-24-goal-loop.md). The base variant used by
  // work/wrapup cycles never gets Task: mutating work stays serial, one
  // order per worker cycle, per the design note's recommendation.
  const settings = {
    permissions: {
      defaultMode: 'acceptEdits',
      allow: allowTask ? baseAllow.concat(['Task']) : baseAllow,
    },
    hooks: {
      PreToolUse: [
        {
          // Windows cycles can surface shell access as a PowerShell tool as
          // well as Bash (the v0 SpaceStations harness guarded both); the
          // guard must fire on either or it is bypassable by tool choice.
          matcher: 'Bash|PowerShell',
          hooks: [{ type: 'command', command: guardCommand }],
        },
      ],
    },
  };

  if (standard) {
    // I4 fix: these must be Claude Code's actual deny-rule path syntax, not
    // a plain OS path - see toDenyPath() above. Home-relative rules use the
    // literal `~/` form (it expands under the permission engine on every
    // platform, and is portable regardless of AUTOPILOT_HOME_OVERRIDE,
    // which is a test-only concept with no equivalent `~` expansion).
    // Project-relative and install-dir rules are real absolute filesystem
    // paths, so they go through toDenyPath()'s //<drive>/ conversion.
    //
    // I5(a): AUTOPILOT_HOME (~/.autopilot) was not denied at all before -
    // a cycle could rewrite projects.json (containment: "off", claudeCmd
    // for a future cycle - SPEC.md section 5). Added here as a second
    // layer; the guard-script content check (I5(b)) is the layer that
    // actually matters for Bash (this permissions.deny layer only
    // constrains the Write/Edit *tools*).
    //
    // A Read deny also blocks the Edit tool but not Write (and vice versa
    // is not implied either) - every path that must not be modified needs
    // both Write(...) and Edit(...) explicitly.
    const projectAutopilot = toDenyPath(path.join(projectDir, '.autopilot', '**'));
    const projectClaude = toDenyPath(path.join(projectDir, '.claude', '**'));
    const installDirGlob = toDenyPath(path.join(INSTALL_DIR, '**'));

    settings.permissions.deny = [
        'Read(~/.claude/**)',
        'Write(~/.claude/**)',
        'Edit(~/.claude/**)',
        'Read(//**/.credentials.json)',
        'Write(~/.autopilot/**)',
        'Edit(~/.autopilot/**)',
        `Write(${projectAutopilot})`,
        `Edit(${projectAutopilot})`,
        `Write(${projectClaude})`,
        `Edit(${projectClaude})`,
        `Write(${installDirGlob})`,
        `Edit(${installDirGlob})`,
      ];
  }

  return settings;
}

// --- git init / .gitignore ----------------------------------------------------

function ensureGit(dir) {
  const gitDir = path.join(dir, '.git');
  if (!fs.existsSync(gitDir)) {
    try {
      execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
    } catch (err) {
      util.log('containment: git init failed for', dir, String(err && err.message));
    }
  }

  const gitignorePath = path.join(dir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    util.atomicWrite(gitignorePath, GITIGNORE_LINES.join('\n') + '\n');
  }
}

// --- .claude/agents/scout.md (v0.3) --------------------------------------
//
// A daemon-generated, read-only research/verification subagent definition,
// written only when the project has orchestration enabled
// (project.workerModel set). Frontmatter + body per the exact contract in
// docs/plans/2026-07-24-goal-loop.md Task P. Lives under the project's
// .claude/ directory, which cycles cannot write (existing deny rules
// above) - so a cycle can dispatch the scout via Task but never edit its
// definition.

const SCOUT_DESCRIPTION =
  'Read-only research and verification subagent. Use for parallel exploration, auditing, and fact-checking. Never edits files.';

function buildScoutAgentMd() {
  const lines = [];
  lines.push('---');
  lines.push('name: scout');
  lines.push(`description: ${SCOUT_DESCRIPTION}`);
  lines.push('tools: Read, Glob, Grep, WebSearch, WebFetch');
  lines.push('model: sonnet');
  lines.push('---');
  lines.push('');
  lines.push('You are the scout subagent: read-only research, auditing, and');
  lines.push('fact-checking support for the Autopilot orchestrator cycle that');
  lines.push('dispatched you. You have no Edit, Write, or Bash access - you cannot');
  lines.push('change anything, only look.');
  lines.push('');
  lines.push('Follow the brief you were given exactly: its stated objective, output');
  lines.push('format, and boundaries (which files/areas to look at, and no others).');
  lines.push('Do not wander outside the boundaries you were given.');
  lines.push('');
  lines.push('Return dense, cite-backed findings, not a narrative: reference exact');
  lines.push('file paths and line numbers for every claim, quote the smallest');
  lines.push('relevant snippet rather than pasting whole files, and say plainly when');
  lines.push('you did not find something rather than guessing.');
  lines.push('');
  return lines.join('\n');
}

// --- public API ----------------------------------------------------------------

function ensureContainment(project) {
  const dir = project.dir;
  const meta = util.projectMeta(dir);
  util.ensureDir(meta);

  const isOff = project.containment === 'off';
  const standard = !isOff;

  const guardPs1Path = path.join(meta, 'guard.ps1');
  const guardShPath = path.join(meta, 'guard.sh');
  const autopilotHome = util.AUTOPILOT_HOME;

  util.atomicWrite(guardPs1Path, buildGuardPs1({ projectDir: dir, includeBlocklist: standard, autopilotHome }));
  util.atomicWrite(guardShPath, buildGuardSh({ projectDir: dir, includeBlocklist: standard, autopilotHome }));

  const settings = buildSettings({
    projectDir: dir,
    guardPs1Path,
    guardShPath,
    standard,
    mcpNames: project.mcp,
    allowTask: false,
  });
  const orchestrateSettings = buildSettings({
    projectDir: dir,
    guardPs1Path,
    guardShPath,
    standard,
    mcpNames: project.mcp,
    allowTask: true,
  });
  const settingsPath = path.join(meta, 'cycle_settings.json');
  const orchestrateSettingsPath = path.join(meta, 'cycle_settings_orchestrate.json');
  util.writeJson(settingsPath, settings);
  util.writeJson(orchestrateSettingsPath, orchestrateSettings);

  ensureGit(dir);

  if (project.workerModel) {
    const agentsDir = path.join(dir, '.claude', 'agents');
    util.atomicWrite(path.join(agentsDir, 'scout.md'), buildScoutAgentMd());
  }

  if (isOff) {
    return { settingsPath, orchestrateSettingsPath, warning: 'containment off' };
  }
  return { settingsPath, orchestrateSettingsPath };
}

module.exports = {
  ensureContainment,
  INSTALL_DIR,
  toDenyPath,
};
