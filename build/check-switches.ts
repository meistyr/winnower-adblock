/**
 * Exercise the kill switches against the built extension, not against a copy of
 * their logic.
 *
 * The switches have failed silently twice. On YouTube the MAIN-world scripts
 * went on pruning ad payloads after the network and cosmetic layers had turned
 * off. In embedded frames every frame asked about its own hostname, so a
 * third-party frame on a paused page was never paused with it. Both looked
 * correct from the top of the page, which is the only place anyone looks.
 *
 * Neither is reachable from a browser test: a cross-origin frame cannot be read
 * from its parent, and a lost worker message cannot be provoked on demand. So
 * the built files are loaded here with a stubbed chrome and asked directly.
 *
 * Every check asserts the paused case AND the still-filtering case. A check that
 * only ever expects "off" passes just as loudly when the extension does nothing
 * at all.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HIDE_DECLARATION } from '../src/shared/constants.ts';

const EXT_DIR = new URL('../extension/', import.meta.url);

export interface CheckResult {
  lines: string[];
  problems: string[];
}

type Reply = { selectors: string[]; off: boolean; dev: boolean };
type Listener = (msg: unknown, sender: unknown, respond: (r: Reply) => void) => void;

const noopEvent = { addListener: () => {} };

type Registered = { id: string; excludeMatches?: string[] };

/**
 * What the stubbed worker has switched on and registered. Passed in when a
 * check needs to watch registration; otherwise every ruleset reads as off and
 * registration goes nowhere, as before.
 */
interface ScriptingProbe {
  enabled: Set<string>;
  registered: Registered[];
}

/** Load extension/sw.js with a stubbed chrome and hand back its message listener. */
async function loadWorker(allowlist: string[], failStorage = false, probe?: ScriptingProbe): Promise<Listener> {
  const code = await readFile(new URL('sw.js', EXT_DIR), 'utf8');
  let listener: Listener | null = null;

  const chrome = {
    runtime: {
      getURL: (p: string) => fileURLToPath(new URL(p, EXT_DIR)),
      onMessage: { addListener: (fn: Listener) => { listener = fn; } },
      onInstalled: noopEvent,
      onStartup: noopEvent,
      getContexts: async () => [{}],
    },
    storage: {
      local: {
        get: async () => {
          if (failStorage) throw new Error('Extension context invalidated.');
          return { allowlist, master: true };
        },
        set: async () => {},
      },
      // The worker mirrors its diagnostic log into session storage. Absent, the
      // mirror throws from inside a timer, which surfaces as an unhandled
      // rejection in the build rather than as a failed check.
      session: {
        get: async () => ({ winnowerLog: [] }),
        set: async () => {},
      },
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateDynamicRules: async () => {},
      getEnabledRulesets: async () => [...(probe?.enabled ?? [])],
      updateEnabledRulesets: async ({ enableRulesetIds = [], disableRulesetIds = [] }: { enableRulesetIds?: string[]; disableRulesetIds?: string[] }) => {
        for (const id of enableRulesetIds) probe?.enabled.add(id);
        for (const id of disableRulesetIds) probe?.enabled.delete(id);
      },
      onRuleMatchedDebug: noopEvent,
    },
    scripting: {
      getRegisteredContentScripts: async () => (probe?.registered ?? []).map((s) => ({ id: s.id })),
      unregisterContentScripts: async ({ ids }: { ids: string[] }) => {
        if (probe) probe.registered = probe.registered.filter((s) => !ids.includes(s.id));
      },
      // Chrome refuses an id that is already registered, and so does this, or
      // two syncs overlapping would pass here and fail in the browser.
      registerContentScripts: async (scripts: Registered[]) => {
        if (!probe) return;
        const taken = scripts.find((s) => probe.registered.some((r) => r.id === s.id));
        if (taken) throw new Error(`Duplicate script ID '${taken.id}'`);
        probe.registered.push(...scripts);
      },
    },
    tabs: { onRemoved: noopEvent },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setIcon: async () => {} },
    offscreen: { createDocument: async () => {} },
    webNavigation: undefined,
  };

  // One read per file, shared. Reading from disk on every call spaced
  // overlapping syncs apart by the I/O alone, so a race that happens in the
  // browser, where this fetch is fast, never happened here.
  const reads = new Map<string, Promise<string>>();
  const fetchStub = async (p: string) => {
    if (!reads.has(p)) reads.set(p, readFile(p, 'utf8'));
    const text = await reads.get(p)!;
    return { json: async () => JSON.parse(text) as unknown };
  };

  const run = new Function('chrome', 'fetch', 'console', code) as
    (c: unknown, f: unknown, l: unknown) => void;
  run(chrome, fetchStub, { log: () => {}, error: () => {} });

  if (!listener) throw new Error('extension/sw.js registered no onMessage listener');
  return listener;
}

function askWorker(listener: Listener, frameHost: string, topUrl: string): Promise<Reply> {
  return new Promise((resolve) => {
    listener(
      { type: 'winnower:cosmetic', hostname: frameHost },
      topUrl ? { tab: { url: topUrl, id: 1 }, frameId: 1 } : { frameId: 1 },
      resolve,
    );
  });
}

/**
 * Load extension/content.js against a stub that fails the first `failures`
 * sendMessage calls, and report what it did.
 *
 * setTimeout fires immediately here. The retry backoff is what is under test,
 * not how long it waits, and the collapse passes it also schedules find nothing
 * in an empty document.
 */
async function runContentScript(failures: number, reply: Reply) {
  const code = await readFile(new URL('content.js', EXT_DIR), 'utf8');
  let sends = 0;

  const stubEl = () => ({
    style: { setProperty: () => {}, removeProperty: () => {} },
    dataset: {} as Record<string, string>,
    querySelectorAll: () => [],
    querySelector: () => null,
    getBoundingClientRect: () => ({ height: 0, width: 0 }),
    appendChild: () => {},
    tagName: 'DIV',
    innerText: '',
    textContent: '',
  });

  const documentElement = stubEl();
  // Keep what the script builds. The marker that tells the collapser which
  // hiding is winnower's own is assembled at runtime, not baked into the
  // bundle as a literal, so grepping content.js for it proves nothing. The
  // only honest check is what the script actually injects.
  const created: ReturnType<typeof stubEl>[] = [];
  const document = {
    documentElement,
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    createElement: () => { const el = stubEl(); created.push(el); return el; },
    head: stubEl(),
  };

  const chrome = {
    runtime: {
      lastError: undefined as { message: string } | undefined,
      sendMessage(msg: { type?: string } | undefined, cb: (r: Reply | undefined) => void) {
        // Only the cosmetic question is under test. The content script also
        // posts batches of diagnostic lines, and counting those would make the
        // retry assertion depend on how much it happened to record, which is
        // exactly what it started doing the moment logging was added.
        if (msg?.type !== 'winnower:cosmetic') {
          cb(undefined);
          return;
        }
        sends += 1;
        const lost = sends <= failures;
        // Set on every send, not just the failing ones: setTimeout fires
        // synchronously in this harness, so a retry runs nested inside the
        // previous callback and would otherwise still see the old error.
        chrome.runtime.lastError = lost ? { message: 'worker asleep or reloading' } : undefined;
        cb(lost ? undefined : reply);
        chrome.runtime.lastError = undefined;
      },
    },
  };

  const run = new Function(
    'chrome', 'document', 'location', 'getComputedStyle', 'setTimeout', 'clearTimeout',
    'MutationObserver', 'addEventListener', 'console', code,
  ) as (...a: unknown[]) => void;

  run(
    chrome,
    document,
    { hostname: 'www.amazon.com', href: 'https://www.amazon.com/' },
    // getPropertyValue as well as display: the collapser reads the provenance
    // marker off the same object, and a stub without it throws rather than
    // failing a check, which would read as a broken harness and not a bug.
    () => ({ display: 'block', getPropertyValue: () => '' }),
    (fn: () => void) => { fn(); return 0; },
    () => {},
    // The collapser watches the page for changes rather than running to a fixed
    // timetable. Both this and clearTimeout are free variables in the bundle,
    // and Node has neither. Without them content.js throws a ReferenceError
    // before a single check runs, which reads as a broken harness, not a bug.
    class { observe() {} disconnect() {} takeRecords() { return []; } },
    // The content script flushes its diagnostic log on pagehide, so the global
    // addEventListener has to exist here too.
    () => {},
    { log: () => {}, error: () => {} },
  );

  return {
    sends,
    switchApplied: documentElement.dataset.winnowerOff === '1',
    injectedCss: created.map((el) => el.textContent).join('\n'),
  };
}

export async function checkSwitches(): Promise<CheckResult> {
  const lines: string[] = [];
  const problems: string[] = [];
  const note = (ok: boolean, label: string, detail: string) => {
    lines.push(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(34)} ${detail}`);
    if (!ok) problems.push(`kill switch: ${label}, ${detail}`);
  };

  // --- the worker's decision, per frame ---
  // The allowlist names one site. A frame is paused when the PAGE is paused,
  // not when the frame's own host happens to be on the list.
  const worker = await loadWorker(['amazon.com']);

  const topPaused = await askWorker(worker, 'www.amazon.com', 'https://www.amazon.com/');
  note(topPaused.off, 'top frame of a paused site', `off=${topPaused.off}`);

  const framePaused = await askWorker(worker, 'amazon-adsystem.com', 'https://www.amazon.com/');
  note(framePaused.off, 'embedded frame on a paused site', `off=${framePaused.off}`);

  const frameLive = await askWorker(worker, 'amazon-adsystem.com', 'https://www.theverge.com/');
  note(!frameLive.off, 'embedded frame on a live site', `off=${frameLive.off}`);

  // The positive half: a site nobody paused still gets its selectors. Without
  // this, every check above passes on an extension that has stopped working.
  const topLive = await askWorker(worker, 'www.theverge.com', 'https://www.theverge.com/');
  note(!topLive.off && topLive.selectors.length > 0, 'top frame of a live site', `off=${topLive.off}, ${topLive.selectors.length} selectors`);

  // Chrome did not say which tab this came from, so the page cannot be
  // identified. Falling back to the frame's own hostname would reinstate the
  // original bug, so winnower steps back instead.
  const noTab = await askWorker(worker, 'amazon-adsystem.com', '');
  note(noTab.off, 'frame with an unidentifiable tab', `off=${noTab.off}`);

  // Same rule when the settings themselves cannot be read at all.
  const brokenWorker = await loadWorker(['amazon.com'], true);
  const unreadable = await askWorker(brokenWorker, 'www.theverge.com', 'https://www.theverge.com/');
  note(unreadable.off, 'steps back if settings unreadable', `off=${unreadable.off}`);

  // --- the content script, when the worker misses a message ---
  const givesUp = await runContentScript(3, { selectors: [], off: true, dev: false });
  note(givesUp.sends > 1, 'asks again after a lost message', `${givesUp.sends} attempts`);

  const recovers = await runContentScript(2, { selectors: [], off: true, dev: false });
  note(recovers.switchApplied, 'applies the switch after retrying', `attempts=${recovers.sends}, applied=${recovers.switchApplied}`);

  // When every attempt is lost the switches cannot be read at all, so winnower
  // steps back rather than risk filtering a paused site. data-winnower-off MUST
  // be set here, which turns off every rule in generic.css.
  const exhausted = await runContentScript(99, { selectors: [], off: true, dev: false });
  note(exhausted.switchApplied && exhausted.sends === 4, 'steps back if every try is lost', `attempts=${exhausted.sends}, applied=${exhausted.switchApplied}`);

  // --- the provenance marker on the rules the content script injects ---
  // src/collapse.ts only collapses a box once it finds something WINNOWER hid
  // inside it, and it knows winnower's own hiding by this marker. A domain rule
  // that hid without marking would leave the collapser blind to precisely the
  // boxes those selectors just emptied, and nothing would error. It would
  // quietly collapse less. generic.css is asserted separately in validate.ts.
  const injected = await runContentScript(0, { selectors: ['.ad-slot', '.promo'], off: false, dev: false });
  const marked = injected.injectedCss.includes(HIDE_DECLARATION);
  note(marked, 'domain rules carry the hide marker', marked ? HIDE_DECLARATION : `injected ${JSON.stringify(injected.injectedCss.slice(-40))}`);

  // --- the lists' scriptlets follow their list's switch ---
  // Fanboy's Annoyance is off by default and holds thousands of set-cookie
  // rules. Its scriptlets must register when it is switched on and go when it
  // is switched off again, while the lists left on keep theirs throughout.
  // Toggled through the same message winnower's menu sends.
  const probe: ScriptingProbe = { enabled: new Set(['ubo-filters']), registered: [] };
  const toggler = await loadWorker(['amazon.com'], false, probe);
  const toggle = (ids: string[]) =>
    new Promise<void>((resolve) => toggler({ type: 'winnower:toggleGroup', ids }, {}, () => resolve()));
  const registeredFrom = (list: string) => probe.registered.filter((s) => s.id.startsWith(`winnower-lists-${list}-`)).length;

  await toggle(['fanboy-annoyance']);
  const whenOn = registeredFrom('fanboy-annoyance');
  note(whenOn > 0, 'a list switched on registers', `fanboy-annoyance: ${whenOn} scripts`);

  await toggle(['fanboy-annoyance']);
  const whenOff = registeredFrom('fanboy-annoyance');
  const kept = registeredFrom('ubo-filters');
  note(whenOff === 0 && kept > 0, 'a list switched off unregisters', `fanboy-annoyance: ${whenOff}, ubo-filters kept: ${kept}`);

  const listScript = probe.registered.find((s) => s.id.startsWith('winnower-lists-'));
  const paused = listScript?.excludeMatches?.includes('*://*.amazon.com/*') ?? false;
  note(paused, 'list scriptlets skip paused sites', paused ? 'amazon.com excluded' : 'amazon.com not excluded');

  // Two switches flipped before the first sync finishes. Each sync unregisters
  // and registers again, so overlapping runs re-register ids the other has
  // already put back. Both lists must end up registered, with no error.
  const replies: unknown[] = [];
  const toggleReply = (ids: string[]) =>
    new Promise<void>((resolve) => toggler({ type: 'winnower:toggleGroup', ids }, {}, (r) => { replies.push(r); resolve(); }));
  await Promise.all([toggleReply(['fanboy-annoyance']), toggleReply(['easylist-cookie'])]);
  const bothOn = registeredFrom('fanboy-annoyance') > 0 && probe.enabled.has('easylist-cookie');
  const errored = replies.some((r) => typeof r === 'object' && r !== null && 'error' in r);
  note(bothOn && !errored, 'two switches at once both apply', errored ? `error: ${JSON.stringify(replies)}` : `fanboy-annoyance: ${registeredFrom('fanboy-annoyance')} scripts`);

  return { lines, problems };
}
