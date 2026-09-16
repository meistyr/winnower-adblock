/**
 * winnower popup.
 *
 * Diagnostics are read from the page itself rather than trusted from the
 * worker, because development repeatedly turned up layers that were silently not
 * running while everything reported success. The popup shows what actually
 * happened on the page you are looking at.
 */
import type { BuildStats, ListGroup } from './shared/catalogue.ts';
import type { Message, PopupState, Reply } from './shared/messages.ts';

const GROUPS: ReadonlyArray<{ key: ListGroup; label: string; note: string }> = [
  { key: 'ads',        label: 'Ads',            note: 'EasyList + uBlock Origin filters' },
  { key: 'tracking',   label: 'Tracking',       note: 'EasyPrivacy, Peter Lowe' },
  { key: 'popups',     label: 'Popups',         note: 'Popunders — also blocks visiting those domains' },
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
    : state.allowlisted ? 'Allowlisted — nothing is blocked here' : 'Ads, trackers and popups';

  $<HTMLInputElement>('master-toggle').checked = state.master;
  $('master-banner').hidden = state.master;

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

async function countActiveRules(state: PopupState) {
  // Rule counts come from the build's stats file, filtered to what is enabled
  // right now — so this reflects the toggles, not the total ever built.
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

async function refresh() {
  const state = await send({ type: 'winnower:state', tabId: tab?.id, hostname });
  if (!state) return;
  renderState(state);
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

  await refresh();
}

init();
