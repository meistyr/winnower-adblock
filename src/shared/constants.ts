/** Dynamic allowlist rule ids live well clear of static rule ids. */
export const ALLOWLIST_RULE_BASE = 100_000;

/**
 * Priority of the dynamic allowlist rules. Must outrank every static rule, or
 * that rule keeps firing on an allowlisted site. It was 1,000,000, which looked
 * generous until measured: AdGuard's converter emits 119 rules at or above
 * that, peaking at 1,000,302 in ubo-unbreak. build/validate.ts asserts every
 * static rule stays below this, importing the same constant the worker uses.
 */
export const ALLOWLIST_PRIORITY = 2_000_000_000;

/**
 * Custom property stamped on everything winnower hides, so the collapser can
 * tell its own work from the site's.
 *
 * The collapser decides a box was an emptied ad wrapper partly on "something
 * inside it is hidden". getComputedStyle reports the RESULT of hiding and never
 * who caused it, so any site that hides its own UI supplied that evidence for
 * free. On twitch.tv that cost the video player: the page's player slot holds
 * nothing but empty divs (the real player is positioned over it from another
 * branch of the DOM), Twitch hid one of them with an inline style, and the
 * collapser read that as its own handiwork and hid the slot. Twitch then
 * measured the slot to place the player, got 0x0, and parked the player
 * offscreen, audio still playing, picture nowhere, the channel's own
 * background colour filling the hole.
 *
 * A marker only winnower emits turns "is this hidden" into "did WE hide this".
 * It also ends a ratchet: winnower's own collapses are display:none too, so
 * hiding one box used to make its parent qualify, and the parent's parent after
 * that. Collapsed nodes are hidden inline and carry no marker, so they stop
 * counting.
 */
export const HID_MARKER = '--winnower-hid';

/**
 * The declaration block on every winnower hide rule, in generic.css and in the
 * per-domain <style> the content script injects.
 *
 * One constant rather than three copies: src/collapse.ts only collapses when it
 * finds this, so a copy that drifted would not fail: it would quietly stop the
 * collapser finding any evidence at all, anywhere, and empty ad boxes would come
 * back with nothing logged. build/validate.ts asserts it survives into the built
 * stylesheet for the same reason.
 */
export const HIDE_DECLARATION = `{display:none!important;${HID_MARKER}:1}`;

/**
 * Where the update check asks, and where it sends people.
 *
 * Chrome does not auto-update an extension loaded unpacked, and winnower is
 * installed unpacked from a zip, so someone on an old version has no way to
 * learn a newer one exists without going and looking.
 *
 * This is the only request winnower makes after it is installed. Unauthenticated
 * and with no identifier of any kind, so GitHub sees an address asking a public
 * URL and nothing distinguishes one winnower from another. Nothing is collected
 * by winnower itself, there is no server to collect it to.
 */
export const RELEASES_API = 'https://api.github.com/repos/meistyr/winnower-adblock/releases/latest';

/**
 * Where the notice sends people: winnower's own download page, not the GitHub
 * release. Someone told there is a new version wants the instructions for
 * replacing the one they have, which is what that page is for.
 */
export const DOWNLOAD_PAGE = 'https://winnower.meistyr.tech/download';

/**
 * At most one check a day.
 *
 * GitHub allows 60 unauthenticated requests an hour per address, so this is
 * nowhere near a limit; the interval is about not making a request winnower has
 * no use for rather than about rate limits.
 */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The badge behind the blocked count: grey normally, brand green when an update is waiting. */
export const BADGE_IDLE = '#3d3d3d';
export const BADGE_UPDATE = '#7bd88f';
