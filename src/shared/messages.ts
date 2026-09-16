/**
 * The runtime message protocol between the extension's contexts and the
 * service worker. Every message the worker handles is a member of Message, and
 * Replies maps each message type to what the worker sends back, so a sender
 * and the handler cannot disagree about a field without failing the type check.
 */
import type { RulesetEntry } from './catalogue.ts';

export type Message =
  /** cosmetic content script: which selectors apply to this host? */
  | { type: 'winnower:cosmetic'; hostname: string }
  /** popup: everything it renders for the active tab */
  | { type: 'winnower:state'; tabId: number | undefined; hostname: string }
  | { type: 'winnower:toggleSite'; hostname: string }
  | { type: 'winnower:toggleMaster' }
  | { type: 'winnower:toggleGroup'; ids: string[] }
  /** offscreen document: Chrome's light/dark mode, for the toolbar icon */
  | { type: 'winnower:colorScheme'; dark: boolean };

export interface PopupState {
  host: string;
  allowlisted: boolean;
  master: boolean;
  allowlist: string[];
  blocked: number;
  rulesets: Array<RulesetEntry & { enabled: boolean }>;
}

export interface Replies {
  'winnower:cosmetic': { selectors: string[]; off: boolean };
  'winnower:state': PopupState | null;
  'winnower:toggleSite': { allowlisted: boolean } | null;
  'winnower:toggleMaster': { master: boolean } | null;
  'winnower:toggleGroup': { enabled: boolean } | { error: string };
  'winnower:colorScheme': undefined;
}

export type MessageType = Message['type'];
export type Reply<T extends MessageType> = Replies[T];
