import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const VERDICT = /^verdict: (clear|blocking finding)\s*$/;
const RUN_TIMEOUT_MS = 300_000;

export function parseVerdict(stdout) {
  const lines = stdout.split('\n').filter((line) => line.trim() !== '');
  const verdict = lines[0]?.match(VERDICT)?.[1];
  const at = lines.findIndex((line) => line.trim() === 'finding:');
  if (!verdict || at === -1) return null;
  const end = lines.findIndex((line, i) => i > at && !line.trim().startsWith('-'));
  const items = lines.slice(at + 1, end === -1 ? lines.length : end).map((line) => line.trim().replace(/^-\s*/, ''));
  const nones = items.filter((item) => item === 'none').length;
  if (items.length === 0 || (nones > 0 && items.length > 1)) return null;
  return (nones === 1) === (verdict === 'clear') ? verdict : null;
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
    if (got !== opts.expect) misses.push(`run ${run}: got ${got ?? 'no consistent verdict'}`);
  }
  console.log(`${opts.runs - misses.length}/${opts.runs} verdict: ${opts.expect}`);
  for (const m of misses) console.log(m);
  return misses.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
