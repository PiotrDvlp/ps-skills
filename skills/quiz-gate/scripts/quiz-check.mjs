#!/usr/bin/env node
// quiz-gate hook v1
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ZEROS = /^0{40}$/;

function git(cwd, args, input) {
  const r = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new Error(`git ${args[0]}: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

export function gitCommonDir(cwd) {
  return resolve(cwd, git(cwd, ['rev-parse', '--git-common-dir']).trim());
}

export function ledgerPath(cwd) {
  return resolve(gitCommonDir(cwd), 'quiz', 'passed.jsonl');
}

export function readLedger(file) {
  const ids = new Set();
  if (!existsSync(file)) return ids;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    try {
      const { id } = JSON.parse(line);
      if (typeof id === 'string') ids.add(id);
    } catch {
      continue;
    }
  }
  return ids;
}

export function commitIdentity(cwd, sha) {
  const parents = git(cwd, ['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').length - 1;
  if (parents > 1) {
    const diff = git(cwd, ['diff-tree', '--cc', '-p', '--no-commit-id', '--no-color', '--no-ext-diff', sha]);
    return diff === '' ? null : `merge:${createHash('sha256').update(diff).digest('hex')}`;
  }
  const patch = git(cwd, ['diff-tree', '-p', '--root', '--no-commit-id', '--no-color', '--no-ext-diff', sha]);
  if (patch === '') return null;
  const id = git(cwd, ['patch-id', '--stable'], patch).split(/\s/)[0];
  if (!id) throw new Error(`git patch-id produced no id for ${sha}`);
  return id;
}

export function unpushed(cwd, tip, remote, remoteSha) {
  const args = ['rev-list', tip, '--not', `--remotes=${remote}`];
  if (remoteSha && !ZEROS.test(remoteSha) && hasCommit(cwd, remoteSha)) args.push(remoteSha);
  return git(cwd, args).split('\n').filter(Boolean);
}

function hasCommit(cwd, sha) {
  return spawnSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd }).status === 0;
}

export function checkPush(cwd, remote, stdin) {
  const passed = readLedger(ledgerPath(cwd));
  const seen = new Set();
  const missing = [];
  for (const line of stdin.split('\n')) {
    const [, localSha, ref, remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZEROS.test(localSha)) continue;
    const tip = git(cwd, ['rev-parse', `${localSha}^{commit}`]).trim();
    for (const sha of unpushed(cwd, tip, remote, remoteSha)) {
      if (seen.has(sha)) continue;
      seen.add(sha);
      const id = commitIdentity(cwd, sha);
      if (id !== null && !passed.has(id)) missing.push({ sha, ref });
    }
  }
  return missing;
}

function main(argv) {
  const remote = argv[0] ?? 'origin';
  try {
    const missing = checkPush(process.cwd(), remote, readFileSync(0, 'utf8'));
    if (missing.length === 0) return 0;
    for (const { sha } of missing) {
      const summary = git(process.cwd(), ['log', '-1', '--format=%h %s', sha]).trim();
      console.error(`no quiz pass: ${summary}`);
    }
    console.error('run the quiz-gate skill (/ps:quiz-gate or /quiz-gate) in this worktree, then push again (or with --remote <name>)');
  } catch (e) {
    console.error(`quiz-gate check failed: ${e.message}`);
    console.error('git push --no-verify bypasses this check');
  }
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
