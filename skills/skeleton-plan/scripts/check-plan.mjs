import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkFormat, parsePlan, planHash } from './plan-format.mjs';
import { classify, startRun, writeReceipt } from './receipt.mjs';
import { coveredFiles, detectAdapter, makeSnapshot, runPrepare, runTypecheck } from './snapshot.mjs';
import { spliceSnapshot } from './splice.mjs';
import { defaultCacheDir, fail, loadTypescript, setupCli } from './tools.mjs';

const STATUS_PREFIX = /^(format|failed|blocked|not typechecked):/;
const USAGE = 'usage: check-plan.mjs --plan P --repo R [--cache-dir D] | check-plan.mjs setup [--cache-dir D]';

const underTest = () => Boolean(process.env.NODE_TEST_CONTEXT);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const diagnosticLines = (diagnostics) => diagnostics.map((d) => (d.file ? `${d.file}:${d.line}: ${d.message}` : d.message));

function fromError(error) {
  if (!Number.isInteger(error?.code)) return { code: 3, lines: [`blocked: ${error?.message ?? error}`] };
  const message = String(error.message);
  return { code: error.code, lines: [STATUS_PREFIX.test(message) ? message : `${error.code === 1 ? 'failed' : 'blocked'}: ${message}`] };
}

function resolveBase(repoRoot, base) {
  try {
    return execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', '--end-of-options', `${base}^{commit}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    throw fail(`blocked: base ${base} is not a commit`, 3);
  }
}

const generatedInputsAt = (repoRoot, sha) =>
  spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `${sha}:nuxt.config.ts`], { stdio: 'ignore' }).status === 0 ? ['generated'] : [];

function gate({ planPath, repoRoot, cacheDir, adapterOverride, plan, expected, runRoot }) {
  const commands = [];
  const timed = (step, command, run) => {
    const start = performance.now();
    const result = run();
    commands.push({ step, command, exitCode: result?.exitCode ?? 0, durationMs: Math.round(performance.now() - start) });
    return result;
  };
  const prepare = (dir, adapter) => adapter.prepare && timed('prepare', adapter.prepare, () => runPrepare(dir, adapter));

  const baseCommit = resolveBase(repoRoot, plan.base);
  const inputs = generatedInputsAt(repoRoot, baseCommit);
  const { dir, fingerprints } = makeSnapshot(repoRoot, baseCommit, inputs, runRoot);
  if (!existsSync(join(dir, 'tsconfig.json'))) return { code: 5, lines: ['not typechecked: no TypeScript'] };
  const tsInfo = loadTypescript(dir, cacheDir);
  const adapter = { ...detectAdapter(dir, tsInfo), ...(underTest() && adapterOverride) };

  prepare(dir, adapter);
  const baseline = timed('baseline typecheck', adapter.typecheck, () => runTypecheck(dir, adapter));
  if (baseline.spawnError || baseline.signal) return { code: 3, lines: ['blocked: typecheck could not run'] };
  if (baseline.exitCode !== 0 || baseline.diagnostics.length > 0) {
    return { code: 3, lines: ['blocked: baseline broken', ...diagnosticLines(baseline.diagnostics)] };
  }
  const splice = spliceSnapshot(tsInfo.ts, dir, plan.blocks);
  prepare(dir, adapter);
  const result = timed('typecheck', adapter.typecheck, () => runTypecheck(dir, adapter));
  const hook = process.env.SKELETON_PLAN_TEST_AFTER_TYPECHECK;
  if (underTest() && hook) spawnSync(process.execPath, [hook, planPath], { stdio: 'ignore' });
  const verdict = classify(result, plan, coveredFiles(dir, tsInfo.ts), splice);
  const details = [...diagnosticLines(result.diagnostics), ...verdict.ungated.map((path) => `ungated: ${path}`)];
  if (verdict.code !== 0 && verdict.code !== 4) return { code: verdict.code, lines: [`${verdict.status}: ${verdict.reason}`, ...details] };

  const receipt = {
    blockHashes: plan.blocks.map(({ code, ...meta }) => ({ id: meta.id, path: meta.path, hash: sha256(`${JSON.stringify(meta)}\0${code}`) })),
    baseCommit,
    generatedInputs: Object.fromEntries(inputs.filter((i) => fingerprints[i]).map((i) => [i, fingerprints[i]])),
    lockfileHash: fingerprints.lockfileHash ?? null,
    nodeVersion: process.version,
    typescript: { version: tsInfo.version, source: tsInfo.source },
    adapter: adapter.name,
    commands,
    status: verdict.status,
    ungated: verdict.ungated,
  };
  if (!writeReceipt(planPath, expected, receipt)) return { code: 1, lines: ['failed: plan changed during the run'] };
  return { code: verdict.code, lines: [verdict.code === 0 ? 'passed' : verdict.reason, ...details, `receipt: ${planPath}.receipt.json`] };
}

/**
 * The whole gate for one plan; writes only inside the run root and the receipt path. `adapterOverride` is read only under `node --test`.
 * @returns {Promise<{ code: 0|1|3|4|5, lines: string[] }>} the exit code and the output, status line first
 */
export async function runGate({ planPath, repoRoot, cacheDir = defaultCacheDir(), adapterOverride }) {
  planPath = resolve(planPath);
  let plan;
  let violations;
  try {
    plan = parsePlan(readFileSync(planPath, 'utf8'));
    violations = checkFormat(plan);
  } catch (e) {
    return e.code === undefined && /^format:/.test(e.message) ? { code: 1, lines: [e.message] } : fromError(e);
  }
  if (violations.length > 0) return { code: 1, lines: violations };
  const expected = planHash(plan);
  const runRoot = join(cacheDir, 'runs');
  let run;
  try {
    run = startRun(planPath, runRoot);
    return gate({ planPath, repoRoot: resolve(repoRoot), cacheDir, adapterOverride, plan, expected, runRoot });
  } catch (e) {
    return fromError(e);
  } finally {
    run?.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === 'setup') {
    process.exitCode = await setupCli(args);
  } else {
    const option = (name) => {
      const i = args.indexOf(name);
      return i >= 0 ? args[i + 1] : undefined;
    };
    const [planPath, repoRoot, cacheDir] = [option('--plan'), option('--repo'), option('--cache-dir')];
    const { code, lines } = planPath && repoRoot
      ? await runGate({ planPath, repoRoot, cacheDir: cacheDir ? resolve(cacheDir) : undefined })
      : { code: 3, lines: [`blocked: ${USAGE}`] };
    console.log(lines.join('\n'));
    process.exitCode = code;
  }
}
