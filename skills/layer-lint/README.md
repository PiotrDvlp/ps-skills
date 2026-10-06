# SHOPin layer-dependency linter

Mechanically enforces the SHOPin `pageModules/<feature>/{components,composables,graphql,mappers,stores,...}` layer boundaries, and emits **agent-formatted remediation** when an edge is wrong. v1, zero runtime deps, Node 20+.

Design doc (rationale, alternatives, future work): `outputs/futterhaus/plans/2026-06-01-shopin-layer-linter-design.md` in the Obsidian vault.

This ships as a skill in its own directory, **not** committed into any app repo. See `SKILL.md` for invocation conventions.

## Usage

`cd` into the target SHOPin repo first, then:

Point `--root` at the repo's Nuxt `srcDir`: `--root=src` for futterhaus, `--root=.` for
betzold (srcDir is the repo root). Value flags **require `=`** — `--config=<path>`, not
`--config <path>`; the space form (and any unknown flag) exits 2 rather than silently
running with no config.

```bash
L="${CLAUDE_SKILL_DIR}"   # the directory holding this README
C=$L/layer-lint.config.json   # futterhaus; use layer-lint.config.betzold.json + --root=. for betzold
node $L/lint-layers.mjs --root=src --config=$C                       # human report (default)
node $L/lint-layers.mjs --root=src --config=$C --format=agent        # imperative fix-direction per violation
node $L/lint-layers.mjs --root=src --config=$C --format=json         # machine output + exit code
node $L/lint-layers.mjs --root=src --config=$C --report-only         # never gates (exit 0), passes flag still set
node $L/lint-layers.mjs --root=src --config=$C --report-dependencies # include #imports blind-spot edges in JSON

cd $L && node --test "test/*.test.mjs"                               # the linter's own fixture tests
```

Flags: `--format=human|agent|json`, `--report-only`, `--report-dependencies`, `--root=<dir>` (default `src`, relative to cwd), `--config=<path>` (default `./layer-lint.config.json`).

**Safety guards.** Classification is srcDir-agnostic (anchors on `pageModules/`/`common/`, so `src/`, root, and `app/` layouts all work). Every run prints `scanned N file(s), M in layers` to stderr; if it scans files but classifies **zero** into a layer it exits 2 — a green run that inspected nothing is a broken run, not a clean pass.

## The rule (single source of truth)

A layer may import **only** the layers in its allow-set; anything else is a violation (deny-by-default). Tier numbers are just a reading aid.

| Layer         | May import                                                         |
| ------------- | ------------------------------------------------------------------ |
| `graphql`     | (nothing in-app)                                                   |
| `keys`        | `keys`                                                             |
| `helpers`     | `helpers`, `keys`, `graphql`                                       |
| `mappers`     | `mappers`, `helpers`, `keys`, `graphql`                            |
| `stores`      | `stores`, `mappers`, `helpers`, `keys`, `graphql`                  |
| `composables` | `composables`, `stores`, `mappers`, `helpers`, `keys`, `graphql`   |
| `components`  | `components` (sibling), `composables`, `stores`, `helpers`, `keys` |
| `views`       | `views`, `components`, `composables`, `stores`, `helpers`, `keys`  |

Violation classes:

- `layer-inversion` (error) — target is above the importer (e.g. `mapper → store`).
- `skip-layer` (warn) — target is below but not allowed (e.g. `component → mapper`; route via a composable).
- `common-reaches-feature` (error) — `common/**` imports `pageModules/**`. `common` is the shared base; the dependency is one-directional.
- `shared-reaches-feature` (error) — a `sharedModules` module (a feature module promoted to a shared base, e.g. betzold's `form`) imports a non-shared feature. Same one-directional contract as common.
- `cross-feature-internal` (warn) — feature A imports feature B's private internals (`components`/`mappers`/`graphql`/`helpers`/`views`). Another feature's `stores`/`composables`/`keys` are its public surface and are allowed. A `sharedModules` module is a public surface in full (all its layers are importable), like common.
- `unknown-layer` (warn) — a file sits in a dir that is not a recognized layer; its edges are unchecked, so it is flagged rather than silently passed.

## Suppressing a finding

Two ways, both rule-scoped:

- Inline: `// layer-lint-disable-next-line <rule>` (suppresses the next line) or `// layer-lint-disable-line <rule>` (this line). Omit `<rule>` to suppress all rules on that line.
- Config allowlist (`layer-lint.config.json`) for durable, reviewed debt.

## What v1 sees (and doesn't)

- **Sees:** explicit `import`/`export … from` edges via the `~/` and `@/` aliases and relative paths. `.vue` `<script>` blocks are parsed; type-only imports (leading `import type` **or** an all-`{ type X }` binding list) are ignored.
- **Blind spots (counted and reported, never silent):** Nuxt auto-imports (a `.vue` calling `useCartStore()` with no import line) and `#imports`-routed symbols. Every run prints both counts. Resolving them to a layer is v2 (a project-wide symbol index built from `nuxt.config.ts imports.dirs`).

### Why the blind spot is reported per finding

The blind spot is not neutral incompleteness — **what it hides correlates with import style**, so the developer who writes a dependency explicitly is the one who gets flagged while identical auto-imported dependencies in the same file pass silently. Measured on futterhaus: of 12 real `common-reaches-feature` edges, v1 could see **1**.

That turns a v1 finding into a trap. A reviewer reads "this file reaches into a feature" and concludes the import is the defect, when it is usually the fifth instance of a pattern the tool cannot see — and the "fix" that follows is to hide the edge behind an auto-import, which greens the run and makes the codebase worse.

So every finding is annotated with its own file's unanalyzed call count:

```
✗ common-reaches-feature  src/common/composables/useCommonAsyncData.ts:5
    common/composables → globalParameter/composables
    ! 4 further call(s) in this file are auto-imports and were NOT analyzed: useCoreGlobalParameters, useCoreMainCategories, …
```

**Read a finding as "at least this edge", never "this edge".** Before acting on one, check the caveat: if the file has unanalyzed calls, the flagged line is a sample, not the population.

`--format=json` always carries `blindSpots: { sharpImports, unresolvedCalls }` alongside `violations`, so a machine consumer cannot read the violation list without the denominator. `--report-dependencies` adds the per-call detail.

**Precision of the unresolved-call count.** A call is unresolved when it is not imported, not declared in-file, and not a known runtime global (JS/DOM, Vue, Nuxt, vue-router, i18n, Apollo, Pinia, Vitest). Binding detection deliberately over-collects — declarations, destructuring, parameters and method definitions — because a missed binding produces a false alarm in a report whose only job is to be trusted, while an over-collected one merely undercounts. Measured on futterhaus: 311 distinct names, 3 false positives (~99%). The two known leaks are identifiers inside **regex literals** (the source masker blanks strings and comments, not regexes) and **parameters whose type annotations contain nested parens**.

## Config & adoption

`layer-lint.config.json` (repo root):

```json
{
  "severityOverrides": { "cross-feature-internal": "error" },
  "sharedModules": ["form"],
  "layerAliases": { "utils": "helpers", "lazy-composables": "composables" },
  "allow": [
    {
      "rule": "layer-inversion",
      "from": "*/mappers",
      "to": "common/stores",
      "files": ["**/mapProductPagePayload.ts"],
      "reason": "why, dated"
    }
  ]
}
```

- Each `allow` entry must name a `rule` (it suppresses only that rule). `from`/`to`/`files` globs support `*` (one segment), `**` (across), `?` (one char), `[abc]`/`[!abc]` classes, and `{a,b}` alternation. Optional `files` narrows by importer path.
- `severityOverrides` values must be `"error"` or `"warn"`, keyed by a known rule; the config loader rejects typos (so a mistyped override can't silently disable a gate).
- `layerAliases` maps a repo-specific layer dir to a canonical layer so it is **enforced** (checked with that layer's allow-set, and legal to import wherever the canonical is) rather than reported as `unknown-layer`. The target must be a known layer; output keeps the real dir name. betzold uses `{ "utils": "helpers", "lazy-composables": "composables" }`.
- `sharedModules` promotes a feature module to a **shared base** alongside `common`: every feature may import all of its layers without a `cross-feature-internal` warning, and it may not reach back into a feature (`shared-reaches-feature`, error). Use for genuine shared infrastructure that lives under `pageModules/` — betzold uses `["form"]` (a shared UI kit). Layer-direction rules still apply inside it.
- `error`-severity allow entries are technical debt — drive them to zero, then drop `--report-only` so the step gates.
