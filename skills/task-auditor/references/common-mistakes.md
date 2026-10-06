# Common Mistakes


| Mistake | Fix |
|---|---|
| Running the extension when no note was written | Phase 3 step 5 runs only after step 2 wrote a note; without a notes root say "extension skipped, no note written" |
| Passing raw user input to `cs-atlassian` | Normalize first (Phase 0b): trim, extract from URL, strip `[[...]]`, uppercase, regex-validate |
| Running Phase 1 only to discover the CLI is missing | Phase 0a verifies `cs-atlassian` before any subagent dispatch — never reorder |
| Embedding raw verifier output in the audit body when parsing fails | Print unparseable output to stderr only; emit `calibration: skipped` with a short reason in the body |
| Adding `<project>` as a semantic tag (e.g. `acme` in tags when project is acme) | Project name is in `tags:` mechanically; semantic tags must be content-driven |
| Re-running the audit and silently clobbering yesterday's note | Phase 0f's "match from a previous day" branch creates a fresh dated note and keeps both |
| Running Phase 2.5 calibration inline in the orchestrator instead of dispatching a separate verifier subagent | Same-tier self-review is not calibration. Phase 2.5 demands `Agent({ subagent_type: "task-auditor-verifier" })` (sonnet + `effort: high`), on a tier distinct from Phase 2's. The rationalization "the data is unambiguous, a separate call would just agree" is the exact failure mode the verifier exists to catch. |
| Pinning the Phase 2.5 verifier to a cheaper tier to save cost | Cost tiering and correctness tiering are different axes. The verifier was `haiku` until 2026-07-27 — the one tier that accepted a false premise in the 2026-07-08 pressure test while Sonnet and Fable rejected it. A verifier that accepts false premises emits `aligned` verdicts carrying no information. |
| Running re-audit detection only at write time (after ~60s of fetch + analysis work) | Phase 0f runs the grep before any subagent dispatch — if the user picks Abort, no subagent cost is paid. Phase 3 just applies the filename Phase 0f resolved. |
