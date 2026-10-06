# <repo> prove-ui adapter

## Harness

`PROVE_UI_PHASE=<baseline|candidate> <harness command> .claude/prove-ui/checks/<id>.mjs`
run from the repo root. Name the readiness signal and the teardown the harness owns.

## Harness preconditions

Conditions the harness itself needs (branch, ports, env files, other servers).
`.distro/` and `.claude/` must be gitignored (or in `.git/info/exclude`); `createProof`
refuses with `DISTRO_NOT_IGNORED` otherwise.

## Base checkout

For "verify an existing fix": the exact commands that build a runnable throwaway checkout of
the base ref (worktree on a temporary `prove-ui/base-<id>` branch, dependencies, env files),
the dependency files that must be identical between base and fix, and the cleanup command.
Never overwrite an existing checkout.

## Doctor preflight

Read-only commands that answer "is this instance worth driving?", run before the first
drive and after any surprise. What to do on a stray process: stop and report.

## Infrastructure codes

Harness exit codes that mean infrastructure, never behaviour.

## Repo-wide traps

Host names, splash screens, data gaps, anything that invalidates a run on every feature.
