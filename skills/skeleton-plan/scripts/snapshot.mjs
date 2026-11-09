import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { ensureSafeDir, fail } from './tools.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ARCHIVE = 1024 * 1024 * 1024;
const RUN_TIMEOUT_MS = 600 * 1000;
const MAX_OUTPUT = 64 * 1024 * 1024;

const RUN_DIR = /^\d+-\d+$/;

function pruneOldRuns(runRoot) {
  for (const name of readdirSync(runRoot).filter((n) => RUN_DIR.test(n))) {
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

const NUXT = { config: 'nuxt.config.ts', name: 'nuxt', generatedInputs: ['generated'], prepare: ['npx', '--no-install', 'nuxi', 'prepare'] };

/** The `nuxt` adapter's generated inputs when `<sha>:./nuxt.config.ts` exists relative to `repoRoot` (which may be a subdirectory of the git repo), else `[]`. */
export function generatedInputsAt(repoRoot, sha) {
  const found = spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `${sha}:./${NUXT.config}`], { stdio: 'ignore' }).status === 0;
  return found ? [...NUXT.generatedInputs] : [];
}

/** From the snapshot: `nuxt.config.ts` means `nuxt`, else `tsc`; typecheck is the snapshot's `typecheck` script, else the loaded `tsc` with `--noEmit -p tsconfig.json`. */
export function detectAdapter(dir, tsInfo) {
  let scripts = {};
  try {
    scripts = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).scripts ?? {};
  } catch {}
  const typecheck = typeof scripts.typecheck === 'string' ? ['npm', 'run', 'typecheck'] : ['node', tsInfo?.tscPath, '--noEmit', '-p', 'tsconfig.json'];
  if (existsSync(join(dir, NUXT.config))) {
    return { name: NUXT.name, generatedInputs: [...NUXT.generatedInputs], prepare: [...NUXT.prepare], typecheck };
  }
  return { name: 'tsc', generatedInputs: [], prepare: null, typecheck };
}

/** Runs the adapter's prepare command in `dir`; throws code 3 `blocked: prepare failed` on a nonzero exit or a spawn error; does nothing when `prepare` is `null`. */
export function runPrepare(dir, adapter) {
  if (!adapter.prepare) return;
  const [cmd, ...args] = adapter.prepare;
  const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT });
  if (r.error || r.status !== 0) {
    const reason = r.error ? (r.error.code ?? r.error.message) : `exit ${r.status}`;
    const tail = String(r.stderr ?? '').trim().split('\n').slice(-5).join('\n');
    throw fail(`blocked: prepare failed (${reason})${tail ? `\n${tail}` : ''}`, 3);
  }
}

const ANSI = /\u001b\[[0-9;]*m/g;
const PLAIN_DIAGNOSTIC = /^(.+?)\((\d+),\d+\): error TS\d+: (.*)$/;
const PRETTY_DIAGNOSTIC = /^(.+?):(\d+):\d+ - error TS\d+: (.*)$/;
const GLOBAL_DIAGNOSTIC = /^error TS\d+: (.*)$/;

function toRelative(dir, file) {
  const slashed = file.replaceAll('\\', '/');
  if (!isAbsolute(file) && !/^[A-Za-z]:\//.test(slashed)) return slashed.replace(/^\.\//, '');
  const roots = [dir, realpathSync.native(dir)].map((d) => d.replaceAll('\\', '/').replace(/\/+$/, ''));
  const root = roots.find((r) => slashed.startsWith(`${r}/`));
  return root ? slashed.slice(root.length + 1) : slashed;
}

/** Repo-relative, `/`-separated paths of the files the snapshot's `tsconfig.json` includes; throws code 3 `blocked: tsconfig unreadable` when it is missing or invalid. */
export function coveredFiles(dir, ts) {
  const unreadable = () => {
    throw fail('blocked: tsconfig unreadable', 3);
  };
  const configPath = join(dir, 'tsconfig.json');
  if (!existsSync(configPath)) unreadable();
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: unreadable };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
  if (!parsed) unreadable();
  return new Set(parsed.fileNames.map((f) => toRelative(dir, f)));
}

function parseDiagnostics(dir, output) {
  const diagnostics = [];
  for (const raw of output.replace(ANSI, '').split(/\r?\n/)) {
    const m = PLAIN_DIAGNOSTIC.exec(raw) ?? PRETTY_DIAGNOSTIC.exec(raw);
    if (m) diagnostics.push({ file: toRelative(dir, m[1]), line: Number(m[2]), message: m[3] });
    const global = m ? null : GLOBAL_DIAGNOSTIC.exec(raw);
    if (global) diagnostics.push({ file: '', line: 0, message: global[1] });
  }
  return diagnostics;
}

/** Runs the adapter's typecheck in `dir` and never throws; parses `file(line,col): error TSnnnn: message` and `file:line:col - error TSnnnn: message` lines from stdout and stderr into repo-relative diagnostics; a file-less `error TSnnnn: message` gets `file: ''`. */
export function runTypecheck(dir, adapter) {
  const [cmd, ...args] = adapter.typecheck;
  const r = spawnSync(cmd, args, { cwd: dir, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT });
  return {
    exitCode: r.status,
    signal: r.signal ?? null,
    spawnError: r.error ? (r.error.code ?? r.error.message) : null,
    diagnostics: parseDiagnostics(dir, `${r.stdout ?? ''}\n${r.stderr ?? ''}`),
  };
}
