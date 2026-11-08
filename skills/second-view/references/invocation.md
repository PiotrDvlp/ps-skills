# Invocation

## The runner

Every run goes through `scripts/run-second-view.mjs`. Never assemble the prompt or the
`codex exec` argv yourself: `buildPrompt` is what strips the withheld half and `buildCodexArgs`
is what pins `-s read-only`, and the runner is the only caller of both that is under test.

1. Write the approved two-part brief to a file under `$TMPDIR` (the user's `/second-view <path>`
   form already has one). Never write the withheld half anywhere else.
2. Run, with Bash `run_in_background: true` and `dangerouslyDisableSandbox: true`, then wait
   for the completion notice:

   ```bash
   node "${CLAUDE_SKILL_DIR}/scripts/run-second-view.mjs" --brief "<absolute brief path>" [--model <m>] [--deep] [--repo <repo-root>] [--keep-prompt <path>]
   ```

   Pass every other flag from the user's `/second-view` line through unchanged: the runner
   refuses a `--sandbox` or bypass flag (`assertSafeArgs`) and any unknown flag, both before it
   spawns anything.
3. Remove the brief file after the run unless the user asked to keep it.

Quote every path: a notes root such as `~/Notes/My Vault/...` contains a space.

The runner refuses to start inside a nested Seatbelt sandbox (`nested_sandbox`): Codex's
`-s read-only` is itself a Seatbelt sandbox, Seatbelt cannot nest, and every Codex shell command
would fail with `sandbox_apply: Operation not permitted`. Turning off the harness sandbox does not
weaken Hard rule 1, because Codex still runs `-s read-only`.

What the runner sends: Codex `exec` with `-m <model> -s read-only --ignore-user-config
--skip-git-repo-check -c model_reasoning_effort="medium|xhigh" [-C <repo>] -o <tmp> -`, with the
prompt on stdin (never through argv: `ARG_MAX` and quoting). `--ignore-user-config` keeps the
user's MCP servers and plugins away from Codex; `AGENTS.md` files still load.

## Result

Success prints one JSON object on stdout: `ok`, `model`, `reasoning_effort` (`medium` or
`xhigh`), `sandbox`, `duration_ms`, `proposal`. Synthesize from `proposal`; record `model` and
`reasoning_effort` from the JSON when saving a note.

## Model resolution

Default `gpt-5.6-sol` (`DEFAULT_MODEL` in `scripts/codex-args.mjs`, the same as codex-review's). `gpt-6-astra` is the top
tier, an explicit opt-in for hard, high-stakes design calls, matching `codex-review`. `--deep`
raises effort to `xhigh` on the ALREADY-RESOLVED model rather than switching models.

`buildCodexArgs` accepts only `ALLOWED_MODELS`: `gpt-6.1-sol`, `gpt-6-astra`, `gpt-6-sol`,
`gpt-6.1-terra`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, the same list as
`codex-review`'s `code-review-core.mjs` (a parity test holds them equal). `gpt-5.6-pro` gets its
own error: it returns HTTP 400 "not supported when using Codex with a ChatGPT account".

## Failure handling

Every failure exits nonzero, prints `[<code>] <message>` on stderr and nothing on stdout. Stop
and report; nothing is retried silently. There is exactly one Codex call.

| code | Behavior |
|---|---|
| `usage` (exit 2) | Unknown flag, missing value, or a forbidden sandbox flag; nothing spawned |
| `nested_sandbox` | Re-run with `dangerouslyDisableSandbox: true` |
| `model_not_allowed` | Model outside `ALLOWED_MODELS`, `gpt-5.6-pro` included |
| `no_brief`, `bad_brief` | Brief missing, or `buildPrompt` refused it (markers); nothing spawned |
| `codex_spawn_failed` | `codex` not on PATH; tell the user to install Codex CLI 0.130.0+ |
| `codex_failed` | Nonzero exit; surface the stderr tail |
| `model_mismatch`, `model_fallback`, `model_unresolved` | Codex did not run the requested model; never synthesize or save provenance from that run |
| `timeout` | No result within 900 s; report and stop |
| `empty_output`, `missing_heading` | Surface the raw output; never synthesize from a malformed proposal |

Temp files are removed on success and failure alike. `--keep-prompt <path>` copies the assembled
prompt to that path first.
