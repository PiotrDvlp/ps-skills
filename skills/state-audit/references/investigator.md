# Investigator packet

The main session sends one packet per investigator. An investigator reads code only and returns
records; it never edits files and never dispatches its own agents.

## Packet (sent)

```text
run ID and target revision (read code with git show "${REV}:path" / git grep ... "${REV}")
area and its entry points (routes, components, stores, middleware)
shared code it may read (clients, wrappers, helpers), and which machine it reports
exclusions (areas owned by another packet)
required scenarios:
  - error results and rejected promises
  - retry after an uncertain completion
  - overlapping writes and stale responses
  - unmount and navigation while work is pending
  - identity change (login, logout, guest to user) and other tabs
  - server-side render and hydration
  - who owns pending-action and overlay state
depth: full | inventory
output limit: 8 detailed candidates, then leads
```

The cross-area packet gets the seams instead of an area: pairs of machines that share state or
hand work to each other.

## Return

1. **Machines**, in the `records.md` machine shape: state, states as predicates, invariants with
   their basis, transitions (event, guard, next state, writer, async effect, error or cancel
   outcome, `file:line`), boundaries. With `depth: inventory`, only ID-less title, state, key files
   and a one-line description.
2. **Finding candidates** (full depth only), at most 8, in the `records.md` finding shape:
   machine, broken invariant, locator, trace (for concurrency, the exact interleaving and why the
   guards allow it), dependencies, recipe, and a proposed confidence. `confirmed` only when every
   step was traced in code; otherwise `plausible`, naming the unchecked runtime or backend
   behaviour.
3. **Leads**: one line each, for anything worth a look that did not fit the limit or was not
   traced.
4. **Coverage**: the coverage of each required scenario as `traced`, `partial`, `not_started` or
   `blocked`, with a reason.

Do not assign IDs; the main session does. Do not rate the whole area as safe; say what was
traced.
