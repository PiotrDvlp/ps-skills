import { createRequire } from 'node:module';
import { join } from 'node:path';

const MACROS = new Set(['withDefaults', 'defineProps', 'defineEmits', 'defineModel', 'defineOptions']);

export function loadVueParsers(root) {
  const req = createRequire(join(root, 'package.json'));
  const { parse } = req('@vue/compiler-sfc');
  const babel = req('@babel/parser');
  return {
    parseSfc: (source) => parse(source).descriptor,
    parseTs: (code) => babel.parse(code, { sourceType: 'module', plugins: ['typescript'] }),
  };
}

function macroLines(ast) {
  const out = new Set();
  const walk = (n) => {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'CallExpression' && n.callee?.type === 'Identifier' && MACROS.has(n.callee.name)) {
      for (let l = n.loc.start.line; l <= n.loc.end.line; l++) out.add(l);
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === 'string') walk(v);
    }
  };
  walk(ast.program);
  return out;
}

export function vueRanges(source, changedLines, { parseSfc, parseTs }) {
  const d = parseSfc(source);
  const blocks = [d.script, d.scriptSetup].filter(Boolean);
  const res = { mutate: [], mutable: [], notCovered: [] };
  if (blocks.length > 1) {
    for (const line of changedLines) res.notCovered.push({ line, reason: 'two script blocks' });
    return res;
  }
  for (const line of changedLines) {
    const b = blocks.find((x) => line > x.loc.start.line && line < x.loc.end.line);
    if (!b) res.notCovered.push({ line, reason: 'template' });
  }
  for (const b of blocks) {
    const off = b.loc.start.line - 1;
    const inBlock = changedLines.filter((l) => l > b.loc.start.line && l < b.loc.end.line);
    let macros;
    try { macros = macroLines(parseTs(b.content)); } catch {
      for (const line of inBlock) res.notCovered.push({ line, reason: 'unparsed' });
      continue;
    }
    for (const line of inBlock) {
      const rel = line - off;
      if (macros.has(rel)) { res.notCovered.push({ line, reason: 'macro' }); continue; }
      if (!b.content.split('\n')[rel - 1]?.trim()) continue;
      res.mutable.push(line);
      const last = res.mutate.at(-1);
      if (last && last.end === rel - 1) last.end = rel; else res.mutate.push({ start: rel, end: rel });
    }
  }
  res.notCovered.sort((a, b) => a.line - b.line);
  return res;
}
