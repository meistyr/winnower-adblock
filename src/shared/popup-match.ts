/**
 * The popup guard's decision: is window.open to this host refused on this page?
 *
 * Shared by src/popup-guard.ts, which runs it in pages, and build/validate.ts,
 * which runs it at build time against the same host lists, so the build checks
 * exactly what ships.
 */
import type { PopupPatterns } from './catalogue.ts';

/** The host and each parent domain: ads.cdn.example.com, cdn.example.com, example.com. */
function withParents(host: string): string[] {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  const out: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) out.push(parts.slice(i).join('.'));
  return out;
}

export function createPopupMatcher(patterns: PopupPatterns): (target: string, page: string) => boolean {
  const hosts = new Set(patterns.hosts);
  const thirdParty = new Set(patterns.thirdParty);
  const allow = new Set(patterns.allow);

  return (target, page) => {
    const domains = withParents(target);
    // An exception allows this whole host: leave it to the DNR rules.
    if (domains.some((d) => allow.has(d))) return false;
    if (domains.some((d) => hosts.has(d))) return true;
    // $popup,third-party: refused unless the page is on that host's own site.
    // Judged by the rule's host, not the registrable domain: a page script has
    // no public suffix list to work that out with.
    const pageHost = page.toLowerCase();
    return domains.some((d) => thirdParty.has(d) && pageHost !== d && !pageHost.endsWith(`.${d}`));
  };
}
