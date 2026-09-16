import { readFile } from 'node:fs/promises';
import { LISTS } from './lists.config.ts';

// domain(s) ## selector      -> hide
// domain(s) #@# selector     -> exception (un-hide)
// domain(s) #?# / #$# ...    -> procedural / style injection
const RE = /^(.*?)(#@?\$?\??#)(.+)$/;

const generic = new Set<string>();
const domains = new Map<string, Set<string>>();
let specific = 0, exceptions = 0, procedural = 0, scriptlets = 0;

for (const l of LISTS) {
  const txt = await readFile(new URL(`../lists/${l.name}.txt`, import.meta.url), 'utf8');
  for (const line of txt.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('!') || t.startsWith('[')) continue;
    const m = RE.exec(t);
    if (!m) continue;
    const [, dom, sep, sel] = m;
    if (sel.startsWith('+js(')) { scriptlets++; continue; }
    if (sep.includes('@')) { exceptions++; continue; }
    if (sep.includes('?') || sep.includes('$')) { procedural++; continue; }
    if (!dom) { generic.add(sel); continue; }
    specific++;
    for (const d of dom.split(',')) {
      if (!d || d.startsWith('~')) continue;
      let bag = domains.get(d);
      if (!bag) domains.set(d, (bag = new Set()));
      bag.add(sel);
    }
  }
}

const k = (n: number) => Math.round(n / 1024).toLocaleString() + ' KB';
console.log('generic selectors (everywhere) :', generic.size.toLocaleString());
console.log('domain-specific rules          :', specific.toLocaleString());
console.log('  distinct domains             :', domains.size.toLocaleString());
console.log('exceptions (#@#)               :', exceptions.toLocaleString());
console.log('procedural (#?# / #$#)         :', procedural.toLocaleString());
console.log('scriptlets (not cosmetic)      :', scriptlets.toLocaleString());
console.log('');
console.log('generic CSS payload            :', k([...generic].join(',').length));
const idx: Record<string, string[]> = {};
for (const [d, s] of domains) idx[d] = [...s];
console.log('domain-specific payload        :', k(JSON.stringify(idx).length));
console.log('');
console.log('top domains by selector count:');
for (const [d, s] of [...domains].sort((a, b) => b[1].size - a[1].size).slice(0, 8)) {
  console.log('  ' + String(s.size).padStart(5), d);
}
console.log('');
const yt = domains.get('youtube.com') ?? domains.get('www.youtube.com');
console.log('youtube.com selectors          :', yt ? yt.size : 0);
