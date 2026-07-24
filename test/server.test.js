'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { startServer } = require('../src/server');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeSnapshot(overrides) {
  return Object.assign(
    {
      daemon: { pid: 123, startedIso: '2026-07-23T00:00:00-07:00', version: '0.2.0', paused: false },
      fatal: null,
      budget: { ok: true, reason: null, checkedIso: null, windows: [] },
      settings: { ceilingPct: 75, graceMinutes: 30, webhook: null },
      current: null,
      projects: [],
    },
    overrides || {}
  );
}

// Minimal fake scheduler per Task 7: a plain EventEmitter with stub command
// methods returning canned snapshots - the same shape the real
// src/scheduler.js Scheduler exposes (snapshot() + command methods + it IS
// the EventEmitter that emits 'status').
function makeFakeScheduler(projects) {
  const sched = new EventEmitter();
  sched._snapshot = makeSnapshot({ projects: projects || [] });
  sched.snapshot = () => sched._snapshot;
  sched.calls = [];
  const record = (name) => (...args) => {
    sched.calls.push([name, ...args]);
    return true;
  };
  sched.pauseAll = record('pauseAll');
  sched.resumeAll = record('resumeAll');
  sched.startProject = record('startProject');
  sched.stopProject = record('stopProject');
  sched.markReviewed = record('markReviewed');
  sched.setPriority = record('setPriority');
  sched.addProject = record('addProject');
  sched.updateSettings = record('updateSettings');
  sched.clearFatal = record('clearFatal');
  sched.addInjection = record('addInjection');
  sched.getInjection = (id) => (id === 'proj1' ? 'queued directive text' : null);
  sched.clearInjection = record('clearInjection');
  sched.stopDaemon = async () => {};
  return sched;
}

function requestRaw(port, method, pathName, { body, host } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : null;
    const headers = Object.assign(
      {},
      payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
      host !== undefined ? { Host: host } : {}
    );
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let parsed = null;
        try {
          parsed = data ? JSON.parse(data) : null;
        } catch (err) {
          parsed = null;
        }
        resolve({ status: res.statusCode, body: parsed, raw: data });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function withServer(scheduler, fn) {
  const handle = startServer({ scheduler, port: 0 });
  await new Promise((resolve, reject) => {
    handle.server.once('listening', resolve);
    handle.server.once('error', reject);
  });
  const port = handle.server.address().port;
  try {
    await fn(port, handle);
  } finally {
    await new Promise((resolve) => handle.close(resolve));
  }
}

// ---------------------------------------------------------------------------
// /api/status passthrough
// ---------------------------------------------------------------------------

test('GET /api/status returns the scheduler snapshot verbatim', async () => {
  const sched = makeFakeScheduler([{ id: 'proj1', dir: process.cwd(), status: 'queued' }]);
  await withServer(sched, async (port) => {
    const res = await requestRaw(port, 'GET', '/api/status', { host: `127.0.0.1:${port}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.projects[0].id, 'proj1');
    assert.equal(res.body.daemon.version, '0.2.0');
  });
});

test('GET /api/status also accepts a bare "localhost" Host header (no port)', async () => {
  const sched = makeFakeScheduler([]);
  await withServer(sched, async (port) => {
    const res = await requestRaw(port, 'GET', '/api/status', { host: 'localhost' });
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// Host header check
// ---------------------------------------------------------------------------

test('non-localhost Host header is rejected with 403 (DNS rebinding defense)', async () => {
  const sched = makeFakeScheduler([]);
  await withServer(sched, async (port) => {
    const res = await requestRaw(port, 'GET', '/api/status', { host: 'evil.example.com' });
    assert.equal(res.status, 403);
    assert.ok(res.body && res.body.error);
  });
});

test('a Host header naming the wrong port is rejected with 403', async () => {
  const sched = makeFakeScheduler([]);
  await withServer(sched, async (port) => {
    const res = await requestRaw(port, 'GET', '/api/status', { host: `127.0.0.1:${port + 1}` });
    assert.equal(res.status, 403);
  });
});

// ---------------------------------------------------------------------------
// POST project command
// ---------------------------------------------------------------------------

test('POST /api/projects/:id/start calls the scheduler method and returns the fresh snapshot', async () => {
  const sched = makeFakeScheduler([{ id: 'proj1', dir: process.cwd() }]);
  await withServer(sched, async (port) => {
    const res = await requestRaw(port, 'POST', '/api/projects/proj1/start', { host: `127.0.0.1:${port}`, body: {} });
    assert.equal(res.status, 200);
    assert.deepEqual(sched.calls[0], ['startProject', 'proj1']);
    assert.ok(res.body.daemon, 'response body must be the status snapshot');
  });
});

test('POST /api/projects/:id/stop, /reviewed, /priority and global pause/resume/settings/fatal-clear all dispatch', async () => {
  const sched = makeFakeScheduler([{ id: 'proj1', dir: process.cwd() }]);
  await withServer(sched, async (port) => {
    await requestRaw(port, 'POST', '/api/projects/proj1/stop', { host: `127.0.0.1:${port}`, body: {} });
    await requestRaw(port, 'POST', '/api/projects/proj1/reviewed', { host: `127.0.0.1:${port}`, body: {} });
    await requestRaw(port, 'POST', '/api/projects/proj1/priority', { host: `127.0.0.1:${port}`, body: { priority: 3 } });
    await requestRaw(port, 'POST', '/api/pause', { host: `127.0.0.1:${port}`, body: {} });
    await requestRaw(port, 'POST', '/api/resume', { host: `127.0.0.1:${port}`, body: {} });
    await requestRaw(port, 'POST', '/api/settings', { host: `127.0.0.1:${port}`, body: { ceilingPct: 80 } });
    await requestRaw(port, 'POST', '/api/fatal/clear', { host: `127.0.0.1:${port}`, body: {} });

    const names = sched.calls.map((c) => c[0]);
    assert.deepEqual(names, ['stopProject', 'markReviewed', 'setPriority', 'pauseAll', 'resumeAll', 'updateSettings', 'clearFatal']);
    const prioCall = sched.calls.find((c) => c[0] === 'setPriority');
    assert.deepEqual(prioCall, ['setPriority', 'proj1', 3]);
  });

});

test('inject endpoints: POST queues, GET reads, unknown id 404s, DELETE clears', async () => {
  const sched = makeFakeScheduler([{ id: 'proj1', dir: process.cwd() }]);
  await withServer(sched, async (port) => {
    const post = await requestRaw(port, 'POST', '/api/projects/proj1/inject', {
      host: `127.0.0.1:${port}`,
      body: { text: 'Please add a star field.' },
    });
    assert.equal(post.status, 200);
    assert.ok(post.body.daemon, 'POST returns the status snapshot');
    const injCall = sched.calls.find((c) => c[0] === 'addInjection');
    assert.deepEqual(injCall, ['addInjection', 'proj1', 'Please add a star field.']);

    const get = await requestRaw(port, 'GET', '/api/projects/proj1/inject', { host: `127.0.0.1:${port}` });
    assert.equal(get.status, 200);
    assert.equal(get.body.text, 'queued directive text');

    const getMissing = await requestRaw(port, 'GET', '/api/projects/nope/inject', { host: `127.0.0.1:${port}` });
    assert.equal(getMissing.status, 404);

    const del = await requestRaw(port, 'DELETE', '/api/projects/proj1/inject', { host: `127.0.0.1:${port}` });
    assert.equal(del.status, 200);
    assert.ok(sched.calls.some((c) => c[0] === 'clearInjection'));
  });
});

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

test('SSE stream delivers a status event when the scheduler emits status', async () => {
  const sched = makeFakeScheduler([]);
  await withServer(sched, async (port) => {
    await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, path: '/api/stream', method: 'GET', headers: { Host: `127.0.0.1:${port}` } },
        (res) => {
          let buf = '';
          const timer = setTimeout(() => {
            req.destroy();
            reject(new Error('timed out waiting for the emitted status event'));
          }, 3000);
          res.on('data', (chunk) => {
            buf += chunk.toString('utf8');
            // Look specifically for the marker snapshot emitted below, not
            // the connect-time snapshot the handler also sends - this
            // proves the scheduler 'status' emit path, not just the
            // on-connect courtesy send.
            if (buf.includes('event: status') && buf.includes('EMITTED_MARKER_9f3a')) {
              clearTimeout(timer);
              req.destroy();
              resolve();
            }
          });
          res.on('error', () => {});
        }
      );
      req.on('error', reject);
      req.end();
      setTimeout(() => {
        sched.emit('status', makeSnapshot({ fatal: { reason: 'EMITTED_MARKER_9f3a', t: 'x' } }));
      }, 100);
    });
  });
});

// ---------------------------------------------------------------------------
// file endpoint whitelist
// ---------------------------------------------------------------------------

test('file endpoint: whitelist rejects path traversal and non-whitelisted names, allows the three real names', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-server-file-'));
  fs.writeFileSync(path.join(dir, 'secret.txt'), 'top secret');
  fs.writeFileSync(path.join(dir, 'PLAN.md'), '- [ ] task one');
  const sched = makeFakeScheduler([{ id: 'proj1', dir }]);

  try {
    await withServer(sched, async (port) => {
      const traversal = await requestRaw(
        port,
        'GET',
        '/api/projects/proj1/file?name=' + encodeURIComponent('../../secret'),
        { host: `127.0.0.1:${port}` }
      );
      assert.equal(traversal.status, 400);

      const nonWhitelisted = await requestRaw(port, 'GET', '/api/projects/proj1/file?name=secret.txt', {
        host: `127.0.0.1:${port}`,
      });
      assert.equal(nonWhitelisted.status, 400);

      const backslash = await requestRaw(
        port,
        'GET',
        '/api/projects/proj1/file?name=' + encodeURIComponent('..\\PLAN.md'),
        { host: `127.0.0.1:${port}` }
      );
      assert.equal(backslash.status, 400);

      const good = await requestRaw(port, 'GET', '/api/projects/proj1/file?name=PLAN.md', {
        host: `127.0.0.1:${port}`,
      });
      assert.equal(good.status, 200);
      assert.equal(good.body.name, 'PLAN.md');
      assert.equal(good.body.content, '- [ ] task one');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('file endpoint: unknown project id returns 404', async () => {
  const sched = makeFakeScheduler([]);
  await withServer(sched, async (port) => {
    const res = await requestRaw(port, 'GET', '/api/projects/nope/file?name=PLAN.md', { host: `127.0.0.1:${port}` });
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// orders endpoint
// ---------------------------------------------------------------------------

test('orders endpoint: happy path, sorted, non-md files ignored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-server-orders-'));
  const ordersDir = path.join(dir, 'orders');
  fs.mkdirSync(ordersDir);
  fs.writeFileSync(
    path.join(ordersDir, '002-second.md'),
    '# Second order\nstatus: in_progress\ncreated: 2026-07-24T00:00:00-07:00 by cycle 3\nverify: -\n'
  );
  fs.writeFileSync(
    path.join(ordersDir, '001-first.md'),
    '# First order\nstatus: done\ncreated: 2026-07-24T00:00:00-07:00 by cycle 1\nverify: -\n'
  );
  fs.writeFileSync(
    path.join(ordersDir, '003-blocked.md'),
    '# Blocked order\nstatus: blocked\ncreated: 2026-07-24T00:00:00-07:00 by cycle 4\nverify: -\n'
  );
  fs.writeFileSync(path.join(ordersDir, 'notes.txt'), 'not an order');
  const sched = makeFakeScheduler([{ id: 'proj1', dir }]);

  try {
    await withServer(sched, async (port) => {
      const res = await requestRaw(port, 'GET', '/api/projects/proj1/orders', { host: `127.0.0.1:${port}` });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.orders, [
        { id: '001-first', title: 'First order', status: 'done' },
        { id: '002-second', title: 'Second order', status: 'in_progress' },
        { id: '003-blocked', title: 'Blocked order', status: 'blocked' },
      ]);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('orders endpoint: no orders dir returns empty array', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-server-orders-empty-'));
  const sched = makeFakeScheduler([{ id: 'proj1', dir }]);
  try {
    await withServer(sched, async (port) => {
      const res = await requestRaw(port, 'GET', '/api/projects/proj1/orders', { host: `127.0.0.1:${port}` });
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.orders, []);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('orders endpoint: unknown project id returns 404', async () => {
  const sched = makeFakeScheduler([]);
  await withServer(sched, async (port) => {
    const res = await requestRaw(port, 'GET', '/api/projects/nope/orders', { host: `127.0.0.1:${port}` });
    assert.equal(res.status, 404);
  });
});

// ---------------------------------------------------------------------------
// 404
// ---------------------------------------------------------------------------

test('unknown route returns a JSON 404', async () => {
  const sched = makeFakeScheduler([]);
  await withServer(sched, async (port) => {
    const res = await requestRaw(port, 'GET', '/api/does-not-exist', { host: `127.0.0.1:${port}` });
    assert.equal(res.status, 404);
    assert.ok(res.body && res.body.error);
  });
});

// ---------------------------------------------------------------------------
// static UI
// ---------------------------------------------------------------------------

test('GET / and /index.html serve ui/index.html; GET /mock-status.json serves the mock file', async () => {
  const sched = makeFakeScheduler([]);
  await withServer(sched, async (port) => {
    const root = await requestRaw(port, 'GET', '/', { host: `127.0.0.1:${port}` });
    assert.equal(root.status, 200);
    assert.match(root.raw, /<!doctype html>|<html/i);

    const indexHtml = await requestRaw(port, 'GET', '/index.html', { host: `127.0.0.1:${port}` });
    assert.equal(indexHtml.status, 200);

    const mock = await requestRaw(port, 'GET', '/mock-status.json', { host: `127.0.0.1:${port}` });
    assert.equal(mock.status, 200);
    assert.ok(mock.body);
  });
});
