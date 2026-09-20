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
 * ## The stated reasons in `math/stats.ts` are FALSE, and that is measured
 *
 * An earlier version of this comment claimed the annotations were verified
 * correct by a 29.9-order-of-magnitude margin. **That verification was wrong**,
 * and so was the method behind it: replicating the continued fraction over a grid
 * of `(x, df)` pairs and taking the minimum `|c|`/`|d|` asks whether the guard is
 * reachable *by that grid*, while the annotation claims something about *all
 * valid inputs*.
 *
 * `Infinity` is a valid input, and the suite already passes it. Replacing each of
 * the five in-loop guard bodies with a throwing sentinel fails **six tests per
 * guard**; the single test `studentTCdf is a valid CDF at extremes`, which calls
 * `studentTCdf(±Infinity, 10)`, trips all five on its own.
 *
 * So the annotation text — "defensive guard, unreachable via valid inputs" — is
 * not a reviewable claim about this code. It is false, and the correct repair is
 * to test the guard bodies and then remove the annotations, which moves the
 * reported figure and therefore belongs in its own change. See
 * `docs/FIX-COVERAGE-GATE-NOISE.md` §5, §7 and §10.
 *
 * ## What this test does NOT do
 *
 * It does not verify that each annotation's stated reason is true, and the
 * `math/stats.ts` case above shows why that matters: the reasons are prose, and
 * prose cannot be checked by pattern-matching the file. Reachability has to be
 * *measured* — by perturbing the code and observing behaviour from outside it,
 * which is what the throwing-sentinel method does and what the counter-based
 * probe did not (a counter added to a body changes v8's block structure and is
 * credited to a different line). What this test guarantees is narrower and still
 * worth having: **the set cannot grow silently**, so a new suppression
 * necessarily reaches a reviewer.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { studentTCdf } from '../math/stats.js';
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
    // This reason states what the annotations CLAIM, and records that the claim
    // is false. It previously asserted the guards were "verified unreachable by
    // arithmetic margin ... a 29.9-order-of-magnitude gap" — that verification
    // sampled a grid of finite `(x, df)` pairs and generalised to all inputs,
    // which is not a valid inference. `studentTCdf(±Infinity, 10)` reaches all
    // five in-loop guards. Kept pinned at 6 so that removing them is a reviewed
    // change rather than a silent one; see the file header and
    // `docs/FIX-COVERAGE-GATE-NOISE.md` §5.
    reason:
      'Underflow guards in the Student-t continued fraction and the Welch df ' +
      'computation. The annotations state "unreachable via valid inputs", and ' +
      'MEASURED REACHABILITY CONTRADICTS THAT: throwing sentinels placed in each ' +
      'of the five in-loop bodies fail six tests apiece, and the existing test ' +
      '"studentTCdf is a valid CDF at extremes" reaches all five through ' +
      'studentTCdf(±Infinity, 10). Removing the annotations is the correct ' +
      'repair and is an open item because it moves the reported figure.',
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
  it('records that the stats.ts guards are reachable, contradicting their stated reason', () => {
    // This is the one assertion in this file that pins BEHAVIOUR rather than the
    // annotation set, and it exists because the stated reason on those six
    // annotations is false.
    //
    // `studentTCdf` carries five in-loop underflow guards annotated
    // "unreachable via valid inputs". `Infinity` is a valid input. It is already
    // passed by the existing extremes test, and it drives every one of those
    // guards — established by replacing each body with a throwing sentinel and
    // watching six tests fail per guard, not by reading the code.
    //
    // The assertions below do not test the guards themselves (they are
    // underflow protection and do not change these outputs); they pin the fact
    // that the asymptotic input is part of the suite's contract. If a future
    // change makes `studentTCdf(±Infinity, df)` throw or return a non-CDF value,
    // this fails here, next to the annotation whose claim about the code is
    // already known to be wrong.
    expect(studentTCdf(Infinity, 10)).toBeCloseTo(1, 12);
    expect(studentTCdf(-Infinity, 10)).toBeCloseTo(0, 12);

    // A finite but extreme t is the same regime without relying on infinities,
    // so the reachability claim does not rest on one special value.
    expect(studentTCdf(-1e300, 10)).toBeCloseTo(0, 12);
    expect(studentTCdf(0, 10)).toBeCloseTo(0.5, 12);
  });
});
