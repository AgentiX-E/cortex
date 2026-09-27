/**
 * A census of exported symbols and their non-test callers.
 *
 * Why this exists
 * ---------------
 * Roadmap B7 shipped a fully working annotation producer —
 * `discriminateContext` and `renderDiscriminatedContext` — that **nothing in
 * production ever called**. It was reachable only from its own unit tests and
 * from barrel re-exports. Every conventional signal said the work was done:
 *
 *   - the unit tests passed (they drove the producer directly, so they could not
 *     ask who else does),
 *   - statement coverage was 100% (a directly-tested unreachable function is
 *     indistinguishable from a reachable one to a line counter),
 *   - the feature switch changed the prompt text (so "is the switch wired?" got
 *     the answer "yes" — it was wired to a code path that never ran).
 *
 * The gap was not in any one function. It was between a function and its
 * absence of callers, and no existing gate looked at that edge.
 *
 * What this measures
 * ------------------
 * For every symbol a package source file exports, count the references to that
 * symbol from **non-test** source files other than the one that declares it.
 * A symbol with zero such references is an *orphan*: it can be deleted without
 * breaking any production code path, which means it is not doing any work.
 *
 * Deliberately excluded from the caller count, each for a measured reason:
 *
 *   - **Test files** (`__tests__/`, `*.test.ts`, `*.spec.ts`). Counting tests
 *     would make every symbol look called, which is the exact blindness this
 *     tool exists to remove.
 *   - **Barrel files** (`index.ts`). A re-export is a `export { x } from './x'`
 *     statement, i.e. a reference to `x` that is not a use of `x`. Counting it
 *     makes the census vacuous, because every public symbol is by definition in
 *     a barrel.
 *   - **The declaring file.** A recursive function that calls itself is not
 *     thereby reachable.
 *
 * What this deliberately does NOT measure
 * ---------------------------------------
 * Reachability. A symbol referenced only by another orphan is still an orphan in
 * the sense of not being reachable from an entry point, but this census counts
 * it as called. Computing true reachability needs a root set (CLI entry points,
 * the benchmark runner, the public API surface) and that judgement belongs to
 * the roadmap, not to a mechanical gate. This tool answers one narrow, exactly
 * checkable question — "does any non-test code mention this?" — and a zero there
 * is unambiguous. It is a *necessary* condition for a symbol doing work, not a
 * sufficient one.
 *
 * The output is intentionally a report rather than a pass/fail: see
 * `baseline.ts` for how known-good orphans are reconciled.
 */

/** One exported symbol, attributed to the file that declares it. */
export type ExportedSymbol = {
  /** The symbol name as written at the declaration. */
  readonly name: string;
  /** Repository-relative path with forward slashes, e.g. `packages/x/src/y.ts`. */
  readonly file: string;
  /** 1-based line of the declaration, for reporting. */
  readonly line: number;
  /** What kind of declaration introduced the name. */
  readonly kind: ExportKind;
};

/** The declaration forms this census understands. */
export type ExportKind =
  'function' | 'class' | 'const' | 'let' | 'var' | 'enum' | 'interface' | 'type';

/** A symbol with the number of distinct non-test, non-barrel, non-self callers. */
export type SymbolCensusEntry = {
  readonly symbol: ExportedSymbol;
  /** Distinct qualifying caller files. Zero means the symbol is an orphan. */
  readonly callerCount: number;
  /** The qualifying caller files, sorted, for the failure message. */
  readonly callers: readonly string[];
};

/** A per-package rollup, so a failure names the package that regressed. */
export type PackageCensus = {
  readonly packageName: string;
  readonly entries: readonly SymbolCensusEntry[];
};

/** The whole-repository census, grouped by package and sorted deterministically. */
export type CensusReport = {
  readonly packages: readonly PackageCensus[];
  readonly totalSymbols: number;
  readonly orphanCount: number;
};

/** Extensions treated as source. Only TypeScript, which is all this repo has. */
const SOURCE_EXTENSION = /\.tsx?$/;

/**
 * Extensions treated as callers but never as declaration sites.
 *
 * `tools/*.mjs` are shipped scripts, not tests: `tools/export-census.mjs` and
 * `tools/read-b7-criterion.mjs` both import from the packages' `dist` output, so
 * they are production consumers of the symbols those packages export. Excluding
 * them would report the entire public API of the census itself as orphaned, and
 * a gate that flags its own tooling is one nobody keeps.
 *
 * They are callers only because a `.mjs` file cannot declare a TypeScript
 * symbol, so treating them as declaration sites would contribute nothing.
 */
const CALLER_ONLY_EXTENSION = /\.mjs$/;

/**
 * Declaration heads this census recognises, longest-first so that
 * `abstract class` is matched before `class` would be tried.
 *
 * Each pattern must capture the declared name in group 1. Ordering matters:
 * `async function` and `function` both exist and must not both fire on the same
 * line, so the alternation is anchored and consumed left to right.
 */
const DECLARATION_PATTERNS: readonly { readonly kind: ExportKind; readonly source: string }[] = [
  { kind: 'function', source: 'export\\s+(?:async\\s+)?function\\s+([A-Za-z_$][A-Za-z0-9_$]*)' },
  { kind: 'class', source: 'export\\s+(?:abstract\\s+)?class\\s+([A-Za-z_$][A-Za-z0-9_$]*)' },
  { kind: 'interface', source: 'export\\s+interface\\s+([A-Za-z_$][A-Za-z0-9_$]*)' },
  { kind: 'type', source: 'export\\s+type\\s+([A-Za-z_$][A-Za-z0-9_$]*)' },
  { kind: 'enum', source: 'export\\s+enum\\s+([A-Za-z_$][A-Za-z0-9_$]*)' },
  { kind: 'const', source: 'export\\s+const\\s+([A-Za-z_$][A-Za-z0-9_$]*)' },
  { kind: 'let', source: 'export\\s+let\\s+([A-Za-z_$][A-Za-z0-9_$]*)' },
  { kind: 'var', source: 'export\\s+var\\s+([A-Za-z_$][A-Za-z0-9_$]*)' },
];

const DECLARATION_REGEXES = DECLARATION_PATTERNS.map((pattern) => ({
  kind: pattern.kind,
  // Anchored to the start of a line (allowing leading whitespace) so that a
  // mention of "export" inside a string or comment mid-line cannot declare a
  // symbol. Declarations in this repo are always at the top level.
  regex: new RegExp(`^\\s*${pattern.source}`),
}));

/**
 * Whether a path is a source file this census should read for declarations.
 *
 * @param path repository-relative path with forward slashes.
 */
export function isSourceFile(path: string): boolean {
  return SOURCE_EXTENSION.test(path);
}

/**
 * Whether a path is a script that may call a symbol but declares none.
 *
 * `tools/*.mjs` consume the packages through `dist`. They are counted as callers
 * so the public API they use is not reported as orphaned.
 *
 * @param path repository-relative path with forward slashes.
 */
export function isCallerOnlyFile(path: string): boolean {
  return CALLER_ONLY_EXTENSION.test(path);
}

/**
 * Whether a path is a test file, and so must not be counted as a caller.
 *
 * Matches the repo's two conventions: a `__tests__` directory anywhere in the
 * path, and a `*.test.ts` / `*.spec.ts` suffix anywhere in the tree. Both are in
 * use, so checking only one would silently count some tests as production.
 *
 * @param path repository-relative path with forward slashes.
 */
export function isTestFile(path: string): boolean {
  if (/(^|\/)__tests__\//.test(path)) return true;
  return /\.(test|spec)\.tsx?$/.test(path);
}

/**
 * Whether a path is a barrel that only re-exports.
 *
 * `index.ts` is the convention here. Re-export statements are references to a
 * symbol but not uses of it, so counting them would make every public symbol
 * appear called.
 *
 * @param path repository-relative path with forward slashes.
 */
export function isBarrelFile(path: string): boolean {
  return /(^|\/)index\.tsx?$/.test(path);
}

/**
 * Extracts every top-level exported symbol from one file's text.
 *
 * Pure and synchronous: takes text, returns symbols. It does not read the
 * filesystem, so a test can drive it with a literal string.
 *
 * Re-exports (`export { a, b } from './x'`) and default exports are not
 * included. A re-export declares no *new* symbol — it is a reference to one
 * declared elsewhere, and that elsewhere is where the census attributes it, so
 * including it here would double-count the same name. A default export is
 * addressed by consumers through a local name of their choosing, which no
 * name-based census can follow.
 *
 * @param source the file's full text.
 * @param path repository-relative path, used only to attribute each symbol.
 * @returns symbols in file order, ties broken by declaration order.
 */
export function extractExportedSymbols(source: string, path: string): readonly ExportedSymbol[] {
  const found: ExportedSymbol[] = [];
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    // Non-null is correct here, not a cast to silence the checker: `index` is
    // bounded by `lines.length`, so the element exists. A `?? ''` fallback would
    // be an unreachable branch — the kind of dead guard that inflates a
    // coverage denominator without ever running.
    const line = lines[index] as string;
    for (const { kind, regex } of DECLARATION_REGEXES) {
      const match = regex.exec(line);
      if (match === null) continue;
      // Every pattern in DECLARATION_PATTERNS has exactly one capture group, so
      // a match always carries a name. Asserting that here keeps the invariant
      // where it is defined rather than adding a guard no input can reach.
      const name = match[1] as string;
      found.push({ name, file: path, line: index + 1, kind });
      // One declaration per line: stop at the first pattern that fires, so
      // `export async function f` is recorded once and not also as a const.
      break;
    }
  }
  return found;
}

/**
 * Counts, for each symbol, the non-test source files that reference it.
 *
 * A "reference" is a whole-word occurrence of the name in a file that is not
 * the declaring file, not a test and not a barrel. Whole-word matching is
 * enforced with identifier boundaries so `norm` does not match `normalize`, and
 * `\b` is not used directly because `$` is a valid identifier character that
 * `\b` would not treat as a word character.
 *
 * This deliberately does not parse imports. A symbol referenced only in a
 * comment or a string would be counted as called. That over-counts in the
 * safe direction: the tool's job is to find definitely-unused symbols, and a
 * false negative (missing a real orphan) is far less costly here than a false
 * positive (flagging live code), which would train its readers to ignore it.
 *
 * @param symbols the symbols to count callers for.
 * @param files every source file in the repository, with its text.
 * @returns one entry per symbol, in the same order as `symbols`.
 */
export function countCallers(
  symbols: readonly ExportedSymbol[],
  files: readonly { readonly path: string; readonly text: string }[],
): readonly SymbolCensusEntry[] {
  const countable = files.filter(
    (file) =>
      (isSourceFile(file.path) || isCallerOnlyFile(file.path)) &&
      !isTestFile(file.path) &&
      !isBarrelFile(file.path),
  );
  return symbols.map((symbol) => {
    const pattern = identifierPattern(symbol.name);
    const callers = countable
      .filter((file) => file.path !== symbol.file && pattern.test(file.text))
      .map((file) => file.path)
      .sort();
    return { symbol, callerCount: callers.length, callers };
  });
}

/**
 * Builds a whole-word matcher for an identifier.
 *
 * JavaScript's `\b` treats `$` as a non-word character, so `\bcost\b` would
 * match inside `$cost` and the pattern would be wrong for a language where `$`
 * is a legal identifier character. The explicit character-class boundaries below
 * are the correct form.
 *
 * @param name the identifier to match.
 */
export function identifierPattern(name: string): RegExp {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_$])${escaped}(?![A-Za-z0-9_$])`);
}

/**
 * Assembles the report from a flat symbol list and file texts.
 *
 * The census is **repository-wide, not per-package**. This matters more than it
 * looks: `cortex-core` exports `BruteForceVectorIndex`, and the only production
 * caller is `cortex-eval`, which imports it across the workspace boundary via
 * `@agentix-e/cortex-core`. A per-package census cannot see that import and
 * reports the class as an orphan. Measured on this repository, scoping the
 * caller search to the declaring package yields 314 orphans out of 435 exports;
 * searching the whole repository yields 196, a difference of 118 that are all
 * cross-package uses. A gate that was 27% false positives would be turned off
 * within a week, so the wide scope is the only defensible one.
 *
 * The trade-off accepted: a symbol exported for a consumer outside this
 * repository (a published package's public API) will read as an orphan. This
 * repository is `private` and publishes nothing, so no such consumer exists
 * today; if one ever does, the baseline is where that is recorded.
 *
 * Sorting is explicit and total so the report is byte-identical across runs and
 * across filesystems, which is what lets it be committed and diffed. Packages
 * and their entries are emitted in the order given, so the caller controls it.
 *
 * @param packageName the workspace package the symbols belong to.
 * @param files every source file in the repository, with its text. Files from
 *   other packages are legitimately callers, so the whole repo is passed.
 */
export function censusPackage(
  packageName: string,
  files: readonly { readonly path: string; readonly text: string }[],
): PackageCensus {
  const own = files.filter(
    (file) => isSourceFile(file.path) && packageOf(file.path) === packageName,
  );
  const symbols = own.flatMap((file) => extractExportedSymbols(file.text, file.path));
  const entries = countCallers(symbols, files);
  return { packageName, entries };
}

/**
 * The workspace package a repository-relative path belongs to.
 *
 * `packages/cortex-core/src/x.ts` -> `cortex-core`. Returns the empty string for
 * a path outside `packages/`, which no source file is, so an unexpected layout
 * attributes to no package rather than silently to the first one.
 *
 * @param path repository-relative path with forward slashes.
 */
export function packageOf(path: string): string {
  const match = /^packages\/([^/]+)\//.exec(path);
  return match?.[1] ?? '';
}

/**
 * Rolls several package censuses into one report.
 *
 * @param packages the per-package results.
 */
export function buildCensusReport(packages: readonly PackageCensus[]): CensusReport {
  const totalSymbols = packages.reduce((sum, pkg) => sum + pkg.entries.length, 0);
  const orphanCount = packages.reduce(
    (sum, pkg) => sum + pkg.entries.filter((entry) => entry.callerCount === 0).length,
    0,
  );
  return { packages, totalSymbols, orphanCount };
}

/**
 * Lists the orphans in a report, as `name (file:line)` strings, sorted.
 *
 * This is the human-facing unit of a census: the set of names that could be
 * deleted without touching any production code path.
 *
 * @param report the census to inspect.
 */
export function listOrphans(report: CensusReport): readonly string[] {
  return report.packages
    .flatMap((pkg) =>
      pkg.entries
        .filter((entry) => entry.callerCount === 0)
        .map(
          (entry) =>
            `${pkg.packageName}: ${entry.symbol.name} (${entry.symbol.file}:${entry.symbol.line})`,
        ),
    )
    .sort();
}
