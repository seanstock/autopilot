#!/usr/bin/env node
'use strict';

// Fake `codex` CLI used by test/runner.test.js and test/engines.test.js.
// Mimics the parts of `codex exec --json` the runner depends on: the prompt
// arrives on stdin (the trailing `-` argument), and stdout is a JSON Lines
// stream of thread/turn/item events. Like fake-claude.js it drops
// received_prompt.txt and env_seen.json into cwd so tests can assert on
// what the runner actually passed.
//
// FAKE_MODE values (default 'clean'):
//   clean        - writes out.txt in cwd, emits an agent_message item and a
//                   turn.completed with usage, exits 0.
//   usage_limit  - emits "You've hit your usage limit" on stderr, exits 1.
//   failed       - emits turn.failed, exits 1.

const fs = require('fs');
const path = require('path');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main() {
  const prompt = await readStdin();
  // -C <dir> is how codex is told where to work; honour it like the real
  // CLI would so artifacts land in the project, not the daemon's cwd.
  const argv = process.argv.slice(2);
  const cIdx = argv.indexOf('-C');
  const cwd = cIdx !== -1 && argv[cIdx + 1] ? argv[cIdx + 1] : process.cwd();

  try {
    fs.writeFileSync(path.join(cwd, 'received_prompt.txt'), prompt);
    fs.writeFileSync(path.join(cwd, 'env_seen.json'), JSON.stringify({
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || null,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || null,
      CODEX_API_KEY: process.env.CODEX_API_KEY || null,
      ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL || null,
      argv,
    }));
  } catch (err) {
    // best effort
  }

  const mode = process.env.FAKE_MODE || 'clean';
  emit({ type: 'thread.started', thread_id: 'fake-thread' });
  emit({ type: 'turn.started' });

  if (mode === 'usage_limit') {
    process.stderr.write("You've hit your usage limit. Try again later.\n");
    process.exitCode = 1;
    return;
  }
  if (mode === 'failed') {
    emit({ type: 'turn.failed', error: { message: 'boom' } });
    process.exitCode = 1;
    return;
  }

  fs.writeFileSync(path.join(cwd, 'out.txt'), 'codex was here\n');
  emit({ type: 'item.started', item: { id: 'item_1', type: 'command_execution', command: 'bash -lc ls', status: 'in_progress' } });
  emit({ type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'fake codex did the work' } });
  emit({ type: 'turn.completed', usage: { input_tokens: 2400, cached_input_tokens: 2000, output_tokens: 150, reasoning_output_tokens: 40 } });
  process.exitCode = 0;
}

main();
