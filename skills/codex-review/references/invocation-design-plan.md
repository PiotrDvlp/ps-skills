# Invocation — design / plan modes


1. Generate a prompt file in `$TMPDIR` containing the rubric concatenated with the target. Format:

   ```
   <contents of references/rubric-design.md or rubric-plan.md>

   <contents of target file>
   ```

2. Allocate a tmp output file in `$TMPDIR` for Codex's final message.

3. Invoke Codex via Bash with `< prompt-file` as the canonical stdin form. Always pass `--skip-git-repo-check` so the skill works against artifacts that do not live in a git repo:

   ```bash
   codex exec -m <model> -s read-only --skip-git-repo-check [-C <repo-root>] \
     -o <tmp-final-message-path> - < <tmp-prompt-file-path>
   ```

   `<model>` defaults to `gpt-5.6-sol` (see `## Invocation forms` in SKILL.md for routing and supported overrides).

   When `--deep` was passed, keep the resolved `<model>` **unchanged** and add `-c model_reasoning_effort="xhigh"`:

   ```bash
   codex exec -m <model> -c model_reasoning_effort="xhigh" -s read-only --skip-git-repo-check [-C <repo-root>] \
     -o <tmp-final-message-path> - < <tmp-prompt-file-path>
   ```

   As in code mode, `--deep` adjusts effort only and never overrides `--model`. Record the effort actually used as `reasoning_effort:` in the note frontmatter — `xhigh` only if the override was really on the command line, otherwise `config-inherit`. Writing `xhigh` for a run that omitted the flag is the failure this note exists to prevent.

   `< file` streams the file through stdin directly — no argv expansion, no shell buffer, no quoting. Two patterns to avoid and why (matching the design's rationale):

   - **Positional-arg substitution** like `codex exec ... "$(cat prompt-file)"`: puts the entire artifact into argv, hits the system `ARG_MAX` ceiling, and breaks on special characters in the surrounding quoting. This is the catastrophic case.
   - **Shell-substituted heredoc/here-string** like `<<<"$(cat prompt-file)"`: feeds stdin (not argv) but the shell still substitutes `$(cat …)` into a string in memory first. That intermediate buffer strips trailing newlines from command substitution, is fragile around escape characters, and forces the shell to hold the full artifact in memory. This is the subtle case.

4. Read the tmp final-message file. Validate it contains the two required headings: `## Verdict` and `## Issues`. If validation fails, surface a clear error to the user including the raw output for debugging — do not silently retry.

5. Check whether Codex could read the repo. Redirect Codex's stderr/stdout to a log file in step 3 and grep it, plus the final message, for `sandbox_apply: Operation not permitted` or a statement that shell/filesystem reads were rejected, blocked or denied. Any hit → write `repo_read: failed` in the note frontmatter and put `> [!warning] Codex could not read the repo (nested Seatbelt); path and code claims in this review are unverified.` directly under the frontmatter; otherwise `repo_read: ok`. Cause: Codex's `-s read-only` Seatbelt cannot start inside Claude Code's Bash sandbox (see `invocation-code.md` § Running inside a Claude Code session) — 35 of 188 notes from 2026-08-06 to 2026-10-05 were blind this way while `repo_root_resolved` still said `true`. Run `codex exec` outside the outer sandbox (the `/sandbox exclude "codex exec *"` exemption, or a sandbox-disabled Bash call) so this stays `ok`.
