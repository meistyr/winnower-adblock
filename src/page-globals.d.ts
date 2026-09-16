/**
 * Globals winnower's MAIN-world scripts put on page windows. The popup reads
 * them back through chrome.scripting.executeScript as its diagnostics.
 */
interface Window {
  /** Set by popup-guard.ts so a second injection does not wrap window.open twice. */
  __winnowerPopup?: boolean;
  /** popup-guard.ts: hosts it knows, window.open calls it refused on this page. */
  __winnowerPopupStats?: { hosts: number; blocked: number };
  /** build/build-scriptlets.ts: rules loaded in the YouTube scriptlet bundle. */
  __winnower_youtube?: { rules: number; version: string };
}
