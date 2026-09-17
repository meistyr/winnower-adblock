# Changelog

All notable changes to winnower are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/meistyr/winnower-adblock/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/meistyr/winnower-adblock/releases/tag/v0.1.0
