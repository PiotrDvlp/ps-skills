# Calibration — measuring the reviewer, not the harness

The harness validates the review's **form**: schema, verdict/severity consistency,
citations against the patch, PASS cap over unreviewable paths. It cannot judge the
review's **content** — whether a `PASS` was deserved or a defect was missed. Calibration
closes that: a small corpus of diffs with **known verdicts**, reviewed on demand through
the normal two-phase runner, scored for recall and precision.

This is the "feed the evaluator known-good and known-bad cases" step from the
loop-engineering literature — the one check neither the harness nor the mutation gate can
replace, because the reviewer is a model, not a function.

## Invocation

```bash
node "${CLAUDE_SKILL_DIR}/scripts/run-calibration.mjs" run [--filter <id>] [--model <m>] [--deep] [--threshold <recall>]
node "${CLAUDE_SKILL_DIR}/scripts/run-calibration.mjs" dry-run [--filter <id>]
```

`run` spends one real Codex call per fixture (6 by default; `--filter` picks one).
`dry-run` materializes + prepares only — it spawns no Codex and is what the test suite
runs. Both scripts' paths are relative to the skill directory.

## How a fixture is reviewed

Each fixture under `references/calibration/<id>/` holds `base/` (committed) and `change/`
(overlaid as the working-tree diff). The runner materializes a throwaway git repo, then
calls the **same** two-phase runner as a real review (`prepare` → `run`), so every
production validation (bundle digest, schema, semantics, citations, drift checks) applies
verbatim. There is no fake codex in the real path — `--keep-artifacts` retains the repos
and bundles for inspection.

## Scoring

- **flag** = final verdict ≠ `PASS`; **should** = expected verdict ≠ `PASS`.
- Confusion matrix TP/FN/FP/TN; **recall** = TP/(TP+FN) — does it flag what should be
  flagged?; **precision** = TP/(TP+FP) — does it flag what should not be?; clean-pass rate
  = TN/(TN+FP).
- **Defect attribution** (heuristic): each buggy fixture lists `defects` with keywords; a
  defect counts as found when any finding's text mentions the keyword (case-insensitive).
  A finding that names the exact boundary value (`100`) or the throwing call (`toFixed`)
  is credited; the report shows per-fixture found/missing so a verdict that is right for
  the wrong reason is visible.
- `--threshold <r>` exits 1 when recall < r — for wiring calibration into a gate. Without
  it, calibration is measurement: exit 0 with the report.
- An errored fixture (e.g. `codex_failed`) is excluded from the matrix, listed as an
  error, and makes the run exit 1.

## Corpus (2026-08-19)

| id | kind | planted defect | expected |
|----|------|----------------|----------|
| `buggy-operator` | buggy | `>=` → `>` on shipping thresholds — off-by-one at exactly 100/50 | NEEDS-WORK |
| `missing-null-guard` | buggy | `renderCart` trusts nullable `discountPrice` — `null.toFixed` throws | NEEDS-WORK |
| `swallowed-error` | buggy | `fetchOrders` catches everything, returns `[]` — failure ≈ empty | NEEDS-WORK |
| `tautological-test` | buggy | new vip branch ships with a test that only asserts `typeof boolean` — passes equally well pre-change (rubric item 6) | NEEDS-WORK |
| `clean-refactor` | clean | `taxAmount` extracted; arithmetic identical | PASS |
| `clean-additive` | clean | additive `farewell()` with a genuinely failing-capable test | PASS |

## Interpretation

- Recall < 1 with no errors = the reviewer missed a planted defect — read that fixture's
  review to see why (severity too low, wrong anchoring, missed class).
- Precision < 1 = the reviewer flagged a clean diff — that is the false-positive cost of
  acting on review findings; a recurring FP on `clean-*` fixtures argues for rubric
  calibration, not acceptance of the FP.
- Defect keywords missing despite a correct verdict = the finding is right but vague —
  worth checking, since a vague finding is hard to act on.
- The corpus is deliberately small and cheap (6 fixtures, ~30s of Codex calls). It measures
  drift, not absolutes: run it before trusting a new model tier, after a rubric change, or
  on a schedule.
