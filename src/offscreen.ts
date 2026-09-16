/**
 * Reports Chrome's light/dark mode to the service worker.
 *
 * A service worker has no window, so it cannot evaluate prefers-color-scheme.
 * An offscreen document with the MATCH_MEDIA reason exists for exactly this. It
 * stays open and reports once on load, then again on every change.
 */
import type { Message } from './shared/messages.ts';

const query = matchMedia('(prefers-color-scheme: dark)');
const report = () =>
  chrome.runtime.sendMessage({ type: 'winnower:colorScheme', dark: query.matches } satisfies Message).catch(() => {});
query.addEventListener('change', report);
report();
