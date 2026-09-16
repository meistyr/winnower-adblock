# Contributing

Thanks for helping. winnower is maintained by one person, so issues and pull requests are read
as time allows.

## Reporting a problem

- **A site breaks with winnower on:** open an issue with the page's address, what goes wrong,
  and whether pausing winnower on that site (from the toolbar popup) fixes it.
- **An ad gets through:** open an issue with the page's address and where the ad appears.
- **A security problem:** please don't open an issue. See [SECURITY.md](SECURITY.md).

Include your Chrome version and your winnower version, which is shown at the bottom of the popup.

## Pull requests

Before opening one, check that the full build passes:

```sh
npm install
npm run update     # type-check, fetch the filter lists, build, validate
```

Keep each pull request to one change, titled in the Conventional Commits style below.
Contributions are licensed under the project's licence, GPL-3.0-or-later.

## Versioning

Semver. winnower is pre-1.0, which the `0.` major version expresses, so a breaking change bumps
the minor version while it stays `0.x`.

| Commit type | Bump |
| --- | --- |
| `feat:` | minor |
| `fix:` `perf:` `refactor:` `chore:` `docs:` `test:` `build:` `ci:` | patch |
| Anything with a `BREAKING CHANGE:` footer | minor (while `0.x`) |

For an extension, breaking means something people rely on stops working the way it did, or
their settings are lost.

`package.json` is the single source of the version. Bump it with
`npm version X.Y.Z --no-git-tag-version` so `package-lock.json` stays in step.

## Commits

[Conventional Commits](https://www.conventionalcommits.org): `type(scope): summary`. The summary
is in the imperative, lowercase, with no trailing period.

Scopes: `filters`, `youtube`, `popup`, `build`, `brand`, `deps`, `ci`, `release`.

```
fix(filters): stop hiding the comment box on news sites
feat(popup): show the version in the footer
chore(deps): bump esbuild to 0.28.3
```

## Branches and releases

There is one branch, `main`. A release is:

1. `npm run update` passes.
2. Bump the version, and move `[Unreleased]` in `CHANGELOG.md` under it with the date.
3. Commit that as `chore(release): X.Y.Z` and tag it `vX.Y.Z`.
4. Push the commit and the tag together. The release workflow builds `winnower.zip` and
   publishes it on [Releases](https://github.com/meistyr/winnower-adblock/releases).

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com). Entries go under
`[Unreleased]` as part of the change itself, written for people who use winnower rather than
people reading the code.

## Labels

| Label | Meaning |
| --- | --- |
| `type:bug` `type:feature` `type:chore` `type:docs` | What kind of work it is |
| `area:filters` `area:youtube` `area:popup` `area:build` `area:brand` | Which part of winnower |
| `report:site-broken` `report:missed-ad` | Reports from people using winnower |
| `blocked:luke` | Waiting on a decision, a credential or an approval |
| `ready` | Decided and ready to build |
| `needs:design` | Needs a decision or a mock before building |
| `accessibility` | A barrier for people with disabilities |
| `good first issue` `help wanted` | Good places to start contributing |
| `duplicate` `invalid` `wontfix` | Closed without a change |

## Writing

Describe what winnower does in plain, user-facing terms. winnower is not affiliated with YouTube,
Google, or any site it runs on.
