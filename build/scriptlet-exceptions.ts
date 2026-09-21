/**
 * Which scriptlet exceptions (`#@#+js(...)`) a compiled list file carries.
 *
 * Kept apart from convert-scriptlets.ts so build/validate.ts can put cases to
 * the same code the build runs, rather than to a copy of its logic.
 */
import { scriptlets } from '@adguard/scriptlets';

/** One exception, as found in a list. `name` undefined means every scriptlet. */
export interface ScriptletException {
  list: string;
  name?: string;
  args: string[];
}

/**
 * One name per scriptlet, whatever alias a rule spells it with.
 *
 * The lists write the same scriptlet several ways (`aopr`,
 * `abort-on-property-read`, `aopr.js`) and the converter keeps the spelling it
 * was given, so `#@#+js(set-constant, foo, 1)` and `##+js(set, foo, 1)` arrive
 * as ubo-set-constant and ubo-set. uBlock treats them as one scriptlet. The
 * function the library runs for each is the same, and its name is the one
 * reliable identity.
 */
export const scriptletId = (name: string): string => scriptlets.getScriptletFunction(name)?.name ?? name;

/**
 * The exception table for one file: host to the argument lists (as JSON) it
 * must not run with, or `*` for none at all.
 *
 * An exception counts for a file of its own list, and for other lists' files
 * only when its list is on by default. The files cannot see which lists are
 * on, and an exception in a list nobody switched on must not turn off another
 * list's rules.
 */
export function exceptionTable(
  file: { list: string; name: string },
  exceptions: ReadonlyMap<string, readonly ScriptletException[]>,
  onByDefault: ReadonlySet<string>,
): Record<string, string[]> {
  const id = scriptletId(file.name);
  const table: Record<string, string[]> = {};
  for (const [host, found] of exceptions) {
    const keys = found
      .filter((x) => x.list === file.list || onByDefault.has(x.list))
      .filter((x) => x.name === undefined || scriptletId(x.name) === id)
      .map((x) => (x.name === undefined ? '*' : JSON.stringify(x.args)));
    if (keys.length) table[host] = [...new Set(keys)];
  }
  return table;
}
