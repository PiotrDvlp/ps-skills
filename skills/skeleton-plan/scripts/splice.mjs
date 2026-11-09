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

/** One file's blocks applied to its base source; selectors resolve against `source`; overlap, missing or ambiguous selectors throw. */
export function spliceFile(ts, path, source, blocks) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const edits = [];
  for (const block of blocks) {
    if (block.op !== 'replace' && block.op !== 'delete-declaration') {
      throw fail(`format: unsupported op ${block.op} in block ${block.id}`, 1);
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
        text: keep ? block.code : '',
      });
    });
  }
  edits.sort((x, y) => x.start - y.start);
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

/** Applies all blocks inside `dir`; refuses any target whose real path leaves `dir`; `.vue` blocks are skipped as ungated. */
export function spliceSnapshot(ts, dir, blocks) {
  throw fail('spliceSnapshot: not implemented', 3);
}
