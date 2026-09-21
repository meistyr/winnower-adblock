/**
 * Cancels that cross from one filter list to another.
 *
 * uBlock Origin's lists switch off rules with `$badfilter`, usually because the
 * rule breaks sites, and the rule they switch off is often in a different list:
 * uBlock's Unbreak list cancels Peter Lowe's `||top.mail.ru^` and blocks
 * `||top.mail.ru^$3p` instead. convert-network.ts converts each list on its
 * own, so a cancel never reached the other list and its rule stayed on. This
 * finds those cancels so the rules can be left out before conversion.
 *
 * Matching is exact, as uBlock's is: a cancel names one rule, pattern and
 * options, and nothing else. Only the spelling is normalised (option order,
 * aliases like `3p` for `third-party`, the order of domains in `domain=`), so
 * two ways of writing the same rule match and two different rules do not.
 */
import type { FilterList } from './lists.config.ts';

/** uBlock's short and negated names, resolved to one spelling. */
const ALIASES: Record<string, string> = {
  '3p': 'third-party',
  '1p': 'first-party',
  '~3p': 'first-party',
  '~1p': 'third-party',
  '~third-party': 'first-party',
  '~first-party': 'third-party',
  xhr: 'xmlhttprequest',
  css: 'stylesheet',
  frame: 'subdocument',
  doc: 'document',
  from: 'domain',
};

/** Options whose value is a `|`-separated list, where order carries no meaning. */
const LIST_OPTIONS = new Set(['domain', 'to', 'denyallow']);

/** A network rule's pattern and options, normalised, or null for anything else. */
export function filterKey(line: string): { key: string; badfilter: boolean } | null {
  const rule = line.trim();
  if (!rule || rule.startsWith('!') || rule.startsWith('[')) return null;
  // Cosmetic and scriptlet rules: ##, #@#, #?#, #$#, #%# and their exceptions.
  if (/#[@?$%]*#/.test(rule)) return null;

  // The options start at the last `$`, with two exceptions. A rule can be all
  // options (`$script,domain=x.com`), so a `$` at the very start still counts.
  // A regular-expression rule can end in `$` itself (`/foo$/`), and that one
  // is part of the pattern: options only follow the regex's closing slash.
  const at = rule.lastIndexOf('$');
  const regexEnd = rule.startsWith('/') ? rule.lastIndexOf('/') : -1;
  if (at < 0 || regexEnd > at) return { key: `${rule}$`, badfilter: false };

  const options = rule
    .slice(at + 1)
    .split(',')
    .filter(Boolean)
    .map((option) => {
      const eq = option.indexOf('=');
      let name = (eq < 0 ? option : option.slice(0, eq)).toLowerCase();
      name = ALIASES[name] ?? name;
      if (eq < 0) return name;
      let value = option.slice(eq + 1);
      if (LIST_OPTIONS.has(name)) value = value.split('|').sort().join('|');
      return `${name}=${value}`;
    });

  const badfilter = options.includes('badfilter');
  const kept = options.filter((o) => o !== 'badfilter').sort();
  return { key: `${rule.slice(0, at)}$${kept.join(',')}`, badfilter };
}

/**
 * The rules each list's cancels switch off in the other lists: key to the lists
 * the cancels came from.
 *
 * Only lists on by default count. Rulesets are fixed when the extension is
 * built, so a cancel cannot follow its list's switch the way uBlock's does:
 * switching Ads off, which includes Unbreak, leaves these rules cancelled where
 * uBlock would put them back. The cancels exist because the rules break sites,
 * so leaving them off is the safer of the two ways to be wrong. It is the same
 * rule exceptions follow in convert-scriptlets.ts.
 */
export function crossListCancels(lists: ReadonlyArray<Pick<FilterList, 'name' | 'enabled'>>, textOf: (name: string) => string): Map<string, Set<string>> {
  const cancels = new Map<string, Set<string>>();
  for (const list of lists) {
    if (!list.enabled) continue;
    for (const line of textOf(list.name).split('\n')) {
      const parsed = filterKey(line);
      if (!parsed?.badfilter) continue;
      if (!cancels.has(parsed.key)) cancels.set(parsed.key, new Set());
      cancels.get(parsed.key)!.add(list.name);
    }
  }
  return cancels;
}

/**
 * A list's text with the rules other lists cancel left out, and how many.
 *
 * A cancel from the list itself is left for the converter, which already
 * applies those within a list.
 */
export function withoutCancelled(name: string, text: string, cancels: Map<string, Set<string>>): { text: string; removed: number } {
  let removed = 0;
  const kept = text.split('\n').filter((line) => {
    const parsed = filterKey(line);
    if (!parsed || parsed.badfilter) return true;
    const from = cancels.get(parsed.key);
    if (!from || (from.size === 1 && from.has(name))) return true;
    removed += 1;
    return false;
  });
  return { text: kept.join('\n'), removed };
}
