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
  for a hard, high-stakes design call when its extra cost is justified. Allowed
  list in references/invocation.md
- `--save` — also write a note under the `Notes root:` directory from the user's
  CLAUDE.md; without that line, refuse `--save` in one sentence and still print
  the synthesis
- `--keep-prompt <path>` — retain the assembled prompt for debugging
- `--repo <path>` — repo root for `-C`

## Hard rules (refuse if violated)

1. Codex always runs `-s read-only`. Reject any `--sandbox` override with a
   one-line error and stop. Enforced by `assertSafeArgs` in
   `scripts/codex-args.mjs` and called by `scripts/run-second-view.mjs`.
   `${CLAUDE_SKILL_DIR}` is the directory holding
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

- **Never assemble the Codex prompt or argv by hand — run
  `scripts/run-second-view.mjs`.** Why this matters: hand-assembly is how the
  withheld half leaks, and a hand-edited `codex exec` line is how `-s read-only`
  (without it Codex inherits `sandbox_mode` from `~/.codex/config.toml`), the
  `gpt-5.6-pro` rejection or the effort pin drop out. The runner is the only path
  that calls `buildPrompt` and `buildCodexArgs` under test, including a canary
  test that the withheld half never reaches Codex. (From `## Hard rules` 1 and 3.)
- **`--ignore-user-config` is on every Codex call.** Why this matters: under
  `-s read-only` Codex still loads every MCP server and plugin from
  `~/.codex/config.toml`, so the "independent" proposer could query Jira or
  Slack for context. The flag drops them; `AGENTS.md` files still load (probe
  2026-11-08, codex-cli 0.167.0). The effort is therefore pinned (`medium`, or
  `xhigh` with `--deep`) instead of inherited.
- **Run the runner in the background with the harness sandbox off.** Seatbelt
  cannot nest: from inside the Claude Code Bash sandbox, every Codex shell
  command fails with `sandbox_apply: Operation not permitted`, so the runner
  refuses (`nested_sandbox`) before any API call. Codex still runs
  `-s read-only`, so Hard rule 1 holds. Use Bash `run_in_background: true` and
  wait for the completion notice; never poll and never run it in the
  foreground: proposal runs took a median 170–210 s (338 Codex runs, Oct–Nov
  2026), the foreground Bash default timeout is 120 s, and its 600 s maximum is
  below the runner's 900 s timeout.
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
