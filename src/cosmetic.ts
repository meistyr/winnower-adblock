/**
 * winnower cosmetic injector (ISOLATED world — needs chrome.runtime).
 *
 * The generic stylesheet is injected natively by the manifest before first
 * paint. This handles only the domain-specific selectors, which are fetched
 * per-hostname via the service worker.
 *
 * The async round-trip is acceptable because the containers these rules target
 * (ad slots, promoted tiles) are rendered by page JS well after load. A
 * MutationObserver is not needed for the CSS itself — a stylesheet applies to
 * elements added later automatically.
 */
import type { Message, Reply } from './shared/messages.ts';

(() => {
  const STYLE_ID = 'winnower-cosmetic';
  if (document.getElementById(STYLE_ID)) return;

  /**
   * Collapse wrappers left holding empty space after their ad child is hidden.
   *
   * Many sites generate their class names (The Verge ships `o1ls9u`, `o1ls91s`
   * — CSS-in-JS hashes that change on rebuild), so filter lists have nothing
   * stable to target on the wrapper. Hiding the ad child leaves a parent that
   * still has its own min-height: measured 2066x250, 800x90 and 380x250 holes
   * on theverge.com with every actual ad element correctly at height 0.
   *
   * Deliberately conservative — this is a heuristic and the failure mode is
   * eating real content:
   *   - requires a hidden descendant, so an empty box alone is never enough
   *   - refuses anything containing visible text, media, or a form control
   *   - refuses structural landmarks (main, article, nav, aside, ...)
   *   - ignores boxes too small to be a visible gap, or large enough to be a
   *     page-level container rather than an ad slot
   */
  /**
   * Restore anything we collapsed that has since gained real content.
   *
   * Guards evaluated at collapse time are not enough on their own. YouTube's
   * #guide-inner-content is genuinely empty during early passes — 0 children,
   * 0 links, real height, hidden descendants — so it satisfied every check,
   * and by the time it held 635 descendants and 38 links it was already hidden
   * and marked. Re-checking each pass makes the collapse self-healing instead
   * of permanent.
   */
  function restoreWronglyCollapsed(): number {
    let restored = 0;
    for (const node of document.querySelectorAll<HTMLElement>('[data-winnower-collapsed]')) {
      const populated =
        node.querySelectorAll('*').length > 20 ||
        node.querySelector('a[href],[role],[tabindex],[aria-label],button,input,video,audio,canvas') ||
        (node.textContent || '').trim().length > 2;
      if (!populated) continue;
      node.style.removeProperty('display');
      delete node.dataset.winnowerCollapsed;
      restored += 1;
    }
    return restored;
  }

  // Set once the worker confirms this site is allowlisted (or the master switch
  // is off). Collapse passes are scheduled before that reply arrives, so they
  // must check it rather than assume.
  let off = false;

  function collapseEmptyWrappers(): number {
    if (off) return 0;
    const KEEP = new Set(['BODY', 'HTML', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ARTICLE', 'SECTION', 'ASIDE']);
    let collapsed = 0;

    restoreWronglyCollapsed();

    // Keyed off the signal rather than a selector list. The first attempt
    // walked up from elements matching the domain selectors, which found
    // nothing: the ad on theverge.com is hidden by a GENERIC rule (.m-ad), and
    // the generic set exists only as a stylesheet, never as data here.
    //
    // The shape we are looking for is a box that occupies real space, shows
    // nothing, and contains something we hid.
    for (const node of document.querySelectorAll<HTMLElement>('div,span,section > div,li')) {
      if (node.dataset.winnowerCollapsed) continue;
      if (KEEP.has(node.tagName)) continue;

      const r = node.getBoundingClientRect();
      if (r.height < 40 || r.width < 100) continue;      // too small to be a visible gap
      if (r.height > 1400) continue;                      // page-level container, not a slot

      if ((node.innerText || '').trim().length > 2) continue;
      if (node.querySelector('input,button,select,textarea,video,audio')) continue;

      // Size and interactivity guards. Added after this pass collapsed
      // YouTube's #guide-inner-content — the navigation menu, 45 links and 64
      // buttons — because a pass happened to run while the guide was still
      // unpopulated: real height, no text yet, hidden children. It looked
      // exactly like an emptied ad wrapper, and the collapse was permanent.
      //
      // An ad slot is a small, non-interactive leaf. Real UI is neither.
      const subtree = node.querySelectorAll('*');
      if (subtree.length > 20) continue;
      if (node.querySelector('a[href]')) continue;
      if (node.querySelector('[role],[tabindex],[aria-label]')) continue;

      const hasMedia = [...node.querySelectorAll('img,svg,canvas,iframe,picture')].some((m) => {
        const b = m.getBoundingClientRect();
        return b.height > 8 && b.width > 8;
      });
      if (hasMedia) continue;

      // The deciding evidence: something inside it is hidden. An empty box with
      // no hidden descendant is far more likely to be a spacer or a not-yet-
      // populated container than a wrapper we emptied.
      const hasHiddenChild = [...subtree].some((c) => getComputedStyle(c).display === 'none');
      if (!hasHiddenChild) continue;

      // Two strikes. A container that is merely slow to populate looks
      // identical to an emptied ad wrapper on any single pass, so require it to
      // still qualify on a later pass before acting. This is what stops the
      // menu being hidden at all, rather than hidden and then restored.
      if (!node.dataset.winnowerCandidate) {
        node.dataset.winnowerCandidate = '1';
        continue;
      }

      node.dataset.winnowerCollapsed = '1';
      node.style.setProperty('display', 'none', 'important');
      collapsed += 1;
    }
    return collapsed;
  }

  // Collapse runs independently of the domain lookup. It must not sit inside
  // the callback below, which returns early when a domain has no specific
  // selectors — the generic stylesheet still hid things on those pages, and
  // theverge.com's leftover slots come from a generic rule, not a domain one.
  //
  // Staged re-runs rather than a MutationObserver: the observer would fire
  // constantly on feed-style pages for no benefit, since ad wrappers appear
  // early and then stay put.
  let collapsedTotal = 0;
  const collapsePass = () => { collapsedTotal += collapseEmptyWrappers(); };
  document.addEventListener('DOMContentLoaded', collapsePass, { once: true });
  for (const ms of [800, 2000, 4000, 7000]) setTimeout(collapsePass, ms);
  // Restore-only sweeps after the collapse passes stop, to catch anything that
  // populates late (lazy sections, a menu opened for the first time).
  for (const ms of [10000, 15000, 25000]) setTimeout(restoreWronglyCollapsed, ms);
  setTimeout(() => {
    try {
      // Distinct from the per-element data-winnower-collapsed marker: reusing
      // that name put the counter on <html>, so querying for collapsed elements
      // returned the document itself and made a one-element bug look like the
      // whole page had been eaten.
      document.documentElement.dataset.winnowerCollapsedCount = String(collapsedTotal);
    } catch {}
  }, 6500);

  chrome.runtime.sendMessage(
    { type: 'winnower:cosmetic', hostname: location.hostname } satisfies Message,
    (reply: Reply<'winnower:cosmetic'> | undefined) => {
      if (chrome.runtime.lastError) return; // worker asleep or reloading

      if (reply?.off) {
        // Allowlisted, or master switch off. The generic stylesheet is
        // injected by the manifest and cannot be removed from here, but every
        // rule in it is gated on html:not([data-winnower-off]) — so this one
        // attribute disables all of it. Then undo anything already collapsed.
        off = true;
        document.documentElement.dataset.winnowerOff = '1';
        for (const n of document.querySelectorAll<HTMLElement>('[data-winnower-collapsed]')) {
          n.style.removeProperty('display');
          delete n.dataset.winnowerCollapsed;
        }
        return;
      }

      const selectors = reply?.selectors ?? [];
      if (selectors.length === 0) return;

      // Chunked for the same reason as generic.css: Blink silently truncates
      // an over-long selector list in a single rule, and in CSS one invalid
      // selector invalidates every selector sharing its rule. Domain lists are
      // small today (~90 max), so this is insurance rather than a live fix.
      const CHUNK = 500;
      const parts: string[] = [];
      for (let i = 0; i < selectors.length; i += CHUNK) {
        parts.push(selectors.slice(i, i + CHUNK).join(',\n') + '\n{display:none!important}');
      }

      const style = document.createElement('style');
      style.id = STYLE_ID;
      style.textContent = parts.join('\n');

      // documentElement exists at document_start; head may not yet.
      (document.head || document.documentElement).appendChild(style);

      // One extra pass now that the domain rules are live — they may have just
      // emptied a wrapper the earlier passes saw as still populated.
      collapsePass();

      // Verification handle. Written to the DOM, not to window: this script
      // runs in the ISOLATED world, which has its own window object, so a
      // property set there is invisible to the page and to anything inspecting
      // from the main world. The documentElement is shared between worlds.
      try {
        document.documentElement.dataset.winnowerCosmetic = String(selectors.length);
      } catch {}
    },
  );
})();
