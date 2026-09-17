#!/usr/bin/env node
'use strict';

// Image generation helper for cycles (2026-09-16). Zero npm dependencies.
//
//   node <autopilot>/image.js "<prompt>" --out picture.png
//        [--model gpt-image-2.5-flare | sd3.5-large | stable-image-ultra | ...]
//        [--aspect 16:9] [--negative "..."]
//
// Uses the provider keys stored by the Settings page (~/.autopilot/keys.json)
// or, when absent, OPENAI_API_KEY / STABILITY_API_KEY from the environment
// (the runner injects the stored keys into every cycle's env, so inside a
// cycle both paths agree). Picks the provider from the model id:
//   gpt-image-*                      -> OpenAI Images API
//   stable-image-ultra|core, sd3.*   -> Stability AI Stable Image v2beta
// Prints the written path on stdout; exits nonzero with a one-line reason
// on stderr. Lives at the repo root, not autopilot.js, because the guard
// hook blocks Bash commands that mention autopilot.js (a cycle must not be
// able to drive the daemon) and this helper is meant to be called from one.

const fs = require('fs');
const path = require('path');

const util = require('./src/util');
const keysModule = require('./src/keys');
const { MODEL_CATALOG } = require('./src/engines');

const STABILITY_BASE = 'https://api.stability.ai/v2beta/stable-image/generate';
const OPENAI_IMAGES = 'https://api.openai.com/v1/images/generations';

// aspect -> OpenAI size (OpenAI takes pixel sizes, Stability takes ratios).
const OPENAI_SIZES = { '1:1': '1024x1024', '3:2': '1536x1024', '2:3': '1024x1536', '16:9': '1536x1024', '9:16': '1024x1536' };

function providerFor(model) {
  if (!model) return null;
  if (/^gpt-image/i.test(model)) return 'openai';
  if (/^(stable-image-|sd3)/i.test(model)) return 'stability';
  return null;
}

function stabilityEndpoint(model) {
  if (model === 'stable-image-ultra') return { url: `${STABILITY_BASE}/ultra`, modelField: null };
  if (model === 'stable-image-core') return { url: `${STABILITY_BASE}/core`, modelField: null };
  return { url: `${STABILITY_BASE}/sd3`, modelField: model }; // sd3.5-large, sd3.5-large-turbo, sd3.5-medium
}

// Minimal multipart/form-data encoder (text fields only).
function multipart(fields) {
  const boundary = `----autopilot${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

// Pure: build the HTTP request for a generation. Returns {url, headers,
// body, parse(json) -> Buffer}. Exported so tests cover both providers
// without network access.
function buildRequest({ model, prompt, aspect, negative, keys }) {
  const provider = providerFor(model);
  if (!provider) throw new Error(`unknown image model: ${model}`);
  const key = keys[provider];
  if (!key) throw new Error(`no ${provider} API key: add it on the Settings page (or set ${provider === 'openai' ? 'OPENAI_API_KEY' : 'STABILITY_API_KEY'})`);

  if (provider === 'openai') {
    const size = OPENAI_SIZES[aspect || '1:1'] || '1024x1024';
    return {
      url: OPENAI_IMAGES,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, n: 1, size, output_format: 'png' }),
      parse: (json) => {
        const b64 = json && json.data && json.data[0] && json.data[0].b64_json;
        if (!b64) throw new Error('OpenAI returned no image data');
        return Buffer.from(b64, 'base64');
      },
    };
  }

  const ep = stabilityEndpoint(model);
  const form = multipart({ prompt, aspect_ratio: aspect || '1:1', output_format: 'png', negative_prompt: negative, model: ep.modelField });
  return {
    url: ep.url,
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'Content-Type': form.contentType },
    body: form.body,
    parse: (json) => {
      const b64 = json && json.image;
      if (!b64) throw new Error(`Stability returned no image (${json && (json.finish_reason || json.name || json.errors)})`);
      return Buffer.from(b64, 'base64');
    },
  };
}

async function generate(opts, fetchImpl) {
  const req = buildRequest(opts);
  const doFetch = fetchImpl || fetch;
  const res = await doFetch(req.url, { method: 'POST', headers: req.headers, body: req.body });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (err) { json = null; }
  if (!res.ok) {
    const msg = (json && (json.error && json.error.message || json.message || (json.errors || []).join('; '))) || text.slice(0, 300);
    throw new Error(`${providerFor(opts.model)} ${res.status}: ${msg}`);
  }
  return req.parse(json);
}

function resolveKeys() {
  const stored = keysModule.load();
  return {
    openai: stored.openai || process.env.OPENAI_API_KEY || null,
    stability: stored.stability || process.env.STABILITY_API_KEY || process.env.STABILITY_KEY || null,
  };
}

// Default model: --model, else settings.imageModel, else the first provider
// with a key (OpenAI's fast model, then Stability Core).
function defaultModel(keys) {
  try {
    const st = require('./src/state').load();
    if (st.settings && st.settings.imageModel) return st.settings.imageModel;
  } catch (err) {
    // no registry yet
  }
  if (keys.openai) return MODEL_CATALOG.images.openai[1] || MODEL_CATALOG.images.openai[0];
  if (keys.stability) return 'stable-image-core';
  return null;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[a.slice(2)] = next; i += 1; } else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const prompt = args._.join(' ').trim();
  if (!prompt || !args.out) {
    console.error('usage: node image.js "<prompt>" --out <file.png> [--model <id>] [--aspect 16:9] [--negative "..."]');
    console.error('models: ' + MODEL_CATALOG.images.openai.concat(MODEL_CATALOG.images.stability).join(', '));
    process.exitCode = 2;
    return;
  }
  const keys = resolveKeys();
  const model = args.model || defaultModel(keys);
  if (!model) {
    console.error('no image model available: add an OpenAI or Stability key on the Settings page');
    process.exitCode = 2;
    return;
  }
  const png = await generate({ model, prompt, aspect: args.aspect, negative: args.negative, keys });
  const outPath = path.resolve(args.out);
  util.ensureDir(path.dirname(outPath));
  fs.writeFileSync(outPath, png);
  console.log(outPath);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`image.js: ${err && err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { providerFor, buildRequest, generate, multipart, parseArgs, OPENAI_SIZES };
