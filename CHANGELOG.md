# Changelog

All notable changes to winnower are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-09-19

### Added

- **Paused sites:** winnower's menu now lists every site you have paused, behind a **Paused
  sites** button below "On this page". You can resume blocking on any of them straight from the
  list, without visiting the site first. Until now the menu only ever told you about the site you
  happened to be on, so the only way to find out whether you had paused something was to go there
  and look.
- **Diagnostics:** winnower now keeps a record of what it does, and the menu has a **Diagnostics**
  view with a **Copy** button. Errors are always recorded, so if a site breaks you can copy what
  happened and paste it into a report without setting anything up or making it happen again first.
  **Developer mode**, which you turn on by clicking the version number at the bottom of the menu
  five times, records every decision winnower makes rather than only the errors. Nothing is ever
  sent anywhere, and the record is thrown away when you close your browser.
- **New version notice:** winnower checks whether a newer version has been released, as soon as
  you install it and once a day after that.
  When one has, the toolbar icon's badge turns green and the menu shows **0.3.0 available** at the
  top, linking to the download. Chrome never updates winnower for you, because it is installed
  from a zip, so until now there was no way to find out a new version existed. This is the only time
  winnower contacts anything after you install it: it asks GitHub for the latest version number
  and nothing else, with no account, no identifier and nothing recorded about you.

### Fixed

- **Twitch:** the video player no longer turns into a solid block of colour when you reload a
  channel page. winnower tidies away the empty boxes an ad leaves behind when it hides one, and
  it was counting boxes the site had emptied itself as its own work. On Twitch that meant
  removing the space the player sits in, leaving the channel's background colour showing through
  while the stream carried on playing with no picture. It now only tidies up after itself, which
  also fixes the same mistake on any other site that keeps its video player outside the part of
  the page it appears in.
- **Gaps left where ads were:** winnower now watches a page for as long as you have it open,
  instead of stopping seven seconds after it loads. Ads that arrive late, on a slow connection or
  further down a page as you scroll, had their space left behind as an empty gap, because
  winnower had stopped looking by the time they appeared.

## [0.2.1] - 2026-09-18

### Fixed

- **Pausing a site:** pausing winnower on a site now stops it hiding things inside content the
  page has embedded from somewhere else, too. Before, the page itself was left alone while
  anything embedded in it was still filtered.
- **When winnower is unsure:** if it cannot tell which site a page belongs to, or cannot read
  your settings (both possible for a moment after a browser or extension restart), it now blocks
  nothing rather than risk filtering a site you had paused.

## [0.2.0] - 2026-09-17

### Added

- **Website:** winnower's details page in `chrome://extensions` links to
  [winnower.meistyr.tech](https://winnower.meistyr.tech).

### Changed

- **Toolbar icon:** now the leaf on its own, without the rounded tile around it.
- **Toolbar menu:** the logo at the top is a little larger, and the section labels and notes are easier to read.
- **Description:** the line under winnower's name in `chrome://extensions` now reads "A free, open-source content
  blocker. Every page in its final shape."

### Fixed

- **Sign-in and share windows:** windows a site opens to sign you in with Google are no longer blocked, and neither
  are the ones it opens to Facebook, bit.ly, t.co, Adobe and about 100 other sites. Popup blocking was treating a
  filter meant for one address on a site as a block on the whole site.

## [0.1.0] - 2026-09-16

First release.

### Added

- **Network blocking:** about 130,000 blocking rules from ten community filter lists (uBlock
  Origin, EasyList, EasyPrivacy, Peter Lowe's list, EasyList Cookie List and Fanboy's Annoyance
  List), grouped into Ads, Tracking, Popups, Cookie banners and Annoyances. Cookie banners and
  Annoyances start switched off, because they are the lists most likely to break a site.
- **YouTube ad blocking:** blocks ads before and during videos, including when you move from one
  video to the next.
- **Element hiding:** hides ads that are part of the page, on every site and with rules for
  specific sites, and hides the empty boxes they leave behind.
- **Popup and popunder blocking:** blocks popups and popunders from known ad networks, including
  popunders a page opens with a script.
- **Toolbar menu:** pause winnower on the site you're on, turn it off everywhere, switch filter
  lists on and off, see how many requests were blocked, and see what actually ran on the page
  you're looking at.
- **Toolbar icon:** follows Chrome's light or dark mode.
- **Release zip:** loads with Load unpacked, with `CREDITS.txt` naming every filter list and the
  licence it declares.

[Unreleased]: https://github.com/meistyr/winnower-adblock/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/meistyr/winnower-adblock/releases/tag/v0.3.0
[0.2.1]: https://github.com/meistyr/winnower-adblock/releases/tag/v0.2.1
[0.2.0]: https://github.com/meistyr/winnower-adblock/releases/tag/v0.2.0
[0.1.0]: https://github.com/meistyr/winnower-adblock/releases/tag/v0.1.0
