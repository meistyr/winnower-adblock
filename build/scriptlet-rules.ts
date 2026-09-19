/**
 * Scriptlet rules, per domain group.
 *
 * Names and argument shapes are AdGuard's (@adguard/scriptlets, GPL-3.0). A
 * maintained library is used rather than hand-written page scripts because
 * YouTube's player changes often, and the library keeps up with those changes.
 *
 * When ads come back after a YouTube update: update @adguard/scriptlets, run
 * `npm run update`, and check these rules against the current player responses.
 *
 * Testing: a tab that has never had a click or key press cannot autoplay, and a
 * player waiting to autoplay looks exactly like a stuck one (no buffered media,
 * player state 3, resolution 0x0). Click the player before deciding playback is
 * broken.
 */
export interface ScriptletRule {
  /** AdGuard scriptlet name, e.g. set-constant. */
  name: string;
  args: string[];
}

export interface ScriptletGroup {
  /** Bundle name: extension/scriptlets/<id>.js and window.__winnower_<id>. */
  id: string;
  matches: string[];
  rules: ScriptletRule[];
}

export const SCRIPTLET_GROUPS: readonly ScriptletGroup[] = [
  {
    id: 'youtube',
    matches: ['*://*.youtube.com/*', '*://*.youtube-nocookie.com/*', '*://*.youtubekids.com/*'],
    rules: [
      // Ad fields in the page's initial player response. set-constant keeps them
      // unset even when the player assigns them again later.
      { name: 'set-constant', args: ['ytInitialPlayerResponse.adPlacements', 'undefined'] },
      { name: 'set-constant', args: ['ytInitialPlayerResponse.adSlots', 'undefined'] },
      { name: 'set-constant', args: ['ytInitialPlayerResponse.playerAds', 'undefined'] },
      { name: 'set-constant', args: ['playerResponse.adPlacements', 'undefined'] },
      { name: 'set-constant', args: ['playerResponse.adSlots', 'undefined'] },

      // Mid-roll ad scheduling.
      { name: 'set-constant', args: ['ytInitialPlayerResponse.adBreakHeartbeatParams', 'undefined'] },

      // Ad stitching configuration.
      { name: 'set-constant', args: ['ytInitialPlayerResponse.playerConfig.ssapConfig', 'undefined'] },

      // Shorts. A separate ad path entirely: the watch-page rules do not cover
      // it, since Shorts ads arrive flagged on reel entries rather than as
      // adPlacements.
      { name: 'json-prune', args: ['entries.[-].command.reelWatchEndpoint.adClientParams.isAd'] },
      {
        name: 'json-prune-fetch-response',
        args: [
          'reelWatchSequenceResponse.entries.[-].command.reelWatchEndpoint.adClientParams.isAd entries.[-].command.reelWatchEndpoint.adClientParams.isAd',
          '',
          'propsToMatch',
          'reel_watch_sequence',
        ],
      },

      // Pages that read google_ad_status expect it to be set once ads have loaded.
      { name: 'set-constant', args: ['google_ad_status', '1'] },

      // SPA navigation: the inline payload only covers the first video.
      {
        name: 'json-prune-fetch-response',
        args: [
          'adPlacements adSlots playerAds adBreakHeartbeatParams playerResponse.adPlacements playerResponse.adSlots playerResponse.playerAds',
          '',
          'propsToMatch',
          '/youtubei/v1/player',
        ],
      },
      // In-app navigation loads videos through /youtubei/v1/get_watch, not
      // /youtubei/v1/player. Its ad fields are not at paths json-prune can reach,
      // so these rename the keys in the raw response instead, and the player finds
      // no ads.
      {
        name: 'trusted-replace-fetch-response',
        args: ['"adPlacements"', '"no_ads_adPlacements"', 'get_watch'],
      },
      {
        name: 'trusted-replace-fetch-response',
        args: ['"adSlots"', '"no_ads_adSlots"', 'get_watch'],
      },
      {
        name: 'trusted-replace-fetch-response',
        args: ['"playerAds"', '"no_ads_playerAds"', 'get_watch'],
      },
      {
        name: 'trusted-replace-fetch-response',
        args: ['"adBreakHeartbeatParams"', '"no_ads_adBreakHeartbeatParams"', 'get_watch'],
      },
      {
        name: 'trusted-replace-xhr-response',
        args: ['"adPlacements"', '"no_ads_adPlacements"', 'get_watch'],
      },
      {
        name: 'trusted-replace-xhr-response',
        args: ['"adSlots"', '"no_ads_adSlots"', 'get_watch'],
      },
      {
        name: 'json-prune-xhr-response',
        args: [
          'adPlacements adSlots playerAds adBreakHeartbeatParams playerResponse.adPlacements playerResponse.adSlots playerResponse.playerAds',
          '',
          'propsToMatch',
          '/youtubei/v1/player',
        ],
      },
    ],
  },
];
