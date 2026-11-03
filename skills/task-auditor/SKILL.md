---
name: task-auditor
description: "Use when about to implement a Jira ticket and it needs a readiness check first — \"audit JIRA-X\", \"is this ticket ready\", \"acceptance criteria review\", \"definition of done check\", Polish \"sprawdź ticket\". Skip if the task is already in progress or merged."
argument-hint: <ISSUE_KEY>
---

# Task Auditor

Audit Jira tasks before implementation to detect information gaps and block premature coding. Writes the audit note under the user's notes root, or returns it in chat when none is configured, then follows the user's task-auditor extension when one is named and a note was written.

## Architecture

Multi-agent pipeline with model-appropriate allocation. Phases 0, 1, 2 run sequentially; Phase 3 runs in the orchestrator session.

| Phase | Role | Model | Purpose |
|-------|------|-------|---------|
| 0. Setup | Orchestrator | current | Verify prerequisites, normalize key, detect project + stack, plan todos |
| 1. Jira fetch | Orchestrator | current | `mcp__cs-atlassian__atlassian_jira_get_issue` with explicit `instance`; CLI only if the MCP is unavailable |
| 1.5. Fast-fail gate | Orchestrator | current | Jira-only structural-emptiness check; emits a synthetic BLOCKED payload and skips Phase 1.75 + 2 when the ticket has no description, no AC, and no substantive comments |
| 1.75. Evidence packet | Orchestrator + script | current + `scripts/prescan.py` | Orchestrator derives keyword plan inline; deterministic pre-scan runs under a wall-clock timeout outside the prompt; assembles a packet (Jira + KEYWORD_PLAN + REPO_SHAPE + MODULE_HIT_TABLE + FILENAME/CONTENT hits) that replaces the analysis agent's search loop |
| 2. Packet-grounded analysis | Subagent | session (unpinned) | Reasons over the packet; emits SCOPE_DECISION first, then gap analysis + verdict; may not search, may issue ≤2 targeted reads from packet-cited paths only. Unpinned since 2026-07-27 — judgment output with no deterministic gate cannot take a cheap tier |
| 3. Output | Orchestrator | current | Write the audit note (notes root) or return it in chat; log line with `Activity log:`; then the extension when configured and a note exists |

## When NOT to use

- **Ticket is already in progress.** A WIP branch or merged PR exists — the audit's purpose is pre-implementation readiness, not retrospective review. Use `codex-review` for post-hoc critique instead.
- **Ticket is a spike or research task.** Acceptance criteria are deliberately exploratory; a BLOCKED verdict will always trigger and yields no signal.
- **Non-engineering ticket** (design-only, content, ops). The codebase-analysis pass has nothing to bind to and produces low-confidence output.
- **Ticket is outside the cs-atlassian allowlist.** The skill cannot fetch it; route the user to `~/.config/cs-atlassian/config.yml` instead of running.
- **You're not in a project directory.** Phase 0c can ask via `AskUserQuestion`, but if the user just wants a quick read of the Jira ticket without the full audit pipeline, call `mcp__cs-atlassian__atlassian_jira_get_issue` directly.

## Quick Reference

**Stack → analysis prompt:**

| Detected stack | Prompt file |
|---|---|
| shopin (Nuxt + `src/pageModules/`) | `references/analysis-prompt.md` |
| spring-boot, next, node-monorepo, unknown | `references/stack-fallback-prompt.md` |

**Verdict → next step:**

| Verdict | Meaning | Recommended action |
|---|---|---|
| START | No BLOCKER gap; a first commit can advance an AC today under the WARNING defaults | Present the decisions with their defaults; the user replies `go recommended` or overrides, then implementation starts |
| BLOCKED | At least one hard-floor BLOCKER (no AC and no description, undecided product scope, a core contract with no in-repo derivation, a deliverable the repo cannot produce) | Do not start; name the owner and what must exist first |

**Artifact map (where things land):**

| Artifact | Path |
|---|---|
| Audit note | `<notes root>/<project>/task-audits/YYYY-MM-DD-<key>-<slug>.md`, or the chat reply when no `Notes root:` line exists |

## Gotchas

- **Run the extension after the note, never instead of it, and never without a note.** If the user's CLAUDE.md names a `task-auditor extension:` file: follow it only after Phase 3 step 2 wrote a note; if the file is missing or a step in it fails, present the audit and report the extension error in one sentence. Why this matters: the extension is the user's bookkeeping; the audit is the deliverable, and bookkeeping that links to a note that does not exist creates dead links.

## Prerequisites

- `cs-atlassian` CLI installed and authenticated (`cs-atlassian login`)
- Target Jira project in cs-atlassian allowlist (`~/.config/cs-atlassian/config.yml`)
- Run from inside the project's git checkout (otherwise Phase 0c asks which project)

## Phase details (spokes)

Load references/phase-0-setup.md for Phase 0a–0f — prerequisite checks, key normalization, project + stack detection, re-audit early-detection.
Load references/phase-2-pipeline.md for Phases 1, 1.5, 1.75 and 2 — cs-atlassian MCP fetch, structural-emptiness fast-fail gate, orchestrator-built evidence packet (with `scripts/prescan.py`), packet-grounded analysis on the session model (SCOPE_DECISION first; no-search clause; ≤2 targeted reads; START/BLOCKED verdict with `Default:` on every WARNING).
Phase 3, in the orchestrator:
1. Resolve `<notes root>` and `<project>` (Phase 0c).
2. With a notes root: write the note at the path from references/output.md "Filename" (`mkdir -p` first; re-audit mode comes from Phase 0f). Without one: skip the write.
3. Present the chat template from references/output.md; add the "Saved to" block only when a note was written.
4. With an `Activity log:` line whose file exists **and a note written in step 2**: prepend the log entry per references/output.md "Log entry"; skip when re-audit chose overwrite. No note, no log line (the entry links `[[<dated-slug>]]`).
5. With a `task-auditor extension:` line and a note written in step 2: follow that file with `<note path>`, `<project>`, `<KEY>`, `<title>`, `<verdict>`, `<decisions>`, `<handoffs>`, `<dated-slug>`, `<re_audit_mode>`. Without a note: say "extension skipped, no note written". Missing file or failed step: one sentence, the audit stands.
Load references/output.md for the audit-note frontmatter, body, log line and chat template.
Load references/common-mistakes.md for the full common-mistakes catalog (the Gotchas above carry the two most operationally costly distillations).

`${CLAUDE_SKILL_DIR}` is the directory holding this file; `references/...` and `scripts/...` paths are relative to it, and Codex does not substitute the variable.

## Present to user

Chat template and closing line: `references/output.md`, section "Present to user (chat)".

## Critical Rules

**ALWAYS:**
1. Fetch issues through the cs-atlassian MCP (`mcp__cs-atlassian__atlassian_jira_get_issue`, explicit `instance`) — it wraps the CLI and runs outside the Bash sandbox. CLI only when the MCP is unavailable. Never Atlassian's official MCP or any other third-party Jira MCP server.
2. Use plain grep/find/Read for codebase analysis — never Serena MCP tools.
3. Fetch the full issue including comments — comments contain hidden scope.
4. Show the START/BLOCKED verdict with the first move, every WARNING's `Default:`, and the HANDOFF owners.
5. Save the audit note when a `Notes root:` line exists; otherwise return it in chat.
6. Be constructively critical — if the task is poorly described, say so.
7. Verify prerequisites (Phase 0a) before any subagent dispatch — failing fast on a missing CLI saves a wasted fetch call.
8. Normalize `<ISSUE_KEY>` (Phase 0b) before any downstream use — never pass raw user input to `cs-atlassian` or filenames.

**NEVER:**
1. Skip comment analysis.
2. Start implementation recommendations if verdict is BLOCKED.
3. Generate gap categories without evidence from the issue data.
4. Pin Phase 2 analysis to a cheap tier — it is deliberately unpinned, because no deterministic gate checks a single audit (see `references/phase-2-pipeline.md`).
5. Add a tag because the project name implies it — semantic tags are content-driven only.

