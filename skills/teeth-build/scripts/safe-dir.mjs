import { lstatSync, mkdirSync } from 'node:fs';

const fail = (message) => Object.assign(new Error(message), { code: 3 });

export function assertSafeDir(path, label = 'state directory') {
  const unsafe = (reason) => fail(`unsafe ${label} ${path}: ${reason}`);
  const st = lstatSync(path);
  if (st.isSymbolicLink()) throw unsafe('is a symlink');
  if (!st.isDirectory()) throw unsafe('is not a directory');
  if (typeof process.getuid !== 'function') throw unsafe('ownership cannot be checked on this platform (POSIX only)');
  if (st.uid !== process.getuid()) throw unsafe('is not owned by the current user');
  if ((st.mode & 0o077) !== 0) throw unsafe(`permissions are ${(st.mode & 0o777).toString(8).padStart(3, '0')}, not owner-only`);
}

export function ensureSafeDir(path, label) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertSafeDir(path, label);
}
