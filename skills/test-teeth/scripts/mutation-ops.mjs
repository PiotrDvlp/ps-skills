// Mask strings and comments so mutations only land in executable code. Template literals
// are masked whole, including interpolations; regex literals are deliberately not masked.
export function maskedRanges(source) {
  const ranges = [];
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const start = i;
      i += 2;
      while (i < n && source[i] !== '\n') i++;
      ranges.push([start, i]);
    } else if (c === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      ranges.push([start, i]);
    } else if (c === "'" || c === '"' || c === '`') {
      const start = i;
      const q = c;
      i++;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === q) { i++; break; }
        i++;
      }
      ranges.push([start, i]);
    } else {
      i++;
    }
  }
  return ranges;
}

function inRanges(pos, ranges) {
  for (const [s, e] of ranges) if (pos >= s && pos < e) return true;
  return false;
}

export function safeMatches(source, regex, ranges = maskedRanges(source)) {
  const out = [];
  for (const m of source.matchAll(regex)) {
    if (!inRanges(m.index, ranges)) out.push(m);
  }
  return out;
}

// Negating conditions beginning with these prefixes can produce invalid syntax.
const RISKY_IF_PREFIX = /^(typeof|await|yield|new|delete|void|instanceof|in|function|class)\b/;

const RETURN_CONTINUATION = ['?', ':', '.', ',', '&&', '||', '??', '+', '-'];

function continuesPastLine(source, lineEnd) {
  for (const line of source.slice(lineEnd + 1).split('\n')) {
    const t = line.trim();
    if (t) return RETURN_CONTINUATION.some((tok) => t.startsWith(tok));
  }
  return false;
}

function hasUnclosedOpener(expr) {
  let depth = 0;
  for (const c of expr) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  return depth > 0;
}

/**
 * New-side line ranges touched by a unified diff, as 1-based inclusive `[start, end]` pairs.
 *
 * Parses hunk headers only, so the diff must be generated with `--unified=0`. A
 * `+<start>,0` hunk is a pure deletion and contributes no new-file range.
 */
export function changedLineRanges(diffText) {
  return [...String(diffText).matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)]
    .map((m) => [Number(m[1]), m[2] === undefined ? 1 : Number(m[2])])
    .filter(([, count]) => count > 0)
    .map(([start, count]) => [start, start + count - 1]);
}

const lineOfOffset = (source, at) => source.slice(0, at).split('\n').length;

const inChangedLines = (file, at) => {
  if (!Array.isArray(file.changedLines)) return true;
  const line = lineOfOffset(file.source, at);
  return file.changedLines.some(([s, e]) => line >= s && line <= e);
};

export function planMutations(files, { maxMutations = 10, manual = [] } = {}) {
  const mutations = [];

  for (const m of manual) {
    const f = files.find((x) => x.path === m.file || x.path.endsWith('/' + m.file));
    if (!f) throw new Error(`--mutations names a file not in --impl: ${m.file}`);
    if (m.find === m.replace) {
      throw new Error(`--mutations entry is a no-op (find === replace): ${JSON.stringify(m.find)}`);
    }
    if (typeof m.find !== 'string' || m.find.length === 0) {
      throw new Error(`--mutations entry needs a non-empty string find: ${JSON.stringify(m)}`);
    }
    const idx = f.source.indexOf(m.find);
    if (idx < 0) throw new Error(`--mutations find not present in ${m.file}: ${JSON.stringify(m.find)}`);
    if (f.source.indexOf(m.find, idx + m.find.length) >= 0) {
      throw new Error(`--mutations find is not unique in ${m.file} — narrow it: ${JSON.stringify(m.find)}`);
    }
    mutations.push({
      file: f.path, at: idx, len: m.find.length, replacement: m.replace,
      kind: m.kind ?? 'manual', note: m.note ?? 'hand-authored mutation',
    });
  }

  const OPS = [
    { kind: 'equality', re: /(?<!\!)===/g, cap: 3, make: (m) => ({ len: 3, replacement: '!==', note: "'===' → '!=='" }) },
    { kind: 'inequality', re: /!==/g, cap: 2, make: (m) => ({ len: 3, replacement: '===', note: "'!==' → '==='" }) },
    { kind: 'logical-and', re: /&&/g, cap: 3, make: (m) => ({ len: 2, replacement: '||', note: "'&&' → '||'" }) },
    { kind: 'logical-or', re: /\|\|/g, cap: 2, make: (m) => ({ len: 2, replacement: '&&', note: "'||' → '&&'" }) },
    {
      kind: 'if-invert', re: /if\s*\(/g, cap: 2,
      make: (m, source) => {
        const parenAt = m.index + m[0].length - 1;
        const after = source.slice(parenAt + 1).replace(/^\s*/, '');
        if (after.startsWith('!')) return null;
        if (RISKY_IF_PREFIX.test(after)) return null;
        return { at: parenAt + 1, len: 0, replacement: '!', note: 'if (<cond>) → if (!<cond>)' };
      },
    },
    {
      kind: 'empty-return', re: /return\s+/g, cap: 2,
      make: (m, source) => {
        let lineEnd = source.indexOf('\n', m.index);
        if (lineEnd < 0) lineEnd = source.length;
        const masked = maskedRanges(source);
        let depth = 0;
        let semi = -1;
        for (let i = m.index + m[0].length; i < source.length; i++) {
          if (inRanges(i, masked)) continue;
          const c = source[i];
          if (c === '(' || c === '[' || c === '{') depth++;
          else if (c === ')' || c === ']' || c === '}') depth--;
          else if (c === ';' && depth === 0) { semi = i; break; }
          if (c === '\n' && depth === 0) break;
        }
        const spanEnd = semi >= m.index ? semi + 1 : lineEnd;
        const expr = source.slice(m.index + m[0].length, spanEnd - (semi >= m.index ? 1 : 0)).trim();
        if (expr.length === 0 || expr === 'undefined') return null;
        if (semi < m.index && (continuesPastLine(source, lineEnd) || hasUnclosedOpener(expr))) return null;
        return { at: m.index, len: spanEnd - m.index, replacement: 'return undefined;', note: 'return <expr> → return undefined' };
      },
    },
  ];

  for (const file of files) {
    const ranges = maskedRanges(file.source);
    for (const op of OPS) {
      const seen = new Set();
      for (const m of safeMatches(file.source, op.re, ranges)) {
        const made = op.make(m, file.source);
        if (!made) continue;
        const at = made.at ?? m.index;
        const len = made.len ?? m[0].length;
        if (!inChangedLines(file, at)) continue;
        const replacement = made.replacement ?? op.replace;
        const key = `${file.path}@${at}:${len}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const next = file.source.slice(0, at) + replacement + file.source.slice(at + len);
        if (next === file.source) continue;
        mutations.push({
          file: file.path, at, len, replacement,
          kind: op.kind, note: made.note ?? op.note,
        });
        if (seen.size >= op.cap) break;
      }
    }
  }

  const deduped = [];
  const keys = new Set();
  for (const m of mutations) {
    const key = `${m.file}@${m.at}:${m.len}`;
    if (keys.has(key)) continue;
    keys.add(key);
    deduped.push(m);
  }
  return deduped.slice(0, maxMutations);
}

export function applyMutation(source, m) {
  return source.slice(0, m.at) + m.replacement + source.slice(m.at + m.len);
}
