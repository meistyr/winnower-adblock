/**
 * winnower service worker.
 *
 * Responsibilities:
 *   - serve per-hostname cosmetic selectors to content scripts
 *   - hold the per-site allowlist and the master switch
 *   - count blocked requests per tab for the badge
 *   - toggle static rulesets on behalf of the popup
 *
 * The cosmetic bucket files could have been exposed via
 * web_accessible_resources and fetched directly by the content script, which
 * would be simpler. They are not, deliberately: any page can probe a
 * web-accessible extension URL to detect the extension. Keeping the files private
 * means a page cannot tell whether winnower is installed.
 */
import { bucketOf, type CosmeticBucket } from './shared/bucket.ts';
import { ALLOWLIST_PRIORITY, ALLOWLIST_RULE_BASE } from './shared/constants.ts';
import type { DynamicScript, RulesetEntry } from './shared/catalogue.ts';
import type { Message, MessageType, PopupState, Reply } from './shared/messages.ts';

const bucketCache = new Map<number, CosmeticBucket>();

async function loadBucket(i: number): Promise<CosmeticBucket> {
  const cached = bucketCache.get(i);
  if (cached) return cached;
  try {
    const res = await fetch(chrome.runtime.getURL(`cosmetic/domains/${i}.json`));
    const json = (await res.json()) as CosmeticBucket;
    bucketCache.set(i, json);
    return json;
  } catch {
    bucketCache.set(i, {});
    return {};
  }
}

/**
 * Candidate keys for a hostname, most specific first:
 *   news.bbc.co.uk -> news.bbc.co.uk, bbc.co.uk, co.uk
 * plus the wildcard form upstream lists use for multi-TLD brands (amazon.*).
 */
function candidates(hostname: string): string[] {
  const host = hostname.replace(/^www\./, '');
  const out = [host];
  const parts = host.split('.');
  for (let i = 1; i < parts.length - 1; i++) out.push(parts.slice(i).join('.'));
  if (parts.length >= 2) out.push(parts[0] + '.*');
  return out;
}

async function selectorsFor(hostname: string): Promise<string[]> {
  const seen = new Set<string>();
  for (const key of candidates(hostname)) {
    const bucket = await loadBucket(bucketOf(key));
    for (const sel of bucket[key] ?? []) seen.add(sel);
  }
  return [...seen];
}

// --- settings ---------------------------------------------------------------

interface Settings {
  allowlist: string[];
  master: boolean;
}

const defaults: Settings = { allowlist: [], master: true };

async function getSettings(): Promise<Settings> {
  const s: Partial<Settings> = await chrome.storage.local.get(defaults);
  return { allowlist: s.allowlist ?? [], master: s.master !== false };
}

const normalise = (h: string | undefined) => String(h || '').replace(/^www\./, '').toLowerCase();

async function isAllowlisted(hostname: string): Promise<boolean> {
  const { allowlist, master } = await getSettings();
  if (!master) return true; // master off behaves as "allowlisted everywhere"
  const host = normalise(hostname);
  return allowlist.some((d) => host === d || host.endsWith('.' + d));
}

/**
 * Rebuild the dynamic allow rules from the allowlist.
 *
 * allowAllRequests at a priority above every static rule, so an allowlisted
 * site is fully restored rather than partially unblocked.
 */
async function syncAllowRules() {
  const { allowlist, master } = await getSettings();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  const addRules: chrome.declarativeNetRequest.Rule[] = [];

  if (!master) {
    // One rule covering everything is cheaper than disabling each ruleset, and
    // reverses instantly when the switch goes back on.
    addRules.push({
      id: ALLOWLIST_RULE_BASE,
      priority: ALLOWLIST_PRIORITY,
      action: { type: 'allowAllRequests' },
      condition: { urlFilter: '*', resourceTypes: ['main_frame', 'sub_frame'] },
    });
  } else {
    allowlist.forEach((d, i) => {
      addRules.push({
        id: ALLOWLIST_RULE_BASE + 1 + i,
        priority: ALLOWLIST_PRIORITY,
        action: { type: 'allowAllRequests' },
        condition: { requestDomains: [d], resourceTypes: ['main_frame', 'sub_frame'] },
      });
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
}

/**
 * Register the MAIN-world scripts (YouTube scriptlets, popup guard) to match
 * the current switches.
 *
 * These cannot live in the manifest. They run at document_start in the MAIN
 * world, with no chrome.storage and no synchronous signal available that
 * early, so they cannot consult the allowlist themselves — and a manifest
 * declaration cannot be switched off. That is precisely why both kill switches
 * appeared broken on YouTube, whose blocking is entirely these scripts: the
 * network and cosmetic layers turned off correctly while ad payloads went on
 * being pruned.
 *
 * Allowlisted sites become excludeMatches; master off registers nothing.
 */
async function syncContentScripts() {
  const { allowlist, master } = await getSettings();

  let wanted: DynamicScript[] = [];
  try {
    wanted = (await (await fetch(chrome.runtime.getURL('dynamic-scripts.json'))).json()) as DynamicScript[];
  } catch {
    return;
  }

  const existing = await chrome.scripting.getRegisteredContentScripts();
  const ours = existing.map((s) => s.id).filter((id) => id.startsWith('winnower-'));
  if (ours.length) await chrome.scripting.unregisterContentScripts({ ids: ours });

  if (!master) return;

  const excludeMatches = allowlist.flatMap((d) => [`*://${d}/*`, `*://*.${d}/*`]);
  const scripts = wanted.map((s): chrome.scripting.RegisteredContentScript => ({
    ...s,
    persistAcrossSessions: true,
    ...(excludeMatches.length ? { excludeMatches } : {}),
  }));
  if (scripts.length) await chrome.scripting.registerContentScripts(scripts);
}

/** Everything the switches control, kept in one place so none can be skipped. */
async function syncAll() {
  await syncAllowRules();
  await syncContentScripts();
}

// --- toolbar icon ---------------------------------------------------------------

// A PNG cannot follow light and dark mode the way an SVG with currentColor can,
// so there are two sets (see brand/README.md). On a dark toolbar the leaf is light,
// so it is drawn thinner, because a light shape on dark reads heavier.
const iconPaths = (ground: 'light' | 'dark') => ({ 16: `icons/mark-on-${ground}-16.png`, 32: `icons/mark-on-${ground}-32.png` });

async function ensureColorSchemeWatcher() {
  const open = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (open.length) return; // still reporting; setIcon state outlives worker restarts
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['MATCH_MEDIA'],
    justification: 'Match the toolbar icon to light or dark mode',
  });
}

// Called on every worker start, not only onStartup/onInstalled: offscreen documents
// do not survive a browser restart or an extension reload. Two overlapping starts
// can both try to create it; the loser throws, which is harmless.
ensureColorSchemeWatcher().catch(() => {});

// --- badge ------------------------------------------------------------------

const blockedByTab = new Map<number, number>();

function setBadge(tabId: number) {
  const n = blockedByTab.get(tabId) ?? 0;
  chrome.action.setBadgeText({ tabId, text: n > 0 ? String(n) : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#3d3d3d' }).catch(() => {});
}

// onRuleMatchedDebug fires only for unpacked extensions, which is exactly how
// winnower is installed. A packed build would need a different counter.
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
  chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
    const tabId = info.request?.tabId;
    if (typeof tabId !== 'number' || tabId < 0) return;
    // This event fires for every matched rule, allow rules included, and does
    // not report the action type. Without filtering, an allowlisted site would
    // count its own allowlist rule as a "block". _dynamic is the allowlist;
    // ubo-unbreak is almost entirely exception rules. Approximate, not exact —
    // a handful of allow rules elsewhere can still be counted.
    const rs = info.rule?.rulesetId;
    if (rs === '_dynamic' || rs === 'ubo-unbreak') return;
    blockedByTab.set(tabId, (blockedByTab.get(tabId) ?? 0) + 1);
    setBadge(tabId);
  });
}

chrome.webNavigation?.onCommitted?.addListener((d) => {
  if (d.frameId !== 0) return;
  blockedByTab.set(d.tabId, 0);
  setBadge(d.tabId);
});

chrome.tabs.onRemoved.addListener((tabId) => blockedByTab.delete(tabId));

// --- messages ---------------------------------------------------------------

async function buildState(tabId: number | undefined, hostname: string): Promise<PopupState> {
  const { allowlist, master } = await getSettings();
  const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
  let catalogue: RulesetEntry[] = [];
  try {
    catalogue = (await (await fetch(chrome.runtime.getURL('rulesets.json'))).json()) as RulesetEntry[];
  } catch {}

  return {
    host: normalise(hostname),
    allowlisted: await isAllowlisted(hostname),
    master,
    allowlist,
    blocked: (tabId === undefined ? undefined : blockedByTab.get(tabId)) ?? 0,
    rulesets: catalogue.map((r) => ({ ...r, enabled: enabled.includes(r.id) })),
  };
}

/** sendResponse, narrowed to the reply type of one message (see shared/messages.ts). */
const replyFor =
  <T extends MessageType>(_type: T, sendResponse: (response?: unknown) => void) =>
  (reply: Reply<T>) =>
    sendResponse(reply);

chrome.runtime.onMessage.addListener((msg: Message | undefined, sender, sendResponse) => {
  if (msg?.type === 'winnower:colorScheme') {
    if (!sender.url?.endsWith('/offscreen.html')) return false;
    chrome.action.setIcon({ path: iconPaths(msg.dark ? 'dark' : 'light') }).catch(() => {});
    return false;
  }

  if (msg?.type === 'winnower:cosmetic') {
    const reply = replyFor(msg.type, sendResponse);
    (async () => {
      // The switches are scoped to the site in the address bar, not to the
      // frame asking. A cross-origin iframe reports its own hostname, so
      // checking that left every third-party frame on a paused page still
      // filtered, while the network layer turned off correctly —
      // allowAllRequests matches the main-frame navigation and cascades to the
      // whole frame tree. sender.tab.url is the top-level document, which is
      // what was paused. Readable without the tabs permission because winnower
      // holds <all_urls> host permissions.
      let site: string | null = null;
      try {
        if (sender.tab?.url) site = new URL(sender.tab.url).hostname;
      } catch {
        /* unparseable top-level URL — leave site null and step back below */
      }

      // A null site means the page this frame belongs to could not be
      // identified. Paused means paused: when winnower cannot tell which site
      // it is on, it steps back rather than risk filtering one someone paused.
      // Falling back to the frame's own hostname would reinstate exactly the
      // bug above — a third-party box answering for itself.
      if (site === null || (await isAllowlisted(site))) {
        reply({ selectors: [], off: true });
        return;
      }
      // Selectors stay keyed to the frame's own hostname: cosmetic rules are
      // written per frame domain, not per top-level site.
      reply({ selectors: await selectorsFor(String(msg.hostname || '')), off: false });
    })().catch(() =>
      // The decision could not be completed — in practice chrome.storage
      // failing because the extension context was invalidated by a reload or
      // an update. That is the same event that loses the content script's
      // message, so both paths answer it the same way: paused means paused,
      // and an unreadable setting is not grounds for filtering a page someone
      // may have paused.
      reply({ selectors: [], off: true }),
    );
    return true;
  }

  if (msg?.type === 'winnower:state') {
    const reply = replyFor(msg.type, sendResponse);
    buildState(msg.tabId, msg.hostname).then(reply).catch(() => reply(null));
    return true;
  }

  if (msg?.type === 'winnower:toggleSite') {
    const reply = replyFor(msg.type, sendResponse);
    (async () => {
      const { allowlist } = await getSettings();
      const host = normalise(msg.hostname);
      const next = allowlist.includes(host)
        ? allowlist.filter((d) => d !== host)
        : [...allowlist, host];
      await chrome.storage.local.set({ allowlist: next });
      await syncAll();
      reply({ allowlisted: next.includes(host) });
    })().catch(() => reply(null));
    return true;
  }

  if (msg?.type === 'winnower:toggleMaster') {
    const reply = replyFor(msg.type, sendResponse);
    (async () => {
      const { master } = await getSettings();
      await chrome.storage.local.set({ master: !master });
      await syncAll();
      reply({ master: !master });
    })().catch(() => reply(null));
    return true;
  }

  if (msg?.type === 'winnower:toggleGroup') {
    const reply = replyFor(msg.type, sendResponse);
    (async () => {
      // A group is on if ANY of its rulesets is on; toggling flips the whole
      // group to the opposite, so a partially-enabled group turns fully off
      // rather than into some mixed state the UI cannot represent.
      const enabled = await chrome.declarativeNetRequest.getEnabledRulesets();
      const ids = msg.ids ?? [];
      const anyOn = ids.some((id) => enabled.includes(id));
      await chrome.declarativeNetRequest.updateEnabledRulesets(
        anyOn ? { disableRulesetIds: ids } : { enableRulesetIds: ids },
      );
      reply({ enabled: !anyOn });
    })().catch((e: unknown) => reply({ error: String(e) }));
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(() => { syncAll().catch(() => {}); });
chrome.runtime.onStartup.addListener(() => { syncAll().catch(() => {}); });
