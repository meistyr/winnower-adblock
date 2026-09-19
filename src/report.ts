/**
 * The content script's end of the diagnostic log (ISOLATED world).
 *
 * A page is where most of winnower's decisions happen and the one place it
 * cannot keep them: a content script's world is torn down on navigation. So
 * lines are batched here and handed to the worker, which holds them — see the
 * log section of src/sw.ts.
 *
 * Batched rather than sent one at a time because a loading page reports in
 * bursts, and each sendMessage is a round trip that can wake a sleeping worker.
 * A collapse pass alone can produce dozens of lines in a few milliseconds.
 *
 * Filtered here as well as in the worker. The worker's check is what makes
 * "errors are always kept" true of every path; this one is what stops a page
 * paying to serialise and post thousands of lines that would then be dropped.
 */
import { isAlwaysKept, type LogLayer, type LogLine, type LogVerb } from './shared/log.ts';
import type { Message } from './shared/messages.ts';

/** Off until the worker's reply says otherwise, so a page records nothing by default. */
let dev = false;

/** Bounded: a page that never stops reporting must not grow this without limit. */
const QUEUE_CAP = 200;
const BATCH_MS = 500;

let queue: LogLine[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;

/** Told by the worker's cosmetic reply, which the content script asks for at document_start. */
export function setDev(on: boolean): void {
  dev = on;
}

/**
 * Record one decision.
 *
 * `t` is milliseconds since this page started rather than a wall clock: the
 * question asked of these lines is "what order did things happen in, and how
 * long after load", and a clock time answers neither without arithmetic.
 */
export function report(layer: LogLayer, verb: LogVerb, subject: string, reason?: string): void {
  const line: LogLine = { t: Math.round(performance.now()), layer, verb, subject, reason };
  if (!dev && !isAlwaysKept(line)) return;
  queue.push(line);
  if (queue.length > QUEUE_CAP) queue = queue.slice(-QUEUE_CAP);
  if (timer === undefined) timer = setTimeout(flush, BATCH_MS);
}

/** Hand everything queued to the worker. */
export function flush(): void {
  timer = undefined;
  if (!queue.length) return;
  const lines = queue;
  queue = [];
  try {
    // The callback exists only to read lastError. The worker answers this
    // message with nothing, so without one Chrome logs "message port closed"
    // into the page's console — noise from a logger is a poor first impression.
    chrome.runtime.sendMessage({ type: 'winnower:log', lines } satisfies Message, () => {
      void chrome.runtime.lastError;
    });
  } catch {
    /* extension reloaded out from under the page; the lines are not worth a retry */
  }
}
