import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, relative, sep } from 'node:path';
import { ensureSafeDir, fail } from './tools.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ARCHIVE = 1024 * 1024 * 1024;

function pruneOldRuns(runRoot) {
  for (const name of readdirSync(runRoot)) {
    const p = join(runRoot, name);
    if (Date.now() - lstatSync(p).mtimeMs > DAY_MS) rmSync(p, { recursive: true, force: true });
  }
}

function newRunDir(runRoot) {
  for (let stamp = Date.now(); ; stamp++) {
    const dir = join(runRoot, `${stamp}-${process.pid}`);
    try {
      mkdirSync(dir, { mode: 0o700 });
      return dir;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
}

function files(root, dir = root) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    return e.isDirectory() ? files(root, p) : [p];
  });
}

function assertNoEscapingLinks(dir, scan = dir, label = 'link') {
  const real = realpathSync.native(dir);
  const checkLink = (p) => {
    let target = null;
    try {
      target = realpathSync.native(p);
    } catch {}
    if (target !== real && !(target ?? '').startsWith(real + sep)) throw fail(`blocked: ${label} leaves snapshot: ${p}`, 3);
  };
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isSymbolicLink()) checkLink(p);
      else if (e.isDirectory()) walk(p);
    }
  };
  if (lstatSync(scan).isSymbolicLink()) checkLink(scan);
  walk(scan);
}

const LOCKFILES = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'];

function cloneDependencies(repoRoot, dir, fingerprints) {
  const lockName = LOCKFILES.find((n) => existsSync(join(dir, n)));
  if (!lockName) return;
  const baseLock = readFileSync(join(dir, lockName));
  const checkoutLock = join(repoRoot, lockName);
  if (!existsSync(checkoutLock) || !baseLock.equals(readFileSync(checkoutLock))) throw fail('blocked: dependencies differ from base', 3);
  fingerprints.lockfileHash = createHash('sha256').update(baseLock).digest('hex');
  fingerprints.nodeVersion = process.version;
  const from = join(repoRoot, 'node_modules');
  if (!existsSync(from)) return;
  const to = join(dir, 'node_modules');
  if (spawnSync('cp', ['-cR', from, to]).status !== 0) {
    rmSync(to, { recursive: true, force: true });
    const copy = spawnSync('cp', ['-R', from, to]);
    if (copy.status !== 0) throw fail(`blocked: dependency clone failed: ${(copy.error?.message ?? String(copy.stderr)).trim()}`, 3);
  }
  assertNoEscapingLinks(dir, to, 'dependency link');
}

function fingerprint(path) {
  const hash = createHash('sha256');
  const st = lstatSync(path);
  const list = st.isDirectory() ? files(path).map((f) => relative(path, f)).sort() : [''];
  for (const rel of list) {
    const p = rel ? join(path, rel) : path;
    const body = lstatSync(p).isSymbolicLink() ? Buffer.from(readlinkSync(p)) : readFileSync(p);
    hash.update(`${rel}\0${body.length}\0`);
    hash.update(body);
  }
  return hash.digest('hex');
}

/** `git archive <base>` into a new run dir under `runRoot`; each present generated input is copied and sha256-fingerprinted; run dirs older than 24 hours are deleted first. */
export function makeSnapshot(repoRoot, base, generatedInputs, runRoot) {
  ensureSafeDir(runRoot, 'runs directory');
  pruneOldRuns(runRoot);
  const dir = newRunDir(runRoot);
  let sha;
  try {
    sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw fail(`blocked: base ${base} is not a commit`, 3);
  }
  let archive;
  try {
    archive = execFileSync('git', ['-C', repoRoot, 'archive', '--format=tar', sha], { maxBuffer: MAX_ARCHIVE, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw fail(`blocked: snapshot export failed: ${String(e.stderr ?? e.message).trim()}`, 3);
  }
  const untar = spawnSync('tar', ['-x', '-C', dir], { input: archive });
  if (untar.status !== 0) throw fail(`blocked: snapshot extract failed: ${String(untar.stderr).trim()}`, 3);
  const fingerprints = {};
  for (const input of generatedInputs) {
    const from = join(repoRoot, input);
    if (!existsSync(from)) continue;
    const to = join(dir, input);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    fingerprints[input] = fingerprint(to);
  }
  assertNoEscapingLinks(dir);
  cloneDependencies(repoRoot, dir, fingerprints);
  return { dir, fingerprints };
}

/** From the snapshot: `nuxt.config.ts` means `nuxt`, else `tsc`; `typecheck` stays `null` until the typecheck task fills it. */
export function detectAdapter(dir, tsInfo) {
  if (existsSync(join(dir, 'nuxt.config.ts'))) {
    return { name: 'nuxt', generatedInputs: ['generated'], prepare: ['npx', '--no-install', 'nuxi', 'prepare'], typecheck: null };
  }
  return { name: 'tsc', generatedInputs: [], prepare: null, typecheck: null };
}
