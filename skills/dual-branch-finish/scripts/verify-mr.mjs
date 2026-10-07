#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const HELP = `Read-only GitLab MR handoff verifier (Node 22+, git, authenticated glab).
Usage: node verify-mr.mjs --repo <path> --branch <branch> --phase before-push
       node verify-mr.mjs --repo <path> --branch <branch> --target <base>
         --title <expected title> --description <draft.md> [--remote origin]
       node verify-mr.mjs --repo <path> --branch <branch> --target <base> --phase existing
         (an MR opened earlier, no draft: checks state, target and pushed commit; skips title and description)
Default phase: after-push. Exit 0: ready-to-push or verified; 1: pending/blocked;
2: unavailable or invalid input. Only 'verified' means the handoff is complete.
Description comparison normalizes CRLF and terminal newlines only.
`;

function command(name, args, cwd) {
  const r = spawnSync(name, args, { cwd, encoding: 'utf8', timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GLAB_CHECK_UPDATE: 'false', GIT_TERMINAL_PROMPT: '0' } });
  if (r.error || r.status !== 0) throw new Error(`${name} ${args[0]} unavailable: ${r.error?.message || r.stderr.trim() || `exit ${r.status}`}`);
  return r.stdout;
}

const glab = (args, cwd) => JSON.parse(command('glab', args, cwd));

// ponytail: first 100 MRs per source branch only; page if a branch ever exceeds it
function listMRs(branch, cwd, remoteUrl) {
  const rows = glab(['mr', 'list', '--all', '--source-branch', branch, '--per-page', '100', '-F', 'json', '-R', remoteUrl], cwd);
  if (!Array.isArray(rows) || rows.some((m) => !m || !Number.isInteger(m.iid) || m.iid < 1 ||
    !['opened', 'merged', 'closed'].includes(m.state) || typeof m.source_branch !== 'string' ||
    !Number.isInteger(m.source_project_id) || !Number.isInteger(m.target_project_id))) {
    throw new Error('glab returned an invalid MR list');
  }
  return rows.filter((m) => m.source_branch === branch && m.source_project_id === m.target_project_id);
}

function result(status, problems = [], mr) {
  return { status, problems, ...(mr ? { mr: mr.iid, url: mr.web_url } : {}) };
}

function verify(v) {
  const phase = v.phase ?? 'after-push';
  if (!v.repo || !v.branch || v.branch.startsWith('-') || !['before-push', 'after-push', 'existing'].includes(phase)) {
    throw new Error('required: --repo, --branch, and a valid --phase; use --help');
  }
  let expectedDescription;
  if (phase === 'after-push') {
    if (!v.target || !v.title?.trim() || !v.description) throw new Error('after-push requires --target, --title, --description');
    expectedDescription = readFileSync(v.description, 'utf8');
    if (!expectedDescription.trim()) throw new Error('description draft is empty');
  }
  if (phase === 'existing' && !v.target) throw new Error('existing requires --target');
  const remoteName = v.remote ?? 'origin';
  if (!remoteName || remoteName.startsWith('-')) throw new Error('invalid remote name');
  const remoteUrl = command('git', ['remote', 'get-url', remoteName], v.repo).trim();
  const matches = listMRs(v.branch, v.repo, remoteUrl);
  const open = matches.filter((m) => m.state === 'opened');
  if (open.length > 1) return result('pending', ['ambiguous-mr: multiple open MRs for this branch']);
  if (!open.length) {
    if (matches.length) return result('pending', ['inactive-mr: branch has only merged/closed MRs; use a fresh branch']);
    return phase === 'before-push' ? result('ready-to-push') : result('pending', ['missing-mr: creation form has not become an open MR']);
  }
  if (phase === 'before-push') return result('ready-to-push', [], open[0]);
  const mr = glab(['mr', 'view', String(open[0].iid), '-F', 'json', '-R', remoteUrl], v.repo);
  if (!mr || mr.iid !== open[0].iid || !['opened', 'merged', 'closed'].includes(mr.state)) throw new Error('glab returned invalid MR details');
  const problems = [];
  if (mr.state !== 'opened') problems.push('inactive-mr: MR is no longer open');
  if (mr.target_branch !== v.target) problems.push('target-mismatch');
  if (phase === 'after-push' && mr.title !== v.title) problems.push('title-mismatch');
  const normalize = (s) => s.replaceAll('\r\n', '\n').replace(/\n+$/, '');
  if (phase === 'after-push' && (typeof mr.description !== 'string' || normalize(mr.description) !== normalize(expectedDescription))) problems.push('description-mismatch');
  const head = command('git', ['rev-parse', '--verify', `${v.branch}^{commit}`], v.repo).trim();
  const ref = `refs/heads/${v.branch}`;
  const remote = command('git', ['ls-remote', remoteName, ref], v.repo)
    .trim().split('\n').map((line) => line.split(/\s+/)).filter((row) => row[1] === ref);
  if (remote.length !== 1 || remote[0][0] !== head) problems.push('remote-commit-mismatch');
  if (mr.sha !== head) problems.push('mr-commit-mismatch');
  const report = result(problems.length ? 'pending' : 'verified', problems, mr);
  return phase === 'existing' ? { ...report, skipped: ['title', 'description'] } : report;
}

try {
  const { values } = parseArgs({ options: {
    repo: { type: 'string' }, branch: { type: 'string' }, target: { type: 'string' },
    title: { type: 'string' }, description: { type: 'string' }, phase: { type: 'string' },
    remote: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(HELP); }
  else {
    const report = verify(values);
    console.log(JSON.stringify(report));
    process.exitCode = report.status === 'pending' ? 1 : 0;
  }
} catch (error) {
  console.log(JSON.stringify({ status: 'unverified', problems: [error.message] }));
  process.exitCode = 2;
}
