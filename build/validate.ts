/**
 * Validate generated rulesets against Chrome's DNR constraints.
 *
 * Exists because the expensive failures here are silent: Chrome rejects an
 * entire ruleset for one malformed rule or an over-cap regexp count, and the
 * extension then loads looking healthy while blocking nothing. A build that
 * prints no errors is not evidence. This asserts positive facts instead.
 */
import { readFile, readdir } from 'node:fs/promises';
import type { PopupPatterns } from '../src/shared/catalogue.ts';
import { ALLOWLIST_PRIORITY, HID_MARKER, HIDE_DECLARATION } from '../src/shared/constants.ts';
import { createPopupMatcher } from '../src/shared/popup-match.ts';
import { collapseVerdict, type BoxFacts, type Verdict } from '../src/shared/collapse-match.ts';
import { formatLine, isAlwaysKept, type LogLine } from '../src/shared/log.ts';
import { isNewer } from '../src/shared/version.ts';
import { checkSwitches } from './check-switches.ts';

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
// The popup guard refuses window.open by host alone, on every site, so one wrong
// host breaks that site's sign-in and share windows everywhere. 0.1.0 refused
// every script-opened google.com window, Google sign-in included. These hosts
// sign people in, so the guard must always let them open.
const SIGN_IN_HOSTS = [
  'accounts.google.com', 'appleid.apple.com', 'login.microsoftonline.com', 'login.live.com',
  'www.facebook.com', 'github.com', 'discord.com',
];
const popupPatterns = JSON.parse(await readFile(new URL('popup-patterns.json', EXT_DIR), 'utf8')) as PopupPatterns;
const guardRefuses = createPopupMatcher(popupPatterns);
const refusedSignIns = SIGN_IN_HOSTS.filter((host) => guardRefuses(host, 'news.example'));
const refusedOwn = popupPatterns.hosts.filter((host) => guardRefuses(host, 'news.example')).length;
console.log(`  popup guard refuses ${refusedOwn.toLocaleString()} / ${popupPatterns.hosts.length.toLocaleString()} of its hosts, ${refusedSignIns.length} / ${SIGN_IN_HOSTS.length} sign-in hosts`);
console.log('');
for (const host of refusedSignIns) problems.push(`the popup guard refuses windows to ${host}, a sign-in host. Find the $popup filter naming it.`);
if (refusedOwn === 0) problems.push('the popup guard refuses none of its own hosts');
console.log('');

// The collapser only hides a box when it finds something WINNOWER hid inside it,
// and it recognises winnower's hiding by HID_MARKER. Losing the marker would not
// error: the collapser would find no evidence anywhere, quietly stop collapsing,
// and the empty ad boxes it exists to remove would come back with nothing
// logged. So assert the marker reached the built files, rather than trusting
// that the emitting code still runs.
// Counted two ways on purpose: every hide in the file, and every hide carrying
// the full marked declaration. Equal means none slipped through unmarked. The
// domain selectors are checked in build/check-switches.ts instead, by running
// the built content script and reading what it injects — the marker is
// assembled at runtime there, so grepping the bundle would prove nothing.
const genericCss = await readFile(new URL('cosmetic/generic.css', EXT_DIR), 'utf8');
const hideBlocks = genericCss.split('display:none!important').length - 1;
const marked = genericCss.split(HIDE_DECLARATION).length - 1;
console.log(`  hide rules marked   ${marked.toLocaleString().padStart(8)} / ${hideBlocks.toLocaleString()} in generic.css`);
if (hideBlocks === 0) problems.push('generic.css contains no hide rules at all');
if (marked !== hideBlocks) problems.push(`${hideBlocks - marked} hide rules in generic.css carry no ${HID_MARKER}; the collapser is blind to whatever they hide`);

// The collapser's judgement, asked directly — it is the part that has gone
// wrong, twice, and neither failure was reachable from a browser test in time
// to matter. Both directions asserted: a suite that only ever expects "skip"
// passes just as loudly on a collapser that has stopped working entirely.
const AD_WRAPPER: BoxFacts = {
  tagName: 'DIV', width: 300, height: 250, textLength: 0, hasFormOrMedia: false,
  subtreeCount: 3, hasAnchor: false, hasAriaOrRole: false, hasVisibleMedia: false,
  hasWinnowerHiddenDescendant: true, seenBefore: true,
};
const SHAPES: [string, BoxFacts, Verdict][] = [
  // The positive half. theverge.com leaves 2066x250 and 800x90 holes behind a
  // generic rule; if these stop collapsing, winnower stops doing this job.
  ['an emptied ad wrapper', AD_WRAPPER, 'collapse'],
  ['the same box, first sighting', { ...AD_WRAPPER, seenBefore: false }, 'candidate'],
  // twitch.tv's player slot, measured live: nine empty divs reserving space for
  // a player positioned over them from another branch of the document, one of
  // which Twitch itself had hidden. Identical to an emptied ad wrapper on every
  // count except who did the hiding.
  ["twitch.tv's player slot", { ...AD_WRAPPER, width: 859, height: 483, subtreeCount: 9, hasWinnowerHiddenDescendant: false }, 'skip'],
  // YouTube's #guide-inner-content, caught mid-populate: 45 links, 64 buttons.
  ["YouTube's guide, mid-populate", { ...AD_WRAPPER, subtreeCount: 64, hasAnchor: true }, 'skip'],
  ['a full-height page container', { ...AD_WRAPPER, height: 1800 }, 'skip'],
  ['a box showing text', { ...AD_WRAPPER, textLength: 40 }, 'skip'],
];
for (const [label, facts, want] of SHAPES) {
  const got = collapseVerdict(facts).verdict;
  console.log(`  ${got === want ? 'ok  ' : 'FAIL'}  collapser: ${label.padEnd(30)} ${got}`);
  if (got !== want) problems.push(`the collapser answers "${got}" for ${label}, expected "${want}"`);
}

// The diagnostic log. "Errors are always kept" is the promise that lets someone
// report a broken site without first turning developer mode on and reproducing
// it, so assert it rather than trusting the call sites to have remembered.
const ERR: LogLine = { t: 1243, layer: 'collapse', verb: 'error', subject: 'div.thing', reason: 'boom' };
const ORDINARY: LogLine = { ...ERR, verb: 'skip' };
const alwaysKept = isAlwaysKept(ERR) && !isAlwaysKept(ORDINARY);
console.log(`  ${alwaysKept ? 'ok  ' : 'FAIL'}  log: errors kept, ordinary lines not`);
if (!alwaysKept) problems.push('the log does not keep errors regardless of developer mode');

// The reason is the column the whole feature exists for; a line that formats
// without it is a line that says what happened and not why.
const rendered = formatLine(ERR);
const hasReason = rendered.includes('— boom') && rendered.includes('collapse') && rendered.includes('1.2s');
console.log(`  ${hasReason ? 'ok  ' : 'FAIL'}  log: line carries time, layer and reason   ${JSON.stringify(rendered.trim())}`);
if (!hasReason) problems.push(`a log line renders as ${JSON.stringify(rendered)}, missing its time, layer or reason`);
// The update check's comparison. Text comparison is the trap here — "0.10.0"
// sorts BELOW "0.9.0" as a string, so the release that matters is the one that
// never gets announced.
const VERSIONS: [string, string, boolean][] = [
  ['v0.3.0', '0.2.1', true],
  ['0.2.1', '0.2.1', false],
  ['0.2.0', '0.2.1', false],
  ['v0.10.0', '0.9.0', true],
  ['1.0.0', '0.99.99', true],
  ['', '0.2.1', false],
  ['not-a-version', '0.2.1', false],
];
for (const [latest, current, want] of VERSIONS) {
  const got = isNewer(latest, current);
  const label = `${latest || '(empty)'} over ${current}`;
  console.log(`  ${got === want ? 'ok  ' : 'FAIL'}  update: ${label.padEnd(28)} ${got ? 'newer' : 'no news'}`);
  if (got !== want) problems.push(`the update check says ${latest} over ${current} is ${got}, expected ${want}`);
}
console.log('');

// The kill switches, asked directly. Both of their known failures were invisible
// from the top of a page, and neither can be provoked from a browser — see
// build/check-switches.ts.
const switches = await checkSwitches();
for (const line of switches.lines) console.log(line);
problems.push(...switches.problems);

if (totalRegexp > MAX_REGEXP_RULES) problems.push(`${totalRegexp} regexp rules exceeds the hard cap of ${MAX_REGEXP_RULES}`);
if (totalRules === 0) problems.push('zero rules across all rulesets');

if (problems.length) {
  console.error('INVALID:');
  for (const p of problems) console.error(`  ! ${p}`);
  process.exitCode = 1;
} else {
  console.log(`✓ ${files.length} rulesets valid, ${totalRules.toLocaleString()} rules, manifest consistent`);
}
