/**
 * winnower's content script (ISOLATED world — needs chrome.runtime).
 *
 * Chrome injects this into every frame, top-level and embedded alike. It does
 * three things:
 *   - asks the worker whether winnower is switched on for this page
 *   - injects the domain-specific selectors if it is
 *   - starts the empty-wrapper collapser (src/collapse.ts)
 *
 * The generic stylesheet is injected natively by the manifest before first
 * paint, so it needs nothing from here except the attribute that gates it.
 * Only the domain-specific selectors are fetched, which is why an async
 * round-trip is acceptable: the containers those rules target (ad slots,
 * promoted tiles) are rendered by page JS well after load, and a stylesheet
 * applies to elements added later anyway.
 *
 * The question this script asks names its OWN hostname. The worker deliberately
 * ignores that when deciding on or off, because an embedded frame reports
 * itself and a pause is scoped to the page — see the handler in src/sw.ts.
 */
import type { Message, Reply } from './shared/messages.ts';
import { HIDE_DECLARATION } from './shared/constants.ts';
import * as collapse from './collapse.ts';
import * as log from './report.ts';

(() => {
  const STYLE_ID = 'winnower-cosmetic';
  if (document.getElementById(STYLE_ID)) return;

  collapse.start();

  // A content script's world goes away on navigation, taking anything still
  // queued with it — and the last few lines before a page is left are usually
  // the interesting ones.
  addEventListener('pagehide', () => log.flush(), { once: true });

  /**
   * Ask the worker for this frame's selectors, retrying a lost reply.
   *
   * Sending a message wakes a sleeping worker, so a missing reply is a
   * transient race during an extension reload or teardown rather than a settled
   * state. Giving up on the first lastError meant the switches silently did
   * nothing: data-winnower-off was never set, so every rule in generic.css
   * stayed live, and every collapse pass ran on a site that had been paused.
   * Intermittent, so it read as an unreliable switch rather than a bug.
   */
  const RETRY_DELAYS = [100, 400, 1200];
  let attempt = 0;

  /** Gate generic.css off, and stop the collapser. Every "do not filter" path ends here. */
  function stepBack(): void {
    // The generic stylesheet is injected by the manifest and cannot be removed
    // from here, but every rule in it is gated on html:not([data-winnower-off])
    // — so this one attribute disables all of it.
    document.documentElement.dataset.winnowerOff = '1';
    collapse.disable();
  }

  function onReply(reply: Reply<'winnower:cosmetic'> | undefined): void {
    if (chrome.runtime.lastError || !reply) {
      if (attempt < RETRY_DELAYS.length) {
        setTimeout(ask, RETRY_DELAYS[attempt++]);
        return;
      }
      // Out of attempts, so the switches cannot be read at all. Paused means
      // paused: step back entirely rather than risk filtering a site that was
      // paused. An ad slipping through is visible and fixes itself on the next
      // load; a page quietly broken by a pause that did not take is neither —
      // it gets blamed on the site, which is how this class of bug survives.
      //
      // Recorded as an error, so it is kept even with developer mode off. This
      // is precisely the state where winnower silently does nothing at all, and
      // until now it left no trace whatsoever.
      log.report('cosmetic', 'error', location.hostname, `no reply from the worker after ${attempt} attempts — stepping back`);
      log.flush();
      stepBack();
      return;
    }

    log.setDev(reply.dev === true);

    if (reply.off) {
      log.report('cosmetic', 'paused', location.hostname, 'allowlisted, or the master switch is off');
      log.flush();
      stepBack(); // allowlisted, or the master switch is off
      return;
    }

    const selectors = reply.selectors ?? [];
    if (selectors.length === 0) {
      log.report('cosmetic', 'applied', location.hostname, 'generic rules only, no rules for this site');
      return;
    }
    log.report('cosmetic', 'applied', location.hostname, `${selectors.length} rules for this site`);

    // Chunked for the same reason as generic.css: Blink silently truncates an
    // over-long selector list in a single rule, and in CSS one invalid selector
    // invalidates every selector sharing its rule. Domain lists are small today
    // (~90 max), so this is insurance rather than a live fix.
    //
    // HIDE_DECLARATION rather than a literal: it carries the marker that lets
    // the collapser recognise winnower's own hiding, and generic.css emits the
    // same constant. A domain rule that hid without marking would leave the
    // collapser blind to exactly the boxes these selectors just emptied.
    const CHUNK = 500;
    const parts: string[] = [];
    for (let i = 0; i < selectors.length; i += CHUNK) {
      parts.push(selectors.slice(i, i + CHUNK).join(',\n') + '\n' + HIDE_DECLARATION);
    }

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = parts.join('\n');

    // documentElement exists at document_start; head may not yet.
    (document.head || document.documentElement).appendChild(style);

    // One extra pass now that the domain rules are live — they may have just
    // emptied a wrapper the earlier passes saw as still populated.
    collapse.pass();

    // Verification handle. Written to the DOM, not to window: this script runs
    // in the ISOLATED world, which has its own window object, so a property set
    // there is invisible to the page and to anything inspecting from the main
    // world. The documentElement is shared between worlds.
    try {
      document.documentElement.dataset.winnowerCosmetic = String(selectors.length);
    } catch {}
  }

  function ask(): void {
    chrome.runtime.sendMessage(
      { type: 'winnower:cosmetic', hostname: location.hostname } satisfies Message,
      onReply,
    );
  }

  ask();
})();
