/**
 * The temporal module has one question-shape classifier, and it is the live one.
 *
 * ## Why this test exists
 *
 * `src/temporal.ts` shipped two exports — `isTemporalQuestion` and `extractDate` —
 * alongside a module docstring claiming that the helpers let "the system route
 * temporal questions to a dedicated answering path". The routing was built, but not
 * there: `temporal-engine.ts` supplies `classifyTemporalQuestion`, and
 * `natural-language-memory.ts:581` calls it. The older boolean survived as a second,
 * **divergent** answer to the same question, tested, exported from the barrel, and
 * reachable by any consumer.
 *
 * They do not merely differ in fidelity. `isTemporalQuestion` matches a bare `ago`,
 * so it answers `true` for "Which book did I finish a week ago?" — routing an
 * event-lookup question toward date arithmetic, which is the exact error
 * `classifyTemporalQuestion` documents and avoids. The two implementations disagree,
 * and the superseded one is wrong on the case the live one names.
 *
 * ## What this test pins
 *
 * Three properties, all of which were false before the deletion:
 *
 * 1. The superseded classifiers are **not exported** from the module or the barrel.
 * 2. `daysBetween` **is** still exported, because it is not superseded — the live
 *    engine imports it. A per-file reading would have deleted a live dependency.
 * 3. The claim in the module docstring now describes what the module actually does.
 *
 * Property 3 is the one worth explaining. An automated check cannot verify that a
 * comment is accurate — that is the standing lesson of `coverage-annotations.test.ts`
 * and `AUDIT-UNREFERENCED-EXPORTS.md`. What it *can* do is refuse to let the specific
 * false sentence return, so the correction is not silently reverted by a later edit
 * that restores the file from an older revision.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as temporal from '../temporal.js';
import * as barrel from '../index.js';

/** Keys the module actually exports at runtime. */
const moduleExports = Object.keys(temporal).sort();

describe('the temporal module exports exactly the helpers that are live', () => {
  it('no longer exports the classifiers that a live implementation replaced', () => {
    // Deleted, not deprecated: a deprecated alias would keep the divergent answer
    // reachable, which is the cost this change exists to remove.
    expect(moduleExports).not.toContain('isTemporalQuestion');
    expect(moduleExports).not.toContain('extractDate');
  });

  it('still exports `daysBetween`, which the engine imports', () => {
    // The counter-assertion, and the reason the change is not "delete the file".
    // `temporal-engine.ts:16` imports this function; removing it would break the
    // live engine, so a file-level reading of the census would have been wrong in
    // the destructive direction.
    expect(moduleExports).toContain('daysBetween');
    expect(typeof temporal.daysBetween).toBe('function');
    expect(temporal.daysBetween('2023/01/08', '2023/01/15')).toBe(7);
  });

  it('exports nothing beyond the one live helper', () => {
    // Exact rather than a subset check, so a reintroduced classifier fails here and
    // not only in the barrel assertion below.
    expect(moduleExports).toEqual(['daysBetween']);
  });

  it('removes them from the package barrel as well as the module', () => {
    // Two places, and the barrel is the one that makes them reachable. Asserting
    // only the module would pass while the public surface still advertised them.
    const keys = Object.keys(barrel);
    expect(keys).not.toContain('isTemporalQuestion');
    expect(keys).not.toContain('extractDate');
    expect(keys).toContain('daysBetween');
  });

  it('leaves the live classifier as the single answer to the question shape', () => {
    // `classifyTemporalQuestion` is the replacement, and it is reachable from the
    // barrel. Pinning it here means the deletion cannot be read as "this capability
    // was removed" — it was consolidated.
    expect(Object.keys(barrel)).toContain('classifyTemporalQuestion');
    const classify = barrel.classifyTemporalQuestion;
    expect(typeof classify).toBe('function');
    // The disambiguation the boolean could not express, asserted on the live
    // implementation so the reason for the consolidation stays measurable.
    expect(classify('How many weeks ago did I receive the chandelier?')).toBe('relative');
    expect(classify('Which book did I finish a week ago?')).toBe('eventLookup');
    expect(classify('Which event happened first, X or Y?')).toBe('ordering');
  });

  it('announces the routing it actually has, not the one it used to claim', () => {
    // The false sentence was: helpers "extract the turn date, compute elapsed days,
    // and detect the question shape so the system can route temporal questions to a
    // dedicated answering path". The route lives in `temporal-engine.ts`, and this
    // module supplies one arithmetic primitive to it.
    const source = readFileSync(join(__dirname, '..', 'temporal.ts'), 'utf8');
    const doc = source.slice(0, source.indexOf('*/'));
    expect(doc).toContain('temporal-engine');
    expect(doc).not.toMatch(/route temporal questions to a dedicated answering path/);
  });
});
