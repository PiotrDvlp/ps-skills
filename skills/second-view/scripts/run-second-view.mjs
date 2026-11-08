#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  closeSync, copyFileSync, existsSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { argv as procArgv } from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildPrompt } from './build-prompt.mjs';
import { assertSafeArgs, assertCodexSandboxUsable, buildCodexArgs, DEFAULT_MODEL } from './codex-args.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUBRIC = join(HERE, '..', 'references', 'rubric-proposal.md');

const TIMEOUT_MS = 900_000;
const ANSI_CSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const FALLBACK_LINE = /^(?:\d{4}-\d\d-\d\dT\S+\s+)?(?:(?:warning|WARN)\b:?\s+(?:[\w:]+:\s+)?)?Model metadata for \S+ not found/im;
let activeChild = null;
const HEADINGS = ['## Approach', '## Design', '## Tradeoffs', '## Risks', '## Open questions'];

const USAGE = 'Usage: node run-second-view.mjs --brief FILE [--model M] [--deep] [--repo DIR] [--keep-prompt PATH]';

class RunError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function parseArgs(argv) {
  const out = { deep: false };
  const valued = { '--brief': 'brief', '--model': 'model', '--repo': 'repo', '--keep-prompt': 'keepPrompt' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--deep') { out.deep = true; continue; }
    const key = valued[a];
    if (!key) {
      try { assertSafeArgs([a]); } catch (e) { throw new RunError('usage', e.message); }
      throw new RunError('usage', `unknown argument ${a}\n${USAGE}`);
    }
    const v = argv[++i];
    if (v === undefined || v.startsWith('--')) throw new RunError('usage', `${a} needs a value`);
    if (out[key] !== undefined) throw new RunError('usage', `${a} given twice`);
    out[key] = v;
  }
  if (!out.brief) throw new RunError('usage', `--brief is required\n${USAGE}`);
  return out;
}

/** The model Codex reports in its session header; same rules as codex-review's `resolveModelFromOutput`. */
export function resolveReportedModel(rawStdout, rawStderr) {
  const stdout = (rawStdout || '').replace(ANSI_CSI, '');
  const stderr = (rawStderr || '').replace(ANSI_CSI, '');
  if (FALLBACK_LINE.test(stderr)) {
    throw new RunError('model_fallback', 'Codex reported an unknown-model fallback; the run used a different model');
  }
  for (const stream of [stderr, stdout]) {
    const header = stream.match(/^model:\s*(\S+)\s*$/m);
    if (header) return header[1];
  }
  throw new RunError('model_unresolved', 'Codex printed no `model:` session header');
}

export function missingHeadings(text) {
  const lines = new Set(String(text).split('\n').map((l) => l.trim()));
  return HEADINGS.filter((h) => !lines.has(h));
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
      reject(new RunError('timeout', `codex did not finish within ${timeoutMs} ms`));
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new RunError('codex_spawn_failed', `cannot start codex: ${e.message}`));
    });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  }).finally(() => { activeChild = null; closeSync(fd); });
}

export async function runSecondView(args, { timeoutMs = TIMEOUT_MS } = {}) {
  try { assertCodexSandboxUsable(); } catch (e) { throw new RunError('nested_sandbox', e.message); }
  const model = args.model ?? DEFAULT_MODEL;
  try { buildCodexArgs({ model, outFile: '-' }); } catch (e) { throw new RunError('model_not_allowed', e.message); }
  if (!existsSync(args.brief)) throw new RunError('no_brief', `${args.brief} does not exist`);

  const dir = mkdtempSync(join(tmpdir(), 'second-view-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  const onSignal = () => { activeChild?.kill('SIGTERM'); cleanup(); process.exit(130); };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    const promptPath = join(dir, 'prompt.md');
    let prompt;
    try {
      prompt = buildPrompt({ rubric: readFileSync(RUBRIC, 'utf8'), brief: readFileSync(args.brief, 'utf8') });
    } catch (e) {
      throw new RunError('bad_brief', e.message);
    }
    writeFileSync(promptPath, prompt);
    if (args.keepPrompt) copyFileSync(promptPath, args.keepPrompt);
    const outFile = join(dir, 'proposal.md');
    const argv = buildCodexArgs({ model, outFile, repoRoot: args.repo, deep: args.deep });

    const started = Date.now();
    const { code, stdout, stderr } = await spawnCodex(argv, promptPath, timeoutMs);
    const durationMs = Date.now() - started;
    if (code !== 0) throw new RunError('codex_failed', `codex exited ${code}\n${stderr.slice(-4000)}`);
    const reported = resolveReportedModel(stdout, stderr);
    if (reported !== model) throw new RunError('model_mismatch', `requested ${model} but Codex reported ${reported}`);

    const proposal = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
    if (!proposal.trim()) throw new RunError('empty_output', `codex produced no final message\n${stdout.slice(-4000)}`);
    const missing = missingHeadings(proposal);
    if (missing.length) {
      throw new RunError('missing_heading', `missing ${missing.join(', ')}; raw output:\n${proposal.slice(0, 4000)}`);
    }
    return {
      ok: true,
      model,
      reasoning_effort: args.deep ? 'xhigh' : 'medium',
      sandbox: 'read-only',
      duration_ms: durationMs,
      proposal,
    };
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    cleanup();
  }
}

function isMain() {
  try {
    return procArgv[1] && realpathSync(procArgv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMain()) {
  try {
    const args = parseArgs(procArgv.slice(2));
    const timeoutMs = Number(process.env.SV_TIMEOUT_MS) || TIMEOUT_MS;
    process.stdout.write(`${JSON.stringify(await runSecondView(args, { timeoutMs }))}\n`);
  } catch (err) {
    console.error(`[${err.code ?? 'error'}] ${err.message}`);
    process.exit(err.code === 'usage' ? 2 : 1);
  }
}
