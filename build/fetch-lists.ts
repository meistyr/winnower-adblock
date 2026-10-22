/**
 * Fetch upstream filter lists into lists/.
 *
 * Every list is sanity-checked before it is written. A 404 that returns an HTML
 * error page is the dangerous failure here: it parses as "a filter list with no
 * filters", converts to zero rules, and leaves you with a build that looks clean
 * and blocks nothing. So we assert something positive about each payload.
 *
 * Uses node:https with `agent: false` rather than global fetch(). Node 22's
 * bundled undici trips an uncatchable assertion: assert(!this.paused) in
 * Parser.finish, when it reuses a keep-alive socket against some hosts
 * (easylist.to, reproducibly, on the request after a large response). The
 * assertion fires from a TLSSocket event handler, so try/catch cannot contain
 * it; it takes the process down. `agent: false` opens a fresh connection per
 * request and avoids the pooling path entirely.
 */
import { writeFile, mkdir, rm } from 'node:fs/promises';
import https from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { LISTS, type FilterList } from './lists.config.ts';
import { UBO_DIR, UBO_ENTRY, UBO_SOURCE, UBO_VERSION } from './ubo-scriptlets.ts';

const OUT_DIR = new URL('../lists/', import.meta.url);
const TIMEOUT_MS = 45_000;
const MIN_LINES = 100;
const MAX_REDIRECTS = 5;

function decompressor(encoding: string | undefined) {
  if (encoding === 'gzip') return createGunzip();
  if (encoding === 'deflate') return createInflate();
  if (encoding === 'br') return createBrotliDecompress();
  return null;
}

function httpGet(url: string, redirectsLeft = MAX_REDIRECTS): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        agent: false,
        headers: {
          'user-agent': 'winnower/0.1 (+https://github.com/meistyr/winnower-adblock)',
          'accept-encoding': 'gzip, deflate, br',
        },
      },
      (res) => {
        const { headers } = res;
        const statusCode = res.statusCode ?? 0; // always set on a client response

        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          res.resume();
          if (redirectsLeft === 0) return reject(new Error('too many redirects'));
          return httpGet(new URL(headers.location, url).href, redirectsLeft - 1).then(resolve, reject);
        }
        if (statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${statusCode} ${res.statusMessage ?? ''}`.trim()));
        }

        const gunzip = decompressor(headers['content-encoding']);
        const stream = gunzip ? res.pipe(gunzip) : res;

        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        stream.on('error', reject);
        res.on('error', reject);
      },
    );

    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error(`timed out after ${TIMEOUT_MS}ms`)));
    req.on('error', reject);
  });
}

/** Lines that are actual filters, not comments or blanks. */
function countFilters(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t !== '' && !t.startsWith('!') && !t.startsWith('[')) n += 1;
  }
  return n;
}

function assertLooksLikeFilterList(text: string): number {
  if (/^\s*<(?:!doctype|html)/i.test(text)) {
    throw new Error(`got HTML, not a filter list (bad URL or captive portal?)`);
  }
  const lines = text.split('\n').length;
  if (lines < MIN_LINES) throw new Error(`only ${lines} lines, too short to be real`);
  const filters = countFilters(text);
  if (filters === 0) throw new Error('parsed 0 actual filters');
  return filters;
}

async function fetchList({ name, url, tier }: FilterList) {
  const text = await httpGet(url);
  const filters = assertLooksLikeFilterList(text);
  await writeFile(new URL(`${name}.txt`, OUT_DIR), text, 'utf8');
  return { name, tier, filters, bytes: Buffer.byteLength(text) };
}

/**
 * uBlock Origin's scriptlet code at UBO_VERSION (see ubo-scriptlets.ts): the
 * entry point and every module it imports, followed through relative imports,
 * written under lists/ubo/js/ with uBlock's own layout so the imports resolve.
 * Checked by loading it: a fetch that went wrong fails here, not in the build.
 */
async function fetchUbo(): Promise<{ files: number; scriptlets: number }> {
  const todo = [UBO_ENTRY];
  const done = new Set<string>();
  while (todo.length) {
    const path = todo.shift()!;
    if (done.has(path)) continue;
    done.add(path);
    const text = await httpGet(new URL(path, UBO_SOURCE).href);
    if (/^\s*<(?:!doctype|html)/i.test(text)) throw new Error(`${path}: got HTML, not JavaScript`);
    const file = new URL(`js/${path}`, UBO_DIR);
    await mkdir(new URL('.', file), { recursive: true });
    await writeFile(file, text, 'utf8');
    for (const [, spec] of text.matchAll(/^\s*(?:import|export)\b[^'"]*?from\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const next = new URL(spec, new URL(path, 'https://x/')).pathname.slice(1);
      if (!done.has(next)) todo.push(next);
    }
    for (const [, spec] of text.matchAll(/^\s*import\s+['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const next = new URL(spec, new URL(path, 'https://x/')).pathname.slice(1);
      if (!done.has(next)) todo.push(next);
    }
  }
  const mod = (await import(new URL(`js/${UBO_ENTRY}`, UBO_DIR).href)) as { builtinScriptlets?: unknown[] };
  const scriptlets = mod.builtinScriptlets?.length ?? 0;
  if (scriptlets < 100) throw new Error(`only ${scriptlets} scriptlets registered, expected well over 100`);
  return { files: done.size, scriptlets };
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const ok: Array<Awaited<ReturnType<typeof fetchList>>> = [];
  const failed: Array<{ name: string; reason: string }> = [];
  for (const list of LISTS) {
    try {
      ok.push(await fetchList(list));
    } catch (err) {
      failed.push({ name: list.name, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const pad = (s: string | number, n: number) => String(s).padEnd(n);
  const num = (s: string | number, n: number) => String(s).padStart(n);

  console.log('');
  console.log(`  ${pad('list', 22)} ${num('filters', 9)} ${num('KB', 8)}  tier`);
  console.log(`  ${'-'.repeat(22)} ${'-'.repeat(9)} ${'-'.repeat(8)}  ----`);
  for (const r of [...ok].sort((a, b) => a.tier - b.tier || a.name.localeCompare(b.name))) {
    console.log(
      `  ${pad(r.name, 22)} ${num(r.filters.toLocaleString(), 9)} ${num(Math.round(r.bytes / 1024).toLocaleString(), 8)}   ${r.tier}`,
    );
  }

  const total = ok.reduce((a, r) => a + r.filters, 0);
  console.log(`  ${'-'.repeat(22)} ${'-'.repeat(9)} ${'-'.repeat(8)}`);
  console.log(`  ${pad('TOTAL', 22)} ${num(total.toLocaleString(), 9)}`);
  console.log('');

  let ubo: Awaited<ReturnType<typeof fetchUbo>> | undefined;
  try {
    await rm(UBO_DIR, { recursive: true, force: true });
    ubo = await fetchUbo();
  } catch (err) {
    failed.push({ name: `uBlock Origin ${UBO_VERSION} scriptlets`, reason: err instanceof Error ? err.message : String(err) });
  }

  if (failed.length) {
    console.error('FAILED:');
    for (const f of failed) console.error(`  ${f.name}: ${f.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${ok.length}/${LISTS.length} lists fetched`);
  console.log(`✓ uBlock Origin ${UBO_VERSION}: ${ubo!.files} files, ${ubo!.scriptlets} scriptlets`);
}

await main();
