#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commitIdentity, gitCommonDir, ledgerPath, readLedger, unpushed } from './quiz-check.mjs';

const MARKERS = new Set(['# quiz-gate hook v1', '// quiz-gate hook v1']);
const CHECK_SOURCE = fileURLToPath(new URL('./quiz-check.mjs', import.meta.url));
const HUSKY_WRAPPER = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"';

const DEFAULT_HOOK = `#!/bin/sh
# quiz-gate hook v1
exec node "$(dirname "$0")/quiz-check.mjs" "$@"
`;

const HUSKY_HOOK = `#!/usr/bin/env sh
# quiz-gate hook v1
t=$(mktemp) || exit 1
trap 'rm -f "$t"' EXIT
cat > "$t" || exit 1
node "$(dirname "$0")/quiz-check.mjs" "$@" < "$t" || exit $?
. "$(dirname "$0")/h" "$@" < "$t"
`;

const MAX_LINE_QUESTIONS = 4;
const MAX_PRIORITY = 2;
const MIN_LINE_GAP = 5;
const CONTEXT_RADIUS = 3;
const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
const SKIPPED_DIRS = new Set(['__tests__', '__snapshots__', 'docs']);

class SetupError extends Error {}
class Finding extends Error {}

const FLAGS = new Set(['no-eligible']);
const COMMAND_FLAGS = {
  install: ['root'],
  uninstall: ['root'],
  status: ['root'],
  pick: ['plan', 'remote', 'root'],
  record: ['attempt', 'grades', 'no-eligible', 'root'],
};
const ATTEMPT_ID = /^[\w-]+$/;

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new SetupError(`git ${args[0]}: ${r.error.message}`);
  return r;
}

function gitOut(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new SetupError(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}

function gitRaw(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new SetupError(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout;
}

function real(path) {
  const missing = [];
  let head = resolve(path);
  while (!existsSync(head) && dirname(head) !== head) {
    missing.unshift(basename(head));
    head = dirname(head);
  }
  return join(realpathSync(head), ...missing);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = {};
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith('--')) throw new SetupError(`unexpected argument: ${rest[i]}`);
    const name = rest[i].slice(2);
    if (COMMAND_FLAGS[command] && !COMMAND_FLAGS[command].includes(name)) throw new SetupError(`unknown flag --${name}`);
    if (FLAGS.has(name)) {
      opts[name] = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) throw new SetupError(`${rest[i]} needs a value`);
    opts[rest[i].slice(2)] = value;
    i++;
  }
  return { command, opts };
}

function rootOf(opts) {
  return real(opts.root ?? gitOut(process.cwd(), ['rev-parse', '--show-toplevel']));
}

function hasMarker(file) {
  return existsSync(file) && MARKERS.has(readFileSync(file, 'utf8').split('\n')[1]);
}

function writeAtomic(file, body, mode) {
  const temp = join(dirname(file), `.${basename(file)}.quiz-tmp`);
  writeFileSync(temp, body);
  chmodSync(temp, mode);
  renameSync(temp, file);
}

function layoutOf(root) {
  const hooks = real(resolve(root, gitOut(root, ['rev-parse', '--git-path', 'hooks'])));
  if (hooks === real(join(gitCommonDir(root), 'hooks'))) return { kind: 'default', hooks };
  const rel = relative(root, hooks);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new SetupError('hooks dir is outside this repo');
  if (!existsSync(hooks)) throw new SetupError('run npm install first');
  const ignored = git(root, ['check-ignore', '-q', join(hooks, 'pre-push')]);
  if (ignored.status === 1) throw new SetupError('hooks dir is tracked; install would change a team file');
  if (ignored.status !== 0) throw new SetupError(`git check-ignore failed: ${ignored.stderr.trim()}`);
  return { kind: existsSync(join(hooks, 'h')) ? 'husky' : 'ignored', hooks };
}

function install(root) {
  const { kind, hooks } = layoutOf(root);
  const hook = join(hooks, 'pre-push');
  const check = join(hooks, 'quiz-check.mjs');
  const ours = hasMarker(hook);
  const stockHusky = kind === 'husky' && existsSync(hook) && readFileSync(hook, 'utf8') === HUSKY_WRAPPER;
  if (existsSync(hook) && !ours && !stockHusky) throw new SetupError('pre-push exists; chain it by hand');
  if (existsSync(check) && !hasMarker(check)) throw new SetupError('quiz-check.mjs exists; not ours');
  mkdirSync(hooks, { recursive: true });
  writeAtomic(check, readFileSync(CHECK_SOURCE), 0o755);
  writeAtomic(hook, kind === 'husky' ? HUSKY_HOOK : DEFAULT_HOOK, 0o755);
  return ours ? 'installed (already)' : 'installed';
}

function uninstall(root) {
  let layout;
  try {
    layout = layoutOf(root);
  } catch (e) {
    if (e instanceof SetupError) return 'not installed';
    throw e;
  }
  const hook = join(layout.hooks, 'pre-push');
  const check = join(layout.hooks, 'quiz-check.mjs');
  let removed = false;
  if (hasMarker(hook)) {
    if (layout.kind === 'husky') writeAtomic(hook, HUSKY_WRAPPER, 0o755);
    else rmSync(hook);
    removed = true;
  }
  if (hasMarker(check)) {
    rmSync(check);
    removed = true;
  }
  return removed ? 'removed' : 'not installed';
}

function status(root) {
  let installed = false;
  try {
    const { hooks } = layoutOf(root);
    installed = hasMarker(join(hooks, 'pre-push')) && hasMarker(join(hooks, 'quiz-check.mjs'));
  } catch (e) {
    if (!(e instanceof SetupError)) throw e;
  }
  return `hook: ${installed ? 'installed' : 'missing'}\npasses: ${readLedger(ledgerPath(root)).size}`;
}

/**
 * First-parent base of the quiz range, or null when every unpushed commit has a pass.
 * A commit counts as unpassed when it, or a side-branch commit it merged in, has an identity missing from `passed`.
 */
export function quizBase(cwd, tip, remote, passed) {
  const firstParents = gitRaw(cwd, ['rev-list', '--first-parent', '--reverse', tip, '--not', `--remotes=${remote}`]).split('\n').filter(Boolean);
  for (const sha of firstParents) {
    const parent = git(cwd, ['rev-parse', '--verify', '-q', `${sha}^1`]);
    const brought = parent.status === 0
      ? gitRaw(cwd, ['rev-list', sha, '--not', `${sha}^1`, `--remotes=${remote}`])
      : gitRaw(cwd, ['rev-list', sha, '--not', `--remotes=${remote}`]);
    const unpassed = brought.split('\n').filter(Boolean).some((c) => {
      const id = commitIdentity(cwd, c);
      return id !== null && !passed.has(id);
    });
    if (!unpassed) continue;
    return parent.status === 0 ? parent.stdout.trim() : gitRaw(cwd, ['hash-object', '-t', 'tree', '/dev/null']).trim();
  }
  return null;
}

function excludedFile(path) {
  const parts = path.split('/');
  const name = parts.at(-1);
  return parts.slice(0, -1).some((dir) => SKIPPED_DIRS.has(dir))
    || /\.(test|spec)\./.test(name)
    || LOCKFILES.has(name)
    || /\.(md|mdx|txt)$/i.test(name);
}

function excludedLine(code) {
  const text = code.trim();
  return !/[\p{L}\p{N}]/u.test(text)
    || /^import(?=[\s{*'"])/.test(text)
    || /^(\/\/|\/\*|\*\/|\*(\s|$)|#(\s|$)|<!--)/.test(text);
}

function addedLines(patch) {
  let hunkText = null;
  let line = 0;
  const found = [];
  for (const row of patch.split('\n')) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row);
    if (header) {
      hunkText = [row];
      line = Number(header[1]);
      continue;
    }
    if (hunkText === null || row === '' || row.startsWith('\\')) continue;
    hunkText.push(row);
    if (row.startsWith('+')) found.push({ line: line++, code: row.slice(1), hunkText });
    else if (row.startsWith(' ')) line++;
  }
  return found;
}

function gitlinkPaths(cwd, diffArgs, base, tip) {
  const fields = gitRaw(cwd, [...diffArgs, '--raw', '-z', base, tip]).split('\0');
  const paths = new Set();
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [oldMode, newMode] = fields[i].slice(1).split(' ');
    if (oldMode === '160000' || newMode === '160000') paths.add(fields[i + 1]);
  }
  return paths;
}

function blamedCommits(cwd, tip, file) {
  const byLine = new Map();
  for (const row of gitRaw(cwd, ['blame', '--porcelain', '--ignore-revs-file', '', tip, '--', file]).split('\n')) {
    const header = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(row);
    if (header) byLine.set(Number(header[2]), header[1]);
  }
  return byLine;
}

/**
 * Added lines of `git diff base tip` that a question may use. `hunk` numbers hunks across the whole diff;
 * `hunkText` is the diff text of that hunk, for the grader packet.
 * With `ownCommits`, only lines whose blame at `tip` is one of those commits count, so lines merged in from the remote are skipped.
 */
export function eligibleLines(cwd, base, tip, ownCommits) {
  const diffArgs = ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--no-renames'];
  const stats = gitRaw(cwd, [...diffArgs, '--numstat', '-z', base, tip]).split('\0').filter(Boolean);
  const gitlinks = gitlinkPaths(cwd, diffArgs, base, tip);
  const lines = [];
  const hunkIds = new Map();
  for (const stat of stats) {
    const [added, , ...rest] = stat.split('\t');
    const file = rest.join('\t');
    if (added === '-' || added === '0' || excludedFile(file) || gitlinks.has(file)) continue;
    const patch = gitRaw(cwd, [...diffArgs, base, tip, '--', `:(literal)${file}`]);
    const blamed = ownCommits ? blamedCommits(cwd, tip, file) : null;
    for (const { line, code, hunkText } of addedLines(patch)) {
      if (excludedLine(code)) continue;
      if (blamed && !ownCommits.has(blamed.get(line))) continue;
      if (!hunkIds.has(hunkText)) hunkIds.set(hunkText, hunkIds.size + 1);
      lines.push({ file, line, code, hunk: hunkIds.get(hunkText), hunkText: hunkText.join('\n') });
    }
  }
  return lines;
}

/**
 * Picks up to four lines: the priority lines first, then one random line per hunk, then any remaining line.
 * A random pick is never within five lines of an already picked line in the same file.
 */
export function chooseLines(eligible, priority, rand) {
  const picked = priority.slice(0, MAX_PRIORITY);
  const key = (l) => `${l.file}:${l.line}`;
  const taken = new Set(picked.map(key));
  const apart = (l) => !taken.has(key(l)) && picked.every((p) => p.file !== l.file || Math.abs(p.line - l.line) >= MIN_LINE_GAP);
  const take = (candidates) => {
    const free = candidates.filter(apart);
    if (free.length === 0) return false;
    picked.push(free[rand(free.length)]);
    return true;
  };
  const hunks = [...new Set(eligible.map((l) => l.hunk))];
  for (let i = hunks.length - 1; i > 0; i--) {
    const j = rand(i + 1);
    [hunks[i], hunks[j]] = [hunks[j], hunks[i]];
  }
  const represented = new Set(picked.map((l) => l.hunk));
  for (const hunk of hunks) {
    if (picked.length >= MAX_LINE_QUESTIONS) break;
    if (!represented.has(hunk)) take(eligible.filter((l) => l.hunk === hunk));
  }
  while (picked.length < MAX_LINE_QUESTIONS && take(eligible));
  return picked;
}

/** Entries of the `not covered` and `proposed equivalents` lines of teeth-build result blocks, each with its block's base. */
export function priorityEntries(planText) {
  const entries = [];
  let base = null;
  for (const row of planText.split('\n')) {
    const baseMatch = /^\s*-\s*base:\s*([0-9a-f]{4,40})\b/.exec(row);
    if (baseMatch) {
      base = baseMatch[1];
      continue;
    }
    if (!base) continue;
    const covered = /^\s*-\s*not covered:\s*(.+?):(\d+)(?:\s|$)/.exec(row);
    if (covered) {
      entries.push({ kind: 'not covered', file: covered[1], line: Number(covered[2]), base });
      continue;
    }
    const equivalent = /^\s*-\s*proposed equivalents:\s*(.+?):(\d+)\s+(\S+)\s+→\s+(?:`([^`]*)`|(\S+))/.exec(row);
    if (equivalent) {
      entries.push({ kind: 'equivalent', file: equivalent[1], line: Number(equivalent[2]), base, mutator: equivalent[3], replacement: equivalent[4] ?? equivalent[5] });
    }
  }
  return entries;
}

/** Values of the `assumptions:` and `decisions:` lines other than `none`. */
export function assumptionLines(planText) {
  const values = [];
  for (const row of planText.split('\n')) {
    const match = /^\s*-\s*(?:assumptions|decisions):\s*(.+?)\s*$/.exec(row);
    if (match && match[1] !== 'none') values.push(match[1]);
  }
  return values;
}

function resolvePriority(cwd, tip, entries, eligible) {
  const lines = [];
  const skipped = [];
  for (const entry of entries.slice(0, MAX_PRIORITY)) {
    const found = lookupPriority(cwd, tip, entry, eligible);
    if (found) lines.push({ ...found, kind: entry.kind, mutator: entry.mutator, replacement: entry.replacement });
    else skipped.push(`skipped priority: ${entry.file}:${entry.line} moved or not found`);
  }
  return { lines, skipped };
}

function lookupPriority(cwd, tip, entry, eligible) {
  try {
    const taskCommit = gitRaw(cwd, ['rev-list', '--first-parent', '--reverse', `${entry.base}..${tip}`]).split('\n')[0];
    if (!taskCommit) return null;
    const text = gitRaw(cwd, ['show', `${taskCommit}:${entry.file}`]).split('\n')[entry.line - 1]?.trim();
    if (!text) return null;
    const matches = eligible.filter((l) => l.file === entry.file && l.code.trim() === text);
    return matches.length === 1 ? matches[0] : null;
  } catch (e) {
    if (e instanceof SetupError) return null;
    throw e;
  }
}

function contextBlock(cwd, tip, file, line) {
  const rows = gitRaw(cwd, ['show', `${tip}:${file}`]).replace(/\n$/, '').split('\n');
  const from = Math.max(1, line - CONTEXT_RADIUS);
  const to = Math.min(rows.length, line + CONTEXT_RADIUS);
  const width = String(to).length;
  const out = [];
  for (let n = from; n <= to; n++) out.push(`${n === line ? '>' : ' '} ${String(n).padStart(width)}  ${rows[n - 1]}`);
  return out.join('\n');
}

function lineQuestion(cwd, tip, l) {
  const code = l.code.trim();
  const where = `\`${l.file}:${l.line}\``;
  const text = l.kind === 'equivalent'
    ? `${where} is \`${code}\`. Mutation testing (\`${l.mutator}\`) replaced part of it with \`${l.replacement}\` and no test failed. Can any caller see a difference? Explain why or why not.`
    : `${where} is \`${code}\` (context shown below). What does this line do, and what breaks if it is removed or changed?`;
  return { kind: l.kind === 'equivalent' ? 'equivalent' : 'line', file: l.file, line: l.line, text, context: contextBlock(cwd, tip, l.file, l.line), hunk: l.hunkText };
}

function assumptionQuestion(recorded) {
  const text = recorded.length > 0
    ? `The build recorded these assumptions and decisions: ${recorded.join('; ')}. Which one does this change depend on most, and what breaks if it is wrong?`
    : 'What is the main assumption this change depends on that the code does not check, and what breaks if it is wrong?';
  return { kind: 'assumption', text };
}

function defaultRemote(root) {
  const upstream = git(root, ['rev-parse', '--abbrev-ref', '@{u}']);
  return upstream.status === 0 && upstream.stdout.includes('/') ? upstream.stdout.trim().split('/')[0] : 'origin';
}

function writeAttempt(root, body) {
  const id = `${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${randomBytes(4).toString('hex')}`;
  const dir = join(gitCommonDir(root), 'quiz', 'attempts');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), JSON.stringify({ ...body, createdAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
  return id;
}

function readPlan(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch (e) {
    throw new SetupError(`cannot read plan ${file}: ${e.message}`);
  }
}

function pick(root, opts) {
  const plan = opts.plan === undefined ? '' : readPlan(opts.plan);
  const remote = opts.remote ?? defaultRemote(root);
  const tip = gitOut(root, ['rev-parse', 'HEAD']);
  const base = quizBase(root, tip, remote, readLedger(ledgerPath(root)));
  if (base === null) return JSON.stringify({ status: 'nothing to quiz' });
  const unpushedShas = unpushed(root, tip, remote);
  const ids = unpushedShas.map((sha) => commitIdentity(root, sha)).filter((id) => id !== null);
  const eligible = eligibleLines(root, base, tip, new Set(unpushedShas));
  if (eligible.length === 0) {
    const attempt = writeAttempt(root, { tip, base, remote, ids, questions: [] });
    return JSON.stringify({ status: 'no eligible lines', attempt });
  }
  const { lines: priority, skipped } = resolvePriority(root, tip, priorityEntries(plan), eligible);
  const chosen = chooseLines(eligible, priority, (n) => randomInt(n));
  const questions = [...chosen.map((l) => lineQuestion(root, tip, l)), assumptionQuestion(assumptionLines(plan))]
    .map((q, i) => ({ n: i + 1, ...q }));
  const attempt = writeAttempt(root, { tip, base, remote, ids, questions });
  return JSON.stringify({ status: 'quiz', attempt, questions, skipped });
}

/**
 * Per-question verdicts of a grader reply, or null when the reply is not in the agreed form:
 * `score: K/N` first, N equal to `n`, `q1..qN` verdict lines in order, K equal to the pass count.
 */
export function parseGrades(text, n) {
  const rows = text.split('\n').map((row) => row.trimEnd());
  const first = rows.find((row) => row.trim() !== '');
  const score = /^score: (\d+)\/(\d+)$/.exec(first ?? '');
  if (!score || Number(score[2]) !== n) return null;
  const verdicts = [];
  for (const row of rows) {
    if (!/^q\d+:/.test(row)) continue;
    const verdict = /^q(\d+): (pass|fail)$/.exec(row);
    if (!verdict || Number(verdict[1]) !== verdicts.length + 1) return null;
    verdicts.push(verdict[2]);
  }
  if (verdicts.length !== n || verdicts.filter((v) => v === 'pass').length !== Number(score[1])) return null;
  return verdicts;
}

function readAttempt(root, id) {
  const file = join(gitCommonDir(root), 'quiz', 'attempts', `${id}.json`);
  if (!ATTEMPT_ID.test(id) || !existsSync(file)) throw new SetupError('unknown attempt');
  return { file, attempt: JSON.parse(readFileSync(file, 'utf8')) };
}

function appendPasses(root, attempt, id) {
  const shaById = new Map();
  for (const sha of unpushed(root, attempt.tip, attempt.remote)) {
    const identity = commitIdentity(root, sha);
    if (identity !== null && !shaById.has(identity)) shaById.set(identity, sha);
  }
  const at = new Date().toISOString();
  const ids = [...new Set(attempt.ids)];
  const file = ledgerPath(root);
  mkdirSync(dirname(file), { recursive: true });
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const torn = existing !== '' && !existing.endsWith('\n');
  const lines = ids.map((identity) => `${JSON.stringify({ id: identity, sha: shaById.get(identity) ?? null, at, attempt: id })}\n`);
  appendFileSync(file, (torn ? '\n' : '') + lines.join(''));
  return ids.length;
}

function record(root, opts) {
  const id = opts.attempt ?? '';
  if ((opts.grades === undefined) === (opts['no-eligible'] === undefined)) throw new SetupError('record needs --attempt and one of --grades or --no-eligible');
  const { file, attempt } = readAttempt(root, id);
  if (attempt.tip !== gitOut(root, ['rev-parse', 'HEAD'])) throw new SetupError('range changed; run pick again');
  const n = attempt.questions.length;
  if (attempt.score !== undefined && attempt.score !== null && attempt.score !== `${n}/${n}`) throw new SetupError('attempt already graded; run pick again');
  let score = null;
  if (opts['no-eligible'] !== undefined) {
    if (n > 0) throw new SetupError('attempt has questions; --no-eligible refused');
  } else {
    let text;
    try {
      text = readFileSync(opts.grades, 'utf8');
    } catch (e) {
      throw new SetupError(`cannot read grades ${opts.grades}: ${e.message}`);
    }
    const verdicts = n > 0 ? parseGrades(text, n) : null;
    if (verdicts === null) throw new SetupError('grader reply does not match the attempt');
    score = `${verdicts.filter((v) => v === 'pass').length}/${n}`;
  }
  const scoredAt = new Date().toISOString();
  if (score !== null && score !== `${n}/${n}`) {
    writeFileSync(file, JSON.stringify({ ...attempt, score, scoredAt }, null, 2));
    throw new Finding(`score ${score}; nothing recorded`);
  }
  const count = appendPasses(root, attempt, id);
  writeFileSync(file, JSON.stringify({ ...attempt, score, scoredAt }, null, 2));
  return `recorded ${count} commits`;
}

const COMMANDS = { install, uninstall, status, pick, record };

function main(argv) {
  try {
    const { command, opts } = parseArgs(argv);
    const run = COMMANDS[command];
    if (!run) throw new SetupError(`usage: quiz.mjs <${Object.keys(COMMANDS).join('|')}> [--root <dir>]`);
    console.log(run(rootOf(opts), opts));
    return 0;
  } catch (e) {
    if (e instanceof Finding) {
      console.log(e.message);
      return 1;
    }
    console.error(e.message);
    return 3;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
