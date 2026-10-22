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
 * Hosts ending in `.*` (`limetorrents.*`, any ending) go to files of their
 * own. Chrome's match patterns cannot express "any ending", so those files load
 * on every site and check the hostname themselves; see WILDCARD_KEYS. Keeping
 * them apart means a page loads only the wildcard tables everywhere, never the
 * far larger exact-host ones.
 *
 * Left out, and counted below (tracked in issue #8):
 *   - hosts written as a regular expression. Chrome's match patterns cannot
 *     express them, and the files have no regex table.
 *   - rules the library's converter rejects and uBlock has no code for. The
 *     rest run on uBlock's own code instead; see ubo-scriptlets.ts.
 *   - rules uBlock runs only from lists it trusts (trusted-*, rpnt), when
 *     they come from any list but uBlock's own.
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
import { exceptionTable, type ScriptletException } from './scriptlet-exceptions.ts';
import type { ListScriptlet } from '../src/shared/catalogue.ts';
import { UBO_LISTS, UBO_VERSION, loadUbo, parseUboArgs, uboScriptlet, type UboScriptlet } from './ubo-scriptlets.ts';

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
/** `youtube.*` reaches youtube.com, which keeps its hand-made group alone. */
const isOwnName = (name: string) => OWN_HOSTS.some((own) => own.startsWith(name + '.'));

interface Group {
  list: string;
  name: string;
  /** Keyed by the name before `.*` rather than by host. See WILDCARD_KEYS. */
  wildcard: boolean;
  /** Set when the rules run on uBlock's code rather than the AdGuard library's. */
  ubo?: UboScriptlet;
  /** [args] or [args, hosts it must not run on]. */
  rules: Array<[string[]] | [string[], string[]]>;
  ruleIndex: Map<string, number>;
  hosts: Map<string, Set<number>>;
}

/** Per list state, so the counts can be compared with what is on by default. */
interface Counts {
  rules: number;
  compiled: number;
  /** Compiled rules that name at least one `.*` host. */
  wildcard: number;
  trusted: number;
  rejected: number;
  ownOnly: number;
  regexOnly: number;
  badHostOnly: number;
  exceptions: number;
}
const emptyCounts = (): Counts => ({
  rules: 0, compiled: 0, wildcard: 0, trusted: 0, rejected: 0, ownOnly: 0, regexOnly: 0, badHostOnly: 0, exceptions: 0,
});

/**
 * The lookup keys of a wildcard file: each name in the hostname's chain with
 * its last one or two labels taken off, so `limetorrents.*` reaches
 * limetorrents.lol, limetorrents.co.uk and www.limetorrents.lol.
 *
 * uBlock decides the ending with the Public Suffix List, which is too large to
 * put on every page. One or two labels covers endings like `.com` and `.co.uk`.
 * The cost is that a name also matches as a subdomain of a two-label site
 * (`limetorrents.example.com`), which the names in these lists are too
 * specific to hit in practice.
 */
const WILDCARD_KEYS = `
  const keys = [];
  for (const h of chain) {
    const parts = h.split('.');
    for (let n = 1; n <= 2 && n < parts.length; n++) keys.push(parts.slice(0, -n).join('.'));
  }
`;

/**
 * The runtime part of every file. It finds this page's calls by walking the
 * hostname up through its parent domains, because a rule for example.com also
 * applies on www.example.com. Exceptions are gathered the same way first.
 * A wildcard file looks its calls up by WILDCARD_KEYS instead.
 *
 * Runs at document_start in the page's own world, before any page script, so
 * the built-ins it uses are still the real ones.
 */
const runtime = (wildcard: boolean) => `
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
${wildcard ? WILDCARD_KEYS : '  const keys = chain;'}
  const done = new Set();
  for (const h of keys) {
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
  await loadUbo();
  const groups = new Map<string, Group>();
  /** host -> the exceptions found for it. Which files they reach is exceptionTable's call. */
  const exceptions = new Map<string, ScriptletException[]>();
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

      // The calls this line makes, each with the domain list it applies to.
      const calls: Array<{ domains: string; call: string[] | null; ubo?: UboScriptlet }> = [];
      if (converted.length && converted.every((r) => isValidScriptletRule(r))) {
        for (const rule of converted) {
          const adg = ADG_RULE.exec(rule);
          calls.push({ domains: adg?.[1] ?? '', call: adg ? parseArgs(adg[3]) : null });
        }
      } else {
        // Rules the library refuses run on uBlock's own code, as uBlock runs
        // them. See ubo-scriptlets.ts. Those uBlock runs only from lists it
        // trusts (trusted-*, rpnt) follow the same rule: uBlock's own lists only.
        const call = parseUboArgs(ubo[3]);
        const code = call?.[0] ? uboScriptlet(call[0]) : undefined;
        const trustedList = list.url.startsWith(UBO_LISTS);
        if (!call || !code || (code.requiresTrust && !trustedList)) {
          if (!isException) {
            if (ubo[3].trim().startsWith('trusted-')) c.trusted += 1;
            else c.rejected += 1;
          }
          continue;
        }
        calls.push({ domains: ubo[1], call: [code.name, ...call.slice(1)], ubo: code });
      }

      let compiledHere = false;
      let wild = 0, own = 0, regex = 0, bad = 0;
      for (const { domains, call, ubo: code } of calls) {
        if (!call) {
          bad += 1;
          continue;
        }
        const [name, ...args] = call;

        const include: string[] = [];
        const names: string[] = [];
        const not: string[] = [];
        for (const entry of domains.split(',').map((d) => d.trim()).filter(Boolean)) {
          if (entry.startsWith('~')) {
            const h = toHost(entry.slice(1));
            if (h) not.push(h);
          } else if (entry.startsWith('/')) regex += 1;
          else if (entry.endsWith('.*')) {
            const base = entry.slice(0, -2).toLowerCase();
            if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(base)) bad += 1;
            else if (isOwnName(base)) own += 1;
            else names.push(base);
          } else {
            const h = toHost(entry);
            if (!h) bad += 1;
            else if (isOwnHost(h)) own += 1;
            else include.push(h);
          }
        }

        if (isException) {
          for (const h of include) {
            if (!exceptions.has(h)) exceptions.set(h, []);
            exceptions.get(h)!.push({ list: list.name, name, args });
          }
          continue;
        }
        if (name === undefined) continue;

        const add = (wildcard: boolean, keys: string[]) => {
          if (!keys.length) return;
          const id = `${list.name}\t${name}\t${wildcard}`;
          let g = groups.get(id);
          if (!g) {
            g = { list: list.name, name, wildcard, ubo: code, rules: [], ruleIndex: new Map(), hosts: new Map() };
            groups.set(id, g);
          }
          const ruleKey = JSON.stringify([args, not]);
          let idx = g.ruleIndex.get(ruleKey);
          if (idx === undefined) {
            idx = g.rules.length;
            g.rules.push(not.length ? [args, not] : [args]);
            g.ruleIndex.set(ruleKey, idx);
          }
          for (const h of new Set(keys)) {
            if (!g.hosts.has(h)) g.hosts.set(h, new Set());
            g.hosts.get(h)!.add(idx);
          }
          compiledHere = true;
        };
        add(false, include);
        add(true, names);
        if (names.length) wild += 1;
      }

      if (isException) continue;
      if (compiledHere) c.compiled += 1;
      if (compiledHere && wild) c.wildcard += 1;
      if (compiledHere) continue;
      if (own) c.ownOnly += 1;
      else if (regex) c.regexOnly += 1;
      else c.badHostOnly += 1;
    }
  }

  await rm(OUT_DIR, { recursive: true, force: true });
  const index: ListScriptlet[] = [];
  let bytes = 0;
  let wildcardBytes = 0;
  let largest = { file: '', kb: 0 };
  // Names the converter accepts but the library has no code for. Left out and
  // counted like the rest, rather than failing the build over one library gap.
  const noCode: string[] = [];

  for (const g of groups.values()) {
    const fn = g.ubo ? undefined : scriptlets.getScriptletFunction(g.name);
    if (!g.ubo && typeof fn !== 'function') {
      noCode.push(`${g.list}/${g.name} (${g.hosts.size} hosts)`);
      continue;
    }

    const hosts = [...g.hosts.keys()].sort();
    const H = Object.fromEntries(hosts.map((h) => [h, [...g.hosts.get(h)!]]));
    const X = exceptionTable(g, exceptions, onByDefault);

    // uBlock's scriptlets take the rule's arguments directly, and reach their
    // helpers by name and shared state through scriptletGlobals, all of which
    // must be in scope. The library's take a source object first.
    const code = g.ubo
      ? [
          `  const scriptletGlobals = {};`,
          g.ubo.code,
          `  const run = (_source, args) => ${g.ubo.fnName}(...args);`,
          `  const NAME = ${JSON.stringify(g.name)};`,
          `  const VERSION = ${JSON.stringify(UBO_VERSION)};`,
        ]
      : [
          `  const run = ${String(fn)};`,
          `  const NAME = ${JSON.stringify(g.name)};`,
          `  const VERSION = ${JSON.stringify(SCRIPTLETS_VERSION)};`,
        ];

    const body = [
      `/* winnower, generated. Do not edit.`,
      ` * list: ${g.list}, scriptlet: ${g.name}, ${g.rules.length} rules on ${hosts.length} ${g.wildcard ? 'names, any ending' : 'hosts'}`,
      g.ubo ? ` * uBlock Origin ${UBO_VERSION} (GPL-3.0)` : ` * @adguard/scriptlets ${SCRIPTLETS_VERSION} (GPL-3.0)`,
      ` * regenerate: npm run list-scriptlets`,
      ` */`,
      `"use strict";`,
      `(() => {`,
      ...code,
      `  const R = ${JSON.stringify(g.rules)};`,
      `  const H = ${JSON.stringify(H)};`,
      `  const X = ${JSON.stringify(X)};`,
      runtime(g.wildcard),
      `})();`,
      ``,
    ].join('\n');

    const file = `scriptlets/lists/${g.list}/${g.name}${g.wildcard ? '.any-ending' : ''}.js`;
    await mkdir(new URL(`scriptlets/lists/${g.list}/`, EXT_DIR), { recursive: true });
    await writeFile(new URL(file, EXT_DIR), body, 'utf8');
    index.push({
      list: g.list,
      name: g.name,
      file,
      hosts,
      ...(g.wildcard ? { wildcard: true } : {}),
      ...(g.ubo?.world === 'ISOLATED' ? { world: 'ISOLATED' } : {}),
    });
    bytes += body.length;
    if (g.wildcard) wildcardBytes += body.length;
    const kb = Math.round(body.length / 1024);
    if (kb > largest.kb) largest = { file, kb };
  }

  index.sort((a, b) => a.file.localeCompare(b.file));
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(new URL('index.json', OUT_DIR), JSON.stringify(index, null, 2), 'utf8');

  console.log('');
  for (const [state, c] of Object.entries(counts)) {
    console.log(`  lists ${state === 'on' ? 'on by default ' : 'off by default'}  ${String(c.rules).padStart(5)} rules  ${String(c.compiled).padStart(5)} compiled`);
    console.log(`      ${c.wildcard} of them on names with any ending`);
    console.log(`      left out: ${c.trusted} trusted-*, ${c.rejected} other rejected, ${c.ownOnly} own-group hosts only, ${c.regexOnly} regex only, ${c.badHostOnly} unusable hosts only`);
    console.log(`      exceptions: ${c.exceptions}`);
  }
  if (noCode.length) console.log(`      no code in the library: ${noCode.join(', ')}`);
  console.log('');
  console.log(`  ${index.length} files, ${Math.round(bytes / 1024)} KB, largest ${largest.kb} KB (${largest.file})`);
  console.log(`  any-ending files, loaded on every site: ${Math.round(wildcardBytes / 1024)} KB with every list on`);

  const compiled = counts.on.compiled + counts.off.compiled;
  if (compiled === 0 || index.length === 0) {
    console.error('! no list scriptlets compiled');
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${compiled.toLocaleString()} list scriptlet rules compiled`);
}

await main();
