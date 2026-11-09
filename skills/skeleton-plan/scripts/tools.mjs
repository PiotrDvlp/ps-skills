import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PINNED_TYPESCRIPT = '5.9.3';

const COMPLETE = '.complete';
export const fail =(message, code = 3) => Object.assign(new Error(message), { code });

export function assertSafeDir(path, label) {
  const unsafe = (reason) => fail(`unsafe ${label} ${path}: ${reason}`);
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw unsafe('is a symlink');
  if (!st.isDirectory()) throw unsafe('is not a directory');
  if (typeof process.getuid !== 'function') throw unsafe('ownership cannot be checked on this platform (POSIX only)');
  if (st.uid !== process.getuid()) throw unsafe('is not owned by the current user');
  if ((st.mode & 0o077) !== 0) throw unsafe(`permissions are ${(st.mode & 0o777).toString(8).padStart(3, '0')}, not owner-only`);
}

export function ensureSafeDir(path, label) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertSafeDir(path, label);
}

function tryLoad(base) {
  const req = createRequire(join(base, 'package.json'));
  let pkgPath;
  try {
    pkgPath = req.resolve('typescript/package.json');
  } catch {
    return null;
  }
  const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version;
  return { ts: req('typescript'), version, tscPath: join(dirname(pkgPath), 'bin', 'tsc') };
}

/** `typescript` from the repo, else from `<cacheDir>/tool`; throws code 3 `run: check-plan.mjs setup` when neither resolves. */
export function loadTypescript(repoRoot, cacheDir) {
  const fromRepo = tryLoad(repoRoot);
  if (fromRepo) return { ...fromRepo, source: 'repo' };
  const tool = join(cacheDir, 'tool');
  if (existsSync(join(tool, COMPLETE))) {
    const fromGate = tryLoad(tool);
    if (fromGate) return { ...fromGate, source: 'gate' };
  }
  throw fail('typescript not found in the repo or the gate install; run: check-plan.mjs setup');
}

async function npmInstall(toolDir) {
  writeFileSync(join(toolDir, 'package.json'), JSON.stringify({ name: 'skeleton-plan-tool', private: true }));
  await promisify(execFile)('npm', ['install', '--prefix', toolDir, '--save-exact', `typescript@${PINNED_TYPESCRIPT}`]);
}

/** Installs `typescript@PINNED_TYPESCRIPT` into `<cacheDir>/tool`; keeps a complete install, replaces a partial one. */
export async function setupTypescript(cacheDir, install = npmInstall) {
  const tool = join(cacheDir, 'tool');
  ensureSafeDir(cacheDir, 'cache directory');
  if (existsSync(join(tool, COMPLETE))) return { installed: false, toolDir: tool };
  rmSync(tool, { recursive: true, force: true });
  ensureSafeDir(tool, 'tool directory');
  await install(tool);
  writeFileSync(join(tool, COMPLETE), '');
  return { installed: true, toolDir: tool };
}

/** Default cache root: `~/.cache/skeleton-plan`. */
export const defaultCacheDir = () => join(homedir(), '.cache', 'skeleton-plan');

/** The `setup [--cache-dir D]` command: installs the pinned TypeScript, prints the result, returns the exit code. */
export async function setupCli(args) {
  const [cmd, ...rest] = args;
  const i = rest.indexOf('--cache-dir');
  const cacheDir = i >= 0 && rest[i + 1] ? resolve(rest[i + 1]) : defaultCacheDir();
  try {
    if (cmd !== 'setup') throw fail('usage: setup [--cache-dir D]');
    const r = await setupTypescript(cacheDir);
    console.log(r.installed ? `installed typescript@${PINNED_TYPESCRIPT} in ${r.toolDir}` : `already complete: ${r.toolDir}`);
    return 0;
  } catch (e) {
    console.error(e.message);
    return Number.isInteger(e.code) ? e.code : 3;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await setupCli(process.argv.slice(2));
}
