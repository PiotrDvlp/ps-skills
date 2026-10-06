# Repo-root resolution (design / plan modes)


`-C <repo-root>` lets Codex verify path-existence claims in the artifact. Resolve in this order:

1. `--repo <path>` flag (explicit user override) — use as-is.
2. Plan/design frontmatter `repo:` field if present and resolves to a directory.
3. `git rev-parse --show-toplevel` from cwd.
4. None of the above → emit a warning in the review note frontmatter (`repo_root_resolved: false`) and proceed without `-C`. Path-existence checks in the rubric become best-effort.

