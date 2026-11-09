import { createHash } from 'node:crypto';
import { closeSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePlan, planHash } from './plan-format.mjs';
import { ensureSafeDir, fail } from './tools.mjs';

/** @typedef {{ status: 'passed'|'failed'|'blocked'|'passed-ungated'|'not-typechecked', code: 0|1|3|4|5, reason?: string, ungated: string[] }} GateResult */

const isVue = (path) => path.toLowerCase().endsWith('.vue');
const ungatedLine = (count) => `passed with ${count} ungated items`;

/** `plan.md` -> `plan.receipt.json`; a path without a trailing `.md` gets `.receipt.json` appended. */
export const receiptPath = (planPath) => `${planPath.endsWith('.md') ? planPath.slice(0, -3) : planPath}.receipt.json`;

/**
 * Pass needs exit 0 and no diagnostics; status 4 needs only `.vue` diagnostics in listed files and at least one gated block; a diagnostic in an unlisted `.ts` or `.vue` file is a broken caller; anything else fails or blocks.
 * @param {import('./snapshot.mjs').TypecheckResult} result
 * @param {import('./plan-format.mjs').ParsedPlan} plan
 * @param {Set<string>} covered repo-relative paths the snapshot's tsconfig includes after the splice
 * @param {{ gated: number, ungated: string[] }} splice
 * @param {Set<string>} [baseCovered] the same paths before the splice; every `delete-file` path must be in it
 * @returns {GateResult}
 */
export function classify(result, plan, covered, splice, baseCovered) {
  const blocked = (reason) => ({ status: 'blocked', code: 3, reason, ungated: [] });
  const failed = (reason) => ({ status: 'failed', code: 1, reason, ungated: [] });

  if (result.spawnError || result.signal) return blocked('typecheck could not run');
  if (splice.gated === 0) return blocked('no gated block');
  const uncovered = plan.blocks.find((b) => !isVue(b.path) && !(b.op === 'delete-file' ? baseCovered : covered).has(b.path));
  if (uncovered) return blocked(`uncovered: ${uncovered.path}`);

  const diagnostics = result.diagnostics;
  const ungatedStatus = (extra) => {
    const ungated = [...new Set([...splice.ungated, ...extra])];
    return { status: 'passed-ungated', code: 4, reason: ungatedLine(ungated.length), ungated };
  };

  if (result.exitCode === 0 && diagnostics.length === 0) {
    return splice.ungated.length > 0 ? ungatedStatus([]) : { status: 'passed', code: 0, ungated: [] };
  }
  const listed = new Set(plan.files.map((f) => f.path));
  const caller = diagnostics.find((d) => (d.file.endsWith('.ts') || isVue(d.file)) && !listed.has(d.file));
  if (caller) return failed(`caller broken: ${caller.file}`);
  if (diagnostics.length > 0 && diagnostics.every((d) => isVue(d.file))) {
    return ungatedStatus(diagnostics.map((d) => d.file));
  }
  if (diagnostics.length > 0) return failed(`typecheck reported ${diagnostics.length} diagnostics`);
  return failed(`typecheck exited ${result.exitCode} without diagnostics`);
}

/** Takes the per-plan lock and deletes an earlier receipt; throws code 3 `blocked: another run on this plan` if locked. */
export function startRun(planPath, runRoot) {
  const locks = join(runRoot, 'locks');
  ensureSafeDir(runRoot, 'run root');
  ensureSafeDir(locks, 'locks dir');
  const lock = join(locks, `${createHash('sha256').update(realpathSync(planPath)).digest('hex')}.lock`);
  const pid = String(process.pid);

  const alive = (other) => {
    try {
      process.kill(other, 0);
      return true;
    } catch (err) {
      return err.code === 'EPERM';
    }
  };
  const take = () => {
    const fd = openSync(lock, 'wx', 0o600);
    try {
      writeFileSync(fd, pid);
    } finally {
      closeSync(fd);
    }
  };

  try {
    take();
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const holder = Number.parseInt(readFileSync(lock, 'utf8'), 10);
    if (Number.isInteger(holder) && alive(holder)) throw fail('blocked: another run on this plan', 3);
    process.stderr.write(`warning: removing stale lock of pid ${holder}\n`);
    rmSync(lock, { force: true });
    try {
      take();
    } catch (retry) {
      if (retry.code === 'EEXIST') throw fail('blocked: another run on this plan', 3);
      throw retry;
    }
  }

  rmSync(receiptPath(planPath), { force: true });
  return {
    release() {
      try {
        if (readFileSync(lock, 'utf8') === pid) rmSync(lock, { force: true });
      } catch {}
    },
  };
}

/** Writes `receiptPath(plan)` via temp file and rename, only if the plan still hashes to `expected`; returns false otherwise. */
export function writeReceipt(planPath, expected, receipt) {
  try {
    if (planHash(parsePlan(readFileSync(planPath, 'utf8'))) !== expected) return false;
  } catch {
    return false;
  }
  const target = receiptPath(planPath);
  const temp = `${target}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify({ approvalHash: expected, ...receipt }, null, 2)}\n`);
  renameSync(temp, target);
  return true;
}

/**
 * The receipt check: `receipt matches` (code 0) only when the plan still hashes to the receipt's `approvalHash` and its Gate line is the line the gate printed for the receipt's status; otherwise `receipt stale: ...` or `receipt missing: <path>` (code 1).
 * @returns {{ code: 0|1, lines: string[] }}
 */
export function verifyReceipt(planPath) {
  const plan = parsePlan(readFileSync(planPath, 'utf8'));
  const path = receiptPath(planPath);
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return { code: 1, lines: [`receipt missing: ${path}`] };
    throw e;
  }
  const stale = (why) => ({ code: 1, lines: [`receipt stale: ${why}`] });
  if (planHash(plan) !== receipt.approvalHash) return stale('the approval part changed');
  const expected = `Gate: ${receipt.status === 'passed-ungated' ? ungatedLine(receipt.ungated?.length ?? 0) : receipt.status}`;
  if (plan.gateLine?.trimEnd() !== expected) {
    return stale(`${plan.gateLine === null ? 'the plan has no Gate line' : `the plan says "${plan.gateLine}"`}, the receipt says "${expected}"`);
  }
  return { code: 0, lines: ['receipt matches'] };
}
