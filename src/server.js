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
const experiments = require('./experiments');

// Preview static serving (experiments spec 2026-08-07): variant output only,
// resolved + traversal-guarded in experiments.resolvePreviewPath. Anything
// not in this map serves as octet-stream (download, never executed).
const PREVIEW_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

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

// Shared contracts (v0.3): GET /api/projects/:id/orders reads
// <dir>/orders/*.md - path-safe (only filenames matching this pattern,
// no separators/traversal), parses title (first line minus '# ') and
// status (scan the first 10 lines for the status: line), sorted by id
// (filename without extension). Orders are model-written project files;
// treat their content as untrusted just like PLAN.md/UPDATES.md.
const ORDER_FILENAME_RE = /^[\w-]+\.md$/i;
const ORDER_STATUS_RE = /^status:\s*(open|in_progress|done|blocked)\b/;

function readOrders(dir) {
  const ordersDir = path.join(dir, 'orders');
  let names;
  try {
    names = fs.readdirSync(ordersDir);
  } catch (err) {
    return [];
  }
  const orders = [];
  for (const name of names) {
    if (!ORDER_FILENAME_RE.test(name)) continue;
    const filePath = path.join(ordersDir, name);
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      continue;
    }
    const lines = content.split(/\r?\n/);
    const titleLine = lines[0] || '';
    const title = titleLine.replace(/^#\s*/, '').trim();
    let status = 'open';
    for (let i = 0; i < Math.min(10, lines.length); i++) {
      const m = lines[i].match(ORDER_STATUS_RE);
      if (m) {
        status = m[1];
        break;
      }
    }
    orders.push({ id: name.replace(/\.md$/i, ''), title, status });
  }
  orders.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return orders;
}

// Blocks until the user picks a folder or cancels. Windows PowerShell 5.1's
// WinForms FolderBrowserDialog is the 1990s tree widget, so this goes
// straight to the modern shell IFileDialog (what Explorer itself uses) via
// COM interop - full modern picker, address bar, New Folder, the lot.
const PICKER_PS_SCRIPT = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFileDialog {
  [PreserveSig] uint Show(IntPtr hwndParent);
  void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
  void SetFileTypeIndex(uint iFileType);
  void GetFileTypeIndex(out uint piFileType);
  void Advise(IntPtr pfde, out uint pdwCookie);
  void Unadvise(uint dwCookie);
  void SetOptions(uint fos);
  void GetOptions(out uint pfos);
  void SetDefaultFolder(IShellItem psi);
  void SetFolder(IShellItem psi);
  void GetFolder(out IShellItem ppsi);
  void GetCurrentSelection(out IShellItem ppsi);
  void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
  void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
  void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
  void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
  void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
  void GetResult(out IShellItem ppsi);
  void AddPlace(IShellItem psi, int fdap);
  void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
  void Close(int hr);
  void SetClientGuid(ref Guid guid);
  void ClearClientData();
  void SetFilter(IntPtr pFilter);
}

[ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IShellItem {
  void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
  void GetParent(out IShellItem ppsi);
  void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
  void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
  void Compare(IShellItem psi, uint hint, out int piOrder);
}

[ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")]
public class FileOpenDialogRCW {}

public static class FolderPicker {
  public static string Pick() {
    IFileDialog dlg = (IFileDialog)new FileOpenDialogRCW();
    uint opts;
    dlg.GetOptions(out opts);
    // FOS_PICKFOLDERS (0x20) | FOS_FORCEFILESYSTEM (0x40)
    dlg.SetOptions(opts | 0x20u | 0x40u);
    dlg.SetTitle("Select the project directory for Autopilot");
    if (dlg.Show(IntPtr.Zero) != 0) return null; // canceled
    IShellItem item;
    dlg.GetResult(out item);
    string path;
    item.GetDisplayName(0x80058000u, out path); // SIGDN_FILESYSPATH
    return path;
  }
}
"@
$p = [FolderPicker]::Pick()
if ($p) { [Console]::Out.Write($p) }
`;

function openNativeFolderPicker() {
  const { spawn } = require('child_process');
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-STA', '-Command', PICKER_PS_SCRIPT], {
      windowsHide: true,
      timeout: 5 * 60 * 1000,
    });
    let out = '';
    let errOut = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (errOut += c));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`picker exited ${code}: ${errOut.slice(0, 300)}`));
      resolve(out.trim() || null);
    });
  });
}

let pickerBusy = false;

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

    // ---- native folder picker (add-project modal) --------------------------
    // The daemon runs in the user's own desktop session, so it can open the
    // real Windows folder-picker dialog (with its Make New Folder button)
    // and return the chosen absolute path - something a browser page can
    // never obtain on its own. One dialog at a time; the request blocks
    // until the user picks or cancels (up to 5 minutes).
    if (method === 'POST' && pathname === '/api/fs/pick') {
      if (process.platform !== 'win32') return sendJson(res, 501, { error: 'native picker is Windows-only' });
      if (pickerBusy) return sendJson(res, 409, { error: 'a picker dialog is already open' });
      pickerBusy = true;
      try {
        const picked = await openNativeFolderPicker();
        return sendJson(res, 200, picked ? { path: picked.replace(/\\/g, '/') } : { canceled: true });
      } catch (err) {
        util.log('server: folder picker failed', String((err && err.message) || err));
        return sendJson(res, 500, { error: 'picker failed' });
      } finally {
        pickerBusy = false;
      }
    }

    // ---- experiments -------------------------------------------------------
    if (pathname === '/api/experiments') {
      if (method === 'GET') {
        return sendJson(res, 200, { experiments: experiments.listExperiments(scheduler) });
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        try {
          const record = experiments.createExperiment(scheduler, body);
          return sendJson(res, 200, { experiment: record });
        } catch (err) {
          const status = err && err.status === 400 ? 400 : 500;
          if (status === 500) util.log('server: createExperiment failed', String((err && err.stack) || err));
          return sendJson(res, status, { error: String((err && err.message) || 'experiment creation failed') });
        }
      }
    }

    let em = pathname.match(/^\/api\/experiments\/([^/]+)\/variants$/);
    if (em && method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const variant = experiments.addVariant(scheduler, em[1], body);
        return sendJson(res, 200, { variant, experiments: experiments.listExperiments(scheduler) });
      } catch (err) {
        const status = err && err.status === 400 ? 400 : 500;
        if (status === 500) util.log('server: addVariant failed', String((err && err.stack) || err));
        return sendJson(res, status, { error: String((err && err.message) || 'add variant failed') });
      }
    }

    em = pathname.match(/^\/api\/experiments\/([^/]+)\/(stop|start)$/);
    if (em && method === 'POST') {
      const ok = experiments.fanOut(scheduler, em[1], em[2]);
      if (!ok) return sendJson(res, 404, { error: 'unknown experiment' });
      return sendJson(res, 200, { experiments: experiments.listExperiments(scheduler) });
    }

    em = pathname.match(/^\/api\/experiments\/([^/]+)$/);
    if (em && method === 'DELETE') {
      const result = experiments.deleteExperiment(scheduler, em[1], query.get('dirs') === '1', query.get('containers') === '1');
      if (!result.ok) return sendJson(res, 409, { error: result.error });
      return sendJson(res, 200, { experiments: experiments.listExperiments(scheduler) });
    }

    // Serve a variant's built output. /preview/<exp>/<label>/<anything>.
    em = pathname.match(/^\/preview\/([^/]+)\/([^/]+)(\/.*)?$/);
    if (em && method === 'GET') {
      if (!em[3]) {
        // Redirect /preview/e/v to /preview/e/v/ so relative asset URLs in
        // the served page resolve under the variant's own path prefix.
        res.writeHead(302, { Location: `${pathname}/` });
        res.end();
        return;
      }
      const filePath = experiments.resolvePreviewPath(em[1], em[2], em[3]);
      if (!filePath) return sendJson(res, 404, { error: 'no output yet' });
      const ext = path.extname(filePath).toLowerCase();
      return serveFile(res, filePath, PREVIEW_TYPES[ext] || 'application/octet-stream');
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

    m = pathname.match(/^\/api\/projects\/([^/]+)\/orders$/);
    if (m && method === 'GET') {
      const project = findProject(scheduler, m[1]);
      if (!project) return sendJson(res, 404, { error: 'project not found' });
      return sendJson(res, 200, { orders: readOrders(project.dir) });
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

    // Deregister a project. Its directory, git history and work product are
    // never touched: those are the user's, and a registry entry is not.
    m = pathname.match(/^\/api\/projects\/([^/]+)$/);
    if (m && method === 'DELETE') {
      const ok = scheduler.removeProject(m[1]);
      if (!ok) return sendJson(res, 409, { error: 'unknown project, or it is mid-cycle' });
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

    // Edit an existing project's config (model, workerModel, effort,
    // workerEffort, verifyCmd, criticRatio, ...). The body is a partial
    // patch; the scheduler/state layer validates each field and ignores
    // anything invalid or non-editable. Applies on the next cycle.
    m = pathname.match(/^\/api\/projects\/([^/]+)\/config$/);
    if (m && method === 'POST') {
      const body = await readJsonBody(req);
      const ok = scheduler.updateProject(m[1], body);
      if (!ok) return sendJson(res, 400, { error: 'unknown project' });
      return sendJson(res, 200, scheduler.snapshot());
    }

    // Bring the local inference server + router up on demand. Returns as soon
    // as the launcher is spawned; the caller watches localModel.available in
    // /api/status to see when it is actually ready.
    if (method === 'POST' && pathname === '/api/localmodel/start') {
      const r = scheduler.startLocalModel();
      if (!r.ok) return sendJson(res, 409, { error: r.error });
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
