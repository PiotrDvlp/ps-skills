import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { TEST_FILE } from './git-changes.mjs';
const sha = (b) => createHash('sha256').update(b).digest('hex');
function tests(root, d = root, out = []) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const n = e.name;
    const p = join(d, n);
    if (n === 'node_modules' || n === '.git') continue;
    if (e.isSymbolicLink()) {
      if (TEST_FILE.test(n)) throw Object.assign(new Error(`symlinked test file ${relative(root, p).split(sep).join('/')}`), { code: 3 });
      continue;
    }
    if (e.isDirectory()) tests(root, p, out);
    else if (TEST_FILE.test(n) || relative(root, d).split(sep).includes('__snapshots__')) out.push(relative(root, p).split(sep).join('/'));
  }
  return out.sort();
}

export function record(featureAbs, dir) {
  rmSync(join(dir, 'files'), { recursive: true, force: true });
  const inv = tests(featureAbs).map((path) => {
    const bytes = readFileSync(join(featureAbs, path));
    mkdirSync(dirname(join(dir, 'files', path)), { recursive: true });
    writeFileSync(join(dir, 'files', path), bytes);
    return { path, sha256: sha(bytes) };
  });
  writeFileSync(join(dir, 'inventory.json'), JSON.stringify(inv, null, 1));
}

function safeInventory(featureAbs, dir) {
  const inv = JSON.parse(readFileSync(join(dir, 'inventory.json'), 'utf8'));
  const inside = (base, p) => resolve(base, p).startsWith(resolve(base) + sep);
  for (const { path } of inv) {
    if (typeof path !== 'string' || isAbsolute(path) || path.split(/[\\/]/).includes('..') || !inside(featureAbs, path) || !inside(join(dir, 'files'), path)) {
      throw Object.assign(new Error(`unsafe inventory path ${path}`), { code: 3 });
    }
  }
  return inv;
}

export function verify(featureAbs, dir) {
  const inv = safeInventory(featureAbs, dir);
  const known = new Set(inv.map((e) => e.path));
  const r = { modified: [], deleted: [], added: tests(featureAbs).filter((p) => !known.has(p)) };
  for (const e of inv) {
    const p = join(featureAbs, e.path);
    if (!existsSync(p)) r.deleted.push(e.path);
    else if (sha(readFileSync(p)) !== e.sha256) r.modified.push(e.path);
  }
  return r;
}

export function restore(featureAbs, dir) {
  const v = verify(featureAbs, dir);
  for (const path of [...v.modified, ...v.deleted]) {
    mkdirSync(dirname(join(featureAbs, path)), { recursive: true });
    writeFileSync(join(featureAbs, path), readFileSync(join(dir, 'files', path)));
  }
  for (const path of v.added) unlinkSync(join(featureAbs, path));
  return verify(featureAbs, dir);
}
