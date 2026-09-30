/**
 * A declaration is exported only when something outside its module can use it.
 *
 * ## Why this test exists
 *
 * The export census classifies every export as `with-caller`, `referenced-locally`,
 * or `unreferenced`. The middle class — 206 members at the time of writing — reads
 * as "an unnecessary `export` keyword", and that reading is wrong for most of it:
 * **182 of the 206 are re-exported from a package barrel**, so their `export` is the
 * package's public API, and **5 more are imported by tests**, so removing it breaks
 * the suite.
 *
 * What remains is the set this test pins: 19 declarations that are exported, absent
 * from every barrel, absent from `bench/` and `tools/`, and mentioned by no file but
 * their own. `export` on those is a claim that a consumer exists, and nothing
 * consumes them — the same claim-shape as `AUDIT-UNREFERENCED-CLASSES.md` §3, in a
 * weaker form: nothing is *wrong* about the code, but the public surface advertises
 * nineteen things it does not have.
 *
 * ## What the fix does, and what it deliberately does not
 *
 * The `export` keyword is removed; the declarations stay. They are used inside their
 * own modules (that is what put them in `referencedLocally`), so nothing else may
 * change.
 *
 * **The barrel is not touched.** Converging the 182 barrel entries would shrink the
 * published interface of four packages — a product decision, not a cleanup, and one
 * with consumers outside this repository. Recorded here so the boundary of this
 * change is explicit rather than implied by the numbers.
 *
 * ## Why this is asserted rather than left to the census
 *
 * A census reports a *count*. The count for `referencedLocally` will fall by 19 and
 * nothing says which 19, or that the five test-imported members were left alone. The
 * assertions below name both sides, so a later change that de-exports a
 * test-imported symbol — or re-exports one of these — fails here with a message
 * about which and why.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// `__dirname` is `packages/cortex-eval/src/__tests__`; three levels up is the
// repository root. Off by one here reads as "module not found" from every
// assertion at once, which is how the first version of this line failed.
const ROOT = join(__dirname, '..', '..', '..', '..');

/**
 * Declarations whose `export` was removed: absent from every barrel and referenced
 * by nothing outside their own file.
 *
 * Kept as an explicit list rather than derived at test time. The derivation is what
 * the previous change already did once (by command), and re-deriving it here would
 * make this test agree with the census by construction — including when the census
 * is wrong. Naming them is what makes the test able to disagree.
 */
const DE_EXPORTED: ReadonlyArray<[pkg: string, file: string, name: string]> = [
  ['cortex-core', 'graph/memory-graph.ts', 'EdgeKind'],
  ['cortex-core', 'graph/memory-graph.ts', 'EdgeAttributes'],
  ['cortex-eval', 'judge.ts', 'JudgeQuestionType'],
  ['cortex-eval', 'llm-factory.ts', 'THINKING_TIMEOUT_MS'],
  ['cortex-eval', 'rerank-factory.ts', 'DEFAULT_LOCAL_RERANK_MODEL'],
  ['cortex-eval', 'rerank-factory.ts', 'DEFAULT_LLM_RERANK_BASE_URL'],
  ['cortex-eval', 'rerank-factory.ts', 'DEFAULT_LLM_RERANK_MODEL'],
  ['cortex-eval', 'rerank-factory.ts', 'RERANK_PROVIDERS'],
  ['cortex-eval', 'rerank-factory.ts', 'RerankProvider'],
  ['cortex-eval', 'retrieval-diagnostics.ts', 'RetrievalDiagnosticOptions'],
  ['cortex-eval', 'variance.ts', 'PairwiseMovement'],
  ['cortex-eval', 'natural-language-memory.ts', 'QaPromptOptions'],
  ['cortex-eval', 'natural-language-memory.ts', 'ConservativeQaPromptOptions'],
  ['cortex-eval', 'natural-language-memory.ts', 'buildAggregationCritiquePrompt'],
  ['cortex-eval', 'natural-language-memory.ts', 'buildRevisedAggregationPrompt'],
  ['cortex-eval', 'natural-language-memory.ts', 'extractAggregationLedger'],
  ['cortex-eval', 'natural-language-memory.ts', 'AggregationKind'],
  ['cortex-eval', 'natural-language-memory.ts', 'projectSessions'],
  ['cortex-eval', 'natural-language-memory.ts', 'QueryExpansionOptions'],
];

/**
 * The five in the same barrel-absent group that must KEEP `export`.
 *
 * A test imports each by name from its module, so the keyword is load-bearing. They
 * are listed here so the boundary of the change is pinned from both sides: this test
 * fails if one of them loses its `export`, before much less useful failures appear in
 * whichever suite depends on it.
 */
const TEST_IMPORTED: ReadonlyArray<[pkg: string, file: string, name: string]> = [
  ['cortex-eval', 'recall-curve.ts', 'classifyCurveMembership'],
  ['cortex-eval', 'natural-language-memory.ts', 'detectBareAbstention'],
  ['cortex-eval', 'natural-language-memory.ts', 'formatStructuredContext'],
  ['cortex-eval', 'fact-memory.ts', 'overlapScore'],
  ['cortex-eval', 'llm-factory.ts', 'resolveTimeoutMs'],
];

function sourceOf(pkg: string, file: string): string {
  return readFileSync(join(ROOT, 'packages', pkg, 'src', file), 'utf8');
}

/** The line that declares `name`, or `undefined` when no such declaration exists. */
function declarationLine(source: string, name: string): string | undefined {
  const pattern = new RegExp(
    String.raw`(?:^|\n)([^\n]*\b(?:type|interface|const|function|class|enum)\s+${name.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    )}\b[^\n]*)`,
  );
  return pattern.exec(source)?.[1];
}

describe('the export surface declares only what a consumer can use', () => {
  it('removes `export` from the 19 declarations nothing outside their module uses', () => {
    for (const [pkg, file, name] of DE_EXPORTED) {
      const line = declarationLine(sourceOf(pkg, file), name);
      expect(line, `${pkg}: ${file} has no declaration of ${name}`).toBeDefined();
      // Both forms are rejected: `export type X` and `export { X }` would each make
      // the name reachable from outside, which is the property being removed.
      expect(line, `${pkg}: ${file} still exports ${name}: ${line}`).not.toMatch(/^\s*export\b/);
    }
  });

  it('leaves the declarations themselves in place', () => {
    // De-exporting must not become deletion. Each symbol is used inside its own
    // module -- that is why the census put it in `referencedLocally` rather than
    // `unreferenced` -- so removing the declaration would break the build.
    for (const [pkg, file, name] of DE_EXPORTED) {
      const source = sourceOf(pkg, file);
      const line = declarationLine(source, name)!;
      expect(line, `${pkg}: ${file} declares ${name} but the declaration looks removed`).toMatch(
        /\b(?:type|interface|const|function|class|enum)\s+/,
      );
    }
  });

  it('keeps `export` on the declarations a test imports by name', () => {
    // The counter-assertion. Without it, a future sweep that applies the same rule
    // mechanically would strip these five and the failure would surface as an
    // unrelated import error in a suite that has nothing to do with this change.
    for (const [pkg, file, name] of TEST_IMPORTED) {
      const line = declarationLine(sourceOf(pkg, file), name);
      expect(line, `${pkg}: ${file} has no declaration of ${name}`).toBeDefined();
      expect(
        line,
        `${pkg}: ${file} must keep exporting ${name}; a test imports it by name`,
      ).toMatch(/^\s*export\b/);
    }
  });

  it('does not reach into the package barrels', () => {
    // The 182 barrel entries are public API. They are not converged here, and this
    // assertion records that as a decision: `index.ts` in each package still
    // re-exports what it did, so the published surface is unchanged by this change.
    for (const pkg of ['cortex-core', 'cortex-eval', 'cortex-llm', 'cortex-node']) {
      const barrel = join(ROOT, 'packages', pkg, 'src', 'index.ts');
      expect(statSync(barrel).size, `${pkg} barrel is unexpectedly empty`).toBeGreaterThan(0);
      const text = readFileSync(barrel, 'utf8');
      expect(text, `${pkg} barrel should still re-export`).toMatch(/^export /m);
    }
  });

  it('leaves no *new* barrel entry naming a de-exported symbol', () => {
    // The two assertions above could both pass while a de-exported name was added
    // to a barrel by hand. This closes that: no barrel may mention any of the 19.
    for (const pkg of ['cortex-core', 'cortex-eval', 'cortex-llm', 'cortex-node']) {
      const text = sourceOf(pkg, 'index.ts');
      for (const [owner, , name] of DE_EXPORTED) {
        if (owner !== pkg) {
          continue;
        }
        expect(
          text,
          `${pkg} barrel names ${name}, which is no longer exported by its module`,
        ).not.toMatch(new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`));
      }
    }
  });

  it('documents every module it touches, so the de-export is discoverable', () => {
    // A reader who lands in `rerank-factory.ts` and sees five unexported constants
    // needs to know they were deliberate rather than leftovers. Each touched file
    // carries a note naming this test and the reason.
    const touched = [...new Set(DE_EXPORTED.map(([, file]) => file))];
    expect(touched.length).toBeGreaterThan(0);
    for (const file of touched) {
      const owner = DE_EXPORTED.find(([, f]) => f === file)![0];
      const source = sourceOf(owner, file);
      expect(source, `${owner}: ${file} should note why its exports were reduced`).toMatch(
        /export-census|referenced-locally|module-private/i,
      );
    }
  });
});
