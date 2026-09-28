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
  buildQuestionRecords,
  buildRecordsFromDataset,
  correctnessVector,
  recordIds,
  type QuestionRecord,
  type QuestionRecordInput,
  type RecordableQuestion,
  type RecordableTrace,
} from '../question-record.js';

function input(overrides: Partial<QuestionRecordInput> = {}): QuestionRecordInput {
  return {
    questionId: 'q1',
    question: 'which reading did the unit report?',
    capability: 'IE',
    groundTruth: '85',
    answer: '240',
    correct: true,
    grounded: true,
    retrieved: 'the record says 85\nthe note says 240',
    ...overrides,
  };
}

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
      input({ retrieved: 'first line\nsecond line\nthird line' }),
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
    const [record] = buildQuestionRecords([input({ retrieved: 'alpha\n\n\nbeta\n' })]);
    expect(record!.turns).toEqual([
      { index: 0, text: 'alpha' },
      { index: 1, text: 'beta' },
    ]);
  });

  it('emits no turns when nothing was retrieved', () => {
    const [record] = buildQuestionRecords([input({ retrieved: '' })]);
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
    const [record]: QuestionRecord[] = buildQuestionRecords([
      input({ retrieved: 'the record says 85\nthe note says 240' }),
    ]);
    expect(Object.keys(record!).sort()).toEqual(
      [
        'answer',
        'capability',
        'correct',
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
