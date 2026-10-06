# The --save note

Resolve `<notes root>` from the `Notes root: <dir>` line in the user's CLAUDE.md and
`<activity log>` from its `Activity log: <file>` line. No `Notes root:` line: refuse `--save`
in one sentence, print the synthesis, stop. No `Activity log:` line: write the note and skip
the log entry.

Inline output is the default. `--save` additionally writes ONE note.

Path: `<notes root>/second-views/YYYY-MM-DD-<topic-slug>.md`. Create the directory first (`mkdir -p`).

Root namespace only. A mid-brainstorm topic has no reliable project home, so
there is no `outputs/<project>/second-views/` variant.

Collision policy: if that path exists, append `-2`, then `-3`, and so on. Never
overwrite — two second views on the same topic on the same day are two separate
runs, not a revision of one.

Frontmatter:

```yaml
---
title: "Second view — <topic>"
source: second-view
target: conversation | <path-to-brief.md>
model: <model id used>
reasoning_effort: xhigh | config-inherit
sandbox: read-only
rubric: rubric-proposal.md
date_added: YYYY-MM-DD
tags: [second-view, <topic-tag>]
---
```

Body, in this order:

1. The four synthesis sections verbatim — `## Convergence`, `## Divergence`,
   `## New to me`, `## Verdict`.
2. `## Appendix A — brief sent to Codex` — the sent half only.
3. `## Appendix B — Codex proposal` — the raw unedited proposal.

**The withheld half is never written to this note.** It is the one piece of
content the whole design keeps off disk; persisting it here would defeat that
for the sake of an appendix nobody reads. If the synthesis needs to reference the
current direction, it paraphrases it in `## Divergence`.

Then prepend one line to `<activity log>` immediately after
the `<!-- log:entries -->` sentinel:

```markdown
## [<date>] second-view | <title> → [[<slug>]]
```

Read the log first — it changes frequently — then `Edit` with
`replace_all: false` on the sentinel line. If the sentinel is missing, say so in one
sentence and keep the note; do not append elsewhere.
