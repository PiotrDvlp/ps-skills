#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  closeSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { argv as procArgv } from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  ReviewError, validateModel, resolveModelFromOutput, assertCodexSandboxUsable,
  DEFAULT_MODEL, HARD_REFUSE_BYTES,
} from './code-review-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUBRICS = {
  design: join(HERE, '..', 'references', 'rubric-design.md'),
  plan: join(HERE, '..', 'references', 'rubric-plan.md'),
};
const TIMEOUT_MS = 900_000;
let activeChild = null;

export const MODES = ['design', 'plan', 'duel'];

const HEADINGS = {
  design: ['## Verdict', '## Issues'],
  plan: ['## Verdict', '## Issues'],
  duel: ['## Approach', '## Design', '## Tradeoffs', '## Risks', '## Open questions'],
};

export function effortFor(mode, deep) {
  if (mode === 'duel') {
    if (deep) {
      throw new ReviewError('deep_in_duel',
        '--deep is rejected in duel mode: it would raise effort on the Codex track only');
    }
    return 'model-default';
  }
  return deep ? 'xhigh' : 'medium';
}

export function buildExecArgv({ mode, model, deep = false, repoRoot, outFile }) {
  if (!MODES.includes(mode)) throw new ReviewError('usage', `unknown mode ${mode}`);
  if (!outFile) throw new ReviewError('usage', 'outFile is required');
  validateModel(model);
  const effort = effortFor(mode, deep);
  const argv = ['exec', '-m', model];
  if (effort !== 'model-default') argv.push('-c', `model_reasoning_effort="${effort}"`);
  argv.push('-s', 'read-only', '--ignore-user-config', '--skip-git-repo-check');
  if (repoRoot) argv.push('-C', repoRoot);
  argv.push('-o', outFile, '-');
  return argv;
}

export function buildExecPrompt({ rubric, target }) {
  if (typeof rubric !== 'string' || typeof target !== 'string') {
    throw new ReviewError('usage', 'rubric and target must both be strings');
  }
  if (Buffer.byteLength(target) >= HARD_REFUSE_BYTES) {
    throw new ReviewError('too_large', `target is ${Buffer.byteLength(target)} bytes; the limit is ${HARD_REFUSE_BYTES}`);
  }
  return `${rubric}\n\n${target}`;
}

export function missingHeadings(mode, text) {
  const lines = new Set(String(text).split('\n').map((l) => l.trim()));
  return HEADINGS[mode].filter((h) => !lines.has(h));
}

function isMain() {
  try {
    return procArgv[1] && realpathSync(procArgv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

const USAGE = `Usage:
  node run-exec.mjs --mode design|plan --target FILE [--model M] [--deep] [--repo DIR] [--keep]
  node run-exec.mjs --mode duel --prompt-file FILE [--model M] [--repo DIR] [--keep]`;

export function parseArgs(argv) {
  const out = { deep: false, keep: false };
  const valued = { '--mode': 'mode', '--target': 'target', '--prompt-file': 'promptFile', '--model': 'model', '--repo': 'repo' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.toLowerCase().includes('--sandbox')) throw new ReviewError('usage', `${a}: Codex always runs -s read-only`);
    if (a === '--deep') { out.deep = true; continue; }
    if (a === '--keep') { out.keep = true; continue; }
    const key = valued[a];
    if (!key) throw new ReviewError('usage', `unknown argument ${a}\n${USAGE}`);
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new ReviewError('usage', `${a} needs a value`);
    if (out[key] !== undefined) throw new ReviewError('usage', `${a} given twice`);
    out[key] = v;
  }
  if (!MODES.includes(out.mode)) throw new ReviewError('usage', `--mode must be one of ${MODES.join(', ')}\n${USAGE}`);
  if (out.mode === 'duel' ? (!out.promptFile || out.target) : (!out.target || out.promptFile)) {
    throw new ReviewError('usage', `${out.mode} mode takes ${out.mode === 'duel' ? '--prompt-file' : '--target'} only\n${USAGE}`);
  }
  return out;
}

function spawnCodex(argv, promptPath, timeoutMs) {
  const fd = openSync(promptPath, 'r');
  const child = spawn('codex', argv, { stdio: [fd, 'pipe', 'pipe'] });
  activeChild = child;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ReviewError('timeout', `codex did not finish within ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new ReviewError('codex_spawn_failed', `cannot start codex: ${e.message}`));
    });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  }).finally(() => { activeChild = null; closeSync(fd); });
}

export async function runExec(args, { timeoutMs = TIMEOUT_MS } = {}) {
  assertCodexSandboxUsable();
  const model = validateModel(args.model ?? DEFAULT_MODEL);
  const effort = effortFor(args.mode, args.deep);
  const source = args.mode === 'duel' ? args.promptFile : args.target;
  if (!existsSync(source)) throw new ReviewError('no_target', `${source} does not exist`);

  const dir = mkdtempSync(join(tmpdir(), 'cxr-exec-'));
  const cleanup = () => { if (!args.keep) rmSync(dir, { recursive: true, force: true }); };
  const onSignal = () => { activeChild?.kill('SIGTERM'); cleanup(); process.exit(130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    let promptPath = source;
    if (args.mode === 'duel') {
      if (readFileSync(source).length >= HARD_REFUSE_BYTES) throw new ReviewError('too_large', `${source} is too large`);
    } else {
      promptPath = join(dir, 'prompt.md');
      writeFileSync(promptPath, buildExecPrompt({
        rubric: readFileSync(RUBRICS[args.mode], 'utf8'),
        target: readFileSync(source, 'utf8'),
      }));
    }
    const outFile = join(dir, 'final.md');
    const argv = buildExecArgv({ mode: args.mode, model, deep: args.deep, repoRoot: args.repo, outFile });

    const started = Date.now();
    const { code, stdout, stderr } = await spawnCodex(argv, promptPath, timeoutMs);
    const durationMs = Date.now() - started;
    if (args.keep) {
      writeFileSync(join(dir, 'codex.stdout.log'), stdout);
      writeFileSync(join(dir, 'codex.stderr.log'), stderr);
    }
    if (code !== 0) throw new ReviewError('codex_failed', `codex exited ${code}\n${stderr.slice(-4000)}`);

    const resolved = resolveModelFromOutput(stdout, stderr);
    if (resolved !== model) throw new ReviewError('model_mismatch', `requested ${model} but Codex reported ${resolved}`);

    const body = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
    if (!body.trim()) throw new ReviewError('empty_output', `codex produced no final message\n${stdout.slice(-4000)}`);
    const missing = missingHeadings(args.mode, body);
    if (missing.length) {
      throw new ReviewError('missing_heading', `missing ${missing.join(', ')}; raw output:\n${body.slice(0, 4000)}`);
    }
    return {
      ok: true,
      mode: args.mode,
      model,
      reasoning_effort: effort,
      sandbox: 'read-only',
      repo_read: 'ok',
      duration_ms: durationMs,
      ...(args.keep ? { artifacts_dir: dir } : {}),
      body,
    };
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    cleanup();
  }
}

if (isMain()) {
  try {
    const args = parseArgs(procArgv.slice(2));
    const timeoutMs = Number(process.env.CXR_EXEC_TIMEOUT_MS) || TIMEOUT_MS;
    process.stdout.write(`${JSON.stringify(await runExec(args, { timeoutMs }))}\n`);
  } catch (err) {
    console.error(`[${err.code ?? 'error'}] ${err.message}`);
    process.exit(err.code === 'usage' ? 2 : 1);
  }
}
