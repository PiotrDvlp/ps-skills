#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HELP = `Compares two pushed twin branches by stable patch-id (Node 22+, git).
Usage: node twin-parity.mjs --repo <dir> --branch <home> --twin <sibling>
         [--home-base origin/main] [--twin-base origin/develop]
Compares origin/main..origin/<home> with origin/develop..origin/<sibling>; local branches are never read.
Exit 0: parity ok. 1: parity mismatch (home-only / twin-only lines follow). 2: a ref is missing or git failed.
`;

function git(repo, args, input) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', input, timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.error || r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.error?.message || r.stderr.trim() || `exit ${r.status}`}`);
  return r.stdout;
}

export function patchIds(repo, range) {
  const subjects = new Map(git(repo, ['log', '--reverse', '--format=%H%x09%s', range, '--'], undefined)
    .split('\n').filter(Boolean).map((line) => {
      const [sha, ...subject] = line.split('\t');
      return [sha, subject.join('\t')];
    }));
  const log = git(repo, ['log', '-p', '--reverse', range, '--']);
  return git(repo, ['patch-id', '--stable'], log).split('\n').filter(Boolean).map((line) => {
    const [id, sha] = line.split(' ');
    return { id, sha, subject: subjects.get(sha) ?? '' };
  });
}

export function compareParity(home, twin) {
  const unused = [...twin];
  const homeOnly = [];
  for (const patch of home) {
    const at = unused.findIndex((candidate) => candidate.id === patch.id);
    if (at === -1) homeOnly.push(patch);
    else unused.splice(at, 1);
  }
  return { ok: !homeOnly.length && !unused.length, homeOnly, twinOnly: unused };
}

function main() {
  const { values: v } = parseArgs({ options: {
    repo: { type: 'string' }, branch: { type: 'string' }, twin: { type: 'string' },
    'home-base': { type: 'string', default: 'origin/main' },
    'twin-base': { type: 'string', default: 'origin/develop' }, help: { type: 'boolean' },
  } });
  if (v.help) { console.log(HELP); return 0; }
  if (!v.repo || !v.branch || !v.twin || [v.branch, v.twin, v['home-base'], v['twin-base']].some((s) => s.startsWith('-'))) {
    throw new Error('required: --repo, --branch, --twin; use --help');
  }
  const home = patchIds(v.repo, `${v['home-base']}..origin/${v.branch}`);
  const twin = patchIds(v.repo, `${v['twin-base']}..origin/${v.twin}`);
  const { ok, homeOnly, twinOnly } = compareParity(home, twin);
  if (ok) {
    console.log(`parity ok, ${home.length} patches`);
    return 0;
  }
  console.log('parity mismatch');
  for (const p of homeOnly) console.log(`home-only ${p.sha.slice(0, 12)} ${p.subject}`);
  for (const p of twinOnly) console.log(`twin-only ${p.sha.slice(0, 12)} ${p.subject}`);
  return 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
