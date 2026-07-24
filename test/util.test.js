'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const util = require('../src/util');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-util-test-'));
}

test('nowIso matches ISO 8601 with local offset', () => {
  const iso = util.nowIso();
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test('ensureDir creates nested directories', () => {
  const base = tempDir();
  const nested = path.join(base, 'a', 'b', 'c');
  assert.equal(fs.existsSync(nested), false);
  util.ensureDir(nested);
  assert.equal(fs.existsSync(nested), true);
  // calling again on existing dir should not throw
  assert.doesNotThrow(() => util.ensureDir(nested));
});

test('atomicWrite survives partial write (write, read back)', () => {
  const base = tempDir();
  const file = path.join(base, 'sub', 'data.txt');
  util.atomicWrite(file, 'hello world');
  const readBack = fs.readFileSync(file, 'utf8');
  assert.equal(readBack, 'hello world');
  // no leftover tmp files
  const entries = fs.readdirSync(path.join(base, 'sub'));
  assert.deepEqual(entries, ['data.txt']);
});

test('atomicWrite overwrites existing file atomically', () => {
  const base = tempDir();
  const file = path.join(base, 'data.txt');
  util.atomicWrite(file, 'first');
  util.atomicWrite(file, 'second');
  assert.equal(fs.readFileSync(file, 'utf8'), 'second');
});

test('readJson returns fallback for missing file', () => {
  const base = tempDir();
  const file = path.join(base, 'missing.json');
  const fallback = { foo: 'bar' };
  const result = util.readJson(file, fallback);
  assert.deepEqual(result, fallback);
});

test('readJson returns fallback for corrupt json', () => {
  const base = tempDir();
  const file = path.join(base, 'corrupt.json');
  fs.writeFileSync(file, '{ not valid json');
  const result = util.readJson(file, 'FALLBACK');
  assert.equal(result, 'FALLBACK');
});

test('writeJson + readJson round trip, 2-space indent', () => {
  const base = tempDir();
  const file = path.join(base, 'out.json');
  util.writeJson(file, { a: 1, b: [1, 2, 3] });
  const raw = fs.readFileSync(file, 'utf8');
  assert.match(raw, /\n {2}"a": 1/);
  const parsed = util.readJson(file, null);
  assert.deepEqual(parsed, { a: 1, b: [1, 2, 3] });
});

test('projectMeta returns <dir>/.autopilot', () => {
  const result = util.projectMeta('C:/Users/alice/Blender/SpaceStations');
  assert.equal(result, path.join('C:/Users/alice/Blender/SpaceStations', '.autopilot'));
});

test('log writes a stamped line to stderr without throwing', () => {
  const chunks = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => { chunks.push(chunk); return true; };
  try {
    util.log('hello', { a: 1 });
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(chunks.length, 1);
  assert.match(chunks[0], /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] hello/);
});

test('AUTOPILOT_HOME respects AUTOPILOT_HOME_OVERRIDE and is resolved lazily', () => {
  const original = process.env.AUTOPILOT_HOME_OVERRIDE;
  try {
    const fake1 = tempDir();
    process.env.AUTOPILOT_HOME_OVERRIDE = fake1;
    assert.equal(util.AUTOPILOT_HOME, fake1);

    const fake2 = tempDir();
    process.env.AUTOPILOT_HOME_OVERRIDE = fake2;
    // re-reading the property must reflect the new override (lazy, not cached)
    assert.equal(util.AUTOPILOT_HOME, fake2);
  } finally {
    if (original === undefined) delete process.env.AUTOPILOT_HOME_OVERRIDE;
    else process.env.AUTOPILOT_HOME_OVERRIDE = original;
  }
});

test('AUTOPILOT_HOME falls back to ~/.autopilot when override is unset', () => {
  const original = process.env.AUTOPILOT_HOME_OVERRIDE;
  try {
    delete process.env.AUTOPILOT_HOME_OVERRIDE;
    assert.equal(util.AUTOPILOT_HOME, path.join(os.homedir(), '.autopilot'));
  } finally {
    if (original === undefined) delete process.env.AUTOPILOT_HOME_OVERRIDE;
    else process.env.AUTOPILOT_HOME_OVERRIDE = original;
  }
});
