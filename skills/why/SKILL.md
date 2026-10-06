---
name: why
description: "Use when asking why existing code, a gate, a guard, or a design decision is the way it is and the reason lives in history rather than the code — \"/why X\", \"why does this exist\", \"why was this done this way\", \"is this still needed\", Polish \"dlaczego to jest tak\". Skip for code written in the current session (just ask), for how code works (read it or use codegraph), and for failing tests (use systematic-debugging)."
---

# /why — evidence-graded rationale for existing code

## Core principle

The reason for a decision is a historical fact with a paper trail: commit, ticket, doc, chat. Find the trail, then report what it proves separately from what you infer. A summary note that calls something "deliberate" is a pointer to the trail, never the trail itself.

## Source order

Work down; stop when the origin is established and the "still valid?" question is either answered or shown unanswerable.

1. **Anchor.** Locate the exact line on the base branch (`origin/main` unless told otherwise). `git blame -L`, then `git log -S '<token>'` to find the commit that *introduced* it, not the last one that moved it.
2. **Commit.** Full message and `--stat` of the introducing commit. Extract ticket keys.
3. **Merge/pull request.** Find the MR/PR that carried the introducing commit: the first merge commit containing it (`git log --merges --ancestry-path --reverse <sha>..<base>`), else search merged MRs/PRs by commit title or branch. Read its description and review discussion (`glab mr view <n> --comments` or `gh pr view <n> --comments`). A review thread often holds the finding that forced the change; the commit records only the fix. If no MR/PR exists (direct push, squash without reference), say so under Sources.
4. **Tickets.** Fetch each key (cs-atlassian). Read description, acceptance criteria, open questions, comments, links, and sub-tasks — a `Todo` sub-task is often the answer to "still needed?".
5. **Notes.** If the user's CLAUDE.md has a `Notes root: <dir>` line and that directory is readable, `rg` the ticket keys and symbol under it. Summary notes there only point to primary notes; flag any claim in them the primary sources contradict. Otherwise add one line to Sources, `notes: skipped (no Notes root)` or `notes: skipped (<path> not readable)`, and continue.
6. **Docs and chat, only if 1-5 leave the origin unexplained.** Confluence search on the ticket key; Slack search on the ticket key or symbol.

Run inline. No subagent fan-out unless a single source returns more than fits in context.

## Output contract

Reply with sections 1-7 in order. Add section 8 only when the user says they plan to change, remove, or simplify the code. Then at most one line of next action.

1. **Question** — restated, with the anchor `path:line` on the base branch.
2. **Found** — facts, each with its source (commit hash, ticket key, `path:line`, note filename).
3. **Inferred** — conclusions drawn from the facts, each naming the facts it rests on.
4. **Competing hypotheses** — at least two when the question includes "still needed?"; one line each on what would confirm it.
5. **Unknown** — what no consulted source answers, and who or what could answer it.
6. **Sources** — one line each: consulted, skipped (why), unavailable (no tool).
7. **Confidence** — high / medium / low, separately for origin and for current validity.
8. **Constraints** — four lines, each citing a Found or Unknown item: Preserve (behaviour that must survive), Change (what is free to change), Avoid (approaches the history shows fail), Risk (what is untested or unknown).

Next action example: the exact question to put to the PO.
