/**
 * Netflix ad breaks, skipped in the player.
 *
 * Nothing on the network separates an ad from the episode. Both stream from the
 * same *.oca.nflxvideo.net servers, and the manifest listing the ad breaks
 * arrives through MSL (/msl/playapi/cadmium/licensedmanifest), which is
 * encrypted, so no network rule or json-prune scriptlet can reach it. The player
 * itself can: its ad manager reports the break that is showing and has
 * skipAdBreak(), which jumps to the next content segment without checking the
 * break's isSkippable flag.
 *
 * Hand-written rather than an AdGuard scriptlet (see build/scriptlet-rules.ts),
 * because no scriptlet calls into a player's internals. Those internals are not
 * a public API and Netflix can rename them in any release. Every step is
 * therefore guarded: when the path stops resolving, the ads play and nothing
 * else changes, and the popup reports "player not found" on a watch page.
 *
 * Also hides the pause ad, a full-screen layer shown while playback is paused.
 * Its art comes from nflxso.net, the same servers as every title's artwork, so
 * it cannot be blocked by URL either. Hiding the layer leaves the paused frame
 * and the player's own controls, which resume normally.
 *
 * Runs in the page's MAIN world (registered by the worker from
 * dynamic-scripts.json), where the netflix global lives.
 */

interface AdManager {
  getPresentingAdBreak(): object | null | undefined;
  skipAdBreak(offsetMs: number, adIndex: number, reason: string): void;
}

interface SessionPlayer {
  getAdManager(): AdManager | null | undefined;
  getCurrentTime(): number;
  seek(ms: number): void;
}

interface VideoPlayerApi {
  getAllPlayerSessionIds(): string[];
  getVideoPlayerBySessionId(id: string): SessionPlayer | null | undefined;
}

declare const netflix: { appContext?: { state?: { playerApp?: { getAPI?(): { videoPlayer?: VideoPlayerApi } } } } } | undefined;

/** How often to look for a break. One property read per player, so cheap. */
const TICK_MS = 250;
/**
 * Picture height samples kept while no break is showing: 40 ticks, 10 seconds.
 * The baseline is the oldest half, 5 to 10 seconds before the break. The last
 * few samples are taken while the player is already switching to the ad stream
 * and read low (480x270 in testing).
 */
const HISTORY = 40;
/** Wait after a skip before judging the picture, so the player has settled. */
const SETTLE_MS = 1500;
/** The pause ad's layer, as Netflix labels it. */
const PAUSE_AD = '[data-uia="pause-ad"]';

(() => {
  if (window.__winnowerNetflix) return;
  window.__winnowerNetflix = true;

  // document_start: there may be no <head> yet, but the root element exists.
  const style = document.createElement('style');
  style.textContent = `${PAUSE_AD}{display:none!important}`;
  document.documentElement.append(style);

  let found = false;
  let skipped = 0;
  let reseeks = 0;

  // Breaks already skipped, so a break the player is slow to leave is not
  // skipped again on every tick.
  const handled = new WeakSet<object>();
  const heights: number[] = [];

  const videoHeight = () => document.querySelector('video')?.videoHeight ?? 0;

  const players = (): SessionPlayer[] => {
    const api = netflix?.appContext?.state?.playerApp?.getAPI?.().videoPlayer;
    if (!api) return [];
    // An episode change keeps the page and starts a new session, so check all of them.
    return api.getAllPlayerSessionIds().flatMap((id) => api.getVideoPlayerBySessionId(id) ?? []);
  };

  const tick = () => {
    let presenting = false;
    try {
      for (const player of players()) {
        const ads = player.getAdManager();
        if (!ads) continue;
        found = true;
        const brk = ads.getPresentingAdBreak();
        if (!brk) continue;
        presenting = true;
        if (handled.has(brk)) continue;
        handled.add(brk);

        const baseline = Math.max(0, ...heights.slice(0, HISTORY / 2));
        ads.skipAdBreak(0, 0, 'user');
        skipped += 1;

        // One skip in four came back at 342p and stayed there. A seek to where
        // the player already is makes it choose the stream again. Only when
        // needed: the seek flushes the picture, which shows as a black flash.
        setTimeout(() => {
          try {
            if (videoHeight() < baseline) {
              player.seek(player.getCurrentTime());
              reseeks += 1;
            }
          } catch {
            /* the player went away, e.g. the viewer left the title */
          }
        }, SETTLE_MS);
      }
    } catch {
      /* Netflix changed its internals. Leave the page as it is. */
    }

    if (presenting) return;
    heights.push(videoHeight());
    if (heights.length > HISTORY) heights.shift();
  };

  setInterval(tick, TICK_MS);

  Object.defineProperty(window, '__winnower_netflix', {
    configurable: true,
    get: () => ({ found, skipped, reseeks }),
  });
})();
