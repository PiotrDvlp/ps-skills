# Invocation

## Assembling the prompt

The skill runs as a standalone `.mjs` script (Node v22.21.1, ESM, no
`package.json`) that Claude writes to a temp file and executes with `node
<script>` — it is not pasted into a REPL and its cwd is whatever the shell's
cwd happened to be at invocation time, not the skill directory. An `import`
specifier that is relative (e.g. `'../scripts/build-prompt.mjs'`) resolves
against the *temp script's own location*, not against this skill's directory —
so it breaks the moment the temp script lives anywhere other than one fixed,
undocumented spot. `readFileSync` with a relative path is worse: it resolves
against the process cwd, which is whatever directory the shell happened to be
in, and is never the skill directory either. Use absolute paths for both,
anchored on the skill's own directory (computed once via `os.homedir()`, never
hand-typed per user):

```javascript
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Anchor: this skill's own directory. Stable regardless of where the temp
// script is written or what the shell's cwd is when it runs.
const SKILL_DIR = join(homedir(), '.claude', 'skills', 'second-view');

const { buildPrompt } = await import(join(SKILL_DIR, 'scripts', 'build-prompt.mjs'));

const prompt = buildPrompt({
  rubric: readFileSync(join(SKILL_DIR, 'references', 'rubric-proposal.md'), 'utf8'),
  brief:  readFileSync(briefPath, 'utf8'), // briefPath must itself be absolute
});
```

(A static `import` specifier must be a string literal, so it cannot be built
from `SKILL_DIR` directly — hence the dynamic `await import(...)` above. If
the temp script is always written inside `SKILL_DIR` itself, a static relative
import is fine, but then say so explicitly at the point the temp file is
created; do not leave it implicit.)

Quote every path that touches a shell command — the vault path
(a notes root such as `~/Notes/My Vault/...`) contains a space, and an unquoted path
silently splits into two arguments.

Write `prompt` to a temp file (see references/save-note.md and Failure
handling below for temp-file lifecycle) and record where the temp files live
(a fresh directory made with `mkdtemp`, cleaned up per the Failure-handling
table) so the invocation script and the reader agree on the same location.
Never assemble the prompt by hand — `buildPrompt` is what strips the withheld
half and it is the only part of that path under test.

## Refusing unrecognized flags before building argv

`assertSafeArgs` is a refusal gate on the user's `/second-view` invocation
line, not an argv-assembly step. `buildCodexArgs` keeps its exact current
signature (`model, outFile, repoRoot, deep`) — extras are NEVER appended to
the Codex argv, per Hard rule 1. The guard exists only to refuse the
invocation outright, before any prompt or argv gets built:

1. Collect every flag on the `/second-view` invocation line that is not one of
   the seven recognized flags (the two positional forms, `--deep`, `--model`,
   `--save`, `--keep-prompt`, `--repo`) into an array `extra`.
2. Call `assertSafeArgs(extra)` first, before building the prompt or the argv.
   If it throws, print the message and stop.

```javascript
const { assertSafeArgs, assertCodexSandboxUsable, buildCodexArgs } = await import(join(SKILL_DIR, 'scripts', 'codex-args.mjs'));

assertSafeArgs(extra);   // throws on any --sandbox override; extra is never used again
assertCodexSandboxUsable();   // throws when run inside the harness sandbox
const argv = buildCodexArgs({ model, outFile, repoRoot, deep });
```

Run the invocation script with Bash `dangerouslyDisableSandbox: true`. Codex's
`-s read-only` is itself a Seatbelt sandbox, and Seatbelt cannot nest: inside
the harness sandbox every Codex shell command fails with `sandbox_apply:
Operation not permitted`, and the proposal comes back with no file reads
behind it. `assertCodexSandboxUsable` catches this before any API call.
Turning off the harness sandbox does not weaken Hard rule 1, because Codex
still runs `-s read-only`.

## Running

The shape below is illustrative of what `buildCodexArgs` produces — it is NOT
a command to copy-paste and run. Building the real argv means calling
`buildCodexArgs` (above) and executing that array directly (e.g. via
`node:child_process` `spawn`), never hand-typing a `codex exec ...` line. See
the `SKILL.md` Gotcha: hand-writing this line is how `--model` or `--deep`
edits silently lose the `gpt-5.6-pro` rejection, the single-`-s` guarantee, or
correct `-c` placement.

```bash
# Illustrative only — the resulting argv shape, not an invocation to run.
codex exec -m gpt-5.6-sol -s read-only --skip-git-repo-check [-C <repo-root>] \
  -o <tmp-out> - < <tmp-prompt>
```

`< file` streams via stdin. Two forms to avoid: `"$(cat prompt)"` puts the whole
artifact in argv and hits `ARG_MAX`; `<<<"$(cat prompt)"` feeds stdin but the
shell still buffers the file in memory first and strips trailing newlines.

## Model resolution

Default `gpt-5.6-sol`. `gpt-6-astra` is the top tier, an explicit opt-in for
hard, high-stakes design calls, matching `codex-build` and `codex-review`.
`--deep` appends `-c model_reasoning_effort="xhigh"` to the ALREADY-RESOLVED
model rather than switching models — `--deep --model gpt-5.6-terra` runs Terra
at xhigh.

`buildCodexArgs` accepts only `ALLOWED_MODELS` (`gpt-6-astra`, `gpt-5.6-sol`,
`gpt-5.6-terra`, `gpt-5.6-luna`, the same list as `codex-review`'s
`code-review-core.mjs`). `gpt-5.6-pro` gets its own error: it returns HTTP 400
"not supported when using Codex with a ChatGPT account". `gpt-5.6-codex` and
`gpt-5.5-codex` do not exist.

## Failure handling

Every failure stops the run and reports. Nothing is retried silently.

| Condition | Detection | Behavior |
|---|---|---|
| `codex` not on PATH | `command -v codex` pre-flight | Abort; tell the user to install Codex CLI 0.130.0+ |
| Nested sandbox | `assertCodexSandboxUsable` pre-flight | Abort; re-run with `dangerouslyDisableSandbox: true` |
| Nonzero exit from `codex exec` | shell exit status | Surface stderr verbatim, abort |
| Wall-clock overrun | 600 s timeout | Kill, report the timeout, abort |
| Output file missing or empty | `test -s <tmp-out>` | Abort, surface the captured stdout log |
| Missing any of the 5 headings | grep per heading | Surface raw output, abort — never synthesize from a malformed proposal |
| Temp files | always | Remove on success and abort alike, unless `--keep-prompt` was passed |

There is no partial-success path: there is exactly one Codex call.
