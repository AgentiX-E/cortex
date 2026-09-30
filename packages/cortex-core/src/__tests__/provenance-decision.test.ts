/**
 * `ProvenanceNode` was deleted, and the finding that justified deleting it survived.
 *
 * ## Why this test exists
 *
 * `ProvenanceNode` was the single entry in the census's `unreferenced` class, which
 * made it look like the one symbol whose remedy was mechanical. It was the opposite:
 * it needed a design call, because the reason nothing referenced it is that the
 * capability it named was **already delivered by a better-typed mechanism**. The
 * bitemporal `Fact` layer records origin (`source`), dual-clock timing
 * (`validFrom`/`validUntil` + `systemFrom`/`systemUntil`) and as-of reconstruction
 * (`currentFacts`, `currentValue`, `isFactCurrentAt`). `ProvenanceNode` offered one
 * timestamp, an untyped `kind` string, and a `parents` DAG edge that **no code in
 * the repository ever read**.
 *
 * See [`docs/DECISION-PROVENANCE-NODE.md`](../../../../docs/DECISION-PROVENANCE-NODE.md).
 *
 * ## The asymmetry this file guards
 *
 * Deleting the symbol is safe and easy. Deleting the **record of the gap** is the
 * real failure mode, because the gap is genuine: `Fact` records what was concluded
 * and how confidently, but not *from which prior facts*. A fact derived from three
 * retrieved memories is indistinguishable from one asserted directly except by its
 * `source` string.
 *
 * So these assertions point in opposite directions on purpose:
 *
 * - the symbol must be **gone** (from the file, the barrel, the arithmetic, the docs);
 * - the gap must be **recorded** (`ARCHITECTURE.md`'s status table states derivation
 *   as not implemented, in the same voice it uses for TD(λ) and inert `sinkhorn`).
 *
 * A change that deletes the symbol *and* the record — which is what a tidy-minded
 * sweep would do — fails the last assertion here with a message naming the gap.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// `__dirname` is `packages/cortex-core/src/__tests__`; four levels up is the
// repository root. The same off-by-one cost the sibling test in `cortex-eval` six
// failed assertions at once when it read as `packages/packages/...`.
const ROOT = join(__dirname, '..', '..', '..', '..');

const ALL_PACKAGES = ['cortex-core', 'cortex-eval', 'cortex-llm', 'cortex-node'] as const;

/** The identifier, as a whole word, so `EmbeddingWithProvenance` never matches. */
const SYMBOL = /(?<![A-Za-z0-9_$])ProvenanceNode(?![A-Za-z0-9_$])/;

function repoFile(...parts: string[]): string {
  return readFileSync(join(ROOT, ...parts), 'utf8');
}

describe('ProvenanceNode is deleted, and its gap is recorded', () => {
  it('removes the module that held nothing but the declaration', () => {
    // The file compiled to zero statements -- one type, no runtime code -- which is
    // why `AUDIT-COVERAGE-ANNOTATION-BLIND-SPOT.md` found its `istanbul ignore file`
    // annotation inert twice over. Nothing is left behind to keep.
    const modulePath = join(ROOT, 'packages', 'cortex-core', 'src', 'domain', 'provenance.ts');
    expect(existsSync(modulePath), `domain/provenance.ts still exists at ${modulePath}`).toBe(
      false,
    );
  });

  it('removes the barrel line that made it part of the published surface', () => {
    const barrel = repoFile('packages', 'cortex-core', 'src', 'index.ts');
    expect(
      barrel,
      'cortex-core barrel still re-exports ProvenanceNode, so it is still public API',
    ).not.toMatch(SYMBOL);
    expect(
      barrel,
      'cortex-core barrel still imports from domain/provenance.js, which no longer exists',
    ).not.toMatch(/domain\/provenance\.js/);
  });

  it('leaves no barrel in any package naming the symbol', () => {
    // Only `cortex-core`'s barrel ever named it (verified by search before deletion),
    // but the assertion covers all four so a re-export chain added later fails here
    // rather than in a consumer.
    for (const pkg of ALL_PACKAGES) {
      const barrel = join(ROOT, 'packages', pkg, 'src', 'index.ts');
      expect(existsSync(barrel), `${pkg} barrel is missing`).toBe(true);
      expect(readFileSync(barrel, 'utf8'), `${pkg} barrel names ProvenanceNode`).not.toMatch(
        SYMBOL,
      );
    }
  });

  it('keeps the domain layer whole: the two types that ship are still there', () => {
    // The counter-weight to the deletions above. `MemoryValue` carries origin and
    // trust; `Fact` carries origin, trust and both time axes. These are what actually
    // deliver the provenance the census's `unreferenced` entry *appeared* to own.
    const memory = repoFile('packages', 'cortex-core', 'src', 'domain', 'memory.ts');
    expect(memory, 'MemoryValue must survive: it carries source + sourceTrust').toMatch(
      /\bMemoryValue\b/,
    );
    expect(memory).toMatch(/\bsourceTrust\b/);

    const fact = repoFile('packages', 'cortex-core', 'src', 'domain', 'fact.ts');
    expect(fact, 'Fact must survive: it is the bitemporal provenance mechanism').toMatch(
      /\bFact\b/,
    );
    // Assert the DECLARATION, not a mention. The first version of this loop checked
    // `\b${clock}\b`, which is satisfied by any *use* of the field -- so renaming the
    // declaration while a use site remained (`fact.systemUntil === Infinity`) passed
    // the check with the field itself gone. Injection 3 caught that: the test stayed
    // green while `systemUntil: number` had become `systemUntilRenamed: number`.
    // A field's existence is a declaration fact, so the assertion has to be one.
    for (const clock of ['validFrom', 'validUntil', 'systemFrom', 'systemUntil']) {
      const declared = new RegExp(
        String.raw`(?:^|\n)\s*${clock}\s*[?]?\s*:\s*(?:number|Number)\s*;`,
      );
      expect(
        fact,
        `Fact no longer DECLARES ${clock}; as-of reconstruction needs the field, not just a use of the name`,
      ).toMatch(declared);
    }
  });

  it('keeps the bitemporal queries that make Fact the provenance mechanism', () => {
    // `systemUntil`'s docstring reads "when the system learned (or superseded) the
    // fact" -- that is an immutable audit log with an as-of query, which is the
    // capability `ProvenanceNode` was declared for and never provided.
    const bitemporal = repoFile('packages', 'cortex-core', 'src', 'temporal', 'bitemporal.ts');
    for (const fn of ['currentFacts', 'currentValue', 'findContradictions']) {
      expect(bitemporal, `bitemporal.ts lost ${fn}, the as-of query provenance needs`).toMatch(
        new RegExp(`export function ${fn}\\b`),
      );
    }
  });

  it('records the derivation gap in ARCHITECTURE.md rather than letting it vanish', () => {
    // THE assertion this file exists for. Deleting a symbol is one line; deleting the
    // evidence that a decision was made -- and that a capability is still missing --
    // is the failure this guards. A tidy sweep that removes the symbol and tidies the
    // docs leaves no trace that fact derivation is unimplemented.
    const arch = repoFile('ARCHITECTURE.md');

    // The layering diagram must not list it: that diagram describes what ships, and
    // a symbol it names does not exist.
    const diagram = arch.split('## Design Principles')[0];
    expect(
      diagram,
      'ARCHITECTURE.md still lists ProvenanceNode in the domain layer diagram, but it is deleted',
    ).not.toMatch(SYMBOL);

    // A *historical* mention is fine, and the status-table row is one -- it records
    // that the symbol was deleted and why. That mention is required, not forbidden:
    // it is the difference between "removed" and "never existed".
    expect(
      arch,
      'the status table should still explain that ProvenanceNode was deleted rather than leave the removal unexplained',
    ).toMatch(SYMBOL);

    expect(
      arch,
      'ARCHITECTURE.md no longer records that fact derivation is unimplemented; the gap is real and must stay visible',
    ).toMatch(/derivation/i);

    // The status table's own voice: TD(λ) and inert `sinkhorn` are stated plainly as
    // not-on-the-eval-path. Derivation belongs in the same table, not in a type that
    // nothing read.
    expect(arch, 'ARCHITECTURE.md should still state plainly which capabilities are inert').toMatch(
      /Implementation status/i,
    );
  });

  it('corrects the README claim instead of deleting the section', () => {
    // `README.md` advertised "every memory records its source, trust, and derivation".
    // Source and trust are true (`MemoryValue.source`, `MemoryValue.sourceTrust`);
    // derivation is not. The claim is retargeted at what is measured, not removed.
    const readme = repoFile('README.md');
    expect(readme, 'README lost its provenance/trust capability entry').toMatch(/[Pp]rovenance/);
    expect(readme, 'README must not imply derivation is recorded while it is not').not.toMatch(
      /every memory records its source, trust, and derivation/i,
    );
  });
});
