#!/usr/bin/env node
// node check-plan.mjs <plan.md>: exit 0 clean, 1 findings, 2 unreadable; SKILL.md plan preflight branches on these codes.

import { readFileSync, realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADING = /^(#{1,6})\s+(.*)/;
const ACCEPTANCE = /\bacceptance\b|\bexit criteria\b|\bdone when\b/i;
const ITEM = /^\s*(\d+[.)]|[-*+])\s+/;
const TABLE_ROW = /^\s*\|/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}/;
const PLACEHOLDER = /<[a-z][a-z0-9 _./-]{1,60}>/i;
const INLINE_CODE = /`([^`\n]+)`/g;
const COMMAND = /^(\.?\/\S|~|\$|[A-Za-z_]\w*=\S|sh |bash |node |npm |npx |pnpm |python|git |curl |make |go |cargo |pytest|vitest|for |grep |rg |test |ls |wt |rtk |codex |claude |printf |echo )/;
const EXPECTED = /\b(exit\w*|print\w*|return\w*|output\w*|show\w*|equal\w*|expected|pass(es|ed)?|fail(s|ed)?|nonzero|non-zero|zero|contains|matches|lists)\b|==|=\s*\d|\d+\s+(tests?|checks?|files?|lines?)\b|→/i;
const MANUAL = /\b(manual(ly)?|by hand|in the browser|open (the )?browser)\b/i;
const MANUAL_ENV = /https?:\/\/|\b(url|account|login|env(ironment)?|fixture|data)\b/i;
const VAR_REF = /\$\{?([A-Za-z_][A-Za-z0-9_]*)/g;
const VAR_ASSIGN = /(?:^|[\s;&|(`])(?:export\s+|local\s+)?([A-Za-z_]\w*)=|\bfor\s+([A-Za-z_]\w*)\s+in\b|\bread\s+(?:-\w+\s+)*([A-Za-z_]\w*)/g;
const SHELL_VARS = new Set(['HOME', 'PWD', 'OLDPWD', 'TMPDIR', 'PATH', 'USER', 'SHELL', 'LANG', 'RANDOM', 'SECONDS',
  'LINENO', 'IFS', 'PPID', 'UID', 'EUID', 'REPLY', 'PIPESTATUS', 'BASHPID', 'HOSTNAME', 'OSTYPE',
  'CLAUDE_PROJECT_DIR']);
const SHELL_FENCES = new Set(['', 'sh', 'bash', 'shell', 'zsh', 'console']);
const SINGLE_QUOTED = /'[^'\n]*'/g;
const TASK = /^task\s+\d+/i;
const PIPED_TEST = /\b(?:(?:npm|npx|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck|build|lint)\b|(?<![\w"'./-])vitest(?=\s|$)(?!\s+list\b)|node\s+--test\b|pytest\b|cargo\s+test\b|go\s+test\b)(?:[^|\n;&]|(?<=>)&|&(?=>))*\|\s*(?:tail|head|grep|rg)\b/g;
const PIPEFAIL_SET = /\bset\s+-[a-zA-Z]*o\s+pipefail\b/;
const CHECK_TITLE = /\b(add|write|create|build|extend|harden|introduce)\w*\b[^\n]{0,60}\b(tests?|specs?|scanner|verifier|validator|gate|guard|checker|check|lint\w*)\b/i;
const TEST_FILE = /[\w./-]*(?:\.(?:test|spec)\.\w+|\/test_\w+\.py|_test\.(?:py|go))\b/;
const NEGATIVE_PROOF = /\b(negative proof|mutation proof|red first|prove[sd]? (?:it|that it|the check) can fail)\b[^\n]*(?:\n(?!\s*\n)[^\n]*)*/i;
const FAIL_EXPECTED = /\b(exit\w*\s+(?:non-?zero|[1-9]\d*)|non-?zero|fails?|failing|rejects?|denied|blocked|red)\b/i;

/** Python str.splitlines() for \n, \r\n and \r: no trailing empty element. */
function splitLines(text) {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const isFence = (line) => line.trim().startsWith('```');
const cut = (s, n) => [...s].slice(0, n).join('');
const inlineCode = (line) => [...line.matchAll(INLINE_CODE)].map((m) => m[1]);

function* headings(lines) {
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (isFence(lines[i])) { fence = !fence; continue; }
    if (fence) continue;
    const m = HEADING.exec(lines[i]);
    if (m) yield [i, m[1].length, m[2].trim()];
  }
}

function sections(lines, pattern) {
  const out = [];
  const heads = [...headings(lines)];
  heads.forEach(([i, level, title], pos) => {
    if (!pattern.test(title)) return;
    const next = heads.slice(pos + 1).find(([, lvl]) => lvl <= level);
    out.push([title, lines.slice(i + 1, next ? next[0] : lines.length)]);
  });
  return out;
}

function items(sectionLines) {
  const found = [];
  let cur = null, fence = false, seenHeader = false;
  for (const line of sectionLines) {
    if (isFence(line)) {
      fence = !fence;
      if (cur) cur.push(line);
      continue;
    }
    if (fence) {
      if (cur) cur.push(line);
      continue;
    }
    if (TABLE_ROW.test(line)) {
      if (TABLE_SEP.test(line.replace(/^[| ]+/, ''))) continue;
      if (!seenHeader) { seenHeader = true; continue; }
      found.push([line]);
      cur = null;
      continue;
    }
    if (ITEM.test(line)) {
      cur = [line];
      found.push(cur);
    } else if (cur && line.trim()) {
      cur.push(line);
    }
  }
  return found.map((c) => c.join('\n'));
}

/** Each inline command and each shell fence, as one string per unit. */
function shellUnits(text) {
  const units = [];
  let fenced = [], fence = false, shell = false;
  for (const line of splitLines(text)) {
    const stripped = line.trim();
    if (stripped.startsWith('```')) {
      if (fence && shell) {
        units.push(fenced.join('\n'));
        fenced = [];
      }
      fence = !fence;
      shell = fence && SHELL_FENCES.has(stripped.slice(3).trim().toLowerCase());
    } else if (!fence) {
      units.push(...inlineCode(line));
    } else if (shell) {
      fenced.push(line);
    }
  }
  return units;
}

const codeText = (text) => shellUnits(text).join('\n');

const hasCommand = (text) =>
  shellUnits(text).some((unit) => splitLines(unit).some((line) => COMMAND.test(line.trim())));

function pipeFindings(text) {
  const out = [];
  for (const unit of shellUnits(text)) {
    for (const m of unit.matchAll(PIPED_TEST)) {
      const end = m.index + m[0].length;
      if (PIPEFAIL_SET.test(unit.slice(0, m.index)) || unit.slice(end).includes('PIPESTATUS')) continue;
      out.push(`[pipe] \`${cut(m[0].trim(), 60)}\` hides the exit status: run it directly or set -o pipefail`);
    }
  }
  return out;
}

function taskFindings(lines) {
  const out = [];
  for (const [title, body] of sections(lines, TASK)) {
    const text = body.join('\n');
    if (!hasCommand(text)) out.push(`[${title}] no verification command`);
    if (!EXPECTED.test(text)) out.push(`[${title}] no expected result`);
    if (CHECK_TITLE.test(title) || TEST_FILE.test(text)) {
      const proof = NEGATIVE_PROOF.exec(text);
      if (!proof) out.push(`[${title}] no negative proof (a 'Negative proof:' line with a command expected to fail)`);
      else if (!FAIL_EXPECTED.test(proof[0])) out.push(`[${title}] negative proof names no failing result (exit 1, non-zero, fails, rejects)`);
    }
  }
  return out;
}

function unassignedVars(code) {
  const assigned = new Set();
  for (const m of code.matchAll(VAR_ASSIGN)) for (const name of m.slice(1)) if (name) assigned.add(name);
  const refs = new Set([...code.replace(SINGLE_QUOTED, '').matchAll(VAR_REF)].map((m) => m[1]));
  return [...refs].filter((v) => !assigned.has(v) && !SHELL_VARS.has(v));
}

function checkItem(text) {
  const problems = unassignedVars(codeText(text)).map((v) => `$${v} never assigned in the command`);
  const placeholder = PLACEHOLDER.exec(text);
  if (placeholder) problems.push(`placeholder ${placeholder[0]}`);
  const hasCmd = text.includes('```') || inlineCode(text).some((c) => COMMAND.test(c));
  if (!hasCmd) problems.push('no command');
  if (!EXPECTED.test(text)) problems.push('no expected result');
  if (MANUAL.test(text) && !MANUAL_ENV.test(text)) problems.push('manual gate names no URL/account/env');
  return problems;
}

/** @returns {string[]} one human-readable finding per problem; empty when the plan passes. */
export function check(text) {
  const lines = splitLines(text);
  const findings = [...pipeFindings(text), ...taskFindings(lines)];
  const accept = sections(lines, ACCEPTANCE);
  if (!accept.length) {
    return [...findings, "no acceptance section (heading containing 'acceptance', 'exit criteria' or 'done when')"];
  }
  for (const [title, body] of accept) {
    const its = items(body);
    if (!its.length) findings.push(`[${title}] section has no list items or table rows`);
    its.forEach((it, idx) => {
      const probs = checkItem(it);
      if (probs.length) {
        const head = cut(it.split('\n')[0].trim(), 70);
        findings.push(`[${title}] item ${idx + 1}: ${probs.join(', ')} — ${head}`);
      }
    });
  }
  return findings;
}

function isMain() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMain()) {
  const path = process.argv[2];
  if (!path) { console.error('usage: check-plan.mjs <plan.md>'); process.exit(2); }
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (err) {
    console.error(`check-plan: cannot read ${path}: ${err.code || err.message}`);
    process.exit(2);
  }
  const findings = check(text);
  for (const f of findings) console.log(f);
  console.log(`check-plan: ${findings.length} finding(s) in ${basename(path)}`);
  process.exit(findings.length ? 1 : 0);
}
