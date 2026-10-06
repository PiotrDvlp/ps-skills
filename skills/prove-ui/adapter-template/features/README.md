# <repo> feature map

Index of mapped features. Read before driving; each file is the recipe for one feature.

## Contract

Each feature file has an H1, one paragraph of user-visible behaviour, then exactly these
H2 sections in this order:

1. `Route and user entry` — every route and user entry point.
2. `Preconditions` — login, data, selected market, viewport, anything the state needs.
3. `Stable selectors` — ARIA role and name or `data-role`; never CSS classes, hashes or child indexes.
4. `States and discriminators` — each state worth proving and the value that tells it apart.
5. `Gotchas` — traps that waste or invalidate a run.

Rules: do not report a skipped entry point as verified through a different path. A file
never driven is marked `Status: draft` under its H1; a driven one says
`Status: proven <date> by <check id>`.

## Features

- (none yet)
