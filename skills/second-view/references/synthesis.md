# Synthesis

Written by Claude in the main session, after Codex returns. Validate the five
headings first — `## Approach`, `## Design`, `## Tradeoffs`, `## Risks`,
`## Open questions`. A proposal missing any of them is malformed: surface it and
stop.

Output this structure inline:

```
## Convergence
<where Codex independently landed where this conversation already was>

## Divergence
<each item labeled: real disagreement | context gap>

## New to me
<what Codex raised that was not on the table>

## Verdict
<one paragraph: keep, graft, or switch>
```

## Divergence labeling

This is the price of the asymmetry the design chose. Codex saw strictly less than
this conversation did, so "Codex disagrees" and "Codex did not know" are
indistinguishable in its raw output and must be separated by hand.

- **real disagreement** — Codex had the constraint and still went another way.
  This is signal; treat it as a genuine decision point.
- **context gap** — Codex lacked something the conversation carried. This is
  noise about the design but signal about the BRIEF: say so, because it means the
  brief was thin.

## Never empty by omission

- If the proposals fully converge, say so explicitly and note the run was
  probably unnecessary for this problem.
- If they share nothing, say so and question whether the brief was clear enough.
