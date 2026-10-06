---
name: codex-review
description: "Use when Codex should act as an independent read-only reviewer of a design, plan, or code diff, or run a design duel — \"codex review X\", \"have Codex critique the plan\", \"duel this problem\". Skip if the user wants Codex to apply fixes; use `codex apply` instead."
---

# Codex Review

You are running Codex as an isolated reviewer over a single artifact. Codex critiques; you (Claude Code) capture the output and write the review note. The boundary is load-bearing — Codex is read-only and never writes files; this skill is the only writer.

## Invocation forms

Treat the following as the canonical entry points:

- `/codex-review design <path-to-file.md>`
- `/codex-review plan <path-to-file.md>`
- `/codex-review code` (= diff vs HEAD via `--uncommitted`)
- `/codex-review code --base <branch>`
- `/codex-review code --commit <sha>`
- `/codex-review code --deep` (= same model at `-c model_reasoning_effort="xhigh"` for hard correctness/security work)
- `/codex-review calibration [--filter <id>] [--model <m>] [--deep] [--threshold <recall>]`
  — measure the reviewer against the known-verdict corpus (`references/calibration/`):
  recall/precision over planted defects and clean diffs. Read-only measurement by default;
  `--threshold` turns it into a gate. See `references/calibration.md`.
- `/codex-review design <path> --deep` / `/codex-review plan <path> --deep` (same effort raise, via the `codex exec` form)
- `/codex-review duel <path-to-brief.md>` (blind two-track design generation)

Common flags:
- `--model <name>` — model override. Default `gpt-5.6-terra` for all modes, including `--deep`.
  - `gpt-5.6-terra` is the cost-balanced default for routine reviews. For high-risk correctness or security work, opt into `--model gpt-5.6-sol`; use `--model gpt-6-astra` only when its extra cost is justified. `gpt-5.6-luna` remains available for calibration experiments, not production review defaults.
  - **`gpt-5.6-pro` is not usable here** — verified 2026-08-06, it returns HTTP 400 `invalid_request_error`: "The 'gpt-5.6-pro' model is not supported when using Codex with a ChatGPT account." Reject it with a one-line error instead of burning a run on it.
- `--deep` — raises reasoning effort on the already-resolved model: append `-c model_reasoning_effort="xhigh"` to the Codex invocation. It never changes the selected model — use `--model gpt-5.6-sol --deep` for a high-risk review. Without `--deep`, Codex inherits `model_reasoning_effort` from `~/.codex/config.toml`.
  - Valid in `code`, `design`, and `plan` modes. **Reject `--deep` in `duel` mode** with a one-line error: it would raise effort on the Codex track only, and a stronger generator on one side is the exact asymmetry the blindness invariant forbids (see `references/invocation-duel.md`).
  - Every mode's spoke must actually apply the override when `--deep` is passed. If a spoke does not, do **not** record `reasoning_effort: xhigh` — the frontmatter would claim an effort the run never used.
- `--claude-model <name>` — duel mode only: Claude-side subagent model, one of `sonnet | opus | haiku | fable`. Default: omit to inherit the session model.
- `--repo <path>` — explicit repo root for `-C` (design/plan modes); overrides plan frontmatter and `git rev-parse`
- `--out <path>` — output path override
- `--force` — skip the soft-warn size guardrail and the plan-mode acceptance-criteria gate

## Hard rules (refuse if violated)

1. Codex always runs with `-s read-only`. **Reject any `--sandbox` override** with a one-line error and stop.
2. **Never prefill Codex with conversation history**, memory, or notes. The prompt is artifact + rubric, plus in code mode an optional `run --context <file>` holding verification the caller already performed (measured results, not opinions or direction); the runner frames it as data that cannot waive a rubric item.
3. **Refuse to run `codex apply`, `codex exec workspace-write`, or any writing Codex subcommand** under this skill. `codex exec` **under `-s read-only`** is permitted — it is how design, plan, duel, and (since 2026-08-15) code mode all invoke Codex. The rule that matters is the sandbox, not the subcommand name: `codex review` was never safer than `codex exec`, it was merely narrower, and it could not carry a rubric.
4. **Hard refuse** if the target artifact is ≥500 KiB. Suggest the user decompose it into smaller artifacts.
5. **Duel mode: both generators get rubric + brief and nothing else.** No conversation history, no hot-cache notes, no memory, no cross-feeding of one proposal into the other. Any per-side prompt asymmetry defeats the mode — refuse and restate the brief-only rule. Codex's read-only sandbox (rule 1) still applies to the duel's Codex track.

## Pre-flight checks

Before invoking Codex, run these in order. Stop with a clear error message if any fails:

1. `command -v codex` — verify the Codex CLI is installed. If missing: tell the user to install Codex CLI 0.130.0+.
2. Verify the target exists:
   - `design` / `plan` mode: `test -f <target-path>` ; if missing, abort.
   - `code` mode: `git rev-parse --is-inside-work-tree` from cwd; if not in a git repo, abort.
   - `plan` mode only, after the file exists: run `node "${CLAUDE_SKILL_DIR}/scripts/check-plan.mjs" <target-path>`. `${CLAUDE_SKILL_DIR}` is the directory holding this file; resolve it yourself where it is not substituted (inside `references/`, or under Codex). Exit 1 means the plan's acceptance criteria are not executable (no command, no expected output, or an unresolved placeholder), a `Task N` section has no verification command or expected result, or a test/typecheck/build is piped into tail/grep/head without `pipefail`; print the script's findings verbatim and stop without calling Codex, unless `--force` was passed. Exit 2 means the file could not be read; stop, `--force` does not apply. Fixing these first saves the Codex round that would only report rubric item 6.
3. Soft warn if the target artifact size ≥50 KiB (`wc -c <target>`); suggest decomposition. At or above 50 KiB, stop and ask unless `--force` was passed.
4. Hard refuse if the target artifact size ≥500 KiB. Stop.
5. For `code` mode only: check for a `## Review mode` heading in **either** `<repo-root>/AGENTS.md` **or** `~/.codex/AGENTS.md` — Codex merges the global file into every session, so the global one covers all repos. Warn only if the heading is in neither (continue anyway). This section is the only lever that exists on what Codex reads; see the sandbox gotcha below for why.
6. For `duel` mode only: the brief must be self-contained. If it lacks a clear problem statement, constraints, OR success criteria (judged loosely, not by literal headings), warn that a thin brief produces divergence noise rather than signal, and continue only on user confirmation or `--force`.

## Gotchas

- **Code mode does not use `codex review` and has no transcript to parse. Do not reintroduce one.** Why this matters: `codex review`'s `[PROMPT]` argument is mutually exclusive with `--uncommitted`, `--base`, and `--commit`, so code mode could never deliver a rubric — and across 81 notes written that way the structured branch fired **zero** times (25 PASS-shaped, 55 unstructured `NEEDS-WORK` fallback). `NEEDS-WORK` meant only "Codex returned prose", and the whole transcript-parsing protocol existed to compensate for the missing rubric. Code mode now runs `scripts/run-code-review.mjs`, which gets a strict `--output-schema` and validates every finding against the reviewed patch. See `references/invocation-code.md`.
- **A code-mode `PASS` means every path in scope was reviewable.** Why this matters: binary and submodule changes have no citable line, so a reviewer can return a clean `PASS` over a patch it could not actually examine. The runner records `unreviewable_paths` and caps `final_verdict` at `NEEDS-WORK` when any exist, while preserving `reviewer_verdict` verbatim. Report both; do not collapse them.
- **`-s read-only` is non-negotiable: without it the reviewer silently inherits `sandbox_mode` from `~/.codex/config.toml` (`workspace-write` today), with no error.** Why this matters: the flag is the only thing making the reviewer read-only; an omission yields a reviewer that can edit the very files it is judging — the boundary this skill is built on — and nothing in the output reveals it. Do not rely on the config default being the mild one. There is no read-scoping counterpart: the sandbox governs writes only, so `AGENTS.md` is the only lever on what Codex reads.
- **Reject `--sandbox` overrides, `codex apply`, `codex exec workspace-write`, and any writing Codex subcommand under this skill; `codex exec` under `-s read-only` is the permitted invocation.** Why this matters: the read-only sandbox is what makes Codex a trustable independent reviewer in this skill's design. Any write capability collapses the boundary that justifies the skill's existence — at that point the user should run `codex apply` themselves. (From the `## Hard rules` section.)

## Resolution and invocation (spokes)

Load references/repo-root.md for the `-C <repo-root>` resolution order used by design/plan modes.
Load references/output-routing.md for the `--out` flag and the notes-root routing.
Load references/invocation-design-plan.md for the prompt-file + tmp-output stdin protocol used by design/plan modes.
Load references/invocation-code.md for the two-phase `run-code-review.mjs` protocol used by code mode (prepare → size decision → run → write-note).
Load references/rubric-duel.md for the shared proposal rubric given verbatim to both duel generators.
Load references/invocation-duel.md for the duel parallel-blind execution protocol and synthesis structure.
Load references/calibration.md for the `calibration` invocation — corpus, scoring, and interpretation (recall/precision over known-verdict diffs).

## Writing the review note

The note is written by THIS skill (Claude), not by Codex. Codex is read-only.

Frontmatter:

```yaml
---
title: "Codex review — <target or git ref>"                               # cross-graph (log.md entry line, note listings)
source: codex-review                                                     # cross-graph (note discovery / skill attribution)
mode: design | plan | code | duel                                        # machine-produced (writer hardcodes it); no in-graph reader
target: <path or git ref>                                                # human-audit
model: <model id used>                                                   # human-audit
reasoning_effort: xhigh | high | config-inherit             # code mode is always explicit (high, or xhigh with --deep); other modes inherit   # human-audit
claude_model: <claude model id or "session-inherit">      # duel mode only   # human-audit
shared_prompt_sha256: <sha256 of the shared prompt file>   # duel mode only — build-time input to verify-duel-symmetry.mjs (passed as --recorded-sha); the note copy is human-audit evidence
shared_prompt_verified: true                               # duel mode only — set only after the verify script passed   # human-audit (synthesis self-check evidence)
sandbox: read-only                                                       # machine-produced (runner emits it); no in-graph reader
rubric: rubric-design.md | rubric-plan.md | rubric-code.md | rubric-duel.md   # human-audit
repo_root_resolved: true | false                                        # human-audit
repo_read: ok | failed                                     # design/plan modes; human-audit — failed = nested-Seatbelt blind run, see invocation-design-plan.md step 5
date_added: YYYY-MM-DD                                                   # cross-graph (log.md entry, note listings)
tags: [codex-review, <mode>]                                             # cross-graph (note discovery)
---
```

**Every frontmatter field names its consumer at introduction** — an in-graph job (a script that reads it back), a named downstream workflow, or explicitly "human audit". A field with no consumer doesn't get added: frontmatter is where dead arrows accrete.

Body:

- **Design / plan modes** — the validated Codex output (Verdict / Issues / Unresolved assumptions / Counter-questions), unchanged. The two required headings come from the rubric and Codex emits them directly.
- **Code mode** — written by `scripts/write-note.mjs` from the runner's result object, not by hand. It renders `## Verdict`, `## Issues`, an `## Incomplete coverage` section when `unreviewable_paths` is non-empty, and `## Unresolved assumptions` when present; the shared routing calls it with `--no-log` and prepends the log entry per "Log integration", and only an extension may let the writer prepend the entry itself. Do not compose this body manually; the writer refuses on a failed run and that gate is the point.
- **Duel mode** — the synthesis produced by *Invocation — duel mode* Step 4 (`## Verdict` / `## Synthesis` / `## Convergence` / `## Divergence` / `## Discarded`), followed by `## Appendix A — Claude proposal` and `## Appendix B — Codex proposal`, each holding that generator's raw unedited proposal.

**Never truncate the issue list after the fact.** The rubric caps at 10 issues upstream. If Codex returns more than 10:
- Write all of them.
- Append a one-line warning at the end of the note: `> [!warning] Codex returned N > 10 issues; rubric cap not held.`

Write the file with `Write`. If a file with the same path already exists, append a `-2`, `-3`, ... suffix.

## Log integration

Only when the user's `CLAUDE.md` has an `Activity log: <file>` line and that file exists. Prepend one entry immediately after the `<!-- log:entries -->` sentinel:

```markdown
## [<date>] codex-review | <title> → [[<slug>]]
```

Use `Read` first (the file changes frequently), then `Edit` with `replace_all: false` on the sentinel line. If the sentinel is missing, say so in one sentence and keep the note; do not append elsewhere. No `Activity log:` line: skip this section.

The shared code-mode routing always passes `--no-log` to the writer and prepends the entry here. Only a `codex-review extension:` file may omit `--no-log`, and then only for a notes root that holds its own `log.md`, so the writer's all-or-nothing note-plus-log handoff applies.

## Confirmation message

After writing, respond with a one-line summary:

```
Codex review saved to <absolute-path> (verdict: <VERDICT>, issues: <count>)
```

For `duel` mode, use instead:

```
Design duel saved to <absolute-path> (verdict: <winner-or-hybrid>, convergence points: <N>, divergence points: <M>)
```

Then stop. Do not auto-iterate, do not address the issues, do not re-invoke Codex. The user (or Claude in the next turn) decides what to act on.

## Recording dispositions

Whoever later acts on the review (fixing the plan before presenting it, or deciding not to) appends one section to the review note, one line per issue, numbered by its position in `## Issues`:

```markdown
## Disposition

- #1 accepted: <what changed, where>
- #2 rejected: <why the finding does not hold, with evidence>
```

- Every issue gets a line; `rejected` always carries a reason.
- Reject a finding that rests on a repo the reviewer could not read only after checking the claim yourself.
- Keep this exact line shape: tooling that mines review notes can then skip `#N rejected` issues, so a known-wrong finding is not learned from. Free-prose dispositions are not parsed.

## Repeat rounds on the same target

Before deciding on another round for a target that already has a review note (same slug with a `-2`, `-3` … suffix), compare the new issues with every earlier round's issues and dispositions:

- **Repeat:** the theme already appeared in an earlier round and was marked accepted — baseline ordering, acceptance wording, step atomicity, gate or data prerequisites, reworded.
- **Stop when every new issue is a repeat or a verification-process WARNING.** Record them in `## Disposition`, then tell the user in one line which themes keep coming back, so they decide whether the plan or the reviewer is wrong. Do not start round N+1 on your own.
- **A new BLOCKER on substance** (wrong behaviour, missing requirement, security, data loss) always justifies another round.

Why: one plan review ran 5 rounds and 36 issues, still BLOCKER at round 5, with the same three themes recurring every round; every finding was acted on, so the cost was rounds, not false positives.

## Boundaries

- Do not auto-fix any issue Codex raises. Apply is a separate concern.
- Do not edit the target file under any circumstance.
- Do not pass conversation history, hot-cache notes, or memory entries to Codex. Artifact + rubric only. **This constrains what this skill sends, not what Codex reads.** `-s read-only` is a *write* sandbox: verified 2026-08-06 on Codex 0.144.5, it grants `access: read` on `{kind: root}` — the whole filesystem. Codex shells out during a review and has been observed self-loading a personal hot-cache note unprompted. Treat reviewer isolation as a best-effort property of the prompt, not an enforced one, and discount a review that cites context it was never handed.
- Do not invoke Codex more than once per `/codex-review` call. Each invocation = one round. If the user wants another pass, they reinvoke explicitly.
