# ps-skills

Twelve development skills for Claude Code and Codex, by Piotr Strzelecki.

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
| `dual-branch-finish` | Lands one change on two integration branches and prints both MR links | — |
| `codex-review` | Independent read-only Codex review of a design, plan or diff | Codex CLI 0.130+ |
| `second-view` | Independent Codex proposal on a problem still being decided | Codex CLI 0.130+ |
| `task-auditor` | Readiness audit of a Jira ticket before implementation | `cs-atlassian` MCP, superpowers plugin |
| `why` | Explains why existing code is the way it is, from history | — |
| `blast-radius` | What a diff could break elsewhere | — |
| `layer-lint` | SHOPin `pageModules/` layer-boundary linter | Node 22 |
| `retro` | Fork of mattpocock/skills `retro` | — |
| `dev-browser` | Fork of SawyerHood/dev-browser; targets CLI 0.2.5 | `dev-browser@0.2.5` |
| `worktree-audit` | Read-only inventory of a repo's git worktrees: target, ahead/behind, dirty, deps, MRs | `glab` for `--mr` |
| `prove-ui` | Proves a browser-visible change with a baseline-vs-candidate run and an attested line | a repo adapter at `.claude/prove-ui/adapter.md` |

## Configuration

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

## Credits

- `retro`: fork of [mattpocock/skills](https://github.com/mattpocock/skills) (MIT), see `skills/retro/NOTICE`.
- `dev-browser`: fork of [SawyerHood/dev-browser](https://github.com/SawyerHood/dev-browser) (MIT), see `skills/dev-browser/NOTICE`.
- `why`: idea from @MAXIMISEART's "ask why, not just what".

## Also recommended

Plugins and skills I run every session but do not ship here:

- [superpowers](https://github.com/obra/superpowers) (Jesse Vincent, MIT) — required by `task-auditor`
- [caveman](https://github.com/JuliusBrussee/caveman) (Julius Brussee)
- [ponytail](https://github.com/DietrichGebert/ponytail) (Dietrich Gebert, MIT) — `commit` and `dual-branch-finish` use `/ponytail-review` when present
- [evals-skills](https://github.com/ai-evals-course/evals-skills) (Hamel Husain, Shreya Shankar)
- `wait-what`, `show-me` (Matt Pocock)
- `archify` (MIT), `vision` (@kunchenguid), [open-code-review](https://github.com/alibaba/open-code-review) (Alibaba, Apache-2.0)

## License

MIT, see `LICENSE`. Forked skills keep their upstream notices.
