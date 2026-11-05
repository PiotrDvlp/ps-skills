---
name: quiz-gate
description: Use before pushing agent-built code, to prove you can explain it — "/quiz-gate", "quiz me before I push", "quiz-gate this branch", or when a push was blocked with `run /ps:quiz-gate`. Asks up to five questions on the unpushed diff, a fresh agent grades them, and a full score records a pass that the local pre-push hook checks. Skip for reviewing code correctness (code-review, codex-review) or auditing tests (test-teeth).
---

# quiz-gate

The user runs `/ps:quiz-gate [--plan <plan file>] [--remote <name>]` in the repo or worktree before a push. You ask the questions, a fresh agent grades the answers, and a full score records a pass per commit. The local `pre-push` hook blocks a push of any commit without a pass.

Below, `Q` stands for `node "${CLAUDE_SKILL_DIR}/scripts/quiz.mjs"`, run from the repo root. `${CLAUDE_SKILL_DIR}` is the directory holding this file; resolve it yourself when the variable is not substituted (Codex does not substitute it). Exit codes: `0` done, `1` failed quiz, `3` usage or setup problem (the message is on stderr).

## 1. Install the hook

Run `node "${CLAUDE_SKILL_DIR}/scripts/quiz.mjs" install` at the start of every quiz. It always rewrites the hook files, so it also puts the hook back after an `npm install` removed it in a husky repo. On exit 3, show the message (for example `run npm install first`, `pre-push exists; chain it by hand`, `hooks dir is tracked; install would change a team file`) and stop.

## 2. Pick the questions

Run `Q pick`, with `--plan <file>` and `--remote <name>` when the user gave them. It prints one JSON object:

- `{"status":"nothing to quiz"}`: every unpushed commit has a pass. Say so and stop.
- `{"status":"no eligible lines","attempt":"<id>"}`: the range changes only tests, docs or lockfiles. Run `Q record --no-eligible --attempt <id>`, say that the range had no eligible lines and the pass is recorded, and stop.
- `{"status":"quiz","attempt":"<id>","questions":[...],"skipped":[...]}`: show each `skipped` line to the user as it is, then go on.

Right after `pick`, save the repo path (`git rev-parse --show-toplevel`) and the tip sha (`git rev-parse HEAD`) for the packet.

## 3. Ask the questions

Ask the questions one at a time, in order, as `Question <n> of <N>`, the `text`, and for `line` and `equivalent` questions the `context` block in a fenced `text` block (`>` marks the asked line). Wait for the answer before you ask the next one.

Rules while the quiz runs:

- Never write an answer, a hint or a part of an answer, even when the user asks for one.
- Never explain the code.
- Never comment on an answer before all answers are given. Between questions, say nothing except the next question.
- The quiz is open book: the user may open any file.
- Keep each answer verbatim, as the user typed it. "I don't know" is an answer.

## 4. Grade

Build the packet in the shape of `fixtures/grade/right.md`:

- `# Grader packet`
- `Repo: <repo path>, tip <tip sha>`
- with `--plan`: `## Plan task`, then the plan task text and its result-block lines, copied from the plan file
- per question: `## q<n> (<kind>) <file>:<line>` (an assumption question has no `file:line`), then `Question:` with the text, `Context:` with the context block, `Hunk:` with the hunk (an assumption question has neither), and `Answer:` with the user's answer verbatim

Each context block, hunk and answer goes in its own fence (`text` for context and answer, `diff` for the hunk), and each fence is longer than the longest run of backticks inside it, at least three. A user's answer can contain ```.

Save `git status --porcelain`. Dispatch the grader with the Agent tool: a new `general-purpose` agent, no `model`, no `effort`, never a fork (a fork inherits this conversation). Its prompt is the content of `references/grader.md` followed by the packet. After the reply, run `git status --porcelain` again; any change fails the attempt: list the changed paths, do not run `record`, and go to step 6.

## 5. Record

Write the grader's reply, byte for byte as returned, to `quiz-grades-<attempt>.txt` in the scratchpad directory (or `$TMPDIR` when there is none). Nothing else is ever written to that file. Then run `Q record --attempt <id> --grades <file>`:

- Exit 0, `recorded N commits`: the attempt passed; the hook now lets these commits out.
- Exit 1, `score K/N; nothing recorded`: the attempt failed.
- Exit 3, `grader reply does not match the attempt`: send one format-repair message to the same grader agent (SendMessage), asking for the reply form of `references/grader.md` and nothing else. Write its new reply to the file the same way and run `record` again. A second exit 3 is a failed attempt.
- Exit 3, `range changed; run pick again`: a commit or checkout moved `HEAD` during the quiz. The attempt failed; say so.
- Any other exit 3: show the message and stop.

Never change the grader's reply, and never write grades of your own.

## 6. Show the result

For each question show the verdict, the grader's reason and its full answer. Then show the score. On a fail, offer a new attempt; it starts again at step 2 with a new `pick`, which picks new lines at random.

This skill never pushes, and never suggests `git push --no-verify`; that bypass is the human's call.

## Limits

- The gate is honour-based against the agent: `record` checks the attempt, the tip and the reply shape, but cannot prove a human typed the answers or a grader wrote the reply.
- `git push --no-verify` bypasses the hook; it is the human's escape and agents never use it.
- In a husky repo, each `npm install` removes the hook until the next quiz, and a worktree where the quiz never ran has no hook.
- The quiz samples: a pass on up to four lines and one assumption marks every commit in the range as passed, however large the range.
