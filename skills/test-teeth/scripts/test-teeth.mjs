import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync, lstatSync, realpathSync, openSync, closeSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export { planMutations, applyMutation, maskedRanges, safeMatches } from './mutation-ops.mjs';
import { planMutations, applyMutation, maskedRanges, safeMatches } from './mutation-ops.mjs';

export function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
export function manifestDir(root) { return join(tmpdir(), 'test-teeth', createHash('sha1').update(root).digest('hex')); }

function inside(root, path) {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function unsafeManifestDir(path, reason) {
  const err = new Error(`unsafe manifest directory ${path}: ${reason}; remove it and rerun`);
  err.code = 3;
  return err;
}

function requireSafeDirectory(path) {
  let st;
  try { st = lstatSync(path); } catch (e) {
    throw unsafeManifestDir(path, e.code === 'ENOENT' ? 'does not exist' : e.message);
  }
  if (st.isSymbolicLink()) throw unsafeManifestDir(path, 'is a symlink');
  if (!st.isDirectory()) throw unsafeManifestDir(path, 'is not a directory');
  if (typeof process.getuid !== 'function' || st.uid !== process.getuid()) throw unsafeManifestDir(path, 'is not owned by the current user');
  if ((st.mode & 0o077) !== 0) throw unsafeManifestDir(path, `permissions are ${(st.mode & 0o777).toString(8).padStart(3, '0')}, not owner-only`);
}

function prepareManifestDirectories(root) {
  const base = join(tmpdir(), 'test-teeth');
  const dir = manifestDir(root);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  requireSafeDirectory(base);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  requireSafeDirectory(dir);
  return dir;
}

function validateManifestDirectories(dir) {
  requireSafeDirectory(dirname(dir));
  requireSafeDirectory(dir);
}

function clearManifest(dir) {
  validateManifestDirectories(dir);
  for (const name of readdirSync(dir)) rmSync(join(dir, name), { recursive: true, force: true });
}

export function reconcile(entries, readFile) {
  const r = { restore: [], drop: [], conflict: [] };
  for (const e of entries) {
    if (e.mutatedHash === null) { r.drop.push(e); continue; }
    let cur;
    try { cur = sha256(readFile(e.path)); } catch { r.drop.push(e); continue; }
    if (cur === e.mutatedHash) r.restore.push(e);
    else if (cur === e.originalHash) r.drop.push(e);
    else r.conflict.push(e);
  }
  return r;
}

function loadManifest(dir) {
  const p = join(dir, 'manifest.json');
  if (!existsSync(p)) return [];
  const m = JSON.parse(readFileSync(p, 'utf8'));
  return m.entries.map((e) => ({ ...e, original: readFileSync(join(dir, 'originals', e.key)) }));
}

function saveManifest(dir, entries) {
  validateManifestDirectories(dir);
  mkdirSync(join(dir, 'originals'), { recursive: true, mode: 0o700 });
  for (const e of entries) {
    const original = join(dir, 'originals', e.key);
    if (!existsSync(original)) writeFileSync(original, e.original);
  }
  const manifest = join(dir, 'manifest.json');
  const tmp = `${manifest}.tmp`;
  writeFileSync(tmp, JSON.stringify({ entries: entries.map(({ original, ...rest }) => rest) }, null, 2));
  renameSync(tmp, manifest);
}

export function recover(root, log = console.error) {
  const dir = prepareManifestDirectories(root);
  const entries = loadManifest(dir);
  if (entries.length === 0) return;
  const rootReal = realpathSync(root);
  const unsafe = [];
  const safe = [];
  for (const entry of entries) {
    let target;
    try { target = resolve(realpathSync(dirname(entry.path)), basename(entry.path)); } catch { target = null; }
    if (!target || !inside(rootReal, target)) unsafe.push(entry);
    else safe.push(entry);
  }
  const r = reconcile(safe, (p) => readFileSync(p));
  r.conflict.push(...unsafe);
  for (const e of r.restore) { writeFileSync(e.path, e.original); log(`restored ${e.path} from manifest`); }
  if (r.conflict.length) {
    saveManifest(dir, r.conflict);
    const err = new Error(`manifest conflict: ${r.conflict.map((e) => e.path).join(', ')} changed since the interrupted run; manifest at ${dir}`);
    err.code = 3;
    throw err;
  }
  clearManifest(dir);
}

export const INVALID_RE = /SyntaxError|Failed to resolve import|Cannot find module|Failed to parse|Transform failed|Parse failure/;
const ASSERTION_PREFIX = 'AssertionError:';

export function caseId(specRel, name, line) {
  return `${specRel}::${name}::${line}`;
}

export function reporterName(a) {
  return [...(a.ancestorTitles ?? []), a.title].join(' > ');
}

export function parseList(listJson, root) {
  const cases = listJson.map((e) => {
    const spec = relative(root, e.file).split(sep).join('/');
    const line = e.location?.line ?? 0;
    return { id: caseId(spec, e.name, line), spec, name: e.name, line, duplicate: false };
  });
  const seen = new Map();
  for (const c of cases) seen.set(c.id, (seen.get(c.id) ?? 0) + 1);
  for (const c of cases) c.duplicate = seen.get(c.id) > 1;
  return cases;
}

export function mapImpl(specAbs, exists = existsSync) {
  const base = basename(specAbs).replace(/\.(test|spec)\.ts$/, '');
  let dir = dirname(specAbs);
  if (basename(dir) === '__tests__') dir = dirname(dir);
  for (const ext of ['.vue', '.ts']) {
    const candidate = join(dir, base + ext);
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function attribute(report, cases, root) {
  const byCase = new Map(cases.map((c) => [c.id, { status: 'missing', message: '' }]));
  const runtimeFailures = [];
  let invalid = false;
  let killed = false;
  for (const file of report.testResults ?? []) {
    const spec = relative(root, file.name).split(sep).join('/');
    if (file.status === 'failed' && (file.assertionResults ?? []).length === 0) invalid = true;
    if (INVALID_RE.test(file.message ?? '')) invalid = true;
    for (const a of file.assertionResults ?? []) {
      const id = caseId(spec, reporterName(a), a.location?.line ?? 0);
      if (!byCase.has(id)) continue;
      const message = a.failureMessages?.[0] ?? '';
      if (!message.startsWith(ASSERTION_PREFIX) && INVALID_RE.test(message)) invalid = true;
      if (a.status === 'passed') byCase.set(id, { status: 'passed', message: '' });
      else if (a.status === 'skipped' || a.status === 'pending' || a.status === 'todo') byCase.set(id, { status: 'skipped', message: '' });
      else if (a.status === 'failed' && message.startsWith(ASSERTION_PREFIX)) { byCase.set(id, { status: 'killed', message }); killed = true; }
      else if (a.status === 'failed') { byCase.set(id, { status: 'runtime', message }); runtimeFailures.push(id); }
    }
  }
  const mutantState = invalid ? 'invalid' : killed ? 'killed' : 'survived';
  if (invalid) {
    for (const [id, v] of byCase) {
      if (v.status === 'killed' || v.status === 'runtime') {
        byCase.set(id, { status: 'missing', message: v.message });
      }
    }
    runtimeFailures.length = 0;
  }
  return { mutantState, byCase, runtimeFailures };
}

const TEMPLATE_OPS = [
  { kind: 'template-if', re: /\b(v-if|v-else-if|v-show)="([^"]+)"/g, cap: 3,
    make: (m) => ({ replacement: `${m[1]}="!(${m[2]})"`, note: `${m[1]} negated` }) },
  { kind: 'template-for', re: /\bv-for="([^"]+?)\s+in\s+[^"]+"/g, cap: 2,
    make: (m) => ({ replacement: `v-for="${m[1]} in []"`, note: 'v-for over empty list' }) },
  { kind: 'template-prop', re: /(?<=\s):([\w.-]+)="([^"]+)"/g, cap: 3,
    make: (m) => (m[1] === 'key' ? null : { replacement: `:${m[1]}="undefined"`, note: `:${m[1]} undefined` }) },
  { kind: 'template-event', re: /(?<=\s)@([\w.-]+)="([^"]+)"/g, cap: 2,
    make: (m) => ({ replacement: `@${m[1]}="() => {}"`, note: `@${m[1]} no-op` }) },
];

function htmlCommentRanges(block, offset) {
  return [...block.matchAll(/<!--[\s\S]*?-->/g)].map((m) => [offset + m.index, offset + m.index + m[0].length]);
}

export function templateMutations(path, source) {
  const start = source.indexOf('<template');
  const end = source.lastIndexOf('</template>');
  if (start < 0 || end < 0) return [];
  const block = source.slice(start, end);
  const ranges = htmlCommentRanges(block, start);
  const out = [];
  for (const op of TEMPLATE_OPS) {
    if (op.cap <= 0) continue;
    let n = 0;
    for (const m of block.matchAll(op.re)) {
      const at = start + m.index;
      if (ranges.some(([s, e]) => at >= s && at < e)) continue;
      const made = op.make(m);
      if (!made) continue;
      if (made.replacement === m[0]) continue;
      out.push({ file: path, at, len: m[0].length, replacement: made.replacement, kind: op.kind, note: made.note });
      if (++n >= op.cap) break;
    }
  }
  return out;
}

export function interleave(lists, max) {
  const out = [];
  const queues = lists.map((l) => [...l]);
  while (out.length < max && queues.some((q) => q.length)) {
    for (const q of queues) {
      if (out.length >= max) break;
      if (q.length) out.push(q.shift());
    }
  }
  return out;
}

export function planAll(files, { maxMutations = 30, manual = [] } = {}) {
  for (const m of manual) {
    if (!files.some((f) => m.file === f.path || f.path.endsWith('/' + m.file))) {
      throw new Error(`--mutations names a file not in the audited set: ${m.file}`);
    }
  }
  const manualPlanned = manual.map((m) => {
    const f = files.find((candidate) => m.file === candidate.path || candidate.path.endsWith('/' + m.file));
    return planMutations([f], { maxMutations: 1, manual: [m] })[0];
  });
  const perFile = files.map((f) => {
    const builtIn = planMutations([f], { maxMutations, manual: [] });
    const template = f.path.endsWith('.vue') ? templateMutations(f.path, f.source) : [];
    return [...template, ...builtIn];
  });
  const planned = [...manualPlanned, ...interleave(perFile, Math.max(0, maxMutations - manualPlanned.length))];
  return planned.map((m, i) => ({ ...m, id: `M${String(i + 1).padStart(2, '0')}` }));
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;

export function fingerprints(stderr) {
  const out = new Map();
  for (const raw of String(stderr).split('\n')) {
    const line = raw.replace(ANSI_RE, '').replace(/\s+at\s+\/\S+/g, '').replace(/\/(?:private\/)?tmp\/\S+/g, 'TMP').replace(/\d+/g, 'N').trim();
    if (!line) continue;
    out.set(line, (out.get(line) ?? 0) + 1);
  }
  return out;
}

export function firstNewWarning(baseline, trimmed) {
  for (const [fp, count] of trimmed) {
    if ((baseline.get(fp) ?? 0) < count) return fp;
  }
  return null;
}

const CALL_HEAD = /^[ \t]*(it|test)(\.(each|concurrent|skip|only|todo|skipIf|runIf)(\([^\)\n]*\))?)*\s*(\(|`)/;

function lineOffset(source, line) {
  let off = 0;
  for (let i = 1; i < line; i++) {
    off = source.indexOf('\n', off);
    if (off < 0) return -1;
    off++;
  }
  return off;
}

export function findCallSpan(source, line) {
  const start = lineOffset(source, line);
  if (start < 0) return null;
  const lineEnd = source.indexOf('\n', start);
  const head = CALL_HEAD.exec(source.slice(start, lineEnd < 0 ? undefined : lineEnd));
  if (!head) return null;
  const ranges = maskedRanges(source);
  const masked = (i) => ranges.some(([s, e]) => i >= s && i < e);
  let i = start + head[0].length - 1;
  let depth = 0;
  let sawCall = false;
  for (; i < source.length; i++) {
    if (masked(i)) continue;
    const c = source[i];
    if (c === '(') { depth++; sawCall = true; }
    else if (c === ')') {
      depth--;
      if (depth === 0 && sawCall) {
        const rest = source.slice(i + 1);
        const chained = /^\s*\(/.exec(rest);
        if (chained) { i += chained[0].length - 1; depth = 0; continue; }
        const semi = /^[ \t]*;/.exec(rest);
        let end = i + 1 + (semi ? semi[0].length : 0);
        const nl = /^[ \t]*\n/.exec(source.slice(end));
        if (nl) end += nl[0].length;
        return { start, end };
      }
    }
  }
  return null;
}

export function removeSpans(source, spans) {
  const sorted = [...spans].sort((a, b) => b.start - a.start);
  let out = source;
  for (const { start, end } of sorted) out = out.slice(0, start) + out.slice(end);
  return out;
}

export function defaultRun(bin, timeoutMs = 120000) {
  return (args, cwd) => {
    const r = spawnSync(bin, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL' });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', signal: r.signal, error: r.error };
  };
}

export function walk(dir, pred, out = [], root = realpathSync(dir)) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (!inside(root, realpathSync(p))) continue;
      walk(p, pred, out, root);
    }
    else if (pred(p)) out.push(p);
  }
  return out;
}

export async function audit(opts) {
  const { root, feature, maxMutations = 30, manual = [], timeoutMs = 120000, log = console.error } = opts;
  const vitestBin = opts.vitestBin ?? join(root, 'node_modules', '.bin', 'vitest');
  const t0 = Date.now();
  const dir = prepareManifestDirectories(root);
  const lock = `${dir}.lock`;
  let ownsLock = false;
  const locked = (pid) => {
    const err = new Error(`another audit is running on this root (pid ${pid})`);
    err.code = 3;
    return err;
  };
  try {
    let fd;
    validateManifestDirectories(dir);
    try {
      fd = openSync(lock, 'wx');
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(lock, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) {
        const err = new Error(`lock file ${lock} has no PID; if no audit is running, delete it and rerun`);
        err.code = 3;
        throw err;
      }
      let alive = true;
      if (alive) try { process.kill(pid, 0); } catch { alive = false; }
      if (alive) throw locked(pid);
      unlinkSync(lock);
      try { fd = openSync(lock, 'wx'); } catch (retry) {
        if (retry.code === 'EEXIST') throw locked(Number(readFileSync(lock, 'utf8')));
        throw retry;
      }
    }
    ownsLock = true;
    writeFileSync(fd, String(process.pid));
    closeSync(fd);

    recover(root, log);
    if (!opts.run && !existsSync(vitestBin)) {
      const err = new Error(`vitest not found at ${vitestBin}`);
      err.code = 3;
      throw err;
    }
    const run = opts.run ?? defaultRun(vitestBin, timeoutMs);
    let entries = [];
    const skippedRestores = new Map();
    const restoreEntry = (entry) => {
      if (entry.mutatedHash === null) return true;
      let current;
      try { current = readFileSync(entry.path); } catch { skippedRestores.set(entry.path, entry); return false; }
      if (sha256(current) !== entry.mutatedHash) { skippedRestores.set(entry.path, entry); return false; }
      writeFileSync(entry.path, entry.original);
      entry.mutatedHash = null;
      skippedRestores.delete(entry.path);
      return true;
    };
    const assertUnchanged = (entry) => {
      let current;
      try { current = readFileSync(entry.path); } catch {}
      if (current && sha256(current) === entry.originalHash) return;
      const err = new Error(`concurrent edit: ${entry.path} changed during the audit`);
      err.code = 3;
      throw err;
    };
    let runs = 0;
    const rootReal = realpathSync(root);
    const featureAbs = resolve(root, feature);
    const featureReal = realpathSync(featureAbs);
    if (!inside(rootReal, featureReal)) {
      const err = new Error('--feature must be inside --root');
      err.code = 3;
      throw err;
    }
    const featureRel = relative(root, featureAbs).split(sep).join('/');
    const filter = featureRel ? `${featureRel.replace(/\/$/, '')}/` : null;
    const runVitest = (extraArgs) => {
    const out = join(dir, `run-${++runs}.json`);
    const r = run(['run', ...(filter ? [filter] : []), '--root', root, '--reporter=json', `--outputFile=${out}`, '--includeTaskLocation', '--no-color', '--no-cache', ...extraArgs], root);
    if (r.signal === 'SIGINT' || r.signal === 'SIGTERM') {
      const err = new Error(`interrupted by ${r.signal}`);
      err.code = 130;
      throw err;
    }
    let json = null;
    let reportInvalid = false;
    try { json = JSON.parse(readFileSync(out, 'utf8')); } catch { json = { testResults: [] }; reportInvalid = true; }
    return { ...r, json, reportInvalid };
    };
    try {
    const specs = walk(featureAbs, (p) => /\.(test|spec)\.ts$/.test(p), [], rootReal);
    const implBySpec = new Map(specs.map((s) => [s, mapImpl(s)]));
    const unmapped = specs.filter((s) => !implBySpec.get(s)).map((s) => relative(root, s).split(sep).join('/'));
    const listOut = run(['list', ...(filter ? [filter] : []), '--root', root, '--json', '--includeTaskLocation', '--no-cache'], root);
    let listJson;
    try { listJson = JSON.parse(listOut.stdout); } catch { listJson = null; }
    if (listOut.status !== 0 || !Array.isArray(listJson)) {
      const first = String(listOut.stderr ?? '').split('\n')[0];
      const err = new Error(`vitest list failed: ${first}`);
      err.code = 3;
      throw err;
    }
    const cases = parseList(listJson, root);
    const implFiles = [...new Set([...implBySpec.values()].filter(Boolean))].map((file) => ({
      path: relative(root, file).split(sep).join('/'), file, source: readFileSync(file, 'utf8'),
    }));
    entries = implFiles.map((f) => ({ path: f.file, key: sha256(Buffer.from(f.file)).slice(0, 16), originalHash: sha256(Buffer.from(f.source)), mutatedHash: null, original: Buffer.from(f.source) }));
    for (const s of specs) {
      const src = readFileSync(s);
      entries.push({ path: s, key: sha256(Buffer.from(s)).slice(0, 16), originalHash: sha256(src), mutatedHash: null, original: src });
    }
    const baseRun = runVitest([]);
    const baseAttr = attribute(baseRun.json, cases, root);
    const baseFailed = baseRun.status !== 0 || baseRun.reportInvalid || (baseRun.json.numFailedTests ?? 0) > 0 || [...baseAttr.byCase.values()].some((v) => v.status === 'killed' || v.status === 'runtime') || baseRun.json.collectionError || baseAttr.mutantState === 'invalid';
    if (baseFailed) {
      const err = new Error(`baseline not green: ${baseRun.json.numFailedTests ?? '?'} failed, ${baseRun.json.numPassedTests ?? '?'} passed`);
      err.code = 2;
      throw err;
    }
    const unmatched = [...baseAttr.byCase.values()].filter((v) => v.status === 'missing').length;
    if (unmatched) log(`test-teeth: ${unmatched} listed cases not matched in reporter output`);
    const baseWarn = fingerprints(baseRun.stderr);
    const mutants = planAll(implFiles, { maxMutations, manual });
    if (manual.length > maxMutations) log(`--mutations has ${manual.length} entries, more than --max-mutations ${maxMutations}; all ${manual.length} run`);
    saveManifest(dir, entries);
    log(`test-teeth: manifest at ${dir}; if this run dies, rerun audit on the same --root to restore`);
    const kills = new Map(cases.map((c) => [c.id, []]));
    const runtimeByCase = new Map(cases.map((c) => [c.id, []]));
    const mutantRows = [];
    for (const m of mutants) {
      const f = implFiles.find((x) => x.path === m.file);
      const mutated = applyMutation(f.source, m);
      if (mutated === f.source) throw new Error(`mutation ${m.id} is a no-op`);
      const entry = entries.find((e) => e.path === f.file);
      assertUnchanged(entry);
      entry.mutatedHash = sha256(Buffer.from(mutated));
      saveManifest(dir, entries);
      let attr;
      try {
        writeFileSync(f.file, mutated);
        const r = runVitest([]);
        if (r.signal === 'SIGKILL' || r.error?.code === 'ETIMEDOUT') attr = { mutantState: 'caught, unattributed', byCase: new Map(), runtimeFailures: [] };
        else if (r.reportInvalid) attr = { mutantState: 'invalid', byCase: new Map(), runtimeFailures: [] };
        else {
          attr = attribute(r.json, cases, root);
          if ((r.status !== 0 || r.signal || r.error?.code === 'ETIMEDOUT') && attr.mutantState === 'survived' && attr.runtimeFailures.length === 0) attr.mutantState = 'caught, unattributed';
        }
      } finally {
        const restored = restoreEntry(entry);
        saveManifest(dir, entries);
        if (!restored) throw new Error('concurrent edit detected');
      }
      const killedBy = [...attr.byCase].filter(([, v]) => v.status === 'killed').map(([id]) => id);
      for (const id of killedBy) kills.get(id).push(m.id);
      for (const id of attr.runtimeFailures) runtimeByCase.get(id)?.push(m.id);
      const state = attr.mutantState === 'survived' && attr.runtimeFailures.length ? `survived (runtime failure in ${attr.runtimeFailures.length} cases)` : attr.mutantState;
      mutantRows.push({ id: m.id, file: m.file, line: f.source.slice(0, m.at).split('\n').length, note: m.note, state, killedBy, runtimeFailures: attr.runtimeFailures });
    }
    const valid = (row) => row.state !== 'invalid' && row.state !== 'caught, unattributed';
    const sampled = mutantRows.filter(valid).length;
    const validByImpl = new Map();
    for (const row of mutantRows) if (valid(row)) validByImpl.set(row.file, (validByImpl.get(row.file) ?? 0) + 1);
    const verdicts = cases.map((c) => {
      const base = baseAttr.byCase.get(c.id);
      const k = kills.get(c.id);
      const runtime = runtimeByCase.get(c.id);
      const impl = implBySpec.get(join(root, c.spec));
      const implRel = impl ? relative(root, impl).split(sep).join('/') : null;
      const sample = implRel ? `${validByImpl.get(implRel) ?? 0} in ${basename(implRel)}` : '0 in mapped impl';
      let result = base?.status === 'missing' ? 'not matched in reporter output' : base?.status === 'skipped' ? 'skipped at baseline' : k.length ? `killed [${k.join(', ')}]` : `killed none of ${sampled} sampled mutants (${sample})`;
      if (base?.status !== 'missing' && !k.length && runtime.length) result += `; runtime failure on [${runtime.join(', ')}]`;
      let deletion = base?.status === 'missing' ? 'not verified: not matched in reporter output' : k.length || base?.status === 'skipped' ? 'keep' : null;
      if (!k.length && base?.status !== 'skipped' && base?.status !== 'missing') {
        if (mutants.length === 0) deletion = 'not verified: no mutants planned';
        else if (!impl && specs.some((s) => relative(root, s).split(sep).join('/') === c.spec)) deletion = 'not verified: no impl mapped';
        else if (implRel && (validByImpl.get(implRel) ?? 0) === 0) deletion = `not verified: no valid mutants on ${basename(implRel)}`;
        else if (runtime.length) deletion = `not verified: runtime failure on [${runtime.join(', ')}]`;
      }
      return { id: c.id, spec: c.spec, name: c.name, line: c.line, result, deletion };
    });

    const bySpec = new Map();
    for (const v of verdicts) if (v.deletion === null) {
      if (cases.find((c) => c.id === v.id).duplicate) { v.deletion = 'not verified: duplicate identity'; continue; }
      if (!bySpec.has(v.spec)) bySpec.set(v.spec, []);
      bySpec.get(v.spec).push(v);
    }
    for (const [spec, vs] of bySpec) {
      const specAbs = join(root, spec);
      const specEntry = entries.find((e) => e.path === specAbs);
      if (!specEntry) {
        for (const v of vs) v.deletion = 'not verified: spec not in audited set';
        continue;
      }
      const src = readFileSync(specAbs, 'utf8');
      const spans = new Map();
      for (const v of vs) {
        const span = findCallSpan(src, v.line);
        if (span) spans.set(v.id, span); else v.deletion = 'not verified: unsupported call shape';
      }
      const spanGroups = new Map();
      for (const c of cases.filter((candidate) => candidate.spec === spec)) {
        const span = findCallSpan(src, c.line);
        if (!span) continue;
        const key = `${span.start}:${span.end}`;
        if (!spanGroups.has(key)) spanGroups.set(key, { span, ids: [] });
        spanGroups.get(key).ids.push(c.id);
      }
      for (const group of spanGroups.values()) {
        const groupCases = group.ids.map((id) => cases.find((c) => c.id === id)).filter(Boolean);
        const call = src.slice(group.span.start, group.span.end);
        if (new Set(groupCases.map((c) => c.name)).size > 1 && !/^(?:it|test)\.each/.test(call.trimStart())) {
          for (const id of group.ids) {
            const target = verdicts.find((candidate) => candidate.id === id);
            if (target?.deletion === null) target.deletion = 'not verified: shared call line';
          }
        }
      }
      for (const v of vs) {
        const span = spans.get(v.id);
        if (!span) continue;
        const group = spanGroups.get(`${span.start}:${span.end}`);
        if (group.ids.some((id) => !vs.some((candidate) => candidate.id === id))) {
          for (const id of group.ids) {
            const target = verdicts.find((candidate) => candidate.id === id);
            if (target) target.deletion = 'not verified: shared each() call';
          }
        }
      }
      const describePaths = (c) => c.name.split(' > ').slice(0, -1).map((_, i, parts) => parts.slice(0, i + 1).join(' > '));
      const candidates = cases.filter((c) => c.spec === spec);
      const paths = new Map();
      for (const c of candidates) {
        for (const path of describePaths(c)) {
          if (!paths.has(path)) paths.set(path, []);
          paths.get(path).push(c);
        }
      }
      for (const [path, pathCases] of paths) {
        if (pathCases.every((c) => vs.some((v) => v.id === c.id && v.deletion === null))) {
          for (const c of pathCases) verdicts.find((v) => v.id === c.id).deletion = `not verified: every test in describe "${path}" is zero-kill; delete the describe block and rerun`;
        }
      }
      const eligibleGroups = [...spanGroups.values()].filter((group) => group.ids.every((id) => vs.some((v) => v.id === id && v.deletion === null)));
      const verify = (groups) => {
        const unique = [...new Map(groups.map((group) => [`${group.span.start}:${group.span.end}`, group.span])).values()];
        const trimmed = removeSpans(src, unique);
        const removedIds = groups.flatMap((group) => group.ids);
        const allGone = removedIds.length === cases.filter((c) => c.spec === spec).length;
        assertUnchanged(specEntry);
        specEntry.mutatedHash = sha256(Buffer.from(trimmed));
        saveManifest(dir, entries);
        try {
          writeFileSync(specAbs, trimmed);
          const r = runVitest(allGone ? ['--exclude', spec] : []);
          if (r.signal === 'SIGKILL' || r.error?.code === 'ETIMEDOUT') return `not removable: timed out after ${timeoutMs} ms`;
          if (r.reportInvalid) return `not removable: no reporter output (vitest exit ${r.status})`;
          const failed = r.json.numFailedTests ?? 0;
          if ((r.json.numFailedTestSuites ?? 0) > 0 && failed === 0 || (r.status !== 0 && failed === 0)) return 'not removable: suite-level failure (likely a describe left with no tests)';
          if (r.status !== 0 || failed > 0) {
            const named = (r.json.testResults ?? []).flatMap((f) => f.assertionResults ?? []).find((a) => a.status === 'failed');
            return `not removable: ${named ? reporterName(named) : `vitest exit ${r.status}, ${failed} failed`}`;
          }
          const w = firstNewWarning(baseWarn, fingerprints(r.stderr));
          if (w) return `not removable: ${w}`;
          return null;
        } finally {
          const restored = restoreEntry(specEntry);
          saveManifest(dir, entries);
          if (!restored) throw new Error('concurrent edit detected');
        }
      };
      const bisect = (groups) => {
        const bad = verify(groups);
        if (!bad) {
          for (const group of groups) for (const id of group.ids) {
            verdicts.find((v) => v.id === id).deletion = 'removable: suite green, no new warnings';
          }
          return true;
        }
        if (groups.length === 1) { for (const id of groups[0].ids) verdicts.find((v) => v.id === id).deletion = bad; return false; }
        const allIds = groups.flatMap((group) => group.ids);
        const mid = Math.ceil(groups.length / 2);
        const leftRemovable = bisect(groups.slice(0, mid));
        const rightRemovable = bisect(groups.slice(mid));
        const removable = leftRemovable && rightRemovable;
        if (removable) for (const id of allIds) {
          const v = verdicts.find((candidate) => candidate.id === id);
          if (!v.deletion.includes('; not together with [')) v.deletion += `; not together with [${allIds.filter((other) => other !== id).join(', ')}]: ${bad}`;
        }
        return removable;
      };
      if (eligibleGroups.length) bisect(eligibleGroups);
    }

    const changed = entries.filter((entry) => {
      try { return sha256(readFileSync(entry.path)) !== entry.originalHash; } catch { return true; }
    });
    if (changed.length) {
      const err = new Error(`concurrent edit: ${changed.map((entry) => entry.path).join(', ')} changed during the audit`);
      err.code = 3;
      throw err;
    }
    return { root, feature, baseline: 'green', cases, mutants: mutantRows, verdicts, unmapped, runs, ms: Date.now() - t0, touched: entries.map((e) => e.path), manifest: dir };
    } finally {
      for (const e of entries) restoreEntry(e);
      if (skippedRestores.size) {
        const kept = [...skippedRestores.values()];
        saveManifest(dir, kept);
        const paths = kept.map((e) => e.path);
        const err = new Error(`concurrent edit: ${paths.join(', ')} changed during the audit; mutated bytes not restored; manifest kept at ${dir}`);
        err.code = 3;
        throw err;
      }
      clearManifest(dir);
    }
  } finally {
    if (ownsLock) rmSync(lock, { force: true });
  }
}

export function renderReport(r) {
  const cell = (value) => String(value).replaceAll('|', '\\|');
  const lines = [];
  lines.push(`Files written during this run (all restored): ${r.touched.join(', ')}`);
  lines.push('', `# test-teeth audit: ${r.feature} in ${r.root}`, '');
  lines.push('## Verdicts', '', '| Test case | Mutation result | Deletion verification |', '| --- | --- | --- |');
  for (const v of r.verdicts) lines.push(`| ${cell(`${v.spec} > ${v.name}`)} | ${cell(v.result)} | ${cell(v.deletion)} |`);
  lines.push('', '## Mutants', '', '| Id | File:line | Note | State | Killed by | Runtime failures |', '| --- | --- | --- | --- | --- | --- |');
  for (const m of r.mutants) lines.push(`| ${cell(m.id)} | ${cell(`${m.file}:${m.line}`)} | ${cell(m.note)} | ${cell(m.state)} | ${cell(m.killedBy.join(', '))} | ${cell(m.runtimeFailures.join(', '))} |`);
  const count = (s) => r.mutants.filter((m) => m.state === s || m.state.startsWith(`${s} (`)).length;
  lines.push('', '## Run', '', `- mutants: ${r.mutants.length} (killed ${count('killed')}, survived ${count('survived')}, invalid ${count('invalid')}, caught unattributed ${count('caught, unattributed')})`,
    `- vitest runs: ${r.runs}`, `- wall time: ${(r.ms / 1000).toFixed(1)} s`, `- files sampled: ${[...new Set(r.mutants.map((m) => m.file))].join(', ')}`, `- no impl mapped: ${r.unmapped.length ? r.unmapped.join(', ') : 'none'}`, `- manifest dir: ${r.manifest}`);
  return lines.join('\n') + '\n';
}

function flag(argv, name) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  if (v === undefined || String(v).startsWith('--')) throw new Error(`--${name} needs a value`);
  return v;
}

export async function main(argv) {
  if (argv[0] !== 'audit') { process.stderr.write('usage: test-teeth.mjs audit --root R --feature F [--max-mutations N] [--mutations JSON] [--report PATH] [--timeout-ms N] [--list-only] [--vitest-bin PATH]\n'); return 3; }
  try {
    const rootArg = flag(argv, 'root');
    if (!rootArg) throw new Error('--root is required');
    const root = realpathSync(rootArg);
    const feature = flag(argv, 'feature');
    if (!feature) throw new Error('--feature is required');
    const maxMutations = Number(flag(argv, 'max-mutations') ?? 30);
    if (!Number.isInteger(maxMutations) || maxMutations <= 0) throw new Error('--max-mutations must be a positive integer');
    const timeoutMs = Number(flag(argv, 'timeout-ms') ?? 120000);
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('--timeout-ms must be a positive integer');
    const mutations = flag(argv, 'mutations');
    const manual = mutations ? JSON.parse(readFileSync(mutations, 'utf8')) : [];
    const vitestBin = flag(argv, 'vitest-bin');
    const report = flag(argv, 'report');
    if (argv.includes('--list-only')) {
      if (manual.length > maxMutations) process.stderr.write(`--mutations has ${manual.length} entries, more than --max-mutations ${maxMutations}; all ${manual.length} run\n`);
      const featureAbs = resolve(root, feature);
      if (!inside(root, realpathSync(featureAbs))) throw new Error('--feature must be inside --root');
      const specs = walk(featureAbs, (p) => /\.(test|spec)\.ts$/.test(p), [], root);
      const files = [...new Set(specs.map((spec) => mapImpl(spec)).filter(Boolean))].map((file) => ({ path: relative(root, file).split(sep).join('/'), file, source: readFileSync(file, 'utf8') }));
      for (const m of planAll(files, { maxMutations, manual })) process.stdout.write(`${m.id} ${m.file} ${m.kind} ${m.note}\n`);
      return 0;
    }
    const result = await audit({ root, feature, maxMutations, manual, timeoutMs, vitestBin, log: (s) => process.stderr.write(s + '\n') });
    const md = renderReport(result);
    if (report) {
      try {
        mkdirSync(dirname(report), { recursive: true });
        writeFileSync(report, md);
        process.stderr.write(`report written to ${report}\n`);
      } catch (e) {
        process.stdout.write(md);
        throw e;
      }
    } else process.stdout.write(md);
    return 0;
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return e.code === 130 ? 130 : e.code === 2 ? 2 : 3;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
