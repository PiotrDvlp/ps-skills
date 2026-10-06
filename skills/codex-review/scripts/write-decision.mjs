// Pure: decides whether a review note may be written, and where.
// Kept separate from write-note.mjs so the rule is testable without a vault,
// and enforced BY write-note.mjs so the rule actually gates something.

/**
 * @param {object} input
 * @param {object|null} input.result      runner result, or null when the run failed
 * @param {string}      input.routing     'project' | 'unknown' | 'other'
 * @param {string}      input.baseDir     directory the note would go in
 * @param {string}      input.slug        note basename without extension
 * @param {string[]}    input.existing    paths that already exist in baseDir
 * @param {boolean}     input.confirmed   user confirmed an 'unknown' namespace
 * @returns {{shouldWrite: boolean, path: string|null, logLine: string|null, reason: string}}
 */
export function decideWrite({ result, routing, baseDir, slug, existing = [], confirmed = false }) {
  if (!result || result.ok !== true) {
    return {
      shouldWrite: false,
      path: null,
      logLine: null,
      reason: result?.error ? `run failed: ${result.error}` : 'run failed or produced no result',
    };
  }
  if (routing === 'unknown' && !confirmed) {
    return {
      shouldWrite: false,
      path: null,
      logLine: null,
      reason: 'namespace classified unknown and the user has not confirmed a destination',
    };
  }

  // Never overwrite: two reviews on the same target on the same day are two runs.
  let candidate = `${baseDir}/${slug}.md`;
  let n = 2;
  while (existing.includes(candidate)) {
    candidate = `${baseDir}/${slug}-${n}.md`;
    n += 1;
  }

  return {
    shouldWrite: true,
    path: candidate,
    logLine: `## [${result.date}] codex-review | ${result.title} → [[${candidate.split('/').pop().replace(/\.md$/, '')}]]`,
    reason: 'ok',
  };
}
