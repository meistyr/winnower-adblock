/**
 * winnower popup.
 *
 * Diagnostics are read from the page itself rather than trusted from the
 * worker, because development repeatedly turned up layers that were silently not
 * running while everything reported success. The popup shows what actually
 * happened on the page you are looking at.
 */
import type { BuildStats, ListGroup } from './shared/catalogue.ts';
import { DOWNLOAD_PAGE } from './shared/constants.ts';
import { formatLog, formatTime, groupRepeats, type LogLine } from './shared/log.ts';
import type { Message, PopupState, Reply } from './shared/messages.ts';

const GROUPS: ReadonlyArray<{ key: ListGroup; label: string; note: string }> = [
  { key: 'ads',        label: 'Ads',            note: 'EasyList + uBlock Origin filters' },
  { key: 'tracking',   label: 'Tracking',       note: 'EasyPrivacy, Peter Lowe' },
  { key: 'popups',     label: 'Popups',         note: 'Popunders, and visiting those domains too' },
  { key: 'cookies',    label: 'Cookie banners', note: 'Consent overlays' },
  { key: 'annoyances', label: 'Annoyances',     note: 'Newsletter nags, overlays. May break sites.' },
];

/** Elements popup.html is known to contain. */
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Message the worker. Resolves null when it could not answer (asleep, reloading). */
const send = <M extends Message>(msg: M) =>
  new Promise<Reply<M['type']> | null>((resolve) =>
    chrome.runtime.sendMessage(msg, (r: Reply<M['type']>) => resolve(chrome.runtime.lastError ? null : r)),
  );

let tab: chrome.tabs.Tab | undefined;
let hostname = '';
/** Set by five clicks on the version; forgotten when the popup closes. */
let devRevealed = false;

interface PageDiagnostics {
  cosmetic: number | null;
  collapsed: number | null;
  off: boolean;
  scriptlets: number | null;
  popupGuard: { hosts: number; blocked: number } | null;
}

/**
 * Runs in the page's MAIN world, where the scriptlet and popup-guard globals live.
 * Serialised by executeScript, so it must not reference anything outside itself
 * (see the keepNames note in build/compile.ts).
 */
function readPageDiagnostics(): PageDiagnostics {
  const d = document.documentElement.dataset;
  return {
    cosmetic: d.winnowerCosmetic != null ? Number(d.winnowerCosmetic) : null,
    collapsed: d.winnowerCollapsedCount != null ? Number(d.winnowerCollapsedCount) : null,
    off: d.winnowerOff === '1',
    scriptlets: window.__winnower_youtube?.rules ?? null,
    popupGuard: window.__winnowerPopupStats ?? null,
  };
}

function setDiag(id: string, text: string, cls: string) {
  const el = $(id);
  el.textContent = text;
  el.className = cls;
}

async function renderDiagnostics() {
  if (!tab?.id) return;
  let diag: PageDiagnostics | null = null;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      world: 'MAIN',
      func: readPageDiagnostics,
    });
    diag = res?.result ?? null;
  } catch {
    // chrome://, the Web Store, and other pages extensions cannot touch.
  }

  if (!diag) {
    for (const id of ['d-cosmetic', 'd-collapsed', 'd-scriptlets', 'd-popups']) setDiag(id, 'n/a', 'na');
    return;
  }

  if (diag.off) {
    for (const id of ['d-cosmetic', 'd-collapsed']) setDiag(id, 'paused', 'warn');
  } else {
    setDiag('d-cosmetic', diag.cosmetic == null ? 'generic only' : `${diag.cosmetic} selectors`, diag.cosmetic == null ? 'na' : 'ok');
    setDiag('d-collapsed', diag.collapsed == null ? 'pending' : String(diag.collapsed), diag.collapsed ? 'ok' : 'na');
  }

  const isYouTube = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtubekids\.com)$/.test(hostname);
  if (!isYouTube) setDiag('d-scriptlets', 'not this site', 'na');
  else if (diag.scriptlets) setDiag('d-scriptlets', `${diag.scriptlets} rules ✓`, 'ok');
  // On YouTube but absent: the MAIN-world script did not inject. Worth shouting.
  else setDiag('d-scriptlets', 'NOT LOADED', 'warn');

  if (!diag.popupGuard) setDiag('d-popups', 'guard not loaded', 'warn');
  else setDiag('d-popups', String(diag.popupGuard.blocked), diag.popupGuard.blocked ? 'ok' : 'na');
}

function renderState(state: PopupState) {
  $('host').textContent = state.host || '—';

  const active = state.master && !state.allowlisted;
  const card = $('site-card');
  card.classList.toggle('is-on', active);
  card.classList.toggle('is-off', !active);
  $<HTMLInputElement>('site-toggle').checked = !state.allowlisted;
  $<HTMLInputElement>('site-toggle').disabled = !state.master;
  $('site-label').textContent = active ? 'Blocking on this site' : 'Paused on this site';
  $('site-sub').textContent = !state.master
    ? 'Master switch is off'
    : state.allowlisted ? 'Allowlisted, nothing is blocked here' : 'Ads, trackers and popups';

  $<HTMLInputElement>('master-toggle').checked = state.master;
  $('master-banner').hidden = state.master;

  // Stays on screen once developer mode is on, so it can be turned off again
  // without remembering how it was turned on.
  $<HTMLInputElement>('dev-toggle').checked = state.dev;
  $('dev-row').hidden = !(state.dev || devRevealed);
  $('diag-count').textContent = state.recorded.toLocaleString();

  $('stat-blocked').textContent = state.blocked.toLocaleString();

  // Group toggles: a group reads as on if any of its rulesets is enabled.
  const container = $('groups');
  container.textContent = '';
  for (const g of GROUPS) {
    const ids = state.rulesets.filter((r) => r.group === g.key).map((r) => r.id);
    if (!ids.length) continue;
    const on = state.rulesets.some((r) => r.group === g.key && r.enabled);

    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `
      <div class="row-label">
        <span></span>
        <span class="row-note"></span>
      </div>
      <label class="switch">
        <input type="checkbox">
        <span class="track"></span>
      </label>`;
    row.querySelector('.row-label span')!.textContent = g.label;
    row.querySelector('.row-note')!.textContent = g.note;
    const input = row.querySelector('input')!;
    input.checked = on;
    input.setAttribute('aria-label', g.label);
    input.addEventListener('change', async () => {
      input.disabled = true;
      await send({ type: 'winnower:toggleGroup', ids });
      await refresh();
    });
    container.appendChild(row);
  }
}

/**
 * The paused-sites list, and the button that opens it.
 *
 * The allowlist has always been in PopupState, buildState in src/sw.ts puts it
 * there, and this menu never rendered it, so the only way to find out whether
 * a site was paused was to go and visit it. That cost a long detour once:
 * amazon.com and amazon.co.uk are separate allowlist entries, and neither of us
 * could see which one had been paused.
 *
 * Sorted rather than left in insertion order. The question this answers is "is
 * X paused?", which is a scan, and storage keeps whatever order the toggles
 * happened to land in.
 */
function renderPaused(state: PopupState) {
  const sites = [...state.allowlist].sort((a, b) => a.localeCompare(b));

  $('paused-count').textContent = String(sites.length);
  // Disabled rather than hidden when empty: a control that vanishes gives
  // someone who paused a site last week nowhere to look for it.
  $<HTMLButtonElement>('open-paused').disabled = sites.length === 0;

  const list = $('paused-list');
  list.textContent = '';

  if (!sites.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No sites are paused.';
    list.appendChild(empty);
    return;
  }

  for (const site of sites) {
    const row = document.createElement('div');
    row.className = 'paused-row';
    row.innerHTML = `
      <span class="paused-host"></span>
      <button class="unpause" type="button">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>
      </button>`;
    // textContent, not interpolated into the innerHTML above: these strings come
    // from storage and are shown back verbatim.
    row.querySelector('.paused-host')!.textContent = site;
    const button = row.querySelector<HTMLButtonElement>('.unpause')!;
    button.title = `Resume blocking on ${site}`;
    button.setAttribute('aria-label', `Resume blocking on ${site}`);
    button.addEventListener('click', () => unpause(site, button));
    list.appendChild(row);
  }
}

/**
 * Resume blocking on a site from the list.
 *
 * The reload is conditional, unlike every other toggle here. The site card and
 * the master switch both act on the page you are looking at, so they reload it
 * unconditionally; a site resumed from this list is usually NOT the open tab,
 * and reloading it would throw away whatever you were doing for a change that
 * does not affect it. Matched the way isAllowlisted does in src/sw.ts, exact
 * host or subdomain, so the reload happens exactly when this page's filtering
 * actually changed.
 */
async function unpause(site: string, button: HTMLButtonElement) {
  button.disabled = true;
  await send({ type: 'winnower:toggleSite', hostname: site });
  if (hostname === site || hostname.endsWith('.' + site)) await reloadTab();
  else await refresh();
}

type View = 'main' | 'paused' | 'diag';

/**
 * Swap views, taking focus with them so the keyboard follows the eye.
 *
 * The caller names what to focus rather than this working it out: returning to
 * the menu should land on the row you left through, and only the caller knows
 * which one that was.
 */
function showView(view: View, focusId: string) {
  $('view-main').hidden = view !== 'main';
  $('view-paused').hidden = view !== 'paused';
  $('view-diag').hidden = view !== 'diag';
  $(focusId).focus();
}

// --- the diagnostic log ------------------------------------------------------

/** Held so Copy sends exactly what is on screen, rather than re-asking. */
let logLines: LogLine[] = [];

/** Briefly say what a button just did, then put its label back. */
function flash(button: HTMLElement, text: string) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = original; }, 1200);
}

function renderLog() {
  const list = $('diag-list');
  list.textContent = '';

  if (!logLines.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Nothing recorded yet.';
    list.appendChild(empty);
    return;
  }

  // Grouped by site, same as the copied text: a log is read by someone working
  // out which page each run belongs to. Identical lines from one pass are
  // folded into a count, a grid of twenty cards is twenty real elements and
  // twenty identical lines, and the count says all of what they said.
  let host: string | undefined;
  for (const line of groupRepeats(logLines)) {
    if (line.host !== host) {
      host = line.host;
      const heading = document.createElement('div');
      heading.className = 'log-host';
      heading.textContent = host || 'winnower';
      list.appendChild(heading);
    }

    const row = document.createElement('div');
    row.className = 'log-line';
    row.innerHTML = '<span class="log-t"></span><span class="log-layer"></span><span class="log-verb"></span><span class="log-msg"></span>';
    const text = line.reason ? `${line.subject}: ${line.reason}` : line.subject;
    row.querySelector('.log-t')!.textContent = formatTime(line.t);
    row.querySelector('.log-layer')!.textContent = line.layer;
    const verb = row.querySelector('.log-verb')!;
    verb.textContent = line.verb;
    verb.classList.add(line.verb);
    row.querySelector('.log-msg')!.textContent = text;
    if (line.count > 1) {
      const times = document.createElement('span');
      times.className = 'log-count';
      times.textContent = ` ×${line.count}`;
      row.querySelector('.log-msg')!.appendChild(times);
    }
    row.title = line.count > 1 ? `${text} (${line.count} times in this pass)` : text;
    list.appendChild(row);
  }
}

async function openLog() {
  const answer = await send({ type: 'winnower:diagnostics' });
  logLines = answer?.lines ?? [];
  renderLog();
  showView('diag', 'diag-back');
}

async function countActiveRules(state: PopupState) {
  // Rule counts come from the build's stats file, filtered to what is enabled
  // right now, so this reflects the toggles, not the total ever built.
  try {
    const stats = (await (await fetch(chrome.runtime.getURL('rules/_stats.json'))).json()) as BuildStats;
    const perList = new Map(stats.lists.map((l): [string, number] => [l.name, l.rules]));
    let popupRules = 0;
    try {
      popupRules = ((await (await fetch(chrome.runtime.getURL('rules/popup.json'))).json()) as unknown[]).length;
    } catch {}
    perList.set('popup', popupRules);
    const total = state.rulesets.filter((r) => r.enabled).reduce((a, r) => a + (perList.get(r.id) ?? 0), 0);
    $('stat-rules').textContent = total.toLocaleString();
  } catch {
    $('stat-rules').textContent = '—';
  }
}

/**
 * Show the header notice if a newer release is out.
 *
 * Deliberately not awaited by init: the worker may answer from a cache or may
 * go to the network, and the menu must not sit blank while it finds out. It
 * appears when it appears.
 */
async function showUpdateIfAny() {
  const answer = await send({ type: 'winnower:update' });
  if (!answer?.newer || !answer.latest) return;
  const link = $<HTMLAnchorElement>('update-link');
  $('update-text').textContent = `${answer.latest.replace(/^v/i, '')} available`;
  link.href = DOWNLOAD_PAGE;
  link.title = `winnower ${answer.latest} has been released. Opens the download page`;
  link.hidden = false;
}

async function refresh() {
  const state = await send({ type: 'winnower:state', tabId: tab?.id, hostname });
  if (!state) return;
  renderState(state);
  renderPaused(state);
  await countActiveRules(state);
  await renderDiagnostics();
}

async function reloadTab() {
  $('reload-hint').hidden = false;
  if (tab?.id) await chrome.tabs.reload(tab.id);
  // Give the page a moment to run its content scripts before re-reading them.
  setTimeout(async () => { $('reload-hint').hidden = true; await refresh(); }, 1800);
}

async function init() {
  // From the manifest, which build/write-manifest.ts fills from package.json.
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    hostname = new URL(tab?.url ?? '').hostname;
  } catch {
    hostname = '';
  }

  $('site-toggle').addEventListener('change', async () => {
    await send({ type: 'winnower:toggleSite', hostname });
    await reloadTab();
  });

  $('master-toggle').addEventListener('change', async () => {
    await send({ type: 'winnower:toggleMaster' });
    await reloadTab();
  });

  $('open-paused').addEventListener('click', () => showView('paused', 'paused-back'));
  $('paused-back').addEventListener('click', () => showView('main', 'open-paused'));
  $('open-diag').addEventListener('click', () => void openLog());
  $('diag-back').addEventListener('click', () => showView('main', 'open-diag'));

  $('diag-copy').addEventListener('click', async () => {
    const header = `winnower v${chrome.runtime.getManifest().version}, ${logLines.length} lines`;
    try {
      await navigator.clipboard.writeText(formatLog(logLines, header));
      flash($('diag-copy'), 'Copied');
    } catch {
      // Denied, or no clipboard in this context. Saying so beats a button that
      // silently did nothing, which reads as the log being empty.
      flash($('diag-copy'), 'Blocked');
    }
  });

  $('diag-clear').addEventListener('click', async () => {
    await send({ type: 'winnower:clearDiagnostics' });
    logLines = [];
    renderLog();
    await refresh();
  });

  // Reloads, like the other switches: a page learns whether to record at
  // document_start, so the one you are looking at only starts once it reloads.
  $('dev-toggle').addEventListener('change', async () => {
    await send({ type: 'winnower:toggleDev' });
    await reloadTab();
  });

  // Five clicks on the version reveal developer mode, the Android gesture.
  // Nothing advertises it, which is the point: it is for whoever is working on
  // winnower, and everyone else gets the errors without touching anything.
  let versionClicks = 0;
  $('version').addEventListener('click', () => {
    if (devRevealed) return;
    if ((versionClicks += 1) < 5) return;
    devRevealed = true;
    $('dev-row').hidden = false;
    $('dev-row').scrollIntoView({ block: 'nearest' });
  });

  await refresh();
  void showUpdateIfAny();
}

init();
