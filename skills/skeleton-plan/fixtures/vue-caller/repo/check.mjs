import { existsSync } from 'node:fs';

if (existsSync('src/greet.ts')) {
  console.log('src/components/Card.vue(3,14): error TS2554: Expected 1 arguments, but got 0.');
  process.exit(2);
}
