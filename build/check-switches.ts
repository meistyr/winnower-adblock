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

const EXT_DIR = new URL('../extension/', import.meta.url);

export interface CheckResult {
  lines: string[];
  problems: string[];
}

type Reply = { selectors: string[]; off: boolean };
type Listener = (msg: unknown, sender: unknown, respond: (r: Reply) => void) => void;

const noopEvent = { addListener: () => {} };

/** Load extension/sw.js with a stubbed chrome and hand back its message listener. */
async function loadWorker(allowlist: string[], failStorage = false): Promise<Listener> {
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
      },
    },
    declarativeNetRequest: {
      getDynamicRules: async () => [],
      updateDynamicRules: async () => {},
      getEnabledRulesets: async () => [],
      onRuleMatchedDebug: noopEvent,
    },
    scripting: {
      getRegisteredContentScripts: async () => [],
      unregisterContentScripts: async () => {},
      registerContentScripts: async () => {},
    },
    tabs: { onRemoved: noopEvent },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setIcon: async () => {} },
    offscreen: { createDocument: async () => {} },
    webNavigation: undefined,
  };

  const fetchStub = async (p: string) => ({
    json: async () => JSON.parse(await readFile(p, 'utf8')) as unknown,
  });

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
  const document = {
    documentElement,
    getElementById: () => null,
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: () => {},
    createElement: () => stubEl(),
    head: stubEl(),
  };

  const chrome = {
    runtime: {
      lastError: undefined as { message: string } | undefined,
      sendMessage(_msg: unknown, cb: (r: Reply | undefined) => void) {
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
    'chrome', 'document', 'location', 'getComputedStyle', 'setTimeout', 'console', code,
  ) as (...a: unknown[]) => void;

  run(
    chrome,
    document,
    { hostname: 'www.amazon.com', href: 'https://www.amazon.com/' },
    () => ({ display: 'block' }),
    (fn: () => void) => { fn(); return 0; },
    { log: () => {}, error: () => {} },
  );

  return { sends, switchApplied: documentElement.dataset.winnowerOff === '1' };
}

export async function checkSwitches(): Promise<CheckResult> {
  const lines: string[] = [];
  const problems: string[] = [];
  const note = (ok: boolean, label: string, detail: string) => {
    lines.push(`  ${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(34)} ${detail}`);
    if (!ok) problems.push(`kill switch: ${label} — ${detail}`);
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
  const givesUp = await runContentScript(3, { selectors: [], off: true });
  note(givesUp.sends > 1, 'asks again after a lost message', `${givesUp.sends} attempts`);

  const recovers = await runContentScript(2, { selectors: [], off: true });
  note(recovers.switchApplied, 'applies the switch after retrying', `attempts=${recovers.sends}, applied=${recovers.switchApplied}`);

  // When every attempt is lost the switches cannot be read at all, so winnower
  // steps back rather than risk filtering a paused site. data-winnower-off MUST
  // be set here, which turns off every rule in generic.css.
  const exhausted = await runContentScript(99, { selectors: [], off: true });
  note(exhausted.switchApplied && exhausted.sends === 4, 'steps back if every try is lost', `attempts=${exhausted.sends}, applied=${exhausted.switchApplied}`);

  return { lines, problems };
}
