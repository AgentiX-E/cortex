#!/usr/bin/env node
/**
 * Which capabilities belong to the product, which belong to the harness, and which exist in neither.
 *
 *     node tools/product-capability-ledger.mjs            # print the ledger as a table
 *     node tools/product-capability-ledger.mjs --check    # fail if the record and the code disagree
 *     node tools/product-capability-ledger.mjs --write    # regenerate docs/PRODUCT-CAPABILITY-LEDGER.md
 *     node tools/product-capability-ledger.mjs --strict   # also fail if any row is not `product`
 *
 * ## The question, and why a table could not answer it
 *
 * The v4 audit's finding is that this repository's headline accuracy is produced by
 * `cortex-eval` -- ranking, anchor recovery, temporal arithmetic, candidate annotation all live
 * there -- and that several mechanisms exist in the product, with tests and full coverage, that no
 * customer can reach. Both halves of that were argued in prose, over 26 hand-written rows whose four
 * judgements (installable / independent / self-sufficient / callable) were typed by a reader.
 *
 * A hand-typed judgement about code is a claim with no expiry date. It was already wrong in the
 * report in one place: `DisclosureSession` is listed as "zero non-test callers" and the caller
 * census disagreed, because the census counted `tools/*.mjs` as callers. Both statements were
 * defensible and they could not both be true, which is the shape of every finding in
 * `AUDIT-SILENT-DENOMINATOR.md`.
 *
 * So this tool derives the verdict and the declaration only names what it is talking about.
 *
 * ## What is derived, and what is merely recorded
 *
 * | column | derived from | what it proves |
 * | --- | --- | --- |
 * | `D1 in a product package` | the declaring file's path | the symbol ships to a customer |
 * | `D2 isolated` | the file's local import closure | no path from it reaches `tools/` or `cortex-eval` |
 * | `D4 called` | the caller census, partitioned | some product file references the name |
 * | `D3 self-sufficient` | **nothing** | declared, and marked as declared |
 *
 * D3 is the one the report could not mechanise: "its input comes from state the product holds rather
 * than from arguments the caller supplies" is a statement about what a function *means*, and every
 * attempt to decide it from a signature gets `buildPrompt(context, question)` wrong in one direction
 * or the other. It is kept as a declared sentence because deleting the column would hide that the
 * ledger is silent on it, and because a sentence that names the state container is auditable by a
 * reader even when it is not auditable by a script. The legend in the generated document says so.
 *
 * ## Four states, and the two directions each can fail in
 *
 * Every row resolves to one state, and `expect` is what the row claims. `--check` fails when they
 * disagree **in either direction**, which is the property that keeps the table alive:
 *
 *   - a `product` row whose caller disappears -> `blocked` -> red, because a published capability
 *     just became unreachable;
 *   - a `product-blocked` row whose caller appears -> `product` -> red, because the debt was paid and
 *     the row still says otherwise;
 *   - a `gap` row whose symbol appears -> `product`/`blocked` -> red, because the gap closed;
 *   - an `instrument` row whose mechanism moved into the product -> red, because the boundary
 *     argument would otherwise keep citing a breach that no longer exists.
 *
 * A red is a two-line edit, and it is always an edit *toward the code's current state*. That is the
 * difference between a ledger and a rubber stamp.
 *
 * ## The fifth red, which is the one the report asked for
 *
 * `boundary` records the product exports that only the harness calls -- 57 of them when this gate
 * arrived. A new one is a mechanism that just became instrument-only, which is exactly the change
 * this repository wants to be told about; adding one without a recorded rationale fails the check
 * and names the symbol. The count is not the finding; the *name* is, which is why the record is a set
 * of names grouped by shape rather than a number.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { stripComments, stripStringContent } from '../packages/cortex-core/dist/export-census.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * The tree this tool measures.
 *
 * `CAPABILITY_LEDGER_ROOT` exists for the same reason `EXPORT_CENSUS_ROOT` does:
 * every failure this tool can report has to be provable, and proving one means
 * building a tree that contains it. Injecting the defect into the checkout the
 * suite is asserting about makes the suite a writer of its own subject -- two
 * runs interleave, the loser's bytes survive, and the next failure is attributed
 * to the ledger rather than to the harness.
 */
const ROOT_OVERRIDE = process.env.CAPABILITY_LEDGER_ROOT;
const REPO =
  ROOT_OVERRIDE === undefined || ROOT_OVERRIDE === ''
    ? path.resolve(HERE, '..')
    : path.resolve(ROOT_OVERRIDE);
const DECLARATIONS =
  process.env.CAPABILITY_LEDGER_DECLARATIONS ??
  path.join(REPO, 'tools/product-capability-declarations.json');
const DOCUMENT = path.join(REPO, 'docs/PRODUCT-CAPABILITY-LEDGER.md');

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const write = argv.includes('--write');
const strict = argv.includes('--strict');
const asJson = argv.includes('--json');

/** The packages a customer installs. Everything else is the measurement. */
const PRODUCT_PACKAGES = new Set(['cortex-core', 'cortex-memory', 'cortex-storage', 'cortex-ai']);

/** A refusal: a message for stderr and a non-zero exit, never a silent downgrade. */
class LedgerRefused extends Error {}

/** The refusal reasons a row may not give. A reason has to name something. */
const PLACEHOLDER = /^(tbd|todo|n\/a|na|none|-+|later|see above|same as above)\.?$/i;

/** Read the census this tool derives from, from the census's own command. */
function census() {
  // Deliberately a subprocess of the committed CLI rather than a second walk of
  // the tree: the tool's verdict must be the gate's verdict, and two
  // implementations that agree today are two implementations that will disagree
  // after the next change to either.
  const out = execFileSync(process.execPath, [path.join(HERE, 'export-census.mjs'), '--json'], {
    cwd: REPO,
    // The census reads its own root from the environment, so a fixture that
    // overrides this tool's root must override the census's too -- otherwise the
    // verdict would be derived from the checkout while the test asserts about the
    // fixture.
    env: { ...process.env, EXPORT_CENSUS_ROOT: REPO },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

/**
 * Every file the walk and the gate search need, as text, by relative path.
 *
 * Not only the declaring files: an import closure passes through modules that
 * export nothing, and a gate literal lives in the file that *uses* the option
 * rather than in the one that declares it. Reading a narrower set would make
 * `--check` pass on a tree it had not looked at.
 */
function readTree() {
  const texts = new Map();
  for (const root of ['packages', 'tools']) {
    if (!existsSync(path.join(REPO, root))) continue;
    for (const entry of readdirSync(path.join(REPO, root), { recursive: true })) {
      const file = `${root}/${entry}`;
      if (!/\.(ts|tsx|mjs)$/.test(file)) continue;
      if (file.includes('node_modules') || file.includes('/dist/')) continue;
      texts.set(file, readFileSync(path.join(REPO, file), 'utf8'));
    }
  }
  return texts;
}

/** One import specifier per line, comment-blanked, from a TypeScript file's text. */
function importSpecifiers(text) {
  const blanked = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const specifiers = [];
  const pattern = /\bfrom\s+['"]([^'"]+)['"]/g;
  for (let match = pattern.exec(blanked); match !== null; match = pattern.exec(blanked)) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

/**
 * Resolve one import to a repository file, or to nothing.
 *
 * Only two shapes exist here: a relative path, and a workspace package. A relative
 * specifier may name a directory (`./disclosure`), a file with no extension
 * (`./memory`), or a compiled-looking file (`./x.js`) -- TypeScript's `bundler`
 * resolution allows all three, and a resolver that handles only the first reports
 * an empty closure for most files, which reads as "isolated".
 */
function resolveImport(from, specifier) {
  if (specifier.startsWith('.')) {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
    const stem = base.endsWith('.js') ? base.slice(0, -3) : base;
    for (const candidate of [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`]) {
      if (existsSync(path.join(REPO, candidate))) return candidate;
    }
    return null;
  }
  const workspace = /^@agentix-e\/([\w-]+)(?:\/.*)?$/.exec(specifier);
  if (workspace === null) return null;
  const candidate = `packages/${workspace[1]}/src/index.ts`;
  return existsSync(path.join(REPO, candidate)) ? candidate : null;
}

/**
 * Every repository file reachable from `start` by local imports, inclusive.
 *
 * Breadth-first with a visited set, and no depth cap: a cap would turn a deep
 * chain into a clean report, which is the direction that hides a breach.
 */
function importClosure(start, texts) {
  const seen = new Set([start]);
  const queue = [start];
  const instrumentImports = [];
  while (queue.length > 0) {
    const file = queue.shift();
    const text = texts.get(file);
    if (text === undefined) continue;
    for (const specifier of importSpecifiers(text)) {
      // The specifier is checked, not only the path it resolves to: a fixture --
      // or a checkout missing a barrel -- has no `cortex-eval/src/index.ts`, and a
      // dependency that cannot be resolved is still a dependency.
      if (isInstrumentSpecifier(specifier)) instrumentImports.push(`${file} -> ${specifier}`);
      const next = resolveImport(file, specifier);
      if (next === null || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return { files: [...seen].sort(), instrumentImports: instrumentImports.sort() };
}

/** Whether an import specifier names the instrument, resolvable or not. */
function isInstrumentSpecifier(specifier) {
  if (specifier.startsWith('tools/') || specifier.startsWith('../tools/')) return true;
  return /^@agentix-e\/cortex-eval(\/|$)/.test(specifier) || /(^|\/)cortex-eval\//.test(specifier);
}

/**
 * Whether a path is a barrel that only re-exports.
 *
 * Mirrors `packages/cortex-core/src/export-census.ts`, which is not imported here
 * because this tool reads the census through its CLI. The duplication is one line
 * and the alternative -- a second import path into the same module -- is what the
 * subprocess exists to avoid.
 */
function isBarrelFile(file) {
  return /(^|\/)index\.tsx?$/.test(file);
}

/** Whether a path is one a customer installs. */
function isProductPath(file) {
  const match = /^packages\/([\w-]+)\//.exec(file);
  return match !== null && PRODUCT_PACKAGES.has(match[1]);
}

/** The instrument trees: the harness and the scripts that drive it. */
function isInstrumentPath(file) {
  return file.startsWith('tools/') || /^packages\/cortex-eval\//.test(file);
}

/**
 * The state a row is actually in, derived.
 *
 * Order matters. `absent` first, because a symbol that does not exist cannot be
 * in a package; then the package, because a harness symbol is the harness
 * working however many product files name it; then the product caller, which is
 * the only fact that says a customer can reach it.
 */
function derivedState(row, index, reach) {
  // A row with no symbol is a row about a *file*: the harness's own scripts
  // declare nothing, so `tools/competitor-sut.mjs` cannot be indexed by name. It
  // is instrument by location and there is nothing else to check about it.
  if (row.symbol === null || row.symbol === undefined) {
    if (row.site == null) return { state: 'absent', entry: undefined };
    return { state: isInstrumentPath(row.site) ? 'instrument' : 'absent', entry: undefined };
  }
  const entries = index.get(row.symbol) ?? [];
  const entry = entries.find((candidate) => candidate.symbol.file === row.site) ?? entries[0];
  if (entry === undefined) return { state: 'absent', entry: undefined };
  if (!isProductPath(entry.symbol.file)) return { state: 'instrument', entry };
  if (!reach.reachable.has(entry.symbol.name)) return { state: 'blocked', entry };
  return { state: 'product', entry };
}

/**
 * The product's entry file: the one place a customer's code starts.
 *
 * `CortexMemory` is the product. Everything else either serves it or does not
 * serve a customer at all, and the difference cannot be read off one file at a
 * time -- which is the second thing this tool found.
 *
 * `DisclosureSession` has no product caller and the census says so. `CardQueue`
 * *does* have one: `DisclosureSession` calls it. Both are unreachable, and a
 * one-hop caller count cannot tell the two apart, so it called `CardQueue`
 * reachable and the audit's row for the disclosure boundary would have been
 * recorded as `product`. Reachability has to be transitive or it is not
 * reachability.
 */
const ENTRY_FILES = [
  'packages/cortex-memory/src/memory.ts',
  // The second entry, added when it started existing. `memory.ts` is the class; `assemble.ts` is the
  // function an installer actually calls, and until this round the package shipped the class and no worked
  // construction of it -- the only non-test one lived in `bench/`, which `files: ["dist"]` does not ship.
  // An entry list that named the class and not the composition root would keep reporting the boundary as
  // unreachable after the product started reaching it, which is a `blocked` row that is wrong in the
  // direction that costs a customer: it says "you cannot use this" about something you can.
  'packages/cortex-memory/src/assemble.ts',
];

/**
 * Every identifier a file's **code** contains, as a set.
 *
 * Comments and string bodies are blanked with the census's own two functions, for
 * the reason the census blanks them: `cortex-core/src/triage/erasure.ts` says
 * "`DisclosureSession`" in a docblock explaining why `facts` is not a parameter,
 * and a tokenizer that read prose would report the class as reachable on the
 * strength of a sentence about it. That is exactly what the first run of this walk
 * did.
 *
 * The helpers are imported from the build while the census *numbers* come from the
 * CLI. That is deliberate: the verdict must equal the gate's, and the tokenizer
 * must equal the matcher's, and those are two different consumers of one module.
 */
function identifierTokens(text) {
  return new Set(stripStringContent(stripComments(text)).match(/[A-Za-z_$][\w$]*/g) ?? []);
}

/**
 * The names a customer can reach.
 *
 * Breadth-first over two edge kinds, and the asymmetry between them is the whole
 * point:
 *
 *   - an **import** makes the imported *file* reachable, because it will be
 *     loaded, and the symbols it declares remain unreachable until something
 *     refers to them;
 *   - a **reference** makes the named symbol reachable, and only if the file
 *     holding the reference is itself reachable.
 *
 * A single hop over "which product files mention this name" conflates the two:
 * it credits a symbol for being called by code that nothing calls.
 *
 * One limitation, stated because it is the permissive direction: a name imported
 * only for its type counts as a reference, exactly as it does in the caller
 * census. A `blocked` verdict is therefore stronger than a `product` one -- a row
 * marked `product` could in principle be a type-only import, while a row marked
 * `blocked` has no chain of references from the entry at all.
 */
function reachableNames(index, texts) {
  const declared = new Map();
  for (const [name, entries] of index) {
    declared.set(name, new Set(entries.map((entry) => entry.symbol.file)));
  }
  const reachable = new Set();
  const seenFiles = new Set();
  const queue = [...ENTRY_FILES];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seenFiles.has(file)) continue;
    seenFiles.add(file);
    const text = texts.get(file);
    if (text === undefined) continue;
    for (const specifier of importSpecifiers(text)) {
      const next = resolveImport(file, specifier);
      if (next !== null && !seenFiles.has(next)) queue.push(next);
    }
    // A barrel re-exports every name in its directory, so counting its tokens
    // would make the whole package reachable through `import ... from
    // '@agentix-e/cortex-core'`. The caller census excludes barrels for the same
    // reason; this walk still *traverses* one, because the modules it points at
    // are genuinely loaded.
    if (isBarrelFile(file)) continue;
    for (const token of identifierTokens(text)) {
      if (!declared.has(token)) continue;
      // A declaration is not a reference. Without this the declaring file makes
      // its own exports reachable, which is how `DisclosureSession` -- whose only
      // mention is its own `export class` line -- came out as reachable on the
      // first run of this walk.
      if (declared.get(token)?.has(file) === true) continue;
      reachable.add(token);
    }
  }
  return { reachable, files: seenFiles };
}

/** The four facts, as booleans, for the table. */
function factsOf(row, resolved, texts, reach) {
  if (resolved.entry === undefined) {
    return {
      d1: false,
      d2: false,
      d4: false,
      closure: [],
      instrumentImports: [],
      productCallers: [],
      reachable: false,
    };
  }
  const site = resolved.entry.symbol.file;
  const closure = importClosure(site, texts);
  return {
    d1: isProductPath(site),
    // The declaring file is in the closure, so a product row must not have the
    // instrument anywhere on its import path -- itself included.
    d2: !closure.files.some((file) => isInstrumentPath(file)) && closure.instrumentImports.length === 0,
    d4: reach.reachable.has(resolved.entry.symbol.name),
    closure: closure.files,
    instrumentImports: closure.instrumentImports,
    productCallers: resolved.entry.productCallers ?? [],
    instrumentCallers: resolved.entry.instrumentCallers ?? [],
    // Reported beside D4 rather than instead of it: the gap between "some product
    // file mentions it" and "a customer can reach it" is where `CardQueue` lives,
    // and a reader who is shown one number will assume it is the other.
    reachable: reach.reachable.has(resolved.entry.symbol.name),
  };
}

/**
 * The state each claim requires.
 *
 * Five claims rather than four because `blocked` names two different findings
 * that look identical from the code: a product capability nobody can reach (debt
 * to assemble) and an instrument capability that was written into a product
 * package (debt to move). The row says which one it is; the tool checks that the
 * state is the one that claim requires.
 */
const REQUIRED = {
  product: 'product',
  'product-blocked': 'blocked',
  instrument: 'instrument',
  'instrument-misplaced': 'blocked',
  gap: 'absent',
};

const REMEDY = {
  product: 'wire a product caller, or demote the row to `product-blocked`',
  'product-blocked': 'the debt was paid: promote the row to `product`',
  instrument: 'the mechanism moved into the product: this row must say `product`',
  'instrument-misplaced': 'give it a product caller, or move it to `cortex-eval` and say `instrument`',
  gap: 'the gap closed: give this row its symbol and the state it now has',
};

/** What the row claims, and whether the code agrees. */
function judge(row, resolved, facts, texts) {
  const problems = [];
  const state = resolved.state;
  const required = REQUIRED[row.expect];
  if (required === undefined) {
    problems.push(`\`${row.expect}\` is not a claim this ledger knows: ${Object.keys(REQUIRED).join(', ')}`);
    return problems;
  }
  if (state !== required) {
    problems.push(`expect ${row.expect} (${required}), derived ${state} -- ${REMEDY[row.expect]}`);
  }
  // D2 has to be able to fail the build or it is decoration. A product capability
  // whose declaring file imports the harness is reachable by a customer only if
  // the harness is installed, which is the definition of the boundary breach.
  if (state === 'product' && !facts.d2) {
    const detail = facts.instrumentImports.slice(0, 3).join(', ');
    problems.push(`the declaring file reaches the instrument: ${detail || 'import path'}`);
  }
  // A gate is a claim about code, so it is checked as one. The literal has to
  // appear in the tree; a gate that was removed and a gate that was never there
  // are the same defect.
  if (row.gate !== undefined) {
    const present = [...texts.entries()].some(
      ([file, text]) => isProductPath(file) && !file.includes('__tests__') && text.includes(row.gate),
    );
    if (!present) problems.push(`gate not found in product source: ${row.gate}`);
  }
  if (row.absent !== undefined) {
    const present = [...texts.entries()].some(
      ([file, text]) => isProductPath(file) && !file.includes('__tests__') && text.includes(row.absent),
    );
    if (present) problems.push(`the gap closed: \`${row.absent}\` now exists in the product`);
  }
  if (row.expect !== 'product') {
    const reason = (row.reason ?? '').trim();
    if (reason.length < 20 || PLACEHOLDER.test(reason)) {
      problems.push(
        `a row that is not \`product\` needs a reason of at least 20 characters, got: ${JSON.stringify(reason)}`,
      );
    }
  }
  return problems;
}

/** The product exports that only the instrument calls, as names, from the census. */
function boundaryOf(report) {
  const names = new Set();
  for (const pkg of report.packages) {
    for (const entry of pkg.entries) {
      if (entry.callerCount === 0) continue;
      if ((entry.productCallers ?? ['product']).length > 0) continue;
      if (!isProductPath(entry.symbol.file)) continue;
      names.add(entry.symbol.name);
    }
  }
  return names;
}

/** The rows, derived, judged, with every fact the table prints. */
function buildLedger(declarations, censusPayload, texts) {
  const index = new Map();
  for (const pkg of censusPayload.report.packages) {
    for (const entry of pkg.entries) {
      const list = index.get(entry.symbol.name) ?? [];
      list.push(entry);
      index.set(entry.symbol.name, list);
    }
  }
  const reach = reachableNames(index, texts);
  const rows = declarations.capabilities.map((row) => {
    const resolved = derivedState(row, index, reach);
    const facts = factsOf(row, resolved, texts, reach);
    const problems = judge(row, resolved, facts, texts);
    return { row, resolved, facts, problems };
  });

  const boundary = boundaryOf(censusPayload.report);
  const recorded = new Set(declarations.boundary.flatMap((group) => group.symbols));
  const boundaryProblems = [];
  for (const name of [...boundary].sort()) {
    if (!recorded.has(name)) {
      boundaryProblems.push(
        `\`${name}\` is a product export called only by the instrument and is in no boundary group: ` +
          'either wire a product caller or record which capability it was meant to serve',
      );
    }
  }
  for (const name of [...recorded].sort()) {
    if (!boundary.has(name)) {
      boundaryProblems.push(
        `\`${name}\` is recorded as instrument-only but is not: the record is stale and must shrink`,
      );
    }
  }

  const counts = { product: 0, blocked: 0, instrument: 0, absent: 0, gated: 0 };
  for (const { row, resolved } of rows) {
    counts[resolved.state] += 1;
    if (row.gate !== undefined) counts.gated += 1;
  }
  return { rows, counts, boundary, recorded, boundaryProblems, reach };
}

/** The ledger as a markdown table, and the legend that says what each column proves. */
function render(ledger, declarations) {
  const lines = [];
  lines.push('# Product capability ledger');
  lines.push('');
  lines.push('<!-- Generated by tools/product-capability-ledger.mjs. Do not edit by hand: edit');
  lines.push('     tools/product-capability-declarations.json and run `pnpm ledger:write`. -->');
  lines.push('');
  lines.push('What this repository can sell, what exists only so that it can be measured, and what');
  lines.push('neither has. Every verdict in the table below is derived from the code by');
  lines.push('`tools/product-capability-ledger.mjs`; the declaration names the capability and its symbol, and');
  lines.push('`pnpm ledger:check` fails when the two disagree in either direction.');
  lines.push('');
  lines.push('## The four states');
  lines.push('');
  lines.push('| state | what it means | how it is derived |');
  lines.push('| --- | --- | --- |');
  lines.push(
    '| **product** | a customer can reach it | declared in a product package, no import path to the instrument, and reachable from `packages/cortex-memory/src/memory.ts` by a chain of references |',
  );
  lines.push(
    '| **blocked** | implemented, tested, unreachable | declared in a product package, and **no reference reaches it from the entry** — either nothing calls it, or the only thing that calls it is itself unreachable |',
  );
  lines.push(
    '| **instrument** | it exists for the measurement | declared under `tools/` or `packages/cortex-eval/` |',
  );
  lines.push('| **gap** | named here, absent from the code | the symbol is not declared anywhere |');
  lines.push('');
  lines.push('A `gate` column names the configuration switch a capability sits behind, and it is checked');
  lines.push('as a literal against the product source: a gate removed from the code and a gate that was');
  lines.push('never there are the same defect. `D3` is **declared, not derived** — see the note below the');
  lines.push('table.');
  lines.push('');
  lines.push(`## The ledger (${ledger.rows.length} rows)`);
  lines.push('');
  lines.push('| # | capability | claim | state | D1 | D2 | D3 (declared) | D4 | product callers | site |');
  lines.push('| ---: | --- | --- | --- | :---: | :---: | --- | :---: | --- | --- |');
  const mark = (value) => (value ? '✓' : '✗');
  for (const { row, resolved, facts } of ledger.rows) {
    // A blocked row can have a one-hop caller and still be unreachable -- that is
    // the `CardQueue` shape, and printing the count without the qualifier would
    // read as "callable, and the state column is wrong".
    const callers =
      facts.productCallers.length === 0
        ? '—'
        : resolved.state === 'blocked'
          ? `unreachable: ${facts.productCallers.length} via \`${facts.productCallers[0]}\``
          : facts.productCallers.length === 1
            ? `\`${facts.productCallers[0]}\``
            : `${facts.productCallers.length}, e.g. \`${facts.productCallers[0]}\``;
    const state =
      resolved.state === 'product' && row.gate !== undefined ? 'product (gated)' : resolved.state;
    // A row with no symbol has no facts to mark. Printing ✗ for D2 on a gap row
    // would read as "this exists and fails a criterion" rather than "there is
    // nothing here", which is the difference the `gap` state exists to make.
    const cells =
      resolved.entry === undefined
        ? ['—', '—', '—', '—']
        : [mark(facts.d1), mark(facts.d2), null, mark(facts.d4)];
    lines.push(
      `| ${row.id} | ${row.capability} | ${row.expect} | **${state}** | ${cells[0]} | ${cells[1]} | ${row.d3} | ${cells[3]} | ${callers} | ${row.site == null ? '—' : `\`${row.site}\``} |`,
    );
  }
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| | rows |');
  lines.push('| --- | ---: |');
  for (const state of ['product', 'blocked', 'instrument', 'absent']) {
    lines.push(`| ${state === 'absent' ? 'gap' : state} | ${ledger.counts[state]} |`);
  }
  lines.push(`| of the product rows, behind a configuration switch | ${ledger.counts.gated} |`);
  lines.push(`| **total** | **${ledger.rows.length}** |`);
  lines.push('');
  lines.push(
    `Product completeness by this measure: **${ledger.counts.product}/${ledger.rows.length}** capabilities are reachable by a customer. ` +
      `The rest are ${ledger.counts.blocked} blocked, ${ledger.counts.instrument} owned by the instrument and ` +
      `${ledger.counts.absent} absent.`,
  );
  lines.push('');
  lines.push('## Why `D3` is declared and not derived');
  lines.push('');
  lines.push(
    'The four judgements the audit proposed were *installable* (D1), *independent* (D2),',
  );
  lines.push('*self-sufficient* (D3) and *callable* (D4). Three of them reduce to facts about paths and');
  lines.push('callers, which is what the three columns above compute. D3 does not.');
  lines.push('');
  lines.push(
    'D3 asks whether a capability draws on state the product holds, or on arguments the caller',
  );
  lines.push('hands it at every call. `buildPrompt(context, question)` fails D3 by that reading, and so');
  lines.push('does every mechanism in this repository that this ledger calls `product`, because the');
  lines.push('product\'s public contract *is* `answer(question, context)`. Mechanising D3 would therefore');
  lines.push('demote the entire product on the strength of a signature, which is a true statement about');
  lines.push('the signature and a false one about the capability.');
  lines.push('');
  lines.push('So the column records the claim and says what it was based on. Where the claim is doing real');
  lines.push('work — the rows the audit grouped as "the instrument ranks, the product does not" — the');
  lines.push('evidence is the `state` column, which is derived.');
  lines.push('');
  lines.push(`## The boundary (${ledger.boundary.size} product exports)`);
  lines.push('');
  lines.push(
    'Product exports whose only callers are the instrument. This is the audit\'s §3.3 argument as a',
  );
  lines.push('set of names rather than a paragraph, and `pnpm ledger:check` fails on a new member: a');
  lines.push('mechanism that just became instrument-only is the change this repository wants to be told');
  lines.push('about.');
  lines.push('');
  for (const group of declarations.boundary) {
    const present = group.symbols.filter((name) => ledger.boundary.has(name)).sort();
    if (present.length === 0) continue;
    lines.push(`### ${group.category} (${present.length})`);
    lines.push('');
    lines.push(group.rationale);
    lines.push('');
    lines.push(present.map((name) => `\`${name}\``).join(', '));
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

function main() {
  const declarations = JSON.parse(readFileSync(DECLARATIONS, 'utf8'));
  const payload = census();
  const texts = readTree();
  for (const row of declarations.capabilities) {
    if (row.site != null && !texts.has(row.site)) {
      throw new LedgerRefused(`row ${row.id} names a site that does not exist: ${row.site}`);
    }
  }

  const ledger = buildLedger(declarations, payload, texts);
  const failures = [];
  for (const { row, problems } of ledger.rows) {
    for (const problem of problems) failures.push(`row ${row.id} (${row.capability}): ${problem}`);
  }
  failures.push(...ledger.boundaryProblems);

  if (asJson) {
    process.stdout.write(
      `${JSON.stringify(
        {
          counts: ledger.counts,
          rows: ledger.rows.map(({ row, resolved, facts, problems }) => ({
            id: row.id,
            capability: row.capability,
            expect: row.expect,
            state: resolved.state,
            site: resolved.entry?.symbol.file ?? null,
            productCallers: facts.productCallers,
            instrumentCallers: facts.instrumentCallers ?? [],
            gate: row.gate ?? null,
            problems,
          })),
          boundary: [...ledger.boundary].sort(),
          boundaryProblems: ledger.boundaryProblems,
        },
        null,
        2,
      )}\n`,
    );
    return failures.length === 0 ? 0 : 1;
  }

  const rendered = render(ledger, declarations);
  if (write) {
    // A fixture tree has no `docs/`, and a tool that can only write into a
    // complete checkout cannot be tested against a partial one.
    mkdirSync(path.dirname(DOCUMENT), { recursive: true });
    writeFileSync(DOCUMENT, rendered, 'utf8');
    process.stdout.write(`wrote ${path.relative(REPO, DOCUMENT)}\n`);
  }

  process.stdout.write(
    `capability ledger: ${ledger.rows.length} rows -- ${ledger.counts.product} product ` +
      `(${ledger.counts.gated} gated), ${ledger.counts.blocked} blocked, ` +
      `${ledger.counts.instrument} instrument, ${ledger.counts.absent} gap; ` +
      `boundary ${ledger.boundary.size} exports\n`,
  );

  if (check) {
    if (existsSync(DOCUMENT)) {
      const onDisk = readFileSync(DOCUMENT, 'utf8');
      if (onDisk !== rendered) {
        failures.push(
          `${path.relative(REPO, DOCUMENT)} is not what the ledger renders: run \`pnpm ledger:write\``,
        );
      }
    } else {
      failures.push(`${path.relative(REPO, DOCUMENT)} does not exist: run \`pnpm ledger:write\``);
    }
  }

  if (strict) {
    for (const { row, resolved } of ledger.rows) {
      if (resolved.state !== 'product') {
        failures.push(`--strict: row ${row.id} (${row.capability}) is ${resolved.state}, not product`);
      }
    }
  }

  if (failures.length === 0) {
    process.stdout.write('the record and the code agree\n');
    return 0;
  }
  process.stderr.write(`\n${failures.length} ledger failure(s):\n`);
  for (const failure of failures) process.stderr.write(`  ${failure}\n`);
  process.stderr.write(
    '\nA ledger failure is a two-line edit toward what the code currently says. If the code is wrong,\n' +
      'change the code; if the row is wrong, change the row; never the other way round.\n',
  );
  return 1;
}

try {
  process.exitCode = main();
} catch (error) {
  if (error instanceof LedgerRefused) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  } else {
    throw error;
  }
}
