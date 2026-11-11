/**
 * The per-question record: what an artifact must carry for a verdict to be
 * auditable rather than asserted.
 *
 * Three separate readers need this and none of them can be served by an
 * aggregate:
 *
 *   1. **The B7 criterion** (`tools/read-b7-criterion.mjs`) needs
 *      `questionId / question / groundTruth / answer / turns / grounded`, and it
 *      fails with "no per-question array found" when the artifact lacks them.
 *   2. **Noise quantification** (`compareQuestionVectors`) needs the per-question
 *      correctness VECTOR for two config-identical runs. Without it the function
 *      has no real caller: it takes two `boolean[]` that nothing produces.
 *   3. **A reader asking "which questions moved"** needs the ids. A count is not
 *      a roster, and a delta is not a measurement unless the noise it must clear
 *      has been measured.
 *
 * The ordering the tests below are written in follows the criterion's own
 * ordering, not convenience: identity before counts, because a count cannot
 * contradict anything.
 */
import { describe, it, expect } from 'vitest';
import {
  admittedFromRecord,
  buildQuestionRecords,
  buildRecordsFromDataset,
  correctnessVector,
  recordIds,
  type QuestionRecord,
  goldOverlapOf,
  type QuestionRecordInput,
  type RecordableQuestion,
  type RecordableTrace,
} from '../question-record.js';

/**
 * An input with sane defaults, so each test states only what it is about.
 *
 * The offer is derived from the retrieved context: in a fixture nothing sits between
 * admission and the record, so overriding `retrieved` describes a different question
 * rather than a budget cut. An explicit `admittedTurns` in `overrides` still wins.
 */

/**
 * The size the joined form would have had.
 *
 * `evidenceChars` measures characters, which is the same number on either unit -- the
 * units plus the separators between them. Computed once so a fixture that changes
 * `retrieved` cannot leave `admitted` describing a different context from the record.
 */
function joinedLength(units: readonly string[]): number {
  return units.reduce((total, unit) => total + unit.length, 0) + Math.max(0, units.length - 1);
}
function input(overrides: Partial<QuestionRecordInput> = {}): QuestionRecordInput {
  const retrieved = overrides.retrieved ?? ['the record says 85', 'the note says 240'];
  return {
    questionId: 'q1',
    question: 'which reading did the unit report?',
    capability: 'IE',
    groundTruth: '85',
    answer: '240',
    correct: true,
    grounded: true,
    retrieved,
    admitted: {
      turns: retrieved.filter((unit) => unit.trim().length > 0).length,
      chars: joinedLength(retrieved),
    },
    // `null` rather than a zero object: this fixture names no gold session, and the
    // absent state is what says "not measured" where a zero would say "measured as a
    // miss". Tests about coverage override it.
    goldOverlap: null,
    // No ranking in this fixture, so the room's composition is unmeasurable rather than
    // a window that was entirely unscored.
    windowComposition: null,
    ...overrides,
  };
}

describe('admittedFromRecord reads back exactly what was written', () => {
  it('returns null for a record that reports only half the offer', () => {
    // The two fields are written together or not at all, so a record carrying one of
    // them is not half-measured -- it is a record whose other half is unknown, and a
    // reader that accepted it would put a size beside a count they do not describe.
    // Reachable from any artifact written by an older or a hand-edited producer.
    expect(admittedFromRecord({ evidenceTurns: 5 })).toBeNull();
    expect(admittedFromRecord({ evidenceChars: 20 })).toBeNull();
  });

  it('round-trips a record that reports both', () => {
    const [record] = buildQuestionRecords([input()]);

    expect(admittedFromRecord(record!)).toEqual({
      turns: record!.evidenceTurns,
      chars: record!.evidenceChars,
    });
    // And a record that reported neither reconstructs to neither.
    const [bare] = buildQuestionRecords([input({ admitted: null })]);
    expect(admittedFromRecord(bare!)).toBeNull();
  });
});

describe('buildQuestionRecords preserves one record per question, in order', () => {
  it('emits the same number of records as inputs', () => {
    const records = buildQuestionRecords([
      input({ questionId: 'a' }),
      input({ questionId: 'b' }),
      input({ questionId: 'c' }),
    ]);
    expect(records).toHaveLength(3);
    expect(records.map((r) => r.questionId)).toEqual(['a', 'b', 'c']);
  });

  it('keeps dataset order rather than sorting by id', () => {
    // Order is not cosmetic: `compareQuestionVectors` compares question i of one
    // run against question i of another, so a record set that reordered itself
    // would compare unrelated questions and produce a plausible-looking number
    // from meaningless data -- the exact error `variance.ts` throws to prevent.
    const records = buildQuestionRecords([
      input({ questionId: 'z' }),
      input({ questionId: 'm' }),
      input({ questionId: 'a' }),
    ]);
    expect(records.map((r) => r.questionId)).toEqual(['z', 'm', 'a']);
  });

  it('carries an empty capability through rather than dropping the question', () => {
    // A question with no capability is still a question that was graded. Dropping
    // it would silently shorten the denominator every downstream rate divides by.
    const records = buildQuestionRecords([input({ capability: '' })]);
    expect(records).toHaveLength(1);
    expect(records[0]!.capability).toBe('');
  });
});

describe('buildQuestionRecords keeps the fields the criterion and the noise model need', () => {
  it('carries the id, truth, answer and verdict on every record', () => {
    const records = buildQuestionRecords([
      input({ questionId: 'q1', groundTruth: '85', answer: '240', correct: false }),
    ]);
    const record = records[0]!;
    expect(record.questionId).toBe('q1');
    expect(record.groundTruth).toBe('85');
    expect(record.answer).toBe('240');
    expect(record.correct).toBe(false);
  });

  it('distinguishes an abstention from an absent field', () => {
    // The distinction the whole B7 criterion rests on. `null` means the reader
    // produced no answer; the property being ABSENT means nobody recorded one.
    // Collapsing the second into the first would report a recording gap as a
    // reader behaviour, and a reader that abstains everywhere is a finding.
    const [abstained] = buildQuestionRecords([input({ answer: null })]);
    expect(abstained!.answer).toBeNull();

    // `exactOptionalPropertyTypes` makes this the only way to express an absent
    // optional: a literal `{ answer: undefined }` is a type error, which is the
    // compiler enforcing the same distinction the test asserts.
    const { answer: _omitted, ...withoutAnswer } = input();
    const [unrecorded] = buildQuestionRecords([withoutAnswer]);
    expect(unrecorded!.answer).toBeUndefined();
    expect(unrecorded!.answer).not.toBeNull();
    expect('answer' in unrecorded!).toBe(false);
  });

  it('carries a numeric ground truth without stringifying it', () => {
    // LongMemEval stores some golds as JSON numbers. Coercing to string here
    // would make "85" and 85 indistinguishable downstream, and the side
    // clustering compares content terms, not raw equality -- so the record must
    // hand over what the dataset actually held.
    const [numeric] = buildQuestionRecords([input({ groundTruth: 85 })]);
    expect(numeric!.groundTruth).toBe(85);
    expect(typeof numeric!.groundTruth).toBe('number');
  });

  it('omits the gold entirely when the caller recorded none', () => {
    // The gap the roster's own honesty rests on. `null` is a gold of "the reader
    // should have abstained" and must be PRESENT; a caller that recorded no gold
    // at all must produce a record with NO `groundTruth` key, so the criterion
    // can tell "this question's gold is abstention" from "nobody wrote the gold
    // down". Destructuring is the only way to express the absence under
    // `exactOptionalPropertyTypes`.
    const { groundTruth: _omitted, ...withoutGold } = input();
    const [record] = buildQuestionRecords([withoutGold]);
    expect('groundTruth' in record!).toBe(false);
    expect(record!.groundTruth).toBeUndefined();
  });

  it('keeps a null gold present rather than omitting the field', () => {
    // `expected: null` is the dataset's "the reader should have abstained" gold,
    // and it must be PRESENT as null rather than absent. The criterion has a
    // branch for a null gold and none for a missing one, so collapsing the two
    // would file a real gold as a recording gap.
    const [record] = buildQuestionRecords([input({ groundTruth: null })]);
    expect(record!.groundTruth).toBeNull();
    expect('groundTruth' in record!).toBe(true);
  });

  it('splits the retrieved context into ordered turns, not one blob', () => {
    // `computeTargetCohort` clusters over `turns`, and a single blob would put
    // every candidate in one turn so no two clusters could ever be formed. The
    // criterion would then report every question `unseparable` and look like an
    // instrument limitation rather than a transcription bug in this function.
    const [record] = buildQuestionRecords([
      input({ retrieved: ['first line', 'second line', 'third line'] }),
    ]);
    expect(record!.turns).toEqual([
      { index: 0, text: 'first line' },
      { index: 1, text: 'second line' },
      { index: 2, text: 'third line' },
    ]);
  });

  it('drops blank lines rather than emitting empty turns', () => {
    // A blank turn carries no terms, so it can never be clustered and only
    // inflates the index space a reader has to walk.
    const [record] = buildQuestionRecords([input({ retrieved: ['alpha', '', '', 'beta', ''] })]);
    expect(record!.turns).toEqual([
      { index: 0, text: 'alpha' },
      { index: 1, text: 'beta' },
    ]);
  });

  it('emits no turns when nothing was retrieved', () => {
    const [record] = buildQuestionRecords([input({ retrieved: [] })]);
    expect(record!.turns).toEqual([]);
  });
});

describe('buildQuestionRecords records the configuration each record was produced under', () => {
  it('stamps every record with the same config object', () => {
    // Stamped per record rather than stated once beside the array. A reader that
    // receives one record out of the array -- which is what a diff or a filtered
    // subset gives them -- must still be able to see which switch produced it.
    const records = buildQuestionRecords([input({ questionId: 'a' }), input({ questionId: 'b' })], {
      retrievalSides: true,
      candidateDiscrimination: true,
    });
    expect(records[0]!.featureConfig).toEqual({
      retrievalSides: true,
      candidateDiscrimination: true,
    });
    expect(records[1]!.featureConfig).toEqual(records[0]!.featureConfig);
  });

  it('omits the field entirely when no config is supplied', () => {
    // Fabricating an "everything off" object would be a claim about a run nobody
    // recorded, and it reads as evidence -- worse than an absent field.
    const [record] = buildQuestionRecords([input()]);
    expect(record!.featureConfig).toBeUndefined();
    expect('featureConfig' in record!).toBe(false);
  });

  it('records switches that are OFF, not only the ones that are ON', () => {
    // A record listing only enabled features cannot distinguish "this switch was
    // off" from "this run predates the switch", and those are different claims
    // about the same file.
    const [record] = buildQuestionRecords([input()], { retrievalSides: false });
    expect(record!.featureConfig).toEqual({ retrievalSides: false });
  });
});

describe('buildQuestionRecords throws rather than producing a misaligned artefact', () => {
  it('throws when the correctness vector disagrees with the record count', () => {
    // The failure mode this prevents: a record array and a correctness vector
    // that are off by one align everything after the gap against the wrong
    // question, and `compareQuestionVectors` would happily compare two runs on
    // that basis. Reported at construction, where the cause is still visible.
    expect(() =>
      buildQuestionRecords([input({ questionId: 'a' }), input({ questionId: 'b' })], undefined, [
        true,
      ]),
    ).toThrow(/correctness vector/);
  });

  it('accepts a correctness vector that matches, and overrides the per-input verdict', () => {
    // The vector is the authority when supplied, because it is what the scorer
    // actually returned; the per-input `correct` is the caller's summary of it.
    const records = buildQuestionRecords(
      [input({ questionId: 'a', correct: true }), input({ questionId: 'b', correct: true })],
      undefined,
      [true, false],
    );
    expect(records.map((r) => r.correct)).toEqual([true, false]);
  });

  it('throws when two records share an id', () => {
    // Ids are the join key for every comparison this artefact feeds. A duplicate
    // makes a map from id to record silently keep one and drop the other, so a
    // moved question would read as stable.
    expect(() =>
      buildQuestionRecords([input({ questionId: 'dup' }), input({ questionId: 'dup' })]),
    ).toThrow(/duplicate/i);
  });
});

describe('a QuestionRecord is what the B7 cohort reader needs', () => {
  it('satisfies the CohortQuestion contract field by field', () => {
    // Not a type assertion: this is the runtime shape check. The reader in
    // `tools/read-b7-criterion.mjs` transcribes `questionId / question /
    // groundTruth / answer / turns / grounded` and passes them to
    // `computeTargetCohort`, so a record missing any of them yields a vacuous
    // verdict rather than an error.
    //
    // `evidenceTurns` and `evidenceChars` are in the list for the reason §13.12
    // registers: they are what §13.11.3's two predictions are read from, and a
    // reader holding a reduced report needs them present on every record to tell
    // "shown nothing" from "shown less than measured".
    const [record]: QuestionRecord[] = buildQuestionRecords([
      input({ retrieved: ['the record says 85', 'the note says 240'] }),
    ]);
    expect(Object.keys(record!).sort()).toEqual(
      [
        'answer',
        'capability',
        'correct',
        'evidenceChars',
        'evidenceTurns',
        'groundTruth',
        'grounded',
        'question',
        'questionId',
        'turns',
      ].sort(),
    );
    expect(record!.grounded).toBe(true);
  });
});

function question(overrides: Partial<RecordableQuestion> = {}): RecordableQuestion {
  return {
    id: 'q1',
    question: 'which reading?',
    capability: 'IE',
    expected: '85',
    ...overrides,
  };
}

function trace(overrides: Partial<RecordableTrace> = {}): RecordableTrace {
  // The spread is load-bearing and was missing in the first draft of this file:
  // without it every override was silently discarded, six tests "passed" their
  // setup and failed their assertion, and the failures pointed at the
  // implementation rather than at this helper. A builder that accepts overrides
  // and ignores them turns every test using it into a test of the defaults.
  return {
    question: 'which reading?',
    retrieved: 'record says 85\nnote says 240',
    answer: '240',
    ...overrides,
  };
}

describe('buildRecordsFromDataset joins traces to questions', () => {
  it('matches a trace to its question by text', () => {
    const records = buildRecordsFromDataset(
      [question({ id: 'q1', question: 'first?', expected: '1' })],
      [trace({ question: 'first?', answer: '2', retrieved: 'a\nb' })],
      [false],
      () => true,
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.answer).toBe('2');
    expect(records[0]!.turns).toHaveLength(2);
    expect(records[0]!.groundTruth).toBe('1');
  });

  it('distinguishes a missing trace from an abstention', () => {
    // The distinction the criterion's `no-move` branch rests on. No trace means
    // nobody recorded what the reader did -- a gap in the artefact. `null` means
    // the reader abstained -- a behaviour. Defaulting the gap to `null` would
    // report the artefact's own shortcoming as a finding about the reader.
    const [record] = buildRecordsFromDataset(
      [question({ id: 'untraced' })],
      [],
      [false],
      () => false,
    );
    expect('answer' in record!).toBe(false);
    expect(record!.answer).toBeUndefined();
  });

  it('records an explicit abstention as null rather than as absence', () => {
    const [record] = buildRecordsFromDataset(
      [question({ id: 'abstained' })],
      [trace({ answer: null })],
      [false],
      () => true,
    );
    expect(record!.answer).toBeNull();
    expect('answer' in record!).toBe(true);
  });

  it('treats an undefined trace answer as an abstention when the trace exists', () => {
    // A trace that exists but carries no `answer` is an abstention, not a gap:
    // the reader ran and produced nothing to score. The trace object is the
    // evidence that it ran at all.
    const [record] = buildRecordsFromDataset(
      [question({ id: 'ran-but-empty' })],
      [trace({ answer: undefined })],
      [false],
      () => true,
    );
    expect(record!.answer).toBeNull();
  });

  it('takes the LAST trace for a question, since that is the scored answer', () => {
    // The abstention retry re-queries, so one question can emit two traces and
    // only the second describes the answer the scorer saw. Taking the first
    // would file a record whose answer never appears in the metrics. The
    // trajectory is the real one: the shipped configuration armed the retry on
    // `80ec1f4f_abs`.
    const [record] = buildRecordsFromDataset(
      [question({ id: 'retried' })],
      [
        trace({ question: 'which reading?', answer: 'first attempt' }),
        trace({ question: 'which reading?', answer: 'retry won' }),
      ],
      [true],
      () => true,
    );
    expect(record!.answer).toBe('retry won');
  });

  it('leaves `retrieved` empty when the trace carries none', () => {
    const [record] = buildRecordsFromDataset(
      [question({ id: 'no-context' })],
      [trace({ retrieved: undefined })],
      [false],
      () => true,
    );
    expect(record!.turns).toEqual([]);
  });

  it('passes the question and its trace to the groundedness predicate', () => {
    // Groundedness is the classifier's property, not this module's. Passing both
    // lets the caller use the retrieved context and the raw LLM output; a
    // predicate given only the question could not.
    const seen: Array<{
      id: string;
      answer: string | number | null | undefined;
      raw: string | undefined;
    }> = [];
    buildRecordsFromDataset(
      [question({ id: 'g1' })],
      [{ ...trace(), llmRaw: 'raw text' }],
      [true],
      ({ question: q, trace: t }) => {
        seen.push({ id: q.id, answer: t?.answer, raw: t?.llmRaw });
        return t !== undefined;
      },
    );
    expect(seen).toEqual([{ id: 'g1', answer: '240', raw: 'raw text' }]);
  });

  it('passes an undefined trace to the predicate for an untraced question', () => {
    // Not `{}` and not a fabricated trace: the predicate has to be able to tell
    // "no record" from "a record with empty fields", because it is the thing that
    // decides whether the question enters the B7 cohort at all.
    let received: RecordableTrace | undefined = trace();
    buildRecordsFromDataset([question({ id: 'untraced' })], [], [false], ({ trace: t }) => {
      received = t;
      return false;
    });
    expect(received).toBeUndefined();
  });

  it('stamps the config onto every record it builds', () => {
    const records = buildRecordsFromDataset(
      [question({ id: 'a' }), question({ id: 'b', question: 'second?' })],
      [],
      [true, false],
      () => false,
      { retrievalSides: true },
    );
    expect(records[0]!.featureConfig).toEqual({ retrievalSides: true });
    expect(records[1]!.featureConfig).toEqual({ retrievalSides: true });
  });

  it('throws when the correctness vector does not match the question count', () => {
    expect(() =>
      buildRecordsFromDataset([question(), question({ id: 'q2' })], [], [true], () => false),
    ).toThrow(/correctness vector length 1 is not 2/);
  });

  it('keeps dataset order even when traces arrive in another order', () => {
    // The vector comparison depends on this: `compareQuestionVectors` compares
    // index i of one run to index i of another, so a record set ordered by trace
    // arrival would compare unrelated questions across two runs.
    const records = buildRecordsFromDataset(
      [question({ id: 'z', question: 'last?' }), question({ id: 'a', question: 'first?' })],
      [trace({ question: 'first?', answer: 'A' }), trace({ question: 'last?', answer: 'Z' })],
      [true, true],
      () => false,
    );
    expect(records.map((r) => r.questionId)).toEqual(['z', 'a']);
    expect(records[0]!.answer).toBe('Z');
  });
});

describe('the derived vectors stay aligned with the records they came from', () => {
  it('derives the correctness vector in record order', () => {
    const records = buildQuestionRecords(
      [input({ questionId: 'a' }), input({ questionId: 'b' }), input({ questionId: 'c' })],
      undefined,
      [true, false, true],
    );
    expect(correctnessVector(records)).toEqual([true, false, true]);
  });

  it('derives the id list in record order', () => {
    const records = buildQuestionRecords([input({ questionId: 'z' }), input({ questionId: 'a' })]);
    expect(recordIds(records)).toEqual(['z', 'a']);
  });

  it('yields empty vectors for an empty record set', () => {
    // Zero, not NaN and not a throw: an arm that graded nothing produces two
    // empty vectors, and `compareQuestionVectors` already handles the empty case
    // by reporting `changedRate: 0` rather than dividing by zero.
    expect(correctnessVector([])).toEqual([]);
    expect(recordIds([])).toEqual([]);
  });

  it('keeps the two vectors the same length as each other', () => {
    // The invariant `compareQuestionVectors` throws on. Asserting it here means a
    // future change to one derivation that forgets the other fails at the source.
    const records = buildQuestionRecords([
      input({ questionId: 'a' }),
      input({ questionId: 'b' }),
      input({ questionId: 'c' }),
    ]);
    expect(recordIds(records)).toHaveLength(correctnessVector(records).length);
  });
});

describe('goldOverlapOf', () => {
  const A = '[2023/01/01 (Sun) 00:00] user: I bought a bike';
  const B = '[2023/01/02 (Mon) 00:00] assistant: Two of them, actually';

  it('counts the gold turns the carried context contains', () => {
    expect(goldOverlapOf([A, B], [A])).toEqual({
      carried: 1,
      total: 1,
      goldDelivered: [true],
      goldTurns: [A],
    });
    expect(goldOverlapOf([A, B], [A, B])).toEqual({
      carried: 2,
      total: 2,
      goldDelivered: [true, true],
      goldTurns: [A, B],
    });
    expect(goldOverlapOf([A, B], ['[2023/03/03 (Fri) 00:00] user: nothing here'])).toEqual({
      carried: 0,
      total: 1,
      goldDelivered: [false],
      goldTurns: ['[2023/03/03 (Fri) 00:00] user: nothing here'],
    });
  });

  it('is a membership test, so a gold that is a prefix of another turn does not count', () => {
    // The defect this pins is the one §13.18.2 was refuted by, one layer in. A bare
    // substring search would report the longer turn as covering the shorter gold, and
    // the reported coverage would then depend on which way round the two were written.
    //
    // Since §13.16.6 the predicate is membership in the carried **units**, so the wrong
    // answer is not reachable rather than merely avoided: there is no haystack to search
    // and therefore no prefix relationship for a search to get wrong.
    const short = '[2023/01/01 (Sun) 00:00] user: I went';
    const long = '[2023/01/01 (Sun) 00:00] user: I went to Lisbon';
    expect(goldOverlapOf([long], [short])).toEqual({
      carried: 0,
      total: 1,
      goldDelivered: [false],
      goldTurns: [short],
    });
    expect(goldOverlapOf([short], [long])).toEqual({
      carried: 0,
      total: 1,
      goldDelivered: [false],
      goldTurns: [long],
    });
    expect(goldOverlapOf([short, long], [short, long])).toEqual({
      carried: 2,
      total: 2,
      goldDelivered: [true, true],
      goldTurns: [short, long],
    });
  });

  it('does not mistake a list marker for a cardinality', () => {
    // §13.18.2's exact counterexample, kept as a regression: a reader testing the gold
    // `3` against this context by substring got `true`, which is how a coverage figure
    // was produced from list markers. The predicate here is equality with a carried unit,
    // so `3` alone matches nothing.
    const unit = '3. **Humidity:** Peace lilies prefer a humid environment';
    expect(goldOverlapOf([unit], ['3'])).toEqual({
      carried: 0,
      total: 1,
      goldDelivered: [false],
      goldTurns: ['3'],
    });
  });

  it('handles a gold turn whose content spans lines', () => {
    // The case the old padded-substring form needed its padding to handle, and the case
    // a line-unit reader could not handle at all: one unit may contain newlines, and it
    // is one unit either way.
    const multi = '[2023/01/01 (Sun) 00:00] user: one\ntwo';
    expect(goldOverlapOf(['x', multi, 'y'], [multi])).toEqual({
      carried: 1,
      total: 1,
      goldDelivered: [true],
      goldTurns: [multi],
    });
    // And the same gold is NOT covered when the units are the lines it spans -- which is
    // why the memory arm's capture reports turns and not lines.
    expect(goldOverlapOf(['x', 'one', 'two', 'y'], [multi])).toEqual({
      carried: 0,
      total: 1,
      goldDelivered: [false],
      goldTurns: [multi],
    });
  });

  it('counts the gold turns a ranking offered, which is what separates ranking from budget', () => {
    // Three numbers, three different failures, and only their difference is readable:
    //   total - pool      the ranking never surfaced the gold turn at all
    //   pool - carried    the ranking had it and the budget did not buy it
    //   carried           it reached the reader
    // §13.61.7 records that the campaign has been unable to distinguish the first two for
    // six runs, and that every candidate pool level tried -- `k = 64`, `k = 256` -- was
    // measured without them.
    expect(goldOverlapOf([A], [A, B], [A, B, 'something else'])).toEqual({
      carried: 1,
      total: 2,
      goldDelivered: [true, false],
      pool: 2,
      goldRanks: [0, 1],
      goldTurns: [A, B],
    });
    // In the pool's reach and cut by the budget: the row the campaign has never had.
    expect(goldOverlapOf([A], [A, B], [A, 'something else'])).toEqual({
      carried: 1,
      total: 2,
      goldDelivered: [true, false],
      pool: 1,
      goldRanks: [0, -1],
      goldTurns: [A, B],
    });
    // Outside the pool entirely -- a ranking failure, not a budget one. `pool: 0` is a
    // measurement and must be present, not omitted.
    expect(goldOverlapOf([A], [A, B], ['something else'])).toEqual({
      carried: 1,
      total: 2,
      goldDelivered: [true, false],
      pool: 0,
      goldRanks: [-1, -1],
      goldTurns: [A, B],
    });
  });

  it('records where each gold turn sits in the ranking, which is what a curve needs', () => {
    // The ordered pool is the one argument that produces both facts: `pool` is its
    // intersection size and `goldRanks` is the position of each gold in it. `-1` is outside
    // the pool, so the array is the same length as `total` and a reader can sum it into any
    // cut point without a second field per cut.
    expect(goldOverlapOf([], [A, B], [A, 'x', B])).toEqual({
      carried: 0,
      total: 2,
      goldDelivered: [false, false],
      pool: 2,
      goldRanks: [0, 2],
      goldTurns: [A, B],
    });
    expect(goldOverlapOf([], [A, B], ['x'])).toEqual({
      carried: 0,
      total: 2,
      goldDelivered: [false, false],
      pool: 0,
      goldRanks: [-1, -1],
      goldTurns: [A, B],
    });
  });

  it('keeps the delivery flags and the count they summarise in agreement', () => {
    // §13.253's two facts, as a property rather than as a claim about one run: a delivered gold
    // may sit beyond `turns` (the window is not a prefix of the ranking) and an undelivered one may
    // carry `-1` (never scored). So neither `carried` nor `goldRanks` alone can say *which* gold is
    // missing -- only these flags can -- and the count must be the flags' own sum or the two
    // columns are two measurements of one thing.
    const cases: readonly (readonly string[])[] = [[], [A], [A, B], ['x']];
    for (const retrieved of cases) {
      for (const pool of [undefined, [], [A], [A, 'x', B]]) {
        const overlap = goldOverlapOf(retrieved, [A, B], pool);
        expect(overlap).not.toBeNull();
        expect(overlap!.goldDelivered).toHaveLength(overlap!.total);
        expect(overlap!.goldDelivered!.filter(Boolean)).toHaveLength(overlap!.carried);
        if (pool !== undefined) expect(overlap!.goldRanks).toHaveLength(overlap!.total);
        // And the flags are the same predicate `carried` was counted from, not a second one.
        const delivered = [A, B].map((gold) => retrieved.includes(gold));
        expect(overlap!.goldDelivered).toEqual(delivered);
      }
    }
  });

  it('omits the pool when no ranking was consulted', () => {
    // `relevanceSignal: none` runs an arrival-order prefix and has no pool, and a `0`
    // there would read as "the ranking surfaced nothing" -- a measured miss where the
    // truth is that nothing was measured. Absent, never zero, for the reason the null
    // case below states.
    const overlap = goldOverlapOf([A, B], [A]);
    expect(overlap).toEqual({ carried: 1, total: 1, goldDelivered: [true], goldTurns: [A] });
    expect(overlap === null ? true : 'pool' in overlap).toBe(false);
  });

  it('keeps carried <= pool <= total whenever the delivery came from the pool', () => {
    // The identity the three numbers have to satisfy for the two subtractions to mean
    // anything. It is asserted over **consistent** inputs -- every delivered turn is one
    // of the candidates -- because that is the only case a real run produces: the budget
    // selects from the pool, so a delivery outside it is a caller defect, not a datum.
    const pools: readonly (readonly string[])[] = [[], [A], [B], [A, B], ['x']];
    for (const pool of pools) {
      const deliveries: readonly (readonly string[])[] = [
        [],
        ...pool.map((turn) => [turn] as const),
        pool,
      ];
      for (const retrieved of deliveries) {
        const overlap = goldOverlapOf(retrieved, [A, B], pool);
        expect(overlap).not.toBeNull();
        expect(overlap!.carried).toBeLessThanOrEqual(overlap!.pool!);
        expect(overlap!.pool!).toBeLessThanOrEqual(overlap!.total);
      }
    }
  });

  it('does not clamp a delivery that did not come from the pool', () => {
    // A function that clamped here would turn a caller defect into a plausible number,
    // which is the one failure mode this package refuses everywhere else: the impossible
    // row is visible (`carried` above `pool`) and a reader can act on it, while a clamped
    // row reads as a ranking that surfaced two gold turns when it surfaced none.
    const overlap = goldOverlapOf([A, B], [A, B], []);
    expect(overlap).toEqual({
      carried: 2,
      total: 2,
      goldDelivered: [true, true],
      goldTurns: [A, B],
      pool: 0,
      goldRanks: [-1, -1],
    });
  });

  it('carries the text of a gold turn that was not delivered', () => {
    // The whole reason the field exists (§13.267.5). `turns` holds what the reader was shown, so a
    // gold turn the budget cut leaves with the budget and its text is then nowhere on the artifact.
    // The restore counterfactual cannot reinstate what it cannot quote, and this is the assertion
    // that keeps the text on the record.
    const undelivered = '[2023/04/04 (Tue) 00:00] user: I finally sold the piano for 400';
    const overlap = goldOverlapOf([A], [A, undelivered]);
    expect(overlap!.goldDelivered).toEqual([true, false]);
    expect(overlap!.goldTurns).toEqual([A, undelivered]);
    // In `total` order, which is the order `goldRanks` and `goldDelivered` already share -- three
    // parallel arrays over one list, so index `i` means the same gold turn in all of them.
    expect(overlap!.goldTurns).toHaveLength(overlap!.total);
  });

  it('reports nothing to measure as null rather than as a zero', () => {
    // `{carried: 0, total: 0}` would render "no annotation" as a measured miss, which
    // is the collapse §13.11.2 forbids. Both spellings of "nothing" -- an absent field
    // from the loader and an empty list from a hand-built fixture -- collapse to null.
    expect(goldOverlapOf(['anything'], undefined)).toBeNull();
    expect(goldOverlapOf(['anything'], [])).toBeNull();
  });
});

describe('the record carries the coverage it was given, or omits it', () => {
  it('writes the measured overlap', () => {
    const [record] = buildQuestionRecords([
      input({
        retrieved: ['the record says 85', 'the note says 240'],
        goldOverlap: { carried: 2, total: 3 },
      }),
    ]);
    expect(record!.goldOverlap).toEqual({ carried: 2, total: 3 });
  });

  it('omits it rather than writing a zero when nothing was measured', () => {
    // Two states a reader must be able to tell apart: "the gold turn was missed" and
    // "nobody could measure". `Object.hasOwn` rather than `=== undefined`, because the
    // point is that the KEY is absent and survives a JSON round trip as an absence.
    const [record] = buildQuestionRecords([input({ goldOverlap: null })]);
    expect(Object.hasOwn(record!, 'goldOverlap')).toBe(false);
    expect(JSON.parse(JSON.stringify(record))).not.toHaveProperty('goldOverlap');
  });
});

describe('the record carries the room to the same contract the gold follows', () => {
  it('writes the measured composition', () => {
    const [record] = buildQuestionRecords([
      input({
        retrieved: ['the record says 85', 'the note says 240'],
        windowComposition: { turns: 2, offered: 1, offeredChars: 19, unscoredChars: 17 },
      }),
    ]);
    expect(record!.windowComposition).toEqual({
      turns: 2,
      offered: 1,
      offeredChars: 19,
      unscoredChars: 17,
    });
  });

  it('omits it rather than writing zeroes when no ranking was consulted', () => {
    // The collapse this guards is the one `relevanceSignal: none` would otherwise render:
    // a composition of `offered: 0` over a full `unscoredChars` is the shape of a ranking
    // that failed, and it is also the exact shape of a run where no ranking existed. The
    // key's absence is what tells them apart, which is why this asserts on the key and on
    // the JSON rather than on the value.
    const [record] = buildQuestionRecords([input({ windowComposition: null })]);
    expect(Object.hasOwn(record!, 'windowComposition')).toBe(false);
    expect(JSON.parse(JSON.stringify(record))).not.toHaveProperty('windowComposition');
  });

  it('keeps a measured zero-turn window as an object', () => {
    // A question declined with no evidence was measured, and its window is empty. That is
    // a fact about the run, not an absence of measurement, so it must survive as an object
    // while `null` above does not survive at all.
    const zero = { turns: 0, offered: 0, offeredChars: 0, unscoredChars: 0 };
    const [record] = buildQuestionRecords([input({ retrieved: [], windowComposition: zero })]);
    expect(record!.windowComposition).toEqual(zero);
    expect(JSON.parse(JSON.stringify(record))).toHaveProperty('windowComposition');
  });
});

describe('the census triples the roster carries', () => {
  /**
   * A pair with one half missing is a delta taken against the wrong object.
   *
   * The product increments `attempted` on every consultation and the second number on every outcome, so the two
   * come from one object or the read was against another. The record still has to be constructible from such
   * an input -- it is a seatbelt, not a parser -- and the value it writes is `0`, which is the only reading
   * available: the consultation happened and produced no second number.
   *
   * The three blocks are exercised together because they are the same rule written three times, and a test per
   * pair would let one of them drift into an `undefined` that JSON drops.
   */
  it('fills the missing half of a pair with zero, and writes no pair at all when there is none', () => {
    const [record] = buildQuestionRecords([
      input({
        recoveryConsultations: 2,
        auditConsultations: 3,
        supersessionConsultations: 4,
      }),
    ]);

    expect(record!.recoveryConsultations).toBe(2);
    expect(record!.recoveryAnswers).toBe(0);
    expect(record!.auditConsultations).toBe(3);
    expect(record!.auditChanges).toBe(0);
    expect(record!.supersessionConsultations).toBe(4);
    expect(record!.supersessionReplacements).toBe(0);
  });

  it('carries the supersession pair through to the JSON when both halves are measured', () => {
    const [record] = buildQuestionRecords([
      input({ supersessionConsultations: 1, supersessionReplacements: 1 }),
    ]);

    expect(JSON.parse(JSON.stringify(record))).toMatchObject({
      supersessionConsultations: 1,
      supersessionReplacements: 1,
    });
  });

  it('omits the pair entirely when the pass did not run', () => {
    // Absence is not zero here, for the reason the audit pair's absence is not: a question the pass never
    // reached and a question it reached and found nothing on are two different facts about the run.
    const [record] = buildQuestionRecords([input({})]);
    expect(Object.hasOwn(record!, 'supersessionConsultations')).toBe(false);
    expect(Object.hasOwn(record!, 'supersessionReplacements')).toBe(false);
  });
});
