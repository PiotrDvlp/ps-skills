#!/usr/bin/env node
// Usage: node scripts/check-public-leaks.mjs --root <dir> --deny-file <file> [--allow-path <prefix>]...
// Exit 0: no findings. 1: findings printed. 2: deny file missing or empty.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.tmp', 'brand-marks', 'assets']);
const TEXT = /\.(md|mjs|cjs|js|ts|json|sh|py|txt|yml|yaml)$/;
const PERSONAL_PATH = /\/Users\/|\/home\/[a-z]|~\/Projekty/;
const TICKET = /\b(?!PROJ-|ABC-)[A-Z][A-Z\d]{1,9}-\d+\b/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (TEXT.test(name)) yield full;
  }
}

export function scanTree({ root, deny, allowPaths = [] }) {
  const findings = [];
  const denyRe = deny.length ? new RegExp(deny.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'i') : null;
  for (const file of walk(root)) {
    const rel = relative(root, file);
    const allowed = allowPaths.some((p) => rel === p || rel.startsWith(`${p}/`));
    readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
      const line = i + 1;
      if (PERSONAL_PATH.test(text)) findings.push({ file: rel, line, match: text.match(PERSONAL_PATH)[0], rule: 'personal-path' });
      if (TICKET.test(text)) findings.push({ file: rel, line, match: text.match(TICKET)[0], rule: 'ticket-key' });
      if (denyRe && !allowed && denyRe.test(text)) findings.push({ file: rel, line, match: text.match(denyRe)[0], rule: 'deny-name' });
    });
  }
  return { findings };
}

function readDeny(file) {
  if (!file || !existsSync(file)) return null;
  const names = readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return names.length ? names : null;
}

if (process.argv[1] && process.argv[1].endsWith('check-public-leaks.mjs')) {
  const argv = process.argv.slice(2);
  const get = (flag) => { const i = argv.indexOf(flag); return i === -1 ? undefined : argv[i + 1]; };
  const allowPaths = argv.flatMap((a, i) => (a === '--allow-path' ? [argv[i + 1]] : []));
  const deny = readDeny(get('--deny-file'));
  if (!deny) { console.error('deny file missing or empty: refusing to run a weakened scan'); process.exit(2); }
  const { findings } = scanTree({ root: get('--root') ?? '.', deny, allowPaths });
  for (const f of findings) console.log(`${f.file}:${f.line}: ${f.rule}: ${f.match}`);
  console.log(`${findings.length} findings`);
  process.exit(findings.length ? 1 : 0);
}
