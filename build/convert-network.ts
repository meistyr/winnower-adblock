/**
 * Convert fetched ABP-syntax filter lists into DNR static rulesets.
 *
 * One ruleset per upstream list. The 50-enabled-ruleset cap counts rulesets,
 * not the rules inside them, so there is no reason to chunk, and per-list
 * granularity is the granularity a human actually wants to toggle.
 *
 * Budget facts:
 *   GUARANTEED_MINIMUM_STATIC_RULES  30,000  <- floor kept under contention
 *   shared pool                     ~300,000 <- available when we are the only blocker
 *   regexp rules                      1,000  <- GLOBAL, hard cap, silent failure
 *
 * Only the regexp cap and the ~330,000 ceiling are hard failures. Exceeding the
 * 30,000 guarantee is a robustness note: it only bites if a second content
 * blocker is installed and starts competing for the shared pool.
 *
 * Filters that need regex lookahead cannot be converted. DNR compiles regexFilter
 * with RE2, which has no lookahead, so the converter reports and drops them.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { Filter, FilterConverter } from '@adguard/dnr-converter';
import { LISTS, type FilterList } from './lists.config.ts';
import type { BuildStats, ListStats } from '../src/shared/catalogue.ts';

const LISTS_DIR = new URL('../lists/', import.meta.url);
const RULES_DIR = new URL('../extension/rules/', import.meta.url);

const GUARANTEED_STATIC_RULES = 30_000;
const SHARED_POOL = 300_000;
const MAX_TOTAL_STATIC_RULES = GUARANTEED_STATIC_RULES + SHARED_POOL;
const MAX_REGEXP_RULES = 1_000;

// Generous per-list caps: we want to measure what the lists actually produce,
// then enforce the real budget across the whole set below. Capping per list
// would silently truncate and hide the true totals.
const PER_LIST_MAX_RULES = 150_000;
const PER_LIST_MAX_REGEXP = 1_000;

async function convertList(list: FilterList, filterId: number): Promise<ListStats> {
  const content = await readFile(new URL(`${list.name}.txt`, LISTS_DIR), 'utf8');
  const converter = new FilterConverter();
  const [result] = await converter.convert([new Filter(filterId, content)], {
    maxNumberOfRules: PER_LIST_MAX_RULES,
    maxNumberOfRegexpRules: PER_LIST_MAX_REGEXP,
  });

  const { ruleset, errors, limitations } = result;
  const rules = await ruleset.getDeclarativeRules();

  await writeFile(new URL(`${list.name}.json`, RULES_DIR), JSON.stringify(rules), 'utf8');

  return {
    name: list.name,
    tier: list.tier,
    filterId,
    rules: rules.length,
    safe: ruleset.getSafeRulesCount(),
    unsafe: ruleset.getUnsafeRulesCount(),
    regexp: ruleset.getRegexpRulesCount(),
    errors: errors?.length ?? 0,
    limitations: limitations?.length ?? 0,
  };
}

async function main() {
  await mkdir(RULES_DIR, { recursive: true });

  const stats: ListStats[] = [];
  for (const [i, list] of LISTS.entries()) {
    process.stdout.write(`  converting ${list.name.padEnd(20)}`);
    const s = await convertList(list, i + 1);
    stats.push(s);
    console.log(`${String(s.rules).padStart(7)} rules`);
  }

  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const num = (s: string | number, n: number) => String(s).padStart(n);
  const fmt = (n: number) => n.toLocaleString();

  console.log('');
  console.log(`  ${pad('ruleset', 22)} ${num('rules', 8)} ${num('regexp', 7)} ${num('unsafe', 7)} ${num('err', 5)}  tier`);
  console.log(`  ${'-'.repeat(22)} ${'-'.repeat(8)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(5)}  ----`);
  for (const s of [...stats].sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name))) {
    console.log(
      `  ${pad(s.name, 22)} ${num(fmt(s.rules), 8)} ${num(fmt(s.regexp), 7)} ${num(fmt(s.unsafe), 7)} ${num(fmt(s.errors), 5)}   ${s.tier}`,
    );
  }

  const tier1 = stats.filter((s) => s.tier === 1).reduce((a, s) => a + s.rules, 0);
  const tier2 = stats.filter((s) => s.tier === 2).reduce((a, s) => a + s.rules, 0);
  const regexp = stats.reduce((a, s) => a + s.regexp, 0);

  console.log(`  ${'-'.repeat(22)} ${'-'.repeat(8)} ${'-'.repeat(7)} ${'-'.repeat(7)} ${'-'.repeat(5)}`);
  console.log(`  ${pad('tier 1 (always on)', 22)} ${num(fmt(tier1), 8)}`);
  console.log(`  ${pad('tier 2 (optional)', 22)} ${num(fmt(tier2), 8)}`);
  console.log(`  ${pad('TOTAL', 22)} ${num(fmt(tier1 + tier2), 8)} ${num(fmt(regexp), 7)}`);
  console.log('');

  // --- budget assertions -------------------------------------------------
  //
  // Hard failures are only the limits Chrome will actually refuse to load.
  // The 30,000 guaranteed minimum is NOT one of them: it is the floor an
  // extension keeps when several blocking extensions contend for the shared
  // ~300,000 pool. As the only content blocker installed, we get the whole
  // pool, so exceeding 30,000 is a robustness note, not a build error.
  const problems: string[] = [];
  const warnings: string[] = [];

  if (regexp > MAX_REGEXP_RULES) {
    problems.push(
      `${fmt(regexp)} regexp rules, over the hard cap of ${fmt(MAX_REGEXP_RULES)}. ` +
        `Chrome rejects the ENTIRE ruleset over this limit, silently.`,
    );
  }
  if (tier1 + tier2 > MAX_TOTAL_STATIC_RULES) {
    problems.push(
      `${fmt(tier1 + tier2)} rules, over the ~${fmt(MAX_TOTAL_STATIC_RULES)} ceiling ` +
        `(${fmt(GUARANTEED_STATIC_RULES)} guaranteed + ~${fmt(SHARED_POOL)} shared pool).`,
    );
  }
  if (tier1 + tier2 === 0) problems.push('converted 0 rules: the build produced nothing');

  if (tier1 > GUARANTEED_STATIC_RULES) {
    warnings.push(
      `tier 1 is ${fmt(tier1)} rules, over the ${fmt(GUARANTEED_STATIC_RULES)} guaranteed minimum. ` +
        `Fine while winnower is the only content blocker installed. It then draws on the ` +
        `full shared pool. Installing a second blocker would degrade this.`,
    );
  }

  await writeFile(
    new URL('_stats.json', RULES_DIR),
    JSON.stringify({ generated: new Date().toISOString(), tier1, tier2, regexp, lists: stats } satisfies BuildStats, null, 2),
    'utf8',
  );

  if (warnings.length) {
    for (const w of warnings) console.log(`  note: ${w}`);
    console.log('');
  }

  if (problems.length) {
    console.error('BUDGET PROBLEMS:');
    for (const p of problems) console.error(`  ! ${p}`);
    console.error('');
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${stats.length} rulesets written to extension/rules/`);
}

await main();
