---
schema: 1
repo_name: demo
repo_root_commit: 0123456789abcdef0123456789abcdef01234567
target_branch: main
---

# State audit: demo

## Machines

### M001: Item loading
- old_id: UI-M9
- coverage: partial
- evidence_revision: f3c24361

Invariants:
- M001-I1 [code contract]: the loading flag is false once the request has settled

State: `itemStore.isLoading` (authoritative), `itemData` (derived).

### M002: Cart line writes
- coverage: full
- evidence_revision: f3c24361

Invariants:
- M002-I1 [product requirement]: the quantity shown equals the quantity the user last entered
- M002-I2 [investigator assumption]: a failed write restores the last server value

## Findings

### F001: Failed item lookup leaves the buy box blocked
- old_id: UI-F3
- machine: M001
- invariant: M001-I1
- lifecycle: open
- disposition: deferred
- severity: P2

#### Locator
Purpose: load the selected item. State role: pending-lookup flag. Trigger: item query rejection.
Violation: the flag stays true after the request ended. Anchors: flag writers, item query, error
callback, overlay consumer.

#### Trace
Variant selected, flag set, query fails, `onError` skips the result callback, nothing clears the
flag, the overlay stays.

#### Dependencies
Client defaults set no `watchQuery` error policy; unchanged since the previous observation.

#### Recipe
```bash
REV=feature/item_refactor
git grep -n "isItemLoading" "${REV}" -- src
git show "${REV}:src/api/client.ts"
git diff --name-only 6f2e7cb2 "${REV}" -- package.json
```

#### Observations

| run | revision | assessment | confidence | verification | on_target | note |
| --- | --- | --- | --- | --- | --- | --- |
| R000 | 6f2e7cb2 | present | confirmed | code_trace | yes | original audit |
| R001 | f3c24361 | present | confirmed | code_trace | no | anchors moved |

### F002: Overlapping quantity writes apply in arrival order
- machine: M002
- invariant: M002-I1
- lifecycle: closed
- disposition: resolved
- severity: P1

#### Locator
Purpose: keep the typed quantity. State role: pending write. Trigger: two quick edits.

#### Trace
Edit A starts, edit B starts, B resolves, A resolves and overwrites B.

#### Recipe
```bash
git grep -n "updateQuantity" "${REV}" -- src
```

#### Observations

| run | revision | assessment | confidence | verification | on_target | note |
| --- | --- | --- | --- | --- | --- | --- |
| R001 | aaaa111 | present | confirmed | code_trace | yes | first seen |
| R002 | bbbb222 | absent | confirmed | regression_test | yes | blocker: the write queue keeps the last intent |
| R003 | cccc333 | present | confirmed | code_trace | yes | came back after a refactor |

### F003: Failed write keeps the optimistic quantity
- machine: M002
- invariant: M002-I2
- lifecycle: open
- disposition: proposed

#### Locator
Purpose: restore after a failed write. State role: optimistic value. Trigger: mutation error.

#### Trace
Write fails, the optimistic value stays, the server value is not restored.

#### Recipe
```bash
git grep -n "optimistic" "${REV}" -- src
```

#### Observations

| run | revision | assessment | confidence | verification | on_target | note |
| --- | --- | --- | --- | --- | --- | --- |
| R002 | bbbb222 | unresolved | plausible | code_trace | unknown | reason: the wrapper source is not readable |

## Issues

### I001: Release the loading flag on every terminal state
- findings: F001
