// Shared fixtures: throwaway git repos and a fake `codex` executable.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'cxr-test-'));
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  return { dir, g, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function write(dir, rel, content) {
  const p = join(dir, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
  return p;
}

export function commitAll(g, msg = 'c') {
  g('add', '-A');
  g('commit', '-qm', msg);
  return g('rev-parse', 'HEAD').trim();
}

/**
 * Fake `codex` on PATH. `behavior`:
 *   { json, model, stdout, stderr, exit, mutate }
 *
 * The session header goes to STDERR, matching codex-cli 0.144.5. Getting this
 * wrong is not cosmetic: a fake that prints the header to stdout hides the exact
 * bug that aborted every real run with model_unresolved. Keep the fake faithful
 * to the stream placement, not just the content.
 *
 * For the same reason the labels carry the real SGR bold escapes and the run is
 * preceded by the models-cache ERROR line: 0.144.5 emits both even when stderr
 * is a pipe, and an unstyled fake hid a second model_unresolved abort.
 *
 * `mutate` is a shell snippet run before exiting, used to simulate drift.
 */
export function makeFakeCodex(behavior = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cxr-fake-'));
  const b = (label) => `\x1b[1m${label}\x1b[0m`;
  const header = [
    '\x1b[2m2026-01-01T00:00:00.000000Z\x1b[0m \x1b[31mERROR\x1b[0m '
    + '\x1b[2mcodex_models_manager::cache\x1b[0m\x1b[2m:\x1b[0m failed to load '
    + 'models cache: missing field `supports_reasoning_summaries` at line 87 column 5',
    'OpenAI Codex v0.144.5', '--------', `${b('workdir:')} /tmp/fake`,
    `${b('model:')} ${behavior.model ?? 'gpt-5.6-terra'}`,
    `${b('provider:')} openai`, `${b('approval:')} never`,
    `${b('sandbox:')} read-only`, '--------',
  ].join('\n');
  const script = `#!/bin/sh
# parse -o <file>
OUT=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) OUT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat > /dev/null   # drain stdin (the prompt)
${behavior.mutate ?? ''}
# Heredoc, not printf '%s': %s does not interpret \\n in its ARGUMENT, so the
# multi-line header would collapse to one literal line and the ^model: anchor
# would never match.
cat >&2 <<'HDREOF'
${header}
HDREOF
${behavior.stderr ? `cat >&2 <<'ERREOF'\n${behavior.stderr}\nERREOF` : ''}
${behavior.stdout ? `cat <<'OUTEOF'\n${behavior.stdout}\nOUTEOF` : ''}
if [ -n "$OUT" ]; then
  cat > "$OUT" <<'FAKEEOF'
${behavior.json ?? '{}'}
FAKEEOF
fi
exit ${behavior.exit ?? 0}
`;
  const p = join(dir, 'codex');
  writeFileSync(p, script);
  chmodSync(p, 0o755);
  return { dir, path: p, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function goodResult(overrides = {}) {
  return JSON.stringify({
    protocol_version: 'codex-review-code/v1',
    verdict: 'PASS',
    issues: [],
    unresolved_assumptions: [],
    ...overrides,
  }, null, 2);
}
