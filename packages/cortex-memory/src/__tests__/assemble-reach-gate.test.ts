/**
 * A capability the ledger calls *"a customer can reach it"* must be nameable at the composition root.
 *
 * ## The defect this is a gate for, found by writing the test beside it
 *
 * `assemble-options.test.ts` was written to prove four options reach the product. It failed on `semanticCarry`,
 * and the failure was not a wrong expectation: the field had never been added to `AssembleOptions` at all. The
 * `factTimeline` forward that *was* added would therefore have shipped inert -- `memory.ts` renders no interval
 * for a fact `semanticCarry` did not put in the prompt -- so the release would have carried a configuration line
 * naming a treatment no run administered, which is the defect class every guard in `assemble.ts` exists for.
 *
 * That is the third time this repository has found the same asymmetry (requirement ⑯): a mechanism reachable from
 * `CortexMemory` and not from the one function an installer calls. Each time it was found by reading, and reading
 * is what let it through the two times before. This file makes it derivable instead.
 *
 * ## Why the gate reads declarations rather than the ledger's table
 *
 * `docs/PRODUCT-CAPABILITY-LEDGER.md` derives `product` from **reachability from `memory.ts`**, which every gated
 * capability satisfies by being an option on the class. Its own prose says the state means *"a customer can reach
 * it"*, and the two disagree exactly when an option is not forwarded. The declarations are the source both are
 * generated from, and their `gate` column is a literal from the product source, so the option's name is already
 * written down once -- parsing `#options.<name>` out of it is reading a fact the repository already asserts.
 *
 * ## What this deliberately does not check
 *
 * Whether the option *works*. `assemble-options.test.ts` drives behaviour for the reachable ones; this file only
 * refuses the state "reachable in the class, unnameable in the package". A test that claimed more would be
 * asserting a reading it cannot take.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const DECLARATIONS = new URL(
  '../../../../tools/product-capability-declarations.json',
  import.meta.url,
);
const ASSEMBLE = new URL('../assemble.ts', import.meta.url);

interface Declaration {
  readonly id?: number | string;
  readonly capability?: string;
  readonly gate?: string;
}

function declarations(): Declaration[] {
  const raw = JSON.parse(readFileSync(DECLARATIONS, 'utf8')) as unknown;
  const rows = Array.isArray(raw)
    ? raw
    : ((raw as { capabilities?: unknown; rows?: unknown }).capabilities ??
      (raw as { rows?: unknown }).rows);
  if (!Array.isArray(rows)) throw new Error('the declarations file has no rows array');
  return rows as Declaration[];
}

/**
 * The option name a gate string is about, or `null` when the gate is not an option.
 *
 * Both spellings the source uses are accepted: `this.#options.x` inside the class and `options.x` where an
 * assembly passes a bag. A gate naming something that is not an option -- `this.#semanticUpdates.push(` -- is
 * `null` rather than a parse failure, because the file is allowed to gate on state the caller cannot name.
 */
function gateOption(gate: string): string | null {
  const match = /(?:#)?options\.([A-Za-z][A-Za-z0-9]*)/u.exec(gate);
  return match === null ? null : (match[1] as string);
}

describe('every gated capability names an option the composition root accepts', () => {
  it('has the declarations and the composition root to compare', () => {
    // Both inputs asserted rather than assumed: a moved file would otherwise make every loop below iterate an
    // empty list and pass, which is the failure mode of every gate that reads by path.
    const rows = declarations();
    expect(rows.length).toBeGreaterThan(20);
    expect(rows.filter((row) => typeof row.gate === 'string').length).toBeGreaterThan(4);
    expect(readFileSync(ASSEMBLE, 'utf8')).toContain('export type AssembleOptions');
  });

  it('accepts the field at `AssembleOptions` for every option a gate names', () => {
    const source = readFileSync(ASSEMBLE, 'utf8');
    const typeStart = source.indexOf('export type AssembleOptions');
    const typeEnd = source.indexOf('/** What a profile wires up', typeStart);
    expect(typeStart).toBeGreaterThan(-1);
    expect(typeEnd).toBeGreaterThan(typeStart);
    const block = source.slice(typeStart, typeEnd);

    const missing: string[] = [];
    for (const row of declarations()) {
      if (typeof row.gate !== 'string') continue;
      const option = gateOption(row.gate);
      if (option === null) continue;
      // A field of the type block, with `?:` so it can stay absent -- the property every forwarded option
      // states, because `undefined` is what reproduces an archived artifact's bytes.
      if (!new RegExp(`readonly ${option}\\?:`, 'u').test(block)) {
        missing.push(`row ${String(row.id ?? row.capability)} gates on \`${option}\``);
      }
    }
    expect(missing).toEqual([]);
  });

  it('forwards the field to the memory rather than only declaring it', () => {
    // Declaring and not forwarding is the state `sessionClock` shipped in for a round: the type accepted it, the
    // constructor ignored it, and every test that read the option back passed. The forward is a conditional
    // spread, so the assertion is that the name appears on the right-hand side of one.
    const source = readFileSync(ASSEMBLE, 'utf8');
    const forwarded = new Set(
      [...source.matchAll(/\{\s*([A-Za-z][A-Za-z0-9]*):\s*options\.\1\s*\}/gu)].map(
        (match) => match[1] as string,
      ),
    );
    const unforwarded: string[] = [];
    for (const row of declarations()) {
      if (typeof row.gate !== 'string') continue;
      const option = gateOption(row.gate);
      if (option === null) continue;
      if (!forwarded.has(option)) unforwarded.push(`row ${String(row.id)}: \`${option}\``);
    }
    expect(unforwarded).toEqual([]);
  });
});
