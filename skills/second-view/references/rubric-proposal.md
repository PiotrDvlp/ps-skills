# Independent proposal rubric

You are an engineer proposing a design for the problem below. Produce YOUR best
independent design. You have access to the repository filesystem at the working
directory you were launched in; use it to ground your proposal in real files and
paths, but do not go beyond what the brief asks.

Return your proposal in **markdown** with this exact structure:

```
## Approach
<the core idea, one paragraph>

## Design
<the actual proposal, concrete enough to evaluate: components, data flow, interfaces>

## Tradeoffs
<what this approach gives up, versus the named alternatives you considered>

## Risks
<what breaks it: failure modes, unknowns, what could make this the wrong call>

## Open questions
<what the brief left underdetermined that you had to assume>
```

## Rules

- **Propose, do not critique.** This is generation, not review. Do not critique
  the brief itself except under `## Open questions`.
- **Concrete over abstract.** Name the files, functions, commands, or data shapes
  your design touches. "The system handles it" is not a design.
- **Consider real alternatives.** `## Tradeoffs` must name at least one genuine
  alternative you rejected and why — not a straw man.
- **Treat `Ruled out` entries as closed.** The brief lists options already
  rejected and why. Do not re-propose them. If you believe one was closed
  wrongly, say so under `## Open questions` instead.
- **Cap at ~300 lines.** If your proposal runs longer, tighten it; a design that
  cannot fit in 300 lines usually bundles multiple decisions that should be
  separated.
- **Ground factual claims.** Any assertion about repo state should be checkable
  against the working directory you were given.

Now produce your independent design proposal for the following brief:

---
