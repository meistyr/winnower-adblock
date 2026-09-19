/**
 * The runtime message protocol between the extension's contexts and the
 * service worker. Every message the worker handles is a member of Message, and
 * Replies maps each message type to what the worker sends back, so a sender
 * and the handler cannot disagree about a field without failing the type check.
 */
import type { RulesetEntry } from './catalogue.ts';
import type { LogLine } from './log.ts';

export type Message =
  /** cosmetic content script: which selectors apply to this host? */
  | { type: 'winnower:cosmetic'; hostname: string }
  /** popup: everything it renders for the active tab */
  | { type: 'winnower:state'; tabId: number | undefined; hostname: string }
  | { type: 'winnower:toggleSite'; hostname: string }
  | { type: 'winnower:toggleMaster' }
  | { type: 'winnower:toggleGroup'; ids: string[] }
  /** content scripts: a batch of recorded decisions, for the worker to keep */
  | { type: 'winnower:log'; lines: LogLine[] }
  /** popup: the recorded lines, and whether developer mode is on */
  | { type: 'winnower:diagnostics' }
  | { type: 'winnower:clearDiagnostics' }
  | { type: 'winnower:toggleDev' }
  /** popup: is a newer release out? Answered from a cache checked at most daily. */
  | { type: 'winnower:update' }
  /** offscreen document: Chrome's light/dark mode, for the toolbar icon */
  | { type: 'winnower:colorScheme'; dark: boolean };

export interface PopupState {
  host: string;
  allowlisted: boolean;
  master: boolean;
  allowlist: string[];
  blocked: number;
  rulesets: Array<RulesetEntry & { enabled: boolean }>;
  /** Developer mode: record every decision, not only errors. */
  dev: boolean;
  /** How many lines are held right now, for the Diagnostics row's count. */
  recorded: number;
}

export interface Replies {
  /**
   * `dev` rides along with the selectors rather than being a second round
   * trip: the content script needs to know at document_start whether to record
   * anything, and it is already asking this question then.
   */
  'winnower:cosmetic': { selectors: string[]; off: boolean; dev: boolean };
  'winnower:state': PopupState | null;
  'winnower:toggleSite': { allowlisted: boolean } | null;
  'winnower:toggleMaster': { master: boolean } | null;
  'winnower:toggleGroup': { enabled: boolean } | { error: string };
  'winnower:log': undefined;
  'winnower:diagnostics': { lines: LogLine[]; dev: boolean } | null;
  'winnower:clearDiagnostics': { recorded: number } | null;
  'winnower:toggleDev': { dev: boolean } | null;
  'winnower:update': { latest: string; newer: boolean } | null;
  'winnower:colorScheme': undefined;
}

export type MessageType = Message['type'];
export type Reply<T extends MessageType> = Replies[T];
