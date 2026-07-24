'use strict';

// Foundation module: events.jsonl + ACTIVITY.log append/read.
// Zero npm dependencies, Node built-ins only, CommonJS.

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const util = require('./util');

const EVENTS_FILENAME = 'events.jsonl';
const ACTIVITY_FILENAME = 'ACTIVITY.log';

// I7 fix (SPEC.md section 8: "Rotate events.jsonl and ACTIVITY.log (size cap
// ~10 MB, keep a few archives); both grow forever otherwise"). Not
// previously implemented anywhere - readEvents()/tailActivity() read the
// entire file into memory on every API call and every UI poll, so an
// unrotated long-lived project degrades the daemon and UI together.
//
// Env override (same convention as util.AUTOPILOT_HOME_OVERRIDE) lets tests
// exercise rotation with a tiny cap instead of writing 10 MB of fixture data.
const DEFAULT_ROTATE_MAX_BYTES = 10 * 1024 * 1024;

function rotateMaxBytes() {
  const override = process.env.AUTOPILOT_ROTATE_BYTES_OVERRIDE;
  if (override !== undefined) {
    const n = Number(override);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_ROTATE_MAX_BYTES;
}

// Keeps exactly one archive generation (`<name>.1`), overwriting any older
// one, checked before every append. Best-effort: any failure just logs and
// leaves the file to keep growing rather than breaking the append itself.
function rotateIfNeeded(file) {
  let size;
  try {
    size = fs.statSync(file).size;
  } catch (err) {
    return; // does not exist yet - nothing to rotate
  }
  if (size < rotateMaxBytes()) return;

  const archive = `${file}.1`;
  try {
    fs.rmSync(archive, { force: true });
  } catch (err) {
    // best effort
  }
  try {
    fs.renameSync(file, archive);
  } catch (err) {
    util.log('events: rotation rename failed for', file, String(err && err.message));
  }
}

// Module-level emitter: one process, one set of subscribers (the server's
// SSE layer). runner.js pipes model output lines through activity() with
// who='model'; the daemon's own lines use the who='daemon' default.
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

function eventsFile(dir) {
  return path.join(util.projectMeta(dir), EVENTS_FILENAME);
}

function activityFile(dir) {
  return path.join(dir, ACTIVITY_FILENAME);
}

function appendEvent(dir, projectId, ev, fields) {
  const file = eventsFile(dir);
  util.ensureDir(path.dirname(file));
  rotateIfNeeded(file);
  const record = Object.assign({ t: util.nowIso(), ev, project: projectId }, fields || {});
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  return record;
}

// Tolerates corrupt lines (skips them). Returns events oldest-first,
// newest last, capped to the last `limit` entries.
function readEvents(dir, limit = 100) {
  let raw;
  try {
    raw = fs.readFileSync(eventsFile(dir), 'utf8');
  } catch (err) {
    return [];
  }

  const lines = raw.split('\n').filter((line) => line.length > 0);
  const parsed = [];
  for (const line of lines) {
    try {
      parsed.push(JSON.parse(line));
    } catch (err) {
      // corrupt line: skip, keep going
    }
  }

  if (parsed.length > limit) {
    return parsed.slice(parsed.length - limit);
  }
  return parsed;
}

function activity(dir, line, who = 'daemon') {
  const file = activityFile(dir);
  util.ensureDir(path.dirname(file));
  rotateIfNeeded(file);
  const stamped = `[${util.nowIso()}] [${who}] ${line}`;
  fs.appendFileSync(file, `${stamped}\n`);
  emitter.emit('activity', { dir, who, line: stamped });
  return stamped;
}

// Returns the last `lines` entries of ACTIVITY.log (empty array if the
// file does not exist yet).
function tailActivity(dir, lines = 200) {
  let raw;
  try {
    raw = fs.readFileSync(activityFile(dir), 'utf8');
  } catch (err) {
    return [];
  }

  const all = raw.split('\n').filter((line) => line.length > 0);
  if (all.length > lines) {
    return all.slice(all.length - lines);
  }
  return all;
}

// Subscribes cb to every activity() call across all projects; returns an
// unsubscribe function.
function onActivity(cb) {
  emitter.on('activity', cb);
  return () => emitter.off('activity', cb);
}

module.exports = {
  appendEvent,
  readEvents,
  activity,
  tailActivity,
  onActivity,
  rotateIfNeeded,
};
