#!/usr/bin/env node
// SHOPin pageModules layer-dependency linter (v1, explicit imports only).
// Zero runtime deps. User-global skill — see SKILL.md / README.md and the vault
// design doc: outputs/futterhaus/plans/2026-06-01-shopin-layer-linter-design.md
//
// Usage (cd into the target repo first):
//   node <skill-dir>/lint-layers.mjs [--format=human|agent|json]
//        [--report-only] [--report-dependencies]
//        [--root=src] [--config=<skill-dir>/layer-lint.config.json]
//
// Exit codes: gating mode → 1 when any unallowlisted error-severity violation
// exists, else 0. --report-only always exits 0 (passes flag still reflects it).

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve, relative, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { lintSource, vueScript, validateConfig, classifyFile } from './core.mjs'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SCAN_EXT = new Set(['.ts', '.mts', '.js', '.mjs', '.vue'])
const SKIP_DIR = new Set(['node_modules', '.nuxt', '.output', 'dist', '.git'])
const SKIP_FILE = /\.(test|spec|stories)\.[a-z]+$|\.d\.ts$/i

function parseArgs(argv) {
  const opts = {
    format: 'human',
    reportOnly: false,
    reportDependencies: false,
    root: 'src',
    config: null
  }
  const VALUE_FLAGS = ['--format', '--root', '--config']
  for (const a of argv) {
    if (a.startsWith('--format=')) opts.format = a.slice('--format='.length)
    else if (a === '--report-only') opts.reportOnly = true
    else if (a === '--report-dependencies') opts.reportDependencies = true
    else if (a.startsWith('--root=')) opts.root = a.slice('--root='.length)
    else if (a.startsWith('--config=')) opts.config = a.slice('--config='.length)
    else {
      // Bulletproofing: reject anything unrecognized instead of ignoring it. The
      // classic trap is `--config <path>` (space form): the old parser dropped
      // both tokens and ran with NO config — no allowlist, no severity overrides
      // — while still looking green. A value flag missing its `=` gets a targeted
      // hint; everything else is a plain unknown-argument error. Exit 2 (usage).
      const bare = VALUE_FLAGS.find((f) => a === f)
      if (bare) {
        process.stderr.write(
          `layer-lint: '${bare}' needs an '=' — write ${bare}=<value>, not '${bare} <value>' ` +
            `(the space form is silently ignored).\n`
        )
      } else {
        process.stderr.write(`layer-lint: unknown argument '${a}'.\n`)
      }
      process.exit(2)
    }
  }
  return opts
}

function* walk(dir) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue
    const abs = join(dir, name)
    let st
    try {
      st = statSync(abs)
    } catch {
      continue
    }
    if (st.isDirectory()) yield* walk(abs)
    else if (SCAN_EXT.has(extname(name)) && !SKIP_FILE.test(name)) yield abs
  }
}

function loadConfig(opts, cwd) {
  const path = opts.config || join(cwd, 'layer-lint.config.json')
  if (!existsSync(path)) return validateConfig()
  try {
    return validateConfig(JSON.parse(readFileSync(path, 'utf8')))
  } catch (e) {
    process.stderr.write(`layer-lint: failed to load config ${path}: ${e.message}\n`)
    process.exit(2)
  }
}

const COLOR = process.stdout.isTTY
const red = (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s)
const yellow = (s) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s)
const dim = (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s)
const sev = (s) => (s === 'error' ? red('✗') : yellow('⚠'))

/** Group unresolved auto-import calls by file for per-finding annotation. */
function byFile(unresolved) {
  const map = new Map()
  for (const u of unresolved) {
    if (!map.has(u.file)) map.set(u.file, [])
    map.get(u.file).push(u.name)
  }
  return map
}

/**
 * The caveat that belongs next to a finding. A violation on an explicit import says
 * nothing about the same file's auto-imported edges, and a reader who does not see
 * that will treat one flagged line as the file's whole dependency story.
 */
function unresolvedNote(names) {
  if (!names || !names.length) return null
  const shown = names.slice(0, 6).join(', ')
  const rest = names.length > 6 ? `, +${names.length - 6} more` : ''
  return `${names.length} further call(s) in this file are auto-imports and were NOT analyzed: ${shown}${rest}`
}

/** Totals line: never let a run imply the unanalyzed set is just `#imports`. */
function blindSpotSummary(sharp, unresolved) {
  if (!sharp.length && !unresolved.length) return null
  const parts = []
  if (sharp.length) parts.push(`${sharp.length} #imports edge(s)`)
  if (unresolved.length)
    parts.push(`${unresolved.length} auto-import call(s) in ${byFile(unresolved).size} file(s)`)
  return `not analyzed (v1 blind spot — see design §Future work): ${parts.join(', ')}.`
}

function reportHuman(violations, sharp, unresolved, passes) {
  const lines = []
  const perFile = byFile(unresolved)
  for (const v of violations) {
    lines.push(`${sev(v.severity)} ${v.rule}  ${v.file}:${v.line}`)
    lines.push(`    ${v.from} → ${v.to}`)
    const note = unresolvedNote(perFile.get(v.file))
    if (note) lines.push(yellow(`    ! ${note}`))
  }
  const summary = blindSpotSummary(sharp, unresolved)
  if (summary) lines.push(dim(`\n${summary}`))
  const errs = violations.filter((v) => v.severity === 'error').length
  const warns = violations.length - errs
  lines.push(`\n${errs} error, ${warns} warning${passes ? '' : red('  → FAIL')}`)
  return lines.join('\n')
}

function reportAgent(violations, sharp, unresolved) {
  const lines = []
  const perFile = byFile(unresolved)
  for (const v of violations) {
    lines.push(`${sev(v.severity)} ${v.rule}  ${v.file}:${v.line}`)
    lines.push(`  ${v.message}`)
    lines.push(`  fix: ${v.fix}`)
    const note = unresolvedNote(perFile.get(v.file))
    if (note) lines.push(`  caveat: ${note} Confirm this edge is not one of many before acting.`)
    lines.push('')
  }
  const summary = blindSpotSummary(sharp, unresolved)
  if (summary) lines.push(`note: ${summary}`)
  return lines.join('\n')
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const cwd = process.cwd()
  const rootAbs = resolve(cwd, opts.root)
  const config = loadConfig(opts, cwd)

  const allViolations = []
  const allSharp = []
  const allUnresolved = []
  let filesScanned = 0
  let filesClassified = 0
  for (const abs of walk(rootAbs)) {
    const rel = relative(cwd, abs).replace(/\\/g, '/')
    let source
    try {
      source = readFileSync(abs, 'utf8')
    } catch {
      continue
    }
    filesScanned++
    if (classifyFile(rel)) filesClassified++
    const scanned = extname(abs) === '.vue' ? vueScript(source) : source
    const { violations, sharpImports, unresolvedCalls } = lintSource(rel, scanned, config)
    allViolations.push(...violations)
    allSharp.push(...sharpImports)
    allUnresolved.push(...unresolvedCalls)
  }

  // Bulletproofing: a run that scanned files but classified none into any layer
  // is almost always a misconfiguration (wrong --root, or a repo layout the tool
  // doesn't understand) — NOT a clean architecture. Reporting green here is the
  // exact false-negative this guard exists to prevent, so fail loudly (exit 2)
  // regardless of --report-only, which only governs violation gating.
  // A root that matched nothing at all (typo, wrong cwd, deleted dir) previously
  // sailed through as `0 error` + exit 0 — the guard below only caught scanned>0.
  // Zero files inspected is never a clean architecture.
  if (filesScanned === 0) {
    process.stderr.write(
      `layer-lint: found no files under '${opts.root}' (resolved to ${rootAbs}).\n` +
        `  Nothing was checked — this is a broken run, not a clean pass. Check --root and cwd.\n`
    )
    process.exit(2)
  }
  if (filesScanned > 0 && filesClassified === 0) {
    process.stderr.write(
      `layer-lint: scanned ${filesScanned} file(s) under '${opts.root}' but classified 0 into any ` +
        `layer.\n  Nothing was checked — this is a broken run, not a clean pass. Point --root at ` +
        `the srcDir that contains pageModules/ and common/ (betzold: --root=.; futterhaus: --root=src).\n`
    )
    process.exit(2)
  }
  // Always surface coverage on stderr so a green run is never ambiguous about
  // whether it actually inspected the layer graph.
  process.stderr.write(
    `layer-lint: scanned ${filesScanned} file(s), ${filesClassified} in layers.\n`
  )

  allViolations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
  const hasBlockingError = allViolations.some((v) => v.severity === 'error')
  const passes = !hasBlockingError

  if (opts.format === 'json') {
    // Always present, even without --report-dependencies: a consumer that reads
    // `violations` alone must still be able to see how much went unanalyzed.
    const payload = {
      passes,
      violations: allViolations,
      blindSpots: { sharpImports: allSharp.length, unresolvedCalls: allUnresolved.length }
    }
    if (opts.reportDependencies) {
      payload.sharpImports = allSharp
      payload.unresolvedCalls = allUnresolved
    }
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  } else if (opts.format === 'agent') {
    process.stdout.write(reportAgent(allViolations, allSharp, allUnresolved) + '\n')
  } else {
    process.stdout.write(reportHuman(allViolations, allSharp, allUnresolved, passes) + '\n')
  }

  // Set exitCode rather than process.exit(): on a pipe, stdout writes are async and
  // process.exit() drops whatever has not flushed — which silently truncated
  // --format=json --report-dependencies at 64KB. A truncated report is worse than a
  // small one, so let the process end on its own once stdout drains.
  process.exitCode = opts.reportOnly ? 0 : passes ? 0 : 1
}

main()
