import { createHash } from 'node:crypto';

const MARKER = '*Below this line: for the implementer, the gates and the reviewer.*';
const SPLICE = /^<!-- skeleton (\{.*\}) -->$/;
const UNCHANGED_LABEL = '**Signature unchanged, behaviour changed**';

/** @typedef {'create'|'insert'|'replace'|'delete-declaration'|'delete-file'} Op */
/** @typedef {{ id: string, path: string, op: Op, selectors: string[], after?: 'imports', into?: 'export-default', property?: string, label: string, code: string, line: number }} Block */
/** @typedef {{ action: 'create'|'modify'|'delete', path: string, change: string }} FileRow */
/** @typedef {{ base: string, approval: string, files: FileRow[], blocks: Block[], unchanged: string[], taskSignatures: Map<string, string[]> }} ParsedPlan */

const fail = (reason) => new Error(`format: ${reason}`);
const backticked = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

const readBase = (markdown) => {
  const front = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return front?.[1].match(/^base:\s*(\S+)/m)?.[1] ?? '';
};

const readFiles = (lines) => {
  const start = lines.findIndex((l) => /^## 1\. Files\b/.test(l));
  if (start < 0) return [];
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (/^## /.test(line)) break;
    if (!line.trim().startsWith('|')) continue;
    const [action, file = '', change = ''] = cells(line);
    if (/^-+$/.test(action.replace(/[:\s]/g, '')) || action.toLowerCase() === 'action') continue;
    rows.push({ action: action.toLowerCase(), path: backticked(file)[0] ?? file, change });
  }
  return rows;
};

const readBlocks = (lines) => {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(SPLICE);
    if (!m) continue;
    let meta;
    try {
      meta = JSON.parse(m[1]);
    } catch {
      throw fail(`bad splice comment at line ${i + 1}`);
    }
    const fence = lines[i + 1]?.match(/^(`{3,})/);
    if (!fence) throw fail(`no code block after line ${i + 1}`);
    const end = lines.findIndex((l, j) => j > i + 1 && l.startsWith(fence[1]) && l.trim() === fence[1]);
    if (end < 0) throw fail(`unclosed code block at line ${i + 2}`);
    const prev = lines[i - 1] ?? '';
    const { selector, selectors, ...rest } = meta;
    blocks.push({
      ...rest,
      selectors: selectors ?? (selector === undefined ? [] : [selector]),
      label: /^\*\*.+\*\*$/.test(prev.trim()) ? prev.trim().slice(2, -2) : '',
      code: lines.slice(i + 2, end).join('\n'),
      line: i + 1,
    });
    i = end;
  }
  return blocks;
};

const readUnchanged = (lines) => {
  const start = lines.findIndex((l) => l.trim() === UNCHANGED_LABEL);
  if (start < 0) return [];
  const out = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*[-*] /.test(line)) out.push(line.replace(/^\s*[-*] /, '').trim());
    else if (out.length && line.trim() === '') break;
    else if (out.length && /^\s+\S/.test(line)) out[out.length - 1] += ` ${line.trim()}`;
    else if (/^(#|\*\*)/.test(line)) break;
  }
  return out;
};

const readTaskSignatures = (lines) => {
  const map = new Map();
  let task = null;
  let inInterfaces = false;
  for (const line of lines) {
    const heading = line.match(/^### (Task \d+)\b/);
    if (heading) {
      task = heading[1];
      inInterfaces = false;
      continue;
    }
    if (!task) continue;
    if (line.startsWith('**Interfaces:**')) inInterfaces = true;
    else if (line.trim() === '' || /^(#|\*\*|Decided here)/.test(line)) inInterfaces = false;
    if (inInterfaces) map.set(task, [...(map.get(task) ?? []), ...backticked(line)]);
  }
  return map;
};

/** Splits at the "Below this line" marker; reads files table, labelled blocks, unchanged lines, task signatures. Throws `format: <reason>`. */
export function parsePlan(markdown) {
  const lines = markdown.split(/\r?\n/);
  const cut = lines.findIndex((l) => l.trim() === MARKER);
  if (cut < 0) throw fail('no approval marker');
  const above = lines.slice(0, cut);
  return {
    base: readBase(markdown),
    approval: above.join('\n'),
    files: readFiles(above),
    blocks: readBlocks(above),
    unchanged: readUnchanged(above),
    taskSignatures: readTaskSignatures(lines.slice(cut + 1)),
  };
}

/** sha256 over the approval part and each block's metadata and code; text below the line does not count. */
export function planHash(plan) {
  const hash = createHash('sha256');
  hash.update(plan.approval);
  for (const { code, ...meta } of plan.blocks) hash.update(`\0${JSON.stringify(meta)}\0${code}`);
  return hash.digest('hex');
}
