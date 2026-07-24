'use strict';

// HTTP + SSE server: binds 127.0.0.1 only, implements the HTTP API from
// docs/plans/2026-07-23-autopilot-build.md "Shared contracts", and serves
// the static UI. Zero npm dependencies, Node built-ins only, CommonJS.
//
// The scheduler INSTANCE is injected (never constructed here) - this
// module only calls its command methods, snapshot(), and subscribes to its
// 'status' EventEmitter event. Tests inject a minimal fake scheduler (plain
// EventEmitter + stub methods returning canned snapshots); production code
// (autopilot.js) injects the real src/scheduler.js Scheduler instance.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const util = require('./util');
const events = require('./events');

const UI_DIR = path.join(__dirname, '..', 'ui');

// Shared contracts: GET /api/projects/:id/file?name=... whitelist is
// exactly these three files - nothing else, no path separators.
const FILE_WHITELIST = new Set(['PLAN.md', 'UPDATES.md', 'WORKLOG.md']);

const SSE_HEARTBEAT_MS = 15000;
const SSE_STATUS_INTERVAL_MS = 5000;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function serveFile(res, filePath, contentType) {
  let data;
  try {
    data = fs.readFileSync(filePath);
  } catch (err) {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': data.length,
  });
  res.end(data);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 10 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        resolve({}); // tolerate a malformed/empty JSON body on action POSTs
      }
    });
    req.on('error', reject);
  });
}

// SPEC.md section 6 / docs/plans Global Constraints: bind 127.0.0.1 only
// and reject any request whose Host header is not localhost:<port> /
// 127.0.0.1:<port> (bare, no port, is also accepted - DNS rebinding
// attacks forge a hostname, not the loopback address itself). The actual
// bound port is read from the live server (not the `port` option) so this
// also works correctly for tests that request an ephemeral port (0).
function isAllowedHost(hostHeader, actualPort) {
  if (!hostHeader) return false;
  const host = String(hostHeader).toLowerCase();
  const allowed = new Set(['localhost', '127.0.0.1', `localhost:${actualPort}`, `127.0.0.1:${actualPort}`]);
  return allowed.has(host);
}

function findProject(scheduler, id) {
  let snap;
  try {
    snap = scheduler.snapshot();
  } catch (err) {
    return null;
  }
  const projects = (snap && snap.projects) || [];
  return projects.find((p) => p.id === id) || null;
}

function startServer({ scheduler, port }) {
  const sseClients = new Set();

  function broadcastSSE(eventName, data) {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of sseClients) {
      try {
        res.write(payload);
      } catch (err) {
        // best effort - a dead socket will be cleaned up by its close handler
      }
    }
  }

  // Global events (budget/sleep/grace) are replicated by the scheduler into
  // every project's own events.jsonl, so per-project GET .../events already
  // carries them - no separate aggregation endpoint is needed here either.
  const onStatus = (snap) => broadcastSSE('status', snap);
  scheduler.on('status', onStatus);

  // events.onActivity's callback signature is {dir, who, line} (see
  // src/events.js) - not {projectId, ...}. Map dir -> project id via the
  // current snapshot (which carries each project's `dir`) so the SSE
  // 'activity' payload matches the exact shape the UI expects:
  // {"project":"<id>","line":"..."}.
  const unsubscribeActivity = events.onActivity(({ dir, line }) => {
    let projectId = null;
    try {
      const snap = scheduler.snapshot();
      const proj = ((snap && snap.projects) || []).find((p) => p.dir === dir);
      projectId = proj ? proj.id : path.basename(dir);
    } catch (err) {
      projectId = path.basename(dir);
    }
    broadcastSSE('activity', { project: projectId, line });
  });

  const heartbeatTimer = setInterval(() => {
    for (const res of sseClients) {
      try {
        res.write(': heartbeat\n\n');
      } catch (err) {
        // best effort
      }
    }
  }, SSE_HEARTBEAT_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();

  const statusTimer = setInterval(() => {
    try {
      broadcastSSE('status', scheduler.snapshot());
    } catch (err) {
      util.log('server: periodic snapshot failed', String((err && err.message) || err));
    }
  }, SSE_STATUS_INTERVAL_MS);
  if (statusTimer.unref) statusTimer.unref();

  function handleSSE(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (res.flushHeaders) res.flushHeaders();
    res.write(': connected\n\n');
    sseClients.add(res);

    // Send an immediate snapshot so the UI does not wait up to 5s on
    // first paint; this is in addition to, not instead of, the
    // event-driven and periodic broadcasts below.
    try {
      res.write(`event: status\ndata: ${JSON.stringify(scheduler.snapshot())}\n\n`);
    } catch (err) {
      // best effort
    }

    req.on('close', () => {
      sseClients.delete(res);
    });
  }

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      util.log('server: unhandled request error', String((err && err.stack) || err));
      try {
        if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
        else res.end();
      } catch (e2) {
        // nothing left to do
      }
    });
  });

  async function handleRequest(req, res) {
    const actualPort = (server.address() && server.address().port) || port;
    const hostHeader = req.headers.host;
    if (!isAllowedHost(hostHeader, actualPort)) {
      sendJson(res, 403, { error: 'forbidden host' });
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(req.url, 'http://internal');
    } catch (err) {
      sendJson(res, 400, { error: 'bad request' });
      return;
    }
    const pathname = decodeURIComponent(parsedUrl.pathname);
    const query = parsedUrl.searchParams;
    const method = req.method;

    // ---- static UI --------------------------------------------------------
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return serveFile(res, path.join(UI_DIR, 'index.html'), 'text/html; charset=utf-8');
    }
    if (method === 'GET' && pathname === '/mock-status.json') {
      return serveFile(res, path.join(UI_DIR, 'mock-status.json'), 'application/json; charset=utf-8');
    }

    // ---- status + stream ---------------------------------------------------
    if (method === 'GET' && pathname === '/api/status') {
      return sendJson(res, 200, scheduler.snapshot());
    }
    if (method === 'GET' && pathname === '/api/stream') {
      return handleSSE(req, res);
    }

    // ---- per-project GETs ---------------------------------------------------
    let m = pathname.match(/^\/api\/projects\/([^/]+)\/activity$/);
    if (m && method === 'GET') {
      const project = findProject(scheduler, m[1]);
      if (!project) return sendJson(res, 404, { error: 'project not found' });
      const lines = parseInt(query.get('lines'), 10);
      return sendJson(res, 200, { lines: events.tailActivity(project.dir, Number.isFinite(lines) ? lines : 200) });
    }

    m = pathname.match(/^\/api\/projects\/([^/]+)\/events$/);
    if (m && method === 'GET') {
      const project = findProject(scheduler, m[1]);
      if (!project) return sendJson(res, 404, { error: 'project not found' });
      const limit = parseInt(query.get('limit'), 10);
      return sendJson(res, 200, { events: events.readEvents(project.dir, Number.isFinite(limit) ? limit : 100) });
    }

    m = pathname.match(/^\/api\/projects\/([^/]+)\/file$/);
    if (m && method === 'GET') {
      const project = findProject(scheduler, m[1]);
      if (!project) return sendJson(res, 404, { error: 'project not found' });
      const name = query.get('name');
      // Whitelist is exact-match only: reject anything not literally one of
      // the three names, including path separators or traversal sequences
      // (both '/' and '\' - Windows accepts either as a separator).
      if (!name || !FILE_WHITELIST.has(name) || name.includes('/') || name.includes('\\')) {
        return sendJson(res, 400, { error: 'invalid file name' });
      }
      const filePath = path.join(project.dir, name);
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        content = '';
      }
      return sendJson(res, 200, { name, content });
    }

    // ---- POST actions -------------------------------------------------------
    if (method === 'POST' && pathname === '/api/projects') {
      const body = await readJsonBody(req);
      scheduler.addProject(body);
      return sendJson(res, 200, scheduler.snapshot());
    }

    m = pathname.match(/^\/api\/projects\/([^/]+)\/start$/);
    if (m && method === 'POST') {
      scheduler.startProject(m[1]);
      return sendJson(res, 200, scheduler.snapshot());
    }

    m = pathname.match(/^\/api\/projects\/([^/]+)\/stop$/);
    if (m && method === 'POST') {
      scheduler.stopProject(m[1]);
      return sendJson(res, 200, scheduler.snapshot());
    }

    m = pathname.match(/^\/api\/projects\/([^/]+)\/reviewed$/);
    if (m && method === 'POST') {
      scheduler.markReviewed(m[1]);
      return sendJson(res, 200, scheduler.snapshot());
    }

    m = pathname.match(/^\/api\/projects\/([^/]+)\/inject$/);
    if (m) {
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const ok = scheduler.addInjection(m[1], body.text);
        if (!ok) return sendJson(res, 400, { error: 'empty text or unknown project' });
        return sendJson(res, 200, scheduler.snapshot());
      }
      if (method === 'GET') {
        const text = scheduler.getInjection(m[1]);
        if (text === null) return sendJson(res, 404, { error: 'unknown project' });
        return sendJson(res, 200, { text });
      }
      if (method === 'DELETE') {
        scheduler.clearInjection(m[1]);
        return sendJson(res, 200, scheduler.snapshot());
      }
    }

    m = pathname.match(/^\/api\/projects\/([^/]+)\/priority$/);
    if (m && method === 'POST') {
      const body = await readJsonBody(req);
      const ok = scheduler.setPriority(m[1], body.priority);
      if (!ok) return sendJson(res, 400, { error: 'invalid priority or unknown project' });
      return sendJson(res, 200, scheduler.snapshot());
    }

    if (method === 'POST' && pathname === '/api/pause') {
      scheduler.pauseAll();
      return sendJson(res, 200, scheduler.snapshot());
    }
    if (method === 'POST' && pathname === '/api/resume') {
      scheduler.resumeAll();
      return sendJson(res, 200, scheduler.snapshot());
    }
    if (method === 'POST' && pathname === '/api/settings') {
      const body = await readJsonBody(req);
      scheduler.updateSettings(body);
      return sendJson(res, 200, scheduler.snapshot());
    }
    if (method === 'POST' && pathname === '/api/fatal/clear') {
      scheduler.clearFatal();
      return sendJson(res, 200, scheduler.snapshot());
    }

    // Graceful daemon stop: scheduler stop + server close + process exit,
    // AFTER the response has flushed to the client (the CLI's `autopilot
    // stop` with no id posts here). Not exercised by the injected-fake
    // server tests (see test/server.test.js) - only the real daemon
    // (autopilot.js `daemon` command) should ever receive this in practice.
    if (method === 'POST' && pathname === '/api/shutdown') {
      const body = JSON.stringify({ ok: true, shuttingDown: true });
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      res.once('finish', () => {
        setImmediate(async () => {
          try {
            if (typeof scheduler.stopDaemon === 'function') await scheduler.stopDaemon();
          } catch (err) {
            util.log('server: scheduler.stopDaemon() during shutdown failed', String((err && err.message) || err));
          }
          close(() => {
            process.exit(0);
          });
        });
      });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  }

  function close(cb) {
    clearInterval(heartbeatTimer);
    clearInterval(statusTimer);
    scheduler.removeListener('status', onStatus);
    unsubscribeActivity();
    for (const res of sseClients) {
      try {
        res.end();
      } catch (err) {
        // already closed
      }
    }
    sseClients.clear();
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(cb);
  }

  server.listen(port, '127.0.0.1');

  return { server, close };
}

module.exports = { startServer, isAllowedHost, FILE_WHITELIST };
