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
 *   6. It must separate "used only inside its own file" from "used nowhere at
 *      all". 235 orphans and 0 defects were the same number until it did, and
 *      the 31 names nothing refers to anywhere were invisible in both readings.
 *
 * Each of 1-6 is asserted against a concrete, minimal fixture rather than the
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
  stripComments,
  censusPackage,
  buildCensusReport,
  listOrphans,
  listReferencedLocally,
  listUnreferenced,
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

describe('stripping comments before matching a name', () => {
  // The census decides "has a caller" by matching a symbol's name against file
  // text, so a name inside a comment used to count as a call. Measured on this
  // repository: `clampAwayFromZero` was reported as called by
  // `vitest.config.ts`, a file with no statement referencing it — the name
  // appeared only in the prose explaining why the function exists. That hides
  // dead code in the worst possible way, because the act of documenting a symbol
  // is what makes it disappear from the orphan report.

  it('blanks a line comment and everything after it', () => {
    const stripped = stripComments('const a = 1; // mentions target here\nconst b = 2;');
    expect(stripped).not.toContain('target');
    // The code before and after survives, and the newline still separates them.
    expect(stripped).toContain('const a = 1;');
    expect(stripped).toContain('const b = 2;');
    expect(stripped.split('\n')).toHaveLength(2);
  });

  it('blanks a block comment, including a multi-line one', () => {
    const stripped = stripComments('const a = 1;\n/* target\n   target */\nconst b = 2;');
    expect(stripped).not.toContain('target');
    expect(stripped).toContain('const a = 1;');
    expect(stripped).toContain('const b = 2;');
  });

  it('keeps every offset valid so a long comment cannot join two lines', () => {
    // Deleting a comment rather than blanking it would splice the code on either
    // side into one line, creating a match neither side has alone. Length is
    // preserved exactly, which rules that out.
    const source = 'const a = 1; /* long\ncomment\nspanning */ const b = 2;';
    const stripped = stripComments(source);
    expect(stripped).toHaveLength(source.length);
    // `1;` and `const` must not become adjacent.
    expect(stripped).not.toContain('1; const');
  });

  it('does not treat a comment marker inside a string literal as a comment', () => {
    // `'// not a comment'` is a string, and a naive scanner would cut the rest of
    // the file from it. The closing quote must survive for this to hold.
    const stripped = stripComments("const url = 'https://example.com/target';\nconst b = 1;");
    expect(stripped).toContain('target');
    expect(stripped).toContain('const b = 1;');
  });

  it('does not let an apostrophe in a comment open a string', () => {
    // The failure this guards: a scanner that skips strings without regard for
    // comments reads `// don't` as an unterminated string and blanks the rest of
    // the file, which would make every symbol look unreferenced.
    const stripped = stripComments("// don't reference target\nconst b = 'kept';");
    expect(stripped).not.toContain('target');
    expect(stripped).toContain('kept');
  });

  it('keeps a template literal, which is where dynamic references live', () => {
    const stripped = stripComments('const p = `./target.js`;');
    expect(stripped).toContain('target');
  });

  it('is a fixed point when there are no comments', () => {
    const source = 'export function f(a: number): number {\n  return a + 1;\n}';
    expect(stripComments(source)).toBe(source);
  });

  it('survives a string whose escape runs off the end of the file', () => {
    // The `?? ''` on the escape's second character. It is reachable: a file
    // truncated mid-string ends with a lone backslash, and reading one past the
    // end yields `undefined`. Without the fallback the push would emit the string
    // "undefined" into the output and lengthen it, silently shifting every offset
    // after the truncation point -- which is the one thing this function exists to
    // keep stable.
    //
    // The input is a truncated literal rather than a complete one because a
    // complete `'a\\'` consumes two characters and never reaches the boundary.
    const truncated = "const s = 'unterminated\\";
    const stripped = stripComments(truncated);
    expect(stripped).toHaveLength(truncated.length);
    expect(stripped).not.toContain('undefined');
  });

  it('classifies a name mentioned only in a comment as having no caller', () => {
    // The end-to-end form of the defect, at the unit level.
    const symbol: ExportedSymbol = {
      name: 'extractedHelper',
      file: 'packages/core/src/a.ts',
      line: 1,
      kind: 'function',
    };
    const entry = entryFor(symbol, [
      file('packages/core/src/a.ts', 'export function extractedHelper() {}'),
      file('packages/core/src/other.ts', '// extractedHelper is documented elsewhere\n'),
    ]);
    expect(entry.callerCount).toBe(0);
    expect(entry.callers).toEqual([]);
  });

  it('still classifies a real call as a caller', () => {
    // POSITIVE CONTROL for the assertion above. A matcher that stripped too much
    // — or stripped the whole file — would report zero callers for everything and
    // pass the previous test while making the census useless.
    const symbol: ExportedSymbol = {
      name: 'extractedHelper',
      file: 'packages/core/src/a.ts',
      line: 1,
      kind: 'function',
    };
    const entry = entryFor(symbol, [
      file('packages/core/src/a.ts', 'export function extractedHelper() {}'),
      file('packages/core/src/other.ts', 'const x = extractedHelper();\n'),
    ]);
    expect(entry.callerCount).toBe(1);
    expect(entry.callers).toEqual(['packages/core/src/other.ts']);
  });

  it('counts a real call even when the file also mentions the name in a comment', () => {
    // The two must not cancel: a comment does not remove a genuine call, and a
    // call does not license the comment. Both directions are asserted here rather
    // than only in isolation, so a regression in either is caught.
    const symbol: ExportedSymbol = {
      name: 'extractedHelper',
      file: 'packages/core/src/a.ts',
      line: 1,
      kind: 'function',
    };
    const entry = entryFor(symbol, [
      file('packages/core/src/a.ts', 'export function extractedHelper() {}'),
      file('packages/core/src/other.ts', '// see extractedHelper\nconst y = extractedHelper();\n'),
    ]);
    expect(entry.callerCount).toBe(1);
  });

  it('ignores a name in the declaring file\u2019s own doc comment for local use', () => {
    // `referencedLocally` asks whether the symbol is used as code inside its own
    // file. A doc comment that restates the name is not a use — otherwise
    // extracting a guarded body into a helper and documenting it would mark the
    // helper as locally referenced even when nothing called it.
    const symbol: ExportedSymbol = {
      name: 'clampAwayFromZero',
      file: 'packages/core/src/math.ts',
      line: 1,
      kind: 'function',
    };
    const undocumentedUse = entryFor(symbol, [
      file('packages/core/src/math.ts', 'export function clampAwayFromZero(v: number) {}\n'),
    ]);
    expect(undocumentedUse.referencedLocally).toBe(false);

    const docOnly = entryFor(symbol, [
      file(
        'packages/core/src/math.ts',
        '/* The clampAwayFromZero guard keeps d from underflowing. */\nexport function clampAwayFromZero(v: number) {}\n',
      ),
    ]);
    expect(docOnly.referencedLocally).toBe(false);

    const real = entryFor(symbol, [
      file(
        'packages/core/src/math.ts',
        'export function clampAwayFromZero(v: number) { return v; }\nconst x = clampAwayFromZero(1);\n',
      ),
    ]);
    expect(real.referencedLocally).toBe(true);
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

describe('separating a local reference from no reference at all', () => {
  it('marks an orphan that is called from another function in its own file', () => {
    // `logBeta` calls `logGamma`; the census saw no caller, but the symbol is
    // very much alive. This is the 200-entry majority of the 235 orphans.
    const entry = entryFor(
      {
        name: 'logGamma',
        file: 'packages/cortex-core/src/math/stats.ts',
        line: 1,
        kind: 'function',
      },
      [
        file(
          'packages/cortex-core/src/math/stats.ts',
          [
            'export function logGamma(z: number): number {',
            '  return finitePart(z);',
            '}',
            'export function logBeta(a: number, b: number): number {',
            '  return logGamma(a) + logGamma(b) - logGamma(a + b);',
            '}',
          ].join('\n'),
        ),
      ],
    );
    expect(entry.callerCount).toBe(0);
    expect(entry.referencedLocally).toBe(true);
  });

  it('does NOT treat a symbol declaration as a reference to itself', () => {
    const entry = entryFor(
      {
        name: 'logGamma',
        file: 'packages/cortex-core/src/math/stats.ts',
        line: 1,
        kind: 'function',
      },
      [
        file(
          'packages/cortex-core/src/math/stats.ts',
          ['export function logGamma(z: number): number {', '  return z;', '}'].join('\n'),
        ),
      ],
    );
    expect(entry.referencedLocally).toBe(false);
  });

  it('does NOT treat self-recursion as a local reference', () => {
    // The sentinel for the declaring-file rule: a recursive function calls
    // itself, and a call to itself is not evidence that anything else wants it.
    // Without the enclosing-body exclusion this reads as `true`.
    const entry = entryFor(SUBJECT, [
      file(SUBJECT.file, 'export function fuseRerank() { return fuseRerank(); }'),
    ]);
    expect(entry.callerCount).toBe(0);
    expect(entry.referencedLocally).toBe(false);
  });

  it('does NOT treat a mention inside a string in its own body as a local reference', () => {
    // `resolveContradiction` throws `'resolveContradiction: empty facts'`. That
    // is the symbol's own body naming itself, not a caller asking for it.
    const entry = entryFor(
      {
        name: 'resolveContradiction',
        file: 'packages/cortex-core/src/contradiction/resolve.ts',
        line: 1,
        kind: 'function',
      },
      [
        file(
          'packages/cortex-core/src/contradiction/resolve.ts',
          [
            'export function resolveContradiction(facts: readonly Fact[]): Resolution {',
            "  if (facts.length === 0) throw new Error('resolveContradiction: empty facts');",
            '  return pick(facts);',
            '}',
          ].join('\n'),
        ),
      ],
    );
    expect(entry.referencedLocally).toBe(false);
  });

  it('does not treat a comment naming the symbol as a reference in its own file', () => {
    // This test used to assert `true` and carry the justification for not
    // stripping comments: doing so "would reclassify live symbols like `hashText`
    // (called six times inside a template literal) as dead".
    //
    // That justification was wrong on its own terms, which is why it is worth
    // recording rather than quietly flipping the assertion. `hashText` is called
    // from *template literals*, not from comments — `\`t-${hashText(turn)}\`` — and
    // `stripComments` copies string and template literals through verbatim. The
    // feared regression never existed, so the conclusion drawn from it ("leave
    // comments counted as references") was unsound. `hashText` is still
    // `referencedLocally: true` today, for the right reason.
    //
    // `retrieveTopK` is the case that exposes the real cost. Its in-file mentions
    // are a declaration at line 429 and four comments (lines 101, 866, 881, 939),
    // so counting comments made it look locally used when nothing in the file
    // calls it. The old test cited `retrieveTopK` as the acceptable price of the
    // trade-off; it was in fact the false positive that the trade-off produced.
    const entry = entryFor(
      {
        name: 'retrieveTopK',
        file: 'packages/cortex-eval/src/retrieval.ts',
        // 1, not the real file's 429: the coordinate is into the fixture below.
        line: 1,
        kind: 'function',
      },
      [
        file(
          'packages/cortex-eval/src/retrieval.ts',
          [
            'export async function retrieveTopK(ctx: Context): Promise<Hit[]> {',
            '  return ctx.hits;',
            '}',
            '// The cap keeps the injected context at the same size as a single-query `retrieveTopK`.',
          ].join('\n'),
        ),
      ],
    );
    expect(entry.referencedLocally).toBe(false);
  });

  it('still counts a template-literal call as a local reference', () => {
    // POSITIVE CONTROL for the case above, and the direct refutation of the old
    // trade-off's premise. `hashText` is only ever called inside template
    // literals, so if stripping broke these it would be reported as dead.
    //
    // The declaration is spread over several lines, as the real `hashText` is.
    // A one-line body would put the calls inside `declarationSpanEnd`'s range and
    // `isReferencedLocally` excludes a declaration's own body deliberately, so a
    // single-line fixture would silently test the body-exclusion rule instead of
    // the template-literal rule. `line` is the fixture's own 1-based coordinate,
    // not the real file's: an out-of-range line makes the function return false
    // without reading anything, which is a green-looking way to test nothing.
    const entry = entryFor(
      {
        name: 'hashText',
        file: 'packages/cortex-eval/src/retrieval.ts',
        line: 1,
        kind: 'function',
      },
      [
        file(
          'packages/cortex-eval/src/retrieval.ts',
          [
            'export function hashText(text: string): string {',
            '  return text;',
            '}',
            'const id = `t-${hashText(turn)}`;',
            'const other = `s-${hashText(session.join("\\n"))}`;',
          ].join('\n'),
        ),
      ],
    );
    expect(entry.referencedLocally).toBe(true);
  });

  it('finds a reference that appears before the declaration', () => {
    // A `const` arrow used by a function declared above it must count; scanning
    // only forward from the declaration line would miss it.
    const entry = entryFor(
      { name: 'floorAt', file: 'packages/cortex-core/src/x.ts', line: 4, kind: 'const' },
      [
        file(
          'packages/cortex-core/src/x.ts',
          [
            'function clampAll(v: number[]): number[] {',
            '  return v.map((n) => floorAt(n));',
            '}',
            'export const floorAt = (n: number): number => n;',
          ].join('\n'),
        ),
      ],
    );
    expect(entry.referencedLocally).toBe(true);
  });

  it('finds a reference on the declaration line when the body is not on it', () => {
    // `export const defaultLimit = baseLimit + 1;` names `baseLimit` on the
    // declaration line of a *different* symbol in the same file.
    const entry = entryFor(
      { name: 'baseLimit', file: 'packages/cortex-core/src/x.ts', line: 1, kind: 'const' },
      [
        file(
          'packages/cortex-core/src/x.ts',
          ['export const baseLimit = 10;', 'export const defaultLimit = baseLimit + 1;'].join('\n'),
        ),
      ],
    );
    expect(entry.referencedLocally).toBe(true);
  });

  it('reads a multi-line signature without mistaking it for the body', () => {
    // The opening brace is on a later line than the declaration. A single-line
    // check would treat the entire file as "inside the body" and find nothing.
    const entry = entryFor(
      { name: 'sinkhorn', file: 'packages/cortex-core/src/math/ot.ts', line: 1, kind: 'function' },
      [
        file(
          'packages/cortex-core/src/math/ot.ts',
          [
            'export function sinkhorn(',
            '  a: number[],',
            '): SinkhornResult {',
            '  return run(a);',
            '}',
            'export const transportCost = (a: number[]) => sinkhorn(a).cost;',
          ].join('\n'),
        ),
      ],
    );
    expect(entry.referencedLocally).toBe(true);
  });

  it('does not count a docstring mention as a caller', () => {
    // THE REGRESSION TEST for a defect that was found, mis-diagnosed as
    // unavoidable, and worked around for a while.
    //
    // The first version of this test asserted the OPPOSITE — that a docstring
    // mention *does* count as a caller — and was titled "which is why prose must
    // not name orphans". The story behind it: the docstring of
    // `isReferencedLocally` named four real orphans as examples, the census
    // matched whole-file text, and all four gained `caller: export-census.ts`
    // and silently left the orphan list while `--check` reported no new orphans.
    //
    // The conclusion drawn then was that the behaviour was inherent and the rule
    // had to be "never write a symbol name in prose". That was wrong. The
    // behaviour was a bug in the matcher, not a property of the problem, and the
    // cost of the workaround was that the tool silently hid dead code whenever
    // somebody documented it.
    //
    // `stripComments` fixes the cause, so the rule is withdrawn: prose may name a
    // symbol freely, and this asserts that naming one does NOT retire a finding.
    const entry = entryFor(
      { name: 'orphanedHelper', file: 'packages/a/src/x.ts', line: 1, kind: 'function' },
      [
        file('packages/a/src/x.ts', 'export function orphanedHelper() {}'),
        file('packages/b/src/doc.ts', '// see orphanedHelper for the example'),
      ],
    );
    expect(entry.callerCount).toBe(0);
    expect(entry.callers).toEqual([]);
  });

  it('does not count a mention inside a block comment as a caller', () => {
    // The multi-line form, which is where real documentation actually lives. The
    // workaround this replaces was hardest to honour here: a JSDoc block on a
    // neighbouring function is the natural place to cross-reference a sibling.
    const entry = entryFor(
      { name: 'orphanedHelper', file: 'packages/a/src/x.ts', line: 1, kind: 'function' },
      [
        file('packages/a/src/x.ts', 'export function orphanedHelper() {}'),
        file(
          'packages/b/src/doc.ts',
          [
            '/**',
            ' * Does the thing.',
            ' *',
            ' * Compare orphanedHelper, which does the other thing.',
            ' */',
            'export function unrelated() {}',
          ].join('\n'),
        ),
      ],
    );
    expect(entry.callerCount).toBe(0);
  });

  it('keeps the local-reference flag off symbols that already have a caller', () => {
    // The flag only exists to explain an orphan. Setting it on called symbols
    // would make it a second, redundant spelling of `callerCount > 0`.
    const entry = entryFor(SUBJECT, [
      file(SUBJECT.file, 'export function fuseRerank() { return fuseRerank(); }'),
      file('packages/cortex-eval/src/use.ts', 'fuseRerank();'),
    ]);
    expect(entry.callerCount).toBe(1);
    expect(entry.referencedLocally).toBeUndefined();
  });

  it('treats an unbalanced declaration as spanning to the end of the file', () => {
    // A truncated or malformed file never closes its brace. Being generous with
    // the span is the safe direction: it can only push a mention into the body,
    // which under-reports local use, and the alternative — stopping at the
    // declaration line — would claim the whole rest of the file is outside it.
    const entry = entryFor(
      { name: 'halfWritten', file: 'packages/a/src/x.ts', line: 1, kind: 'function' },
      [
        file(
          'packages/a/src/x.ts',
          ['export function halfWritten() {', '  return halfWritten();'].join('\n'),
        ),
      ],
    );
    expect(entry.callerCount).toBe(0);
    // The only mention is inside the unterminated body, so it is self-reference.
    expect(entry.referencedLocally).toBe(false);
  });

  it('leaves the flag unset when the declaring file was not supplied', () => {
    // A hand-built call passes only the files it knows about. Nothing can be
    // said about local use, and inventing `false` would report the symbol as
    // dead; the report's own reading of an absent flag is what handles it.
    const entry = entryFor(
      { name: 'elsewhere', file: 'packages/a/src/absent.ts', line: 1, kind: 'function' },
      [file('packages/b/src/other.ts', 'const x = 1;')],
    );
    expect(entry.callerCount).toBe(0);
    expect(entry.referencedLocally).toBeUndefined();
  });
});

describe('classifying the orphan debt', () => {
  /** A report with one orphan of each class, hand-built to keep the equation exact. */
  function mixedReport() {
    return buildCensusReport([
      {
        packageName: 'a',
        entries: [
          {
            symbol: { name: 'live', file: 'packages/a/src/x.ts', line: 1, kind: 'function' },
            callerCount: 0,
            callers: [],
            referencedLocally: true,
          },
          {
            symbol: { name: 'dead', file: 'packages/a/src/x.ts', line: 2, kind: 'function' },
            callerCount: 0,
            callers: [],
            referencedLocally: false,
          },
          {
            symbol: { name: 'called', file: 'packages/a/src/x.ts', line: 3, kind: 'function' },
            callerCount: 3,
            callers: ['p', 'q', 'r'],
          },
        ],
      },
    ]);
  }

  it('counts the two orphan classes and keeps their sum equal to the orphan count', () => {
    const report = mixedReport();
    expect(report.orphanCount).toBe(2);
    expect(report.referencedLocallyCount).toBe(1);
    expect(report.unreferencedCount).toBe(1);
    expect(report.referencedLocallyCount + report.unreferencedCount).toBe(report.orphanCount);
  });

  it('counts an orphan with no classification recorded as unreferenced', () => {
    // Entries assembled by hand (or by an older reader) carry no flag. Reading
    // an absent flag as "referenced" would hide debt; reading it as
    // "unreferenced" over-reports it, which is the direction that gets checked.
    const report = buildCensusReport([
      {
        packageName: 'a',
        entries: [
          {
            symbol: { name: 'unknown', file: 'packages/a/src/x.ts', line: 1, kind: 'function' },
            callerCount: 0,
            callers: [],
          },
        ],
      },
    ]);
    expect(report.unreferencedCount).toBe(1);
    expect(report.referencedLocallyCount).toBe(0);
  });

  it('lists the locally-referenced orphans as package-qualified locations, sorted', () => {
    expect(listReferencedLocally(mixedReport())).toEqual(['a: live (packages/a/src/x.ts:1)']);
  });

  it('lists the unreferenced orphans as package-qualified locations, sorted', () => {
    expect(listUnreferenced(mixedReport())).toEqual(['a: dead (packages/a/src/x.ts:2)']);
  });

  it('partitions the orphans, so no orphan is listed twice or dropped', () => {
    const report = mixedReport();
    const both = [...listReferencedLocally(report), ...listUnreferenced(report)].sort();
    expect(both).toEqual(listOrphans(report));
  });

  it('returns nothing from the classifier lists when there is no orphan debt', () => {
    const report = buildCensusReport([
      {
        packageName: 'a',
        entries: [
          {
            symbol: { name: 'called', file: 'packages/a/src/x.ts', line: 1, kind: 'function' },
            callerCount: 1,
            callers: ['one'],
          },
        ],
      },
    ]);
    expect(listReferencedLocally(report)).toEqual([]);
    expect(listUnreferenced(report)).toEqual([]);
  });
});
