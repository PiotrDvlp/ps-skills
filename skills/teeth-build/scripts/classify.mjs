const ASSERTION = /^(expected |AssertionError)|Snapshot .* mismatched/;

function originalText(sourceLines, { start, end }) {
  const text = sourceLines?.[start.line - 1]?.slice(start.column - 1, start.line === end.line ? end.column - 1 : undefined).trim();
  if (!text) return '';
  const cut = text.length > 80 ? `${text.slice(0, 80)} …` : text;
  return start.line === end.line || cut.endsWith('…') ? cut : `${cut} …`;
}

const codeSpan = (text) => (text.includes('`') ? `\`\` ${text} \`\`` : `\`${text}\``);

export const formatRow = (r) => `${r.file}:${r.line} ${r.mutator} ${r.original ? `${codeSpan(r.original)} ` : ''}→ ${r.replacement} (${r.reason})`;

export function classifyMutants(report, changed) {
  const out = { findings: [], timedOut: [], invalid: [], passed: [], notCovered: [] };
  for (const [file, wanted] of changed) {
    const want = new Set(wanted);
    const validLines = new Set();
    const sourceLines = report.files?.[file]?.source?.split('\n');
    for (const m of report.files?.[file]?.mutants ?? []) {
      const line = m.location.start.line;
      if (!want.has(line)) continue;
      const row = { file, line, mutator: m.mutatorName, original: originalText(sourceLines, m.location), replacement: m.replacement ?? '', reason: '' };
      const reason = m.statusReason ?? '';
      if (m.status === 'CompileError' || m.status === 'RuntimeError') { out.invalid.push(row); continue; }
      validLines.add(line);
      if (m.status === 'Timeout') out.timedOut.push(row);
      else if (m.status === 'Survived' || m.status === 'NoCoverage') out.findings.push({ ...row, reason: m.status });
      else if (m.status !== 'Killed') out.findings.push({ ...row, reason: `unknown status ${m.status}` });
      else if (!m.killedBy?.length) out.findings.push({ ...row, reason: 'unattributed' });
      else if (ASSERTION.test(reason)) out.passed.push(row);
      else out.findings.push({ ...row, reason: 'no assertion evidence' });
    }
    for (const line of wanted) if (!validLines.has(line)) out.notCovered.push({ file, line, reason: 'no mutant inside the changed lines' });
  }
  for (const k of ['findings', 'timedOut', 'invalid', 'passed']) out[k].sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return out;
}
