---
name: second-view
description: "Use when an independent OpenAI proposal would sharpen an approach still being decided — \"second view on this\", \"get me a second view before I commit\", \"get another view on this problem\", \"what would another model say\". Committing here means settling on an approach, not a git commit. Skip if the artifact already exists and needs critique; use codex-review instead."
---

# second-view

You send a user-approved brief to Codex, get ONE independent proposal back, and
synthesize it against the direction this conversation already has. Codex is
read-only and never writes files.

## Invocation forms

- `/second-view` — build the brief from the current conversation
- `/second-view <path-to-brief.md>` — use an existing two-part brief file
- `--deep` — raise reasoning effort to `xhigh` on the resolved model
- `--model <name>` — override the model. Default `gpt-5.6-sol`; `gpt-6-astra`
  for a hard, high-stakes design call when its extra cost is justified
- `--save` — also write a note under the `Notes root:` directory from the user's
  CLAUDE.md; without that line, refuse `--save` in one sentence and still print
  the synthesis
- `--keep-prompt <path>` — retain the assembled prompt for debugging
- `--repo <path>` — repo root for `-C`

## Hard rules (refuse if violated)

1. Codex always runs `-s read-only`. Reject any `--sandbox` override with a
   one-line error and stop. Enforced by `assertSafeArgs` in
   `scripts/codex-args.mjs`. `${CLAUDE_SKILL_DIR}` is the directory holding
   this file; resolve it yourself where it is not substituted.
2. Never pass conversation history, notes-root summary files (a hot-cache or
   mission note), or memory entries. Brief only.
3. Never pass the `=== WITHHELD ===` half. Enforced by `buildPrompt` in
   `scripts/build-prompt.mjs`. Never write the withheld half to a file.
4. Never run `codex apply`, `codex exec workspace-write`, or any writing Codex
   subcommand under this skill.
5. Exactly one Codex call per invocation. No auto-iterate.

## Known limitation

These rules govern what this skill SENDS. They cannot govern what Codex READS.
Codex has been observed self-reading a notes-root summary file and unrelated skill files
during a review it was never given them for. So "independent" here means "this
skill did not feed it the conversation", not "it saw nothing related". Say so in
the confirmation message rather than claiming blindness the skill cannot deliver.

## Flow

1. Build the two-part brief. Load references/brief-contract.md.
2. Show BOTH halves to the user. Wait for approval or edits. An unapproved brief
   is never sent.
3. Run Codex. Load references/invocation.md.
4. Synthesize inline. Load references/synthesis.md.
5. If `--save` was passed and the user's CLAUDE.md has a `Notes root:` line, write the
   note; if it also has an `Activity log:` line, prepend an entry with op `second-view`.
   Without `Notes root:`, say in one sentence that `--save` needs it and stop after the
   synthesis. Load references/save-note.md.

## Gotchas

- **Never assemble the Codex prompt by hand — call `buildPrompt`.** Why this
  matters: hand-assembly is how the withheld half leaks, and the unit test that
  proves the boundary holds only covers `buildPrompt`. A hand-built prompt is
  untested by construction. (From `## Hard rules` 3.)
- **Never hand-write the `codex exec` invocation line — call `buildCodexArgs`.**
  Why this matters: a missing `-s read-only` silently inherits `sandbox_mode`
  from `~/.codex/config.toml` (`workspace-write` today), and hand-editing a copy-pasted line
  (e.g. to add `--model` or `--deep`) is how that flag, the `gpt-5.6-pro`
  rejection, or correct `-c` placement silently drop out. The bash block in
  `references/invocation.md` shows only the resulting argv shape, not an
  invocation to run — build the real argv with `buildCodexArgs` and execute
  that array directly. (From `## Hard rules` 1.)
- **Seatbelt cannot nest: run Codex with the harness sandbox off.** From
  inside the Claude Code Bash sandbox, every Codex shell command fails with
  `sandbox_apply: Operation not permitted` and it can read no files. Run the
  invocation script with `dangerouslyDisableSandbox: true`.
  `assertCodexSandboxUsable` refuses the run before any API call. Codex still
  runs `-s read-only`, so Hard rule 1 holds. (From references/invocation.md.)
- **Never pass the artifact through argv.** `codex exec ... "$(cat prompt)"`
  hits `ARG_MAX` and breaks on special characters; `<<<"$(cat prompt)"` buffers
  the whole file in the shell and strips trailing newlines. Use `< prompt-file`.
  (From references/invocation.md.)
- **`node --test <dir>` does not scan a directory.** On Node v22.21.1 an absolute
  directory argument resolves as a *module to execute* and exits 1 with
  `Cannot find module`, which looks exactly like a real test failure. Run the
  suite as `cd scripts && node --test`, or glob `scripts/*.test.mjs`.

## Boundaries

- Do not edit the target brief.
- Do not auto-fix or act on what Codex proposes. Synthesis is the deliverable.
- Do not invoke Codex more than once per call.
