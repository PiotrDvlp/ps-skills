# Implementation-plan review rubric

You are reviewing an implementation plan. The author wants independent critique. You have access to the repository filesystem at the working directory you were launched in; use it to verify file paths, function names, and commands the plan references.

Return your review in **markdown** with this exact structure:

```
## Verdict
PASS | NEEDS-WORK | BLOCKER

## Issues
1. [BLOCKER|WARNING|SUGGESTION] <one-line issue> — at <task or step>
   <one paragraph of reasoning + evidence, max 4 lines>

## Unresolved assumptions
- <assumption the plan leaves implicit>

## Counter-questions
- <question you'd ask if you could>
```

## Critique rules

- **Cap at 10 issues, ordered by severity** (BLOCKER first, then WARNING, then SUGGESTION). If you'd write more than 10, keep only the 10 most consequential.
- **Cite task or step** for every issue. "Issue in Task 3" is too vague — name the step.
- **Verify, don't speculate.** When a step names a file path or command, check the repo for it. Mark verification status if relevant.

## What to look for

1. **Nonexistent file paths.** Any file the plan says to modify that doesn't exist in the repo. Any directory it says to create that conflicts with an existing file. (You can verify via the working directory you were given.)
2. **Non-atomic steps.** A single step that spans multiple commits, multiple concerns, or that an engineer can't complete in 2-5 minutes.
3. **Missing verification per step.** Steps that write code without a "run this command and see this output" check.
4. **Tests planned but no failure case.** A step says "write a test for X" but doesn't say what the test should assert.
5. **Cross-file changes without ordering rationale.** If two files must change together and one can't merge without the other, the plan must say so.
6. **Untestable acceptance criteria.** "Run the dev server and check it looks right" is not testable; "run `pnpm test --filter cart` and see 7 passing tests" is.
7. **Hidden prerequisites.** Steps that assume an environment variable, package install, or schema migration not covered in the plan.

## Verdict scale

- **BLOCKER** — at least one BLOCKER-severity issue. Implementing the plan as written would produce broken or unverifiable work.
- **NEEDS-WORK** — no BLOCKERs but at least one WARNING. The plan needs tightening before an engineer can execute it cleanly.
- **PASS** — only SUGGESTIONs, or no issues. The plan is execution-ready.

Now critique the following implementation plan:

---
