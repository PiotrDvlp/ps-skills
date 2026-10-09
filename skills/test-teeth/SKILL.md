---
name: test-teeth
description: Use when existing vitest unit tests under one feature should be audited for teeth — "audit the tests in cart", "which tests in productList kill nothing", "test-teeth audit". Runs sampled mutations and reports per test case what it killed and whether it is removable. Skip for writing new tests or for a single spec file's correctness.
---

# test-teeth

Reports which sampled production-code mutants each test case killed, then checks whether zero-kill cases can be removed while the feature suite stays green without new warning fingerprints. The report is evidence for a developer, not an instruction to delete tests.

## Run

```bash
node ${CLAUDE_SKILL_DIR}/scripts/test-teeth.mjs audit --root /path/to/your/repo --feature src/features/cart
```

Flags:

- `--max-mutations N`: total mutation budget, default 30. Hand-authored mutations always run in full, even when their count exceeds the budget; generated mutations fill any slots left.
- `--mutations file.json`: hand-authored `[{file, find, replace, note}]`; `file` is repo-relative. These run first.
- `--report PATH`: write the report and create its parent directory.
- `--timeout-ms N`: timeout for each vitest run, default 120000.
- `--vitest-bin PATH`: override `<root>/node_modules/.bin/vitest`.
- `--list-only`: print the mutation plan without running vitest.

Exit 0 means a report was produced; 2 means the baseline was not green; 3 means usage failure, manifest conflict, concurrent edit, another audit on the root, or missing/broken vitest discovery; 130 means SIGINT or SIGTERM interrupted vitest.

## Read the report

- `killed [M03]`: the case failed with an assertion on M03.
- `killed none of N sampled mutants (k in File)`: none failed the case; `k` valid mutants targeted its mapped implementation file.
- `killed none of N sampled mutants (0 in mapped impl)`: no implementation was mapped.
- `; runtime failure on [M01, M04]`: those mutants crashed this case without an assertion failure.
- `skipped at baseline`: vitest skipped, pended, or marked the case todo before mutation.
- `keep`: the case killed a mutant or was skipped at baseline.
- `removable: suite green, no new warnings`: removal kept the suite green without a new warning fingerprint.
- `; not together with [ids]: <not removable reason>`: every member was removable alone, but the smallest batch containing them failed for the stated reason.
- `not removable: <case or warning>`: removal caused the named case failure or a new warning fingerprint.
- `not removable: vitest exit <status>, <N> failed`: removal failed without a named failed case.
- `not removable: suite-level failure (likely a describe left with no tests)`: a suite failed or vitest exited non-zero without a failed case.
- `not removable: timed out after <N> ms`: the trimmed verification run exceeded its timeout.
- `not removable: no reporter output (vitest exit <status>)`: the trimmed run produced no parseable reporter file, including when its exit status was zero.
- `not verified: duplicate identity`: reporter identities collide.
- `not verified: unsupported call shape`: the call could not be located.
- `not verified: spec not in audited set`: vitest listed a spec outside the scan.
- `not verified: no impl mapped`: no sibling `.ts` or `.vue` implementation exists.
- `not verified: runtime failure on [ids]`: crashes make deletion evidence unreliable.
- `not verified: shared each() call`: rows share a call and not all are verifiable zero-kill cases.
- `not verified: shared call line`: distinct non-`each` cases share one source span, including cases generated inside a multi-line `describe.each`, so neither can be removed independently.
- `not verified: every test in describe "<path>" is zero-kill; delete the describe block and rerun`: trimming every case would leave an empty describe; remove the whole block manually and audit again.
- `not verified: no valid mutants`: every planned mutant was invalid, so deletion verification was skipped.
- `not verified: no mutants planned`: the audited implementations offered no mutation, so deletion verification was skipped.
- Mutant `killed`: at least one case failed with an assertion.
- Mutant `survived`: no case killed it.
- Mutant `survived (runtime failure in K cases)`: no assertion killed it, while K cases crashed.
- Mutant `invalid`: the mutation or reporter output could not provide valid evidence.
- Mutant `caught, unattributed`: vitest failed or timed out without attribution to a failed case.

## Before deleting

At the default budget a feature with 20 implementation files gets 1–2 mutants per file. `.vue` files get template mutants before script mutants. `removable` means only that no other test and no warning observed by this run depends on the case. Rerun with a larger `--max-mutations` or targeted `--mutations` before deleting anything.

## While it runs

Do not edit files under `--feature`. Stop `nuxt dev` and vitest watchers first because they react to transient mutants. Run one audit per root at a time.

For exit 3 due to manifest conflict or concurrent edit, open each named file, decide which bytes are right, then `rm -rf <manifest dir>` and rerun.

Vitest 4 reporter shape is unverified; trust results on vitest 3 repos only until a vitest 4 fixture lands.

## Developing this skill

From the skill directory, run `node --test scripts/*.test.mjs`. Set `TEST_TEETH_VITEST_ROOT` to a repo with vitest 3 installed to run the integration tests; otherwise they are skipped.
