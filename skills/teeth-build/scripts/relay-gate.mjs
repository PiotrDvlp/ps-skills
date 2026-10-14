import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureSafeDir, assertSafeDir, fail } from './safe-dir.mjs';
import { record, verify, restore } from './locked.mjs';
import { classifyMutants } from './classify.mjs';
import { loadVueParsers, vueRanges } from './vue-ranges.mjs';
import { changedLines, gitOk } from './git-changes.mjs';
import { withRepoLock, syncWork, toolReady, setupTool, linkTool, writeConfig, runStryker } from './stryker.mjs';
import { parseList, reporterName, caseId } from '../../test-teeth/scripts/test-teeth.mjs';

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || String(v).startsWith('--')) throw fail(`--${name} needs a value`);
  return v;
}

export function vitestMajor(root) {
  const p = join(root, 'node_modules', 'vitest', 'package.json');
  if (!existsSync(p)) throw fail(`vitest not found in ${root}/node_modules`);
  const { version } = JSON.parse(readFileSync(p, 'utf8'));
  if (version.split('.')[0] !== '3') throw fail(`vitest ${version} not verified`);
  return 3;
}

export function stateDir({ cacheRoot, hashDir }, task) {
  ensureSafeDir(cacheRoot, 'cache directory');
  ensureSafeDir(hashDir, 'cache directory');
  const dir = join(hashDir, 'state', task);
  ensureSafeDir(dir);
  assertSafeDir(join(hashDir, 'state'));
  return dir;
}

const realRun = (root) => (args, cwd = root) => {
  const r = spawnSync(join(root, 'node_modules', '.bin', 'vitest'), args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, CI: '1' } });
  if (r.error) throw fail(`vitest failed to start: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', signal: r.signal };
};

const interrupted = (r) => r.signal === 'SIGINT' || r.signal === 'SIGTERM';
const USAGE = 'usage: relay-gate.mjs setup|baseline|red|locked|mutants --root R ...';

const git = (root, ...a) => gitOk(root, a).trim();

function baseline(ctx) {
  const { root, feature, state, deps } = ctx;
  if (git(root, 'status', '--porcelain')) throw fail('working tree not clean');
  deps.vitestMajor(root);
  const base = git(root, 'rev-parse', 'HEAD');
  const list = deps.run(['list', feature, '--json', '--includeTaskLocation', '--no-cache'], root);
  if (interrupted(list)) return 130;
  if (list.status !== 0) return 2;
  const suite = deps.run(['run', feature, '--no-cache', '--passWithNoTests'], root);
  if (interrupted(suite)) return 130;
  if (suite.status !== 0) return 2;
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'baseline.json.tmp'), JSON.stringify({ base, list: JSON.parse(list.stdout) }));
  renameSync(join(state, 'baseline.json.tmp'), join(state, 'baseline.json'));
  return 0;
}

const keyed = (cases) => cases.map((c) => ({ ...c, key: `${c.spec}::${c.name}` }));

function red(ctx) {
  const { root, feature, state, deps } = ctx;
  deps.vitestMajor(root);
  const basePath = join(state, 'baseline.json');
  if (!existsSync(basePath)) throw fail('no baseline; run baseline');
  const before = new Set(keyed(parseList(JSON.parse(readFileSync(basePath, 'utf8')).list, root)).map((c) => c.key));
  const findings = [];
  const run = deps.run(['list', feature, '--json', '--includeTaskLocation', '--no-cache'], root);
  if (interrupted(run)) return 130;
  if (run.status !== 0) return 2;
  const now = keyed(parseList(JSON.parse(run.stdout), root));
  const seen = new Set();
  for (const c of now) {
    if (seen.has(c.key)) findings.push(`${c.spec} > ${c.name}: duplicate identity`);
    seen.add(c.key);
  }
  const fresh = now.filter((c) => !before.has(c.key));
  if (!fresh.length) {
    deps.log('no new tests');
    return 1;
  }
  const out = join(state, 'red.json');
  rmSync(out, { force: true });
  const res = deps.run(['run', feature, '--reporter=json', `--outputFile=${out}`, '--includeTaskLocation', '--no-color', '--no-cache'], root);
  if (interrupted(res)) return 130;
  if (!existsSync(out)) throw fail('vitest wrote no report');
  const report = JSON.parse(readFileSync(out, 'utf8'));
  const specOf = (f) => relative(root, f.name).split(sep).join('/');
  const broken = new Set(report.testResults.filter((f) => f.status === 'failed' && !f.assertionResults?.length).map(specOf));
  const results = new Map();
  for (const f of report.testResults) {
    for (const a of f.assertionResults ?? []) results.set(caseId(specOf(f), reporterName(a), a.location?.line ?? 0), a);
  }
  for (const c of fresh) {
    const a = results.get(c.id);
    const message = a?.failureMessages?.[0] ?? '';
    let reason = null;
    if (!a) reason = broken.has(c.spec) ? 'import error' : 'not reported';
    else if (a.status === 'passed') reason = 'already passing';
    else if (['skipped', 'pending', 'todo'].includes(a.status)) reason = 'skipped';
    else if (a.status !== 'failed' || !message.startsWith('AssertionError:')) reason = `crashed (${message.split('\n')[0]})`;
    if (reason) findings.push(`${c.spec} > ${c.name}: ${reason}`);
  }
  for (const f of findings) deps.log(f);
  return findings.length ? 1 : 0;
}

function locked(ctx, argv) {
  const featureAbs = resolve(ctx.root, ctx.feature);
  const dir = join(ctx.state, 'locked');
  if (argv.includes('--record')) {
    mkdirSync(dir, { recursive: true });
    record(featureAbs, dir);
    return 0;
  }
  const result = argv.includes('--restore') ? restore(featureAbs, dir) : argv.includes('--verify') ? verify(featureAbs, dir) : null;
  if (!result) throw fail(USAGE);
  const lines = ['modified', 'deleted', 'added'].flatMap((k) => result[k].map((p) => `${k}: ${p}`));
  for (const l of lines) ctx.deps.log(l);
  return lines.length ? 1 : 0;
}

function cachePaths(root, argv) {
  const cacheRoot = resolve(flag(argv, 'cache-dir') ?? join(homedir(), '.cache', 'teeth-build'));
  const hashDir = join(cacheRoot, createHash('sha1').update(root).digest('hex'));
  return { cacheRoot, hashDir, toolDir: join(hashDir, 'tool'), workDir: join(hashDir, 'work') };
}

function setup(root, argv) {
  const { cacheRoot, hashDir, toolDir } = cachePaths(root, argv);
  ensureSafeDir(cacheRoot, 'cache directory');
  ensureSafeDir(hashDir, 'cache directory');
  return setupTool(toolDir);
}

const GLOB = /[*?[\]]|[?*+@!]\(|\{[^}]*(,|\.\.)/;
export const isGlob = (f) => GLOB.test(f);

const matchedMessage = (n, m) => `Stryker matched ${n == null ? 'an unknown number of' : `${n} of`} ${m} changed files`;

export function tsRanges(source, lines) {
  const fileLines = source.split('\n');
  const mutable = lines.filter((l) => fileLines[l - 1]?.trim());
  const mutate = [];
  for (const l of lines) {
    const last = mutate.at(-1);
    if (last && last.end === l - 1) last.end = l; else mutate.push({ start: l, end: l });
  }
  return { mutate: mutate.filter((m) => mutable.some((l) => l >= m.start && l <= m.end)), mutable };
}

function mutateEntries(root, changed) {
  const mutate = [];
  const mutable = new Map();
  const notCovered = [];
  let parsers = null;
  for (const [file, lines] of changed) {
    if (isGlob(file)) {
      for (const l of lines) notCovered.push(`${file}:${l} glob characters in path`);
      continue;
    }
    if (!/\.(ts|vue)$/.test(file)) {
      for (const l of lines) notCovered.push(`${file}:${l} unsupported extension`);
      continue;
    }
    const source = readFileSync(join(root, file), 'utf8');
    if (file.endsWith('.vue')) {
      parsers ??= loadVueParsers(root);
      const r = vueRanges(source, lines, parsers);
      for (const m of r.mutate) mutate.push(`${file}:${m.start}-${m.end}`);
      if (r.mutable.length) mutable.set(file, r.mutable);
      for (const n of r.notCovered) notCovered.push(`${file}:${n.line} ${n.reason}`);
      continue;
    }
    const r = tsRanges(source, lines);
    if (!r.mutable.length) continue;
    mutable.set(file, r.mutable);
    for (const m of r.mutate) mutate.push(`${file}:${m.start}-${m.end}`);
  }
  return { mutate, mutable, notCovered };
}

async function mutants(ctx, argv) {
  const { root, state, deps } = ctx;
  const { hashDir, toolDir, workDir } = ctx.paths;
  const top = git(root, 'rev-parse', '--show-toplevel');
  if (realpathSync(top) !== realpathSync(root)) throw fail('root must be the git top-level');
  const base = flag(argv, 'base') ?? (existsSync(join(state, 'baseline.json')) ? JSON.parse(readFileSync(join(state, 'baseline.json'), 'utf8')).base : null);
  if (!base) throw fail('no baseline; run baseline or pass --base');
  deps.vitestMajor(root);
  const changed = changedLines(root, base, ctx.feature);
  const { mutate, mutable, notCovered } = mutateEntries(root, changed);
  for (const n of notCovered) deps.log(`not covered: ${n}`);
  if (!mutable.size) {
    deps.log('no changed mutable lines');
    return 0;
  }
  if (!deps.toolReady(toolDir)) throw fail(`run: relay-gate.mjs setup --root ${root}`);
  const tsconfig = join(root, 'tsconfig.json');
  if (existsSync(tsconfig) && /"extends"\s*:\s*"\.\/\.nuxt\//.test(readFileSync(tsconfig, 'utf8')) && !existsSync(join(root, '.nuxt'))) throw fail('run npx nuxi prepare');
  return withRepoLock(hashDir, () => {
    deps.syncWork(root, workDir);
    deps.linkTool(toolDir, root);
    writeConfig(workDir, mutate, { hasVitestConfig: existsSync(join(root, 'vitest.config.ts')) });
    const res = deps.runStryker(toolDir, workDir);
    const row = (r) => `${r.file}:${r.line} ${r.mutator} → ${r.replacement} (${r.reason})`;
    if (res.signal) {
      if (res.signal === 'SIGINT' || res.signal === 'SIGTERM') return 130;
      throw fail(`stryker killed by ${res.signal}`, 2);
    }
    if (!res.report && res.noTests && res.instrumented !== 0) {
      const rows = [...mutable].flatMap(([file, lines]) => lines.map((line) => ({ file, line, mutator: 'NoCoverage', replacement: 'no test reaches this file', reason: 'NoCoverage' })));
      for (const r of rows) deps.log(row(r));
      deps.log(`${rows.length} findings, 0 passed, 0 timed out, 0 invalid, ${notCovered.length} not covered`);
      return 1;
    }
    if (!res.report && res.noTests && res.instrumented === 0) {
      if (!(res.matched >= mutable.size)) throw fail(matchedMessage(res.matched, mutable.size));
      const n = [...mutable.values()].reduce((a, l) => a + l.length, 0) + notCovered.length;
      for (const [file, lines] of mutable) for (const line of lines) deps.log(`not covered: ${file}:${line} no mutant inside the changed lines`);
      deps.log(`0 findings, 0 passed, 0 timed out, 0 invalid, ${n} not covered`);
      return 0;
    }
    if (!res.report) {
      deps.log(res.firstError ?? 'Stryker wrote no report');
      return 2;
    }
    if (!(res.matched >= mutable.size)) throw fail(matchedMessage(res.matched, mutable.size));
    const c = classifyMutants(res.report, mutable);
    for (const r of c.findings) deps.log(row(r));
    for (const r of c.notCovered) deps.log(`not covered: ${r.file}:${r.line} ${r.reason}`);
    for (const r of c.timedOut) deps.log(`timed out: ${r.file}:${r.line} ${r.mutator}`);
    for (const r of c.invalid) deps.log(`invalid: ${r.file}:${r.line} ${r.mutator}`);
    deps.log(`${c.findings.length} findings, ${c.passed.length} passed, ${c.timedOut.length} timed out, ${c.invalid.length} invalid, ${notCovered.length + c.notCovered.length} not covered`);
    return c.findings.length ? 1 : 0;
  });
}

export async function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  try {
    const cmd = argv[0];
    if (!['setup', 'baseline', 'red', 'locked', 'mutants'].includes(cmd)) {
      log(USAGE);
      return 3;
    }
    const rootArg = flag(argv, 'root');
    const root = rootArg && resolve(rootArg);
    if (cmd === 'setup') {
      if (!root) throw fail('--root is required');
      return setup(root, argv);
    }
    const task = flag(argv, 'task');
    const feature = flag(argv, 'feature');
    if (!root || !task || !feature) throw fail('--root, --task and --feature are required');
    const outside = (base, p) => {
      const r = relative(base, p);
      return r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r);
    };
    const featureAbs = resolve(root, feature);
    if (outside(root, featureAbs) || (existsSync(featureAbs) && outside(realpathSync(root), realpathSync(featureAbs)))) throw fail('--feature must be inside --root');
    if (!/^[\w.-]+$/.test(task) || task === '.' || task === '..') throw fail('invalid --task');
    const d = {
      run: deps.run ?? realRun(root),
      stateDir: deps.stateDir ?? stateDir,
      vitestMajor: deps.vitestMajor ?? vitestMajor,
      runStryker: deps.runStryker ?? runStryker,
      toolReady: deps.toolReady ?? toolReady,
      syncWork: deps.syncWork ?? syncWork,
      linkTool: deps.linkTool ?? linkTool,
      log,
    };
    const paths = cachePaths(root, argv);
    const ctx = { root, feature, paths, state: d.stateDir(paths, task), deps: d };
    return await { baseline, red, locked, mutants }[cmd](ctx, argv);
  } catch (e) {
    log(e.message);
    return [2, 3, 130].includes(e.code) ? e.code : 3;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
