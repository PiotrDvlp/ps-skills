#!/usr/bin/env node
// The ONLY component that writes a code-mode review note and, unless --no-log, prepends log.md.
//
// It calls decideWrite() itself and refuses when shouldWrite is false. There is
// deliberately no override flag: an advisory check that the caller may ignore
// gates nothing, and "no note is written on failure" has to be a property a
// test can falsify.

import {
  readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync,
  openSync, closeSync, writeSync, statSync, mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { decideWrite } from './write-decision.mjs';

// log.md is read-modify-written, so two concurrent reviews could both pass the
// guards and the later whole-file write would silently drop the earlier entry.
// A lockfile next to log.md serializes the read->write critical section.
const LOCK_TIMEOUT_MS = 2_000;   // ~20 attempts x 100ms
const LOCK_STALE_MS = 30_000;    // a crashed writer must not wedge us forever

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock(lockPath) {
  let stoleStale = false;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let fd;
    try {
      fd = openSync(lockPath, 'wx');
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      let mtimeMs;
      try {
        mtimeMs = statSync(lockPath).mtimeMs;
      } catch {
        continue;             // the holder released it between open and stat
      }
      if (Date.now() - mtimeMs > LOCK_STALE_MS && !stoleStale) {
        stoleStale = true;    // steal a stale lock exactly once, then race again
        try { unlinkSync(lockPath); } catch { /* someone else stole it first */ }
        continue;
      }
      sleepSync(100);
      continue;
    }
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    return true;
  }
  return false;
}

class CleanAbort extends Error {
  constructor(message, reason) {
    super(message);
    this.reason = reason;
  }
}

const SENTINEL = '<!-- log:entries -->';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case '--result': out.result = next(); break;      // path to runner JSON, or '-' for stdin
      case '--vault': out.vault = next(); break;
      case '--base-dir': out.baseDir = next(); break;   // vault-relative
      case '--slug': out.slug = next(); break;
      case '--routing': out.routing = next(); break;
      case '--confirmed': out.confirmed = true; break;
      case '--no-log': out.noLog = true; break;
      case '--dry-run': out.dryRun = true; break;
      default: break;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
for (const k of ['result', 'vault', 'baseDir', 'slug', 'routing']) {
  if (!args[k]) { console.error(`[usage] --${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`); process.exit(2); }
}

let result = null;
try {
  const raw = args.result === '-'
    ? readFileSync(0, 'utf8')
    : readFileSync(args.result, 'utf8');
  result = JSON.parse(raw);
} catch {
  result = null;     // unreadable/absent/invalid result is a failed run
}

const absBase = join(args.vault, args.baseDir);
const existing = existsSync(absBase)
  ? readdirSync(absBase).map((f) => `${args.baseDir}/${f}`)
  : [];

const decision = decideWrite({
  result,
  routing: args.routing,
  baseDir: args.baseDir,
  slug: args.slug,
  existing,
  confirmed: !!args.confirmed,
});

if (!decision.shouldWrite) {
  console.error(`[refused] ${decision.reason}`);
  console.log(JSON.stringify({ written: false, reason: decision.reason }, null, 2));
  process.exit(1);
}

const fm = result.frontmatter ?? {};
const yaml = [
  '---',
  `title: "${result.title.replace(/"/g, '\\"')}"`,
  'source: codex-review',
  'mode: code',
  ...Object.entries(fm).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`),
  `date_added: ${result.date}`,
  'tags: [codex-review, code]',
  '---',
  '',
].join('\n');

const notePath = join(args.vault, decision.path);

if (args.noLog) {
  if (args.dryRun) {
    console.log(JSON.stringify({ written: false, dryRun: true, path: notePath, logLine: null }, null, 2));
    process.exit(0);
  }
  mkdirSync(absBase, { recursive: true });
  writeFileSync(notePath, yaml + result.body);
  console.log(JSON.stringify({ written: true, path: notePath, logLine: null }, null, 2));
  process.exit(0);
}

// All-or-nothing: the log handoff is verified BEFORE the note write, so a guard
// failure never leaves a note on disk without its log entry. The read is
// side-effect-free, so dry-run performs the same validation and its preview
// always agrees with what a real run would do.
const logPath = join(args.vault, 'log.md');
const lockPath = join(args.vault, 'log.md.lock');

if (!acquireLock(lockPath)) {
  // Clean abort BEFORE any note write: we never held the lock, so nothing to release.
  console.error('[abort] another writer holds log.md.lock');
  console.log(JSON.stringify({ written: false, reason: 'log.md lock timeout' }, null, 2));
  process.exit(1);
}

// Guards + note write + log write all sit inside the lock; the finally block
// releases it on every path (process.exit() below runs AFTER finally).
let exitCode = 0;
try {
  let log;
  try {
    log = readFileSync(logPath, 'utf8');
  } catch (err) {
    throw new CleanAbort(`[abort] cannot read ${logPath}: ${err.code || err.message}`, 'log handoff failed before note write');
  }
  if (!log.includes(SENTINEL)) {
    throw new CleanAbort(`[abort] ${logPath} is missing the ${SENTINEL} sentinel — add the sentinel line, then re-run`, 'log handoff failed before note write');
  }

  if (args.dryRun) {
    console.log(JSON.stringify({ written: false, dryRun: true, path: decision.path, logLine: decision.logLine }, null, 2));
  } else {
    try {
      writeFileSync(notePath, yaml + result.body);
    } catch (err) {
      throw new CleanAbort(`[abort] cannot write note: ${err.code || err.message}`, 'log handoff failed before note write');
    }

    try {
      // Function replacement: a string replacement would splice `$&` (and friends)
      // from a Codex-derived title into the log line as the matched sentinel.
      writeFileSync(logPath, log.replace(SENTINEL, () => `${SENTINEL}\n\n${decision.logLine}`));
    } catch (err) {
      try { unlinkSync(notePath); } catch { /* best effort */ }
      throw new CleanAbort(`[abort] log write failed after note write, note removed: ${err.code || err.message}`, 'note removed after log handoff failure');
    }

    console.log(JSON.stringify({ written: true, path: decision.path, logLine: decision.logLine }, null, 2));
  }
} catch (err) {
  if (err instanceof CleanAbort) {
    console.error(err.message);
    console.log(JSON.stringify({ written: false, reason: err.reason }, null, 2));
  } else {
    console.error(`[abort] ${err && err.stack ? err.stack : err}`);
  }
  exitCode = 1;
} finally {
  try { unlinkSync(lockPath); } catch { /* best effort */ }
}
process.exit(exitCode);
