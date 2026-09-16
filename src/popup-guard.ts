/**
 * window.open guard for JS-driven popunders.
 *
 * Those never produce a navigation DNR can block: the page calls window.open()
 * itself, so this wraps it. Runs in the page's MAIN world at document_start
 * (registered by the worker from dynamic-scripts.json), where there are no
 * chrome.* APIs, and window.open has to answer synchronously anyway. So the host
 * list is baked in at compile time: build/compile.ts replaces POPUP_HOSTS with
 * the hosts build/convert-popup.ts extracted from the $popup filters.
 */
declare const POPUP_HOSTS: readonly string[];

(() => {
  if (window.__winnowerPopup) return;
  window.__winnowerPopup = true;

  const HOSTS = new Set(POPUP_HOSTS);
  let blocked = 0;

  /** Match the host or any parent domain, so sub.evil.com hits evil.com. */
  function isBlocked(host: string): boolean {
    host = host.replace(/^www\./, '');
    if (HOSTS.has(host)) return true;
    const parts = host.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      if (HOSTS.has(parts.slice(i).join('.'))) return true;
    }
    return false;
  }

  const realOpen = window.open;
  window.open = function (this: Window, url?: string | URL, ...rest: [target?: string, features?: string]) {
    try {
      if (url) {
        const u = new URL(String(url), location.href);
        if ((u.protocol === 'http:' || u.protocol === 'https:') && isBlocked(u.hostname)) {
          blocked += 1;
          // Return a stub, not null: pages commonly dereference the result
          // (win.focus(), win.closed) and would throw on null, which can break
          // the click handler that was doing something legitimate as well.
          const stub = { closed: true, close() {}, focus() {}, blur() {}, postMessage() {}, document: null, location: { href: '' } };
          return stub as unknown as Window;
        }
      }
    } catch {
      /* unparseable URL — fall through to the real implementation */
    }
    return realOpen.apply(this, [url, ...rest]);
  };

  Object.defineProperty(window, '__winnowerPopupStats', {
    configurable: true,
    get: () => ({ hosts: HOSTS.size, blocked }),
  });
})();
