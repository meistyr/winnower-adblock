/**
 * winnower's empty-wrapper collapser (ISOLATED world, same as its caller).
 *
 * Kept apart from the content script because it is a different job. It never
 * reads a filter list and does not know what a selector is — it looks at the
 * page's own geometry and guesses which empty boxes used to hold something
 * winnower hid. Every bug in this area has come from that guessing, so it earns
 * being readable on its own.
 *
 * The switch is honoured here too: passes are scheduled before the worker's
 * reply arrives, so they check `off` rather than assume.
 */

/**
 * Publish how many wrappers are collapsed right now.
 *
 * A running total written once could not stay true: it was set at 6500ms while
 * a collapse pass still runs at 7000ms, and it never came down when a restore
 * sweep put something back. So it reported "collapsed by 6500ms", not
 * "collapsed" — and it is the handle used to check this from a page, so it is
 * the last thing that should lie. Counting the marks is always current.
 *
 * The key stays distinct from the per-element data-winnower-collapsed marker.
 * Reusing that name put the counter on <html>, which then matched the query
 * below and made a one-element bug look like the whole page had been eaten.
 */
function publishCount(): void {
  try {
    document.documentElement.dataset.winnowerCollapsedCount =
      String(document.querySelectorAll('[data-winnower-collapsed]').length);
  } catch {}
}

/**
 * Restore anything we collapsed that has since gained real content.
 *
 * Guards evaluated at collapse time are not enough on their own. YouTube's
 * #guide-inner-content is genuinely empty during early passes — 0 children,
 * 0 links, real height, hidden descendants — so it satisfied every check, and
 * by the time it held 635 descendants and 38 links it was already hidden and
 * marked. Re-checking each pass makes the collapse self-healing instead of
 * permanent.
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
  if (restored) publishCount();
  return restored;
}

// Set once the worker confirms this site is allowlisted, the master switch is
// off, or the switches could not be read at all. Collapse passes are scheduled
// before that reply arrives, so they must check it rather than assume.
let off = false;

/**
 * Collapse wrappers left holding empty space after their ad child is hidden.
 *
 * Many sites generate their class names (The Verge ships `o1ls9u`, `o1ls91s` —
 * CSS-in-JS hashes that change on rebuild), so filter lists have nothing stable
 * to target on the wrapper. Hiding the ad child leaves a parent that still has
 * its own min-height: measured 2066x250, 800x90 and 380x250 holes on
 * theverge.com with every actual ad element correctly at height 0.
 *
 * Deliberately conservative — this is a heuristic and the failure mode is
 * eating real content:
 *   - requires a hidden descendant, so an empty box alone is never enough
 *   - refuses anything containing visible text, media, or a form control
 *   - refuses structural landmarks (main, article, nav, aside, ...)
 *   - ignores boxes too small to be a visible gap, or large enough to be a
 *     page-level container rather than an ad slot
 *
 * The guards are ordered cheapest-first on purpose. Measured on theverge.com:
 * of 3,088 candidates, 2,236 are rejected by one getBoundingClientRect and 750
 * more by innerText, leaving ~24 to reach the getComputedStyle walk over a
 * whole subtree. That ordering is why a full pass costs 16ms rather than
 * seconds. Move the expensive check earlier and it stops being viable.
 */
function collapseEmptyWrappers(): number {
  if (off) return 0;
  const KEEP = new Set(['BODY', 'HTML', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ARTICLE', 'SECTION', 'ASIDE']);
  let collapsed = 0;

  restoreWronglyCollapsed();

  // Keyed off the signal rather than a selector list. The first attempt walked
  // up from elements matching the domain selectors, which found nothing: the ad
  // on theverge.com is hidden by a GENERIC rule (.m-ad), and the generic set
  // exists only as a stylesheet, never as data here.
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

    // Size and interactivity guards. Added after this pass collapsed YouTube's
    // #guide-inner-content — the navigation menu, 45 links and 64 buttons —
    // because a pass happened to run while the guide was still unpopulated:
    // real height, no text yet, hidden children. It looked exactly like an
    // emptied ad wrapper, and the collapse was permanent.
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

    // Two strikes. A container that is merely slow to populate looks identical
    // to an emptied ad wrapper on any single pass, so require it to still
    // qualify on a later pass before acting. This is what stops the menu being
    // hidden at all, rather than hidden and then restored.
    if (!node.dataset.winnowerCandidate) {
      node.dataset.winnowerCandidate = '1';
      continue;
    }

    node.dataset.winnowerCollapsed = '1';
    node.style.setProperty('display', 'none', 'important');
    collapsed += 1;
  }
  if (collapsed) publishCount();
  return collapsed;
}

/** Run one pass now. Used after the domain rules land, which may have just emptied a wrapper. */
export function pass(): void {
  collapseEmptyWrappers();
}

/**
 * Schedule the staged passes, then the restore-only sweeps.
 *
 * Staged re-runs rather than a MutationObserver: the observer would fire
 * constantly on feed-style pages for no benefit, since ad wrappers appear early
 * and then stay put. The later sweeps catch anything that populates after the
 * passes stop — lazy sections, a menu opened for the first time.
 *
 * This runs independently of the domain lookup. It must not be driven by the
 * worker's reply, which returns early when a domain has no specific selectors:
 * the generic stylesheet still hid things on those pages, and theverge.com's
 * leftover slots come from a generic rule, not a domain one.
 */
export function start(): void {
  document.addEventListener('DOMContentLoaded', pass, { once: true });
  for (const ms of [800, 2000, 4000, 7000]) setTimeout(pass, ms);
  for (const ms of [10000, 15000, 25000]) setTimeout(restoreWronglyCollapsed, ms);
}

/**
 * Stop collapsing, and put back everything already collapsed.
 *
 * Called when the site turns out to be paused, or when the switches could not
 * be read at all. The two always go together: leaving boxes hidden after
 * deciding not to filter would be the same bug from the other end.
 */
export function disable(): void {
  off = true;
  for (const n of document.querySelectorAll<HTMLElement>('[data-winnower-collapsed]')) {
    n.style.removeProperty('display');
    delete n.dataset.winnowerCollapsed;
  }
  publishCount();
}
