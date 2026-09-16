import { readFile } from 'node:fs/promises';
import { LISTS } from './lists.config.ts';

const shapes = new Map<string, number>();
let total = 0, exceptions = 0;
const samples: string[] = [];

for (const l of LISTS) {
  const txt = await readFile(new URL(`../lists/${l.name}.txt`, import.meta.url), 'utf8');
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('!') || t.startsWith('[')) continue;
    if (t.includes('##') || t.includes('#@#')) continue; // cosmetic
    const dollar = t.lastIndexOf('$');
    if (dollar === -1) continue;
    const opts = t.slice(dollar + 1).split(',');
    if (!opts.includes('popup')) continue;

    total += 1;
    if (t.startsWith('@@')) exceptions += 1;

    // What other options ride along with $popup?
    for (const o of opts) {
      const key = o.split('=')[0];
      shapes.set(key, (shapes.get(key) ?? 0) + 1);
    }
    if (samples.length < 10) samples.push(t.slice(0, 96));
  }
}

console.log('total $popup rules :', total.toLocaleString());
console.log('  exceptions (@@)  :', exceptions.toLocaleString());
console.log('');
console.log('options appearing alongside $popup:');
for (const [k, v] of [...shapes].sort((a, b) => b[1] - a[1])) {
  console.log('  ' + String(v).padStart(5), k);
}
console.log('');
console.log('samples:');
for (const s of samples) console.log('  ' + s);
