# <repo> prove-ui adapter

Main checkout: <absolute path of the repo's main checkout>

## Harness

`PROVE_UI_PHASE=<baseline|candidate> <prove-ui skill dir>/bin/browser.mjs run <this folder>/checks/<id>.mjs --serve --timeout 180`
run from the root of the checkout being proven (or the repo's own harness command). Name the
readiness signal and the teardown the harness owns.
`shot(name)` saves the viewport, `shot(name, { fullPage: true })` the whole page.

## Harness preconditions

Conditions the harness itself needs (branch, ports, env files, other servers).
`.distro/` must be gitignored (or in `.git/info/exclude`); `createProof` refuses with
`DISTRO_NOT_IGNORED` otherwise.

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
