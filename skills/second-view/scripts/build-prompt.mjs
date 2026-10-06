// Assembles the exact text sent to Codex. Stripping the withheld half is THIS
// function's job — the acceptance criterion tests it here rather than observing
// a downstream artifact, because this is the code that enforces the boundary.
const SENT_MARKER = '=== SENT TO CODEX ===';
const WITHHELD_MARKER = '=== WITHHELD ===';

export function buildPrompt({ rubric, brief }) {
  if (typeof rubric !== 'string' || typeof brief !== 'string') {
    throw new Error('rubric and brief must both be strings');
  }

  const sentAt = brief.indexOf(SENT_MARKER);
  if (sentAt === -1) {
    throw new Error(
      `brief is missing the ${SENT_MARKER} marker — refusing to send it whole`,
    );
  }

  // A WITHHELD block positioned before the SENT marker means the brief is
  // structured in a way this parser does not understand. Falling through would
  // treat the withheld content as sendable, which is the one failure this
  // module exists to prevent, so refuse instead of guessing.
  const withheldAt = brief.indexOf(WITHHELD_MARKER);
  if (withheldAt !== -1 && withheldAt < sentAt) {
    throw new Error(
      `${WITHHELD_MARKER} appears before ${SENT_MARKER} — refusing to guess the boundary`,
    );
  }

  // A near-miss marker (wrong spacing, wrong number of "=", lowercase, a
  // trailing qualifier) must not fail open. indexOf is exact-match: any drift
  // makes withheldAt === -1 and the code below would then send the entire
  // remainder of the brief, including whatever WITHHELD-like content is there.
  // A missing SENT marker throws (above); a mangled WITHHELD marker must too —
  // the asymmetry between those two cases is exactly the bug this guards.
  if (withheldAt === -1 && /^\s*={2,}\s*WITHHELD/im.test(brief.slice(sentAt))) {
    throw new Error(
      'a WITHHELD-like line is present but does not match the exact marker '
      + `${WITHHELD_MARKER} — refusing to guess`,
    );
  }

  const afterSent = sentAt + SENT_MARKER.length;
  const problemHalf = withheldAt === -1
    ? brief.slice(afterSent)
    : brief.slice(afterSent, withheldAt);

  if (problemHalf.trim() === '') {
    throw new Error(
      'the problem half is empty or whitespace-only — refusing to send a rubric with no problem',
    );
  }

  return `${rubric}\n\n${problemHalf.trim()}\n`;
}
