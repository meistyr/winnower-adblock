/**
 * The collapser's decision: is this box an ad wrapper winnower emptied?
 *
 * Shared by src/collapse.ts, which reads the facts off a real element, and
 * build/validate.ts, which runs it against fixed shapes at build time, so the
 * build checks exactly the decision that ships. Same arrangement as
 * src/shared/popup-match.ts.
 *
 * Kept apart from the DOM walk deliberately. Every bug in this area has been a
 * bug in the JUDGEMENT, not in the walking, a menu mistaken for an ad slot on
 * YouTube, a video player slot mistaken for one on Twitch, and a judgement
 * with no DOM in it can be asked about a shape directly, in a test, instead of
 * only being observed in a browser after the fact.
 */

/**
 * Tags never collapsed whatever else is true.
 *
 * Structural landmarks: hiding one of these is never "tidying a gap": it is
 * eating the page. Today src/collapse.ts only ever offers div, span and li, so
 * this is a backstop rather than a live filter, which is the point, since the
 * candidate selector is the kind of thing that gets widened later.
 */
const KEEP = new Set(['BODY', 'HTML', 'MAIN', 'HEADER', 'FOOTER', 'NAV', 'ARTICLE', 'SECTION', 'ASIDE']);

/**
 * What the decision needs to know about one box.
 *
 * READ IN ORDER, CHEAPEST FIRST. See collapseVerdict. Callers in a page supply
 * these as lazy getters so the expensive ones are never computed for a box that
 * a cheap one already rejected.
 */
export interface BoxFacts {
  /** Uppercase, as the DOM reports it. */
  readonly tagName: string;
  readonly width: number;
  readonly height: number;
  /** Trimmed length of the box's rendered text. */
  readonly textLength: number;
  /** Contains a form control or a media element. */
  readonly hasFormOrMedia: boolean;
  /** Number of descendant elements. */
  readonly subtreeCount: number;
  readonly hasAnchor: boolean;
  /** Contains [role], [tabindex] or [aria-label], i.e. real UI. */
  readonly hasAriaOrRole: boolean;
  /** Contains an img/svg/canvas/iframe/picture bigger than 8x8. */
  readonly hasVisibleMedia: boolean;
  /** Contains something WINNOWER hid, not merely something hidden. */
  readonly hasWinnowerHiddenDescendant: boolean;
  /** Already qualified on an earlier pass. */
  readonly seenBefore: boolean;
}

/** skip: leave alone. candidate: qualifies, needs a second pass. collapse: hide it. */
export type Verdict = 'skip' | 'candidate' | 'collapse';

export interface Judgement {
  verdict: Verdict;
  /** Which guard decided it, in the words the diagnostic log prints. */
  reason: string;
  /**
   * Worth recording.
   *
   * A pass considers ~1,900 boxes on youtube.com and rejects 94% of them on
   * size or text alone, most of the page, in other words, and recording a
   * line for each would bury the handful that matter. True only once a box has
   * got far enough to look like an ad slot: refused by a late guard, or acted
   * on. The Twitch player slot was one of these; a 20x20 spacer is not.
   */
  noteworthy: boolean;
}

const skip = (reason: string, noteworthy = false): Judgement => ({ verdict: 'skip', reason, noteworthy });

/**
 * Judge one box.
 *
 * Deliberately conservative: this is a heuristic and its failure mode is
 * eating real content, so every check is a reason to REFUSE and only the last
 * line accepts.
 *
 * The order is load-bearing, not stylistic. Measured on theverge.com: of 3,088
 * candidate boxes, 2,236 are rejected on the rect alone and 750 more on the
 * text, leaving ~24 to reach a getComputedStyle walk over a whole subtree. That
 * is why a full pass costs 16ms rather than seconds. Move an expensive fact
 * earlier, or make the caller compute them all up front, and the collapser
 * stops being viable on a feed page.
 */
export function collapseVerdict(f: BoxFacts): Judgement {
  if (KEEP.has(f.tagName)) return skip('structural landmark');

  // Geometry. Too small to be a visible gap, or large enough to be a page-level
  // container rather than an ad slot.
  if (f.height < 40 || f.width < 100) return skip('too small to be a visible gap');
  if (f.height > 1400) return skip('page-level container, not a slot');

  // Shows something, so it is not an emptied box.
  if (f.textLength > 2) return skip('shows text');

  // From here the box is slot-shaped, so a refusal is worth recording.

  if (f.hasFormOrMedia) return skip('contains a control or a media element', true);

  // An ad slot is a small, non-interactive leaf. Real UI is neither. Added
  // after a pass collapsed YouTube's #guide-inner-content, the navigation
  // menu, 45 links and 64 buttons, because it happened to run while the guide
  // was still unpopulated: real height, no text yet, hidden children.
  if (f.subtreeCount > 20) return skip(`${f.subtreeCount} children`, true);
  if (f.hasAnchor) return skip('contains a link', true);
  if (f.hasAriaOrRole) return skip('contains real UI', true);
  if (f.hasVisibleMedia) return skip('contains visible media', true);

  // The deciding evidence, and the whole reason this is a judgement rather than
  // a filter: we only tidy up after OURSELVES.
  //
  // This used to ask whether anything inside was hidden, by anyone. Sites hide
  // their own UI constantly, so the box next door's business counted as proof
  // of ours. twitch.tv's player slot is nine empty divs, its real player is
  // positioned over it from elsewhere in the document, and one div that Twitch
  // itself had hidden was enough to get the whole player collapsed.
  if (!f.hasWinnowerHiddenDescendant) return skip('nothing of ours hidden inside', true);

  // Two strikes. A container merely slow to populate looks identical to an
  // emptied ad wrapper on any single pass, so make it qualify twice before
  // acting. This is what stops a slow menu being hidden at all, rather than
  // hidden and then restored.
  return f.seenBefore
    ? { verdict: 'collapse', reason: 'emptied wrapper', noteworthy: true }
    : { verdict: 'candidate', reason: 'qualifies, waiting for a second pass', noteworthy: true };
}
