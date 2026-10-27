#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const PACKET_SECTIONS = ['## Data Sources', '## Scope Decision', '## Codebase Evidence', '## Gaps']

export function mismatches(results, expected) {
  return Object.entries(expected).flatMap(([key, e]) => {
    const r = results[key]
    if (!r) return [`${key}: missing from results`]
    if (r.verdict !== e.verdict) return [`${key}: expected verdict ${e.verdict}, got ${r.verdict}`]
    if (e.minHandoffs && !(r.handoffs >= e.minHandoffs)) {
      return [`${key}: expected handoffs >= ${e.minHandoffs}, got ${r.handoffs}`]
    }
    return []
  })
}

function sections(markdown) {
  const out = {}
  for (const part of markdown.split(/^(?=## )/m)) {
    const title = part.split('\n', 1)[0].trim()
    if (PACKET_SECTIONS.includes(title)) out[title] = part.trimEnd()
  }
  return out
}

export function packet(key, audits) {
  const slug = key.toLowerCase()
  const file = readdirSync(audits)
    .filter((f) => f.includes(`-${slug}-`))
    .sort()
    .at(-1)
  if (!file) throw new Error(`${key}: no audit note under ${audits}`)
  const found = sections(readFileSync(join(audits, file), 'utf8'))
  for (const s of PACKET_SECTIONS) if (!found[s]) console.error(`${key}: section ${s} absent in ${file}`)
  const body = PACKET_SECTIONS.map((s) => found[s] ?? `${s}\n\n_absent in note_`).join('\n\n')
  return `=== ${key} (${file})\n\n${body}\n`
}

function flag(name) {
  const i = process.argv.indexOf(name)
  return i === -1 ? undefined : process.argv[i + 1]
}

const usage = 'usage: retro-verdict.mjs --expected <expected.json> (--packets --audits <dir> | --check <results.json>)'
const mode = ['--packets', '--check'].find((m) => process.argv.includes(m))
if (mode) {
  const expectedPath = flag('--expected')
  if (!expectedPath) {
    console.error(usage)
    process.exit(2)
  }
  const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))
  if (mode === '--packets') {
    const audits = flag('--audits') ?? process.env.RETRO_AUDITS
    if (!audits) {
      console.error(usage)
      process.exit(2)
    }
    for (const key of Object.keys(expected)) process.stdout.write(packet(key, audits) + '\n')
  } else {
    const lines = mismatches(JSON.parse(readFileSync(flag('--check'), 'utf8')), expected)
    for (const line of lines) console.log(line)
    process.exit(lines.length ? 1 : 0)
  }
} else if (process.argv.length > 2) {
  console.error(usage)
  process.exit(2)
}
