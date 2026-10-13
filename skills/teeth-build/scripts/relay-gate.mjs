import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { record, verify, restore } from './locked.mjs';
import { parseList, attribute } from '../../test-teeth/scripts/test-teeth.mjs';

const fail = (message, code = 3) => Object.assign(new Error(message), { code });

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

function requireSafeDirectory(path) {
  const unsafe = (reason) => fail(`unsafe state directory ${path}: ${reason}`);
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw unsafe('is a symlink');
  if (!st.isDirectory()) throw unsafe('is not a directory');
  if (typeof process.getuid !== 'function') throw unsafe('ownership cannot be checked on this platform (POSIX only)');
  if (st.uid !== process.getuid()) throw unsafe('is not owned by the current user');
  if ((st.mode & 0o077) !== 0) throw unsafe(`permissions are ${(st.mode & 0o777).toString(8).padStart(3, '0')}, not owner-only`);
}

export function stateDir(root, task) {
  const base = join(tmpdir(), 'teeth-build');
  const hashed = join(base, createHash('sha1').update(resolve(root)).digest('hex'));
  const dir = join(hashed, task);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const p of [base, hashed, dir]) requireSafeDirectory(p);
  return dir;
}

const realRun = (root) => (args, cwd = root) => {
  const r = spawnSync(join(root, 'node_modules', '.bin', 'vitest'), args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw fail(`vitest failed to start: ${r.error.message}`);
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', signal: r.signal };
};

const interrupted = (r) => r.signal === 'SIGINT' || r.signal === 'SIGTERM';
const USAGE = 'usage: relay-gate.mjs setup|baseline|red|locked|mutants --root R ...';

function git(root, ...a) {
  const r = spawnSync('git', ['--no-optional-locks', '-C', root, ...a], { encoding: 'utf8' });
  if (r.status !== 0) throw fail(`git ${a[0]} failed`);
  return r.stdout.trim();
}

function baseline(ctx) {
  const { root, feature, state, deps } = ctx;
  if (git(root, 'status', '--porcelain')) throw fail('working tree not clean');
  deps.vitestMajor(root);
  const base = git(root, 'rev-parse', 'HEAD');
  const list = deps.run(['list', feature, '--json', '--includeTaskLocation', '--no-cache'], root);
  if (interrupted(list)) return 130;
  if (list.status !== 0) return 2;
  const suite = deps.run(['run', feature, '--no-cache'], root);
  if (interrupted(suite)) return 130;
  if (suite.status !== 0) return 2;
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'baseline.json.tmp'), JSON.stringify({ base, list: JSON.parse(list.stdout) }));
  renameSync(join(state, 'baseline.json.tmp'), join(state, 'baseline.json'));
  return 0;
}

const keyed = (cases) => cases.map((c) => ({ ...c, key: `${c.spec}::${c.name}` }));
const REASONS = { passed: 'already passing', skipped: 'skipped', missing: 'not reported' };

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
  const res = deps.run(['run', feature, '--reporter=json', `--outputFile=${out}`, '--includeTaskLocation', '--no-color', '--no-cache'], root);
  if (interrupted(res)) return 130;
  if (!existsSync(out)) throw fail('vitest wrote no report');
  const { mutantState, byCase } = attribute(JSON.parse(readFileSync(out, 'utf8')), fresh, root);
  for (const c of fresh) {
    const { status, message } = byCase.get(c.id);
    if (status === 'killed') continue;
    const reason = status === 'runtime' ? `crashed (${message.split('\n')[0]})`
      : status === 'missing' && mutantState === 'invalid' ? 'import error' : REASONS[status];
    findings.push(`${c.spec} > ${c.name}: ${reason}`);
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

export async function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  try {
    const cmd = argv[0];
    if (!['baseline', 'red', 'locked'].includes(cmd)) {
      log(USAGE);
      return 3;
    }
    const rootArg = flag(argv, 'root');
    const root = rootArg && resolve(rootArg);
    const task = flag(argv, 'task');
    const feature = flag(argv, 'feature');
    if (!root || !task || !feature) throw fail('--root, --task and --feature are required');
    if (!/^[\w.-]+$/.test(task) || task === '.' || task === '..') throw fail('invalid --task');
    const d = {
      run: deps.run ?? realRun(root),
      stateDir: deps.stateDir ?? stateDir,
      vitestMajor: deps.vitestMajor ?? vitestMajor,
      log,
    };
    const ctx = { root, feature, state: d.stateDir(root, task), deps: d };
    return { baseline, red, locked }[cmd](ctx, argv);
  } catch (e) {
    log(e.message);
    return [2, 3, 130].includes(e.code) ? e.code : 3;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
