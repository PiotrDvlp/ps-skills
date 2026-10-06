# Output-path resolution

Routing is configured by optional lines in the user's `CLAUDE.md` (global `~/.claude/CLAUDE.md`
or the project one). First match wins:

1. `--out <path>` → write the note to that path as-is. Code mode maps it to the writer as
   `--vault "$(dirname <path>)" --base-dir . --slug <basename of path without .md> --routing other --no-log`.
2. Else, if `CLAUDE.md` has a `codex-review extension: <file>` line, read that file; it decides the
   directory and the writer call, and may replace any step below. If the file is missing or a step
   in it fails, report that in one sentence and fall through to step 3.
3. Else, if `CLAUDE.md` has a `Notes root: <dir>` line, the note goes to
   `<notes root>/codex-reviews/<slug>.md`. Code mode calls the writer with
   `--vault "<notes root>" --base-dir codex-reviews --routing other --no-log`. Design, plan and duel
   notes are written with `Write`. If `CLAUDE.md` also has an `Activity log: <file>` line, prepend
   the log entry yourself per `## Log integration` in `SKILL.md`.
4. Else the note goes to `${TMPDIR:-/tmp}/codex-reviews/<slug>.md`, with the same writer shape as
   step 3 (`--vault "${TMPDIR:-/tmp}"`). Say in the confirmation that the note is in a temp
   directory and give its absolute path.

The writer creates a missing directory on the `--no-log` path and prints the absolute note path.
Design, plan and duel notes: create the directory first (`mkdir -p`), then `Write`.

Slug rule: `review-<basename-without-ext-of-target>` for design/plan;
`review-code-<base-or-uncommitted>-<short-sha>` for code mode; `duel-<basename-without-ext-of-brief>`
for duel mode. Design, plan and duel file names carry a date prefix (`YYYY-MM-DD-<slug>.md`);
code mode passes the slug alone to the writer.
