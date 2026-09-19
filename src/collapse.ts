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
import { collapseVerdict } from './shared/collapse-match.ts';
import { HID_MARKER } from './shared/constants.ts';

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
 * Did WINNOWER hide this element, as opposed to the page hiding its own?
 *
 * getComputedStyle answers what an element looks like, never who made it look
 * that way, and that gap is what broke twitch.tv: the collapser accepted "the
 * page hid one of its own divs" as proof that IT had emptied the box. So every
 * winnower hide rule now carries HID_MARKER (src/shared/constants.ts) and this
 * asks for the marker, not just the state.
 *
 * Custom properties inherit, so everything inside a hidden element reports the
 * marker too. Harmless: a box containing such a descendant but not the marked
 * element itself is necessarily INSIDE the marked element, which is already
 * hidden, so collapsing there changes nothing on screen.
 *
 * Winnower's own collapses are deliberately not detected here. They are applied
 * inline and carry no marker, which ends a ratchet: hiding a box used to make
 * its parent qualify on the strength of that hide, and the parent's parent
 * after that. On twitch.tv the marker-less chain reached the player slot.
 */
function isHiddenByWinnower(el: Element): boolean {
  const s = getComputedStyle(el);
  if (s.display !== 'none') return false;
  return s.getPropertyValue(HID_MARKER).trim() === '1';
}

/**
 * Collapse wrappers left holding empty space after their ad child is hidden.
 *
 * Many sites generate their class names (The Verge ships `o1ls9u`, `o1ls91s` —
 * CSS-in-JS hashes that change on rebuild), so filter lists have nothing stable
 * to target on the wrapper. Hiding the ad child leaves a parent that still has
 * its own min-height: measured 2066x250, 800x90 and 380x250 holes on
 * theverge.com with every actual ad element correctly at height 0.
 *
 * This function finds the boxes and reads their facts. Whether a box qualifies
 * is src/shared/collapse-match.ts, which build/validate.ts runs against fixed
 * shapes — so the judgement that has twice gone wrong here can be asked about
 * directly instead of only observed in a browser afterwards.
 *
 * THE FACTS GO IN AS GETTERS, NOT VALUES. collapseVerdict reads them
 * cheapest-first and returns at the first refusal, so an expensive fact is
 * never computed for a box a cheap one already rejected. Measured on
 * theverge.com: of 3,088 candidates, 2,236 die on the rect and 750 more on the
 * text, leaving ~24 to reach the getComputedStyle walk. Pass a plain object of
 * computed values instead and all 3,088 pay for all of it — 16ms per pass
 * becomes seconds on a feed page.
 */
function collapseEmptyWrappers(): number {
  if (off) return 0;
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

    // Both memoised: each is read more than once by the facts below, and each
    // is a layout or a tree walk. Neither runs unless a fact that needs it is
    // actually reached.
    let rect: DOMRect | undefined;
    const box = () => (rect ??= node.getBoundingClientRect());
    let kids: NodeListOf<Element> | undefined;
    const subtree = () => (kids ??= node.querySelectorAll('*'));

    const verdict = collapseVerdict({
      tagName: node.tagName,
      get width() { return box().width; },
      get height() { return box().height; },
      get textLength() { return (node.innerText || '').trim().length; },
      get hasFormOrMedia() { return !!node.querySelector('input,button,select,textarea,video,audio'); },
      get subtreeCount() { return subtree().length; },
      get hasAnchor() { return !!node.querySelector('a[href]'); },
      get hasAriaOrRole() { return !!node.querySelector('[role],[tabindex],[aria-label]'); },
      get hasVisibleMedia() {
        return [...node.querySelectorAll('img,svg,canvas,iframe,picture')].some((m) => {
          const b = m.getBoundingClientRect();
          return b.height > 8 && b.width > 8;
        });
      },
      get hasWinnowerHiddenDescendant() { return [...subtree()].some(isHiddenByWinnower); },
      get seenBefore() { return !!node.dataset.winnowerCandidate; },
    });

    if (verdict === 'skip') continue;
    if (verdict === 'candidate') {
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
