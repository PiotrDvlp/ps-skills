---
name: prove-ui
description: Use before editing code for a browser-visible change in a repo that has `.claude/prove-ui/adapter.md`, and before calling such a change done — "fix the focus ring on X", "implement this UI ticket and prove it", "before I call PROJ-123 done, prove it in the browser". Proves the change with a baseline-vs-candidate browser run. Skip for lint/typecheck/test runs (verify), plain screenshots or page exploration (dev-browser), and logic-only changes with no rendered effect.
---

# prove-ui

A UI change counts as proven only when the same check observes the old value on the
unedited code and a different, declared new value after the edit. One screenshot of the
end state proves nothing: six past checks passed with or without the fix.

## Procedure

1. Read `<repo>/.claude/prove-ui/adapter.md` and run its doctor preflight. Read
   `features/README.md`, then the feature file for the route. No feature file: map the
   feature from source first, using the contract in `features/README.md`. Notes elsewhere
   are leads to confirm, not facts.
2. **Before the first product edit**, write `.claude/prove-ui/checks/<id>.mjs`:

   ```js
   import { createProof } from '${CLAUDE_SKILL_DIR}/lib/proof.mjs'

   export default async ({ page, shot, baseUrl }) => {
     const p = createProof({ id: '<id>', feature: '<feature>', route: '/', interaction: '<what the user does>',
       baseUrl, file: import.meta.url, shot })
     await page.goto(`${baseUrl}/`)
     await p.precondition('<state that must hold>', await page.locator('<stable selector>').isVisible())
     await p.observe('<value name>', await page.locator('<stable selector>').evaluate((el) => getComputedStyle(el).color),
       { baseline: '<old literal>', candidate: '<new literal>' })
     await p.finish()
   }
   ```

   `${CLAUDE_SKILL_DIR}` is the directory holding this file; resolve it yourself when the variable is not substituted (Codex does not substitute it). Write the resolved absolute path into the check file.
   `id` equals the file name. Name the correct and the broken state before writing it.
   Preconditions (route, data, market, rendered app) are separate from observations.
   Prefer computed style, geometry, ARIA state or text over pixels.
3. Run the adapter's harness command with `PROVE_UI_PHASE=baseline`. The manifest under
   `.distro/browser/prove-ui/<id>/baseline.json` must say `OBSERVED`. A mismatch here
   means the check is wrong: fix the check, rerun the baseline, still before any edit.
4. Edit the product code. Never edit the check file from here on.
5. Run the harness with `PROVE_UI_PHASE=candidate`.
6. Run `node "${CLAUDE_SKILL_DIR}/bin/attest.mjs" .claude/prove-ui/checks/<id>.mjs`.
   Paste its `verified in-browser:` line into the completion summary. Never write that
   line by hand.

## Reading results

| Result | Meaning | Next |
|---|---|---|
| `BROWSER_CRASHED`, `BROWSER_TIMEOUT`, `BROWSER_SERVER_FAILED`, `BROWSER_PORT_BUSY` | infrastructure | doctor, then rerun; never a behaviour result |
| `BROWSER_SCRIPT_FAILED` | the check threw | read the phase manifest's `outcome`; no manifest means the check script itself errored (selector, timeout, syntax) |
| `DISTRO_NOT_IGNORED` | `.distro/` is not gitignored in this repo | ignore it first; manifests would otherwise change the tree fingerprint |
| `BASELINE_MISSING`, `CANDIDATE_MISSING` | a phase never wrote a manifest | run that phase |
| `MANIFEST_INVALID` | a manifest is unreadable or incomplete | rerun that phase; never edit manifests |
| `EVIDENCE_ROOT_INVALID` | `PROVE_UI_EVIDENCE_ROOT` is missing or not inside a git repo | pass the fix checkout's absolute path |
| `BASELINE_DIRTY` | the base checkout had uncommitted or untracked files when the baseline ran | rebuild the base checkout clean, rerun the baseline |
| `BASELINE_NOT_ANCESTOR` | the baseline commit is not an ancestor of the candidate commit | use `git merge-base` of the fix branch and its target as the base ref |
| `CHECK_MISSING`, `NOT_A_REPO` | wrong check path, or the check is outside a git repo | pass the path to `checks/<id>.mjs` inside the repo |
| `PRECONDITION_UNMET` | wrong state, data or route | fix the setup, not the code |
| `BEHAVIOR_MISMATCH` (candidate) | the change does not do what the check declares | fix the code |
| `CRITERION_CHANGED` | check edited after the baseline | rerun both phases from the base code |
| `TREE_UNCHANGED` | both phases ran on the same code | the edit did not reach the tree |
| `CANDIDATE_STALE` | code changed after the candidate run | rerun the candidate, then `attest` |

## Verify an existing fix

The fix is already committed on a branch (finished ticket, open MR). Never overwrite the fix
checkout's files to get the old code; build a throwaway base checkout instead.

1. Fix checkout: the branch's worktree, clean (`git status --porcelain` empty) and runnable
   (dependencies installed). None exists: stop and report; setting one up is the user's call.
2. Base ref: `git merge-base origin/<target> <fix branch>`.
3. Build the base checkout with the adapter's "Base checkout" commands. They refuse when the
   dependency files differ between base and fix.
4. Write the check into the fix checkout's `checks/` and copy it unchanged into the base
   checkout's `checks/`.
5. Baseline: run the harness from the base checkout with `PROVE_UI_PHASE=baseline` and
   `PROVE_UI_EVIDENCE_ROOT=<fix checkout path>`. The manifest and a copy of the screenshot land
   in the fix checkout, so they survive the base checkout's removal.
6. Candidate: run the harness from the fix checkout with `PROVE_UI_PHASE=candidate`.
7. `attest` against the check in the fix checkout.
8. Remove the base checkout with the adapter's cleanup command, and hand the user the
   temporary branch deletion (`git branch -D prove-ui/base-<id>`): deleting a branch is theirs.

## No baseline possible

Code already edited, a behaviour-preserving refactor, or a route that needs login: do a
manual `/dev-browser` check and write
`browser-checked (no baseline: <reason>): <route> — <interaction> (screenshot: <path>)`.
Never call that `verified in-browser`.

## Rules

- Do not report a skipped entry point as verified through a different path.
- Never kill a process you did not start. Evidence under `.distro/` stays local.
- A feature file that was never driven is a draft; mark it so.
