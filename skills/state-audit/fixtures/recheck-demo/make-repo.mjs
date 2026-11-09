#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXED_DATE = '2026-01-01T00:00:00Z';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'state-audit demo',
  GIT_AUTHOR_EMAIL: 'demo@example.com',
  GIT_AUTHOR_DATE: FIXED_DATE,
  GIT_COMMITTER_NAME: 'state-audit demo',
  GIT_COMMITTER_EMAIL: 'demo@example.com',
  GIT_COMMITTER_DATE: FIXED_DATE,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

const QUERY_LIB = `export async function runQuery(fetcher, { onResult, onError } = {}, client = { defaults: {} }) {
  try {
    onResult?.(await fetcher());
  } catch (err) {
    const policy = client.defaults.errorPolicy;
    if (policy && policy !== 'none') onResult?.(null);
    onError?.(err);
  }
}
`;

const client = (defaults) => `export const client = { defaults: ${defaults} };\n`;

const FLAG = `let itemLoading = false;

export const setItemLoading = (value) => {
  itemLoading = value;
};

export const isItemLoading = () => itemLoading;
`;

const loader = ({ name, statePath, libPath, clientPath, onError }) => `import { runQuery } from '${libPath}';
import { client } from '${clientPath}';
import { setItemLoading } from '${statePath}';

export async function ${name}(id, fetcher) {
  setItemLoading(true);
  await runQuery(fetcher, {
    onResult: () => setItemLoading(false),${onError ? '\n    onError: () => setItemLoading(false),' : ''}
  }, client);
}
`;

const app = ({ loaderPath, name, statePath }) => `import { ${name} } from '${loaderPath}';
export { isItemLoading } from '${statePath}';

export async function selectItem(id, fail) {
  await ${name}(id, async () => {
    if (fail) throw new Error('network');
    return { id };
  });
}
`;

const V1 = {
  'lib/query.mjs': QUERY_LIB,
  'src/client.mjs': client('{}'),
  'src/store.mjs': FLAG,
  'src/loadItem.mjs': loader({ name: 'loadItem', statePath: './store.mjs', libPath: '../lib/query.mjs', clientPath: './client.mjs' }),
  'app.mjs': app({ loaderPath: './src/loadItem.mjs', name: 'loadItem', statePath: './src/store.mjs' }),
};

const moved = (overrides = {}) => ({
  'lib/query.mjs': QUERY_LIB,
  'src/client.mjs': client('{}'),
  'src/item/state.mjs': FLAG,
  'src/item/useItem.mjs': loader({ name: 'useItem', statePath: './state.mjs', libPath: '../../lib/query.mjs', clientPath: '../client.mjs', ...overrides }),
  'app.mjs': app({ loaderPath: './src/item/useItem.mjs', name: 'useItem', statePath: './src/item/state.mjs' }),
});

const V5 = moved({ libPath: 'query-lib' });
delete V5['lib/query.mjs'];

const SNAPSHOTS = [
  ['v1-defect', 'demo: item loading with a store flag', V1],
  ['v2-moved', 'refactor: move item loading under src/item', moved()],
  ['v3-fixed', 'fix: release the loading flag on error', moved({ onError: true })],
  ['v4-wrapper', 'chore: client runs result callbacks on errors', { ...moved(), 'src/client.mjs': client("{ errorPolicy: 'all' }") }],
  ['v5-missing', 'chore: use the query-lib package', V5],
];

class UsageError extends Error {}

function isNonEmptyDir(dir) {
  return existsSync(dir) && readdirSync(dir).length > 0;
}

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...GIT_ENV } }).trim();
}

function writeSnapshot(repo, files) {
  for (const entry of readdirSync(repo)) {
    if (entry !== '.git') rmSync(join(repo, entry), { recursive: true, force: true });
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
}

function seededNote(repoName, rootCommit, v1) {
  return `---
schema: 1
repo_name: ${repoName}
repo_root_commit: ${rootCommit}
target_branch: main
---

# State audit: ${repoName}

## Machines

### M001: Item loading
- coverage: full
- evidence_revision: ${v1}

Invariants:
- M001-I1 [code contract]: the item loading flag is false once the item request has settled

State: the item loading flag (authoritative), set before the query and cleared by its callbacks.

## Findings

### F001: Failed item request leaves the loading flag set
- machine: M001
- invariant: M001-I1
- lifecycle: open
- disposition: proposed
- severity: P2

#### Locator
Purpose: load the selected item. State role: pending-request flag. Trigger: rejection of the item
query. Violation: the flag stays true after the request ended. Anchors: every writer of the flag,
the query call, its error callback, the client defaults, the query library.

#### Trace
selectItem with a failing fetcher -> the flag is set to true -> runQuery catches the error -> with
no client errorPolicy it does not call onResult -> no onError is passed -> the flag stays true.

#### Dependencies
Client defaults (\`src/client.mjs\`): no errorPolicy. Query library (\`lib/query.mjs\`): calls
onResult on error only when an errorPolicy other than none is set.

#### Recipe
\`\`\`bash
REV=v1-defect
git grep -n "isItemLoading\\|setItemLoading" "\${REV}"
git grep -n "onError" "\${REV}" -- src
git show "\${REV}:src/client.mjs"
\`\`\`

#### Observations

| run | revision | assessment | confidence | verification | on_target | note |
| --- | --- | --- | --- | --- | --- | --- |
| R000 | ${v1} | present | confirmed | code_trace | unknown | seeded |

## Issues
`;
}

export function makeDemo(repoDir, outDir) {
  if (!repoDir || !outDir) throw new UsageError('Usage: node make-repo.mjs <repo-dir> <out-dir>');
  for (const dir of [repoDir, outDir]) {
    if (isNonEmptyDir(dir)) throw new UsageError(`${dir} exists and is not empty`);
  }
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(outDir, { recursive: true });
  git(repoDir, '-c', 'init.defaultBranch=main', 'init', '-q');
  for (const [tag, message, files] of SNAPSHOTS) {
    writeSnapshot(repoDir, files);
    git(repoDir, 'add', '-A');
    git(repoDir, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
    git(repoDir, 'tag', tag);
  }
  const root = git(repoDir, 'rev-list', '--max-parents=0', 'HEAD');
  const v1 = git(repoDir, 'rev-parse', 'v1-defect');
  const note = join(outDir, `${basename(repoDir)}.md`);
  writeFileSync(note, seededNote(basename(repoDir), root, v1));
  return { tags: SNAPSHOTS.map(([tag]) => tag), note };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const { tags, note } = makeDemo(process.argv[2], process.argv[3]);
    process.stdout.write(`tags: ${tags.join(', ')}\nnote: ${note}\n`);
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}
