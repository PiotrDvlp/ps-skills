---
name: worktree-audit
description: Use when asking which git worktrees are stale, merged, behind or safe to clean up, or before picking up a ticket whose branch lives in a worktree — "audit the worktrees", "which worktrees can go", "is the PROJ-123 worktree ready to run", "worktree inventory". Read-only table per worktree; never removes anything. Skip for creating a worktree (using-git-worktrees) or finishing a branch (dual-branch-finish).
---

# worktree-audit

One read-only row per worktree of a repo:

```
node "${CLAUDE_SKILL_DIR}/worktree-audit.mjs" --repo <repo root> [--mr]
```

`${CLAUDE_SKILL_DIR}` is the directory holding this file; resolve it yourself when the variable is not substituted (Codex does not substitute it).

| Column | Meaning |
|---|---|
| `target` | `origin/develop` for branches ending `_develop` or `_dev`, otherwise `origin/main` |
| `ahead/behind` | commits the branch has beyond its target / commits the target gained since; a big behind means rebase or conflict risk |
| `in-target` | `contained` = no commits beyond the target. This is not "merged": a branch created a minute ago is also contained. The `mr` column shows real merges |
| `worktree` | `dirty` = uncommitted or untracked files. A `contained` but `dirty` worktree still holds work |
| `node_modules` | `no-deps` = the worktree cannot run tests, typecheck or a dev server as it is |
| `mr` | with `--mr`: MRs for the branch via `glab` (needs the sandbox off; inside it `glab` fails with a TLS error) |

Counts use the local remote-tracking refs; the script never fetches. Say how old the last
fetch is when it matters.

## Rules

- Never remove, prune or switch anything from this output. Removing a worktree or deleting a
  branch is the user's decision; give them the commands.
- `contained` plus no open MR plus `clean` is the only cleanup candidate, and only when no
  local evidence lives in it (for example a `.distro/` directory under the worktree).
- A repo may ship its own worktree helper with a removal preview; when that preview checks
  `_develop` twins against a ref you pass, pass `origin/develop` for them.
