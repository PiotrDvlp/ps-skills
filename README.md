# ps-skills

Twelve development skills and a principles reference for Claude Code and Codex, by Piotr Strzelecki.

## Install

Claude Code (plugin, namespaced `/ps:<skill>`):

```
claude plugin marketplace add PiotrDvlp/ps-skills
claude plugin install ps@ps-skills
```

Any agent that reads `SKILL.md` directories (`npx skills`, bare names):

```
npx skills@latest add PiotrDvlp/ps-skills
```

## Skills

| Skill | What it does | Needs |
| --- | --- | --- |
| `commit` | Groups unstaged changes into logical commits; derives the message shape from `git log` | — |
| `dual-branch-finish` | Lands one change on two integration branches and verifies both MR handoffs | Node 22+, authenticated `glab` |
| `codex-review` | Independent read-only Codex review of a design, plan or diff | Codex CLI 0.130+ |
| `second-view` | Independent Codex proposal on a problem still being decided | Codex CLI 0.130+ |
| `task-auditor` | Readiness audit of a Jira ticket before implementation | `cs-atlassian` MCP (ask the author for the `cs-tools` repo) |
| `why` | Explains why existing code is the way it is, from history | `cs-atlassian` MCP for tickets; `glab` or `gh` for MR lookups |
| `blast-radius` | What a diff could break elsewhere | — |
| `layer-lint` | SHOPin `pageModules/` layer-boundary linter | Node 22 |
| `retro` | Fork of mattpocock/skills `retro` | — |
| `dev-browser` | Fork of SawyerHood/dev-browser; targets CLI 0.2.5 | `dev-browser@0.2.5` |
| `worktree-audit` | Read-only inventory of a repo's git worktrees: target, ahead/behind, dirty, deps, MRs | `glab` for `--mr` |
| `prove-ui` | Proves a browser-visible change with a baseline-vs-candidate run and an attested line | a repo adapter at `.claude/prove-ui/adapter.md` |

## Principles

`/ps:principles` loads the eighteen working rules behind these skills (verification, debugging, planning, retrieval, code, delegation, working with the human), each with the moment it applies and the skill that enforces it. `/ps:principles <name>` applies one, for example `/ps:principles explain-the-number`. The skill never loads on its own; nothing from it sits in context until you invoke it, and a new session starts without it.

To have the principles in every session, add one line to your `~/.claude/CLAUDE.md` (or the project one):

```
At the start of each task, invoke /ps:principles.
```

This costs about 170 lines of context per session. Without the line, the skill is a reference you pull in when you want it. Source: `skills/principles/SKILL.md`.

| Principle | Group | Rule |
| --- | --- | --- |
| `prove-it-works` | verification | A check that did not run is not a pass; quote the decisive line before claiming done |
| `explain-the-number` | verification | A measured value travels with run count, spread and the named limiter |
| `verification-must-be-able-to-fail` | verification | A test or check that passes with and without the change proves nothing |
| `fix-root-causes` | debugging | Reproduce, write three hypotheses, rule out two; after two failed fixes, attack the shared premise |
| `blast-radius` | debugging | Find the one fact a change is safe because of, and prove it, not just the caller list |
| `executable-plans` | planning | Cite claims, evaluate two real alternatives, make every criterion a runnable command |
| `second-pass-before-presenting` | planning | A non-trivial plan gets an independent model review before the human sees it |
| `review-only-on-shared-code` | planning | Fix the diff base first; on shared or analytics code propose, do not apply |
| `notes-first-retrieval` | retrieval | Search your own notes before web or model knowledge; name the files, state the gap |
| `read-the-whole-source` | retrieval | Fetch the full thread or article before summarizing; cite per claim |
| `zero-comments` | code | No comments unless a reader cannot derive it; suppressions are defects |
| `tooling-outside-team-repos` | code | Personal linters, hooks and skills never land in a team repository |
| `guard-the-context-window` | delegation | Bulk reads and searches go through subagents; the main thread keeps the decision |
| `pin-model-and-effort-on-dispatch` | delegation | Cheap tier only behind a gate that sees the failure; pin effort with model |
| `encode-lessons-in-structure` | delegation | A repeated instruction becomes a type, lint, hook or script, not more text |
| `ask-only-at-the-boundary` | human | Act on anything reversible; ask first for push, installs, destructive or external writes |
| `disagree-with-evidence` | human | Object directly with a file, incident or alternative; no evidence, ask instead |
| `key-fact-first` | human | Answer first, corrections first, decisions under one numbered heading |

## Configuration

The `commit` and `dual-branch-finish` GitLab handoffs share a read-only verifier at
`skills/dual-branch-finish/scripts/verify-mr.mjs` (`--help` lists the flags). It discovers MRs
by source branch, checks open state before a push, and verifies title, target, full description
and pushed commit after it. A creation link is reported as pending until the MR is read back;
MR creation and updates still require the user's authorization. No new dependencies.

Four optional lines in your `~/.claude/CLAUDE.md`:

```
Notes root: /absolute/path/to/your/notes
Activity log: /absolute/path/to/your/notes/log.md
task-auditor extension: /absolute/path/to/a-markdown-file.md
codex-review extension: /absolute/path/to/a-markdown-file.md
```

Without `Notes root:`, `task-auditor` answers in chat, `codex-review` writes to `$TMPDIR/codex-reviews/`, and `second-view --save` is refused. With `Activity log:`, skills that save a note prepend `## [date] <op> | <title> → [[slug]]` after a `<!-- log:entries -->` line in that file. The extension files are plain Markdown instructions the skill follows after its own work is done.

## Paths

Skill files reference themselves as `${CLAUDE_SKILL_DIR}/...`. Claude Code substitutes the variable. Codex does not: read it as "the directory holding `SKILL.md`".

Before you publish: `node scripts/check-public-leaks.mjs --root . --deny-file <your private deny file> --allow-path skills/layer-lint` must print `0 findings`. The deny file lists names that must never appear here, one per line; a missing or empty file exits 2 on purpose. `layer-lint` is allowed to name the frameworks it lints.

## Credits

- `retro`: fork of [mattpocock/skills](https://github.com/mattpocock/skills) (MIT), see `skills/retro/NOTICE`.
- `dev-browser`: fork of [SawyerHood/dev-browser](https://github.com/SawyerHood/dev-browser) (MIT), see `skills/dev-browser/NOTICE`.
- `why`: idea from @MAXIMISEART's "ask why, not just what".
- `principles`: four rules adopted from [pstack](https://github.com/cursor/plugins/tree/main/pstack) (Lauren Tan, MIT), rewritten; named in the skill's Credits section.

## Also recommended

Plugins and skills I run every session but do not ship here:

- [superpowers](https://github.com/obra/superpowers) (Jesse Vincent, MIT)
- [caveman](https://github.com/JuliusBrussee/caveman) (Julius Brussee)
- [ponytail](https://github.com/DietrichGebert/ponytail) (Dietrich Gebert, MIT) — `commit` and `dual-branch-finish` use `/ponytail-review` when present
- [evals-skills](https://github.com/ai-evals-course/evals-skills) (Hamel Husain, Shreya Shankar)
- `wait-what`, `show-me` (Matt Pocock)
- `archify` (MIT), `vision` (@kunchenguid), [open-code-review](https://github.com/alibaba/open-code-review) (Alibaba, Apache-2.0)

## License

MIT, see `LICENSE`. Forked skills keep their upstream notices.
