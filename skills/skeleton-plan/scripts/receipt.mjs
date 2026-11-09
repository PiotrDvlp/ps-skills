/** @typedef {{ status: 'passed'|'failed'|'blocked'|'passed-ungated'|'not-typechecked', code: 0|1|3|4|5, reason?: string, ungated: string[] }} GateResult */

const isVue = (path) => path.endsWith('.vue');

/**
 * Pass needs exit 0 and no diagnostics; status 4 needs only `.vue` diagnostics and at least one gated block; anything else fails or blocks.
 * @param {import('./snapshot.mjs').TypecheckResult} result
 * @param {import('./plan-format.mjs').ParsedPlan} plan
 * @param {Set<string>} covered repo-relative paths the snapshot's tsconfig includes
 * @param {{ gated: number, ungated: string[] }} splice
 * @returns {GateResult}
 */
export function classify(result, plan, covered, splice) {
  const blocked = (reason) => ({ status: 'blocked', code: 3, reason, ungated: [] });
  const failed = (reason) => ({ status: 'failed', code: 1, reason, ungated: [] });

  if (result.spawnError || result.signal) return blocked('typecheck could not run');
  if (splice.gated === 0) return blocked('no gated block');
  const uncovered = plan.blocks.find((b) => b.op !== 'delete-file' && !isVue(b.path) && !covered.has(b.path));
  if (uncovered) return blocked(`uncovered: ${uncovered.path}`);

  const diagnostics = result.diagnostics;
  const ungatedStatus = (extra) => {
    const ungated = [...new Set([...splice.ungated, ...extra])];
    return { status: 'passed-ungated', code: 4, reason: `passed with ${ungated.length} ungated items`, ungated };
  };

  if (result.exitCode === 0 && diagnostics.length === 0) {
    return splice.ungated.length > 0 ? ungatedStatus([]) : { status: 'passed', code: 0, ungated: [] };
  }
  if (diagnostics.length > 0 && diagnostics.every((d) => isVue(d.file))) {
    return ungatedStatus(diagnostics.map((d) => d.file));
  }
  const listed = new Set(plan.files.map((f) => f.path));
  const caller = diagnostics.find((d) => d.file.endsWith('.ts') && !listed.has(d.file));
  if (caller) return failed(`caller broken: ${caller.file}`);
  if (diagnostics.length > 0) return failed(`typecheck reported ${diagnostics.length} diagnostics`);
  return failed(`typecheck exited ${result.exitCode} without diagnostics`);
}
