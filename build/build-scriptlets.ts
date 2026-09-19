/**
 * Generate injectable scriptlet bundles from SCRIPTLET_GROUPS.
 *
 * scriptlets.invoke() returns a self-contained IIFE per rule. We concatenate a
 * group's rules into one file per domain group, injected at document_start in
 * the MAIN world.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { scriptlets, SCRIPTLETS_VERSION } from '@adguard/scriptlets';
import { SCRIPTLET_GROUPS } from './scriptlet-rules.ts';

const OUT_DIR = new URL('../extension/scriptlets/', import.meta.url);

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const built: Array<{ id: string; rules: number; of: number; kb: number }> = [];
  for (const group of SCRIPTLET_GROUPS) {
    const parts = [
      `/* winnower, generated. Do not edit.`,
      ` * group: ${group.id}`,
      ` * @adguard/scriptlets ${SCRIPTLETS_VERSION} (GPL-3.0)`,
      ` * regenerate: npm run scriptlets`,
      ` */`,
      `"use strict";`,
    ];

    let ok = 0;
    for (const rule of group.rules) {
      let code: string | null | undefined;
      try {
        code = scriptlets.invoke({
          name: rule.name,
          args: rule.args,
          engine: 'extension',
          version: SCRIPTLETS_VERSION,
          verbose: false,
        });
      } catch (err) {
        console.error(`  ! ${group.id}: ${rule.name} failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        continue;
      }
      if (typeof code !== 'string' || code.length === 0) {
        console.error(`  ! ${group.id}: ${rule.name} produced no code`);
        process.exitCode = 1;
        continue;
      }
      parts.push(`\n/* ${rule.name}(${rule.args.join(', ')}) */`);
      parts.push(`try { ${code} } catch (e) { /* one bad scriptlet must not kill the rest */ }`);
      ok += 1;
    }

    // Verification handle, readable from the MAIN-world console.
    parts.push(
      `\ntry { Object.defineProperty(window, "__winnower_${group.id}", { configurable: true, get: () => ({ rules: ${ok}, version: "${SCRIPTLETS_VERSION}" }) }); } catch (e) {}`,
    );

    const body = parts.join('\n');
    await writeFile(new URL(`${group.id}.js`, OUT_DIR), body, 'utf8');
    built.push({ id: group.id, rules: ok, of: group.rules.length, kb: Math.round(body.length / 1024) });
  }

  console.log('');
  for (const b of built) {
    console.log(`  ${b.id.padEnd(14)} ${String(b.rules).padStart(2)}/${b.of} rules  ${String(b.kb).padStart(4)} KB`);
  }
  console.log('');
  const total = built.reduce((a, b) => a + b.rules, 0);
  if (total === 0) {
    console.error('! no scriptlets generated');
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${built.length} scriptlet bundle(s), ${total} rules`);
}

await main();
