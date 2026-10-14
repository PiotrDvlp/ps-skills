const ASSERTION = /^(expected |AssertionError)|Snapshot .* mismatched/;

export function classifyMutants(report, changed) {
  const out = { findings: [], timedOut: [], invalid: [], passed: [], notCovered: [] };
  for (const [file, wanted] of changed) {
    const want = new Set(wanted);
    const validLines = new Set();
    for (const m of report.files?.[file]?.mutants ?? []) {
      const line = m.location.start.line;
      if (!want.has(line)) continue;
      const row = { file, line, mutator: m.mutatorName, replacement: m.replacement ?? '', reason: '' };
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
