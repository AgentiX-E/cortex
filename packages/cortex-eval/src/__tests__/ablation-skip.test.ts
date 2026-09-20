import { describe, expect, it } from 'vitest';
import {
  ABLATION_SKIP_FILENAME,
  buildAblationSkipRecord,
  parseMissingCohortMembers,
  serializeAblationSkips,
} from '../ablation-skip.js';

/**
 * The guard message these tests parse against is copied verbatim from the throw
 * in `runner.ts`'s `runQueryExpansionDecompositionAblation`. It is duplicated
 * here on purpose: if the guard's wording changes, `parseMissingCohortMembers`
 * silently starts returning `[]` and every skip record loses its missing ids.
 * A literal fixture makes that a failing test rather than a quiet data loss.
 */
const GUARD_MESSAGE =
  'conjunction ablation cohort is incomplete: 1/7 present, missing 6456829e_abs, edced276_abs, ' +
  'e5ba910e_abs, gpt4_70e84552_abs, gpt4_c27434e8_abs, gpt4_fe651585_abs. P2/P3 are ' +
  'pre-registered against these exact questions, so scoring the present subset would report ' +
  'a different experiment under the same name. Raise LIMIT until the cohort is covered (200 ' +
  'covers all 7 on LongMemEval-S), or pass requireCohortCoverage: false to run deliberately ' +
  'under-covered with the shortfall recorded.';

describe('parseMissingCohortMembers', () => {
  it('extracts every missing id from the guard message', () => {
    expect(parseMissingCohortMembers(GUARD_MESSAGE)).toEqual([
      '6456829e_abs',
      'edced276_abs',
      'e5ba910e_abs',
      'gpt4_70e84552_abs',
      'gpt4_c27434e8_abs',
      'gpt4_fe651585_abs',
    ]);
  });

  it('stops at the sentence end rather than swallowing the prose after it', () => {
    // The guard continues with three more sentences. A greedy match would pull
    // "P2/P3 are pre-registered..." in as cohort members, producing a record
    // that names questions that do not exist.
    const parsed = parseMissingCohortMembers(GUARD_MESSAGE);
    expect(parsed).not.toContain(
      'P2/P3 are pre-registered against these exact questions, so scoring the present subset would report a different experiment under the same name',
    );
    expect(parsed.every((id) => id.endsWith('_abs'))).toBe(true);
  });

  it('handles a single missing member', () => {
    expect(
      parseMissingCohortMembers('cohort is incomplete: 6/7 present, missing 80ec1f4f_abs. Done.'),
    ).toEqual(['80ec1f4f_abs']);
  });

  it('tolerates no space after a comma', () => {
    expect(
      parseMissingCohortMembers('cohort is incomplete: 5/7 present, missing a_abs,b_abs. Done.'),
    ).toEqual(['a_abs', 'b_abs']);
  });

  it('returns [] for a message that is not a coverage shortfall', () => {
    expect(parseMissingCohortMembers('LLM request failed: ETIMEDOUT')).toEqual([]);
  });

  it('does not match a bare occurrence of the word missing mid-sentence', () => {
    // Anchored on the guard's wording: a provider error that happens to contain
    // "missing" must not be mis-parsed into a cohort shortfall, because a skip
    // record naming invented questions is worse than one naming none.
    expect(parseMissingCohortMembers('the response is missing content.')).toEqual([]);
  });

  it('returns [] when the missing list is empty', () => {
    expect(parseMissingCohortMembers('cohort is incomplete: 7/7 present, missing . Done.')).toEqual(
      [],
    );
  });

  it('returns [] when the missing list is only whitespace and separators', () => {
    // Reaches `match[1] ?? ''` with a non-empty match, so the fallback is
    // exercised by behaviour rather than asserted as dead code: `[^.]*` is
    // greedy over whitespace, so a malformed-but-matching message takes this
    // path and the `?? ''` is load-bearing for it.
    expect(
      parseMissingCohortMembers('cohort is incomplete: 7/7 present, missing  ,  . Done.'),
    ).toEqual([]);
  });

  it('requires the terminating period so truncated messages do not over-capture', () => {
    expect(
      parseMissingCohortMembers(
        'cohort is incomplete: 5/7 present, missing a_abs, b_abs and then the process died',
      ),
    ).toEqual([]);
  });
});

describe('buildAblationSkipRecord', () => {
  it('carries the arm name, the unmodified reason, the ids and the denominator', () => {
    const record = buildAblationSkipRecord('conjunction', new Error(GUARD_MESSAGE), 7);
    expect(record.ablation).toBe('conjunction');
    expect(record.reason).toBe(GUARD_MESSAGE);
    expect(record.required).toBe(7);
    expect(record.missing).toHaveLength(6);
  });

  it('stringifies a non-Error throwable instead of dropping it', () => {
    // A guard that throws a string, or a provider library that rejects with a
    // plain object, must still produce a readable reason: an empty reason would
    // make the skip record useless for exactly the failures it exists to
    // explain.
    expect(buildAblationSkipRecord('conjunction', 'plain string refusal', 7).reason).toBe(
      'plain string refusal',
    );
    expect(buildAblationSkipRecord('conjunction', { code: 429 }, 7).reason).toBe('[object Object]');
  });

  it('records a zero denominator for an arm that declares no cohort', () => {
    const record = buildAblationSkipRecord('other', new Error('boom'), 0);
    expect(record.required).toBe(0);
    expect(record.missing).toEqual([]);
  });

  it('keeps the denominator the caller supplied, not the shortfall length', () => {
    // A fully-missing cohort and a partially-missing one must stay
    // distinguishable: inferring the denominator from `missing` would collapse
    // "6 of 7 lost" and "6 of 6 lost" into the same record.
    expect(buildAblationSkipRecord('conjunction', new Error(GUARD_MESSAGE), 6).required).toBe(6);
  });
});

describe('serializeAblationSkips', () => {
  it('emits a JSON array with a trailing newline', () => {
    const out = serializeAblationSkips([
      buildAblationSkipRecord('conjunction', new Error(GUARD_MESSAGE), 7),
    ]);
    expect(out.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(out) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it('emits an empty array rather than an empty file', () => {
    // The shape must be stable across runs: a consumer reads the key
    // unconditionally, so "nothing was skipped" cannot be represented as an
    // absent or unparseable file.
    expect(serializeAblationSkips([])).toBe('[]\n');
  });

  it('round-trips every field', () => {
    const record = buildAblationSkipRecord('conjunction', new Error(GUARD_MESSAGE), 7);
    const parsed = JSON.parse(serializeAblationSkips([record])) as (typeof record)[];
    expect(parsed[0]).toEqual(record);
  });
});

describe('ABLATION_SKIP_FILENAME', () => {
  it('sits inside the workflow artifact glob', () => {
    // The workflow uploads `benchmark-*.json`; a filename outside that pattern
    // would make the skip record unrecoverable from the artifact alone, which is
    // the entire point of writing it.
    expect(ABLATION_SKIP_FILENAME).toMatch(/^benchmark-.*\.json$/);
  });
});
