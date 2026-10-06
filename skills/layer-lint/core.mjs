// Pure logic for the SHOPin pageModules layer-dependency linter.
// No runtime dependencies; see README.md beside this file and the design at
// outputs/futterhaus/plans/2026-06-01-shopin-layer-linter-design.md (in the vault).
import { posix } from 'node:path'

/**
 * Classify a repo-relative file path into its layer membership.
 * Returns { root, module, layer } for files under <srcDir>/pageModules/<m>/<layer>/
 * or <srcDir>/common/<layer>/, else null.
 *
 * srcDir-agnostic on purpose: futterhaus keeps code under `src/`, betzold's Nuxt
 * srcDir is the repo root (no prefix), a stock Nuxt 4 srcDir is `app/`. We anchor
 * on the distinctive `pageModules/`/`common/` segment rather than a hardcoded
 * prefix, so the same tool works across every SHOPin repo. (A hardcoded `src/`
 * silently classified nothing — hence a false green — on root-srcDir repos.)
 */
export function classifyFile(filePath) {
  const norm = filePath.replace(/\\/g, '/').replace(/^\.\//, '')
  let m = norm.match(/(?:^|\/)pageModules\/([^/]+)\/([^/]+)(?:\/|$)/)
  if (m) return { root: 'pageModules', module: m[1], layer: m[2] }
  m = norm.match(/(?:^|\/)common\/([^/]+)(?:\/|$)/)
  if (m) return { root: 'common', module: 'common', layer: m[1] }
  return null
}

/**
 * Resolve an import specifier (from a file at `fromFile`) to a target.
 * - `#imports` → { kind: 'sharp-imports' } (v1 blind spot, not resolved)
 * - `~/...` alias and `./`,`../` relative → resolved to a repo path, then
 *   classified: a hit in a layer → { kind:'layer', root, module, layer }
 * - everything else (externals, in-app paths outside pageModules/common)
 *   → { kind: 'ignored' }
 */
export function resolveSpecifier(specifier, fromFile) {
  if (specifier === '#imports') return { kind: 'sharp-imports' }

  let repoPath = null
  if (specifier.startsWith('~/') || specifier.startsWith('@/')) {
    // Nuxt maps both ~ and @ to srcDir. classifyFile is srcDir-agnostic, so we
    // don't prepend a prefix — `~/pageModules/…` and `~/common/…` classify on
    // their distinctive segment regardless of whether srcDir is src/, app/, or root.
    repoPath = specifier.slice(2)
  } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    repoPath = posix.normalize(posix.join(posix.dirname(fromFile), specifier))
  } else {
    return { kind: 'ignored' } // bare module, other alias (#app, etc.)
  }

  const cls = classifyFile(repoPath)
  return cls ? { kind: 'layer', ...cls } : { kind: 'ignored' }
}

// Authoritative allow-set (the single source of truth — see the design's layer
// model). A layer may import only the layers in its set; anything else is a
// violation. Tier numbers are a reading aid for inversion-vs-skip classification.
export const ALLOW = {
  graphql: new Set([]),
  keys: new Set(['keys']),
  helpers: new Set(['helpers', 'keys', 'graphql']),
  mappers: new Set(['mappers', 'helpers', 'keys', 'graphql']),
  stores: new Set(['stores', 'mappers', 'helpers', 'keys', 'graphql']),
  composables: new Set(['composables', 'stores', 'mappers', 'helpers', 'keys', 'graphql']),
  components: new Set(['components', 'composables', 'stores', 'helpers', 'keys']),
  views: new Set(['views', 'components', 'composables', 'stores', 'helpers', 'keys'])
}
const TIER = {
  graphql: 0,
  keys: 0,
  helpers: 1,
  mappers: 1,
  stores: 2,
  composables: 3,
  components: 4,
  views: 5
}

// Guard against ALLOW/TIER drift: a layer present in one but not the other would
// silently disable layer-direction checks for it. Fail loudly at load instead.
{
  const a = Object.keys(ALLOW).sort().join(',')
  const t = Object.keys(TIER).sort().join(',')
  if (a !== t) throw new Error(`layer-lint: ALLOW and TIER layer sets disagree (${a} vs ${t})`)
}

/** The recognized runtime layers. A dir outside this set is an unknown layer. */
export const KNOWN_LAYERS = new Set(Object.keys(TIER))

/** Rule ids the config may reference, and the valid severities. */
export const RULES = [
  'layer-inversion',
  'skip-layer',
  'common-reaches-feature',
  'shared-reaches-feature',
  'cross-feature-internal',
  'unknown-layer'
]
const SEVERITIES = new Set(['error', 'warn'])

// Layers that count as a feature module's private internals for cross-feature
// boundary checks (rule B). stores/composables/keys are the public surface
// (keys are shared injection-token contracts); everything else is internal.
const CROSS_FEATURE_INTERNAL = new Set(['components', 'mappers', 'graphql', 'helpers', 'views'])

/**
 * A location is a "shared base" if it is `common/` (built-in) or a feature
 * module the config designates as shared (`sharedModules`, e.g. betzold's `form`
 * — a shared UI kit). A shared base is a public surface every feature may import,
 * and — like common — must never reach back into a feature.
 */
function isSharedBase(loc, sharedModules) {
  if (loc.root === 'common') return true
  return loc.root === 'pageModules' && sharedModules.includes(loc.module)
}

/**
 * Evaluate a runtime dependency edge between two classified layer locations.
 * Returns null when allowed, else { rule, severity }. Priority: structural
 * shared-base→feature ban, then layer-direction (allow-set), then cross-feature
 * boundary. `sharedModules` are pageModules modules promoted to shared bases.
 * Severities are defaults; the CLI applies config overrides.
 */
export function evaluateEdge(from, to, sharedModules = []) {
  if (!from || !to) return null

  const toShared = isSharedBase(to, sharedModules)

  // Structural: common is the base of the base; it must never depend on ANY
  // pageModule — not even a shared one (form depends on common, never the reverse).
  if (from.root === 'common' && to.root === 'pageModules') {
    return { rule: 'common-reaches-feature', severity: 'error' }
  }

  // A config-designated shared module (not common) must likewise not reach into
  // a feature — same one-directional contract, distinct rule id for messaging.
  if (
    from.root === 'pageModules' &&
    sharedModules.includes(from.module) &&
    to.root === 'pageModules' &&
    !toShared
  ) {
    return { rule: 'shared-reaches-feature', severity: 'error' }
  }

  // Layer-direction (allow-set), only when both layers are known runtime layers.
  const allow = ALLOW[from.layer]
  const fromTier = TIER[from.layer]
  const toTier = TIER[to.layer]
  if (allow && fromTier !== undefined && toTier !== undefined && !allow.has(to.layer)) {
    return toTier > fromTier
      ? { rule: 'layer-inversion', severity: 'error' }
      : { rule: 'skip-layer', severity: 'warn' }
  }

  // Cross-feature boundary (rule B): reaching another feature's internals. A
  // shared base is a public surface (like common), so importing it is exempt.
  if (from.root === 'pageModules' && to.root === 'pageModules' && from.module !== to.module) {
    if (toShared) return null
    if (CROSS_FEATURE_INTERNAL.has(to.layer)) {
      return { rule: 'cross-feature-internal', severity: 'warn' }
    }
  }

  return null
}

// --- Config: validation, severity overrides, allowlist matching ---

/**
 * Convert a glob to an anchored RegExp. Supports `*` (one segment), `**` (across
 * segments), `?` (one non-separator char), `[abc]`/`[!abc]` char classes, and
 * `{a,b}` brace alternation (one level).
 */
function globToRe(glob) {
  let re = ''
  let brace = 0
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*'
        i++
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if (c === '{') {
      re += '(?:'
      brace++
    } else if (c === '}' && brace > 0) {
      re += ')'
      brace--
    } else if (c === ',' && brace > 0) {
      re += '|'
    } else if (c === '[') {
      // char class: copy through closing ], translating leading ! to ^
      let cls = '['
      i++
      if (glob[i] === '!') {
        cls += '^'
        i++
      }
      while (i < glob.length && glob[i] !== ']') {
        cls += glob[i]
        i++
      }
      re += cls + ']'
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp('^' + re + '$')
}
// Compiled-regex cache keyed by glob string — globs are static config, so this
// avoids recompiling on every violation × allow-entry comparison.
const globCache = new Map()
const globMatch = (glob, str) => {
  let re = globCache.get(glob)
  if (!re) {
    re = globToRe(glob)
    globCache.set(glob, re)
  }
  return re.test(str)
}

/** Validate and normalize a layer-lint config. Throws on a malformed allow entry. */
export function validateConfig(config) {
  const c = config || {}
  const allow = (c.allow || []).map((entry, i) => {
    if (!entry || typeof entry.rule !== 'string' || !entry.rule) {
      throw new Error(`layer-lint config: allow[${i}] is missing required "rule"`)
    }
    if (typeof entry.from !== 'string' || typeof entry.to !== 'string') {
      throw new Error(`layer-lint config: allow[${i}] needs string "from" and "to"`)
    }
    return {
      rule: entry.rule,
      from: entry.from,
      to: entry.to,
      files: entry.files || null,
      reason: entry.reason || null
    }
  })
  const severityOverrides = c.severityOverrides || {}
  for (const [rule, severity] of Object.entries(severityOverrides)) {
    if (!RULES.includes(rule)) {
      throw new Error(`layer-lint config: severityOverrides references unknown rule "${rule}"`)
    }
    if (!SEVERITIES.has(severity)) {
      throw new Error(
        `layer-lint config: severityOverrides["${rule}"] must be "error" or "warn", got "${severity}"`
      )
    }
  }
  // sharedModules: pageModules modules promoted to shared public bases (like
  // `common`) — every feature may import them, and they may not reach back into
  // a feature. betzold uses `["form"]` (a shared UI kit).
  const sharedModules = c.sharedModules || []
  if (!Array.isArray(sharedModules) || sharedModules.some((m) => typeof m !== 'string')) {
    throw new Error('layer-lint config: sharedModules must be an array of module-name strings')
  }
  // layerAliases: map a repo-specific layer dir (e.g. betzold's `utils`,
  // `lazy-composables`) to a canonical layer. The dir is then checked with the
  // canonical layer's allow-set and tier — so it is *enforced*, not silenced —
  // while output keeps its real dir name. The target MUST be a known layer.
  const layerAliases = c.layerAliases || {}
  for (const [dir, canonical] of Object.entries(layerAliases)) {
    if (!KNOWN_LAYERS.has(canonical)) {
      throw new Error(
        `layer-lint config: layerAliases["${dir}"] points at unknown layer "${canonical}" ` +
          `(known: ${[...KNOWN_LAYERS].join(', ')})`
      )
    }
  }
  return { severityOverrides, allow, layerAliases, sharedModules }
}

/** Resolve a layer dir name to its canonical layer, honoring config aliases. */
export function canonicalLayer(layer, config) {
  return (config && config.layerAliases && config.layerAliases[layer]) || layer
}

/** Resolve a rule's severity, honoring config overrides. */
export function effectiveSeverity(rule, defaultSeverity, config) {
  return (config && config.severityOverrides && config.severityOverrides[rule]) || defaultSeverity
}

/**
 * Is this violation suppressed by the allowlist? An entry suppresses only when
 * rule matches exactly AND from/to globs match AND (if present) one of `files`
 * globs matches the importing file path.
 */
export function isAllowlisted(violation, config) {
  if (!config || !config.allow) return false
  return config.allow.some((a) => {
    if (a.rule !== violation.rule) return false
    if (!globMatch(a.from, violation.from) || !globMatch(a.to, violation.to)) return false
    if (a.files && a.files.length) {
      return a.files.some((f) => globMatch(f, violation.file))
    }
    return true
  })
}

// --- Remediation + per-file linting ---

const label = (loc) => `${loc.module}/${loc.layer}`

/** Agent-voice fix direction for a rule, parameterized by the offending edge. */
export function fixFor(rule, from, to) {
  switch (rule) {
    case 'layer-inversion':
      return `${from.layer} sits below ${to.layer}; a ${from.layer} must not depend on a ${to.layer}. Move the ${to.layer} read into a caller higher up (composable/store) and pass the value in, or relocate the logic.`
    case 'skip-layer':
      return `${from.layer} should not reach a ${to.layer} directly. Route the data through a composable instead of importing the ${to.layer} from a ${from.layer}.`
    case 'common-reaches-feature':
      return `common/ is the shared base and must never import from a feature module (pageModules/${to.module}). Invert the dependency: move the shared piece into common/, or have the feature depend on common rather than the reverse.`
    case 'shared-reaches-feature':
      return `'${from.module}' is a shared base (every feature may import it) and must never import from a feature module ('${to.module}'). Invert: move the shared piece down into common/ or '${from.module}', or have the feature pass it in — a shared base can't depend on a feature.`
    case 'cross-feature-internal':
      return `'${from.module}' is reaching into '${to.module}' internals (its ${to.layer}). Only another feature's stores/composables/keys are a public surface. Expose what you need via ${to.module}'s store/composable, or lift the shared piece into common/.`
    case 'unknown-layer':
      return `'${from.layer}' is not a recognized SHOPin layer (${[...KNOWN_LAYERS].join(', ')}). Move this file into a known layer dir, or extend the layer model if it is a deliberate new layer — files in unknown layers are not checked.`
    default:
      return 'Resolve the layer-boundary violation.'
  }
}

/**
 * Parse inline suppression directives. Returns a map of 1-based line → Set of
 * suppressed rules ('*' = all). Supports:
 *   // layer-lint-disable-next-line [rule]   (suppresses the following line)
 *   // layer-lint-disable-line [rule]        (suppresses this line)
 */
function parseDisableDirectives(source) {
  const map = new Map()
  const lines = source.split('\n')
  lines.forEach((text, i) => {
    const m = text.match(/\/\/\s*layer-lint-disable-(next-line|line)(?:\s+(\S+))?/)
    if (!m) return
    const target = m[1] === 'next-line' ? i + 2 : i + 1 // 1-based
    if (!map.has(target)) map.set(target, new Set())
    map.get(target).add(m[2] || '*')
  })
  return map
}

const isDisabled = (directives, line, rule) => {
  const set = directives.get(line)
  return !!set && (set.has('*') || set.has(rule))
}

/**
 * Lint a single file's source. Returns { violations, sharpImports, unresolvedCalls }.
 * violations: { rule, severity, file, line, from, to, message, fix }.
 * sharpImports: unresolved `#imports` edges (one half of the v1 blind spot).
 * unresolvedCalls: bare calls with no stated origin — auto-imports (the other, larger
 * half). Never violations on their own: v1 cannot tell which layer they land in, and
 * guessing would be worse than declaring the gap.
 */
export function lintSource(file, source, config) {
  const fromLoc = classifyFile(file)
  const violations = []
  const sharpImports = []
  if (!fromLoc) return { violations, sharpImports, unresolvedCalls: [] }
  const unresolvedCalls = extractUnresolvedCalls(source).map((c) => ({ file, ...c }))

  // Resolve the importer's layer through config aliases for rule evaluation,
  // but keep fromLoc (the real dir name) for all display/output.
  const fromCanon = { ...fromLoc, layer: canonicalLayer(fromLoc.layer, config) }

  const directives = parseDisableDirectives(source)

  // Surface a file sitting in an unrecognized layer dir — its edges are not
  // checked (no allow-set), so flag it instead of silently passing.
  if (!KNOWN_LAYERS.has(fromCanon.layer)) {
    const v = {
      rule: 'unknown-layer',
      severity: effectiveSeverity('unknown-layer', 'warn', config),
      file,
      line: 1,
      from: label(fromLoc),
      to: '—',
      message: `${file} is in an unrecognized layer '${fromLoc.layer}'`,
      fix: fixFor('unknown-layer', fromLoc, fromLoc)
    }
    if (!isDisabled(directives, 1, 'unknown-layer') && !isAllowlisted(v, config)) violations.push(v)
  }

  for (const { specifier, line } of extractImports(source)) {
    const target = resolveSpecifier(specifier, file)
    if (target.kind === 'sharp-imports') {
      sharpImports.push({ file, line, specifier })
      continue
    }
    if (target.kind !== 'layer') continue

    // Evaluate with canonical layers (alias-resolved), report with real names.
    const targetCanon = { ...target, layer: canonicalLayer(target.layer, config) }
    const verdict = evaluateEdge(fromCanon, targetCanon, config ? config.sharedModules : [])
    if (!verdict) continue

    const v = {
      rule: verdict.rule,
      severity: effectiveSeverity(verdict.rule, verdict.severity, config),
      file,
      line,
      from: label(fromLoc),
      to: label(target),
      message: `${label(fromLoc)} imports ${label(target)} (${verdict.rule})`,
      fix: fixFor(verdict.rule, fromLoc, target)
    }
    if (isDisabled(directives, line, verdict.rule)) continue
    if (isAllowlisted(v, config)) continue
    violations.push(v)
  }
  return { violations, sharpImports, unresolvedCalls }
}

/**
 * Mask a source for import scanning: blank // and /* *\/ comments, and blank
 * string/template *interiors* too — EXCEPT a string in specifier position
 * (preceded at code level by `from` or `import`), whose interior is kept so the
 * real specifier survives. Newlines are preserved so line numbers stay accurate.
 *
 * This is what stops import-looking text inside an ordinary string literal
 * (`const x = "import { y } from '~/...'"`) from being scanned as a real edge,
 * while keeping the genuine `from '~/...'` / `import '~/...'` specifier strings.
 */
function maskForImportScan(src) {
  let out = ''
  let state = 'code' // code | line | block | sq | dq | tpl
  let curWord = '' // identifier being accumulated at code level
  let lastWord = '' // last completed identifier at code level
  let preserve = false // keep the current string's interior (specifier position)?
  const blank = (c) => (c === '\n' ? '\n' : c === '\t' ? '\t' : ' ')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const c2 = src[i + 1]
    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        lastWord = ''
        curWord = ''
        state = 'line'
        out += '  '
        i++
        continue
      }
      if (c === '/' && c2 === '*') {
        lastWord = ''
        curWord = ''
        state = 'block'
        out += '  '
        i++
        continue
      }
      if (c === "'" || c === '"' || c === '`') {
        if (curWord) {
          lastWord = curWord
          curWord = ''
        }
        preserve = lastWord === 'from' || lastWord === 'import'
        lastWord = ''
        state = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl'
        out += c
        continue
      }
      if (/[A-Za-z0-9_$]/.test(c)) {
        curWord += c
      } else if (curWord) {
        lastWord = curWord
        curWord = ''
      }
      out += c
      continue
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out += '\n'
        continue
      }
      out += blank(c)
      continue
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') {
        state = 'code'
        out += '  '
        i++
        continue
      }
      out += blank(c)
      continue
    }
    // string / template literal interior
    if (c === '\\') {
      out += preserve ? c + (c2 ?? '') : c2 === undefined ? ' ' : '  '
      i++
      continue
    }
    const closes =
      (state === 'sq' && c === "'") ||
      (state === 'dq' && c === '"') ||
      (state === 'tpl' && c === '`')
    if (closes) {
      out += c
      state = 'code'
      continue
    }
    out += preserve ? c : blank(c)
  }
  return out
}

/** Precompute newline offsets so a char index resolves to a 1-based line in O(log n). */
function lineResolver(src) {
  const nl = []
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') nl.push(i)
  return (idx) => {
    let lo = 0
    let hi = nl.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (nl[mid] < idx) lo = mid + 1
      else hi = mid
    }
    return lo + 1
  }
}

/**
 * Is an import's binding section type-only? True for a leading `import type`
 * (m[2] starts with `type`) or a brace-only import where every named binding is
 * an inline `type X` (and there is no default/namespace import before the brace).
 */
function isTypeOnlyBindings(middle) {
  const t = middle.trim()
  if (/^type[\s{*]/.test(t)) return true
  const braced = t.match(/^\{([\s\S]*)\}$/)
  if (!braced) return false
  const members = braced[1]
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  return members.length > 0 && members.every((s) => /^type\s/.test(s))
}

/**
 * For a .vue SFC, return source with everything outside <script> blocks blanked
 * (newlines preserved) so import line numbers still map to the .vue file.
 */
export function vueScript(source) {
  const blanked = source.replace(/[^\n]/g, ' ').split('') // keep newlines only
  for (const m of source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const inner = m[1]
    const start = m.index + m[0].indexOf('>') + 1
    for (let i = 0; i < inner.length; i++) blanked[start + i] = inner[i]
  }
  return blanked.join('')
}

/**
 * Extract runtime import/export-from specifiers with their statement-start line.
 * Drops leading `import type` / `export type` (type-only edges are out of v1
 * scope); a mixed value+inline-type import keeps its specifier. Specifiers
 * inside comments are ignored. Returns [{ specifier, line }] sorted by line.
 */
export function extractImports(source) {
  const src = maskForImportScan(source)
  const lineAt = lineResolver(src)
  const found = []

  // import/export ... from '...'  — middle may not span another import/export.
  const fromRe =
    /\b(import|export)\b((?:(?!\b(?:import|export)\b)[\s\S])*?)\bfrom\b\s*['"]([^'"]+)['"]/g
  for (const m of src.matchAll(fromRe)) {
    if (isTypeOnlyBindings(m[2])) continue // type-only edge — out of v1 scope
    found.push({ specifier: m[3], line: lineAt(m.index) })
  }

  // side-effect import '...' (no `from`)
  for (const m of src.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) {
    found.push({ specifier: m[1], line: lineAt(m.index) })
  }

  return found.sort((a, b) => a.line - b.line || a.specifier.localeCompare(b.specifier))
}

/** Control-flow and operator keywords that are followed by `(` but are not calls. */
const CALL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'instanceof', 'function',
  'await', 'new', 'delete', 'void', 'do', 'else', 'case', 'in', 'of', 'yield', 'throw',
  'super', 'this', 'import', 'export', 'as', 'from', 'satisfies', 'keyof', 'infer',
  'async', 'try', 'finally', 'with', 'let', 'const', 'var', 'get', 'set', 'default',
  'type', 'interface', 'enum', 'namespace', 'declare', 'abstract', 'implements', 'extends',
  'public', 'private', 'protected', 'readonly', 'override', 'is', 'asserts'
])

/**
 * Called identifiers that resolve to a runtime global rather than a project module:
 * JS/DOM builtins plus the surface Nuxt, Vue, i18n, Apollo and Vitest inject. A call
 * that is NOT in here, NOT imported, and NOT declared in-file is unresolved — in a
 * Nuxt app that almost always means an auto-import, which v1 cannot follow to a layer.
 */
const RUNTIME_GLOBALS = new Set([
  // JS / DOM
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Date', 'Math',
  'JSON', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Proxy', 'Reflect', 'RegExp',
  'Error', 'TypeError', 'RangeError', 'URL', 'URLSearchParams', 'Intl', 'AbortController',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'structuredClone', 'queueMicrotask', 'fetch', 'atob', 'btoa',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'IntersectionObserver',
  'ResizeObserver', 'MutationObserver', 'CustomEvent', 'Event', 'FormData', 'Blob', 'File',
  'FileReader', 'Image', 'Headers', 'require', 'process', 'console', 'globalThis', 'window',
  'document', 'navigator', 'constructor',
  // Vue
  'ref', 'shallowRef', 'computed', 'reactive', 'readonly', 'shallowReactive', 'toRef',
  'toRefs', 'toValue', 'unref', 'isRef', 'watch', 'watchEffect', 'watchPostEffect',
  'nextTick', 'provide', 'inject', 'defineProps', 'defineEmits', 'defineExpose',
  'defineModel', 'defineOptions', 'defineSlots', 'defineComponent', 'defineAsyncComponent',
  'withDefaults', 'onMounted', 'onUnmounted', 'onBeforeMount', 'onBeforeUnmount',
  'onUpdated', 'onBeforeUpdate', 'onActivated', 'onDeactivated', 'onErrorCaptured',
  'onServerPrefetch', 'onScopeDispose', 'effectScope', 'getCurrentInstance', 'h', 'markRaw',
  'resolveComponent', 'resolveDirective', 'useSlots', 'useAttrs', 'useTemplateRef', 'useId',
  'onBeforeRouteLeave', 'onBeforeRouteUpdate',
  // Nuxt
  'useNuxtApp', 'useRuntimeConfig', 'useState', 'useAsyncData', 'useLazyAsyncData',
  'useFetch', 'useLazyFetch', 'useRoute', 'useRouter', 'useCookie', 'useHead', 'useSeoMeta',
  'useRequestEvent', 'useRequestHeaders', 'useRequestURL', 'useError', 'useAppConfig',
  'useNuxtData', 'navigateTo', 'abortNavigation', 'createError', 'showError', 'clearError',
  'refreshNuxtData', 'defineNuxtPlugin', 'defineNuxtRouteMiddleware', 'definePageMeta',
  'defineNuxtComponent', 'callOnce', 'preloadComponents', 'prerenderRoutes', 'setPageLayout',
  // i18n / Apollo / Pinia
  'useI18n', 'useLocalePath', 'useLocaleHead', 'useSwitchLocalePath', 'useRouteBaseName',
  'defineI18nRoute', 'useQuery', 'useLazyQuery', 'useMutation', 'useSubscription',
  'useApollo', 'useApolloClient', 'defineStore', 'storeToRefs', 'acceptHMRUpdate', '$fetch',
  // Vitest
  'describe', 'it', 'test', 'expect', 'vi', 'beforeEach', 'afterEach', 'beforeAll', 'afterAll'
])

/**
 * Names bound in this file: import bindings, declarations, destructuring targets and
 * arrow/function parameters. Deliberately over-collects — a name wrongly treated as
 * bound is a silent undercount, whereas a wrongly "unresolved" name is a false alarm
 * in a report whose whole job is to be trustworthy.
 */
function boundNames(src) {
  const bound = new Set()
  const add = (text) => {
    for (const n of text.matchAll(/[A-Za-z_$][\w$]*/g)) bound.add(n[0])
  }
  const fromRe =
    /\b(?:import|export)\b((?:(?!\b(?:import|export)\b)[\s\S])*?)\bfrom\b\s*['"][^'"]+['"]/g
  for (const m of src.matchAll(fromRe)) add(m[1])
  for (const m of src.matchAll(/\b(?:function|class)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1])
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) bound.add(m[1])
  for (const m of src.matchAll(/\b(?:const|let|var)\s*[{[]([^}\]]*)[}\]]/g)) add(m[1])
  for (const m of src.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) add(m[1])
  // Method definitions — class methods and object-literal shorthand (`pause() {`,
  // `addToCart(state) {`). These look exactly like calls to a name-plus-paren scan.
  const methodRe =
    /(?:^|[\n{,;])\s*(?:async\s+|static\s+|get\s+|set\s+|\*\s*)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*[:{]/g
  for (const m of src.matchAll(methodRe)) bound.add(m[1])
  return bound
}

/**
 * Calls whose origin this file does not state: not imported, not declared here, not a
 * runtime global. Returns [{ name, line }], one entry per distinct name, sorted by first
 * use. These are the edges v1 cannot resolve to a layer — reporting the count is what
 * keeps a clean-looking run from being read as a clean architecture.
 */
export function extractUnresolvedCalls(source) {
  const src = maskForImportScan(source)
  const lineAt = lineResolver(src)
  const bound = boundNames(src)
  const found = new Map()
  for (const m of src.matchAll(/(^|[^.\w$?])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[2]
    if (found.has(name) || bound.has(name)) continue
    if (CALL_KEYWORDS.has(name) || RUNTIME_GLOBALS.has(name)) continue
    found.set(name, lineAt(m.index + m[1].length))
  }
  return [...found]
    .map(([name, line]) => ({ name, line }))
    .sort((a, b) => a.line - b.line || a.name.localeCompare(b.name))
}
