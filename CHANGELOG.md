# Changelog

All notable changes to winnower are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-09-16

First release.

### Added

- Network blocking: about 130,000 declarativeNetRequest rules converted from ten filter lists
  (uBlock Origin, EasyList, EasyPrivacy, Peter Lowe's list, EasyList Cookie List and Fanboy's
  Annoyance List), grouped into Ads, Tracking, Popups, Cookie banners and Annoyances. Cookie
  banners and Annoyances start switched off, because they are the lists most likely to break a
  site.
- YouTube ad blocking: blocks pre-roll and mid-roll ads, including when moving between videos
  without a reload.
- Cosmetic filtering: generic and site-specific element hiding, and collapsing the empty
  wrappers hidden ads leave behind.
- Popup and popunder blocking: `$popup` filters as main-frame rules, plus a `window.open` guard
  for popunders opened by scripts.
- Toolbar popup: pause on the current site, a master switch, filter-list toggles, a count of
  blocked requests, and diagnostics showing what actually ran on the page you are looking at.
- A toolbar icon that follows Chrome's light or dark mode.
- A release zip that loads with Load unpacked, with `CREDITS.txt` naming every filter list and
  the licence it declares.

[Unreleased]: https://github.com/meistyr/winnower-adblock/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/meistyr/winnower-adblock/releases/tag/v0.1.0
