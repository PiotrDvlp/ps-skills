import { existsSync } from 'node:fs';

if (existsSync('src/greet.ts')) {
  console.error('typecheck crashed');
  process.exit(2);
}
