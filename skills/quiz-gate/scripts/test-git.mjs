import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmp } from './test-tmp.mjs';

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

export function commit(dir, file, text, msg) {
  writeFileSync(join(dir, file), text);
  git(dir, 'add', file);
  git(dir, 'commit', '-q', '-m', msg);
  return git(dir, 'rev-parse', 'HEAD');
}

export function repoWithRemote() {
  const remote = tmp('qg-remote-');
  git(remote, 'init', '-q', '--bare', '-b', 'main');
  const dir = tmp('qg-work-');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'remote', 'add', 'origin', remote);
  commit(dir, 'a.txt', 'one\ntwo\nthree\n', 'base');
  git(dir, 'push', '-q', 'origin', 'main');
  return { dir, remote };
}
