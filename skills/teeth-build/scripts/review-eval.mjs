import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const VERDICT = /^verdict: (clear|blocking finding)\s*$/;
const RUN_TIMEOUT_MS = 300_000;

export function parseVerdict(stdout) {
  const first = stdout.split('\n').find((line) => line.trim() !== '');
  return first?.match(VERDICT)?.[1] ?? null;
}

function parse(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      packet: { type: 'string' },
      expect: { type: 'string' },
      runs: { type: 'string', default: '3' },
      model: { type: 'string', default: 'claude-opus-5-5' },
      prompt: { type: 'string', default: fileURLToPath(new URL('../references/reviewer.md', import.meta.url)) },
    },
  });
  const opts = { ...values, runs: Number(values.runs) };
  if (!opts.packet) throw new Error('--packet is required');
  if (opts.expect !== 'clear' && opts.expect !== 'blocking finding') throw new Error('--expect must be "clear" or "blocking finding"');
  if (!Number.isInteger(opts.runs) || opts.runs < 1) throw new Error('--runs must be a positive integer');
  return opts;
}

function callClaude(model, input) {
  const args = ['-p', '--model', model, '--no-session-persistence', '--tools', ''];
  const r = spawnSync('claude', args, { input, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, killSignal: 'SIGKILL' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`claude exited ${r.status ?? r.signal}: ${r.stderr.trim()}`);
  return r.stdout;
}

export function main(argv) {
  let opts;
  let input;
  try {
    opts = parse(argv);
    input = `${readFileSync(opts.prompt, 'utf8')}\n\n${readFileSync(opts.packet, 'utf8')}`;
  } catch (e) {
    console.error(e.message);
    return 3;
  }
  const misses = [];
  for (let run = 1; run <= opts.runs; run++) {
    let got;
    try {
      got = parseVerdict(callClaude(opts.model, input));
    } catch (e) {
      console.error(e.message);
      return 3;
    }
    if (got !== opts.expect) misses.push(`run ${run}: got ${got ?? 'no verdict line'}`);
  }
  console.log(`${opts.runs - misses.length}/${opts.runs} verdict: ${opts.expect}`);
  for (const m of misses) console.log(m);
  return misses.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
