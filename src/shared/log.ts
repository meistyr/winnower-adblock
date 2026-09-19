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

/** A line, plus how many identical ones it stands for. */
export interface GroupedLine extends LogLine {
  count: number;
}

/**
 * Fold identical lines from the same pass into one, carrying a count.
 *
 * A pass walks the whole page, so a grid of twenty identical cards produces
 * twenty identical lines — theverge.com wrote `div.up4voo8 — contains visible
 * media` twenty times in one pass, and twitch.tv's directory did the same for
 * every stream card. They are genuinely different elements, so they cannot be
 * deduplicated where they are recorded; but "this happened twenty times" is
 * the whole of what those twenty lines say.
 *
 * Grouped within a pass rather than only when adjacent: the repeats interleave
 * (card, title, thumbnail, card, title, thumbnail…), so adjacency misses them.
 * First-occurrence order is kept, which keeps the pass readable top to bottom.
 */
export function groupRepeats(lines: readonly LogLine[]): GroupedLine[] {
  const out: GroupedLine[] = [];
  const seen = new Map<string, GroupedLine>();
  for (const line of lines) {
    const key = `${line.host}|${line.t}|${line.layer}|${line.verb}|${line.subject}|${line.reason ?? ''}`;
    const existing = seen.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    const grouped: GroupedLine = { ...line, count: 1 };
    seen.set(key, grouped);
    out.push(grouped);
  }
  return out;
}

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
export function formatLine(line: LogLine, count = 1): string {
  const when = formatTime(line.t).padStart(6);
  const what = line.reason ? `${line.subject} — ${line.reason}` : line.subject;
  return `${when}  ${line.layer.padEnd(8)} ${line.verb.padEnd(8)} ${what}${count > 1 ? `  ×${count}` : ''}`;
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
  for (const line of groupRepeats(lines)) {
    if (line.host !== host) {
      host = line.host;
      out.push('', `— ${host || 'winnower'} —`);
    }
    out.push(formatLine(line, line.count));
  }
  if (out.length === (header ? 1 : 0)) out.push('(nothing recorded)');
  return out.join('\n').trim() + '\n';
}
