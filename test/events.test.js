'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const events = require('../src/events');

function tempProjectDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-events-test-'));
}

test('appendEvent stamps t and project, creates .autopilot dir', () => {
  const dir = tempProjectDir();
  const rec = events.appendEvent(dir, 'myproj', 'cycle_start', { cycle: 1, kind: 'work' });
  assert.match(rec.t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
  assert.equal(rec.project, 'myproj');
  assert.equal(rec.ev, 'cycle_start');
  assert.equal(rec.cycle, 1);
  assert.equal(rec.kind, 'work');

  const file = path.join(dir, '.autopilot', 'events.jsonl');
  assert.ok(fs.existsSync(file));
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), rec);
});

test('appendEvent appends multiple lines in order', () => {
  const dir = tempProjectDir();
  events.appendEvent(dir, 'p', 'cycle_start', { cycle: 1 });
  events.appendEvent(dir, 'p', 'cycle_end', { cycle: 1, exit: 'clean' });
  const all = events.readEvents(dir, 100);
  assert.equal(all.length, 2);
  assert.equal(all[0].ev, 'cycle_start');
  assert.equal(all[1].ev, 'cycle_end');
});

test('readEvents returns empty array when file absent', () => {
  const dir = tempProjectDir();
  assert.deepEqual(events.readEvents(dir), []);
});

test('readEvents skips a corrupt line', () => {
  const dir = tempProjectDir();
  const metaDir = path.join(dir, '.autopilot');
  fs.mkdirSync(metaDir, { recursive: true });
  const file = path.join(metaDir, 'events.jsonl');
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ t: '2026-07-23T00:00:00-07:00', ev: 'a', project: 'p' }),
      'not valid json {{{',
      JSON.stringify({ t: '2026-07-23T00:00:01-07:00', ev: 'b', project: 'p' }),
      '',
    ].join('\n')
  );
  const result = events.readEvents(dir, 100);
  assert.equal(result.length, 2);
  assert.equal(result[0].ev, 'a');
  assert.equal(result[1].ev, 'b');
});

test('readEvents respects limit, keeping the newest last', () => {
  const dir = tempProjectDir();
  for (let i = 0; i < 5; i += 1) {
    events.appendEvent(dir, 'p', 'tick', { i });
  }
  const result = events.readEvents(dir, 2);
  assert.equal(result.length, 2);
  assert.equal(result[0].i, 3);
  assert.equal(result[1].i, 4);
});

test('activity appends a stamped line to ACTIVITY.log at project root', () => {
  const dir = tempProjectDir();
  events.activity(dir, 'did a thing');
  const file = path.join(dir, 'ACTIVITY.log');
  assert.ok(fs.existsSync(file));
  const content = fs.readFileSync(file, 'utf8');
  assert.match(content, /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}\] \[daemon\] did a thing/);
});

test('activity defaults who to daemon, accepts override', () => {
  const dir = tempProjectDir();
  events.activity(dir, 'model said something', 'model');
  const content = fs.readFileSync(path.join(dir, 'ACTIVITY.log'), 'utf8');
  assert.match(content, /\[model\] model said something/);
});

test('tailActivity returns the last N lines', () => {
  const dir = tempProjectDir();
  for (let i = 0; i < 10; i += 1) {
    events.activity(dir, `line ${i}`);
  }
  const tail = events.tailActivity(dir, 3);
  assert.equal(tail.length, 3);
  assert.match(tail[0], /line 7/);
  assert.match(tail[1], /line 8/);
  assert.match(tail[2], /line 9/);
});

test('tailActivity returns empty array when file absent', () => {
  const dir = tempProjectDir();
  assert.deepEqual(events.tailActivity(dir), []);
});

// ---------------------------------------------------------------------------
// I7: size-capped rotation (SPEC.md section 8) - injectable cap via
// AUTOPILOT_ROTATE_BYTES_OVERRIDE so the test does not need to write 10 MB.
// ---------------------------------------------------------------------------

test.beforeEach(() => {
  delete process.env.AUTOPILOT_ROTATE_BYTES_OVERRIDE;
});
test.afterEach(() => {
  delete process.env.AUTOPILOT_ROTATE_BYTES_OVERRIDE;
});

test('I7: events.jsonl rotates to .1 once it crosses the (injectable) size cap', () => {
  process.env.AUTOPILOT_ROTATE_BYTES_OVERRIDE = '200';
  const dir = tempProjectDir();
  const file = path.join(dir, '.autopilot', 'events.jsonl');
  const archive = `${file}.1`;

  for (let i = 0; i < 20; i += 1) {
    events.appendEvent(dir, 'p', 'tick', { i, pad: 'x'.repeat(20) });
  }

  assert.ok(fs.existsSync(archive), 'expected a .1 archive to exist once the cap was crossed');
  // The live file must still be readable/parseable JSONL after rotation.
  const live = events.readEvents(dir, 1000);
  assert.ok(live.length > 0);
  assert.ok(live.every((e) => e.ev === 'tick'));
});

test('I7: rotation keeps exactly one archive generation (does not pile up .2, .3, ...)', () => {
  process.env.AUTOPILOT_ROTATE_BYTES_OVERRIDE = '150';
  const dir = tempProjectDir();
  const file = path.join(dir, '.autopilot', 'events.jsonl');

  for (let i = 0; i < 60; i += 1) {
    events.appendEvent(dir, 'p', 'tick', { i, pad: 'x'.repeat(20) });
  }

  assert.ok(fs.existsSync(`${file}.1`));
  assert.equal(fs.existsSync(`${file}.2`), false, 'must not accumulate a second archive generation');
});

test('I7: ACTIVITY.log rotates to .1 once it crosses the (injectable) size cap', () => {
  process.env.AUTOPILOT_ROTATE_BYTES_OVERRIDE = '200';
  const dir = tempProjectDir();
  const file = path.join(dir, 'ACTIVITY.log');
  const archive = `${file}.1`;

  for (let i = 0; i < 20; i += 1) {
    events.activity(dir, `line ${i} ${'x'.repeat(20)}`);
  }

  assert.ok(fs.existsSync(archive), 'expected a .1 archive to exist once the cap was crossed');
  const tail = events.tailActivity(dir, 1000);
  assert.ok(tail.length > 0);
});

test('activity emits via onActivity for every call', () => {
  const dir = tempProjectDir();
  const received = [];
  const off = events.onActivity((payload) => received.push(payload));
  try {
    events.activity(dir, 'hello there', 'model');
    assert.equal(received.length, 1);
    assert.equal(received[0].who, 'model');
    assert.match(received[0].line, /hello there/);
  } finally {
    off();
  }
  // after unsubscribing, no further events delivered
  events.activity(dir, 'should not be received');
  assert.equal(received.length, 1);
});
