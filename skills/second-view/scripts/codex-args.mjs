// Builds the Codex invocation. `-s read-only` is hardcoded as adjacent tokens
// and there is deliberately no parameter to change it: the read-only sandbox is
// what makes Codex a trustable independent generator in this skill.
import { execFileSync } from 'node:child_process';

const FORBIDDEN = [
  'danger-full-access',
  'dangerously-bypass-approvals-and-sandbox',
  'workspace-write',
];

export const ALLOWED_MODELS = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];

export function assertSafeArgs(extra = []) {
  // A STRING defeats every check below: `for (const a of 'x')` iterates
  // characters, so each includes() runs against a single character and returns
  // false. A vacuous safety guard must fail loudly rather than pass silently.
  if (!Array.isArray(extra)) {
    throw new Error(
      `extra args must be an array of separate arguments, got ${typeof extra} — `
      + 'a string is iterated per character, which defeats every check below',
    );
  }
  for (const a of extra) {
    const lower = String(a).toLowerCase();
    if (lower.includes('--sandbox')) {
      throw new Error(`--sandbox override is forbidden in second-view: ${a}`);
    }
    for (const f of FORBIDDEN) {
      if (lower.includes(f)) throw new Error(`${f} is forbidden`);
    }
  }
}

/**
 * Refuse to run `codex exec` inside another Seatbelt sandbox.
 *
 * @remarks
 * Seatbelt cannot nest: from inside the Claude Code Bash sandbox, `-s read-only`
 * fails every Codex shell command with `sandbox_apply: Operation not permitted`.
 * A no-op `sandbox-exec` makes the same syscall, so it answers in milliseconds.
 * Same probe as `codex-build/scripts/implement.mjs` `assertCodexSandboxUsable`.
 *
 * @param probe - injectable runner; throws when a nested sandbox cannot be created.
 */
export function assertCodexSandboxUsable(probe = () => execFileSync(
  'sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' },
)) {
  if (process.platform !== 'darwin') return;
  try {
    probe();
  } catch {
    throw new Error(
      'nested sandbox: `codex exec -s read-only` runs its own Seatbelt sandbox and Seatbelt '
      + 'cannot nest, so every Codex command would fail with `sandbox_apply: Operation not '
      + 'permitted`. Re-run the invocation script with the harness sandbox off '
      + '(Bash `dangerouslyDisableSandbox: true`), or from a shell outside the sandbox.',
    );
  }
}

export function buildCodexArgs({ model, outFile, repoRoot, deep = false }) {
  if (!model || !outFile) throw new Error('model and outFile are required');
  if (model === 'gpt-5.6-pro') {
    throw new Error(
      'gpt-5.6-pro is not supported when using Codex with a ChatGPT account (HTTP 400)',
    );
  }
  if (!ALLOWED_MODELS.includes(model)) {
    throw new Error(`model ${model} is not allowed; pick one of ${ALLOWED_MODELS.join(', ')}`);
  }

  const argv = ['exec', '-m', model, '-s', 'read-only', '--skip-git-repo-check'];
  if (deep) argv.push('-c', 'model_reasoning_effort="xhigh"');
  if (repoRoot) argv.push('-C', repoRoot);
  argv.push('-o', outFile, '-');
  return argv;
}
