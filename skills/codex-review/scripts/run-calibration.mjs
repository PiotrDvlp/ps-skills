#!/usr/bin/env node
// run-calibration.mjs — measure the Codex reviewer against known-verdict diffs.
//
// The one gap the harness cannot close on its own: nothing proves the reviewer would
// CATCH a real defect or HOLD a clean diff. The harness validates the review's FORM
// (schema, verdict/severity consistency, citations against the patch, PASS cap over
// unreviewable paths) — it cannot judge the review's CONTENT. Calibration is the
// "feed the evaluator known-good and known-bad cases" step from the loop-engineering
// literature: a small corpus of diffs with KNOWN verdicts, reviewed on demand, scored
// for recall (does it flag what should be flagged?) and precision (does it flag what
// should not be?).
//
// Each fixture in references/calibration/<id>/ is materialized into a throwaway git
// repo (base/ committed, change/ overlaid as the working-tree diff) and reviewed
// through the SAME two-phase runner as a real review (prepare → run), so every
// validation that applies in production applies here. No fake codex, no shortcuts.
//
// Commands:
//   run        materialize + review every fixture with the real Codex CLI, score it
//   dry-run    materialize + prepare only — spawns NO Codex; for tests and preview
//
// Flags: --filter <id>  only one fixture | --model <m> (default gpt-5.6-terra)
//        --deep  xhigh effort | --threshold <recall>  exit 1 if recall < threshold
//        --keep-artifacts  keep tmp fixture repos and bundles
//
// Exit codes: 0 = run completed (calibration is measurement; the report is the output)
//             1 = recall below --threshold (when given), or a fixture failed to review
//             2 = usage / internal error
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, readFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { argv as procArgv } from 'node:process';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNNER = join(HERE, 'run-code-review.mjs');
const CALIB_DIR = join(HERE, '..', 'references', 'calibration');
const MANIFEST = join(CALIB_DIR, 'manifest.json');

// ---------------------------------------------------------------------------
// Corpus loading and materialization.
// ---------------------------------------------------------------------------

export function loadManifest(manifestPath = MANIFEST) {
  return JSON.parse(readFileSync(manifestPath, 'utf8'));
}

/** Turn one fixture's base/ + change/ into a throwaway repo with an uncommitted diff. */
export function materializeFixture(fixtureDir) {
  const dir = mkdtempSync(join(tmpdir(), 'cxr-cal-'));
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  cpSync(join(fixtureDir, 'base'), dir, { recursive: true });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'cal@cal');
  g('config', 'user.name', 'cal');
  g('config', 'commit.gpgsign', 'false');
  g('add', '-A');
  g('commit', '-qm', 'baseline');
  // Overlay the change: edits overwrite, new files appear as untracked. NOT committed.
  cpSync(join(fixtureDir, 'change'), dir, { recursive: true });
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function spawnRunner(args) {
  const r = spawnSync('node', [RUNNER, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** prepare + run one fixture through the real two-phase runner. Returns a score entry. */
export function reviewFixture(fixture, { model = 'gpt-5.6-terra', deep = false, keep = false }) {
  const materialized = materializeFixture(join(CALIB_DIR, fixture.id));
  try {
    const prep = spawnRunner(['prepare', '--uncommitted', '--repo', materialized.dir]);
    if (prep.status !== 0) {
      return { id: fixture.id, expected_verdict: fixture.expected_verdict, error: prep.stderr.trim() || 'prepare failed' };
    }
    const prepJson = JSON.parse(prep.stdout);
    const runArgs = ['run', '--bundle', prepJson.bundle, '--model', model];
    if (deep) runArgs.push('--deep');
    if (keep) runArgs.push('--keep-artifacts');
    const run = spawnRunner(runArgs);
    if (run.status !== 0) {
      return { id: fixture.id, expected_verdict: fixture.expected_verdict, error: run.stderr.trim() || 'run failed' };
    }
    const out = JSON.parse(run.stdout);
    return {
      id: fixture.id,
      expected_verdict: fixture.expected_verdict,
      final_verdict: out.final_verdict,
      reviewer_verdict: out.reviewer_verdict,
      issue_count: out.issue_count,
      issues: parseIssues(out.body),
      body: out.body,
    };
  } finally {
    if (!keep) materialized.cleanup();
  }
}

/** Extract structured issues from the rendered body — `1. [WARNING] title — path:line`. Best-effort. */
function parseIssues(body) {
  const issues = [];
  let current = null;
  for (const line of (body || '').split('\n')) {
    const m = line.match(/^\d+\. \[([A-Z]+)\]\s*(.*)$/);
    if (m && ['BLOCKER', 'WARNING', 'SUGGESTION'].includes(m[1])) {
      if (current) issues.push(current);
      current = { severity: m[1], text: `${m[1]}: ${m[2]}` };
    } else if (current && line.trim()) {
      current.text += ' ' + line.trim();
    }
  }
  if (current) issues.push(current);
  return issues;
}

// ---------------------------------------------------------------------------
// Scoring — pure, exported for tests.
// ---------------------------------------------------------------------------

/**
 * Confusion-matrix scoring over review outcomes.
 * entries: [{ id, expected_verdict, final_verdict?, error? }]
 * flagged = final_verdict !== 'PASS'; should = expected_verdict !== 'PASS'.
 */
export function scoreCalibration(entries) {
  const byId = {};
  const matrix = { tp: 0, fn: 0, fp: 0, tn: 0 };
  const errors = [];
  for (const e of entries) {
    if (e.error) {
      errors.push(e);
      byId[e.id] = { error: e.error };
      continue;
    }
    const flagged = e.final_verdict !== 'PASS';
    const should = e.expected_verdict !== 'PASS';
    const cell = should ? (flagged ? 'tp' : 'fn') : (flagged ? 'fp' : 'tn');
    matrix[cell]++;
    byId[e.id] = { final_verdict: e.final_verdict, expected_verdict: e.expected_verdict, cell };
  }
  const { tp, fn, fp, tn } = matrix;
  return {
    byId,
    matrix,
    recall: tp + fn > 0 ? tp / (tp + fn) : null,
    precision: tp + fp > 0 ? tp / (tp + fp) : null,
    cleanPassRate: tn + fp > 0 ? tn / (tn + fp) : null,
    flaggedCount: tp + fp,
    shouldFlagCount: tp + fn,
    errors,
  };
}

/**
 * Defect-level attribution: for each fixture, which planted defects did the findings
 * mention? Keyword match on issue text (case-insensitive) — a heuristic, not proof:
 * a finding that names the exact boundary value or the throwing call is credited.
 */
export function defectFindings(entries, fixtures) {
  const out = {};
  for (const fixture of fixtures) {
    const entry = entries.find((e) => e.id === fixture.id);
    if (!entry || entry.error || !entry.issues) {
      out[fixture.id] = { found: [], missing: fixture.defects.map((d) => d.keyword), total: fixture.defects.length };
      continue;
    }
    const hay = entry.issues.map((i) => `${i.severity}: ${i.text}`).join('\n').toLowerCase();
    const found = [];
    const missing = [];
    for (const d of fixture.defects) {
      if (hay.includes(d.keyword.toLowerCase())) found.push(d.keyword);
      else missing.push(d.keyword);
    }
    out[fixture.id] = { found, missing, total: fixture.defects.length };
  }
  return out;
}

export function exitCodeFor(score, threshold) {
  if (threshold !== null && score.recall !== null && score.recall < threshold) return 1;
  if (score.errors.length > 0) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Report + CLI.
// ---------------------------------------------------------------------------

function renderReport(score, defects) {
  const pct = (v) => (v === null ? 'n/a' : `${(v * 100).toFixed(0)}%`);
  const lines = [];
  for (const [id, cell] of Object.entries(score.byId)) {
    if (cell.error) { lines.push(`  ${id}: ERROR — ${cell.error}`); continue; }
    const mark = cell.cell === 'tp' ? 'TP' : cell.cell === 'fn' ? 'FN' : cell.cell === 'fp' ? 'FP' : 'TN';
    const d = defects[id];
    const defectNote = d && d.total > 0
      ? ` | defects ${d.found.length}/${d.total} found${d.missing.length ? ` (missing: ${d.missing.join(', ')})` : ''}`
      : '';
    lines.push(`  ${id}: expected ${cell.expected_verdict}, got ${cell.final_verdict} [${mark}]${defectNote}`);
  }
  const { tp, fn, fp, tn } = score.matrix;
  return [
    'CALIBRATION REPORT',
    '',
    ...lines,
    '',
    `  matrix: TP=${tp} FN=${fn} FP=${fp} TN=${tn}`,
    `  recall (flagged what should be flagged):   ${pct(score.recall)}`,
    `  precision (flagged what should not be):    ${pct(score.precision)}`,
    `  clean pass rate:                           ${pct(score.cleanPassRate)}`,
    score.errors.length ? `  errors: ${score.errors.length} fixture(s) failed to review` : '',
  ].filter((l) => l !== '').join('\n');
}

function usage() {
  process.stderr.write(`run-calibration.mjs — measure the Codex reviewer against known-verdict diffs

Usage:
  node scripts/run-calibration.mjs run [--filter <id>] [--model <m>] [--deep] [--threshold <recall>] [--keep-artifacts]
  node scripts/run-calibration.mjs dry-run [--filter <id>] [--keep-artifacts]

  run       materialize each fixture, review it with the real Codex CLI (two-phase
            runner, same validations as production), score recall/precision.
  dry-run   materialize + prepare only — spawns NO Codex; verifies the corpus builds.

  --filter <id>       review one fixture only
  --model <m>         default gpt-5.6-terra
  --deep              xhigh reasoning effort
  --threshold <r>     exit 1 when recall < r (e.g. 0.75)
  --keep-artifacts    keep throwaway fixture repos and bundles

Exit codes: 0 = completed; 1 = recall below threshold or a fixture errored; 2 = usage.
`);
}

function isMain() {
  try {
    return procArgv[1] && realpathSync(procArgv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isMain()) {
  try {
    const [cmd, ...rest] = procArgv.slice(2);
    if (!['run', 'dry-run'].includes(cmd)) { usage(); process.exit(2); }
    const value = (name) => {
      const i = rest.indexOf(`--${name}`);
      if (i < 0) return undefined;
      const v = rest[i + 1];
      if (v === undefined || String(v).startsWith('--')) throw new Error(`--${name} needs a value`);
      return v;
    };
    const filter = value('filter');
    const model = value('model') ?? 'gpt-5.6-terra';
    const deep = rest.includes('--deep');
    const keep = rest.includes('--keep-artifacts');
    const rawThreshold = value('threshold');
    const threshold = rawThreshold === undefined ? null : Number(rawThreshold);
    if (threshold !== null && (Number.isNaN(threshold) || threshold < 0 || threshold > 1)) {
      throw new Error(`--threshold must be a fraction in [0,1] (got ${rawThreshold})`);
    }

    const manifest = loadManifest();
    const fixtures = manifest.fixtures.filter((f) => !filter || f.id === filter);
    if (fixtures.length === 0) throw new Error(`no fixtures match --filter ${filter}`);

    if (cmd === 'dry-run') {
      for (const fixture of fixtures) {
        const m = materializeFixture(join(CALIB_DIR, fixture.id));
        try {
          const prep = spawnRunner(['prepare', '--uncommitted', '--repo', m.dir]);
          if (prep.status !== 0) throw new Error(`${fixture.id}: ${prep.stderr.trim()}`);
          const json = JSON.parse(prep.stdout);
          process.stdout.write(`${fixture.id}: bundle ${json.bundle.split('/').pop()} (${json.bytes} bytes, ${json.unreviewable_paths.length} unreviewable)\n`);
        } finally {
          if (!keep) m.cleanup();
        }
      }
      process.exit(0);
    }

    const entries = fixtures.map((f) => reviewFixture(f, { model, deep, keep }));
    const score = scoreCalibration(entries);
    const defects = defectFindings(entries, fixtures);
    process.stdout.write(renderReport(score, defects) + '\n');
    if (threshold !== null) {
      process.stdout.write(`threshold: recall >= ${threshold} — ${score.recall !== null && score.recall >= threshold ? 'MET' : 'NOT MET'}\n`);
    }
    process.exit(exitCodeFor(score, threshold));
  } catch (e) {
    process.stderr.write(String(e?.message ?? e) + '\n');
    process.exit(2);
  }
}
