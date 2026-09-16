/**
 * Zip the built extension into winnower.zip, the release asset.
 *
 * Files sit at the root of the zip, so unzipping gives a folder that can be
 * selected directly in chrome://extensions → Load unpacked. The name never
 * changes between versions, which keeps
 * github.com/meistyr/winnower-adblock/releases/latest/download/winnower.zip a
 * permanent link the website can use.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, type Zippable } from 'fflate';

const EXT_DIR = new URL('../extension/', import.meta.url);
const OUT = new URL('../winnower.zip', import.meta.url);

/**
 * Not part of a release:
 *   popup-patterns.json  build input only; its hosts are baked into popup-guard.js
 *   _metadata/           Chrome's indexed-ruleset cache, written into extension/ when
 *                        this folder is loaded unpacked on the build machine
 */
const EXCLUDE = (rel: string) => rel === 'popup-patterns.json' || rel.startsWith('_metadata/');

/** A release without these would load, but would be missing its licence, credits or manifest. */
const REQUIRED = ['manifest.json', 'LICENSE.txt', 'CREDITS.txt', 'sw.js', 'popup.html', 'popup-guard.js'];

// Zip entry names always use forward slashes, whatever the OS separator is.
const extPath = fileURLToPath(EXT_DIR);
const entries = (await readdir(EXT_DIR, { recursive: true, withFileTypes: true }))
  .filter((e) => e.isFile())
  .map((e) => relative(extPath, join(e.parentPath, e.name)).split(sep).join('/'))
  .filter((rel) => !EXCLUDE(rel))
  .sort();

const missing = REQUIRED.filter((f) => !entries.includes(f));
if (missing.length) {
  console.error(`! extension/ is missing ${missing.join(', ')}. Run \`npm run update\` first.`);
  process.exit(1);
}

// The version a user sees in chrome://extensions must be the version being released.
const manifest = JSON.parse(await readFile(new URL('manifest.json', EXT_DIR), 'utf8')) as { version: string };
const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
if (manifest.version !== pkg.version) {
  console.error(`! manifest.json is ${manifest.version} but package.json is ${pkg.version}. Run \`npm run manifest\`.`);
  process.exit(1);
}

const files: Zippable = {};
let bytes = 0;
for (const rel of entries) {
  const data = await readFile(new URL(rel, EXT_DIR));
  files[rel] = new Uint8Array(data);
  bytes += data.length;
}

const zip = zipSync(files, { level: 9 });
await writeFile(OUT, zip);

const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
console.log(`✓ winnower.zip: v${manifest.version}, ${entries.length} files, ${mb(bytes)} MB → ${mb(zip.length)} MB`);
