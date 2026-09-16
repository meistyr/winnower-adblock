/**
 * Bundle the extension's TypeScript (src/) into extension/.
 *
 * One standalone IIFE per entry point. Content scripts and the popup's classic
 * <script> cannot be ES modules, so anything they share (src/shared/) has to be
 * bundled into each file rather than imported at runtime.
 *
 * esbuild strips types without checking them: `npm run typecheck` is the check.
 *
 * Load-bearing options:
 *   keepNames: false  popup.ts passes readPageDiagnostics to
 *                     chrome.scripting.executeScript({ func }), which serialises
 *                     the function's source and runs it inside the page.
 *                     keepNames wraps functions in a __name() helper that exists
 *                     only in the popup's bundle, so the page would throw.
 *   minify: false     same reason, and unpacked extensions are debugged by
 *                     reading this output.
 *   target chrome121  the manifest minimum; ?. and ?? stay native instead of
 *                     becoming helper calls.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import type { PopupPatterns } from '../src/shared/catalogue.ts';

const SRC = new URL('../src/', import.meta.url);
const EXT_DIR = new URL('../extension/', import.meta.url);

const ENTRIES = ['sw', 'popup', 'cosmetic', 'offscreen', 'popup-guard'] as const;

// The popup guard's host list is baked in at compile time. It runs in the MAIN
// world, where there is no chrome.runtime to fetch it with.
let patterns: PopupPatterns;
try {
  patterns = JSON.parse(await readFile(new URL('popup-patterns.json', EXT_DIR), 'utf8')) as PopupPatterns;
} catch {
  console.error('! extension/popup-patterns.json is missing. Run `npm run popup` first.');
  process.exit(1);
}
if (!Array.isArray(patterns.hosts) || patterns.hosts.length === 0) {
  console.error('! extension/popup-patterns.json has no hosts; the popup guard would block nothing.');
  process.exit(1);
}

const result = await build({
  entryPoints: Object.fromEntries(ENTRIES.map((name) => [name, fileURLToPath(new URL(`${name}.ts`, SRC))])),
  outdir: fileURLToPath(EXT_DIR),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome121',
  minify: false,
  keepNames: false,
  sourcemap: false,
  charset: 'utf8',
  banner: { js: '/* winnower — generated from src/ by build/compile.ts. Do not edit. */\n"use strict";' },
  define: { POPUP_HOSTS: JSON.stringify(patterns.hosts) },
  metafile: true,
  logLevel: 'warning',
});

if (result.errors.length) process.exit(1);
for (const [file, out] of Object.entries(result.metafile.outputs)) {
  console.log(`  ${file.replace(/^.*extension[\/]/, '').padEnd(18)} ${String(Math.round(out.bytes / 1024)).padStart(4)} KB`);
}
console.log(`\u2713 compiled ${ENTRIES.length} entry points into extension/ (popup guard: ${patterns.hosts.length.toLocaleString()} hosts)`);
