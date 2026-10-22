/**
 * uBlock Origin's own scriptlet code, for the list rules that only uBlock's
 * code runs as written.
 *
 * The AdGuard library runs most list rules, but its converter refuses every
 * trusted-* rule, and half of those have no AdGuard counterpart at all. Where
 * one exists it is AdGuard's own implementation, which can read the same
 * arguments differently, and the lists' authors test against uBlock. So these
 * rules run uBlock's code, from src/js/resources at a fixed release, which
 * fetch-lists.ts downloads into lists/ubo/ beside the lists.
 *
 * uBlock registers each scriptlet with the helpers it depends on. A compiled
 * file carries those helpers and the scriptlet's function once, and calls it
 * with the rule's arguments as uBlock does: fn(...args), inside a scope that
 * defines scriptletGlobals.
 */
import { readFile } from 'node:fs/promises';

/** The uBlock Origin release the code is taken from. Bump it deliberately. */
export const UBO_VERSION = '1.75.0';
export const UBO_SOURCE = `https://raw.githubusercontent.com/gorhill/uBlock/${UBO_VERSION}/src/js/`;
/** The entry point. Everything it imports, transitively, is fetched beside it. */
export const UBO_ENTRY = 'resources/scriptlets.js';
export const UBO_DIR = new URL('../lists/ubo/', import.meta.url);

interface Registered {
  name: string;
  aliases?: string[];
  fn: (...args: string[]) => unknown;
  dependencies?: string[];
  world?: 'ISOLATED' | 'MAIN';
  requiresTrust?: boolean;
}

interface ArgDetails {
  argBeg: number;
  argEnd: number;
  separatorEnd: number;
  transform: boolean;
  failed: boolean;
}
interface ArglistParserType {
  nextArg(s: string, beg: number): ArgDetails;
  normalizeArg(s: string): string;
}

export interface UboScriptlet {
  /** uBlock's name without `.js`, aliases resolved: trusted-rpnt is trusted-replace-node-text. */
  name: string;
  /** The JavaScript name of the function the call is made to. */
  fnName: string;
  /** Every dependency, then the scriptlet itself, as source text. */
  code: string;
  world: 'MAIN' | 'ISOLATED';
  /** uBlock runs it only from lists it trusts. */
  requiresTrust: boolean;
}

const byName = new Map<string, Registered>();
let parser: ArglistParserType | undefined;

/** Load the fetched code. Fails loudly when it is missing, since the build needs it. */
export async function loadUbo(): Promise<void> {
  if (parser) return;
  await readFile(new URL(UBO_ENTRY, new URL('js/', UBO_DIR))).catch(() => {
    throw new Error(`uBlock Origin ${UBO_VERSION} code is missing from lists/ubo/. Run npm run fetch.`);
  });
  const mod = (await import(new URL(`js/${UBO_ENTRY}`, UBO_DIR).href)) as { builtinScriptlets: Registered[] };
  for (const s of mod.builtinScriptlets) {
    byName.set(s.name, s);
    for (const a of s.aliases ?? []) byName.set(a, s);
  }
  const { ArglistParser } = (await import(new URL('js/arglist-parser.js', UBO_DIR).href)) as {
    ArglistParser: new (separator: string) => ArglistParserType;
  };
  parser = new ArglistParser(',');
}

/**
 * A `+js(...)` body split the way uBlock splits it: unquoted, commas escaped
 * with a backslash or protected by quotes. The scriptlet's name comes first,
 * without `.js`. Null when uBlock's parser reports the arguments malformed.
 */
export function parseUboArgs(body: string): string[] | null {
  if (!parser) throw new Error('loadUbo() first');
  const out: string[] = [];
  for (let i = 0; i < body.length; ) {
    const d = parser.nextArg(body, i);
    if (d.failed) return null;
    const raw = body.slice(d.argBeg, d.argEnd);
    out.push(d.transform ? parser.normalizeArg(raw) : raw);
    if (d.separatorEnd <= i) break;
    i = d.separatorEnd;
  }
  if (out.length) out[0] = out[0].replace(/\.js$/, '');
  return out;
}

/** The scriptlet a rule names, with its dependencies, or undefined if uBlock has none by that name. */
export function uboScriptlet(token: string): UboScriptlet | undefined {
  const main = byName.get(`${token}.js`);
  if (!main) return undefined;
  const seen = new Set<string>([main.name]);
  const deps: string[] = [];
  const queue = [...(main.dependencies ?? [])];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const dep = byName.get(name);
    if (!dep) throw new Error(`uBlock ${main.name} depends on ${name}, which is not registered`);
    deps.push(String(dep.fn));
    queue.push(...(dep.dependencies ?? []));
  }
  return {
    name: main.name.replace(/\.js$/, ''),
    fnName: main.fn.name,
    code: [...deps, String(main.fn)].join('\n'),
    world: main.world === 'ISOLATED' ? 'ISOLATED' : 'MAIN',
    requiresTrust: main.requiresTrust === true,
  };
}
