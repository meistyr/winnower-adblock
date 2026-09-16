/**
 * Shapes of the JSON files the build writes into extension/ and the extension
 * reads back. Kept free of DOM, Node and chrome.* types: this module is checked
 * under both tsconfigs.
 */

export type ListGroup = 'ads' | 'tracking' | 'popups' | 'cookies' | 'annoyances';

/** One entry of rulesets.json (build/write-manifest.ts → worker → popup). */
export interface RulesetEntry {
  id: string;
  group: ListGroup;
  tier: 1 | 2;
  note: string;
}

/** One entry of dynamic-scripts.json: a MAIN-world script the worker registers. */
export interface DynamicScript {
  id: string;
  matches: string[];
  js: string[];
  runAt: 'document_start' | 'document_end' | 'document_idle';
  world: 'MAIN' | 'ISOLATED';
  allFrames: boolean;
}

/** Per-list conversion stats, as recorded in rules/_stats.json. */
export interface ListStats {
  name: string;
  tier: 1 | 2;
  filterId: number;
  rules: number;
  safe: number;
  unsafe: number;
  regexp: number;
  errors: number;
  limitations: number;
}

/** rules/_stats.json (build/convert-network.ts → popup rule counter). */
export interface BuildStats {
  generated: string;
  tier1: number;
  tier2: number;
  regexp: number;
  lists: ListStats[];
}

/** popup-patterns.json (build/convert-popup.ts → build/compile.ts → popup guard). */
export interface PopupPatterns {
  hosts: string[];
}
