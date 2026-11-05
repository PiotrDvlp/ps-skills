#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitCommonDir, ledgerPath, readLedger } from './quiz-check.mjs';

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
cat > "$t"
node "$(dirname "$0")/quiz-check.mjs" "$@" < "$t" || exit $?
. "$(dirname "$0")/h" "$@" < "$t"
`;

class SetupError extends Error {}

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.error) throw new SetupError(`git ${args[0]}: ${r.error.message}`);
  return r;
}

function gitOut(cwd, args) {
  const r = git(cwd, args);
  if (r.status !== 0) throw new SetupError(`git ${args.join(' ')} failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
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

const COMMANDS = { install, uninstall, status };

function main(argv) {
  try {
    const { command, opts } = parseArgs(argv);
    const run = COMMANDS[command];
    if (!run) throw new SetupError(`usage: quiz.mjs <${Object.keys(COMMANDS).join('|')}> [--root <dir>]`);
    console.log(run(rootOf(opts), opts));
    return 0;
  } catch (e) {
    console.error(e.message);
    return 3;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
