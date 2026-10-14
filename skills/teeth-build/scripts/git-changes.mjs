import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fail } from './safe-dir.mjs';

const SOURCE = /\.(ts|vue|js|jsx|tsx|mjs|cjs|mts|cts)$/;
export const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const git = (root, args) => spawnSync('git', ['--no-optional-locks', '-c', 'core.quotePath=false', '-C', root, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

export function gitOk(root, args) {
  const r = git(root, args);
  if (r.status !== 0 || r.error) throw fail(`git ${args[0]} failed: ${(r.error?.message ?? r.stderr ?? '').split('\n')[0]}`);
  return r.stdout;
}

export function changedLines(root, base, featureRel) {
  if (git(root, ['merge-base', '--is-ancestor', base, 'HEAD']).status !== 0) throw fail(`base ${base} is not an ancestor of HEAD; rerun baseline`);
  const out = new Map();
  const add = (file, line) => { if (!out.has(file)) out.set(file, []); out.get(file).push(line); };
  const diff = gitOk(root, ['diff', '-U0', '--no-color', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/', base, '--', featureRel]);
  let file = null;
  let header = false;
  const quoted = (f) => { throw fail(`git quoted the path ${f}; rename it without quotes, tabs or newlines`); };
  for (const l of diff.split('\n')) {
    if (l.startsWith('diff --git ')) header = true;
    if (header && /^(\+\+\+|---) "/.test(l)) quoted(l.slice(4));
    if (header && l.startsWith('+++ ')) file = l === '+++ /dev/null' ? null : l.slice(6).replace(/\t$/, '');
    const h = l.match(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/);
    if (h) header = false;
    if (h && file && SOURCE.test(file) && !TEST_FILE.test(file)) {
      const start = Number(h[1]), count = h[2] === undefined ? 1 : Number(h[2]);
      for (let i = 0; i < count; i++) add(file, start + i);
    }
  }
  for (const f of gitOk(root, ['ls-files', '--others', '--exclude-standard', '--', featureRel]).split('\n').filter(Boolean)) {
    if (f.startsWith('"')) quoted(f);
    if (!SOURCE.test(f) || TEST_FILE.test(f)) continue;
    const n = readFileSync(join(root, f), 'utf8').replace(/\n$/, '').split('\n').length;
    for (let i = 1; i <= n; i++) add(f, i);
  }
  return new Map([...out.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
