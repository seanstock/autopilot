'use strict';

// image.js: request construction for both providers and the generate()
// flow, with fetch injected. No network.

const test = require('node:test');
const assert = require('node:assert/strict');

const image = require('../image');
const { MODEL_CATALOG } = require('../src/engines');

const KEYS = { openai: 'sk-o', stability: 'sk-s' };

test('providerFor maps model ids to providers', () => {
  for (const m of MODEL_CATALOG.images.openai) assert.equal(image.providerFor(m), 'openai', m);
  for (const m of MODEL_CATALOG.images.stability) assert.equal(image.providerFor(m), 'stability', m);
  assert.equal(image.providerFor('claude-sonnet-5'), null);
});

test('OpenAI request: JSON body, bearer auth, aspect mapped to a size, b64 parsed', () => {
  const r = image.buildRequest({ model: 'gpt-image-2.5-flare', prompt: 'a red pond', aspect: '16:9', keys: KEYS });
  assert.equal(r.url, 'https://api.openai.com/v1/images/generations');
  assert.equal(r.headers.Authorization, 'Bearer sk-o');
  const body = JSON.parse(r.body);
  assert.equal(body.model, 'gpt-image-2.5-flare');
  assert.equal(body.prompt, 'a red pond');
  assert.equal(body.size, '1536x1024');
  const png = r.parse({ data: [{ b64_json: Buffer.from('PNGDATA').toString('base64') }] });
  assert.equal(png.toString(), 'PNGDATA');
  assert.throws(() => r.parse({ data: [] }), /no image data/);
});

test('Stability request: multipart form, model field only on the sd3 endpoint, JSON image parsed', () => {
  const ultra = image.buildRequest({ model: 'stable-image-ultra', prompt: 'p', keys: KEYS });
  assert.equal(ultra.url, 'https://api.stability.ai/v2beta/stable-image/generate/ultra');
  assert.equal(ultra.headers.Accept, 'application/json');
  assert.match(ultra.headers['Content-Type'], /^multipart\/form-data; boundary=/);
  const ultraBody = ultra.body.toString();
  assert.match(ultraBody, /name="prompt"\r\n\r\np\r\n/);
  assert.match(ultraBody, /name="aspect_ratio"\r\n\r\n1:1/);
  assert.doesNotMatch(ultraBody, /name="model"/, 'ultra/core take no model field');

  const sd3 = image.buildRequest({ model: 'sd3.5-large-turbo', prompt: 'p', aspect: '9:16', negative: 'blurry', keys: KEYS });
  assert.equal(sd3.url, 'https://api.stability.ai/v2beta/stable-image/generate/sd3');
  const sd3Body = sd3.body.toString();
  assert.match(sd3Body, /name="model"\r\n\r\nsd3\.5-large-turbo/);
  assert.match(sd3Body, /name="negative_prompt"\r\n\r\nblurry/);
  assert.match(sd3Body, /name="aspect_ratio"\r\n\r\n9:16/);
  assert.equal(sd3.parse({ image: Buffer.from('X').toString('base64') }).toString(), 'X');
  assert.throws(() => sd3.parse({ finish_reason: 'CONTENT_FILTERED' }), /CONTENT_FILTERED/);
});

test('buildRequest refuses without the provider key or with an unknown model', () => {
  assert.throws(() => image.buildRequest({ model: 'gpt-image-2.5-flare', prompt: 'p', keys: { openai: null, stability: 'x' } }), /no openai API key/);
  assert.throws(() => image.buildRequest({ model: 'dall-e-2000', prompt: 'p', keys: KEYS }), /unknown image model/);
});

test('generate() posts the built request and surfaces provider errors with status', async () => {
  const calls = [];
  const fetchOk = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify({ image: Buffer.from('IMG').toString('base64') }) };
  };
  const out = await image.generate({ model: 'stable-image-core', prompt: 'p', keys: KEYS }, fetchOk);
  assert.equal(out.toString(), 'IMG');
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].url, /\/core$/);

  const fetchErr = async () => ({ ok: false, status: 402, text: async () => JSON.stringify({ error: { message: 'insufficient credits' } }) });
  await assert.rejects(image.generate({ model: 'gpt-image-2.5-sunburst', prompt: 'p', keys: KEYS }, fetchErr), /openai 402: insufficient credits/);
});
