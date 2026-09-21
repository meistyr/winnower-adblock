/**
 * Compile the filter lists' scriptlet rules (`domains##+js(...)`) into files
 * the worker registers, one per list and scriptlet.
 *
 * convert-cosmetic.ts skips these lines because they are scripts, not
 * selectors. They are how the lists fix individual sites, and uBlock Origin and
 * AdGuard maintain them, so winnower takes them as they come rather than
 * writing its own for each site.
 *
 * Size is the constraint. scriptlets.invoke() returns a self-contained copy of
 * the scriptlet's code for every rule: YouTube's 18 rules come to 334 KB, and
 * the lists' ~3,000 would come to about 100 MB. So each file carries one
 * scriptlet's code once, with a table of the hosts it runs on and the
 * arguments for each, and a page loads only the files whose hosts match it.
 * The calls are made the way invoke() makes them, so a rule behaves the same
 * either way.
 *
 * Left out, and counted below (tracked in issue #8):
 *   - hosts ending in `.*`, and hosts written as a regular expression. Chrome's
 *     match patterns cannot express either.
 *   - rules the library's converter rejects, which includes every trusted-* rule.
 *   - hosts with a hand-made group in scriptlet-rules.ts. Those sites keep that
 *     group alone.
 *
 * Lists that are off by default are compiled too. Whether a file runs follows
 * the list's switch, which the worker applies when it registers the scripts.
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { scriptlets, SCRIPTLETS_VERSION } from '@adguard/scriptlets';
import { convertUboToAdg } from '@adguard/scriptlets/converters';
import { isValidScriptletRule } from '@adguard/scriptlets/validators';
import { LISTS } from './lists.config.ts';
import { SCRIPTLET_GROUPS } from './scriptlet-rules.ts';
import type { ListScriptlet } from '../src/shared/catalogue.ts';

const LISTS_DIR = new URL('../lists/', import.meta.url);
const EXT_DIR = new URL('../extension/', import.meta.url);
const OUT_DIR = new URL('scriptlets/lists/', EXT_DIR);

const UBO_RULE = /^(.*?)(#@?#)\+js\((.*)\)$/;
const ADG_RULE = /^(.*?)(#@?%#)\/\/scriptlet\((.*)\)$/;

/**
 * The arguments of an AdGuard scriptlet call: `'a', 'b\'c'` gives ["a", "b'c"].
 *
 * Only the enclosing quote is escaped. Every other backslash is part of the
 * value, which matters for regular expressions: the converter turns uBlock's
 * `/[a-z]\d+/` into `'/[a-z]\d+/'`, and the `\d` has to arrive intact.
 */
function parseArgs(s: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  const spaces = () => {
    while (s[i] === ' ') i += 1;
  };
  spaces();
  if (i >= s.length) return out;
  for (;;) {
    const quote = s[i];
    if (quote !== "'" && quote !== '"') return null;
    i += 1;
    let value = '';
    for (;;) {
      if (i >= s.length) return null;
      if (s[i] === '\\' && s[i + 1] === quote) {
        value += quote;
        i += 2;
      } else if (s[i] === quote) {
        i += 1;
        break;
      } else {
        value += s[i];
        i += 1;
      }
    }
    out.push(value);
    spaces();
    if (i >= s.length) return out;
    if (s[i] !== ',') return null;
    i += 1;
    spaces();
  }
}

/**
 * A domain entry as a host a match pattern can name, or null.
 *
 * Strict on purpose. A regular-expression entry can contain commas, so
 * splitting the domain list leaves fragments of it behind, and a lenient check
 * would turn one of those into a host.
 */
function toHost(entry: string): string | null {
  let h = entry.trim().toLowerCase();
  if (!/^[\x21-\x7e]+$/.test(h)) {
    try {
      h = new URL(`http://${h}/`).hostname;
    } catch {
      return null;
    }
  }
  if (/^\d+(\.\d+){3}$/.test(h)) return null;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h) ? h : null;
}

/** Hosts that have a hand-made group, from matches like `*://*.youtube.com/*`. */
const OWN_HOSTS = SCRIPTLET_GROUPS.flatMap((g) =>
  g.matches.map((m) => /^\*:\/\/\*\.([^/]+)\/\*$/.exec(m)?.[1]).filter((h): h is string => !!h),
);
const isOwnHost = (h: string) => OWN_HOSTS.some((own) => h === own || h.endsWith('.' + own));

interface Group {
  list: string;
  name: string;
  /** [args] or [args, hosts it must not run on]. */
  rules: Array<[string[]] | [string[], string[]]>;
  ruleIndex: Map<string, number>;
  hosts: Map<string, Set<number>>;
}

/** Per list state, so the counts can be compared with what is on by default. */
interface Counts {
  rules: number;
  compiled: number;
  trusted: number;
  rejected: number;
  wildcardOnly: number;
  ownOnly: number;
  regexOnly: number;
  badHostOnly: number;
  exceptions: number;
}
const emptyCounts = (): Counts => ({
  rules: 0, compiled: 0, trusted: 0, rejected: 0, wildcardOnly: 0, ownOnly: 0, regexOnly: 0, badHostOnly: 0, exceptions: 0,
});

/**
 * The runtime part of every file. It finds this page's calls by walking the
 * hostname up through its parent domains, because a rule for example.com also
 * applies on www.example.com. Exceptions are gathered the same way first.
 *
 * Runs at document_start in the page's own world, before any page script, so
 * the built-ins it uses are still the real ones.
 */
const RUNTIME = `
  const has = Object.prototype.hasOwnProperty;
  const host = location.hostname;
  const chain = [];
  for (let h = host; ; ) {
    chain.push(h);
    const dot = h.indexOf('.');
    if (dot < 0) break;
    h = h.slice(dot + 1);
  }
  const except = new Set();
  for (const h of chain) if (has.call(X, h)) for (const k of X[h]) except.add(k);
  if (except.has('*')) return;
  const done = new Set();
  for (const h of chain) {
    if (!has.call(H, h)) continue;
    for (const i of H[h]) {
      if (done.has(i)) continue;
      done.add(i);
      const [args, not] = R[i];
      if (except.has(JSON.stringify(args))) continue;
      if (not && not.some((n) => host === n || host.endsWith('.' + n))) continue;
      try { run({ name: NAME, args, engine: 'extension', version: VERSION, verbose: false }, args); } catch (e) { /* one bad call must not stop the rest */ }
    }
  }
`;

async function main() {
  const groups = new Map<string, Group>();
  /**
   * host -> exceptions found for it, each `${name}\t${JSON args}` or `*` for
   * every scriptlet, with the list it came from.
   *
   * An exception belongs to its list, and should count only while that list is
   * on. The files cannot know which lists are on, so an exception is written
   * into its own list's files, whose running already means its list is on, and
   * into other lists' files only when its list is on by default. Otherwise an
   * exception in a list nobody switched on would turn off another list's rules.
   */
  const exceptions = new Map<string, Array<{ list: string; key: string }>>();
  const onByDefault = new Set(LISTS.filter((l) => l.enabled).map((l) => l.name));
  const counts = { on: emptyCounts(), off: emptyCounts() };

  for (const list of LISTS) {
    const c = list.enabled ? counts.on : counts.off;
    const text = await readFile(new URL(`${list.name}.txt`, LISTS_DIR), 'utf8');

    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('!')) continue;
      const ubo = UBO_RULE.exec(line);
      if (!ubo) continue;
      const isException = ubo[2] === '#@#';
      if (isException) c.exceptions += 1;
      else c.rules += 1;

      let converted: string[] = [];
      try {
        converted = convertUboToAdg(line);
      } catch {
        converted = [];
      }
      if (!converted.length || !converted.every((r) => isValidScriptletRule(r))) {
        if (!isException) {
          if (ubo[3].trim().startsWith('trusted-')) c.trusted += 1;
          else c.rejected += 1;
        }
        continue;
      }

      let compiledHere = false;
      let wild = 0, own = 0, regex = 0, bad = 0;
      for (const rule of converted) {
        const adg = ADG_RULE.exec(rule);
        const call = adg ? parseArgs(adg[3]) : null;
        if (!adg || !call) {
          bad += 1;
          continue;
        }
        const [name, ...args] = call;

        const include: string[] = [];
        const not: string[] = [];
        for (const entry of adg[1].split(',').map((d) => d.trim()).filter(Boolean)) {
          if (entry.startsWith('~')) {
            const h = toHost(entry.slice(1));
            if (h) not.push(h);
          } else if (entry.startsWith('/')) regex += 1;
          else if (entry.endsWith('.*')) wild += 1;
          else {
            const h = toHost(entry);
            if (!h) bad += 1;
            else if (isOwnHost(h)) own += 1;
            else include.push(h);
          }
        }

        if (isException) {
          const key = name === undefined ? '*' : `${name}\t${JSON.stringify(args)}`;
          for (const h of include) {
            if (!exceptions.has(h)) exceptions.set(h, []);
            exceptions.get(h)!.push({ list: list.name, key });
          }
          continue;
        }
        if (!include.length || name === undefined) continue;

        const id = `${list.name}\t${name}`;
        let g = groups.get(id);
        if (!g) {
          g = { list: list.name, name, rules: [], ruleIndex: new Map(), hosts: new Map() };
          groups.set(id, g);
        }
        const ruleKey = JSON.stringify([args, not]);
        let idx = g.ruleIndex.get(ruleKey);
        if (idx === undefined) {
          idx = g.rules.length;
          g.rules.push(not.length ? [args, not] : [args]);
          g.ruleIndex.set(ruleKey, idx);
        }
        for (const h of new Set(include)) {
          if (!g.hosts.has(h)) g.hosts.set(h, new Set());
          g.hosts.get(h)!.add(idx);
        }
        compiledHere = true;
      }

      if (isException) continue;
      if (compiledHere) c.compiled += 1;
      else if (wild) c.wildcardOnly += 1;
      else if (own) c.ownOnly += 1;
      else if (regex) c.regexOnly += 1;
      else c.badHostOnly += 1;
    }
  }

  await rm(OUT_DIR, { recursive: true, force: true });
  const index: ListScriptlet[] = [];
  let bytes = 0;
  let largest = { file: '', kb: 0 };
  // Names the converter accepts but the library has no code for. Left out and
  // counted like the rest, rather than failing the build over one library gap.
  const noCode: string[] = [];

  for (const g of groups.values()) {
    const fn = scriptlets.getScriptletFunction(g.name);
    if (typeof fn !== 'function') {
      noCode.push(`${g.list}/${g.name} (${g.hosts.size} hosts)`);
      continue;
    }

    const hosts = [...g.hosts.keys()].sort();
    const H = Object.fromEntries(hosts.map((h) => [h, [...g.hosts.get(h)!]]));
    const X: Record<string, string[]> = {};
    for (const [h, found] of exceptions) {
      const mine = found
        .filter((x) => x.list === g.list || onByDefault.has(x.list))
        .map((x) => x.key)
        .filter((k) => k === '*' || k.startsWith(`${g.name}\t`))
        .map((k) => (k === '*' ? k : k.slice(g.name.length + 1)));
      if (mine.length) X[h] = [...new Set(mine)];
    }

    const body = [
      `/* winnower, generated. Do not edit.`,
      ` * list: ${g.list}, scriptlet: ${g.name}, ${g.rules.length} rules on ${hosts.length} hosts`,
      ` * @adguard/scriptlets ${SCRIPTLETS_VERSION} (GPL-3.0)`,
      ` * regenerate: npm run list-scriptlets`,
      ` */`,
      `"use strict";`,
      `(() => {`,
      `  const run = ${String(fn)};`,
      `  const NAME = ${JSON.stringify(g.name)};`,
      `  const VERSION = ${JSON.stringify(SCRIPTLETS_VERSION)};`,
      `  const R = ${JSON.stringify(g.rules)};`,
      `  const H = ${JSON.stringify(H)};`,
      `  const X = ${JSON.stringify(X)};`,
      RUNTIME,
      `})();`,
      ``,
    ].join('\n');

    const file = `scriptlets/lists/${g.list}/${g.name}.js`;
    await mkdir(new URL(`scriptlets/lists/${g.list}/`, EXT_DIR), { recursive: true });
    await writeFile(new URL(file, EXT_DIR), body, 'utf8');
    index.push({ list: g.list, name: g.name, file, hosts });
    bytes += body.length;
    const kb = Math.round(body.length / 1024);
    if (kb > largest.kb) largest = { file, kb };
  }

  index.sort((a, b) => a.file.localeCompare(b.file));
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(new URL('index.json', OUT_DIR), JSON.stringify(index, null, 2), 'utf8');

  console.log('');
  for (const [state, c] of Object.entries(counts)) {
    console.log(`  lists ${state === 'on' ? 'on by default ' : 'off by default'}  ${String(c.rules).padStart(5)} rules  ${String(c.compiled).padStart(5)} compiled`);
    console.log(`      left out: ${c.wildcardOnly} wildcard-only, ${c.trusted} trusted-*, ${c.rejected} other rejected, ${c.ownOnly} own-group hosts only, ${c.regexOnly} regex only, ${c.badHostOnly} unusable hosts only`);
    console.log(`      exceptions: ${c.exceptions}`);
  }
  if (noCode.length) console.log(`      no code in the library: ${noCode.join(', ')}`);
  console.log('');
  console.log(`  ${index.length} files, ${Math.round(bytes / 1024)} KB, largest ${largest.kb} KB (${largest.file})`);

  const compiled = counts.on.compiled + counts.off.compiled;
  if (compiled === 0 || index.length === 0) {
    console.error('! no list scriptlets compiled');
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${compiled.toLocaleString()} list scriptlet rules compiled`);
}

await main();
