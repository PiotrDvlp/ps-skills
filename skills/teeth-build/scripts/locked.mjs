import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

const IS_TEST = /\.(test|spec)\.ts$/;
const sha = (b) => createHash('sha256').update(b).digest('hex');
function tests(root, d = root, out = []) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (n === 'node_modules') continue;
    if (statSync(p).isDirectory()) tests(root, p, out);
    else if (IS_TEST.test(n)) out.push(relative(root, p).split(sep).join('/'));
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

export function verify(featureAbs, dir) {
  const inv = JSON.parse(readFileSync(join(dir, 'inventory.json'), 'utf8'));
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
