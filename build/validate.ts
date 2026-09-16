/**
 * Validate generated rulesets against Chrome's DNR constraints.
 *
 * Exists because the expensive failures here are silent: Chrome rejects an
 * entire ruleset for one malformed rule or an over-cap regexp count, and the
 * extension then loads looking healthy while blocking nothing. A build that
 * prints no errors is not evidence. This asserts positive facts instead.
 */
import { readFile, readdir } from 'node:fs/promises';
import { ALLOWLIST_PRIORITY } from '../src/shared/constants.ts';

const RULES_DIR = new URL('../extension/rules/', import.meta.url);
const EXT_DIR = new URL('../extension/', import.meta.url);

const MAX_REGEXP_RULES = 1_000;
const MAX_PRIORITY = 2_147_483_647;

// ALLOWLIST_PRIORITY is the worker's own constant, imported. Every static rule
// has to sit strictly below it or that rule keeps firing on an allowlisted site.
let maxStaticPriority = 0;

const VALID_ACTIONS = new Set([
  'block', 'redirect', 'allow', 'upgradeScheme', 'modifyHeaders', 'allowAllRequests',
]);
const VALID_RESOURCE_TYPES = new Set([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport',
  'webbundle', 'other',
]);

/** A rule as read from disk: untrusted until the checks below pass. */
interface UncheckedRule {
  id: number;
  priority?: number;
  action?: { type?: string };
  condition?: { resourceTypes?: string[]; excludedResourceTypes?: string[]; regexFilter?: string };
}

const problems: string[] = [];
let totalRules = 0;
let totalRegexp = 0;

const files = (await readdir(RULES_DIR)).filter((f) => f.endsWith('.json') && !f.startsWith('_'));

for (const file of files) {
  let rules: unknown;
  try {
    rules = JSON.parse(await readFile(new URL(file, RULES_DIR), 'utf8'));
  } catch (err) {
    problems.push(`${file}: not valid JSON — ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }
  if (!Array.isArray(rules)) {
    problems.push(`${file}: top level is not an array`);
    continue;
  }

  const ids = new Set<number>();
  let regexpHere = 0;

  for (const r of rules as UncheckedRule[]) {
    if (!Number.isInteger(r.id) || r.id < 1) {
      problems.push(`${file}: rule id must be a positive integer, got ${JSON.stringify(r.id)}`);
      break;
    }
    if (ids.has(r.id)) {
      problems.push(`${file}: duplicate rule id ${r.id} — Chrome rejects the whole ruleset`);
      break;
    }
    ids.add(r.id);

    if (!r.action || r.action.type === undefined || !VALID_ACTIONS.has(r.action.type)) {
      problems.push(`${file}: rule ${r.id} has invalid action ${JSON.stringify(r.action?.type)}`);
      break;
    }
    if (!r.condition) {
      problems.push(`${file}: rule ${r.id} has no condition`);
      break;
    }
    if (r.priority !== undefined && (!Number.isInteger(r.priority) || r.priority < 1 || r.priority > MAX_PRIORITY)) {
      problems.push(`${file}: rule ${r.id} priority ${r.priority} out of range`);
      break;
    }
    for (const key of ['resourceTypes', 'excludedResourceTypes'] as const) {
      for (const t of r.condition[key] ?? []) {
        if (!VALID_RESOURCE_TYPES.has(t)) {
          problems.push(`${file}: rule ${r.id} has unknown resourceType "${t}"`);
          break;
        }
      }
    }
    if (r.condition.regexFilter !== undefined) regexpHere += 1;
    if ((r.priority ?? 1) > maxStaticPriority) maxStaticPriority = r.priority ?? 1;
  }

  totalRules += rules.length;
  totalRegexp += regexpHere;
  console.log(`  ${file.replace('.json', '').padEnd(22)} ${String(rules.length).padStart(7)} rules  ${String(regexpHere).padStart(4)} regexp`);
}

// manifest cross-check: every declared ruleset must have a file, and vice versa.
const manifest = JSON.parse(await readFile(new URL('manifest.json', EXT_DIR), 'utf8')) as {
  declarative_net_request: { rule_resources: Array<{ path: string }> };
};
const declared = new Set(manifest.declarative_net_request.rule_resources.map((r) => r.path.replace('rules/', '')));
for (const f of files) if (!declared.has(f)) problems.push(`${f} exists but is not declared in manifest.json`);
for (const d of declared) if (!files.includes(d)) problems.push(`manifest.json declares ${d} but the file is missing`);

console.log('');
console.log(`  rulesets   ${files.length}`);
console.log(`  rules      ${totalRules.toLocaleString()}`);
console.log(`  regexp     ${totalRegexp.toLocaleString()} / ${MAX_REGEXP_RULES.toLocaleString()}`);
console.log('');

console.log(`  priority   max static ${maxStaticPriority.toLocaleString()} < allowlist ${ALLOWLIST_PRIORITY.toLocaleString()}`);
console.log('');
if (maxStaticPriority >= ALLOWLIST_PRIORITY) {
  problems.push(
    `a static rule has priority ${maxStaticPriority}, >= the allowlist's ${ALLOWLIST_PRIORITY}. ` +
      `It would keep firing on allowlisted sites. Raise ALLOWLIST_PRIORITY in src/shared/constants.ts.`,
  );
}
if (totalRegexp > MAX_REGEXP_RULES) problems.push(`${totalRegexp} regexp rules exceeds the hard cap of ${MAX_REGEXP_RULES}`);
if (totalRules === 0) problems.push('zero rules across all rulesets');

if (problems.length) {
  console.error('INVALID:');
  for (const p of problems) console.error(`  ! ${p}`);
  process.exitCode = 1;
} else {
  console.log(`✓ ${files.length} rulesets valid, ${totalRules.toLocaleString()} rules, manifest consistent`);
}
