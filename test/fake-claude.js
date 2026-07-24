#!/usr/bin/env node
'use strict';

// Fake `claude` CLI used only by test/runner.test.js. Mimics the parts of
// the real `claude -p --output-format stream-json` contract the runner
// depends on: it reads the full prompt from stdin first (proving the
// runner writes the preamble to stdin rather than argv), then emits
// scripted NDJSON lines to stdout based on env FAKE_MODE.
//
// It also drops two extra artifacts into cwd so tests can assert on
// what the runner actually did without re-parsing stdout:
//   - received_prompt.txt: the raw stdin it was given (verbatim).
//   - env_seen.json: a couple of env vars the runner is supposed to strip.
//
// FAKE_MODE values (default 'clean'):
//   clean        - writes out.txt in cwd, emits an assistant line + a
//                   successful result (usage 1000 in / 200 out), exits 0.
//   usage_limit  - emits "You've hit your limit" text, exits 1.
//   context_full - emits "prompt is too long" text, exits 1.
//   credit       - emits "Credit balance is too low" text, exits 1.
//   hang         - never exits on its own (sleeps ~10 minutes); used for
//                   timeout / STOP-file kill tests.

const fs = require('fs');
const path = require('path');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
  });
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function main() {
  const prompt = await readStdin();

  try {
    fs.writeFileSync(path.join(process.cwd(), 'received_prompt.txt'), prompt);
    fs.writeFileSync(
      path.join(process.cwd(), 'env_seen.json'),
      JSON.stringify({
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || null,
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN || null,
      })
    );
  } catch (err) {
    // Best effort only; do not let artifact-writing failures affect the
    // scripted behavior under test.
  }

  const mode = process.env.FAKE_MODE || 'clean';

  if (mode === 'clean') {
    try {
      fs.writeFileSync(path.join(process.cwd(), 'out.txt'), 'fake claude wrote this\n');
    } catch (err) {
      // best effort
    }
    emit({ type: 'assistant', message: { content: [{ type: 'text', text: 'Doing the work.' }] } });
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 1000, output_tokens: 200 },
      total_cost_usd: 0.05,
    });
    process.exit(0);
    return;
  }

  if (mode === 'usage_limit') {
    const text = "You've hit your limit for this period.";
    emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    process.stderr.write(`${text}\n`);
    process.exit(1);
    return;
  }

  if (mode === 'context_full') {
    const text = 'Error: prompt is too long for the context window.';
    emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    process.stderr.write(`${text}\n`);
    process.exit(1);
    return;
  }

  if (mode === 'credit') {
    const text = 'Credit balance is too low to continue.';
    emit({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    process.stderr.write(`${text}\n`);
    process.exit(1);
    return;
  }

  if (mode === 'hang') {
    // Deliberately never resolves on its own; the runner's timeout / STOP
    // kill path is what is expected to end this process.
    setTimeout(() => {}, 10 * 60 * 1000);
    return;
  }

  // Unknown FAKE_MODE: exit cleanly but emit nothing classifiable, to
  // exercise the 'unknown' fallback path.
  process.exit(0);
}

main();
