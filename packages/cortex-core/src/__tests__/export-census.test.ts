/**
 * Tests for the export census.
 *
 * The properties under test are the ones that decide whether the census is
 * trustworthy, because a census that over-reports gets ignored and one that
 * under-reports finds nothing:
 *
 *   1. It must not count a test file as a caller. If it does, every symbol looks
 *      called and the tool is blind to exactly the defect it exists to find.
 *   2. It must not count a barrel re-export as a caller. Every public symbol is
 *      in a barrel, so counting them makes the census vacuous.
 *   3. It must not count the declaring file. A recursive or self-helping symbol
 *      is not thereby reachable.
 *   4. It must match whole identifiers. `norm` must not be satisfied by
 *      `normalize`, or the census reports near-zero orphans on a codebase full
 *      of them.
 *   5. It must search repository-wide, not per-package, or every cross-package
 *      use reads as an orphan.
 *
 * Each of 1-5 is asserted against a concrete, minimal fixture rather than the
 * live repository, so a failure says which rule broke rather than which file
 * moved.
 */
import { describe, it, expect } from 'vitest';
import {
  isSourceFile,
  isTestFile,
  isBarrelFile,
  isCallerOnlyFile,
  extractExportedSymbols,
  countCallers,
  identifierPattern,
  censusPackage,
  buildCensusReport,
  listOrphans,
  packageOf,
  type ExportedSymbol,
} from '../export-census.js';

/** A file fixture: path plus text. */
function file(path: string, text: string): { path: string; text: string } {
  return { path, text };
}

/** Packs one symbol list and file list through `countCallers` and returns the entry. */
function entryFor(
  symbol: ExportedSymbol,
  files: readonly { readonly path: string; readonly text: string }[],
) {
  const [entry] = countCallers([symbol], files);
  if (entry === undefined) throw new Error('countCallers returned nothing for one symbol');
  return entry;
}

const SUBJECT: ExportedSymbol = {
  name: 'fuseRerank',
  file: 'packages/cortex-core/src/retrieval/rerank.ts',
  line: 116,
  kind: 'function',
};

describe('path classification', () => {
  it('recognises only TypeScript as source', () => {
    expect(isSourceFile('packages/a/src/b.ts')).toBe(true);
    expect(isSourceFile('packages/a/src/b.tsx')).toBe(true);
    expect(isSourceFile('packages/a/src/b.js')).toBe(false);
    expect(isSourceFile('packages/a/src/b.md')).toBe(false);
  });

  it('treats only .mjs as a caller that declares nothing', () => {
    // `tools/*.mjs` consume the packages through `dist`; they call symbols but
    // cannot declare TypeScript ones.
    expect(isCallerOnlyFile('tools/export-census.mjs')).toBe(true);
    expect(isCallerOnlyFile('tools/read-b7-criterion.mjs')).toBe(true);
    expect(isCallerOnlyFile('packages/a/src/b.ts')).toBe(false);
    expect(isCallerOnlyFile('tools/rebuild-baseline.py')).toBe(false);
  });

  it('counts a tool script as a caller so an exported API is not mislabelled orphaned', () => {
    // THE REGRESSION TEST for the caller-only extension. Without it, every
    // symbol the CLI imports reads as orphaned and the gate flags its own
    // tooling.
    const entry = countCallers(
      [
        {
          name: 'censusPackage',
          file: 'packages/cortex-core/src/export-census.ts',
          line: 277,
          kind: 'function',
        },
      ],
      [
        file('packages/cortex-core/src/export-census.ts', 'export function censusPackage() {}'),
        file(
          'tools/export-census.mjs',
          "import { censusPackage } from '../packages/cortex-core/dist/export-census.js';",
        ),
      ],
    )[0];
    expect(entry?.callerCount).toBe(1);
    expect(entry?.callers).toEqual(['tools/export-census.mjs']);
  });

  it('recognises both test conventions in use', () => {
    // A `__tests__` directory and a `.test.ts` suffix are both in use in this
    // repository. Checking only one would miss real tests and count them as
    // production callers.
    expect(isTestFile('packages/a/src/__tests__/b.test.ts')).toBe(true);
    expect(isTestFile('packages/a/src/b.test.ts')).toBe(true);
    expect(isTestFile('packages/a/src/b.spec.ts')).toBe(true);
    // A `__tests__` directory with a non-suffixed name is still a test.
    expect(isTestFile('packages/a/src/__tests__/helpers.ts')).toBe(true);
    // And a production file whose name merely contains "test" is not.
    expect(isTestFile('packages/a/src/latest.ts')).toBe(false);
    expect(isTestFile('packages/a/src/protest.ts')).toBe(false);
    expect(isTestFile('packages/a/src/contest.ts')).toBe(false);
  });

  it('recognises a barrel', () => {
    expect(isBarrelFile('packages/a/src/index.ts')).toBe(true);
    expect(isBarrelFile('packages/a/src/index.tsx')).toBe(true);
    expect(isBarrelFile('packages/a/src/indexer.ts')).toBe(false);
  });

  it('attributes a path to its workspace package', () => {
    expect(packageOf('packages/cortex-core/src/x.ts')).toBe('cortex-core');
    expect(packageOf('packages/cortex-eval/src/deep/nested/x.ts')).toBe('cortex-eval');
    // Outside `packages/` there is no package; reporting '' is better than
    // guessing, so an unexpected layout is visible rather than silently merged.
    expect(packageOf('tools/export-census.mjs')).toBe('');
    expect(packageOf('packages/')).toBe('');
  });
});

describe('extracting exported symbols', () => {
  it('finds every declaration form this repository uses', () => {
    const source = [
      'export function alpha(): void {}',
      'export async function beta(): Promise<void> {}',
      'export class Gamma {}',
      'export abstract class Delta {}',
      'export interface Epsilon {}',
      'export type Zeta = string;',
      'export enum Eta { A }',
      'export const theta = 1;',
      'export let iota = 2;',
      'export var kappa = 3;',
    ].join('\n');
    const names = extractExportedSymbols(source, 'packages/a/src/x.ts').map((s) => s.name);
    expect(names).toEqual([
      'alpha',
      'beta',
      'Gamma',
      'Delta',
      'Epsilon',
      'Zeta',
      'Eta',
      'theta',
      'iota',
      'kappa',
    ]);
  });

  it('records the kind and the 1-based line of each declaration', () => {
    const source = [
      '// a comment',
      'export const first = 1;',
      '',
      'export interface Second {}',
    ].join('\n');
    const symbols = extractExportedSymbols(source, 'packages/a/src/x.ts');
    expect(symbols).toEqual([
      { name: 'first', file: 'packages/a/src/x.ts', line: 2, kind: 'const' },
      { name: 'Second', file: 'packages/a/src/x.ts', line: 4, kind: 'interface' },
    ]);
  });

  it('does not invent a symbol from a re-export', () => {
    // `export { x } from './y'` re-exports a symbol declared elsewhere. Recording
    // it here would double-count the name: once at its declaration and once at
    // every barrel that forwards it.
    const source = "export { alpha } from './alpha.js';\nexport * from './beta.js';";
    expect(extractExportedSymbols(source, 'packages/a/src/index.ts')).toEqual([]);
  });

  it('does not invent a symbol from a default export', () => {
    // A default export has no name a consumer must use, so a name-based census
    // cannot follow it. Recording the local name would be a guess.
    expect(extractExportedSymbols('export default function () {}', 'packages/a/src/x.ts')).toEqual(
      [],
    );
    expect(extractExportedSymbols('export default 1;', 'packages/a/src/x.ts')).toEqual([]);
  });

  it('ignores a mention of a declaration inside a string or a comment', () => {
    const source = [
      '// export const commented = 1;',
      'const text = "export const quoted = 1;";',
      'export const real = 1;',
    ].join('\n');
    const names = extractExportedSymbols(source, 'packages/a/src/x.ts').map((s) => s.name);
    // The quoted one is mid-line so no anchor; the commented one is anchored by
    // `//` before `export`, which the leading-whitespace-only anchor rejects.
    expect(names).toEqual(['real']);
  });
});

describe('counting callers', () => {
  it('counts a non-test source file that references the symbol', () => {
    const entry = entryFor(SUBJECT, [
      file(SUBJECT.file, 'export function fuseRerank() {}'),
      file('packages/cortex-eval/src/use.ts', 'import { fuseRerank } from "core";\nfuseRerank();'),
    ]);
    expect(entry.callerCount).toBe(1);
    expect(entry.callers).toEqual(['packages/cortex-eval/src/use.ts']);
  });

  it('does NOT count a test file, which is the blindness this exists to remove', () => {
    // The B7 producer was reachable from its own unit tests and nowhere else.
    // If tests counted as callers, that state would read as healthy.
    const entry = entryFor(SUBJECT, [
      file(SUBJECT.file, 'export function fuseRerank() {}'),
      file(
        'packages/cortex-core/src/__tests__/rerank.test.ts',
        "import { fuseRerank } from '../rerank.js';",
      ),
      file('packages/cortex-core/src/rerank.test.ts', 'fuseRerank();'),
    ]);
    expect(entry.callerCount).toBe(0);
    expect(entry.callers).toEqual([]);
  });

  it('does NOT count a barrel re-export, or the census would be vacuous', () => {
    const entry = entryFor(SUBJECT, [
      file(SUBJECT.file, 'export function fuseRerank() {}'),
      file(
        'packages/cortex-core/src/index.ts',
        "export { fuseRerank } from './retrieval/rerank.js';",
      ),
    ]);
    expect(entry.callerCount).toBe(0);
  });

  it('does NOT count the declaring file itself', () => {
    // A function called only by its own neighbour in the same file is still
    // unreachable from outside, and a recursive function calls itself.
    const entry = entryFor(SUBJECT, [
      file(SUBJECT.file, 'export function fuseRerank() { return fuseRerank(); }'),
    ]);
    expect(entry.callerCount).toBe(0);
  });

  it('searches across package boundaries, not only the declaring package', () => {
    // THE REGRESSION TEST for the scoping flaw. `BruteForceVectorIndex` is
    // exported by cortex-core and called only by cortex-eval. A per-package
    // census reported it as an orphan.
    const entry = countCallers(
      [
        {
          name: 'BruteForceVectorIndex',
          file: 'packages/cortex-core/src/vector/brute-force.ts',
          line: 11,
          kind: 'class',
        },
      ],
      [
        file(
          'packages/cortex-core/src/vector/brute-force.ts',
          'export class BruteForceVectorIndex {}',
        ),
        file(
          'packages/cortex-eval/src/embedding-memory.ts',
          "import { BruteForceVectorIndex } from '@agentix-e/cortex-core';",
        ),
      ],
    )[0];
    expect(entry?.callerCount).toBe(1);
    expect(entry?.callers).toEqual(['packages/cortex-eval/src/embedding-memory.ts']);
  });

  it('searches across package boundaries through censusPackage, not only countCallers', () => {
    // This is the test the scoping flaw actually needed. The census above drives
    // `countCallers` directly, so it passes even when `censusPackage` narrows the
    // caller search back to the declaring package — which is the bug that
    // shipped and produced 118 false orphans on the live repository. Verified by
    // mutation: reverting `censusPackage` to `countCallers(symbols, own)` leaves
    // the previous test green and turns this one red.
    const files = [
      file('packages/core/src/a.ts', 'export function helper() {}'),
      file('packages/eval/src/b.ts', 'helper();'),
    ];
    const core = censusPackage('core', files);
    expect(core.entries.map((e) => [e.symbol.name, e.callerCount])).toEqual([['helper', 1]]);
  });

  it('de-duplicates a symbol referenced several times in one file', () => {
    const entry = entryFor(SUBJECT, [
      file(SUBJECT.file, 'export function fuseRerank() {}'),
      file('packages/cortex-eval/src/use.ts', 'fuseRerank();\nfuseRerank();\nfuseRerank();'),
    ]);
    // One caller, not three: the question is "does any non-test code mention
    // this", and a file is mentioned or not.
    expect(entry.callerCount).toBe(1);
  });

  it('sorts callers so the report is stable across filesystems', () => {
    const entry = entryFor(SUBJECT, [
      file(SUBJECT.file, 'export function fuseRerank() {}'),
      file('packages/z/src/c.ts', 'fuseRerank();'),
      file('packages/a/src/a.ts', 'fuseRerank();'),
      file('packages/m/src/b.ts', 'fuseRerank();'),
    ]);
    expect(entry.callers).toEqual([
      'packages/a/src/a.ts',
      'packages/m/src/b.ts',
      'packages/z/src/c.ts',
    ]);
  });

  it('reports every symbol it is given, in the order given', () => {
    const symbols: ExportedSymbol[] = [
      { name: 'used', file: 'packages/a/src/x.ts', line: 1, kind: 'function' },
      { name: 'unused', file: 'packages/a/src/x.ts', line: 2, kind: 'function' },
    ];
    const entries = countCallers(symbols, [
      file('packages/a/src/x.ts', 'export function used() {}\nexport function unused() {}'),
      file('packages/a/src/y.ts', 'used();'),
    ]);
    expect(entries.map((e) => [e.symbol.name, e.callerCount])).toEqual([
      ['used', 1],
      ['unused', 0],
    ]);
  });
});

describe('whole-identifier matching', () => {
  it('does not let a longer name satisfy a shorter one', () => {
    // `norm` vs `normalize`: without identifier boundaries the census reports
    // almost nothing as orphaned on a codebase like this one.
    const pattern = identifierPattern('norm');
    expect(pattern.test('const n = norm(v);')).toBe(true);
    expect(pattern.test('const n = normalize(v);')).toBe(false);
    expect(pattern.test('const n = denorm(v);')).toBe(false);
  });

  it('treats $ as an identifier character, which \\b would not', () => {
    // JavaScript's \b considers `$` a non-word character, so `\bcost\b` matches
    // inside `$cost`. The explicit character classes get this right.
    const pattern = identifierPattern('cost');
    expect(pattern.test('total = cost;')).toBe(true);
    expect(pattern.test('total = $cost;')).toBe(false);
    expect(pattern.test('total = cost$;')).toBe(false);
    expect(pattern.test('total = cost_2;')).toBe(false);
  });

  it('escapes regex metacharacters in a symbol name', () => {
    // `$` is both an identifier character and a regex anchor; a name containing
    // it must match literally.
    const pattern = identifierPattern('$count');
    expect(pattern.test('let x = $count;')).toBe(true);
    expect(pattern.test('let x = a_count;')).toBe(false);
  });
});

describe('assembling the report', () => {
  it('groups symbols by their declaring package', () => {
    const files = [
      file('packages/core/src/a.ts', 'export function one() {}'),
      file('packages/eval/src/b.ts', 'export function two() {}'),
    ];
    const core = censusPackage('core', files);
    const evalPkg = censusPackage('eval', files);
    expect(core.entries.map((e) => e.symbol.name)).toEqual(['one']);
    expect(evalPkg.entries.map((e) => e.symbol.name)).toEqual(['two']);
  });

  it('counts totals and orphans across packages', () => {
    const report = buildCensusReport([
      {
        packageName: 'a',
        entries: [
          {
            symbol: { name: 'x', file: 'packages/a/src/x.ts', line: 1, kind: 'function' },
            callerCount: 0,
            callers: [],
          },
          {
            symbol: { name: 'y', file: 'packages/a/src/x.ts', line: 2, kind: 'function' },
            callerCount: 2,
            callers: ['p', 'q'],
          },
        ],
      },
      {
        packageName: 'b',
        entries: [
          {
            symbol: { name: 'z', file: 'packages/b/src/z.ts', line: 1, kind: 'function' },
            callerCount: 0,
            callers: [],
          },
        ],
      },
    ]);
    expect(report.totalSymbols).toBe(3);
    expect(report.orphanCount).toBe(2);
  });

  it('lists orphans as package-qualified locations, sorted', () => {
    const report = buildCensusReport([
      {
        packageName: 'zeta',
        entries: [
          {
            symbol: { name: 'b', file: 'packages/zeta/src/x.ts', line: 9, kind: 'function' },
            callerCount: 0,
            callers: [],
          },
        ],
      },
      {
        packageName: 'alpha',
        entries: [
          {
            symbol: { name: 'a', file: 'packages/alpha/src/x.ts', line: 4, kind: 'class' },
            callerCount: 0,
            callers: [],
          },
          {
            symbol: { name: 'called', file: 'packages/alpha/src/x.ts', line: 5, kind: 'class' },
            callerCount: 1,
            callers: ['one'],
          },
        ],
      },
    ]);
    expect(listOrphans(report)).toEqual([
      'alpha: a (packages/alpha/src/x.ts:4)',
      'zeta: b (packages/zeta/src/x.ts:9)',
    ]);
  });

  it('returns nothing from a report with no orphans', () => {
    const report = buildCensusReport([
      {
        packageName: 'a',
        entries: [
          {
            symbol: { name: 'x', file: 'packages/a/src/x.ts', line: 1, kind: 'function' },
            callerCount: 1,
            callers: ['one'],
          },
        ],
      },
    ]);
    expect(listOrphans(report)).toEqual([]);
    expect(report.orphanCount).toBe(0);
  });
});
