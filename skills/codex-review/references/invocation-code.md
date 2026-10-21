# Invocation — code mode

Code mode does **not** use the `codex review` subcommand. It runs
`scripts/run-code-review.mjs`, which drives `codex exec` with the rubric and a
strict output schema.

Why: `codex review`'s `[PROMPT]` argument is mutually exclusive with
`--uncommitted`, `--base`, **and** `--commit`, so code mode had no channel to
deliver a rubric. Across 81 notes written that way the structured branch never
once fired — 25 PASS-shaped, 55 unstructured `NEEDS-WORK` fallback, 0 structured.
The verdict field carried no information. There is no transcript to parse any
more; do not reintroduce one.

## Two phases

The runner is non-interactive and cannot prompt, but the soft-size guardrail
needs a human decision *between* measuring the patch and spending a Codex call.
So it splits:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/run-code-review.mjs" prepare --uncommitted [flags]
node "${CLAUDE_SKILL_DIR}/scripts/run-code-review.mjs" prepare --base <branch> [flags]
node "${CLAUDE_SKILL_DIR}/scripts/run-code-review.mjs" prepare --commit <sha> [flags]
```

`prepare` resolves the target, builds the patch, and prints JSON:

```json
{
  "bundle": "/tmp/cxr-bundle-XXXX",
  "bytes": 8231,
  "soft_warn": false,
  "diff_sha256": "…",
  "unreviewable_paths": [],
  "untracked_included": 1,
  "target_resolved": "…"
}
```

It spawns no Codex process. Read `bytes`:

- `soft_warn: true` (≥50 KiB) → tell the user the size and ask before continuing.
- ≥500 KiB → `prepare` already refused; suggest decomposing the change.

Then either continue or clean up:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/run-code-review.mjs" run --bundle <dir> [--model <m>] [--deep] [--keep-artifacts] [--context <file>]
node "${CLAUDE_SKILL_DIR}/scripts/run-code-review.mjs" discard --bundle <dir>     # user declined
```

`run` re-hashes the patch against the manifest, spawns Codex exactly once, runs
all three validation layers, and prints a result object containing `ok`,
`reviewer_verdict`, `final_verdict`, `issue_count`, `body`, and `frontmatter`.
Any failure exits nonzero and prints **no** result.

`--context <file>` passes verification the caller already performed (for example,
a scenario measured red on the base and green on the candidate). It is rendered as
data ahead of the patch and cannot waive a rubric item; a missing file aborts with
`no_context`. Never put conversation history in it.

The runner rejects an unknown flag, a flag missing its value, and a second target
selector with `[usage]`. `run` and `discard` only accept a directory that `prepare`
made, and refuse anything else with `[not_a_bundle]`.

## Scope flags

| flag | meaning |
|---|---|
| `--path <p>` | include only matching paths (repeatable; values union) |
| `--exclude <p>` | exclude matching paths (repeatable; beats `--path`) |
| `--tracked-only` | uncommitted mode: omit untracked files |
| `--repo <dir>` | repo root (default: cwd) |

Values are treated as **literal** paths; the runner builds any pathspec magic
itself, so a value cannot smuggle in `:(glob)` or an attribute selector.

## Writing the note

The runner never writes. Pipe its result to the writer:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/write-note.mjs" \
  --result <result.json> \
  --vault "<notes root or temp dir>" \
  --base-dir codex-reviews \
  --slug review-code-<base-or-uncommitted>-<short-sha> \
  --routing other \
  --no-log \
  [--confirmed] [--dry-run]
```

The shared routing always passes `--no-log`: the writer creates the directory and
prints the absolute note path with `logLine: null`, and the log entry (if any) is
prepended per `## Log integration` in `SKILL.md`. Only a `codex-review extension:`
file may omit `--no-log`, against a root that holds `log.md`; the writer then
prepends the entry itself, all-or-nothing with the note.

`write-note.mjs` calls `write-decision.mjs` and **refuses to write when the run
failed** or when routing is `unknown` without `--confirmed`. There is no override
flag. Resolve routing per `references/output-routing.md` first and pass the answer in.

## Verdicts

Two fields, and they are not interchangeable:

- `reviewer_verdict` — exactly what Codex returned, after validation. A reviewer
  whose verdict contradicts its own issue severities aborts the run.
- `final_verdict` — derived. If any path changed with no reviewable line content
  (binary, submodule) and the reviewer said `PASS`, this is `NEEDS-WORK`, so a
  `PASS` never overstates coverage.

Record both. The note states which rule fired when they differ.

## Failure modes

All abort with a distinct code, write nothing, and never retry:

`empty_patch`, `too_large`, `octopus_merge`, `git_failed`, `bundle_tampered`,
`model_not_allowed`, `model_fallback`, `model_unresolved`, `model_mismatch`,
`drift_before_run`, `drift_during_run`, `codex_failed`, `empty_output`,
`invalid_json`, `schema_violation`, `protocol_mismatch`, `too_many_issues`,
`verdict_mismatch`.

`codex_failed` (for example "Selected model is at capacity") keeps the bundle and
prints `retained for a retry`: rerun `run --bundle <same dir>`, with `--model` to
switch models. Every other code deletes the bundle, so the next attempt starts
with `prepare`.

## Unanchored findings

A finding whose `path:line` is not an added or deleted line of the patch (a
context line, or a file outside the diff) does not abort the run. It stays in
the result, the note marks it `unanchored: not a changed line of the patch`, and
`frontmatter.unanchored_issues` lists its 1-based number. Check the claim
yourself before acting on it, and record it in `## Disposition` like any other.

## Staged files

`--uncommitted` covers modified, untracked, and staged-new files. Do not stage
or edit files between `prepare` and the end of `run`: the drift check aborts
with `drift_during_run`.

## Running inside a Claude Code session

Codex's `-s read-only` Seatbelt cannot initialize inside Claude Code's own Bash sandbox —
macOS does not nest Seatbelt profiles. Codex then reads nothing and reviews the patch text
alone, while still returning `ok: true` and a clean `PASS`. No field distinguishes that run
from a real one: the only trace is a free-text `## Unresolved assumptions` line saying the
execution sandbox failed to initialize. Measured 2026-09-16, one patch run twice — with the
outer sandbox off, the same patch returned `PASS` with no such section.

Exempt the runner once, in `~/.claude/settings.json`:

```
/sandbox exclude "node <absolute path of this skill>/scripts/run-code-review.mjs *"
/sandbox exclude "codex exec *"    # design, plan and duel modes invoke Codex directly
```

The absolute path is the directory holding `SKILL.md`: Claude Code shows it as the
skill's base directory when the skill loads and substitutes it for
`${CLAUDE_SKILL_DIR}` in `SKILL.md`. Codex does not substitute the variable.

The skill's own test suite has the same problem in another form: run under the
Claude Code sandbox from a write-denied skills directory, 15 runner tests fail with
`model_unresolved`. Run `node --test` from `scripts/` with the sandbox disabled, or
from a copy of the skill under `$TMPDIR`.

`-s read-only` still binds — the exemption drops only the *outer* sandbox from a process that
carries its own, so the read-only boundary this skill rests on is untouched. Until it is in
place, a `PASS` produced inside a Claude Code session is not evidence the code was examined.
