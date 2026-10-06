#!/usr/bin/env node
// Duel-mode shared-prompt integrity check (run at duel Step 3, before synthesis).
//
//   verify  re-hash the shared prompt file and compare against the hash recorded
//           at build time AND the hash the Claude track reported consuming.
//
// A mismatch on either comparison exits nonzero and prints the raw hashes — a
// symmetry violation must stop the duel before any synthesis exists. The Codex
// track needs no reported hash: its consumption of the hashed file is enforced
// by construction (stdin redirect), so the only reported value is Claude's.

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { argv as procArgv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { sha256 } from './code-review-core.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case '--shared-prompt': out.sharedPrompt = next(); break;
      case '--recorded-sha': out.recordedSha = next(); break;
      case '--claude-sha': out.claudeSha = next(); break;
      case '--emit': out.emit = next(); break;
      default: break;
    }
  }
  return out;
}

/** Pure: decides whether the duel's symmetry proof holds. */
export function verifySymmetry({ computed, recorded, claudeReported }) {
  // Byte-strict on purpose: hash text is produced by shasum -a 256 / node crypto in
  // canonical lowercase hex; normalize at the call site if a non-canonical producer appears.
  if (computed !== recorded) {
    return { ok: false, reason: 'shared prompt drifted after build — recorded hash does not match current bytes' };
  }
  if (computed !== claudeReported) {
    return { ok: false, reason: 'Claude track consumed different bytes — reported hash does not match the shared prompt' };
  }
  return { ok: true };
}

// Main guard: importing this module (e.g. from the test suite) must not run the CLI.
const invokedDirectly = procArgv[1] && realpathSync(procArgv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) main();

function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const k of ['sharedPrompt', 'recordedSha', 'claudeSha']) {
    if (!args[k]) {
      console.error(`[usage] --${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} is required`);
      process.exit(2);
    }
  }

  let computed;
  try {
    computed = sha256(readFileSync(args.sharedPrompt));
  } catch (err) {
    console.error(`[abort] cannot read shared prompt file: ${err.code}`);
    console.log(JSON.stringify({ ok: false, reason: 'shared prompt file missing or unreadable at verify time' }, null, 2));
    process.exit(1);
  }
  const verdict = verifySymmetry({
    computed,
    recorded: args.recordedSha,
    claudeReported: args.claudeSha,
  });

  const full = {
    ...verdict,
    computed,
    recorded: args.recordedSha,
    claudeReported: args.claudeSha,
  };

  console.log(JSON.stringify(full, null, 2));

  // Sidecar verdict artifact (--emit): written ONLY on success, so a skipped verify
  // run is distinguishable from a passed one by the file's absence.
  if (verdict.ok && args.emit) {
    writeFileSync(args.emit, JSON.stringify({ ...full, verified_at: new Date().toISOString() }, null, 2) + '\n');
  }

  if (!verdict.ok) process.exit(1);
}
