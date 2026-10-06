#!/usr/bin/env node
// Two-phase, non-interactive adapter for codex-review code mode.
//
//   prepare  build the patch + bundle, print sizing JSON, spawn NO Codex
//   run      consume a bundle, spawn Codex exactly once, validate, print result
//   discard  remove a bundle the caller decided not to use
//
// Two phases exist because the soft-size guardrail needs a human decision
// BETWEEN measuring the patch and spending a Codex call, and this script cannot
// prompt. The skill decides in between and calls `run` with the same bundle, so
// the reviewed patch is provably the measured one.

import { spawn } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync,
  readdirSync, lstatSync, openSync, closeSync, chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveTarget, buildPatch, countUntracked, stateDigest, parsePatch,
  validateAgainstSchema, validateSemantics, validateCitations, deriveFinalVerdict,
  assemblePrompt, renderBody, validateModel, resolveModelFromOutput,
  sha256, git, ReviewError, PROTOCOL_VERSION, SOFT_WARN_BYTES, HARD_REFUSE_BYTES,
} from './code-review-core.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(HERE, '..', 'references', 'code-review-output.schema.json');
const RUBRIC_PATH = join(HERE, '..', 'references', 'rubric-code.md');
const BUNDLE_PREFIX = 'cxr-bundle-';
const BUNDLE_TTL_MS = 24 * 60 * 60 * 1000;

const die = (code, msg) => { console.error(`[${code}] ${msg}`); process.exit(1); };

function parseArgs(argv) {
  const out = { paths: [], excludes: [] };
  const setSelector = (sel) => {
    if (out.selector) die('usage', 'pass exactly one of --uncommitted, --base, --commit');
    out.selector = sel;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) die('usage', `${a} needs a value`);
      return v;
    };
    switch (a) {
      case '--uncommitted': setSelector({ kind: 'uncommitted' }); break;
      case '--base': setSelector({ kind: 'base', base: next() }); break;
      case '--commit': setSelector({ kind: 'commit', commit: next() }); break;
      case '--path': out.paths.push(next()); break;
      case '--exclude': out.excludes.push(next()); break;
      case '--tracked-only': out.trackedOnly = true; break;
      case '--repo': out.repo = next(); break;
      case '--model': out.model = next(); break;
      case '--deep': out.deep = true; break;
      case '--bundle': out.bundle = next(); break;
      case '--keep-artifacts': out.keep = true; break;
      case '--context': out.context = next(); break;
      default: die('usage', `unknown argument ${a}`);
    }
  }
  return out;
}

/** Only a directory `prepare` made may be deleted: our prefix, a real directory, a manifest. */
function isBundle(dir) {
  try {
    return basename(dir).startsWith(BUNDLE_PREFIX)
      && lstatSync(dir).isDirectory()
      && existsSync(join(dir, 'manifest.json'));
  } catch { return false; }
}

/** Remove abandoned bundles older than the TTL. Best-effort, never fatal. */
function sweepBundles() {
  const root = tmpdir();
  let entries = [];
  try { entries = readdirSync(root); } catch { return; }
  for (const name of entries) {
    const dir = join(root, name);
    if (!isBundle(dir)) continue;
    try {
      const createdAt = new Date(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')).created_at).getTime();
      if (Date.now() - createdAt > BUNDLE_TTL_MS) rmSync(dir, { recursive: true, force: true });
    } catch { /* a bundle we cannot read is not ours to reason about */ }
  }
}

// ---------------------------------------------------------------- prepare

function cmdPrepare(args) {
  sweepBundles();
  const repoRoot = git(args.repo ?? process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  const selector = args.selector ?? { kind: 'uncommitted' };
  const scope = { paths: args.paths, excludes: args.excludes, trackedOnly: !!args.trackedOnly };

  const bundle = mkdtempSync(join(tmpdir(), BUNDLE_PREFIX));
  chmodSync(bundle, 0o700);

  try {
    const target = resolveTarget(repoRoot, selector);
    const patch = buildPatch(repoRoot, target, scope, { tmpDir: bundle });
    if (!patch.trim()) throw new ReviewError('empty_patch', 'the selected diff is empty; nothing to review');

    const bytes = Buffer.byteLength(patch);
    if (bytes >= HARD_REFUSE_BYTES) {
      throw new ReviewError('too_large',
        `patch is ${bytes} bytes (>= ${HARD_REFUSE_BYTES}); decompose the change`);
    }

    const { unreviewable } = parsePatch(patch);
    const untrackedIncluded = selector.kind === 'uncommitted' ? countUntracked(repoRoot, scope) : 0;
    const diffSha = sha256(patch);

    writeFileSync(join(bundle, 'patch.diff'), patch);
    const manifest = {
      protocol_version: PROTOCOL_VERSION,
      created_at: new Date().toISOString(),
      repo_root: repoRoot,
      target_kind: target.kind,
      target_requested: target.requested,
      target_resolved: target.resolved,
      scope: { paths: scope.paths, excludes: scope.excludes, tracked_only: scope.trackedOnly },
      diff_sha256: diffSha,
      diff_bytes: bytes,
      unreviewable_paths: unreviewable,
      untracked_included: untrackedIncluded,
      // Captured HERE, not just in `run`: the patch is built now, possibly
      // before a human answers the size prompt. Without this capture a change
      // during that window would leave both run-side digests agreeing on the
      // new state while Codex reviewed a patch describing the old one.
      state_digest_prepare: stateDigest(repoRoot),
      rubric_sha256: sha256(readFileSync(RUBRIC_PATH)),
    };
    writeFileSync(join(bundle, 'manifest.json'), JSON.stringify(manifest, null, 2));

    console.log(JSON.stringify({
      bundle,
      bytes,
      soft_warn: bytes >= SOFT_WARN_BYTES,
      soft_warn_threshold: SOFT_WARN_BYTES,
      diff_sha256: diffSha,
      unreviewable_paths: unreviewable,
      untracked_included: untrackedIncluded,
      target_resolved: target.resolved,
    }, null, 2));
  } catch (err) {
    rmSync(bundle, { recursive: true, force: true });   // prepare owns cleanup on failure
    die(err.code ?? 'prepare_failed', err.message);
  }
}

// ---------------------------------------------------------------- run

function buildCodexArgv({ model, deep, repoRoot, schemaPath, outFile }) {
  const argv = ['exec', '-m', model];
  argv.push('-c', `model_reasoning_effort="${deep ? 'xhigh' : 'high'}"`);
  argv.push('-s', 'read-only');            // hardcoded; there is no parameter to change it
  argv.push('--skip-git-repo-check');
  // NO --json. Verified live on codex-cli 0.144.5: the JSONL stream carries only
  // thread.started / turn.started / item.completed / turn.completed and contains
  // no model field anywhere, AND passing --json suppresses the plain-text
  // `model: <slug>` session header. So --json actively destroys the only
  // provenance channel that exists while adding nothing — the final message
  // already arrives via -o, not via the event stream.
  argv.push('-C', repoRoot);
  argv.push('--output-schema', schemaPath);
  argv.push('-o', outFile);
  argv.push('-');
  return argv;
}

async function cmdRun(args) {
  const bundle = args.bundle;
  if (!bundle || !existsSync(bundle)) die('no_bundle', `--bundle <dir> is required and must exist (got ${bundle})`);
  if (!isBundle(bundle)) die('not_a_bundle', `${bundle} was not made by prepare; refusing to use or delete it`);

  const cleanup = () => { if (!args.keep) rmSync(bundle, { recursive: true, force: true }); };
  const onSignal = () => { cleanup(); process.exit(130); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
    const patch = readFileSync(join(bundle, 'patch.diff'), 'utf8');
    const repoRoot = manifest.repo_root;

    // Re-hash: matching the stored value only proves the manifest is internally
    // consistent, not that the artifact on disk is the one that was measured.
    const actual = sha256(patch);
    if (actual !== manifest.diff_sha256) {
      throw new ReviewError('bundle_tampered',
        `patch.diff hash ${actual} != manifest ${manifest.diff_sha256}; the bundle changed between phases`);
    }

    const model = validateModel(args.model ?? 'gpt-5.6-terra');

    const digestBefore = stateDigest(repoRoot);
    if (digestBefore !== manifest.state_digest_prepare) {
      throw new ReviewError('drift_before_run',
        `repository changed between prepare and run (${manifest.state_digest_prepare} -> ${digestBefore})`);
    }

    if (args.context && !existsSync(args.context)) {
      throw new ReviewError('no_context', `--context ${args.context} does not exist`);
    }
    const prompt = assemblePrompt({
      rubric: readFileSync(RUBRIC_PATH, 'utf8'),
      manifest: {
        target_kind: manifest.target_kind,
        target_resolved: manifest.target_resolved,
        scope: manifest.scope,
        diff_sha256: manifest.diff_sha256,
      },
      patch,
      context: args.context ? readFileSync(args.context, 'utf8') : null,
    });
    const promptPath = join(bundle, 'prompt.md');
    writeFileSync(promptPath, prompt);

    const outFile = join(bundle, 'final.json');
    const argv = buildCodexArgv({ model, deep: args.deep, repoRoot, schemaPath: SCHEMA_PATH, outFile });

    const fd = openSync(promptPath, 'r');    // stdin from file == `< prompt-file`
    const child = spawn('codex', argv, { stdio: [fd, 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const exit = await new Promise((res) => child.on('close', res));
    closeSync(fd);
    writeFileSync(join(bundle, 'codex.stdout.log'), stdout);
    writeFileSync(join(bundle, 'codex.stderr.log'), stderr);

    if (exit !== 0) throw new ReviewError('codex_failed', `codex exited ${exit}\n${stderr.slice(-4000)}`);

    const modelResolved = resolveModelFromOutput(stdout, stderr);
    if (modelResolved !== model) {
      throw new ReviewError('model_mismatch', `requested ${model} but Codex reported ${modelResolved}`);
    }

    if (!existsSync(outFile) || !readFileSync(outFile, 'utf8').trim()) {
      throw new ReviewError('empty_output', `codex produced no final message\n${stdout.slice(-4000)}`);
    }
    let parsed;
    try { parsed = JSON.parse(readFileSync(outFile, 'utf8')); }
    catch (e) { throw new ReviewError('invalid_json', `final message is not valid JSON: ${e.message}`); }

    // Layer 1 locally too: the fake-codex test adapter cannot enforce a remote
    // schema, so without this the schema contract would be untested.
    validateAgainstSchema(parsed, JSON.parse(readFileSync(SCHEMA_PATH, 'utf8')));
    validateSemantics(parsed);
    validateCitations(parsed, parsePatch(patch).citations);

    const digestAfter = stateDigest(repoRoot);
    if (digestAfter !== digestBefore) {
      throw new ReviewError('drift_during_run',
        `repository changed while Codex was reviewing (${digestBefore} -> ${digestAfter})`);
    }

    const finalVerdict = deriveFinalVerdict(parsed.verdict, manifest.unreviewable_paths);
    const body = renderBody(parsed, {
      finalVerdict,
      unreviewable: manifest.unreviewable_paths,
      untrackedIncluded: manifest.untracked_included,
    });

    console.log(JSON.stringify({
      ok: true,
      date: new Date().toISOString().slice(0, 10),
      title: `Codex review — ${manifest.target_resolved}`,
      reviewer_verdict: parsed.verdict,
      final_verdict: finalVerdict,
      issue_count: parsed.issues.length,
      body,
      frontmatter: {
        model_requested: model,
        model_resolved: modelResolved,
        reasoning_effort: args.deep ? 'xhigh' : 'high',
        sandbox: 'read-only',
        rubric: 'rubric-code.md',
        rubric_sha256: manifest.rubric_sha256,
        diff_sha256: manifest.diff_sha256,
        target_kind: manifest.target_kind,
        target_requested: manifest.target_requested,
        target_resolved: manifest.target_resolved,
        scope: manifest.scope,
        untracked_included: manifest.untracked_included,
        unreviewable_paths: manifest.unreviewable_paths,
        state_digest: digestAfter,
        reviewer_verdict: parsed.verdict,
        final_verdict: finalVerdict,
      },
    }, null, 2));

    if (args.keep) console.error(`[kept] artifacts retained at ${bundle}`);
    cleanup();
  } catch (err) {
    if (args.keep) console.error(`[kept] artifacts retained at ${bundle}`);
    cleanup();
    die(err.code ?? 'run_failed', err.message);
  }
}

// ---------------------------------------------------------------- main

const [, , cmd, ...rest] = process.argv;
const args = parseArgs(rest);
if (cmd === 'prepare') cmdPrepare(args);
else if (cmd === 'run') await cmdRun(args);
else if (cmd === 'discard') {
  if (!args.bundle) die('no_bundle', 'discard requires --bundle <dir>');
  if (!isBundle(args.bundle)) die('not_a_bundle', `${args.bundle} was not made by prepare; refusing to delete it`);
  rmSync(args.bundle, { recursive: true, force: true });
} else {
  die('usage', 'usage: run-code-review.mjs prepare|run|discard [flags]');
}
