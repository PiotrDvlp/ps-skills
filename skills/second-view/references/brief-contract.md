# The two-part brief

Claude drafts both halves and shows both. Only the first reaches Codex.

```
=== SENT TO CODEX ===
Problem statement
Constraints          hard requirements, stack, what is fixed
Success criteria
Ruled out            what is already dead, and why

=== WITHHELD ===
Current direction    Claude's live position from the conversation
```

## Rules

- The user approves or edits before anything runs. An unapproved brief is never
  sent.
- `Ruled out` is the ONLY channel through which conversation content crosses the
  boundary, and it carries negatives only — what was rejected and why, never
  which live option is preferred. It exists because a reviewer kept fully
  uninformed re-proposes ideas already killed.
- The withheld half is NEVER written to a file *by this skill*. It stays in
  conversation context and is used only at synthesis. This invariant is
  already spent, not violated, by `/second-view <path-to-brief.md>`
  (`SKILL.md`'s invocation forms): a hand-authored brief file the user points
  at can itself already contain a withheld half on disk before the skill ever
  runs. When the target is a file, say so plainly in the confirmation
  message — do not imply the withheld half never touches disk in that form —
  and note that the file is readable by Codex regardless of what this skill
  passes to it.
- Marker strings are exact: `=== SENT TO CODEX ===` and `=== WITHHELD ===`.
  `buildPrompt` throws if the first is missing, or if the second precedes it.
