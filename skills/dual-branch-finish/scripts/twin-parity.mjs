#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const HELP = `Compares two pushed twin branches by stable patch-id (Node 22+, git).
Usage: node twin-parity.mjs --repo <dir> --branch <home> --twin <sibling>
         [--home-base origin/main] [--twin-base origin/develop]
Compares origin/main..origin/<home> with origin/develop..origin/<sibling>; local branches are never read.
Matches as a set and in order; merge commits carry no patch and are not compared.
Exit 0: parity ok. 1: parity mismatch (home-only / twin-only lines follow). 2: a ref is missing or git failed.
Exit 3: parity context-only; the unmatched patches pair up by position with equal subjects (changed lines follow),
so only the context around a hunk may differ. Compare them with git range-diff before carrying on.
`;

function git(repo, args, input) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', input, timeout: 30_000,
    maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
  if (r.error || r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.error?.message || r.stderr.trim() || `exit ${r.status}`}`);
  return r.stdout;
}

export function patchIds(repo, range) {
  const subjects = new Map(git(repo, ['log', '--no-color', '--pretty=format:%H%x09%s', '--reverse', range, '--'])
    .split('\n').filter(Boolean).map((line) => {
      const [sha, ...subject] = line.split('\t');
      return [sha, subject.join('\t')];
    }));
  const withDiff = git(repo, ['log', '--no-color', '--no-merges', '--pretty=format:%x01%H', '--name-only', '--reverse', range, '--'])
    .split('\x01').filter((chunk) => chunk.split('\n').slice(1).some(Boolean)).length;
  const log = git(repo, ['log', '-p', '--no-color', '--no-ext-diff', '--pretty=medium', '--reverse', range, '--']);
  const ids = git(repo, ['patch-id', '--stable'], log).split('\n').filter(Boolean).map((line) => {
    const [id, sha] = line.split(' ');
    return { id, sha, subject: subjects.get(sha) ?? '' };
  });
  if (ids.length < withDiff) throw new Error(`patch-id produced ${ids.length} ids for ${withDiff} commits with a diff in ${range}`);
  return ids;
}

export function compareParity(home, twin) {
  const unused = [...twin];
  const homeOnly = [];
  for (const patch of home) {
    const at = unused.findIndex((candidate) => candidate.id === patch.id);
    if (at === -1) homeOnly.push(patch);
    else unused.splice(at, 1);
  }
  let order = null;
  if (!homeOnly.length && !unused.length) {
    const index = home.findIndex((patch, i) => patch.id !== twin[i].id);
    if (index !== -1) order = { index, home: home[index].sha, twin: twin[index].sha };
  }
  const paired = !order && homeOnly.length > 0 && homeOnly.length === unused.length
    && homeOnly.every((patch, i) => patch.subject === unused[i].subject);
  return { ok: !homeOnly.length && !unused.length && !order, homeOnly, twinOnly: unused, order, contextOnly: paired };
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
  const { ok, homeOnly, twinOnly, order, contextOnly } = compareParity(home, twin);
  if (ok) {
    console.log(`parity ok, ${home.length} patches`);
    return 0;
  }
  if (contextOnly) {
    console.log('parity context-only');
    homeOnly.forEach((p, i) => console.log(`changed ${i} home ${p.sha.slice(0, 12)} twin ${twinOnly[i].sha.slice(0, 12)} ${p.subject}`));
    return 3;
  }
  console.log('parity mismatch');
  for (const p of homeOnly) console.log(`home-only ${p.sha.slice(0, 12)} ${p.subject}`);
  for (const p of twinOnly) console.log(`twin-only ${p.sha.slice(0, 12)} ${p.subject}`);
  if (order) console.log(`order ${order.index} home ${order.home.slice(0, 12)} twin ${order.twin.slice(0, 12)}`);
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
