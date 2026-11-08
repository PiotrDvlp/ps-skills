# Invocation — design / plan modes

Design and plan modes run `scripts/run-exec.mjs`. Never type a `codex exec` line by hand: a
hand-edited line is how `-s read-only`, the model check or the effort flag get dropped, and
nothing in the output reveals it.

## Running

Run it with Bash `run_in_background: true` and `dangerouslyDisableSandbox: true` (or a
`sandbox.excludedCommands` entry for this command), then wait for the completion notice. See
`## Running Codex` in `SKILL.md` for why.

```bash
node "${CLAUDE_SKILL_DIR}/scripts/run-exec.mjs" --mode plan --target "<absolute path>" [--repo <repo-root>] [--model <m>] [--deep]
node "${CLAUDE_SKILL_DIR}/scripts/run-exec.mjs" --mode design --target "<absolute path>" [--repo <repo-root>] [--model <m>] [--deep]
```

- `--repo` comes from `references/repo-root.md`; without one, Codex runs without `-C` and the
  note records `repo_root_resolved: false`.
- `--model` defaults to the skill default (see `## Invocation forms` in `SKILL.md`).
- `--deep` raises effort from `medium` to `xhigh` on the same model.
- Quote every path: the vault path contains a space.

The runner:

1. Refuses to start inside a nested Seatbelt sandbox (`nested_sandbox`). Codex's
   `-s read-only` cannot initialize there and would review blind; a log grep cannot detect that
   reliably, because the Codex log echoes the prompt and every file Codex reads.
2. Builds the prompt from `references/rubric-design.md` or `rubric-plan.md` plus the target,
   and refuses a target of 500 KiB or more (`too_large`).
3. Runs Codex once as `exec` with `-m <model> -c model_reasoning_effort="medium|xhigh"
   -s read-only --ignore-user-config --skip-git-repo-check [-C <repo>] -o <tmp> -`, prompt on stdin.
   `--ignore-user-config` keeps the user's MCP servers and plugins away from the reviewer;
   `AGENTS.md` files still load.
4. Checks the exit code, the model Codex reports, a non-empty final message, and the
   `## Verdict` and `## Issues` headings. Timeout: 900 s.

## Result

Success prints one JSON object on stdout:

```json
{ "ok": true, "mode": "plan", "model": "gpt-6.1-sol", "reasoning_effort": "medium",
  "sandbox": "read-only", "repo_read": "ok", "duration_ms": 104000,
  "body": "## Verdict\n…" }
```

- The note body is `body`, unchanged.
- Frontmatter `model`, `reasoning_effort`, `sandbox` and `repo_read` come from the JSON. Never
  write a value the JSON does not hold.

## Failures

Every failure exits nonzero, prints `[<code>] <message>` on stderr and nothing on stdout. Never
retry silently; surface the message.

| code | meaning |
|---|---|
| `usage` (exit 2) | unknown flag, missing value, any `--sandbox` |
| `nested_sandbox` | run inside the harness sandbox; re-run with it off |
| `model_not_allowed` | model outside `ALLOWED_MODELS` (`gpt-5.6-pro` included) |
| `no_target`, `too_large` | target missing, or 500 KiB or more |
| `codex_spawn_failed`, `codex_failed` | Codex did not start, or exited nonzero (stderr tail included) |
| `model_mismatch`, `model_fallback`, `model_unresolved` | Codex did not run the requested model |
| `empty_output`, `missing_heading` | no final message, or one without the required headings (raw output included) |
| `timeout` | no result within 900 s |

`--keep` retains the prompt, final message and Codex logs and adds `artifacts_dir` to the JSON.
