/**
 * Every coverage-ignore annotation is enumerated, justified, and pinned.
 *
 * ## Why this test exists
 *
 * `c8 ignore` / `v8 ignore` comments assert that a line of code cannot execute.
 * That assertion is invisible to the type system, invisible to a code reviewer
 * skimming a diff, and — as `docs/FIX-COVERAGE-GATE-NOISE.md` establishes —
 * unreliable in a second way too: the annotations under-suppress on some runs,
 * so the reported percentage moves between identical invocations of the suite.
 *
 * So an annotation is a load-bearing claim about the code, and an *undeclared*
 * annotation is a claim nobody reviewed. This test makes the set explicit: the
 * count is pinned, every entry carries its reason, and adding a new one fails
 * until it is declared here.
 *
 * ## The stated reasons in `math/stats.ts` were FALSE when written
 *
 * An earlier version of this comment claimed the annotations were verified
 * correct by a 29.9-order-of-magnitude margin. **That verification was wrong**,
 * and so was the method behind it: replicating the continued fraction over a grid
 * of `(x, df)` pairs and taking the minimum `|c|`/`|d|` asks whether the guard is
 * reachable *by that grid*, while the annotation claims something about *all
 * valid inputs*.
 *
 * `Infinity` is a valid input, and the suite already passes it. Replacing each of
 * the five in-loop guard bodies with a throwing sentinel failed **six tests per
 * guard**, and `studentTCdf(±Infinity, 10)` tripped all five on its own.
 *
 * ## ...and are only now correct, by accident
 *
 * Chasing that contradiction uncovered **two genuine defects**, and fixing them
 * moved the guards into the unreachable state the annotations had assumed:
 *
 * 1. `logGamma`'s reflection branch used `sin(pi z)` where the identity requires
 *    `|sin(pi z)|`, so it took `Math.log` of a negative number and returned NaN
 *    for every negative non-integer input.
 * 2. `regularizedIncompleteBeta` omitted the complementary-identity branch, so it
 *    ran the continued fraction far outside its convergence region and returned
 *    values wrong by orders of magnitude for small `p` -- without producing NaN.
 *
 * With both fixed, re-running the same sentinel experiment leaves the suite
 * **green**: all five guards are genuinely unreachable. The annotation text was
 * false when written and true now, for a reason it never stated. That is the
 * useful lesson -- **an annotation is a claim about a specific version of the
 * code, and a later bug fix can silently make it true or false.**
 *
 * See `docs/FIX-COVERAGE-GATE-NOISE.md` §5, §7 and §10.
 *
 * ## The gate was scoped to one package and blind to one provider — both fixed
 *
 * This test used to scan `cortex-core/src` only, and its pattern recognised the
 * `c8` and `v8` prefixes but not `istanbul`. Two consequences, both measured
 * rather than argued, and both now closed:
 *
 * 1. **Scope.** The two `c8 ignore start` shims in `cortex-llm` (the optional
 *    `@xenova/transformers` peer loaders) were outside the scanned directory, so
 *    the file's central claim -- "the set is enumerated" -- was true of one
 *    package and false of the repository.
 * 2. **Prefix.** Six files carried `/* istanbul ignore file ... *\/` and the
 *    pattern could not see any of them. Worse, `istanbul ignore file` is **not a
 *    suppression that vitest's v8 provider honours**: deleting all five in
 *    `cortex-core` left the reported figure bit-identical (raw counters
 *    946/958 = 98.7474%, both before and after). The annotations were therefore
 *    not hiding untested code -- they were hiding *nothing*, while reading as
 *    though a decision had been made and reviewed. That is the same shape as a
 *    feature flag that is set and never consumed: `docs/AUDIT-B7-DEAD-SWITCH.md`.
 *
 * The fix was to delete them, not to enumerate them. A pin on a no-op annotation
 * would have preserved the appearance of review over an empty set of
 * consequences, and the type-only files needed no exemption at all: they compile
 * to zero statements, so `coverage-final.json` records `statementMap: {}` and the
 * text report omits them. `hasNoRuntimeCode` below asserts that property
 * directly, so the reason those files are absent from the report is checked
 * rather than assumed.
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
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { studentTCdf } from '../math/stats.js';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

/**
 * True when a top-level statement emits no JavaScript.
 *
 * Used by the type-only-file test below. `export type X = ...`, `export interface
 * X {}` and `import type` all disappear at compile time; a wrapped declaration is
 * unwrapped rather than special-cased, so a future `export declare const` (which
 * also emits nothing) is classified correctly instead of being reported as
 * runtime code.
 */
function isTypeLevelExport(node: ts.Statement): boolean {
  if (ts.isTypeAliasDeclaration(node) || ts.isInterfaceDeclaration(node)) {
    return true;
  }
  if (ts.isImportDeclaration(node)) {
    // `import type { X } from '...'` is erased; a value import is not, and it
    // does emit an import statement even if nothing is used at runtime.
    return node.importClause?.isTypeOnly === true;
  }
  if (ts.isExportDeclaration(node)) {
    // `export { type X }` / `export type { X }` are erased; a plain re-export of
    // values is not.
    return node.isTypeOnly;
  }
  if (ts.isVariableStatement(node)) {
    // `declare const X: T` is erased; `const X = 1` is not. TypeScript's flag for
    // this is `NodeFlags.Ambient`, but it is marked internal in the published
    // typings, so testing the modifier through the modifier list is what
    // type-checks. `ts.NodeFlags.Declare` -- the spelling a comment would suggest
    // -- does not exist at all, which the first version of this helper found out
    // from the build rather than from reading.
    return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword) === true;
  }
  return false;
}

/**
 * Repository root, derived rather than configured.
 *
 * The annotation set is a property of the repository, not of this package, so the
 * scan has to start above `packages/`. Walking up until `pnpm-workspace.yaml` is
 * found keeps this correct if the test file moves, and fails loudly instead of
 * silently scanning the wrong tree if the marker ever disappears.
 */
function repoRoot(): string {
  let dir = join(__dirname, '..');
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = join(dir, '..');
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new Error(
    'pnpm-workspace.yaml not found above this test; cannot scope the annotation scan',
  );
}

const ROOT = repoRoot();

/**
 * The expected annotation set, keyed by `<package>: <path-relative-to-src>`.
 *
 * `count` is exact rather than a minimum: a *decrease* is also a change worth
 * reviewing, because removing an annotation raises coverage and may mean the
 * guard became reachable — which would be a real behavioural finding, not a
 * cleanup.
 *
 * The extra file-level spec is separate from the line-level one because the two
 * make different claims: a `next` annotation asserts one statement is
 * unreachable, a `start` block asserts an entire file's worth of statements is
 * unreachable in every configuration the suite runs under. The second is a much
 * stronger claim and is worth reviewing on its own.
 */
const EXPECTED: Record<string, { count: number; reason: string }> = {
  'cortex-core: graph/memory-graph.ts': {
    count: 2,
    reason: 'Defensive guards on graph traversal invariants that the public API cannot violate.',
  },
  'cortex-core: math/stats.ts': {
    count: 6,
    // The stated reason "unreachable via valid inputs" was measured FALSE at the
    // time it was written: throwing sentinels placed in each of the five in-loop
    // guards failed six tests apiece, and `studentTCdf(±Infinity, 10)` reached
    // all five on its own. The guards were reachable, so the annotations were
    // suppressing a coverage gap rather than documenting dead code.
    //
    // That is no longer the current state. Two genuine defects were found and
    // fixed while investigating this file -- `logGamma` lost the sign of
    // `sin(pi z)` on the reflection branch and returned NaN for every negative
    // non-integer input, and `regularizedIncompleteBeta` was missing the
    // complementary-identity branch and so evaluated the continued fraction far
    // outside its region of convergence (returning silently wrong values for
    // small `p`). With both fixed, the same sentinel experiment now leaves the
    // suite GREEN: all five guards are genuinely unreachable, so the original
    // reason is true, just not for the version of the code that made the claim.
    //
    // Kept pinned at 6 so that removing them stays a reviewed change; the count
    // is unchanged because the guards are still there, only now dead.
    reason:
      'Underflow guards in the Student-t continued fraction and the Welch df ' +
      'computation. Originally annotated "unreachable via valid inputs", which ' +
      'was FALSE at the time: throwing sentinels failed six tests per guard and ' +
      'studentTCdf(±Infinity, 10) reached all five. After fixing the logGamma ' +
      'reflection sign and adding the complementary-identity branch to ' +
      'regularizedIncompleteBeta, the same sentinel experiment leaves the suite ' +
      'green, so the guards are now genuinely unreachable and the annotations ' +
      'are correct-by-accident. See docs/FIX-COVERAGE-GATE-NOISE.md §5 and §7.',
  },
  'cortex-eval: fact-memory.ts': {
    count: 1,
    reason:
      'A set-union length guard in FactMemorySystem, where both input sets are ' +
      'non-empty by construction so the union cannot be empty. The single ' +
      '`next` form is deliberate: the guard is one statement, and a `start` ' +
      'block would also suppress the surrounding retrieval logic that the ' +
      'suite does exercise.',
  },
};

/**
 * Whole-file and whole-block suppressions, keyed the same way.
 *
 * These are not merely a different count — they are a different *kind* of claim,
 * and the file-level ones are the reason this list exists separately. A `start`
 * block is the annotation equivalent of `|| true` at file scope: it removes
 * statements from the denominator, so the reported percentage stops being a
 * statement about the tested code and becomes a statement about what was
 * excluded. Each one therefore needs to justify why the excluded code cannot be
 * tested *in this environment* rather than merely being inconvenient.
 */
const EXPECTED_BLOCK: Record<string, { count: number; reason: string }> = {
  'cortex-llm: embedding/transformers-pipeline.ts': {
    count: 1,
    reason:
      'Optional-peer loading shim: the module dynamically imports ' +
      '@xenova/transformers, which is an optionalDependency and absent in CI. ' +
      'The tested path is the injectable pipelineFactory on ' +
      'TransformersEmbedding; this file only supplies the default binding.',
  },
  'cortex-llm: rerank/transformers-rerank-pipeline.ts': {
    count: 1,
    reason:
      'Optional-peer loading shim for the offline cross-encoder, same peer and ' +
      'same reason as the embedding loader. The injectable pipeline on ' +
      'CrossEncoderReranker is the tested path.',
  },
};

function tsFiles(dir: string, into: string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Tests are not shipped code and are not coverage-instrumented, so an
      // annotation there cannot affect the gate this test protects.
      if (entry === '__tests__') {
        continue;
      }
      tsFiles(full, into);
      continue;
    }
    if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) {
      into.push(full);
    }
  }
  return into;
}

/**
 * Every `.ts` file with runtime code, across every workspace package.
 *
 * `dist` is skipped: it is build output, and an annotation there is a copy of one
 * in `src` that this test would otherwise double-count. Reading `src` only also
 * keeps the scan independent of whether a build has run.
 */
function sourceFiles(): string[] {
  const packagesDir = join(ROOT, 'packages');
  const out: string[] = [];
  for (const pkg of readdirSync(packagesDir).sort()) {
    const src = join(packagesDir, pkg, 'src');
    if (!statSync(join(packagesDir, pkg)).isDirectory() || !existsSync(src)) {
      continue;
    }
    tsFiles(src, out);
  }
  return out.sort();
}

/**
 * Any coverage-suppression hint, whichever provider prefix it uses.
 *
 * `istanbul` is included even though the v8 provider does not honour it. A
 * pattern that only matches the prefixes known to work would be blind to exactly
 * the annotations most likely to be mistaken -- which is how six of them sat
 * unreviewed. Seeing more than the runtime honours is the safe direction: the
 * extra matches reach the assertions below and have to be justified or removed.
 */
const ANNOTATION = /(?:\/\/|\/\*)\s*(?:c8|v8|istanbul)\s+ignore\b[^\n]*/g;

/** The blanket forms: a whole file, or an explicitly opened block. */
const BLANKET = /\bignore\s+(?:file|start)\b/;

interface Scanned {
  /** `<package>: <path>` -> the blanket annotations in that file. */
  block: Map<string, string[]>;
  /** `<package>: <path>` -> the line-scoped (`next`) annotations only. */
  line: Map<string, string[]>;
  /** `<package>: <path>` -> annotations carrying the `istanbul` prefix. */
  istanbul: Map<string, string[]>;
}

function packageOf(file: string): string {
  const rest = relative(join(ROOT, 'packages'), file);
  return rest.split('/')[0]!;
}

function scan(): Scanned {
  const block = new Map<string, string[]>();
  const line = new Map<string, string[]>();
  const istanbul = new Map<string, string[]>();
  for (const file of sourceFiles()) {
    const text = readFileSync(file, 'utf8');
    const matches = text.match(ANNOTATION);
    if (!matches || matches.length === 0) {
      continue;
    }
    // Keyed from `packages/`, so the key does not change if the repository moves.
    const key = `${packageOf(file)}: ${relative(join(ROOT, 'packages', packageOf(file), 'src'), file)}`;
    const blanks = matches.filter((m) => BLANKET.test(m));
    if (blanks.length > 0) {
      block.set(key, blanks);
    }
    const scoped = matches.filter((m) => !BLANKET.test(m));
    if (scoped.length > 0) {
      line.set(key, scoped);
    }
    const foreign = matches.filter((m) => /\bistanbul\s+ignore\b/.test(m));
    if (foreign.length > 0) {
      istanbul.set(key, foreign);
    }
  }
  return { block, line, istanbul };
}

function counts(map: Map<string, string[]>): Record<string, number> {
  return Object.fromEntries([...map].map(([file, matches]) => [file, matches.length]));
}

function declaredCounts(spec: Record<string, { count: number }>): Record<string, number> {
  return Object.fromEntries(Object.entries(spec).map(([file, s]) => [file, s.count]));
}

describe('the coverage-ignore annotation set is pinned', () => {
  it('contains exactly the declared files, with the declared counts', () => {
    const found = scan();
    // Compared as a whole object rather than file-by-file so a NEW file with an
    // annotation fails as visibly as a changed count in a known one. Both kinds
    // are asserted, so a `next` annotation cannot be laundered into a `start`
    // block without changing a pinned number.
    expect(counts(found.line)).toEqual(declaredCounts(EXPECTED));
    expect(counts(found.block)).toEqual(declaredCounts(EXPECTED_BLOCK));
  });

  it('scans every workspace package, not only the one this file lives in', () => {
    // Guards the scope fix directly: if `sourceFiles` ever regresses to a single
    // package, the two `cortex-llm` block annotations vanish from the scan and
    // the assertion above would still pass against a smaller EXPECTED_BLOCK.
    const packages = new Set(sourceFiles().map(packageOf));
    expect([...packages].sort()).toEqual([
      'cortex-core',
      'cortex-eval',
      'cortex-llm',
      'cortex-node',
    ]);
  });

  it('declares a reason for every file that carries an annotation', () => {
    const found = scan();
    for (const file of found.line.keys()) {
      expect(EXPECTED[file], `no declared reason for ${file}`).toBeDefined();
      expect(EXPECTED[file]!.reason.length).toBeGreaterThan(20);
    }
    for (const file of found.block.keys()) {
      expect(EXPECTED_BLOCK[file], `no declared reason for ${file}`).toBeDefined();
      expect(EXPECTED_BLOCK[file]!.reason.length).toBeGreaterThan(20);
    }
  });

  it('annotates only with a stated reason, never bare', () => {
    // A bare `/* c8 ignore next */` states that code is unreachable without
    // saying why, which is the annotation equivalent of a comment-less `|| true`.
    // Every one in this repository carries a `--` rationale; that is asserted
    // here so the convention cannot decay into bare suppressions.
    const found = scan();
    for (const [file, matches] of [...found.line, ...found.block]) {
      for (const annotation of matches) {
        expect(annotation, `${file}: annotation has no rationale: ${annotation}`).toMatch(/--/);
      }
    }
  });

  it('uses no `istanbul` prefix, because the v8 provider does not honour it', () => {
    // This is the assertion that closes the six-annotation hole. `istanbul ignore
    // file` is read by nyc, not by vitest's v8 provider: all five instances in
    // `cortex-core` were deleted and the reported figure did not move by a single
    // counter (946/958 = 98.7474% before and after). An annotation whose effect
    // on the measured number is exactly zero while its effect on a reader is
    // "this was considered and exempted" is worse than no annotation.
    //
    // The assertion is an equality against an empty object rather than a
    // `toBeEmpty` on the found map, so a reintroduction reports the offending
    // file and text in the diff rather than just a count.
    expect(counts(scan().istanbul)).toEqual({});
  });

  it('does not suppress a whole file or block without declaring it', () => {
    // `c8 ignore file` / `c8 ignore start` suppress far more than a guard: they
    // remove statements from the denominator, so the reported percentage becomes
    // a statement about what was excluded rather than about what was tested.
    //
    // The blanket forms are therefore not banned outright -- the two optional-peer
    // shims genuinely cannot be executed in CI -- but they are held to a stronger
    // standard than a `next`: each one must appear in EXPECTED_BLOCK above with a
    // reason, and this test fails on any that does not. That is the difference
    // between a suppression and a reviewed suppression.
    const found = scan();
    for (const file of found.block.keys()) {
      expect(
        EXPECTED_BLOCK[file],
        `${file}: blanket suppression is not allowed: ${found.block.get(file)!.join(', ')}`,
      ).toBeDefined();
    }
    // And the converse: a declared blanket site that no longer carries one means
    // the file became testable, which is a change worth reviewing too.
    expect(counts(found.block)).toEqual(declaredCounts(EXPECTED_BLOCK));
  });

  it('leaves the type-only files unannotated because they compile to no statements', () => {
    // These five carried `/* istanbul ignore file */` and no longer do. The
    // reason they need no exemption is a property of the code, not of the
    // tooling, and this asserts it: each file consists solely of type-level
    // declarations, so there is no statement for a coverage provider to miss.
    // `coverage-final.json` records `statementMap: {}` for all five.
    //
    // This list was six. `packages/cortex-core/src/domain/provenance.ts` was the
    // sixth and is deleted -- see `docs/DECISION-PROVENANCE-NODE.md`. Its removal
    // is not a gap opening in this test: the assertion is "every file on this list
    // compiles to no statements", and a deleted file cannot violate it. Dropping it
    // from the list is the whole of the change, and it is recorded here rather than
    // done silently so the count in this comment stays honest.
    //
    // The check parses the file and classifies top-level nodes, rather than
    // pattern-matching the text. The text version was written first and failed
    // immediately -- on `answerTemporal?: (` in `cortex-eval/src/types.ts`, a
    // multi-line function-type member of an interface, which any line-oriented
    // rule reads as runtime code. That is the same lesson as this file's
    // `math/stats.ts` section: a claim about the code cannot be verified by
    // matching how the code is spelled. The AST is the compiler's own answer.
    for (const rel of [
      'packages/cortex-core/src/interfaces/embedding.ts',
      'packages/cortex-core/src/interfaces/llm.ts',
      'packages/cortex-core/src/interfaces/storage.ts',
      'packages/cortex-core/src/interfaces/vector.ts',
      'packages/cortex-eval/src/types.ts',
    ]) {
      const path = join(ROOT, rel);
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.ESNext,
        /* setParentNodes */ false,
      );
      // A type-level top-level node emits nothing. Anything else -- a variable,
      // a function, a call, an export assignment -- emits code, and a file that
      // emits code must be tested rather than exempted.
      const runtime = source.statements.filter((node) => !isTypeLevelExport(node));
      expect(
        runtime.map((node) => ts.SyntaxKind[node.kind]),
        `${rel}: declares runtime code, so it needs tests rather than an exemption`,
      ).toEqual([]);
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
