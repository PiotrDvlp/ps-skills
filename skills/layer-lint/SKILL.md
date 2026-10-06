---
name: layer-lint
description: "Use when checking or enforcing SHOPin pageModules layer boundaries in futterhaus, betzold-vue, or brax — \"lint layers\", \"check layer boundaries\", \"did I break the layer rules\" — or before finishing work that touched pageModules/. Skip for the Obsidian vault (use lint) or repos without the SHOPin pageModules architecture."
---

# SHOPin layer-dependency linter

A standalone, zero-dependency Node tool (kept here, **not** committed into any app repo) that enforces SHOPin layer boundaries and emits agent-ready remediation. Full reference: `README.md` in this directory. Design rationale + review history: `outputs/futterhaus/plans/2026-06-01-shopin-layer-linter-design.md` in the Obsidian vault.

## How to run

`cd` into the target repo first so reported paths are clean, then point `--root` at
that repo's Nuxt `srcDir` — it differs per repo:

```bash
# futterhaus — srcDir is src/
cd <futterhaus checkout>
node "${CLAUDE_SKILL_DIR}/lint-layers.mjs" \
  --root=src --config="${CLAUDE_SKILL_DIR}/layer-lint.config.json"

# betzold-vue — srcDir is the repo ROOT
cd <betzold-vue checkout>
node "${CLAUDE_SKILL_DIR}/lint-layers.mjs" \
  --root=. --config="${CLAUDE_SKILL_DIR}/layer-lint.config.betzold.json"
```

`${CLAUDE_SKILL_DIR}` is the directory holding this file; resolve it yourself when the variable is not substituted (Codex does not substitute it).

Useful flags (see README for all): `--format=human|agent|json`, `--report-only` (never
gates — exit 0), `--root=<dir>` (default `src`), `--config=<path>`.

**Value flags require `=`.** Write `--config=<path>`, not `--config <path>` — the space
form (and any unknown flag) now exits 2 with a message rather than silently running with
no config. After every run the tool prints a coverage line to stderr
(`scanned N file(s), M in layers`); if it scanned files but classified **zero** into a
layer it exits 2 — a green run that inspected nothing is a broken run, not a clean pass.

- For self-correction in an edit loop, use `--format=agent` — each violation prints an imperative fix direction.
- For a machine check, use `--format=json` (emits `{ passes, violations }`); exit code is 1 on an unallowlisted error-severity violation unless `--report-only`.

## Per-repo config

`layer-lint.config.json` here is the **futterhaus** allowlist (seeds its 3 known inversions); `layer-lint.config.betzold.json` is betzold's (seeds its 3 known error-severity debts + layer aliases). The linter is shared across SHOPin repos but each repo has its own debt, so keep one config per repo alongside this skill and pass it via `--config=`. Each `allow` entry is rule-scoped; `error`-severity entries are debt to drive to zero.

**`layerAliases`** maps a repo-specific layer dir to a canonical layer so it is *enforced* rather than reported as `unknown-layer`. betzold uses `{ "utils": "helpers", "lazy-composables": "composables" }` — a `utils/` file is then checked with the `helpers` allow-set (and importing it is legal wherever `helpers` is), while output keeps the real `utils` name. The alias target must be a known layer (graphql, keys, helpers, mappers, stores, composables, components, views).

**`sharedModules`** promotes a `pageModules/` feature to a shared base like `common`: every feature may import all its layers (no `cross-feature-internal`), and it may not reach back into a feature (`shared-reaches-feature`, error). betzold uses `["form"]` (a shared UI kit — 16 of its cross-feature warnings were features legitimately using form).

## Scope note (v1)

Explicit `import`/`export … from` edges only (via `~/`/`@/` aliases and relative paths); `.vue` `<script>` blocks parsed; type-only imports ignored. Nuxt auto-imports and `#imports` are a reported blind spot, **not** a clean bill of health — a green run means "no explicit-import violations," not "architecturally clean."

Classification is **srcDir-agnostic**: it anchors on the `pageModules/`/`common/` segment, so it works whether srcDir is `src/` (futterhaus), the repo root (betzold), or `app/`. The zero-coverage guard (exit 2 when nothing classifies, or when `--root` matches no files at all) is the backstop against pointing `--root` at the wrong place.

## Reading a finding

**A finding means "at least this edge", never "this edge."** The blind spot is biased, not neutral: it hides exactly the dependencies written as auto-imports, so the explicitly-written one gets flagged while identical ones in the same file pass silently. On futterhaus, v1 sees 1 of 12 real `common-reaches-feature` edges.

Each finding therefore carries its own file's unanalyzed count:

```
! 4 further call(s) in this file are auto-imports and were NOT analyzed: useCoreGlobalParameters, …
```

When you see that line, **check whether the flagged edge is one of many before recommending a fix.** If it is, the defect is usually the file's layer placement, not the import — and "make the import implicit" is never the fix: it greens the run while hiding the same dependency.

## Tests

`cd "${CLAUDE_SKILL_DIR}" && node --test "test/*.test.mjs"` (117 fixture tests, zero deps).

## Gotchas

- **Value flags require `=`.** `--config=<path>`, not `--config <path>`. The space form (and any unknown flag) exits 2 with a message — this is deliberate, so a typo can't silently run with no config.
- **A green run is NOT a clean bill of health.** Only explicit `import`/`export … from` edges are checked; Nuxt auto-imports and `#imports` are a known blind spot. Green means "no explicit-import violations," nothing stronger. The summary line prints both blind-spot counts — read them before calling a run clean.
- **Never recommend hiding an edge to satisfy the linter.** Deleting an explicit import so a bare auto-imported call resolves it is not a fix; it is the same dependency, now invisible to the tool and to the reader. Named consts (`FILTER`) are not auto-importable at all, so it usually also means inlining a magic string.
- **Zero classifications → exit 2.** If the tool scanned files but classified none into a layer, that's a broken run (usually `--root` points at the wrong dir), not a clean pass.
- **`--root` differs per repo:** `src` for futterhaus, the repo root (`.`) for betzold. Each repo also has its own config file with its own debt allowlist — pass the right one via `--config=`.
