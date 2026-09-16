/**
 * Convert element-hiding filters into injectable CSS.
 *
 * Two payloads, because they have very different reach:
 *
 *   generic  (~41k selectors, ~700KB) applies to every site. Emitted as a plain
 *            stylesheet and injected natively via the manifest at document_start,
 *            so it lands before first paint with no JS and no flash.
 *
 *   specific (~38k rules over ~35k domains, ~2.2MB) cannot ship to every page,
 *            and 35k content-script registrations is not viable either. Hashed
 *            into buckets so a page fetches only its own ~9KB slice.
 *
 * The async fetch for the specific payload is acceptable: the ad containers it
 * targets are rendered by page JS well after load, so there is nothing to flash.
 *
 * Procedural filters (#?#, :has-text, :upward) need a runtime evaluator and are
 * skipped — counted and reported so the gap stays visible.
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { LISTS } from './lists.config.ts';
import { BUCKETS, bucketOf, type CosmeticBucket } from '../src/shared/bucket.ts';

const LISTS_DIR = new URL('../lists/', import.meta.url);
const OUT_DIR = new URL('../extension/cosmetic/', import.meta.url);

const RE = /^(.*?)(#@?\$?\??#)(.+)$/;

/** Selectors per CSS rule. See the note where generic.css is written. */
const CHUNK = 500;

/**
 * Emit `html:not([data-winnower-off]) :is(a, b, c) {display:none!important}`.
 *
 * Two things this buys beyond chunking:
 *
 * 1. A kill switch. Manifest-injected CSS cannot be removed by a content
 *    script, so without a guard like this the per-site allowlist could not
 *    restore a site that cosmetic filtering had broken — which is the main
 *    reason to have an allowlist at all. Setting the attribute on <html>
 *    disables every rule at once, instantly.
 *
 * 2. :is() has FORGIVING selector parsing. A single invalid selector in a
 *    plain comma list invalidates the entire rule; inside :is() it is ignored
 *    and its siblings still apply. That is a real safety gain given ~41k
 *    selectors from upstream lists we do not control.
 *
 * :is() takes the specificity of its most specific argument, and the html
 * prefix adds a little more. With !important that still wins in practice.
 */
function chunkToCss(selectors: string[]): string {
  const parts: string[] = [];
  for (let i = 0; i < selectors.length; i += CHUNK) {
    const group = selectors.slice(i, i + CHUNK).join(',\n');
    parts.push(`html:not([data-winnower-off]) :is(\n${group}\n){display:none!important}`);
  }
  return parts.join('\n') + '\n';
}

/**
 * CSS.escape-free sanity check. A malformed selector poisons every rule after
 * it in the same stylesheet, so anything suspicious is dropped rather than
 * risking the whole bundle.
 */
function selectorLooksSafe(sel: string): boolean {
  if (sel.length > 400) return false;
  if (sel.includes('{') || sel.includes('}')) return false;
  if (/:(?:has-text|matches-css|upward|watch-attr|xpath|min-text-length|others|matches-path)\b/i.test(sel)) return false;
  if (sel.startsWith('+js(')) return false;
  return true;
}

async function main() {
  const generic = new Set<string>();
  const specific = new Map<string, Set<string>>(); // domain -> selectors
  const genericExc = new Set<string>();
  const specificExc = new Map<string, Set<string>>(); // domain -> selectors
  let procedural = 0, unsafe = 0, scriptlets = 0;

  for (const l of LISTS) {
    const txt = await readFile(new URL(`${l.name}.txt`, LISTS_DIR), 'utf8');
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('!') || t.startsWith('[')) continue;
      const m = RE.exec(t);
      if (!m) continue;
      const [, dom, sep, sel] = m;

      if (sel.startsWith('+js(')) { scriptlets++; continue; }
      if (sep.includes('?') || sep.includes('$')) { procedural++; continue; }
      if (!selectorLooksSafe(sel)) { unsafe++; continue; }

      const isException = sep.includes('@');
      const targets = dom ? dom.split(',').filter((d) => d && !d.startsWith('~')) : null;

      if (!targets) {
        (isException ? genericExc : generic).add(sel);
        continue;
      }
      for (const d of targets) {
        const bag = isException ? specificExc : specific;
        let set = bag.get(d);
        if (!set) bag.set(d, (set = new Set()));
        set.add(sel);
      }
    }
  }

  // Apply exceptions: a #@# rule un-hides a selector that a ## rule would hide.
  for (const s of genericExc) generic.delete(s);
  for (const [d, sels] of specificExc) {
    const own = specific.get(d);
    if (own) for (const s of sels) own.delete(s);
  }

  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(new URL('domains/', OUT_DIR), { recursive: true });

  // --- generic stylesheet -------------------------------------------------
  const genericList = [...generic];
  const css = chunkToCss(genericList);
  await writeFile(new URL('generic.css', OUT_DIR), css, 'utf8');

  // --- bucketed domain payloads -------------------------------------------
  const buckets: CosmeticBucket[] = Array.from({ length: BUCKETS }, () => ({}));
  let specCount = 0;
  for (const [d, sels] of specific) {
    if (sels.size === 0) continue;
    // Strip a leading www. so the lookup key matches what the page reports.
    // MERGE rather than assign: both "youtube.com" and "www.youtube.com" appear
    // in upstream lists and collapse to the same key here. Assigning let the
    // second overwrite the first, which silently cost youtube.com 16 of its 19
    // selectors — including every ad-container rule.
    const key = d.replace(/^www\./, '');
    const b = buckets[bucketOf(key)];
    if (b[key]) {
      const merged = new Set(b[key]);
      for (const s of sels) merged.add(s);
      b[key] = [...merged];
    } else {
      b[key] = [...sels];
    }
  }
  for (const b of buckets) for (const k of Object.keys(b)) specCount += b[k].length;
  let written = 0, maxKb = 0;
  for (let i = 0; i < BUCKETS; i++) {
    const body = JSON.stringify(buckets[i]);
    await writeFile(new URL(`domains/${i}.json`, OUT_DIR), body, 'utf8');
    written += Object.keys(buckets[i]).length;
    maxKb = Math.max(maxKb, body.length / 1024);
  }

  const kb = (n: number) => Math.round(n / 1024).toLocaleString();
  console.log('');
  // Count rules in the emitted string, not from genericList.length / CHUNK.
  // The computed form printed "83 rules" while the file still held one giant
  // rule, because chunkToCss was not actually wired in. A log line that
  // restates intent cannot detect that intent was not carried out.
  const emittedRules = (css.match(/\{display:none!important\}/g) ?? []).length;
  console.log(`  generic selectors     ${genericList.length.toLocaleString().padStart(8)}   ${kb(css.length).padStart(5)} KB  in ${emittedRules} emitted rules`);
  console.log(`  domain selectors      ${specCount.toLocaleString().padStart(8)}`);
  console.log(`  domains covered       ${written.toLocaleString().padStart(8)}   across ${BUCKETS} buckets`);
  console.log(`  largest bucket                    ${Math.round(maxKb).toString().padStart(5)} KB  (per-page fetch)`);
  console.log('');
  console.log(`  exceptions applied    ${(genericExc.size + [...specificExc.values()].reduce((a, s) => a + s.size, 0)).toLocaleString().padStart(8)}`);
  console.log(`  procedural skipped    ${procedural.toLocaleString().padStart(8)}   (need a runtime evaluator)`);
  console.log(`  unsafe skipped        ${unsafe.toLocaleString().padStart(8)}`);
  console.log('');

  if (genericList.length === 0 || specCount === 0) {
    console.error('! produced an empty cosmetic payload');
    process.exitCode = 1;
    return;
  }
  console.log(`\u2713 cosmetic: ${genericList.length.toLocaleString()} generic + ${specCount.toLocaleString()} domain-specific selectors`);
}

await main();
