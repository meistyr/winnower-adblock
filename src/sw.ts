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
import {
  ALLOWLIST_PRIORITY, ALLOWLIST_RULE_BASE, BADGE_IDLE, BADGE_UPDATE,
  RELEASES_API, UPDATE_CHECK_INTERVAL_MS,
} from './shared/constants.ts';
import { isNewer } from './shared/version.ts';
import type { DynamicScript, RulesetEntry } from './shared/catalogue.ts';
import { LOG_CAP, isAlwaysKept, type LogLine } from './shared/log.ts';
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
  /** Record every decision, not only errors. Off unless someone turned it on. */
  dev: boolean;
}

const defaults: Settings = { allowlist: [], master: true, dev: false };

async function getSettings(): Promise<Settings> {
  const s: Partial<Settings> = await chrome.storage.local.get(defaults);
  return { allowlist: s.allowlist ?? [], master: s.master !== false, dev: s.dev === true };
}

const normalise = (h: string | undefined) => String(h || '').replace(/^www\./, '').toLowerCase();

// --- the diagnostic log -----------------------------------------------------

/**
 * The recorded lines, oldest first.
 *
 * Held in memory and mirrored into chrome.storage.session. MV3 stops an idle
 * worker within seconds, and a log that vanished each time it went quiet would
 * never still contain the thing you opened the menu to look at. `session`
 * rather than `local`: it is dropped when the browser closes, and a record of
 * every site visited has no business outliving the session that produced it.
 */
let logLines: LogLine[] = [];
let logLoaded = false;
let logFlush: ReturnType<typeof setTimeout> | undefined;

async function loadLog(): Promise<void> {
  if (logLoaded) return;
  logLoaded = true;
  try {
    const { winnowerLog } = await chrome.storage.session.get({ winnowerLog: [] });
    if (Array.isArray(winnowerLog)) logLines = winnowerLog as LogLine[];
  } catch {
    /* session storage unavailable — carry on with the in-memory copy */
  }
}

/** Mirror to session storage, debounced: a loading page reports in bursts. */
function flushLog(): void {
  if (logFlush !== undefined) return;
  logFlush = setTimeout(() => {
    logFlush = undefined;
    chrome.storage.session.set({ winnowerLog: logLines }).catch(() => {});
  }, 400);
}

/**
 * Keep some lines, subject to the level.
 *
 * The developer-mode check lives HERE, not at each call site, so that "errors
 * are always kept" is true of every path into the log rather than of the paths
 * someone remembered. Senders filter too — a page that recorded everything and
 * shipped it here to be discarded would have paid the cost regardless — but
 * this is the backstop.
 *
 * The host is taken from the sender, never from the message: winnower listens
 * on every site, so a page can send whatever it likes.
 */
async function record(lines: LogLine[], host?: string): Promise<void> {
  if (!lines.length) return;
  await loadLog();
  const { dev } = await getSettings();
  const keep = lines.filter((line) => dev || isAlwaysKept(line));
  if (!keep.length) return;
  for (const line of keep) logLines.push(host ? { ...line, host } : line);
  if (logLines.length > LOG_CAP) logLines = logLines.slice(-LOG_CAP);
  flushLog();
}

const workerStart = Date.now();

/** Record one line about the worker's own behaviour. */
const note = (verb: LogLine['verb'], subject: string, reason?: string) =>
  void record([{ t: Date.now() - workerStart, layer: 'worker', verb, subject, reason }]).catch(() => {});

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

// --- update check -----------------------------------------------------------

/** Remembered so the badge can be painted without waiting on a network call. */
let updatePending = false;

interface UpdateCheck {
  /** When the last attempt finished, successful or not. */
  checkedAt: number;
  /** The newest tag GitHub reported, or '' if it has never answered. */
  latest: string;
}

/**
 * Ask GitHub for the newest release, at most once a day.
 *
 * Runs when the worker starts — which is whenever winnower is doing anything —
 * rather than only when the menu is opened, so someone who never opens the menu
 * still finds out. The day's interval is held in storage rather than in memory:
 * MV3 stops an idle worker within seconds, and an in-memory timestamp would
 * mean a check on every wake.
 *
 * Never throws and never surfaces a failure. Offline, rate-limited, GitHub
 * down — none of that is the reader's problem, and an extension complaining
 * that it could not check for updates is worse than one that quietly tries
 * again tomorrow. A failed attempt still moves checkedAt, so a machine with no
 * connection makes one attempt a day rather than one per worker wake.
 */
async function checkUpdate(force = false): Promise<{ latest: string; newer: boolean }> {
  const current = chrome.runtime.getManifest().version;
  let state: UpdateCheck = { checkedAt: 0, latest: '' };
  try {
    const stored = await chrome.storage.local.get({ updateCheck: state });
    if (stored.updateCheck && typeof stored.updateCheck === 'object') {
      state = stored.updateCheck as UpdateCheck;
    }
  } catch {
    /* unreadable settings — treat as never checked */
  }

  if (force || Date.now() - (state.checkedAt || 0) > UPDATE_CHECK_INTERVAL_MS) {
    try {
      const res = await fetch(RELEASES_API, { headers: { accept: 'application/vnd.github+json' } });
      const json = (await res.json()) as { tag_name?: string };
      const tag = String(json?.tag_name ?? '').trim();
      state = { checkedAt: Date.now(), latest: tag || state.latest };
    } catch {
      state = { ...state, checkedAt: Date.now() };
    }
    try {
      await chrome.storage.local.set({ updateCheck: state });
    } catch {
      /* the answer is still good for this worker's lifetime */
    }
  }

  const newer = isNewer(state.latest, current);
  if (newer !== updatePending) {
    updatePending = newer;
    repaintBadges();
  }
  return { latest: state.latest, newer };
}

function setBadge(tabId: number) {
  const n = blockedByTab.get(tabId) ?? 0;
  // A tint alone cannot carry the news: the badge is only drawn when there is
  // something in it, so on a page where nothing was blocked there would be no
  // badge to tint. A dot gives the tint something to colour.
  const text = n > 0 ? String(n) : updatePending ? '•' : '';
  chrome.action.setBadgeText({ tabId, text }).catch(() => {});
  chrome.action
    .setBadgeBackgroundColor({ tabId, color: updatePending ? BADGE_UPDATE : BADGE_IDLE })
    .catch(() => {});
  // Green badge, dark text — the brand green is light, and Chrome's default
  // white on it is unreadable.
  chrome.action.setBadgeTextColor?.({ tabId, color: updatePending ? '#0f1a12' : '#ffffff' }).catch(() => {});
}

/** Repaint every tab's badge, after the update state changes under them. */
function repaintBadges() {
  for (const tabId of blockedByTab.keys()) setBadge(tabId);
  chrome.tabs.query({}).then((tabs) => {
    for (const t of tabs) if (typeof t.id === 'number') setBadge(t.id);
  }).catch(() => {});
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
  const { allowlist, master, dev } = await getSettings();
  await loadLog();
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
    dev,
    recorded: logLines.length,
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
      // Rides along with the selectors rather than costing a second round
      // trip: the page has to know at document_start whether to record
      // anything, and it is already asking this question then.
      const { dev } = await getSettings();

      if (site === null || (await isAllowlisted(site))) {
        reply({ selectors: [], off: true, dev });
        return;
      }
      // Selectors stay keyed to the frame's own hostname: cosmetic rules are
      // written per frame domain, not per top-level site.
      reply({ selectors: await selectorsFor(String(msg.hostname || '')), off: false, dev });
    })().catch(() =>
      // The decision could not be completed — in practice chrome.storage
      // failing because the extension context was invalidated by a reload or
      // an update. That is the same event that loses the content script's
      // message, so both paths answer it the same way: paused means paused,
      // and an unreadable setting is not grounds for filtering a page someone
      // may have paused.
      reply({ selectors: [], off: true, dev: false }),
    );
    return true;
  }

  if (msg?.type === 'winnower:state') {
    const reply = replyFor(msg.type, sendResponse);
    buildState(msg.tabId, msg.hostname).then(reply).catch(() => reply(null));
    return true;
  }

  if (msg?.type === 'winnower:update') {
    const reply = replyFor(msg.type, sendResponse);
    checkUpdate().then(reply).catch(() => reply(null));
    return true;
  }

  if (msg?.type === 'winnower:log') {
    // The site is read off the sender, never off the message. winnower listens
    // on every site, so the lines themselves are whatever a page chose to send;
    // the label saying where they came from must not be.
    let host: string | undefined;
    try {
      if (sender.tab?.url) host = new URL(sender.tab.url).hostname;
    } catch {
      /* unparseable — the lines are still worth keeping, just unattributed */
    }
    // Capped before it reaches record(), so one page cannot flush the buffer
    // of everything else by sending an enormous batch.
    const lines = Array.isArray(msg.lines) ? msg.lines.slice(0, LOG_CAP) : [];
    void record(lines, host).catch(() => {});
    return false; // nothing to answer; the sender does not wait
  }

  if (msg?.type === 'winnower:diagnostics') {
    const reply = replyFor(msg.type, sendResponse);
    (async () => {
      await loadLog();
      const { dev } = await getSettings();
      reply({ lines: logLines.slice(), dev });
    })().catch(() => reply(null));
    return true;
  }

  if (msg?.type === 'winnower:clearDiagnostics') {
    const reply = replyFor(msg.type, sendResponse);
    (async () => {
      logLines = [];
      logLoaded = true;
      try {
        await chrome.storage.session.set({ winnowerLog: [] });
      } catch {
        /* cleared in memory regardless */
      }
      reply({ recorded: 0 });
    })().catch(() => reply(null));
    return true;
  }

  if (msg?.type === 'winnower:toggleDev') {
    const reply = replyFor(msg.type, sendResponse);
    (async () => {
      const { dev } = await getSettings();
      await chrome.storage.local.set({ dev: !dev });
      // Recorded before the reply so the first line in a fresh log says when
      // recording started, which is the question you ask of a log's first line.
      note('applied', `developer mode ${dev ? 'off' : 'on'}`);
      reply({ dev: !dev });
    })().catch(() => reply(null));
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

// Ignoring the day's interval on purpose. A copy that has just been installed
// or reloaded should find out where it stands straight away: someone who
// downloads a months-old zip today would otherwise be told it is current, and
// only learn the truth tomorrow.
chrome.runtime.onInstalled.addListener(() => {
  syncAll().catch(() => {});
  void checkUpdate(true).catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { syncAll().catch(() => {}); });

// At module scope rather than behind onStartup/onInstalled, so it runs whenever
// the worker wakes — which is whenever winnower is doing anything. The day's
// interval lives in storage, so waking often costs nothing.
void checkUpdate().catch(() => {});
