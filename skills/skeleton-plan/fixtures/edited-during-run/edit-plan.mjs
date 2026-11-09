import { readFileSync, writeFileSync } from 'node:fs';

const plan = process.argv[2];
writeFileSync(plan, readFileSync(plan, 'utf8').replace(/^# Greeting$/m, '# Greeting, edited'));
