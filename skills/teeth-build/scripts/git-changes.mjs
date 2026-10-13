import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const PROD = /\.(ts|vue)$/;
const TEST = /\.(test|spec)\.ts$/;
const git = (root, args) => spawnSync('git', ['--no-optional-locks', '-c', 'core.quotePath=false', '-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

function gitOk(root, args) {
  const r = git(root, args);
  if (r.status !== 0 || r.error) {
    const err = new Error(`git ${args[0]} failed: ${(r.error?.message ?? r.stderr ?? '').split('\n')[0]}`);
    err.code = 3;
    throw err;
  }
  return r.stdout;
}

export function changedLines(root, base, featureRel) {
  if (git(root, ['merge-base', '--is-ancestor', base, 'HEAD']).status !== 0) {
    const err = new Error(`base ${base} is not an ancestor of HEAD; rerun baseline`);
    err.code = 3;
    throw err;
  }
  const out = new Map();
  const add = (file, line) => { if (!out.has(file)) out.set(file, []); out.get(file).push(line); };
  const diff = gitOk(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', base, '--', featureRel]);
  let file = null;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+++ ')) file = l === '+++ /dev/null' ? null : l.slice(6).replace(/\t$/, '');
    const h = l.match(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/);
    if (h && file && PROD.test(file) && !TEST.test(file)) {
      const start = Number(h[1]), count = h[2] === undefined ? 1 : Number(h[2]);
      for (let i = 0; i < count; i++) add(file, start + i);
    }
  }
  for (const f of gitOk(root, ['ls-files', '--others', '--exclude-standard', '--', featureRel]).split('\n').filter(Boolean)) {
    if (!PROD.test(f) || TEST.test(f)) continue;
    const n = readFileSync(join(root, f), 'utf8').replace(/\n$/, '').split('\n').length;
    for (let i = 1; i <= n; i++) add(f, i);
  }
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
