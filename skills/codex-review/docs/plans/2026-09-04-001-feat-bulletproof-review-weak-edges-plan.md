---
title: "feat: Bulletproof the weak edges in codex-review"
artifact_contract: ce-unified-plan/v1
artifact_readiness: implementation-ready
execution: code
product_contract_source: ce-plan-bootstrap
origin: session verification of codex-review graph (2026-09-04)
date_added: 2026-09-04
tags: [plan, codex-review, graph-integrity]
---

# feat: Bulletproof the weak edges in codex-review

---

## Product Contract

### Summary

Harden the three weak edges a 2026-09-04 graph verification surfaced in the `codex-review` skill: the duel mode's shared-prompt hash becomes verified rather than decorative, audit-only frontmatter fields get an explicit consumer story, and the vault `log.md` handoff fails loudly instead of silently when its contract breaks. No changes to the read-only reviewer boundary, the code-mode runner's validation layers, or any vault-side consumer.

### Problem Frame

The verification mapped the skill's job/arrow graph using the "an arrow is real only when the next job reads the last job's output" test and found no fake edges — but three weak ones:

1. **Duel `shared_prompt_sha256` is recorded, never re-checked.** The symmetry proof is written into frontmatter, but no downstream job verifies the shared prompt file still holds those bytes at synthesis time, nor that the Claude track actually consumed the hashed file. The proof is an arrow into a hypothetical auditor.
2. **Audit frontmatter is dead in-graph.** `rubric:`, `reasoning_effort:`, `repo_root_resolved:` have no machine consumer inside the skill. They are legitimately human-facing, but nothing says so — a future maintainer can't tell a load-bearing field from a stale habit, and new fields can accrete the same way.
3. **The `log.md` handoff degrades silently.** Code mode's writer aborts on a missing sentinel but only *after* the note file is already on disk (a partial write: note without log entry). A missing `log.md` crashes with a stack trace. The manual modes (design/plan/duel) have no guard at all. And nothing in the skill records who consumes the log line, so the entry format can drift away from `daily-context`/`queue-process` without anything noticing.

### Requirements

- **R1** — Duel-mode synthesis must verify shared-prompt integrity before synthesis runs: the shared prompt file's current hash matches the hash recorded at build time, the Claude track presents evidence (a reported hash) that it consumed those bytes, and the Codex track's consumption is enforced by construction — its prompt is piped from the same hashed file via stdin.
- **R2** — The frontmatter template and the note-writing instructions must distinguish machine-consumed fields from human-audit fields, and must require that any new frontmatter field names its consumer.
- **R3** — The `log.md` write path must be all-or-nothing: no note is written unless the log handoff will also succeed, and every mode's log integration validates the sentinel before editing.
- **R4** — The log entry format's downstream consumers (`daily-context`, `queue-process` in the vault) must be named in the skill, so changing the format triggers a check against them.

### Scope Boundaries

**Out of scope:**
- Changes to vault-side consumers (`daily-context`, `queue-process`, vault `log.md` structure) — different repos; this plan only hardens the producer side and documents the contract.
- Removing or re-purposing any existing frontmatter field.
- Changes to the code-mode runner's validation layers (schema, semantics, citations, drift) — the verification confirmed those are real edges.
- Calibration corpus changes.
- The `-s read-only` boundary and all hard rules — untouched by construction.

### Summary (stage-2 embed)

Plan hardens the three weak edges inside the codex-review skill repo only: duel shared-prompt hash verified at synthesis time, audit frontmatter given an explicit consumer story, and the vault log handoff guarded at write time. Read-only boundary, runner validation layers, and vault-side consumers untouched.

---

## Planning Contract

### Key Technical Decisions

- **KTD1: Duel-hash enforcement is a script, not prose.** A small standalone verify script runs at duel Step 3 and exits nonzero on mismatch. Rationale: this skill's own history shows manual protocols fail — the transcript-parsing protocol produced 0 structured verdicts across 81 notes. The verify step follows the same philosophy as `run-code-review.mjs`: a gate a test can falsify, not an instruction a session can skip. The Claude track additionally reports its own hash of the file it read, appended to its proposal, so byte-identical consumption is evidenced rather than assumed (the subagent computes the hash from the same file it was told to read — no extra file access).
- **KTD2: Audit frontmatter is documented, not machine-consumed.** Zero code. Building consumers for fields whose consumers are humans would create the exact fake-edge inversion this plan avoids — an arrow to a job that doesn't exist. The fix is a one-line inline classification in the frontmatter template plus a rule for future fields (R2).
- **KTD3: Log-handoff hardening is producer-side only.** Reorder `write-note.mjs` so the sentinel/`log.md` checks precede the note write (all-or-nothing), add a clean abort for a missing `log.md`, add the sentinel check to the manual-mode log-integration protocol, and document the consumer contract (R4). Contract enforcement on the consumer side is out of scope.
- **KTD4: Verification evidence lands in the duel note.** When hashes verify, the frontmatter `shared_prompt_sha256` line gains a companion `shared_prompt_verified: true` field; a mismatch aborts before any note exists. This converts the decorative field into a checked claim.

### Assumptions

- The `daily-context` and `queue-process` skills parse the `## [YYYY-MM-DD] codex-review | <title> → [[<slug>]]` line shape; this was inferred from their descriptions, not read. The contract note in R4 states the shape as produced, and the consumer skills remain the authority on what they accept.
- Subagents in the duel flow have shell access sufficient to compute a sha256 of the file they read (they already Read it; hashing is the same access level).

---

## Implementation Units

### U1. Duel shared-prompt integrity verification

**Goal:** Synthesis in duel mode cannot proceed unless the shared prompt's bytes are proven unchanged since build time and each track evidenced consumption.

**Requirements:** R1, R4 (partly — the verified field is frontmatter evolution)

**Dependencies:** none

**Files:**
- `scripts/verify-duel-symmetry.mjs` (new)
- `scripts/verify-duel-symmetry.test.mjs` (new)
- `references/invocation-duel.md`
- `SKILL.md`

**Approach:** New script takes `--shared-prompt <path>`, `--recorded-sha <sha256>`, and `--claude-sha <sha256>`. It re-hashes the file, compares against both the recorded hash and the Claude track's reported hash, and prints a JSON verdict (`{ok, computed, recorded, claudeReported}`) — nonzero exit on any mismatch or missing file. Protocol changes: duel Step 2's fixed subagent wrapper gains the instruction to append a `sha256: <hash>` line (of the shared prompt file) to its returned proposal; duel Step 3 gains a verify step between "read both outputs" and "validate headings," aborting with the raw hashes surfaced on failure. Step 4's note instructions add `shared_prompt_verified: true` to frontmatter only after the script passed — classified human-audit (synthesis self-check evidence). SKILL.md's duel bullet and frontmatter template pick up the new field.

**Patterns to follow:** `write-decision.mjs` (pure, testable decision logic), `run-code-review.mjs` (JSON verdict to stdout, nonzero exit on failure, no retries).

**Test scenarios:**
- Happy path: matching recorded and Claude-reported hashes → `{ok: true}`, exit 0.
- Drift: shared prompt file modified after build → `ok: false`, exit nonzero, computed vs recorded hashes in output.
- Claude-track divergence: file intact but Claude-reported hash differs → `ok: false`, exit nonzero (asymmetry detected even without file drift).
- Missing file: shared prompt path doesn't exist at verify time → clean error, exit nonzero.
- Missing arguments → usage error, exit 2.

**Verification:** `node --test scripts/verify-duel-symmetry.test.mjs` passes; the existing suite (79 tests) still passes.

### U2. Frontmatter consumer classification and new-field rule

**Goal:** Every frontmatter field declares who consumes it; future fields can't accrete as unlabeled dead arrows.

**Requirements:** R2

**Dependencies:** U1 (classifies the `shared_prompt_verified` field U1 introduces)

**Files:**
- `SKILL.md` (frontmatter template + "Writing the review note" section)

**Approach:** Inline comments on the frontmatter template classify each field: machine-produced but with no in-graph machine reader (`mode`, `sandbox` — hardcoded by the writer and emitted by the runner, never parsed back), cross-graph (consumed by other vault workflows), or human-audit (read by reviewers of the note). No template field currently has an in-graph machine reader. Add one rule to the note-writing section: a new frontmatter field must state its consumer at introduction — an in-graph job, a named downstream workflow, or explicitly "human audit" — and fields with no consumer don't get added.

**Patterns to follow:** The gotchas section's style — a rule paired with the failure it prevents.

**Test scenarios:**
- Test expectation: none — documentation-only change; verification is the U2 checklist item that every existing field carries a classification and no field is left unlabeled.

**Verification:** Reading the frontmatter template, every field's consumer is stated without needing code context.

### U3. All-or-nothing log.md handoff

**Goal:** A note and its log entry are written together or not at all, in every mode, and the log line's consumers are on record.

**Requirements:** R3, R4

**Dependencies:** none

**Files:**
- `scripts/write-note.mjs`
- `scripts/run-code-review.test.mjs` (or a focused `write-note` test addition)
- `SKILL.md` ("Log integration" section)

**Approach:** In `write-note.mjs`, move the sentinel check and `log.md` readability check above the note write, so both failure modes (missing sentinel, missing/unreadable `log.md`) abort before `writeFileSync(notePath, ...)`. Replace the uncaught `readFileSync(logPath)` throw with the same clean `[abort]` + exit-1 shape as the sentinel failure. In SKILL.md's Log integration section: add the pre-edit check for manual modes (Read first, confirm the sentinel exists, abort with a clear message if not — same protocol discipline as the code-mode writer), and add a short consumer-contract note naming `daily-context` and `queue-process` as the parsers of the `## [YYYY-MM-DD] codex-review | <title> → [[<slug>]]` shape, with the rule that changing the format requires checking those consumers first.

**Patterns to follow:** The existing `[abort]` + exit-1 handling in `write-note.mjs`; the writer-gate test pattern in `run-code-review.test.mjs` (refusal is a testable property).

**Test scenarios:**
- Happy path: note and log entry both written; entry sits directly after the sentinel.
- Sentinel missing → nothing written (no note file, no log change), exit 1, `[abort]` message naming the fix.
- `log.md` missing → nothing written, exit 1, clean message (no stack trace).
- `log.md` unreadable → nothing written, exit 1.
- Existing note-collision suffix behavior unchanged (`-2`, `-3`).

**Verification:** Focused writer tests pass; full suite passes; a manual dry run against a scratch vault confirms abort-before-write ordering.

---

## Verification Contract

- Full test suite green: `node --test scripts/*.test.mjs` (existing 79 + new U1/U3 cases).
- Duel protocol walkthrough: with a scratch brief, the Step 3 verify script passes on identical bytes and aborts on a deliberately modified shared prompt.
- Writer walkthrough: scratch-vault runs of the four U3 failure modes each write nothing.
- Frontmatter template review: no unlabeled fields remain (U2).
