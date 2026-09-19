/**
 * Is the release winnower just heard about newer than the one running?
 *
 * Separated out and free of chrome.* so build/validate.ts can ask it directly,
 * the same arrangement as shared/popup-match.ts and shared/collapse-match.ts.
 * Version comparison looks trivial and has one famous trap: compared as text,
 * "0.10.0" sorts BELOW "0.9.0", so the update that matters is the one that
 * never gets announced. Compared as numbers per part, it does not.
 *
 * Deliberately not a semver library. winnower's versions are three numbers, the
 * tags carry a "v" prefix, and the only question asked is "is this bigger".
 * Pre-release suffixes are not used, CONTRIBUTING.md says alpha is expressed
 * by the 0. major, so anything after the numbers is ignored rather than
 * ranked, and a tag that parses to nothing is treated as "no news".
 */

/** `v0.10.2` → [0, 10, 2]. Missing or unparseable parts become 0. */
export function parseVersion(version: string): [number, number, number] {
  const cleaned = String(version || '').trim().replace(/^v/i, '');
  const parts = cleaned.split('.', 3).map((p) => {
    const n = Number.parseInt(p, 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
}

/**
 * True only when `latest` is strictly ahead of `current`.
 *
 * Equal is not newer, and older is not newer, a rolled-back release must not
 * announce itself as an update. Unparseable input yields 0.0.0, which is never
 * ahead of a real version, so a malformed tag says nothing rather than
 * announcing a downgrade.
 */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}
