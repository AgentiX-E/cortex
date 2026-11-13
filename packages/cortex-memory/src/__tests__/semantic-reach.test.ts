/**
 * The semantic kernel is not reachable from the shipping package, and this test says so out loud.
 *
 * ## Why an assertion instead of a paragraph
 *
 * `docs/AUDIT-SEMANTIC-REACH.md` records that `cortex-core` carries 2,899 lines of typed-fact machinery
 * -- frames, taxonomy, edges, assumptions, revision, units, `assemble`, contradiction, consolidation --
 * that no module in `cortex-memory` imports. That claim has the same failure mode as every other
 * document in this repository: it is true when written and silently false after one commit that adds an
 * import. A reader who trusts it would understate the product; a reader who re-derives it would pay for
 * the audit twice.
 *
 * So the claim is executable. If a later change wires the kernel into the product, this test fails and
 * names the symbol, which forces the audit's reach table to move at the same time the code does. That is
 * the only ordering under which a reach table stays true.
 *
 * ## What it deliberately does not assert
 *
 * It does not assert that the kernel *should* be unreachable. Reachability is a decision recorded in the
 * audit with its prerequisites; the test only refuses to let the record rot. And it does not look at
 * `cortex-eval`, which is the arm rather than the product -- what the arm calls is the subject of a
 * different measurement.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = path.resolve(import.meta.dirname, '../../../..');
const PRODUCT = path.join(REPO, 'packages/cortex-memory/src');

/**
 * The kernel, by the exports a wiring would have to import.
 *
 * Named rather than derived from a directory: a directory list would make this test pass by moving a
 * file, and the claim is about the mechanism, not about where the mechanism is filed.
 */
const SEMANTIC_KERNEL = [
  'KnowledgeFrame',
  'KnowledgeFact',
  'FactType',
  'EdgeType',
  'buildKnowledgeUnit',
  'deriveAssumptions',
  'deriveSupersedes',
  'reviseLedger',
  'assemble',
  'resolveContradiction',
  'consolidate',
  'MemoryGraph',
  'isFactCurrentAt',
  'slotKey',
  'renderBlocks',
] as const;

/** Every `.ts` file under a directory, excluding tests. */
function sources(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...sources(full));
    } else if (entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** The names a file imports from `@agentix-e/cortex-core`, and whether the import is type-only. */
function coreImports(file: string): { names: string[]; typeOnly: boolean }[] {
  const text = readFileSync(file, 'utf8');
  const found: { names: string[]; typeOnly: boolean }[] = [];
  const pattern = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+'@agentix-e\/cortex-core'/gs;
  for (const match of text.matchAll(pattern)) {
    const names = (match[2] ?? '')
      .split(',')
      .map((name) =>
        name
          .trim()
          .replace(/^type\s+/, '')
          .split(' as ')[0]!
          .trim(),
      )
      .filter((name) => name !== '');
    found.push({ names, typeOnly: match[1] !== undefined });
  }
  return found;
}

describe('the product does not reach the semantic kernel', () => {
  const files = sources(PRODUCT);

  it('imports no symbol from the kernel, and names the audit when one appears', () => {
    const hits: string[] = [];
    for (const file of files) {
      for (const imported of coreImports(file)) {
        for (const name of imported.names) {
          if ((SEMANTIC_KERNEL as readonly string[]).includes(name)) {
            hits.push(`${path.relative(REPO, file)} imports ${name}`);
          }
        }
      }
    }
    // The assertion is on the list, so a failure prints what was wired rather than just a count.
    expect(hits, 'docs/AUDIT-SEMANTIC-REACH.md §3: move the reach table row to P first').toEqual(
      [],
    );
  });

  it('still imports the value gates, so the assertion above is not vacuous', () => {
    // A test that passes because the product imports nothing from core would be green for the wrong
    // reason. These two are the package's stated reason to exist, and they must be there.
    const names = files.flatMap((file) => coreImports(file).flatMap((entry) => entry.names));
    expect(names).toContain('decideWrite');
    expect(names).toContain('decideRetrieval');
  });

  it('does not reach the arm at all, not even for a type', () => {
    // `CortexMemory implements SessionAwareMemorySystem`, and that interface used to live in
    // `cortex-eval` while `cortex-memory`'s `package.json` did not depend on it: the edge was type-only,
    // acyclic and undeclared, which every build passed and which broke any consumer who installed the
    // product alone -- the emitted `.d.ts` named a package that would not be there.
    //
    // The protocol types moved to `cortex-core` (`protocol/memory-system.ts`), so the invariant is now
    // zero rather than "type-only". Asserting the stronger one is what keeps the backwards edge from
    // coming back the next time a type is convenient.
    const offenders = files.filter((file) =>
      /from\s+'@agentix-e\/cortex-eval'/.test(readFileSync(file, 'utf8')),
    );
    expect(offenders.map((file) => path.relative(REPO, file))).toEqual([]);
  });
});
