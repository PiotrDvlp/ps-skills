# Invocation — duel mode


Duel mode runs two independent generators on the SAME brief, blind to each other, then the main session synthesizes. The blindness is the point: symmetric input (rubric + brief, nothing else) to both sides, parallel execution, synthesis only after both return.

**Blindness invariant:** neither generator sees the other's output, the conversation history, hot-cache notes, memory, or any hint that a second proposal exists. Both receive rubric + brief and nothing more. Any per-side asymmetry defeats the mode.

## Step 1: Build the shared prompt

Both generators receive the identical prompt — any per-side difference reintroduces the asymmetry the mode exists to remove. Build one prompt file in `$TMPDIR`. Record `shasum -a 256` of this shared prompt file into the note frontmatter as `shared_prompt_sha256`. This hash is a real symmetry proof only because **both tracks consume this exact file**: the Codex track reads it via stdin, and the Claude track's subagent is told to `Read` the same path (Step 2) rather than receiving a pasted copy that could silently diverge from the hashed bytes.

```
<contents of references/rubric-duel.md>

<contents of the brief file>
```

## Step 2: Launch both tracks in parallel

### Codex track (background)

Reuse the design/plan stdin protocol. Codex stays read-only:

```bash
codex exec -m <model> -s read-only --skip-git-repo-check [-C <repo-root>] \
  -o <tmp-codex-out> - < <shared-prompt-file>
```

Run it with `run_in_background: true` so the Claude track runs concurrently. Default `<model>` is `gpt-5.6-sol` (or `--model` override).

**`--deep` is rejected in duel mode** — reject it with a one-line error rather than honoring it. The override would apply to this track only, and the Claude track has no equivalent knob (`--claude-model` selects a model, not an effort). Handing one generator `xhigh` while the other runs at session effort is the same asymmetry as a weaker model, just in the opposite direction. Never add `-c model_reasoning_effort` to this command.

### Claude track (subagent)

Dispatch ONE fresh subagent via the Agent tool, in the SAME message as launching the Codex background job so both run concurrently:

- `subagent_type: "general-purpose"`
- `model:` — omit to inherit the session model; set only if `--claude-model` was passed. Accepted values: `sonnet | opus | haiku | fable`.
- `prompt:` — a fixed minimal wrapper that points the subagent at the shared prompt file, NOT an inline paste of the brief: `Read the file at <shared-prompt-file-path> and follow its instructions to produce your design proposal. Read no other file for context. Assume no other proposal exists. End your proposal with a final line in the form "sha256: <hash>" computed from the shared prompt file you read (e.g. via `shasum -a 256`) — it evidences the bytes you consumed and is verified before synthesis.` The subagent thus consumes the SAME byte-identical artifact Codex reads via stdin, so `shared_prompt_sha256` covers both tracks. A pasted brief is forbidden — it can silently diverge from the hashed file and defeat the symmetry proof.

## Step 3: Wait for both, then verify and validate

**Verify shared-prompt integrity before validating headings or synthesizing.** As soon as both tracks return, extract the trailing "sha256: <hash>" line from the returned Claude proposal — this is the only part of either proposal you read at this point; blindness binds the generators, not the synthesizer — then run the verify script before reading the Codex output file or either proposal in full. It re-hashes the shared prompt file and compares against both the build-time hash and the Claude track's reported hash:

```bash
node "${CLAUDE_SKILL_DIR}/scripts/verify-duel-symmetry.mjs" \
  --shared-prompt <shared-prompt-file> \
  --recorded-sha <value recorded in Step 1> \
  --claude-sha <hash from the subagent's "sha256:" line> \
  --emit <shared-prompt-file>.verified.json
```

On success the script writes a verdict sidecar JSON (`ok`, the three hashes, `verified_at`) next to the shared prompt; on any failure it writes no sidecar. Copy the verdict from the sidecar file and record `shared_prompt_verified: true` in the note frontmatter **only when the sidecar exists with `ok: true`** — the sidecar is the artifact, not the session's memory. Any nonzero exit is a symmetry violation: surface the raw hashes from the script's JSON and STOP. Do not retry, do not synthesize from one proposal — a duel that fails its symmetry proof is not a duel. If the Claude proposal lacks the `sha256:` line entirely, treat it as a failed Claude track under this same STOP protocol (surface the raw proposal; do not invoke the verify script with an empty hash).

Read the Codex output file and the subagent's returned proposal. Validate that EACH contains all five required headings: `## Approach`, `## Design`, `## Tradeoffs`, `## Risks`, `## Open questions`.

**If either side fails validation or errors:** surface that side's raw output and STOP. Do not retry silently. Do not synthesize from one proposal — a one-sided duel is just a proposal with extra steps. Tell the user to re-invoke.

## Step 4: Synthesize (main session)

The synthesizer sees BOTH proposals — blindness applies to the generators only. Write the synthesis with this exact structure:

```
## Verdict
<winner or hybrid, one paragraph>

## Synthesis
<the combined design, grafting the best of both>

## Convergence
<where both independently agree — high-confidence signal>

## Divergence
<real decision points: which side was taken, and why>

## Discarded
<what was rejected from each proposal, and why>
```

`## Convergence` and `## Divergence` are the mode's payoff and must never be empty-by-omission:
- If the proposals fully converge, say so explicitly and note the duel was likely unnecessary for this problem.
- If they share nothing, say so and question whether the brief was clear enough.

## Known limitations

The gate detects persistent drift (shared prompt modified after build) and Claude-side divergence (subagent consumed different bytes than the hashed file). It does **not** detect a mutate-and-restore race: the shared prompt swapped out and restored between Step 1 hashing and track consumption is undetectable by construction and accepted — exploiting it requires concurrent write access to the temp directory.
