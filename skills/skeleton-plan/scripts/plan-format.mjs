import { createHash } from 'node:crypto';
import { posix } from 'node:path';

const MARKER = '*Below this line: for the implementer, the gates and the reviewer.*';
const SPLICE = /^<!-- skeleton (\{.*\}) -->$/;
const SPLICE_START = /^<!--\s*skeleton/;
const UNCHANGED_LABEL = '**Signature unchanged, behaviour changed**';
const FILES_HEADING = /^## 1\. Files\b/;
const GATE_LINE = /^Gate: /;

/** @typedef {'create'|'insert'|'replace'|'delete-declaration'|'delete-file'} Op */
/** @typedef {{ id: string, path: string, op: Op, selectors: string[], after?: 'imports', into?: 'export-default', property?: string, label: string, code: string, line: number, selectorConflict?: true }} Block */
/** @typedef {{ action: 'create'|'modify'|'delete', path: string, change: string }} FileRow */
/** @typedef {{ base: string, gateLine: string|null, approval: string, files: FileRow[], blocks: Block[], unchanged: string[], taskSignatures: Map<string, string[]>, taskFiles: Set<string> }} ParsedPlan */

const fail = (reason) => new Error(`format: ${reason}`);
const backticked = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
const cells = (row) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

const readBase = (markdown) => {
  const front = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return front?.[1].match(/^base:\s*(\S+)/m)?.[1] ?? '';
};

const readFiles = (lines) => {
  const start = lines.findIndex((l) => FILES_HEADING.test(l));
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

const isString = (value) => typeof value === 'string';
const wellTyped = (meta) =>
  meta !== null && typeof meta === 'object' && !Array.isArray(meta)
  && ['id', 'path', 'op'].every((key) => isString(meta[key]))
  && ['selector', 'after', 'into', 'property'].every((key) => meta[key] === undefined || isString(meta[key]))
  && (meta.selectors === undefined || (Array.isArray(meta.selectors) && meta.selectors.every(isString)));

const readBlocks = (lines) => {
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    const m = text.match(SPLICE);
    if (!m) {
      if (SPLICE_START.test(text)) throw fail(`bad splice comment at line ${i + 1}`);
      continue;
    }
    let meta;
    try {
      meta = JSON.parse(m[1]);
    } catch {
      throw fail(`bad splice comment at line ${i + 1}`);
    }
    if (!wellTyped(meta)) throw fail(`bad splice comment at line ${i + 1}`);
    const fence = lines[i + 1]?.match(/^(`{3,})/);
    if (!fence) throw fail(`no code block after line ${i + 1}`);
    const end = lines.findIndex((l, j) => j > i + 1 && l.startsWith(fence[1]) && l.trim() === fence[1]);
    if (end < 0) throw fail(`unclosed code block at line ${i + 2}`);
    const prev = lines[i - 1] ?? '';
    const { selector, selectors, ...rest } = meta;
    blocks.push({
      ...rest,
      selectors: selectors ?? (selector === undefined ? [] : [selector]),
      ...(selector !== undefined && selectors !== undefined && { selectorConflict: true }),
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
  let produces = false;
  for (const line of lines) {
    const heading = line.match(/^### (Task \d+)\b/);
    if (heading) {
      task = heading[1];
      inInterfaces = false;
      continue;
    }
    if (!task) continue;
    if (line.startsWith('**Interfaces:**')) {
      inInterfaces = true;
      produces = false;
    }
    else if (line.trim() === '' || /^(#|\*\*|Decided here)/.test(line)) inInterfaces = false;
    if (!inInterfaces) continue;
    const found = [];
    for (const part of line.split(/\b(Produces|Consumes)\b/)) {
      if (part === 'Produces' || part === 'Consumes') produces = part === 'Produces';
      else if (produces) found.push(...backticked(part));
    }
    map.set(task, [...(map.get(task) ?? []), ...found]);
  }
  return map;
};

const FILES_LINE = '**Files:**';
const FILES_TOKEN = /\b(create|modify|delete|test)\b|`([^`]+)`|\[\[([^\]|#]+)/gi;

const readTaskFiles = (lines) => {
  const named = new Set();
  let text = null;
  const flush = () => {
    if (text === null) return;
    let verb = null;
    for (const m of text.matchAll(FILES_TOKEN)) {
      if (m[1]) verb = m[1].toLowerCase();
      else if (verb && verb !== 'test') named.add(m[2] ?? `[[${m[3].trim()}]]`);
    }
    text = null;
  };
  for (const line of lines) {
    const at = line.indexOf(FILES_LINE);
    if (at >= 0) {
      flush();
      text = line.slice(at + FILES_LINE.length);
    }
    else if (text !== null && (line.trim() === '' || /^(#|\*\*|Decided here|Verify|Expected)/.test(line))) flush();
    else if (text !== null) text += ` ${line}`;
  }
  flush();
  return named;
};

const findGateLine = (above) => {
  const files = above.findIndex((l) => FILES_HEADING.test(l));
  const frontEnd = above[0] === '---' ? above.indexOf('---', 1) : -1;
  let fence = null;
  for (let i = frontEnd + 1; i < files; i++) {
    const marker = above[i].match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (fence === null && marker) fence = marker;
    else if (fence !== null && marker?.[0] === fence[0] && marker.length >= fence.length && above[i].trim() === marker) fence = null;
    else if (fence === null && GATE_LINE.test(above[i])) return i;
  }
  return -1;
};

/** Splits at the "Below this line" marker; reads files table, labelled blocks, unchanged lines, task signatures, and the paths task `**Files:**` lines create, modify or delete (`[[name]]` for a wikilink). The first `Gate: ` header line above `## 1. Files`, outside the front matter and code fences, is `gateLine` and is left out of `approval`. Throws `format: <reason>`. */
export function parsePlan(markdown) {
  const lines = markdown.split(/\r?\n/);
  const cut = lines.findIndex((l) => l.trim() === MARKER);
  if (cut < 0) throw fail('no approval marker');
  const above = lines.slice(0, cut);
  const gate = findGateLine(above);
  return {
    base: readBase(markdown),
    gateLine: gate < 0 ? null : above[gate],
    approval: above.filter((_, i) => i !== gate).join('\n'),
    files: readFiles(above),
    blocks: readBlocks(above),
    unchanged: readUnchanged(above),
    taskSignatures: readTaskSignatures(lines.slice(cut + 1)),
    taskFiles: readTaskFiles(lines.slice(cut + 1)),
  };
}

const VERBS = { create: 'Create', insert: 'Insert into', replace: 'Replace in', 'delete-declaration': 'Delete in', 'delete-file': 'Delete in' };
const ROWS = { create: 'create', insert: 'modify', replace: 'modify', 'delete-declaration': 'modify', 'delete-file': 'delete' };
const SELECTOR_KINDS = ['const', 'function', 'type', 'interface', 'class', 'enum'];
const SOURCE_FILE = /\.(ts|tsx|mts|cts|vue)$/i;
const tail = (path) => path.split('/').slice(-2).join('/');
const leavesRepo = (path) => path.startsWith('/') || path.split(/[\\/]/).includes('..');
const notNormalised = (path) => path === '' || path.endsWith('/') || posix.normalize(path) !== path;
const capitalised = (word) => word.charAt(0).toUpperCase() + word.slice(1);

const namesPath = (tokens, path) => {
  const segments = Math.min(2, path.split('/').length);
  return tokens.some((t) => t.split('/').length >= segments && (t === path || path.endsWith(`/${t}`)));
};

/** `{ kind, name }` of a `kind:name` selector, or `{ error }` with the `format:` reason when it is malformed or its kind is unknown. */
export function parseSelector(selector) {
  const m = selector.match(/^([^:]+):([A-Za-z_$][\w$]*)$/);
  if (!m) return { error: `format: bad selector ${selector}` };
  if (!SELECTOR_KINDS.includes(m[1])) return { error: `format: unknown selector kind ${m[1]}` };
  return { kind: m[1], name: m[2] };
}

const blockErrors = (b, sharing) => {
  const out = [];
  const at = `${b.id} (line ${b.line})`;
  if (leavesRepo(b.path)) out.push(`format: path ${b.path} leaves the repo in ${at}`);
  else if (notNormalised(b.path)) out.push(`format: path ${b.path} is not normalised`);
  if (!SOURCE_FILE.test(b.path)) out.push(`format: path ${b.path} is not a TypeScript or Vue file in ${b.id}`);
  if (!Object.hasOwn(VERBS, b.op)) return [...out, `format: unsupported op ${b.op} in block ${b.id}`];
  if ((b.op === 'create' || b.op === 'delete-file') && sharing > 1) out.push(`format: ${b.op} must be the only block for ${b.path}`);
  if (b.op === 'insert' && b.after !== 'imports') {
    if (b.into !== 'export-default') out.push(`format: insert needs after or into in block ${b.id}`);
    else if (!b.property) out.push(`format: insert into export-default needs property in block ${b.id}`);
  }
  const names = [];
  if (b.op === 'replace' || b.op === 'delete-declaration') {
    if (b.selectors.length === 0) out.push(`format: ${b.op} needs a selector in ${at}`);
    for (const selector of b.selectors) {
      const parsed = parseSelector(selector);
      if (parsed.error) out.push(parsed.error);
      else names.push(parsed.name);
    }
  }
  const tokens = backticked(b.label);
  const unnamed = [];
  if (!b.label.includes(VERBS[b.op])) unnamed.push(`verb "${VERBS[b.op]}"`);
  if (!namesPath(tokens, b.path)) unnamed.push(`path \`${tail(b.path)}\``);
  for (const name of names) if (!tokens.includes(name)) unnamed.push(`selector \`${name}\``);
  if (b.op === 'insert' && b.after !== 'imports' && b.property && !tokens.includes(b.property)) unnamed.push(`property \`${b.property}\``);
  for (const what of unnamed) out.push(`format: label "${b.label}" does not name ${what} in ${at}`);
  return out;
};

/** Every format violation as `format: <reason>`: labels, files rows, rows with no block or task behind them, paths, ops, selectors, inserts, overlaps and task signatures; empty means clean. */
export function checkFormat(plan) {
  const out = [];
  const blockPaths = new Set(plan.blocks.map((b) => b.path));
  for (const row of plan.files) {
    const wikilink = `[[${posix.basename(row.path).replace(/\.md$/, '')}]]`;
    if (!blockPaths.has(row.path) && !plan.taskFiles?.has(row.path) && !plan.taskFiles?.has(wikilink)) {
      out.push(`format: orphan row ${capitalised(row.action)} for ${row.path}: no block, and no task Files line creates, modifies or deletes it`);
    }
  }
  const ids = new Set(plan.blocks.map((b) => b.id));
  const perPath = new Map();
  for (const b of plan.blocks) perPath.set(b.path, (perPath.get(b.path) ?? 0) + 1);
  const claimed = new Map();
  for (const b of plan.blocks) {
    out.push(...blockErrors(b, perPath.get(b.path)));
    const rows = plan.files.filter((f) => f.path === b.path);
    if (rows.length === 0) out.push(`format: not in files table ${b.path} in ${b.id} (line ${b.line})`);
    for (const row of rows) {
      if (Object.hasOwn(ROWS, b.op) && row.action !== ROWS[b.op]) {
        out.push(`format: row ${capitalised(row.action)} for ${b.path} does not fit op ${b.op} in ${b.id}`);
      }
    }
    if (b.selectorConflict) out.push(`format: selector and selectors both set in ${b.id} (line ${b.line})`);
    for (const sel of b.selectors) {
      const key = `${b.path}\0${sel}`;
      if (claimed.has(key)) out.push(`format: overlapping ${sel} in ${b.path}: ${claimed.get(key)} and ${b.id}`);
      else claimed.set(key, b.id);
    }
  }
  for (const [task, values] of plan.taskSignatures) {
    let current = null;
    for (const sig of values) {
      if (ids.has(sig)) current = plan.blocks.find((b) => b.id === sig);
      else if (!(current ? [current] : plan.blocks).some((b) => b.code.includes(sig))) {
        out.push(`format: signature \`${sig}\` in ${task} not found in ${current ? current.id : 'any block'}`);
      }
    }
  }
  return [...new Set(out)];
}

const normalised = (text) => text
  .split('\n')
  .map((line) => line.trimEnd())
  .join('\n')
  .replace(/\n{3,}/g, '\n\n')
  .replace(/^\n+|\n+$/g, '');

/** sha256 over the approval part, with trailing whitespace stripped and blank-line runs collapsed, and each block's metadata (not its line number) and code; text below the line and the Gate line do not count. */
export function planHash(plan) {
  const hash = createHash('sha256');
  hash.update(normalised(plan.approval));
  for (const { code, line, ...meta } of plan.blocks) hash.update(`\0${JSON.stringify(meta)}\0${code}`);
  return hash.digest('hex');
}
