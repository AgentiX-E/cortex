/**
 * Every coverage-ignore annotation is enumerated, justified, and pinned.
 *
 * ## Why this test exists
 *
 * `c8 ignore` / `v8 ignore` comments assert that a line of code cannot execute.
 * That assertion is invisible to the type system, invisible to a code reviewer
 * skimming a diff, and — as `docs/FIX-COVERAGE-GATE-NOISE.md` establishes —
 * actively unstable in its effect on the reported percentage, because the v8
 * provider attributes ignored guard bodies to the enclosing loop on some runs and
 * not others.
 *
 * So an annotation is a load-bearing claim about the code, and an *undeclared*
 * annotation is a claim nobody reviewed. This test makes the set explicit: the
 * count is pinned, every entry carries its reason, and adding a new one fails
 * until it is declared here.
 *
 * ## What this test does NOT do
 *
 * It does not verify that each annotation's stated reason is true. That is not
 * checkable from the annotation text — proving a guard unreachable requires
 * reasoning about the arithmetic, as done for the continued-fraction guards in
 * the document above (a 29.9-order-of-magnitude margin between the observed
 * minimum and the `1e-30` threshold). What this test guarantees is narrower and
 * still worth having: **the set cannot grow silently**, so a new suppression
 * necessarily reaches a reviewer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(__dirname, '..');

/**
 * The expected annotation set, keyed by source file.
 *
 * `count` is exact rather than a minimum: a *decrease* is also a change worth
 * reviewing, because removing an annotation raises coverage and may mean the
 * guard became reachable — which would be a real behavioural finding, not a
 * cleanup.
 */
const EXPECTED: Record<string, { count: number; reason: string }> = {
  'graph/memory-graph.ts': {
    count: 2,
    reason: 'Defensive guards on graph traversal invariants that the public API cannot violate.',
  },
  'math/stats.ts': {
    count: 6,
    reason:
      'Underflow guards in the Student-t continued fraction and the Welch df ' +
      'computation. Verified unreachable by arithmetic margin, not by inspection: ' +
      'the smallest |c| or |d| any exercised input produces is ~0.81 against a ' +
      '1e-30 threshold, a 29.9-order-of-magnitude gap.',
  },
};

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Tests are not shipped code and are not coverage-instrumented, so an
      // annotation there cannot affect the gate this test protects.
      if (entry === '__tests__') {
        continue;
      }
      out.push(...tsFiles(full));
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const ANNOTATION = /(?:\/\/|\/\*)\s*(?:c8|v8)\s+ignore\b[^\n]*/g;

function scan(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of tsFiles(SRC)) {
    const matches = readFileSync(file, 'utf8').match(ANNOTATION);
    if (matches && matches.length > 0) {
      found.set(relative(SRC, file), matches);
    }
  }
  return found;
}

describe('the coverage-ignore annotation set is pinned', () => {
  it('contains exactly the declared files, with the declared counts', () => {
    const found = scan();
    const foundCounts = Object.fromEntries(
      [...found].map(([file, matches]) => [file, matches.length]),
    );
    const expectedCounts = Object.fromEntries(
      Object.entries(EXPECTED).map(([file, spec]) => [file, spec.count]),
    );
    // Compared as a whole object rather than file-by-file so a NEW file with an
    // annotation fails as visibly as a changed count in a known one.
    expect(foundCounts).toEqual(expectedCounts);
  });

  it('declares a reason for every file that carries an annotation', () => {
    for (const file of scan().keys()) {
      expect(EXPECTED[file], `no declared reason for ${file}`).toBeDefined();
      expect(EXPECTED[file]!.reason.length).toBeGreaterThan(20);
    }
  });

  it('annotates only with a stated reason, never bare', () => {
    // A bare `/* c8 ignore next */` states that code is unreachable without
    // saying why, which is the annotation equivalent of a comment-less `|| true`.
    // Every one in this repository carries a `--` rationale; that is asserted
    // here so the convention cannot decay into bare suppressions.
    for (const [file, matches] of scan()) {
      for (const annotation of matches) {
        expect(annotation, `${file}: annotation has no rationale: ${annotation}`).toMatch(/--/);
      }
    }
  });

  it('does not suppress a whole file or block', () => {
    // `c8 ignore file` / `c8 ignore start` suppress far more than a guard and
    // would make the reported percentage a statement about what was excluded
    // rather than about what was tested. Only `next`/`stop`-free forms are
    // allowed, and this asserts that no blanket form has crept in.
    for (const [file, matches] of scan()) {
      for (const annotation of matches) {
        expect(
          annotation,
          `${file}: blanket suppression is not allowed: ${annotation}`,
        ).not.toMatch(/\bignore\s+(?:file|start)\b/);
      }
    }
  });
});
