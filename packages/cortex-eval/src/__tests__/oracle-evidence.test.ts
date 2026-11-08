/**
 * Tests for the oracle-evidence condition (`oracle-evidence.ts`) and the switch that arms it
 * (`CORTEX_MEMORY_ORACLE`).
 *
 * ## What these tests are written against
 *
 * A transform that silently does nothing is the failure mode with the worst consequences in this
 * project: the run completes, the artifact names an oracle dataset, and the accuracy is a
 * shipped-retrieval score. Every test below therefore either (a) asserts a property that a
 * do-nothing implementation fails, or (b) asserts a property that an over-eager implementation
 * (one that drops a turn the reader needed) fails. There is no test that only checks the shape of
 * the returned object.
 *
 * The three properties that carry the measurement:
 *
 *  1. **The pool is the gold set, and only the gold set.** A transform that kept the corpus and
 *     added the gold would measure nothing; one that dropped a gold turn would understate the
 *     reader. Both directions are asserted.
 *  2. **Session boundaries survive.** Without them `MR` questions route to the flat path and the
 *     ceiling is measured under a prompt the shipped run never uses -- a different experiment
 *     wearing the same name.
 *  3. **The artifact can see that it ran.** `assertOracleReached` is tested as a rejection, because
 *     a check that only passes is indistinguishable from no check.
 */
import { describe, expect, it } from 'vitest';

import {
  assertOracleReached,
  describeOracleCensus,
  oracleEvidenceDataset,
} from '../oracle-evidence.js';
import { cortextMemoryArmOptions, toMemoryArmConfig } from '../bench-memory-arm.js';
import type { BenchmarkDataset, Question } from '../types.js';

function question(overrides: Partial<Question> = {}): Question {
  return {
    id: 'q-1',
    capability: 'IE',
    question: 'What degree did I graduate with?',
    expected: 'Business Administration',
    context: ['session A turn 1', 'session A turn 2', 'session B turn 1'],
    sessions: [['session A turn 1', 'session A turn 2'], ['session B turn 1']],
    ...overrides,
  };
}

function dataset(questions: readonly Question[]): BenchmarkDataset {
  return { name: 'longmemeval', questions: [...questions] };
}

describe('oracleEvidenceDataset', () => {
  it('replaces the pool with the gold session and keeps its boundary', () => {
    const source = dataset([question({ goldTurns: ['session B turn 1'] })]);

    const { dataset: graded, census } = oracleEvidenceDataset(source);

    expect(graded.questions[0]!.context).toEqual(['session B turn 1']);
    expect(graded.questions[0]!.sessions).toEqual([['session B turn 1']]);
    expect(census).toMatchObject({
      questions: 1,
      sourced: 1,
      unsourced: 0,
      turns: 1,
      chars: 'session B turn 1'.length,
      shippedTurns: 3,
      shippedChars:
        'session A turn 1'.length + 'session A turn 2'.length + 'session B turn 1'.length,
    });
  });

  it('keeps a multi-session pool in two groups, and in the dataset order', () => {
    // The gold names one turn from each session in the REVERSE order of the sessions, which is
    // what a reader that iterated the gold list would produce: `B` first, then `A`. Iterating the
    // sessions is the only order that keeps a date line ahead of the facts it dates.
    const source = dataset([
      question({
        capability: 'MR',
        goldTurns: ['session B turn 1', 'session A turn 1'],
      }),
    ]);

    const { dataset: graded } = oracleEvidenceDataset(source);

    expect(graded.questions[0]!.sessions).toEqual([['session A turn 1'], ['session B turn 1']]);
    // The flat context is derived from the grouped view rather than computed separately, so the
    // two views a router can reach cannot describe different evidence.
    expect(graded.questions[0]!.context).toEqual(['session A turn 1', 'session B turn 1']);
  });

  it('drops a session that contributes no gold turn instead of keeping it empty', () => {
    const source = dataset([question({ goldTurns: ['session A turn 2'] })]);

    const { dataset: graded } = oracleEvidenceDataset(source);

    expect(graded.questions[0]!.sessions).toEqual([['session A turn 2']]);
    expect(graded.questions[0]!.sessions).not.toContainEqual([]);
  });

  it('leaves a question with no gold evidence on the shipped corpus and counts it', () => {
    const source = dataset([
      question({ id: 'q-gold', goldTurns: ['session A turn 1'] }),
      question({ id: 'q-abs', capability: 'ABS', expected: null }),
    ]);

    const { dataset: graded, census } = oracleEvidenceDataset(source);

    // Identity, not equality: the untransformed question is not copied, so a caller holding the
    // shipped dataset cannot observe a rewritten context it never asked for.
    expect(graded.questions[1]).toBe(source.questions[1]);
    expect(census.sourced).toBe(1);
    expect(census.unsourced).toBe(1);
  });

  it('treats an empty gold list as no annotation rather than as an empty pool', () => {
    // `[]` and absent are the same claim in `Question.goldTurns`' own words ("absent says the
    // dataset did not name the evidence"). An empty pool would decline every question and read
    // as a reader that cannot answer, which is a different and much worse statement.
    const source = dataset([question({ goldTurns: [] })]);

    const { dataset: graded, census } = oracleEvidenceDataset(source);

    expect(graded.questions[0]!.context).toEqual(source.questions[0]!.context);
    expect(census.unsourced).toBe(1);
    expect(census.turns).toBe(0);
  });

  it('does not fabricate a session grouping when the dataset carried none', () => {
    // A one-element `sessions` array would route every question to `answerSessions` and change the
    // prompt for a reason the condition never named.
    // Built without the key rather than with `sessions: undefined`, because absence is the
    // property under test and `exactOptionalPropertyTypes` keeps the two distinguishable.
    const bare: Question = {
      id: 'q-bare',
      capability: 'IE',
      question: 'What degree did I graduate with?',
      expected: 'Business Administration',
      context: ['session A turn 1', 'session B turn 1'],
      goldTurns: ['session B turn 1'],
    };
    const source = dataset([bare]);

    const { dataset: graded } = oracleEvidenceDataset(source);

    expect('sessions' in graded.questions[0]!).toBe(false);
    expect(graded.questions[0]!.context).toEqual(['session B turn 1']);
  });

  it('carries every field the router and the record read', () => {
    const source = dataset([
      question({
        id: 'mr-7',
        capability: 'TR',
        questionType: 'knowledge-update',
        questionDate: '2023/05/30 (Tue) 23:40',
        expected: '4',
        goldTurns: ['session A turn 1'],
      }),
    ]);

    const { dataset: graded } = oracleEvidenceDataset(source);
    const out = graded.questions[0]!;

    // A transform that rebuilt the question from `context` and `goldTurns` alone would drop
    // `questionDate` and silently turn every `TR` question into an unanswerable one.
    expect(out).toMatchObject({
      id: 'mr-7',
      capability: 'TR',
      questionType: 'knowledge-update',
      questionDate: '2023/05/30 (Tue) 23:40',
      expected: '4',
      goldTurns: ['session A turn 1'],
    });
  });

  it('produces a pool in which every turn is gold, which is what makes goldOverlap a check', () => {
    const source = dataset([
      question({ capability: 'MR', goldTurns: ['session A turn 1', 'session A turn 2'] }),
    ]);

    const { dataset: graded } = oracleEvidenceDataset(source);
    const out = graded.questions[0]!;

    for (const turn of out.context) {
      expect(out.goldTurns).toContain(turn);
    }
    expect(out.context).toHaveLength(out.goldTurns!.length);
  });

  it('marks the dataset name, so the artifact cannot be filed beside a shipped run', () => {
    const { dataset: graded } = oracleEvidenceDataset(dataset([question({ goldTurns: [] })]));

    // The literal rather than an exported constant: the suffix is the artifact's contract with its
    // reader, so a test that read it from the implementation could not notice it changing.
    expect(graded.name).toBe('longmemeval+oracle');
  });

  it('refuses a second application, whose census would describe neither population', () => {
    const once = oracleEvidenceDataset(dataset([question({ goldTurns: ['session A turn 1'] })]));

    expect(() => oracleEvidenceDataset(once.dataset)).toThrow(/applied twice/);
    expect(() => oracleEvidenceDataset(once.dataset)).toThrow(/\+oracle/);
  });

  it('refuses a gold turn that belongs to no session rather than dropping it', () => {
    // `goldTurns` is derived from the sessions by the same renderer, so this can only be a
    // disagreement between the two -- and a pool that quietly lost the answer turn would
    // understate the reader for a reason no reader of the artifact could see.
    const source = dataset([question({ id: 'broken-3', goldTurns: ['a turn from nowhere'] })]);

    expect(() => oracleEvidenceDataset(source)).toThrow(/broken-3/);
    expect(() => oracleEvidenceDataset(source)).toThrow(/renderer disagreement/);
  });

  it('handles an empty dataset without inventing a population', () => {
    const { dataset: graded, census } = oracleEvidenceDataset(dataset([]));

    expect(graded.questions).toEqual([]);
    expect(census).toEqual({
      questions: 0,
      sourced: 0,
      unsourced: 0,
      turns: 0,
      chars: 0,
      shippedTurns: 0,
      shippedChars: 0,
    });
  });

  it('leaves the dataset it was handed untouched', () => {
    const source = dataset([question({ goldTurns: ['session B turn 1'] })]);
    const before = JSON.parse(JSON.stringify(source)) as BenchmarkDataset;

    oracleEvidenceDataset(source);

    expect(source).toEqual(before);
  });
});

describe('describeOracleCensus', () => {
  it('names both populations, because neither number is interpretable alone', () => {
    const { census } = oracleEvidenceDataset(
      dataset([question({ goldTurns: ['session A turn 1'] })]),
    );

    const line = describeOracleCensus(census);

    expect(line).toContain('1/1 question(s) carry the gold sessions');
    expect(line).toContain(`pool 1 turns / 16 chars against 3 / 48 shipped`);
    expect(line).toContain('3.0x fewer turns');
  });

  it('says how many questions kept their shipped context', () => {
    const { census } = oracleEvidenceDataset(
      dataset([question({ id: 'a', goldTurns: ['session A turn 1'] }), question({ id: 'b' })]),
    );

    expect(describeOracleCensus(census)).toContain('1 keep their shipped context');
  });

  it('refuses to divide by a pool of nothing', () => {
    const { census } = oracleEvidenceDataset(dataset([question()]));

    expect(describeOracleCensus(census)).toContain('n/a');
  });
});

describe('assertOracleReached', () => {
  const census = oracleEvidenceDataset(
    dataset([question({ goldTurns: ['session A turn 1'] })]),
  ).census;

  it('accepts an artifact that carries the suffix and the same population', () => {
    expect(() =>
      assertOracleReached({ dataset: 'longmemeval+oracle', questionCount: 1 }, census),
    ).not.toThrow();
  });

  it('rejects an artifact graded on the shipped corpus', () => {
    // The whole point: a run whose transform never reached the graded dataset publishes a
    // shipped score under a name every reader would file as a ceiling.
    expect(() => assertOracleReached({ dataset: 'longmemeval', questionCount: 1 }, census)).toThrow(
      /not an oracle dataset/,
    );
  });

  it('rejects an artifact whose population differs from the census', () => {
    expect(() =>
      assertOracleReached({ dataset: 'longmemeval+oracle', questionCount: 22 }, census),
    ).toThrow(/different populations/);
  });
});

describe('the CORTEX_MEMORY_ORACLE switch', () => {
  const BASE = { CORTEX_MEMORY: '1' };

  it('is off when the variable is absent, so every earlier run keeps its meaning', () => {
    expect(cortextMemoryArmOptions(BASE).oracleEvidence).toBe(false);
  });

  it("reads '' as off, because an unfilled dispatch input arrives as the empty string", () => {
    expect(cortextMemoryArmOptions({ ...BASE, CORTEX_MEMORY_ORACLE: '' }).oracleEvidence).toBe(
      false,
    );
  });

  it("reads '0' as off and '1' as on", () => {
    expect(cortextMemoryArmOptions({ ...BASE, CORTEX_MEMORY_ORACLE: '0' }).oracleEvidence).toBe(
      false,
    );
    expect(cortextMemoryArmOptions({ ...BASE, CORTEX_MEMORY_ORACLE: '1' }).oracleEvidence).toBe(
      true,
    );
  });

  it('rejects an unrecognised value instead of reading it as off', () => {
    // `readToggle` would answer `false` for `oracle`, which runs the shipped corpus under a
    // dispatch that asked for a ceiling -- the one class of number a later re-reading cannot repair.
    expect(() => cortextMemoryArmOptions({ ...BASE, CORTEX_MEMORY_ORACLE: 'oracle' })).toThrow(
      /CORTEX_MEMORY_ORACLE/,
    );
    expect(() => cortextMemoryArmOptions({ ...BASE, CORTEX_MEMORY_ORACLE: 'TRUE' })).toThrow(
      /must be '1', '0' or unset/,
    );
  });

  it('records the resolved evidence source in the artifact config, never by omission', () => {
    expect(toMemoryArmConfig(cortextMemoryArmOptions(BASE)).evidenceSource).toBe('corpus');
    expect(
      toMemoryArmConfig(cortextMemoryArmOptions({ ...BASE, CORTEX_MEMORY_ORACLE: '1' }))
        .evidenceSource,
    ).toBe('gold-sessions');
  });
});
