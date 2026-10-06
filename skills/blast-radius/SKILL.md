---
name: blast-radius
description: "Use when asked for the blast radius of a change, what a diff, commit or MR could break elsewhere, or whether a refactor is really behaviour-preserving, especially before merging changes to analytics/dataLayer payloads, GraphQL fields, shared types, stores or build config."
---

# Blast radius

Most risky-looking changes are safe because of one fact ("the call only moved, same function, same arguments"; "the compiler sets `__name` in production"). Tracing callers and listing risks is the easy part. The job is to name that fact and prove it by running code. A green existing suite is not that proof unless one of its tests exercises the fact.

## Output (every slot required, in this order)

1. **What it does** — including the behaviour the diff does not spell out.
2. **Load-bearing fact** — one sentence: "Safe because <fact>." Then the ladder rung reached, the exact command run, and its decisive output line. Not proven: write `UNPROVEN` plus the command that would prove it.
3. **Risks** — each with `file:line`, likelihood, cost, and how to check.
4. **Cleared** — what was checked and why it is fine.
5. **Checks run** — existing suites, typecheck, lint, each with its decisive line. Kept separate from slot 2: a regression signal, not the proof.
6. **Before you merge** — the cheapest check that would catch the real bug.

## Ladder

1. Asserted. 2. Pointed at `file:line` or library source. 3. Walked the failure path. 4. Ran code that fails loudly if the fact is wrong. 5. Reproduced in the running app.

Rung 4 is the target. Rung 5 when the fact is about runtime, DOM or build output.

## Proof by fact shape

| Fact | Proof |
|---|---|
| Refactor, output identical | Export parent and commit (`git archive <sha> \| tar -x -C $TMPDIR/br/<sha>`), symlink `node_modules`, `.nuxt`, `generated`. One script or spec feeds the same real fixture through both versions and diffs the output (e.g. the dataLayer payload). |
| Only X is affected | Enumerate candidates with a script and assert the predicate per candidate. A prose list of checked components is rung 3. |
| Build-time behaviour (`__name`, inlined env, tree-shaking) | Compile the file with production settings and grep the artifact. |
| New test covers the fix | Revert the fix in the scratch copy; the test must fail. |
| Consumed outside the repo (GTM, GA4 reports, backend) | Cannot be proven locally. Prove the payload is byte-identical (row 1) or mark the consumer `UNKNOWN` and name the owner question. |

Proof runs only in `$TMPDIR` copies; product code is never edited to make a point.
