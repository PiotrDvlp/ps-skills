#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const ENUMS = {
  lifecycle: ['open', 'closed'],
  disposition: ['proposed', 'selected', 'deferred', 'rejected', 'resolved', 'reopened'],
  assessment: ['present', 'absent', 'unresolved', 'not_checked'],
  confidence: ['confirmed', 'plausible'],
  verification: ['code_trace', 'executed_repro', 'regression_test'],
  on_target: ['yes', 'no', 'unknown'],
  basis: ['code contract', 'product requirement', 'investigator assumption'],
  coverage: ['full', 'partial', 'inventory'],
  severity: ['P1', 'P2', 'P3'],
};

export const ALLOWED_PAIRS = {
  open: ['proposed', 'selected', 'deferred', 'reopened'],
  closed: ['rejected', 'resolved'],
};

const SECTION_KIND = { Machines: 'machines', Findings: 'findings', Issues: 'issues' };
const ROW_KEYS = ['run', 'revision', 'assessment', 'confidence', 'verification', 'on_target', 'note'];

function splitRow(line) {
  const cells = [];
  let cur = '';
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (body[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += body[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}

export function parseLivingNote(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const note = { frontmatter: null, frontmatterUnclosed: false, machines: [], findings: [], issues: [], headings: [], orphans: [] };
  let i = 0;
  if (lines[0].trim() === '---') {
    note.frontmatter = {};
    for (i = 1; i < lines.length && lines[i].trim() !== '---'; i++) {
      const m = lines[i].match(/^([A-Za-z_]+):\s*(.*)$/);
      if (m) note.frontmatter[m[1]] = m[2].trim();
    }
    if (i >= lines.length) note.frontmatterUnclosed = true;
    i++;
  }
  let kind = null;
  let record = null;
  let section = null;
  let inFence = false;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      if (section) section.body += line + '\n';
      continue;
    }
    if (!inFence) {
      const h2 = line.match(/^##\s+(.+?)\s*$/);
      if (h2 && !line.startsWith('###')) {
        kind = SECTION_KIND[h2[1]] ?? null;
        record = null;
        section = null;
        continue;
      }
      const h3 = line.match(/^###\s+(.+?)\s*$/);
      if (h3 && !line.startsWith('####')) {
        section = null;
        if (!kind) {
          record = null;
          const orphan = h3[1].match(/^([MFI]\d+)\s*:/);
          if (orphan) note.orphans.push({ id: orphan[1], line: lineNo });
          continue;
        }
        const idMatch = h3[1].match(/^([A-Za-z0-9-]+)\s*:/);
        record = { id: idMatch ? idMatch[1] : h3[1], line: lineNo, fields: {}, kind };
        if (kind === 'machines') record.invariants = [];
        if (kind === 'findings') {
          record.sections = {};
          record.observations = [];
        }
        note[kind].push(record);
        note.headings.push(record);
        continue;
      }
      const h4 = line.match(/^####\s+(.+?)\s*$/);
      if (h4 && record?.kind === 'findings') {
        section = { line: lineNo, body: '' };
        record.sections[h4[1]] = section;
        continue;
      }
      if (record && !section) {
        const inv = line.match(/^-\s+([A-Z]\d+-I\d+)\s+\[([^\]]+)\]\s*:/);
        if (inv && record.kind === 'machines') {
          record.invariants.push({ id: inv[1], basis: inv[2].trim(), line: lineNo });
          continue;
        }
        const field = line.match(/^-\s+([a-z_]+):\s*(.*)$/);
        if (field) {
          record.fields[field[1]] = field[2].trim();
          record.fieldLines = { ...record.fieldLines, [field[1]]: lineNo };
          continue;
        }
      }
      if (section && record.sections.Observations === section && line.trim().startsWith('|')) {
        const cells = splitRow(line);
        if (cells[0] === 'run' || cells.every((c) => /^:?-+:?$/.test(c))) continue;
        const row = { line: lineNo, cells: cells.length };
        ROW_KEYS.forEach((k, n) => { row[k] = cells[n] ?? ''; });
        record.observations.push(row);
        continue;
      }
    }
    if (section) section.body += line + '\n';
  }
  return note;
}

const ID_PREFIX = { machines: 'M', findings: 'F', issues: 'I' };
const REQUIRED_SECTIONS = ['Locator', 'Trace', 'Recipe', 'Observations'];

function checkEnum(out, rec, key, value, line, { required = true } = {}) {
  if (value === undefined || value === '') {
    if (required) out.push({ line, id: rec.id, message: `enum ${key}: missing` });
    return;
  }
  if (!ENUMS[key].includes(value)) out.push({ line, id: rec.id, message: `enum ${key}: bad value '${value}'` });
}

function recipeQuoting(body) {
  const bad = [];
  for (const m of body.matchAll(/\$[A-Za-z_]\w*:[A-Za-z]/g)) bad.push(m[0]);
  for (const m of body.matchAll(/\$\{[A-Za-z_]\w*\}:/g)) {
    if (body[m.index - 1] !== '"') bad.push(m[0]);
  }
  return bad;
}

export function checkRecords(note) {
  const out = [];
  const fm = note.frontmatter;
  if (!fm) {
    out.push({ line: 1, id: '-', message: 'frontmatter missing' });
  } else if (note.frontmatterUnclosed) {
    out.push({ line: 1, id: '-', message: "frontmatter opened but never closed with '---'; nothing after it was read" });
  } else {
    const missing = [];
    if (fm.schema !== '1') missing.push('schema: 1');
    if (!fm.repo_name) missing.push('repo_name');
    if (!/^[0-9a-f]{40}$/.test(fm.repo_root_commit ?? '')) missing.push('repo_root_commit (40 hex)');
    if (!fm.target_branch) missing.push('target_branch');
    if (missing.length) out.push({ line: 1, id: '-', message: `frontmatter needs ${missing.join(', ')}` });
  }

  for (const orphan of note.orphans) {
    out.push({ line: orphan.line, id: orphan.id, message: 'record is outside a known section (## Machines, ## Findings, ## Issues) and was not checked' });
  }

  const seen = new Set();
  for (const rec of note.headings) {
    if (!new RegExp(`^${ID_PREFIX[rec.kind]}\\d{3,}$`).test(rec.id)) {
      out.push({ line: rec.line, id: rec.id, message: `malformed ID or ID prefix for ${rec.kind}` });
    } else if (seen.has(rec.id)) {
      out.push({ line: rec.line, id: rec.id, message: 'duplicate ID' });
    }
    seen.add(rec.id);
  }

  const machines = new Map(note.machines.map((m) => [m.id, m]));
  for (const m of note.machines) {
    checkEnum(out, m, 'coverage', m.fields.coverage, m.line);
    for (const inv of m.invariants) {
      if (!ENUMS.basis.includes(inv.basis)) out.push({ line: inv.line, id: m.id, message: `enum basis: bad value '${inv.basis}'` });
    }
  }

  const findingIds = new Set(note.findings.map((f) => f.id));
  for (const f of note.findings) {
    const fl = f.fieldLines ?? {};
    const machine = machines.get(f.fields.machine);
    let invariant;
    if (!machine) {
      out.push({ line: fl.machine ?? f.line, id: f.id, message: `unknown machine '${f.fields.machine ?? ''}'` });
    } else {
      invariant = machine.invariants.find((inv) => inv.id === f.fields.invariant);
      if (!invariant) out.push({ line: fl.invariant ?? f.line, id: f.id, message: `invariant '${f.fields.invariant ?? ''}' is not listed under machine ${machine.id}` });
    }

    for (const name of REQUIRED_SECTIONS) {
      if (!f.sections[name]) out.push({ line: f.line, id: f.id, message: `missing section ${name}` });
    }
    if (f.sections.Observations && f.observations.length === 0) {
      out.push({ line: f.sections.Observations.line, id: f.id, message: 'section Observations has no rows' });
    }

    checkEnum(out, f, 'lifecycle', f.fields.lifecycle, fl.lifecycle ?? f.line);
    checkEnum(out, f, 'disposition', f.fields.disposition, fl.disposition ?? f.line);
    checkEnum(out, f, 'severity', f.fields.severity, fl.severity ?? f.line, { required: false });

    for (const row of f.observations) {
      if (row.cells !== ROW_KEYS.length) out.push({ line: row.line, id: f.id, message: `observation row has ${row.cells} cells, expected ${ROW_KEYS.length}` });
      if (!row.revision) out.push({ line: row.line, id: f.id, message: 'observation without revision' });
      for (const key of ['assessment', 'confidence', 'verification', 'on_target']) checkEnum(out, f, key, row[key], row.line);
      if (row.assessment === 'absent' && !row.note.startsWith('blocker:')) out.push({ line: row.line, id: f.id, message: "absent observation needs a note starting 'blocker:'" });
      if (row.assessment === 'unresolved' && !row.note.startsWith('reason:')) out.push({ line: row.line, id: f.id, message: "unresolved observation needs a note starting 'reason:'" });
    }

    if (f.sections.Recipe) {
      for (const bad of recipeQuoting(f.sections.Recipe.body)) {
        out.push({ line: f.sections.Recipe.line, id: f.id, message: `recipe quoting: write '${bad}' as "\${NAME}:path"` });
      }
    }

    const { lifecycle, disposition } = f.fields;
    if (ALLOWED_PAIRS[lifecycle] && ENUMS.disposition.includes(disposition) && !ALLOWED_PAIRS[lifecycle].includes(disposition)) {
      out.push({ line: fl.disposition ?? f.line, id: f.id, message: `lifecycle/disposition pair '${lifecycle}/${disposition}' is not allowed` });
    }
    if (disposition === 'resolved') {
      const rows = f.observations;
      const pass = rows.findLastIndex((r) => r.verification === 'regression_test' && r.assessment === 'absent' && r.on_target === 'yes');
      const laterPresent = pass >= 0 && rows.slice(pass + 1).find((r) => r.assessment === 'present');
      if (pass < 0) {
        out.push({ line: rows.at(-1)?.line ?? f.line, id: f.id, message: 'resolved needs a passing regression test row (regression_test / absent / on_target yes)' });
      } else if (laterPresent) {
        out.push({ line: laterPresent.line, id: f.id, message: 'resolved finding has a present row after its regression test; mark it reopened' });
      }
    }
    if (disposition === 'selected' && invariant?.basis === 'investigator assumption') {
      out.push({ line: fl.disposition ?? f.line, id: f.id, message: 'selected finding rests on an investigator assumption; the owner must confirm the invariant first' });
    }
  }

  for (const issue of note.issues) {
    const ids = (issue.fields.findings ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) out.push({ line: issue.line, id: issue.id, message: 'issue lists no findings' });
    for (const id of ids) {
      if (!findingIds.has(id)) out.push({ line: issue.line, id: issue.id, message: `issue names unknown finding ${id}` });
    }
  }
  return out;
}

function main(argv) {
  const file = argv[0];
  if (!file) {
    process.stderr.write('Usage: node check-records.mjs <living-note.md>\n');
    return 2;
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    process.stderr.write(`cannot read ${file}: ${e.message}\n`);
    return 2;
  }
  const problems = checkRecords(parseLivingNote(text));
  for (const p of problems) process.stdout.write(`${p.line}: ${p.id}: ${p.message}\n`);
  process.stdout.write(`${problems.length} problems\n`);
  return problems.length ? 1 : 0;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
