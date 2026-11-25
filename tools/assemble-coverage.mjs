#!/usr/bin/env node
/**
 * Every option `CortexMemoryOptions` declares is either forwarded by the composition root, explained,
 * or counted as open work -- and the count of open work may only go down.
 *
 * ## The defect this exists for
 *
 * `assembleMemory` is the only construction path the published package offers. Twice now a field has
 * been found missing from it long after the mechanism behind it was measured: `conflicts` (a reach
 * table a customer could not act on) and `readerByRoute` (the provider contract itself). Both were found
 * by hand, by comparing a registration against a manual, and both were found *late*.
 *
 * A hand audit is not a mechanism. The reason these gaps survive is structural: a field with a default
 * has a value to compare and therefore fails a diff; a field with a **fallback** does not -- the run is
 * complete, valid and silent, and its reading says the mechanism did not help. `readerByRoute` is the
 * pure case: a map that cannot be expressed is six routes on `llm`, which is exactly what every archived
 * artifact was produced with.
 *
 * So the check is mechanical and the vocabulary is closed. A field is one of:
 *
 *   - **forwarded** -- `options.<name>` is read in `assemble.ts`, which is the only way a value reaches
 *     `CortexMemory`;
 *   - **explained** -- deliberately not forwardable, with the reason recorded here;
 *   - **open** -- not yet decided. Counted, capped, and printed on every run.
 *
 * Adding a field to the type without touching this table fails the run, and so does fixing one without
 * moving it out of `OPEN`. That is the point: the count is a ratchet, so the gap can only shrink.
 *
 * ## Usage
 *
 *     node tools/assemble-coverage.mjs              # the check
 *     node tools/assemble-coverage.mjs --self-test  # hermetic: fixtures, no file reads
 *     node tools/assemble-coverage.mjs --json       # machine-readable reading
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TYPES = join(ROOT, 'packages/cortex-memory/src/types.ts');
const ASSEMBLE = join(ROOT, 'packages/cortex-memory/src/assemble.ts');

/**
 * Fields the composition root must not forward, with the reason.
 *
 * `relevanceFor` is the only one: the product ranks with its own `SearchIndex`, and the callback exists
 * for a harness to override that ranking. Forwarding both would let a caller set two rankers and get
 * one of them, with the artifact naming the other -- `AUDIT-PRODUCT-SURFACE.md` §13 records the
 * precedence (`#relevanceFor` reads the override first) and why it must not be reachable from here.
 */
const EXPLAINED = {
  relevanceFor:
    'the product ranks with its own SearchIndex; the callback is the harness escape hatch, and forwarding ' +
    'it beside `index` would let a caller set two rankers while the artifact names one',
};

/**
 * Fields that are neither forwarded nor explained -- the open work, named and capped.
 *
 * Each entry says what the field does and what the decision is waiting on, because "undecided" without a
 * question is just a missing line. Moving a field out of this table means either forwarding it (plus a
 * composition-level test, the way `assemble-conflict-reach.test.ts` and `assemble-reader-by-route.test.ts`
 * do) or writing it into `EXPLAINED` with the reason it must stay out.
 */
const OPEN = {
  widthPlan: 'a per-question budget function -- suspected harness instrument rather than product feature',
  relevanceUnits: 'which unit the relevance signal buys; the product has `session-text` but the root has no field',
  windowRadius: 'the anchor-neighbourhood radius, paired with `relevanceUnits`',
  reviewBareDecline: 'one of the three second-consultation knobs',
  selfConsistency: 'consultations per question and majority reduction',
  windowOrdering: 'the reference pipeline time-window reorder, as two injections',
};

/** The most open entries this check will tolerate. Lower it when one is resolved; never raise it. */
const CEILING = 6;

/** Parse the field names of one `export type <name> = { ... };` block. */
export function typeFields(source, name) {
  const start = source.indexOf(`export type ${name} = {`);
  if (start === -1) return null;
  // Brace counting rather than a regex, so a nested object type inside the block does not truncate it.
  // The first `{` after the name opens the block; the matching `}` at column zero closes it.
  const close = source.indexOf('\n};', start);
  if (close === -1) return null;
  const body = source.slice(start, close);
  return [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((match) => match[1]);
}

/**
 * Classify every declared field, and return the findings a reader needs.
 *
 * Pure over its two sources, so the self-test can drive it without touching the repository.
 */
export function classify(fields, assembleSource, explained, open) {
  const findings = [];
  const forwarded = [];
  for (const field of fields) {
    if (assembleSource.includes(`options.${field}`)) {
      forwarded.push(field);
      continue;
    }
    if (field in explained) continue;
    if (field in open) continue;
    findings.push({
      code: 'unclaimed-field',
      detail:
        `${field} is declared by CortexMemoryOptions and is neither read in assemble.ts nor listed as ` +
        'explained or open -- forward it with a composition-level test, or record why it must stay out',
    });
  }

  for (const field of [...Object.keys(explained), ...Object.keys(open)]) {
    if (!fields.includes(field)) {
      findings.push({
        code: 'stale-entry',
        detail: `${field} is listed here but no longer declared by CortexMemoryOptions`,
      });
      continue;
    }
    if (forwarded.includes(field)) {
      findings.push({
        code: 'stale-entry',
        detail: `${field} is listed as not-forwarded but assemble.ts reads options.${field} -- move it out of the table`,
      });
    }
  }

  const openCount = Object.keys(open).filter((field) => fields.includes(field) && !forwarded.includes(field)).length;
  if (openCount > CEILING) {
    findings.push({
      code: 'ratchet-raised',
      detail: `${openCount} open fields against a ceiling of ${CEILING} -- a field was added without a decision`,
    });
  }

  return { findings, forwarded, openCount };
}

function read(path) {
  return readFileSync(path, 'utf8');
}

function report(reading) {
  const { findings, forwarded, openCount, total } = reading;
  for (const finding of findings) process.stdout.write(`FAIL [${finding.code}] ${finding.detail}\n`);
  process.stdout.write(
    `assemble-coverage: ${total} field(s), ${forwarded.length} forwarded, ` +
      `${Object.keys(EXPLAINED).length} explained, ${openCount}/${CEILING} open\n`,
  );
  if (findings.length === 0) process.stdout.write('ok -- the composition root can express every field, or says why not\n');
  return findings.length === 0 ? 0 : 1;
}

function main() {
  if (process.argv.includes('--self-test')) return selfTest();
  const fields = typeFields(read(TYPES), 'CortexMemoryOptions');
  if (fields === null) {
    process.stdout.write('FAIL [unreadable] CortexMemoryOptions not found in types.ts\n');
    return 1;
  }
  const reading = classify(fields, read(ASSEMBLE), EXPLAINED, OPEN);
  reading.total = fields.length;
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      total: reading.total,
      forwarded: reading.forwarded,
      explained: Object.keys(EXPLAINED),
      open: Object.keys(OPEN),
      openCount: reading.openCount,
      ceiling: CEILING,
      findings: reading.findings,
    }, null, 2)}\n`);
    return reading.findings.length === 0 ? 0 : 1;
  }
  return report(reading);
}

/**
 * Hermetic: four fixtures, each of which must turn **exactly one** rule red.
 *
 * A check that fires for the wrong reason is a failure, not a noisy pass, so the assertion is on the
 * code and the count rather than on "something failed".
 */
function selfTest() {
  const cases = [];
  const assert = (condition, message) => {
    if (!condition) cases.push(message);
  };

  const fields = ['llm', 'now', 'readerByRoute', 'widthPlan', 'relevanceFor'];
  const assemble = 'new CortexMemory({ llm: options.llm, now: options.now, readerByRoute: options.readerByRoute });';
  const explained = { relevanceFor: 'deliberate' };
  const open = { widthPlan: 'undecided' };

  // 1. The baseline passes and counts one open field.
  {
    const reading = classify(fields, assemble, explained, open);
    assert(reading.findings.length === 0, 'baseline must pass');
    assert(reading.openCount === 1, 'baseline must count one open field');
    assert(reading.forwarded.length === 3, 'baseline must count three forwarded fields');
  }

  // 2. A declared field nobody claimed.
  {
    const reading = classify([...fields, 'mystery'], assemble, explained, open);
    assert(reading.findings.length === 1, 'unclaimed field must produce exactly one finding');
    assert(reading.findings[0]?.code === 'unclaimed-field', 'unclaimed field must use its own code');
  }

  // 3. An entry that was resolved but left in the table.
  {
    const reading = classify(fields, assemble, explained, { ...open, readerByRoute: 'now forwarded' });
    assert(reading.findings.length === 1, 'stale entry must produce exactly one finding');
    assert(reading.findings[0]?.code === 'stale-entry', 'stale entry must use its own code');
    assert(reading.findings[0]?.detail.includes('readerByRoute'), 'stale entry must name the field');
  }

  // 4. An entry for a field the type no longer declares. `explained` is emptied here so that the only
  //    orphan is the one this fixture is about: a fixture with two defects proves neither.
  {
    const reading = classify(['llm', 'now', 'readerByRoute'], assemble, {}, open);
    assert(reading.findings.length === 1, 'orphaned entry must produce exactly one finding');
    assert(reading.findings[0]?.code === 'stale-entry', 'orphaned entry must use the stale code');
  }

  // 5. The ratchet: open work above the ceiling.
  {
    const many = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key) => [key, 'undecided']));
    const reading = classify(['llm', 'now', 'readerByRoute', ...Object.keys(many)], assemble, {}, many);
    assert(reading.findings.length === 1, 'ceiling breach must produce exactly one finding');
    assert(reading.findings[0]?.code === 'ratchet-raised', 'ceiling breach must use its own code');
  }

  // 6. The parser itself: a nested object type inside the block must not truncate it.
  {
    const source = 'export type Demo = {\n  a?: number;\n  b?: { inner?: string };\n  c: boolean;\n};\n\nexport type Other = { z: 1 };\n';
    const parsed = typeFields(source, 'Demo');
    assert(parsed?.join(',') === 'a,b,c', 'typeFields must read every field and stop at the block');
    assert(typeFields(source, 'Missing') === null, 'typeFields must return null for an absent type');
  }

  for (const failure of cases) process.stdout.write(`FAIL ${failure}\n`);
  if (cases.length > 0) return 1;
  process.stdout.write(`ok -- assemble-coverage self-test, 6 fixtures, ${cases.length} failure(s)\n`);
  return 0;
}

process.exitCode = main();
