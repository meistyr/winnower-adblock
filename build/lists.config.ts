import type { ListGroup } from '../src/shared/catalogue.ts';

/**
 * Upstream filter lists, in the order they are applied.
 *
 * Two independent axes. These were conflated at first, and they are not the
 * same question:
 *
 * tier   , robustness priority. Tier 1 is what we want to keep if a second
 *           content blocker is ever installed and starts competing for the
 *           shared rule pool, leaving us only the 30,000 guaranteed minimum.
 * enabled: whether the ruleset is on by default. Blocking value, not
 *           robustness. Lists that meaningfully break sites default to off.
 */
export interface FilterList {
  /** Ruleset id, file name under lists/ and extension/rules/. */
  name: string;
  /** Which popup toggle controls it. */
  group: ListGroup;
  tier: 1 | 2;
  enabled: boolean;
  url: string;
  note: string;
  /** For CREDITS.txt, only when the list's own header has no Title line. */
  title?: string;
}

export const LISTS: readonly FilterList[] = [
  // --- tier 1: core ---------------------------------------------------------
  {
    name: 'ubo-filters',
    group: 'ads',
    tier: 1,
    enabled: true,
    url: 'https://ublockorigin.github.io/uAssets/filters/filters.txt',
    note: "uBlock Origin's own filters, highest signal per rule",
  },
  {
    name: 'ubo-badware',
    group: 'ads',
    tier: 1,
    enabled: true,
    url: 'https://ublockorigin.github.io/uAssets/filters/badware.txt',
    note: 'Badware risks, malware/scam hosts',
  },
  {
    name: 'ubo-quick-fixes',
    group: 'ads',
    tier: 1,
    enabled: true,
    url: 'https://ublockorigin.github.io/uAssets/filters/quick-fixes.txt',
    note: 'Fast-moving fixes, updated more often than the main list',
  },
  {
    name: 'ubo-unbreak',
    group: 'ads',
    tier: 1,
    enabled: true,
    url: 'https://ublockorigin.github.io/uAssets/filters/unbreak.txt',
    note: 'Exception rules that repair sites the other lists break. Never drop this.',
  },
  {
    name: 'easylist',
    group: 'ads',
    tier: 1,
    enabled: true,
    url: 'https://easylist.to/easylist/easylist.txt',
    note: 'The baseline ad list',
  },

  // --- tier 2: optional -----------------------------------------------------
  {
    name: 'easyprivacy',
    group: 'tracking',
    tier: 2,
    enabled: true,
    url: 'https://easylist.to/easylist/easyprivacy.txt',
    note: 'Tracking and telemetry',
  },
  {
    name: 'ubo-privacy',
    group: 'tracking',
    tier: 2,
    enabled: true,
    url: 'https://ublockorigin.github.io/uAssets/filters/privacy.txt',
    note: "uBO's privacy additions",
  },
  {
    name: 'peter-lowe',
    group: 'tracking',
    tier: 2,
    enabled: true,
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext',
    note: 'Ad/tracking server list, cheap, almost all plain domain blocks',
    title: "Peter Lowe's ad and tracking server list",
  },
  {
    name: 'easylist-cookie',
    group: 'cookies',
    tier: 2,
    enabled: false,
    url: 'https://secure.fanboy.co.nz/fanboy-cookiemonster.txt',
    note: 'Cookie consent banners',
  },
  {
    name: 'fanboy-annoyance',
    group: 'annoyances',
    tier: 2,
    enabled: false,
    url: 'https://secure.fanboy.co.nz/fanboy-annoyance.txt',
    note: 'Overlays, newsletter nags, social widgets. Most likely list to break a site.',
  },
];
