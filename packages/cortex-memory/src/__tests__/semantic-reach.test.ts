/**
 * The semantic kernel is reachable from the shipping package, and only where the reach table says it is.
 *
 * ## What this test used to assert, and why the assertion inverted
 *
 * `docs/AUDIT-SEMANTIC-REACH.md` records that `cortex-core` carried 2,899 lines of typed-fact machinery that
 * no module in `cortex-memory` imported. That claim has the same failure mode as every other document in this
 * repository: true when written, silently false after one commit that adds an import. So it was made
 * executable — an assertion on **zero** kernel imports, which fails and names the symbol the moment a later
 * change wires something.
 *
 * It fired, exactly once, on the commit that added the fact source. That is the assertion working: the reach
 * table and the code could not drift apart without this test printing which row moved.
 *
 * ## Why it is a allowlist rather than a count now
 *
 * Zero was the right assertion while zero was the fact. Now the fact is *seven*, and a bare count would be the
 * weaker claim: it would pass if an eighth import appeared and a ninth were removed. So the invariant becomes
 * the one an audit can actually use —
 *
 * > every kernel symbol the product imports is named here, with the file that imports it; and every one of
 * > them is **called** from that file, not merely imported.
 *
 * The second half is what refuses a fake wiring. `import { assemble }` with no call compiles, passes a lint
 * rule, moves nothing, and would let a reach table say `P` — the failure `AUDIT-SEMANTIC-REACH.md` §4.3 priced
 * at 43 mechanism flips for 46 damages. A call is the smallest evidence that a symbol is load-bearing.
 *
 * ## What it deliberately does not assert
 *
 * It does not assert that the kernel *should* be reachable at this width. Which rows are `P` is a decision
 * recorded in the audit; the test only refuses to let the record rot. And it does not look at `cortex-eval`,
 * which is the arm rather than the product — what the arm calls is the subject of a different measurement.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const REPO = path.resolve(import.meta.dirname, '../../../..');
const PRODUCT = path.join(REPO, 'packages/cortex-memory/src');

/**
 * The kernel, by the exports a wiring would have to import.
 *
 * Named rather than derived from a directory: a directory list would make this test pass by moving a file,
 * and the claim is about the mechanism, not about where the mechanism is filed.
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

/**
 * The symbols that are wired today, and the file that owns each wiring.
 *
 * `cortex-memory/src/semantic-facts.ts` is the fact source, and since exit criterion E2 it is the *only* file
 * that speaks to the kernel. It turns the span-and-date authorisation `supersede.ts` already computed into a
 * `KnowledgeUnit` with a `supersedes` edge, and then does the three things that make the unit say something a
 * reader can act on:
 *
 * - `deriveAssumptions` — a fact with no ledger entry cannot be refuted, and for one round these had none, so
 *   `reviseLedger` had nothing to write and the block served the superseded value on its own `fact:` line.
 * - `deriveSupersedes` — the edge, computed from the two `at` values rather than from a guess.
 * - `reviseLedger` — the refutation itself. An edge that says "B replaced A" beside a persistence that says
 *   "still open" is the contradiction `revision.ts` exists to prevent.
 * - `assemble` — the single exit. It is what refuses the refuted fact, and it renders the block, so a caller
 *   that took served ids and rendered them itself would be a second exit with no conflict flags.
 *
 * `buildKnowledgeUnit` is imported for its refusal: a unit whose span or grounding is wrong does not become a
 * prompt line. `KnowledgeFrame` and `KnowledgeFact` are its parameter types.
 *
 * `renderBlocks` has left this map, and that is the point of `assemble`: the renderer is now reached through the
 * exit rather than beside it, so a second render path cannot disagree with the one the ledger decided for.
 *
 * `resolveContradiction` is **declined rather than absent**, and `DECISION-SEMANTIC-LAYER-ROUTE.md` §5 prices
 * it: the function decides between two facts claiming one instant, this module only ever produces a strictly
 * ordered pair, and feeding it the pair anyway — the only defensible inputs it could be given — returns the
 * value the revision just refuted. A call site would be decoration that changes an answer for the worse.
 */
const WIRED: Readonly<Record<string, string>> = {
  KnowledgeFrame: 'semantic-facts.ts',
  KnowledgeFact: 'semantic-facts.ts',
  buildKnowledgeUnit: 'semantic-facts.ts',
  deriveAssumptions: 'semantic-facts.ts',
  deriveSupersedes: 'semantic-facts.ts',
  reviseLedger: 'semantic-facts.ts',
  assemble: 'semantic-facts.ts',
};

/**
 * The wired names that are values rather than types, so a call site is required.
 *
 * A type has no call site and asserting one would fail for the wrong reason; a value that is imported and
 * never called is the fake wiring this test exists to refuse.
 */
const WIRED_VALUES = [
  'buildKnowledgeUnit',
  'deriveAssumptions',
  'deriveSupersedes',
  'reviseLedger',
  'assemble',
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

describe('the product reaches the semantic kernel exactly where the table says', () => {
  const files = sources(PRODUCT);

  it('imports no kernel symbol outside the allowlist, and names the audit when one appears', () => {
    const hits: string[] = [];
    for (const file of files) {
      for (const imported of coreImports(file)) {
        for (const name of imported.names) {
          if (!(SEMANTIC_KERNEL as readonly string[]).includes(name)) continue;
          if (WIRED[name] !== path.basename(file)) {
            hits.push(`${path.relative(REPO, file)} imports ${name}`);
          }
        }
      }
    }
    // The assertion is on the list, so a failure prints what was wired rather than just a count.
    expect(
      hits,
      'docs/AUDIT-SEMANTIC-REACH.md §3: move the reach table row to P in the same commit',
    ).toEqual([]);
  });

  it('calls every wired value, so an import with no call site cannot pass as wiring', () => {
    const silent: string[] = [];
    for (const name of WIRED_VALUES) {
      const owner = WIRED[name]!;
      const text = readFileSync(path.join(PRODUCT, owner), 'utf8');
      // Import statements themselves match `name (` only if written `name({`, which no import is, so a
      // call-shaped occurrence is evidence of a call rather than of the import that brought the name in.
      if (!new RegExp(`\\b${name}\\s*\\(`).test(text))
        silent.push(`${owner} imports ${name} and never calls it`);
    }
    expect(silent, 'A wired symbol with no call site is the decoration §4.3 refuses').toEqual([]);
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
