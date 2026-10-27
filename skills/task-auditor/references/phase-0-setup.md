# Phase 0: Setup


Announce to the user before starting: `Auditing <ISSUE_KEY> — verifying prerequisites, then fetching the issue and dispatching the analysis subagent (~30–60s).`

### 0a. Verify prerequisites

Run one check — abort if it fails:

1. **cs-atlassian MCP** — `mcp__cs-atlassian__atlassian_jira_get_issue` is in the tool list (load it via ToolSearch if deferred). If absent, check the CLI instead: `bash -lc 'command -v cs-atlassian >/dev/null && cs-atlassian --version'`. If neither exists, print and abort:
   > cs-atlassian not available. Install it from the `cs-tools` repo (ask the skill author for access; `packages/atlassian/README.md`), register its MCP server, then run `cs-atlassian login`.

### 0b. Normalize `<ISSUE_KEY>`

Accept the raw argument from the user and normalize:

1. Trim whitespace.
2. If the input is a URL containing `/browse/<KEY>` (Jira), `/jira/<KEY>`, or a query string with `selectedIssue=<KEY>`, extract `<KEY>`.
3. If the input is wrapped as `[[<KEY>]]` (Obsidian wikilink), strip the brackets.
4. Uppercase.
5. Validate against regex `^[A-Z]{2,10}-\d+$`. If it fails, print and abort:
   > Invalid issue key: `<raw>`. Expected format `ABC-123` (2–10 uppercase letters, dash, digits).

Use the normalized `<ISSUE_KEY>` for the rest of the run.

### 0c. Determine `<project>`

1. `<project>` = `basename "$(git rev-parse --show-toplevel)"`.
2. If that command fails (not inside a git work tree), ask via `AskUserQuestion`: "Which project is this audit for?" and use the answer as `<project>`.
3. `<notes root>` = the `Notes root:` line of the user's CLAUDE.md, or none.

### 0d. Detect stack and pick analysis prompt

Inspect the project root in this order; first match wins:

| Marker at project root | Stack | Analysis prompt path |
|---|---|---|
| `nuxt.config.ts` AND `src/pageModules/` directory exists | shopin | `references/analysis-prompt.md` |
| `pom.xml` containing `<artifactId>spring-boot-starter-parent</artifactId>` or `<groupId>org.springframework.boot</groupId>` | spring-boot | `references/stack-fallback-prompt.md` |
| `next.config.js`, `next.config.ts`, or `next.config.mjs` | next | `references/stack-fallback-prompt.md` |
| `package.json` containing a `"workspaces":` field | node-monorepo | `references/stack-fallback-prompt.md` |
| anything else | unknown | `references/stack-fallback-prompt.md` |

Record `<analysis-prompt-path>` for use in Phase 2.

### 0e. Plan progress tracking

Create a TaskCreate todo list with these items so the user can see live progress through the multi-phase pipeline:

1. Fetch Jira issue (Phase 1)
2. Codebase analysis (Phase 2)
3. Write audit note or return it in chat (Phase 3)
4. Prepend log entry when `Activity log:` is set and a note was written
5. Run the task-auditor extension when configured and a note was written

Mark each `in_progress` when starting and `completed` immediately on success — don't batch.

### 0f. Re-audit early-detection

Only with a notes root; without one, skip this step (nothing was written before). Before dispatching any subagents, grep for existing audits, executed early so the user is not made to wait ~60s of fetch + analysis work before being asked what to do.

```bash
grep -l "^aliases: \[<ISSUE_KEY>\]" "<notes root>/<project>/task-audits/"*.md 2>/dev/null
```

- **No match** → continue to Phase 1 with the standard target filename (references/output.md "Filename").
- **Match dated today** (same `YYYY-MM-DD` prefix) → invoke `AskUserQuestion` immediately with options: `Overwrite (refresh from current Jira state)` (recommended), `New dated note (preserve history)`, `Abort`.
  - On **Abort** → exit cleanly. No subagent work, no writes. This is the path the early detection exists to fast-path.
  - On **Overwrite** → store `<resolved-filename> = existing-filename`, set `re_audit_mode = overwrite`, continue to Phase 1.
  - On **New dated note** → store `<resolved-filename> = existing-slug + "-2"/"-3"/…`, set `re_audit_mode = new-dated`, continue to Phase 1.
- **Match from a previous day** → set `re_audit_mode = previous-day`, continue to Phase 1. Print one line: `Previous audit for <ISSUE_KEY>: <existing-filename> — keeping both, writing fresh dated note today.`

Carry `<resolved-filename>` and `re_audit_mode` forward into Phase 3.

