/**
 * Convert $popup filters into DNR rules.
 *
 * AdGuard's converter drops these — 3,017 of them — because DNR has no notion
 * of "this navigation is a popup". DNR classifies by resource type and
 * initiator, not by how a navigation began, so the information simply is not
 * in its model and mistranslating would be worse than refusing.
 *
 * But a popup IS a main_frame request with an initiator, so most of these can
 * be re-expressed. The honest cost: DNR cannot tell a popunder to evil.example
 * from you deliberately typing evil.example into the address bar, so both are
 * blocked. For domains that exist to serve popunders that is the right answer;
 * it is why this ships as its own ruleset that can be toggled off on its own.
 *
 * Popunders are the dominant ad format on free streaming sites — the window
 * that opens behind yours when you click play.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { LISTS } from './lists.config.ts';
import type { PopupPatterns } from '../src/shared/catalogue.ts';

const LISTS_DIR = new URL('../lists/', import.meta.url);
const OUT = new URL('../extension/rules/popup.json', import.meta.url);
const PATTERNS_OUT = new URL('../extension/popup-patterns.json', import.meta.url);

const BLOCK_PRIORITY = 1000;
const ALLOW_PRIORITY = 2000; // must outrank block for @@ exceptions to win

interface ParsedRule {
  isException: boolean;
  pattern: string;
  thirdParty: boolean;
  domains: string[];
  excludedDomains: string[];
}

interface PopupRule {
  id: number;
  priority: number;
  action: { type: 'allow' | 'block' };
  condition: {
    resourceTypes: ['main_frame'];
    urlFilter?: string;
    initiatorDomains?: string[];
    excludedInitiatorDomains?: string[];
    domainType?: 'thirdParty';
  };
}

/** Parse "||foo.com^$popup,domain=a.com|b.com,3p" into its parts. */
function parseRule(line: string): ParsedRule | null {
  const isException = line.startsWith('@@');
  const body = isException ? line.slice(2) : line;
  const dollar = body.lastIndexOf('$');
  if (dollar === -1) return null;

  const pattern = body.slice(0, dollar);
  const opts = body.slice(dollar + 1).split(',');
  if (!opts.includes('popup')) return null;
  if (opts.includes('badfilter')) return null; // disables another rule; not ours to apply

  const out: ParsedRule = { isException, pattern, thirdParty: false, domains: [], excludedDomains: [] };
  for (const o of opts) {
    if (o === 'third-party' || o === '3p' || o === 'strict3p') out.thirdParty = true;
    else if (o.startsWith('domain=')) {
      for (const d of o.slice(7).split('|')) {
        if (!d) continue;
        if (d.startsWith('~')) out.excludedDomains.push(d.slice(1));
        else out.domains.push(d);
      }
    }
  }
  return out;
}

/** Filter-list wildcard domains (vipbox.*) cannot be expressed in DNR. */
const expandable = (d: string) => !d.includes('*');

function toDnr(parsed: ParsedRule, id: number): PopupRule | null {
  const { isException, pattern, thirdParty, domains, excludedDomains } = parsed;

  const initiatorDomains = domains.filter(expandable);
  const excludedInitiatorDomains = excludedDomains.filter(expandable);
  const bare = pattern === '' || pattern === '*';

  // REFUSAL: a bare pattern with no initiator would block every top-level
  // navigation in the browser. Nothing is worth shipping that by accident.
  if (bare && initiatorDomains.length === 0) return null;

  // A domain-scoped rule whose domains were all wildcards would silently
  // widen to "everywhere". Drop it rather than broaden it.
  if (domains.length > 0 && initiatorDomains.length === 0) return null;

  const condition: PopupRule['condition'] = { resourceTypes: ['main_frame'] };
  if (!bare) condition.urlFilter = pattern;
  if (initiatorDomains.length) condition.initiatorDomains = initiatorDomains;
  if (excludedInitiatorDomains.length) condition.excludedInitiatorDomains = excludedInitiatorDomains;
  if (thirdParty) condition.domainType = 'thirdParty';

  return {
    id,
    priority: isException ? ALLOW_PRIORITY : BLOCK_PRIORITY,
    action: { type: isException ? 'allow' : 'block' },
    condition,
  };
}

async function main() {
  const seen = new Set<string>();
  const parsed: ParsedRule[] = [];
  let raw = 0, badfilter = 0;

  for (const l of LISTS) {
    const txt = await readFile(new URL(`${l.name}.txt`, LISTS_DIR), 'utf8');
    for (const line of txt.split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('!') || t.startsWith('[')) continue;
      if (t.includes('##') || t.includes('#@#') || t.includes('#?#')) continue;
      if (!/(^|,)popup(,|$)/.test(t.slice(t.lastIndexOf('$') + 1))) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      raw += 1;
      const p = parseRule(t);
      if (!p) { badfilter += 1; continue; }
      parsed.push(p);
    }
  }

  const rules: PopupRule[] = [];
  let refused = 0;
  let id = 1;
  for (const p of parsed) {
    const r = toDnr(p, id);
    if (!r) { refused += 1; continue; }
    rules.push(r);
    id += 1;
  }

  await writeFile(OUT, JSON.stringify(rules), 'utf8');

  // Hosts for the window.open guard — the JS-driven popunders never produce
  // a blockable navigation, because the page calls window.open() itself.
  //
  // The guard has only the host to go on, on every site, so it takes only
  // filters that block a whole host everywhere: ||popads.net^$popup. A filter
  // narrowed to a path (||google.com/favicon.ico) or to some sites
  // (domain=instagram.com) would block the whole host on every site in the
  // guard. 0.1.0 did exactly that, and refused every script-opened window to
  // google.com, Google sign-in included. Those filters stay DNR-only above,
  // where their conditions survive.
  //
  // Exceptions follow the same shape: one for a whole host everywhere
  // (@@||accounts.google.com^$popup) goes on the allow list. A narrowed one,
  // such as a single click-through path on doubleclick.net, can't be expressed
  // by host, and allowing the whole host for it would let that network's
  // popunders through, so the guard keeps refusing that host.
  const WHOLE_HOST = /^\|\|([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\^\|?)?$/i;
  const hosts = new Set<string>();
  const thirdPartyHosts = new Set<string>();
  const allowHosts = new Set<string>();
  let narrowed = 0;
  for (const p of parsed) {
    const m = WHOLE_HOST.exec(p.pattern);
    const everywhere = p.domains.length === 0 && p.excludedDomains.length === 0;
    if (!m || !everywhere) {
      if (!p.isException && p.pattern.startsWith('||')) narrowed += 1;
      continue;
    }
    const host = m[1].toLowerCase();
    if (p.isException) allowHosts.add(host);
    else (p.thirdParty ? thirdPartyHosts : hosts).add(host);
  }
  for (const h of hosts) thirdPartyHosts.delete(h); // blocked everywhere already
  const patterns: PopupPatterns = { hosts: [...hosts], thirdParty: [...thirdPartyHosts], allow: [...allowHosts] };
  await writeFile(PATTERNS_OUT, JSON.stringify(patterns), 'utf8');

  // The window.open guard itself is src/popup-guard.ts. build/compile.ts bakes
  // these hosts into it, because it runs in the MAIN world with no chrome.runtime
  // to fetch them, and window.open has to answer synchronously anyway.

  const blocks = rules.filter((r) => r.action.type === 'block').length;
  const allows = rules.length - blocks;
  console.log('');
  console.log(`  $popup rules found     ${String(raw).padStart(7)}`);
  console.log(`  badfilter/unparsed     ${String(badfilter).padStart(7)}`);
  console.log(`  refused (unsafe)       ${String(refused).padStart(7)}   bare pattern with no initiator, or wildcard-only domains`);
  console.log(`  DNR rules emitted      ${String(rules.length).padStart(7)}   ${blocks} block / ${allows} allow`);
  console.log(`  window.open hosts      ${String(hosts.size).padStart(7)}   + ${thirdPartyHosts.size} third-party only, ${allowHosts.size} excepted`);
  console.log(`  left to DNR alone      ${String(narrowed).padStart(7)}   narrowed to a path or to some sites`);
  console.log('');

  if (rules.length === 0) {
    console.error('! produced no popup rules');
    process.exitCode = 1;
    return;
  }
  console.log(`✓ popup: ${rules.length} DNR rules, ${hosts.size + thirdPartyHosts.size} window.open hosts`);
}

await main();
