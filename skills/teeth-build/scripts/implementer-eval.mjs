import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const RUN_TIMEOUT_MS = 300_000;
const BEGIN = 'BEGIN CASE REPORT';
const END = 'END CASE REPORT';

const bare = (line) => line.trim().replace(/^-\s*/, '');

/** The `case: <name>` sections inside the one BEGIN/END CASE REPORT block, in reply order, duplicates kept; null when there is not exactly one block. */
export function parseCaseReport(reply) {
  const lines = reply.split('\n');
  const begins = lines.flatMap((line, i) => (line.trim() === BEGIN ? [i] : []));
  const ends = lines.flatMap((line, i) => (line.trim() === END ? [i] : []));
  if (begins.length !== 1 || ends.length !== 1 || ends[0] < begins[0]) return null;
  const sections = [];
  for (const line of lines.slice(begins[0] + 1, ends[0])) {
    const header = bare(line).match(/^case:\s*(.*\S)\s*$/);
    if (header) sections.push({ name: header[1], lines: [] });
    else if (sections.length > 0) sections.at(-1).lines.push(line);
  }
  return sections;
}

/** Scores one reply: every case once, one non-empty `oracle:` each, none matching `forbid` (a pattern string, compiled here case-insensitively). */
export function scoreReply(reply, { cases, forbid }) {
  const sections = parseCaseReport(reply);
  if (sections === null) return { pass: false, misses: ['no case report block'] };
  const re = new RegExp(forbid, 'i');
  const misses = [];
  for (const name of cases) {
    const found = sections.filter((s) => s.name === name);
    if (found.length === 0) { misses.push(`${name}: missing case`); continue; }
    if (found.length > 1) { misses.push(`${name}: duplicate case`); continue; }
    const oracles = found[0].lines.map(bare).filter((line) => line.startsWith('oracle:')).map((line) => line.slice('oracle:'.length).trim());
    if (oracles.length > 1) misses.push(`${name}: ${oracles.length} oracle lines`);
    else if (oracles.length === 0 || oracles[0] === '') misses.push(`${name}: missing oracle`);
    else if (re.test(oracles[0])) misses.push(`${name}: oracle matches /${re.source}/: ${oracles[0]}`);
  }
  for (const name of new Set(sections.map((s) => s.name))) {
    if (!cases.includes(name)) misses.push(`${name}: unknown case`);
  }
  return { pass: misses.length === 0, misses };
}

function parse(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      packet: { type: 'string' },
      cases: { type: 'string' },
      'forbid-oracle': { type: 'string' },
      runs: { type: 'string', default: '3' },
      model: { type: 'string', default: 'claude-sonnet-5-5' },
      effort: { type: 'string', default: 'medium' },
      prompt: { type: 'string', default: fileURLToPath(new URL('../references/implementer.md', import.meta.url)) },
      'reply-file': { type: 'string' },
    },
  });
  if (!values.packet) throw new Error('--packet is required');
  if (!values.cases) throw new Error('--cases is required');
  if (!values['forbid-oracle']) throw new Error('--forbid-oracle is required');
  new RegExp(values['forbid-oracle'], 'i');
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  return { ...values, runs, cases: values.cases.split(',').map((c) => c.trim()).filter(Boolean), forbid: values['forbid-oracle'] };
}

function callClaude(opts, input) {
  const args = ['-p', '--model', opts.model, '--effort', opts.effort, '--no-session-persistence', '--tools', ''];
  const cwd = mkdtempSync(join(tmpdir(), 'implementer-eval-run-'));
  try {
    const r = spawnSync('claude', args, { input, cwd, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, killSignal: 'SIGKILL' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`claude exited ${r.status ?? r.signal}: ${r.stderr.trim()}`);
    return r.stdout;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** CLI entry; returns the exit code. */
export function main(argv) {
  let opts;
  let replies;
  let input;
  try {
    opts = parse(argv);
    if (opts['reply-file']) replies = [readFileSync(opts['reply-file'], 'utf8')];
    else input = `${readFileSync(opts.prompt, 'utf8')}\n\n${readFileSync(opts.packet, 'utf8')}`;
  } catch (e) {
    console.error(e.message);
    return 3;
  }
  const total = replies ? 1 : opts.runs;
  const lines = [];
  let passed = 0;
  for (let run = 1; run <= total; run++) {
    let reply;
    try {
      reply = replies ? replies[0] : callClaude(opts, input);
    } catch (e) {
      console.error(e.message);
      return 3;
    }
    const { pass, misses } = scoreReply(reply, opts);
    if (pass) passed++;
    for (const m of misses) lines.push(`run ${run}: ${m}`);
  }
  console.log(`${passed}/${total} oracle report`);
  for (const line of lines) console.log(line);
  return passed === total ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
