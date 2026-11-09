import { lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import { fail } from './tools.mjs';

const KINDS = {
  const: 'isVariableStatement',
  function: 'isFunctionDeclaration',
  type: 'isTypeAliasDeclaration',
  interface: 'isInterfaceDeclaration',
  class: 'isClassDeclaration',
  enum: 'isEnumDeclaration',
};

const declaredNames = (ts, statement, kind) => {
  if (!ts[KINDS[kind]](statement)) return [];
  if (kind === 'const') {
    return statement.declarationList.declarations.filter((d) => ts.isIdentifier(d.name)).map((d) => d.name.text);
  }
  return statement.name ? [statement.name.text] : [];
};

const leadingStart = (ts, source, node) => {
  const jsdoc = (ts.getLeadingCommentRanges(source, node.getFullStart()) ?? [])
    .filter((c) => source.startsWith('/**', c.pos) && !source.startsWith('/**/', c.pos));
  return jsdoc.at(-1)?.pos ?? node.getStart();
};

const deletionEnd = (ts, source, end) => {
  const trailing = ts.getTrailingCommentRanges(source, end);
  const after = trailing?.length ? trailing.at(-1).end : end;
  const lineBreak = source.slice(after).match(/^[ \t]*\r?\n/);
  return lineBreak ? after + lineBreak[0].length : after;
};

const parseSelector = (selector) => {
  const m = selector.match(/^([^:]+):([A-Za-z_$][\w$]*)$/);
  if (!m) throw fail(`format: bad selector ${selector}`, 1);
  if (!Object.hasOwn(KINDS, m[1])) throw fail(`format: unknown selector kind ${m[1]}`, 1);
  return [m[1], m[2]];
};

const resolveSelector = (ts, file, source, selector) => {
  const [kind, name] = parseSelector(selector);
  const groups = [];
  file.statements.forEach((statement, i) => {
    if (!declaredNames(ts, statement, kind).includes(name)) return;
    const previous = groups.at(-1);
    if (kind === 'function' && previous?.last === i - 1) Object.assign(previous, { last: i, end: statement.end });
    else groups.push({ last: i, start: leadingStart(ts, source, statement), end: statement.end });
  });
  if (groups.length === 0) throw fail(`failed: selector ${selector}`, 1);
  if (groups.length > 1) throw fail(`failed: ambiguous ${selector}`, 1);
  return groups[0];
};

const splitImports = (ts, code) => {
  const imports = [];
  for (const statement of ts.createSourceFile('block.ts', code, ts.ScriptTarget.Latest, true).statements) {
    if (!ts.isImportDeclaration(statement)) break;
    imports.push(statement);
  }
  if (imports.length === 0) return { imports: [], code };
  return {
    imports: imports.map((statement) => statement.getText()),
    code: code.slice(imports.at(-1).end).replace(/^(?:[ \t]*\r?\n)+/, ''),
  };
};

const normaliseImport = (text) => text.replace(/\s+/g, ' ').replace(/\s*([{},;])\s*/g, '$1').replace(/;$/, '');

const unwrap = (ts, node) => {
  while (node && (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node))) {
    node = node.expression;
  }
  return node;
};

const defaultObject = (ts, file) => {
  const exported = file.statements.find((s) => ts.isExportAssignment(s) && !s.isExportEquals);
  let node = unwrap(ts, exported?.expression);
  if (node && ts.isCallExpression(node)) node = unwrap(ts, node.arguments[0]);
  if (!node || !ts.isObjectLiteralExpression(node)) throw fail('failed: no export-default object', 1);
  return node;
};

const indent = (code, pad) => code.split('\n').map((line) => (line ? pad + line : line)).join('\n');

const propertyEdit = (ts, file, source, block, code) => {
  if (!block.property) throw fail(`format: insert into export-default needs property in block ${block.id}`, 1);
  const object = defaultObject(ts, file);
  if (object.properties.some((p) => p.name?.text === block.property)) {
    throw fail(`failed: property ${block.property} exists`, 1);
  }
  const property = code.trim().replace(/,$/, '');
  const last = object.properties.at(-1);
  if (!last) return { start: object.end - 1, text: `\n${indent(property, '  ')}\n` };
  if (!source.slice(object.getStart(), last.getStart()).includes('\n')) return { start: last.end, text: `, ${property}` };
  const lineStart = source.lastIndexOf('\n', last.getStart()) + 1;
  return { start: last.end, text: `,\n${indent(property, source.slice(lineStart).match(/^[ \t]*/)[0])}` };
};

/** One file's blocks applied to its base source; selectors resolve against `source`; overlap, missing or ambiguous selectors throw. */
export function spliceFile(ts, path, source, blocks) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const baseImports = file.statements.filter((s) => ts.isImportDeclaration(s));
  const anchor = baseImports.at(-1)?.end ?? 0;
  const seen = new Set(baseImports.map((s) => normaliseImport(s.getText())));
  const added = [];
  const edits = [];
  for (const block of blocks) {
    if (block.op !== 'replace' && block.op !== 'delete-declaration' && block.op !== 'insert') {
      throw fail(`format: unsupported op ${block.op} in block ${block.id}`, 1);
    }
    const { imports, code } = block.op === 'delete-declaration' ? { imports: [], code: '' } : splitImports(ts, block.code);
    for (const line of imports) {
      const key = normaliseImport(line);
      if (!seen.has(key)) added.push(line);
      seen.add(key);
    }
    if (block.op === 'insert') {
      if (block.after === 'imports') {
        edits.push({ block: block.id, selector: 'after:imports', start: anchor, end: anchor, text: anchor ? `\n\n${code}` : `${code}\n\n` });
      } else if (block.into === 'export-default') {
        const { start, text } = propertyEdit(ts, file, source, block, code);
        edits.push({ block: block.id, selector: `export-default:${block.property}`, start, end: start, text });
      } else {
        throw fail(`format: insert needs after or into in block ${block.id}`, 1);
      }
      continue;
    }
    const ranges = block.selectors
      .map((selector) => ({ selector, ...resolveSelector(ts, file, source, selector) }))
      .sort((x, y) => x.start - y.start);
    ranges.forEach((range, i) => {
      const keep = block.op === 'replace' && i === 0;
      edits.push({
        block: block.id,
        selector: range.selector,
        start: range.start,
        end: keep ? range.end : deletionEnd(ts, source, range.end),
        text: keep ? code : '',
      });
    });
  }
  if (added.length) {
    const text = anchor ? `\n${added.join('\n')}` : `${added.join('\n')}\n`;
    edits.unshift({ block: 'imports', selector: 'imports', start: anchor, end: anchor, text });
  }
  edits.sort((x, y) => x.start - y.start || (x.end - x.start) - (y.end - y.start));
  for (let i = 1; i < edits.length; i++) {
    const [a, b] = [edits[i - 1], edits[i]];
    if (b.start < a.end) {
      throw fail(`format: overlapping ${a.selector} (block ${a.block}) and ${b.selector} (block ${b.block}) in ${path}`, 1);
    }
  }
  let out = source;
  for (const edit of edits.reverse()) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

const leaves = (path) => fail(`blocked: target leaves snapshot ${path}`, 3);
const inside = (root, real) => real === root || real.startsWith(root + sep);

const realOrNull = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const makeParents = (root, path) => {
  let current = root;
  for (const segment of path.split('/').slice(0, -1)) {
    current = join(current, segment);
    if (!lstatSync(current, { throwIfNoEntry: false })) mkdirSync(current);
    const real = realOrNull(current);
    if (real === null || !inside(root, real)) throw leaves(path);
    current = real;
  }
};

const resolveTarget = (root, path, create) => {
  if (create) makeParents(root, path);
  const parent = realOrNull(join(root, dirname(path)));
  if (parent === null) throw fail(`failed: missing ${path}`, 1);
  if (!inside(root, parent)) throw leaves(path);
  const full = join(parent, basename(path));
  const stat = lstatSync(full, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) throw leaves(path);
  return { full, exists: Boolean(stat) };
};

/** Applies all blocks inside `dir`; refuses any target whose real path leaves `dir`; `.vue` blocks are skipped as ungated. */
export function spliceSnapshot(ts, dir, blocks) {
  const root = realpathSync(dir);
  const groups = new Map();
  const ungated = new Set();
  for (const block of blocks) {
    if (isAbsolute(block.path) || block.path.split(/[\\/]/).includes('..')) throw leaves(block.path);
    if (block.path.endsWith('.vue')) ungated.add(block.path);
    else groups.set(block.path, [...(groups.get(block.path) ?? []), block]);
  }
  const writes = [];
  let gated = 0;
  for (const [path, group] of groups) {
    gated += group.length;
    const whole = group.find((b) => b.op === 'create' || b.op === 'delete-file');
    if (whole && group.length > 1) throw fail(`format: ${whole.op} must be the only block for ${path}`, 1);
    const target = resolveTarget(root, path, whole?.op === 'create');
    if (whole?.op === 'create') {
      if (target.exists) throw fail(`failed: exists ${path}`, 1);
      const text = whole.code.endsWith('\n') ? whole.code : `${whole.code}\n`;
      writes.push(() => writeFileSync(target.full, text, { flag: 'wx' }));
    } else if (!target.exists) {
      throw fail(`failed: missing ${path}`, 1);
    } else if (whole) {
      writes.push(() => unlinkSync(target.full));
    } else {
      const out = spliceFile(ts, path, readFileSync(target.full, 'utf8'), group);
      writes.push(() => writeFileSync(target.full, out));
    }
  }
  for (const write of writes) write();
  return { gated, ungated: [...ungated] };
}
