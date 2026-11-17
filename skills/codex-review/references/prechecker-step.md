# Prechecker pre-step (pre-flight step 3)

`design` and `plan` modes only. Run it only when both hold:

- `~/.claude/agents/plan-prechecker.md` exists.
- The user's `CLAUDE.md` has a `Notes root: <dir>` line.

Without a `Notes root:` line, skip silently and record nothing. With `Notes root:` set but no agent file, only append `{attemptId, target, status: "skipped"}` to `<log>` and go to step 5 below.

`<log>` is `<Notes root>/insights/self-improve/design-quality/trial.jsonl`. Append one JSON object per line. Every line carries `attemptId` = UTC `YYYYMMDDTHHMMSSZ` + `-` + 8 random hex characters (`openssl rand -hex 4`) + `-` + target basename. Make one `attemptId` per `/codex-review` call and reuse it on every line of that call.

The numbers in the table are the steps of this pre-step, not the pre-flight numbers.

| Step | Action | On failure |
|---|---|---|
| 1 | `mkdir -p` the `design-quality/` and `drafts/` directories, then append `{attemptId, target (absolute path), status: "started"}` to `<log>`. | `mkdir` or append fails: tell the user, skip steps 2–4, continue with step 5. No trial record. |
| 2 | Copy the target to `<Notes root>/insights/self-improve/design-quality/drafts/<attemptId>.md`. | Copy fails: append `status: "failed"`, `reason`, go to step 5. |
| 3 | Run `date +%s` before and after one `plan-prechecker` dispatch (session model) with the target and repo root. Fix accepted findings; note each rejected one with a reason. In `plan` mode, rerun `check-plan.mjs` on the fixed target; exit 1 stops as in pre-flight step 2. | Dispatch error, or no valid JSON block: append `status: "failed"`, `reason`; no second dispatch; go to step 5. |
| 4 | Append `{attemptId, status: "prechecked", durationMs, findings, accepted, rejected}`. | Append fails: tell the user; the attempt stays `started` and becomes an orphan. |
| 5 | Run Codex as today. Never pass the prechecker report to Codex (Hard rule 2). | Unchanged. |
| 6 | After the review note is written, append `{attemptId, status: "reviewed", reviewNote: <note path>}`. | Append fails: tell the user; the attempt is an orphan. |

Details:

- Step 3 dispatch: Agent tool, `subagent_type: "plan-prechecker"`, with the absolute target path and the repo root from `references/repo-root.md`. Its report ends in one fenced `json` block with a `findings` array.
- Step 4 values: `durationMs` = (second `date +%s` − first) × 1000. `findings`, `accepted` and `rejected` are counts.
- Step 5: continue with pre-flight step 4 and the rest of this skill.
- Step 6: `reviewNote` is the absolute path of the note this skill wrote.

Reading `<log>`: rows merge per `attemptId`, the last status wins, and `failed` stays `failed` after a later `reviewed`. Second run on the same target: a new `attemptId`, new draft file, new rows; the report uses the first reviewed attempt. A crash anywhere leaves at worst an orphan attempt, which the report prints and leaves out. Two concurrent attempts get different `attemptId`s through the random part, also within one second and for targets with the same basename.
