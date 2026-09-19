/**
 * What winnower records about its own decisions, and how that reads.
 *
 * winnower logged nothing at all until now: no console calls anywhere in src/,
 * and empty catch blocks, so a failure left no trace and the code carried on.
 * That is the right default for someone using it and a poor one for anyone
 * working on it — a reported broken site could only be investigated by driving
 * a browser and inspecting the page by hand.
 *
 * Two levels, decided per line rather than per session:
 *   - errors are ALWAYS kept, so someone reporting a broken site has something
 *     to paste without first reproducing it with a switch turned on
 *   - everything else is kept only while developer mode is on, because a line
 *     per decision is thousands of lines per page and names every site visited
 *
 * Nothing here touches chrome.* or the DOM, so it type-checks under both
 * tsconfigs and build/validate.ts can assert the formatting directly — the same
 * arrangement as shared/popup-match.ts and shared/collapse-match.ts.
 */

/** Which part of winnower spoke. Each runs in a different place. */
export type LogLayer = 'net' | 'cosmetic' | 'collapse' | 'popup' | 'worker';

/** What it did. `error` is the only one kept when developer mode is off. */
export type LogVerb =
  | 'blocked' | 'applied' | 'hid' | 'restored' | 'allowed' | 'paused' | 'skip' | 'error';

export interface LogLine {
  /** Milliseconds since this page — or the worker — started. */
  t: number;
  layer: LogLayer;
  verb: LogVerb;
  /** What it acted on: a host, a selector, an element. */
  subject: string;
  /** WHY. The column that matters; without it a log says what happened and not why. */
  reason?: string;
  /** The site it happened on. Filled in by the worker from the sender, not trusted from the page. */
  host?: string;
}

/**
 * How many lines the worker keeps.
 *
 * Small on purpose. This is a diagnostic tail, not a history: the useful
 * question is "what just happened on the page I am looking at", and an
 * unbounded buffer holding every site visited is a liability rather than a
 * feature.
 */
export const LOG_CAP = 500;

/** Kept even with developer mode off. */
export const isAlwaysKept = (line: LogLine): boolean => line.verb === 'error';

/** `802ms`, `1.2s` — short enough for a narrow column, precise enough to order by. */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * One line, as it appears in the menu and on the clipboard.
 *
 * Fixed columns so a wall of these can be scanned down rather than read across:
 * when, which part, what it did, what it did it to — and the reason after the
 * dash.
 */
export function formatLine(line: LogLine): string {
  const when = formatTime(line.t).padStart(6);
  const what = line.reason ? `${line.subject} — ${line.reason}` : line.subject;
  return `${when}  ${line.layer.padEnd(8)} ${line.verb.padEnd(8)} ${what}`;
}

/**
 * The whole log as one block of text, for the menu's Copy button.
 *
 * Grouped by site with a rule between, because a pasted log is read by someone
 * who was not there and needs to know which page each run belongs to.
 */
export function formatLog(lines: readonly LogLine[], header?: string): string {
  const out: string[] = header ? [header] : [];
  let host: string | undefined;
  for (const line of lines) {
    if (line.host !== host) {
      host = line.host;
      out.push('', `— ${host || 'winnower'} —`);
    }
    out.push(formatLine(line));
  }
  if (out.length === (header ? 1 : 0)) out.push('(nothing recorded)');
  return out.join('\n').trim() + '\n';
}
