import { chmodSync, closeSync, existsSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertSafeDir, ensureSafeDir, fail } from './safe-dir.mjs';

const VERSION = '10.0.0';
const PKGS = ['@stryker-mutator/core', '@stryker-mutator/vitest-runner'];
const outside = (rel) => rel === '..' || rel.startsWith(`..${sep}`);

function acquire(lock) {
  try {
    const fd = openSync(lock, 'wx');
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    return false;
  }
}

export async function withRepoLock(cacheRoot, fn) {
  ensureSafeDir(cacheRoot, 'cache directory');
  const lock = join(cacheRoot, 'lock');
  if (!acquire(lock)) {
    const pid = Number(readFileSync(lock, 'utf8'));
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    if (alive) throw fail(`another mutants run on this repo (pid ${pid})`);
    rmSync(lock, { force: true });
    if (!acquire(lock)) throw fail('another mutants run on this repo');
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

export function syncWork(root, workDir) {
  const r0 = resolve(root);
  const w0 = resolve(workDir);
  if (!outside(relative(r0, w0)) || !outside(relative(w0, r0))) throw fail('work directory overlaps the repo');
  ensureSafeDir(workDir, 'work directory');
  rmSync(join(workDir, 'reports'), { recursive: true, force: true });
  rmSync(join(workDir, '.stryker-tmp'), { recursive: true, force: true });
  let r;
  try {
    r = spawnSync('rsync', ['-a', '--delete', '--exclude=.git', '--exclude=node_modules', '--exclude=.env*', '--exclude=/.output', '--exclude=/.stryker-tmp', '--exclude=/reports', `${root}/`, `${workDir}/`]);
  } finally {
    chmodSync(workDir, 0o700);
  }
  if (r.error || r.status !== 0) throw fail(`rsync failed${r.error ? `: ${r.error.message}` : ` (${r.status})`}`);
  assertSafeDir(workDir, 'work directory');
  const nm = join(workDir, 'node_modules');
  rmSync(nm, { recursive: true, force: true });
  symlinkSync(join(root, 'node_modules'), nm);
}

export function toolReady(toolDir) {
  const ok = PKGS.every((p) => {
    try { return JSON.parse(readFileSync(join(toolDir, 'node_modules', p, 'package.json'), 'utf8')).version === VERSION; } catch { return false; }
  });
  return ok && existsSync(join(toolDir, 'node_modules', '.bin', 'stryker'));
}

export function setupTool(toolDir) {
  ensureSafeDir(dirname(toolDir), 'cache directory');
  ensureSafeDir(toolDir, 'tool directory');
  if (toolReady(toolDir)) return 0;
  rmSync(toolDir, { recursive: true, force: true });
  ensureSafeDir(toolDir, 'tool directory');
  const npm = (...args) => spawnSync('npm', args, { cwd: toolDir, stdio: 'inherit' });
  npm('init', '-y');
  npm('i', '--no-audit', '--no-fund', '--legacy-peer-deps', ...PKGS.map((p) => `${p}@${VERSION}`));
  return toolReady(toolDir) ? 0 : 3;
}

export function linkTool(toolDir, root) {
  for (const name of ['vitest', 'typescript']) {
    const dest = join(toolDir, 'node_modules', name);
    rmSync(dest, { recursive: true, force: true });
    symlinkSync(join(root, 'node_modules', name), dest);
  }
}

export function writeConfig(workDir, mutate, { hasVitestConfig }) {
  const config = {
    testRunner: 'vitest',
    vitest: { related: true, ...(hasVitestConfig ? { configFile: 'vitest.config.ts' } : {}) },
    mutate,
    coverageAnalysis: 'perTest',
    disableBail: true,
    ignorePatterns: ['!.nuxt'],
    reporters: ['json'],
    jsonReporter: { fileName: 'reports/mutation.json' },
    tempDirName: '.stryker-tmp',
    cleanTempDir: true,
  };
  writeFileSync(join(workDir, 'stryker.config.json'), JSON.stringify(config, null, 2));
}

export function runStryker(toolDir, workDir) {
  const file = join(workDir, 'reports', 'mutation.json');
  rmSync(file, { force: true });
  const r = spawnSync(join(toolDir, 'node_modules', '.bin', 'stryker'), ['run', 'stryker.config.json'], { cwd: workDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw fail(`stryker failed to start: ${r.error.message}`);
  let report = null;
  if (existsSync(file)) {
    try { report = JSON.parse(readFileSync(file, 'utf8')); } catch { throw fail('unreadable Stryker report'); }
  }
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  const firstError = out.split('\n').find((l) => l.includes(' ERROR ')) ?? null;
  const inst = out.match(/Instrumented \d+ source file\(s\) with (\d+) mutant\(s\)/);
  const found = out.match(/Found (\d+) of \d+ file\(s\) to be mutated/);
  return { status: r.status, signal: r.signal, report, firstError, matched: found ? Number(found[1]) : null, instrumented: inst ? Number(inst[1]) : null, noTests: out.includes('No tests were found') };
}
