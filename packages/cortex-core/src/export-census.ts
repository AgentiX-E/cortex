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
 * `tools/export-census.mjs --check` for how known-good orphans are reconciled
 * against `tools/export-census-baseline.json`, and
 * `tools/rebuild-export-census-baseline.py` for how that baseline is rebuilt
 * after a deliberate change.
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
  /**
   * For an orphan, whether its own declaring file still refers to it.
   *
   * This is the distinction that turns an undifferentiated debt number into a
   * pair of findings. `true` means the symbol is used but need not be exported —
   * deleting the `export` keyword is the whole remedy. `false` means nothing
   * mentions it anywhere and the symbol is dead.
   *
   * Absent on symbols that have a caller, where the question is moot, and on
   * entries assembled by hand. Read absent as `false`: an unclassified orphan is
   * debt until something shows otherwise.
   */
  readonly referencedLocally?: boolean;
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
  /** Orphans, split by the two counts below. Their sum is always this number. */
  readonly orphanCount: number;
  /** Orphans still used inside their own file: an unnecessary `export`. */
  readonly referencedLocallyCount: number;
  /** Orphans nothing refers to anywhere: a dead-code candidate. */
  readonly unreferencedCount: number;
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
 * Finds the last line of the block opened by a declaration.
 *
 * Counts braces from the declaration line forward and returns the line on which
 * the depth opened there first returns to zero. That span is the declaration's
 * own body, and every mention of the symbol inside it is either the declaration
 * itself or the symbol referring to itself.
 *
 * Lexical, not syntactic, and deliberately so. Bringing in a TypeScript parser
 * would make this the only thing in the module that is neither pure nor
 * synchronous, and the tests that drive it with literal strings would have to
 * grow a parser dependency. The cost is that a brace inside a string or a
 * template literal could shift the answer. The consequence is bounded and in the
 * safe direction: a drifted span is too *large*, so a mention that should count
 * falls inside the body and the symbol is classified `unreferenced` — the class
 * whose members get read. The other direction would hide debt.
 *
 * @param lines the file's lines, without terminators.
 * @param declarationLine the 0-based index of the declaration.
 * @returns the 0-based index of the line closing the block, or the last line if
 *   the braces never balance (a truncated file, where being generous is safe).
 */
export function bodyEndLine(lines: readonly string[], declarationLine: number): number {
  let depth = 0;
  let opened = false;
  for (let index = declarationLine; index < lines.length; index += 1) {
    const line = lines[index] as string;
    for (const character of line) {
      if (character === '{') {
        depth += 1;
        opened = true;
      } else if (character === '}') {
        depth -= 1;
        if (opened && depth === 0) return index;
      }
    }
  }
  return Math.max(declarationLine, lines.length - 1);
}

/**
 * The lines of a declaration that belong to the declaration itself.
 *
 * A single-line signature ends the span on the declaration line. A signature
 * whose brace is on a later line, or whose body spans lines, extends it. Without
 * the second case a multi-line `export function f(\n  a: number[],\n) {` would
 * mark the rest of the file as "inside the body" and the symbol would read as
 * unreferenced.
 *
 * @param lines the file's lines, without terminators.
 * @param declarationLine the 0-based index of the declaration.
 */
function declarationSpanEnd(lines: readonly string[], declarationLine: number): number {
  const declaration = lines[declarationLine] as string;
  const opensHere = declaration.includes('{');
  const continues =
    declarationLine + 1 < lines.length && (lines[declarationLine + 1] as string).includes('{');
  if (!opensHere && !continues) return declarationLine;
  return bodyEndLine(lines, declarationLine);
}

/**
 * Whether a symbol's own declaring file still refers to it somewhere.
 *
 * "Somewhere" excludes the declaration line and excludes the declaration's own
 * body, so that a plain `export function f()` does not count as a reference to
 * itself and self-recursion does not count as a reference from outside. Every
 * other line, before or after the declaration, does count.
 *
 * A mention in a comment or a string counts. That is a deliberate over-count in
 * the safe direction, and it is load-bearing: the text-hashing helper in
 * cortex-eval is called six times inside template literals and the candidate
 * schema key twice, so stripping comments and strings would reclassify two live,
 * heavily-used symbols as dead. A census that reports live code as dead is one
 * its readers stop believing. The price is that a symbol whose only mention is a
 * comment stays in this class rather than moving to `unreferenced`.
 *
 * That paragraph deliberately describes those symbols instead of naming them.
 * The census matches whole-file text, comments included, so writing an
 * identifier in prose here registers as a caller and silently retires that
 * symbol's orphan entry — a comment must not be able to change what the census
 * measures. This was not hypothetical: an earlier draft of this file named four
 * orphans in its own documentation and made all four read as called.
 *
 * @param symbol the symbol to classify; `symbol.line` is 1-based.
 * @param declaringFileText the full text of the file that declares it.
 */
export function isReferencedLocally(symbol: ExportedSymbol, declaringFileText: string): boolean {
  const lines = declaringFileText.split('\n');
  const declarationLine = symbol.line - 1;
  if (declarationLine < 0 || declarationLine >= lines.length) return false;
  const bodyEnd = declarationSpanEnd(lines, declarationLine);
  const pattern = identifierPattern(symbol.name);
  for (let index = 0; index < lines.length; index += 1) {
    if (index === declarationLine) continue;
    if (index > declarationLine && index <= bodyEnd) continue;
    if (pattern.test(lines[index] as string)) return true;
  }
  return false;
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
 * A zero here is then split in two by `isReferencedLocally`, because "no caller"
 * conflates two very different findings — a symbol that is used but needlessly
 * exported, and a symbol nothing uses at all. Measured on this repository before
 * the split existed, 235 orphans and 0 defects were the same statement, and the
 * 31 names nothing refers to anywhere could not be read out of it.
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
    if (callers.length > 0) return { symbol, callerCount: callers.length, callers };
    const declaringFile = files.find((file) => file.path === symbol.file);
    if (declaringFile === undefined) {
      // The declaring file was not passed in, which happens when a caller builds
      // a report by hand. Nothing can be said about local use, and an unreadable
      // orphan must not be reported as dead, so it is left unclassified: the
      // report reads the absence as `unreferenced`, the direction that gets
      // checked.
      return { symbol, callerCount: callers.length, callers };
    }
    return {
      symbol,
      callerCount: callers.length,
      callers,
      referencedLocally: isReferencedLocally(symbol, declaringFile.text),
    };
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
 * The two orphan classes are counted here rather than derived later so that the
 * equation `referencedLocallyCount + unreferencedCount === orphanCount` is a
 * property of the report object, asserted in one place, instead of a claim three
 * consumers each recompute and one of them gets wrong.
 *
 * @param packages the per-package results.
 */
export function buildCensusReport(packages: readonly PackageCensus[]): CensusReport {
  const totalSymbols = packages.reduce((sum, pkg) => sum + pkg.entries.length, 0);
  const orphans = packages.flatMap((pkg) => pkg.entries.filter((entry) => entry.callerCount === 0));
  const referencedLocallyCount = orphans.filter((entry) => entry.referencedLocally === true).length;
  return {
    packages,
    totalSymbols,
    orphanCount: orphans.length,
    referencedLocallyCount,
    // Everything not positively classified as locally referenced counts as
    // unreferenced. An entry with the flag absent is unclassified, and reading
    // an unknown as "fine" is how debt goes unreported.
    unreferencedCount: orphans.length - referencedLocallyCount,
  };
}

/** Renders one entry as `package: name (file:line)`, the census's unit of debt. */
function describeEntry(packageName: string, entry: SymbolCensusEntry): string {
  return `${packageName}: ${entry.symbol.name} (${entry.symbol.file}:${entry.symbol.line})`;
}

/** The orphans of one class, as sorted `name (file:line)` strings. */
function listOrphansMatching(
  report: CensusReport,
  matches: (entry: SymbolCensusEntry) => boolean,
): readonly string[] {
  return report.packages
    .flatMap((pkg) =>
      pkg.entries
        .filter((entry) => entry.callerCount === 0 && matches(entry))
        .map((entry) => describeEntry(pkg.packageName, entry)),
    )
    .sort();
}

/**
 * Lists the orphans in a report, as `name (file:line)` strings, sorted.
 *
 * This is the human-facing unit of a census: the set of names that could be
 * deleted without touching any production code path.
 *
 * It deliberately returns both classes together. The total is the number the
 * gate reconciles against the baseline, and splitting it here would change what
 * every existing consumer sees. Use `listReferencedLocally` and
 * `listUnreferenced` to read the two classes apart.
 *
 * @param report the census to inspect.
 */
export function listOrphans(report: CensusReport): readonly string[] {
  return listOrphansMatching(report, () => true);
}

/**
 * Lists the orphans that are still used inside their own declaring file.
 *
 * Each one is an unnecessary `export` keyword rather than dead code: the symbol
 * has a live call site, it just has no caller outside the file that declares it.
 *
 * @param report the census to inspect.
 */
export function listReferencedLocally(report: CensusReport): readonly string[] {
  return listOrphansMatching(report, (entry) => entry.referencedLocally === true);
}

/**
 * Lists the orphans that nothing refers to anywhere — not another file, not
 * their own file outside their declaration. These are the dead-code candidates,
 * and the only entries in a census that justify deletion.
 *
 * @param report the census to inspect.
 */
export function listUnreferenced(report: CensusReport): readonly string[] {
  return listOrphansMatching(report, (entry) => entry.referencedLocally !== true);
}
