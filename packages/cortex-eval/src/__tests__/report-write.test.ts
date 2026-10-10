/**
 * Writing a report must not be able to destroy a measurement.
 *
 * ## The incident
 *
 * Run `38003036421` graded all four runs of all five hundred questions -- roughly
 * forty minutes of work -- and then died on the last line of the happy path:
 *
 *     RangeError: Invalid string length
 *         at JSON.stringify
 *         at main (.../bench/run-ablation.ts:273)
 *
 * The Markdown had already been written; the JSON had not. The artifact that
 * survived held a stack trace and a document, and the measurement -- which was
 * complete and in memory -- was gone. A reader could not tell "measured and
 * un-writable" from "never measured".
 *
 * This is `§13.11.7`'s shape one step later. There, the run died *during* the
 * measurement and the failure path persisted the cheapest thing (an embedding
 * cache) while discarding the only thing being measured. Here the run died
 * *after* the measurement, and the writer had no path that survives it.
 *
 * ## What these tests pin
 *
 * `§13.12.7` states the rule: the JSON writer must not be able to destroy a
 * measurement. If serialization would exceed the runtime's limit, the writer
 * emits a reduced report **plus a manifest naming exactly what was reduced**, so
 * the run always ends with an artifact. These tests use a real injected
 * serializer -- not a mock of `JSON.stringify` -- because the thing being tested
 * is the writer's own decision, not the runtime's behaviour.
 */

import { describe, expect, it } from 'vitest';
import { serializeReportOrReduce } from '../report-write.js';
import type { AblationReport } from '../report.js';
import { buildQuestionRecords } from '../question-record.js';

/**
 * The writer's dependency type, derived from the writer itself.
 *
 * `ReportWriterDeps` is deliberately not exported -- the export census counts an
 * export only when something outside the tests uses it, and this type is used
 * only here. Deriving it from the function signature keeps the test typed
 * without adding an export nothing consumes.
 */
type ReportWriterDeps = Parameters<typeof serializeReportOrReduce>[1];

/** A minimal report whose records carry a stated amount of evidence. */
function reportWithEvidence(turnsPerQuestion: number, questions: number): AblationReport {
  const retrieved = Array.from({ length: turnsPerQuestion }, (_, i) => `turn ${i}`).join('\n');
  const records = buildQuestionRecords(
    Array.from({ length: questions }, (_, i) => ({
      questionId: `q${i}`,
      question: `question ${i}`,
      capability: 'IE',
      groundTruth: 'a fact',
      answer: 'a fact',
      correct: true,
      grounded: false,
      retrieved,
    })),
    // The cohort-level configuration, passed as the builder's second parameter
    // exactly as the arm passes it. It is here so a reduction that drops it is
    // visible: with the parameter absent, "dropped" and "never had it" would
    // serialize the same way and the test could not tell them apart.
    { cortexMemory: true },
  );
  return {
    dataset: 'longmemeval',
    questionCount: questions,
    baseline: { name: 'reference-pipeline', metrics: {} as never },
    feature: { name: 'cortex-memory', metrics: {} as never },
    ablation: {} as never,
    generatedAt: '2026-10-10T00:00:00.000Z',
    questions: records,
  };
}

/** Real serializers, so no test depends on a mock of the runtime. */
const deps: ReportWriterDeps = {
  serialize: (value) => JSON.stringify(value, null, 2),
};

describe('serializeReportOrReduce', () => {
  it('returns the full JSON when serialization succeeds', () => {
    const report = reportWithEvidence(3, 2);

    const result = serializeReportOrReduce(report, deps, { maxTurnsPerRecord: 8 });

    expect(result.reduced).toBe(false);
    expect(result.manifest).toBeNull();
    expect(JSON.parse(result.json)).toMatchObject({ dataset: 'longmemeval', questionCount: 2 });
  });

  it('does not lose the measurement when serialization throws', () => {
    const report = reportWithEvidence(3, 2);
    const exploding: ReportWriterDeps = {
      serialize: (value) => {
        // Throw only for the full report, so the reduced attempt succeeds -- which
        // is exactly the real shape: the full report is too big and the reduced
        // one is not.
        const text = JSON.stringify(value);
        if (text.includes('"turn 2"')) throw new RangeError('Invalid string length');
        return text;
      },
    };

    const result = serializeReportOrReduce(report, exploding, { maxTurnsPerRecord: 1 });

    expect(result.reduced).toBe(true);
    // The report is still parseable -- the measurement is not gone.
    const parsed = JSON.parse(result.json) as AblationReport;
    expect(parsed.questionCount).toBe(2);
    expect(parsed.questions).toHaveLength(2);
  });

  it('names what was reduced and by how much', () => {
    const report = reportWithEvidence(5, 2);
    const exploding: ReportWriterDeps = {
      serialize: (value) => {
        const text = JSON.stringify(value);
        if (text.includes('"turn 4"')) throw new RangeError('Invalid string length');
        return text;
      },
    };

    const result = serializeReportOrReduce(report, exploding, { maxTurnsPerRecord: 2 });

    expect(result.manifest).not.toBeNull();
    expect(result.manifest!.reason).toContain('Invalid string length');
    expect(result.manifest!.reducedQuestionIds).toEqual(['q0', 'q1']);
    expect(result.manifest!.turnsMeasured).toBe(10);
    expect(result.manifest!.turnsCarried).toBeLessThan(10);
  });

  it('reports the bound it applied in the manifest', () => {
    const report = reportWithEvidence(5, 1);
    const exploding: ReportWriterDeps = {
      serialize: (value) => {
        const text = JSON.stringify(value);
        if (text.includes('"turn 4"')) throw new RangeError('Invalid string length');
        return text;
      },
    };

    const result = serializeReportOrReduce(report, exploding, { maxTurnsPerRecord: 2 });

    expect(result.manifest!.maxTurnsPerRecord).toBe(2);
  });

  it('states the original size so a reader can see the scale of the loss', () => {
    const report = reportWithEvidence(5, 1);
    const exploding: ReportWriterDeps = {
      serialize: (value) => {
        const text = JSON.stringify(value);
        if (text.includes('"turn 4"')) throw new RangeError('Invalid string length');
        return text;
      },
    };

    const result = serializeReportOrReduce(report, exploding, { maxTurnsPerRecord: 2 });

    expect(result.manifest!.charsMeasured).toBeGreaterThan(0);
    expect(result.manifest!.charsMeasured).toBe(
      report.questions![0]!.evidenceChars * report.questions!.length,
    );
  });

  it('rethrows when the reduced report also cannot be serialized', () => {
    // A serializer that always throws means no reduction can help, and pretending
    // otherwise would produce an empty artifact that reads as an empty run.
    const report = reportWithEvidence(5, 1);
    const always: ReportWriterDeps = {
      serialize: () => {
        throw new RangeError('Invalid string length');
      },
    };

    expect(() => serializeReportOrReduce(report, always, { maxTurnsPerRecord: 1 })).toThrow(
      /Invalid string length/,
    );
  });

  it('propagates a non-serialization error rather than reducing for it', () => {
    // A circular structure is a bug in the report, not a size problem, and
    // reducing the evidence would hide it behind a smaller artifact.
    const report = reportWithEvidence(3, 1);
    const circular: ReportWriterDeps = {
      serialize: () => {
        throw new TypeError('Converting circular structure to JSON');
      },
    };

    expect(() => serializeReportOrReduce(report, circular, { maxTurnsPerRecord: 1 })).toThrow(
      /circular/,
    );
  });

  it('omits absent optional fields rather than writing them as undefined', () => {
    // The bound rebuilds each record through `buildQuestionRecords`, and every
    // optional field it forwards is conditional. The reason is not style: an
    // explicit `undefined` would put `"answer": undefined` in the JSON key set
    // and make the reduced report differ from the full one in *which fields
    // exist*, so a reader diffing the two would see missing fields and read them
    // as dropped measurements rather than as fields the run never had.
    //
    // The record below carries the optionals as present-but-`undefined` keys,
    // which is what a report deserialized from a writer that did put them there
    // would look like -- the exact upstream defect this arm of the conditional
    // exists to absorb rather than propagate.
    const base = reportWithEvidence(5, 1);
    const withUndefinedKeys = {
      ...base,
      questions: [
        {
          ...base.questions![0]!,
          groundTruth: undefined,
          answer: undefined,
          rawOutput: '',
        },
      ],
    } as unknown as AblationReport;

    const exploding: ReportWriterDeps = {
      serialize: (value) => {
        const text = JSON.stringify(value);
        if (text.includes('"turn 4"')) throw new RangeError('Invalid string length');
        return text;
      },
    };

    const result = serializeReportOrReduce(withUndefinedKeys, exploding, { maxTurnsPerRecord: 2 });
    const reduced = (JSON.parse(result.json) as AblationReport).questions![0]!;

    // The keys must not survive the rebuild: absent means absent, not `undefined`.
    expect(Object.hasOwn(reduced, 'groundTruth')).toBe(false);
    expect(Object.hasOwn(reduced, 'answer')).toBe(false);
    // An empty string is a value the run had, not a missing field, so it is
    // carried through -- the conditional tests for `undefined`, not falsiness,
    // and a `||` here would silently drop a record whose raw output was empty.
    expect(Object.hasOwn(reduced, 'rawOutput')).toBe(true);
    expect(reduced.rawOutput).toBe('');
    // `featureConfig` is NOT a per-record input: it is the second parameter of
    // `buildQuestionRecords`, shared by the whole cohort. A reducer that forwards
    // it per record loses it silently -- the value goes in and no record comes
    // out carrying it -- so the reduction would drop a field the run did have.
    expect(Object.hasOwn(reduced, 'featureConfig')).toBe(true);
    expect(reduced.featureConfig).toEqual({ cortexMemory: true });
    // And every field the run did have survives the rebuild.
    expect(reduced.turns).toHaveLength(3);
    expect(reduced.evidenceTurns).toBe(5);
    expect(reduced.evidenceChars).toBe(base.questions![0]!.evidenceChars);
    expect(result.manifest!.maxTurnsPerRecord).toBe(2);
  });

  it('names a cross-realm failure in the report-defect message', () => {
    // The path that reaches `message` with a non-`Error`: the "bound did not
    // engage" branch, which calls `describeFailure(firstError)` -- and
    // `firstError` is a cross-realm `RangeError`, matched by shape rather than
    // by prototype. The message must quote its `message` field and not the
    // useless `[object Object]` that coercing it would produce.
    const crossRealm = {
      name: 'RangeError',
      message: 'Invalid string length',
    };
    const report = reportWithEvidence(1, 2);
    let call = 0;
    const staged: ReportWriterDeps = {
      serialize: () => {
        call += 1;
        // Full attempt fails with the cross-realm size error; the reduced
        // attempt succeeds, but the bound never engaged (one turn per record
        // against a bound of one), so this is the defect branch.
        if (call === 1) throw crossRealm;
        return JSON.stringify({ anything: true });
      },
    };

    expect(() => serializeReportOrReduce(report, staged, { maxTurnsPerRecord: 1 })).toThrow(
      /Underlying failure: Invalid string length/,
    );
  });

  it('says a thrown value was unreadable instead of dressing it as readable', () => {
    // The last arm of `message`: a value that is neither an `Error` nor an object
    // with a string `message`. Coercing it would put `[object Object]` -- or a
    // bare `42` -- where the artifact's `reason` is, text that names no cause but
    // reads as though it does. The fixed sentence says what is actually known.
    //
    // The route is the defect branch: the failure is accepted as a size failure
    // (so reduction starts), the tightened attempt succeeds, and the bound did
    // not engage -- so `describeFailure` is handed the original value. The value
    // is a number, which carries no text at all.
    const report = reportWithEvidence(1, 2);
    let call = 0;
    const staged: ReportWriterDeps = {
      serialize: () => {
        call += 1;
        // A `RangeError` for the full attempt (a real size failure), then a
        // number for the tightened one -- rethrown untouched by `attempt`? No:
        // a number fails `isSizeFailure` and is rethrown, which skips the defect
        // branch. So the number is the FIRST failure and `attempt` rejects it.
        if (call === 1) throw 42;
        return JSON.stringify({ anything: true });
      },
    };

    // Rejected as a size failure, so it propagates untouched. Nothing reaches
    // `message`, and that is the point: the writer must not describe a value it
    // could not classify.
    let caught: unknown;
    try {
      serializeReportOrReduce(report, staged, { maxTurnsPerRecord: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(42);
  });

  it('describes a message-bearing but non-Error failure through the defect branch', () => {
    // The cross-realm shape, reached on the "bound did not engage" path: the
    // first failure is size-shaped (so reduction starts), the tightened attempt
    // succeeds, and no turn was dropped. `describeFailure` then receives the
    // plain object, and `message` must read its `message` field rather than
    // coercing it to `[object Object]`.
    const crossRealmSizeFailure = { name: 'RangeError', message: 'Invalid string length' };
    const report = reportWithEvidence(1, 2);
    let call = 0;
    const staged: ReportWriterDeps = {
      serialize: () => {
        call += 1;
        if (call === 1) throw crossRealmSizeFailure;
        return JSON.stringify({ anything: true });
      },
    };

    expect(() => serializeReportOrReduce(report, staged, { maxTurnsPerRecord: 1 })).toThrow(
      /Underlying failure: Invalid string length/,
    );
  });

  it('states a report defect rather than an empty run when the bound cannot change the outcome', () => {
    // The case: the full report fails to serialize, but bounding the evidence
    // does not change the text at all -- so a reduced attempt succeeds only
    // because the serializer is inconsistent, and the "reduction" that would be
    // reported describes nothing.
    //
    // Concretely: every record here carries one turn, which is already at or
    // below the requested bound, so `evidenceReductionOf` returns null. The
    // writer must refuse rather than publish a manifest claiming a reduction it
    // did not perform -- a manifest naming zero dropped turns would read as "the
    // run was small", which is the one thing it was not.
    const report = reportWithEvidence(1, 2);
    let call = 0;
    const inconsistent: ReportWriterDeps = {
      serialize: () => {
        call += 1;
        // The first (full) attempt is refused for size; the second is not.
        if (call === 1) throw new RangeError('Invalid string length');
        return JSON.stringify({ anything: true });
      },
    };

    expect(() => serializeReportOrReduce(report, inconsistent, { maxTurnsPerRecord: 1 })).toThrow(
      /report defect, not a run property/,
    );
  });

  it('reduces for a cross-realm RangeError that is not this realm’s RangeError', () => {
    // `instanceof RangeError` is realm-bound, and a serializer that runs in a
    // worker, a `vm` context or a second copy of the runtime throws a
    // `RangeError` whose prototype chain does not include this realm's. Testing
    // only `instanceof` would report "not a size failure" for the one failure
    // this module exists to absorb, and the run would die exactly as
    // `38003036421` did -- with the measurement complete and unwritable.
    //
    // The value below claims `RangeError` by name and message and satisfies no
    // `instanceof`, which is what a cross-realm error looks like from here. It
    // is a plain object, so `String()` reads `[object Object]` rather than the
    // message -- which is why `isSizeFailure` matches on the `message` field.
    const crossRealm = {
      name: 'RangeError',
      message: 'Invalid string length',
    };
    expect(crossRealm instanceof RangeError).toBe(false);

    const report = reportWithEvidence(5, 1);
    const exploding: ReportWriterDeps = {
      serialize: (value) => {
        const text = JSON.stringify(value);
        if (text.includes('"turn 4"')) throw crossRealm;
        return text;
      },
    };

    const result = serializeReportOrReduce(report, exploding, { maxTurnsPerRecord: 2 });

    expect(result.reduced).toBe(true);
    // The reason is quoted from the cross-realm error's own message.
    expect(result.manifest!.reason).toContain('Invalid string length');
  });

  it('does not treat a RangeError-shaped object without a message as a size failure', () => {
    // The shape test is strict for a reason: `{ name: 'RangeError' }` alone is
    // not an error the runtime raised, and treating it as one would let an
    // arbitrary object trigger a reduction that hides whatever really went
    // wrong. The writer must rethrow the value itself, untouched.
    const impostor = { name: 'RangeError' };
    const report = reportWithEvidence(3, 1);
    const thrower = {
      serialize: () => {
        throw impostor;
      },
    } as unknown as ReportWriterDeps;

    // Identity, not a message match: the rethrow must preserve the value, so a
    // caller can inspect it. A wrapped `Error` here would replace the cause.
    let caught: unknown;
    try {
      serializeReportOrReduce(report, thrower, { maxTurnsPerRecord: 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(impostor);
  });

  it('falls back to coercion for an object whose message is not a string', () => {
    // The `typeof candidate === 'string'` guard has to reject a non-string
    // `message`, or an object like `{ message: 42 }` would put a number where the
    // manifest's `reason` is declared to be text. It then coerces the object as a
    // whole, which is the honest reading of "this throwing thing has no message".
    const numericMessage = {
      name: 'RangeError',
      message: 42,
    };
    const report = reportWithEvidence(3, 1);
    let call = 0;
    const thrower: ReportWriterDeps = {
      serialize: () => {
        call += 1;
        // First call is refused as a size failure; the tightened call throws the
        // oddly-shaped object, which `attempt` rethrows untouched.
        if (call === 1) throw new RangeError('Invalid string length');
        throw numericMessage;
      },
    };

    let caught: unknown;
    try {
      serializeReportOrReduce(report, thrower, { maxTurnsPerRecord: 2 });
    } catch (error) {
      caught = error;
    }
    // Untouched, because `isRangeErrorShaped` requires a string `message`.
    expect(caught).toBe(numericMessage);
  });

  it('reports an unreadable thrown value rather than crashing inside the handler', () => {
    // `String()` is not total: a null-prototype object throws when coerced. That
    // throw would land inside the code handling a failure and replace one
    // diagnosis with another, so `message` falls back to a literal.
    const unreadable = Object.create(null) as object;
    const report = reportWithEvidence(3, 1);
    const thrower = {
      serialize: () => {
        throw unreadable;
      },
    } as unknown as ReportWriterDeps;

    let caught: unknown;
    try {
      serializeReportOrReduce(report, thrower, { maxTurnsPerRecord: 1 });
    } catch (error) {
      caught = error;
    }
    // The value is rethrown untouched, so the unreadable text never reaches
    // `message` on this path -- and the important part is that no coercion
    // crash occurred.
    expect(caught).toBe(unreadable);
  });

  it('reports reduced=false when the report has no questions to reduce', () => {
    const report: AblationReport = {
      dataset: 'longmemeval',
      questionCount: 0,
      baseline: { name: 'reference-pipeline', metrics: {} as never },
      feature: { name: 'cortex-memory', metrics: {} as never },
      ablation: {} as never,
      generatedAt: '2026-10-10T00:00:00.000Z',
    };
    const exploding: ReportWriterDeps = {
      serialize: () => {
        throw new RangeError('Invalid string length');
      },
    };

    // Nothing to reduce, and a throw here is honest: there is no measurement.
    expect(() => serializeReportOrReduce(report, exploding, { maxTurnsPerRecord: 1 })).toThrow();
  });

  it('handles a report whose questions key is absent at all', () => {
    // `questionCount: 0` and a missing `questions` key are different artifacts
    // and both are legal: a run that recorded no cohort omits the field rather
    // than writing an empty array. The reducer must therefore treat "no key" as
    // "nothing to reduce" instead of reading `undefined.length`, so the
    // `?? []` arm is behaviour and not defensive noise.
    const report = {
      ...reportWithEvidence(3, 1),
      questionCount: 0,
      questions: undefined,
    } as unknown as AblationReport;
    const exploding: ReportWriterDeps = {
      serialize: () => {
        throw new RangeError('Invalid string length');
      },
    };

    // No cohort means no reduction is possible, so the honest outcome is a
    // throw: there is no measurement to publish at any bound.
    expect(() => serializeReportOrReduce(report, exploding, { maxTurnsPerRecord: 2 })).toThrow(
      /no artifact to write/,
    );
  });

  it('describes a non-Error failure by its string form rather than as undefined', () => {
    // `isSizeFailure` only accepts a `RangeError`, so a thrown non-Error never
    // reaches the manifest by that route. It reaches `message` through
    // `describeFailure` on the "no bound fits" path, and there the message must
    // carry the value: `String(error)` is what makes a thrown string readable in
    // the log instead of `undefined`.
    const report = reportWithEvidence(3, 1);
    const thrower = {
      serialize: () => {
        throw 'boom: a thrown string, not an Error';
      },
    } as unknown as ReportWriterDeps;

    expect(() => serializeReportOrReduce(report, thrower, { maxTurnsPerRecord: 1 })).toThrow(
      /boom: a thrown string, not an Error/,
    );
  });

  it('records a non-Error failure in the manifest by its string form', () => {
    // The `String(error)` arm: a value that is not an `Error` reaching `message`
    // through the *manifest* route, not through `describeFailure`.
    //
    // The route matters. `attempt` rethrows a non-`RangeError` untouched, so
    // nothing reaches `message` that way. What does reach it is the bound loop's
    // tail: when tightening ends, `describeFailure` is handed whatever the LAST
    // attempt failed with. Staging the failures -- `RangeError` first (so the
    // reduction starts), then a bare string on every tightened bound -- puts the
    // string in `lastError`, and the thrown message must quote it.
    const report = reportWithEvidence(5, 1);
    let call = 0;
    const staged: ReportWriterDeps = {
      serialize: () => {
        call += 1;
        if (call === 1) throw new RangeError('Invalid string length');
        throw 'second failure is not an Error';
      },
    };

    expect(() => serializeReportOrReduce(report, staged, { maxTurnsPerRecord: 2 })).toThrow(
      /second failure is not an Error/,
    );
  });

  it('rejects a bound below one for the same reason the builder does', () => {
    const report = reportWithEvidence(3, 1);
    expect(() => serializeReportOrReduce(report, deps, { maxTurnsPerRecord: 0 })).toThrow(
      /maxTurnsPerRecord/,
    );
  });

  it('keeps every non-evidence field intact through a reduction', () => {
    const report = reportWithEvidence(5, 2);
    const exploding: ReportWriterDeps = {
      serialize: (value) => {
        const text = JSON.stringify(value);
        if (text.includes('"turn 4"')) throw new RangeError('Invalid string length');
        return text;
      },
    };

    const result = serializeReportOrReduce(report, exploding, { maxTurnsPerRecord: 2 });
    const parsed = JSON.parse(result.json) as AblationReport;

    expect(parsed.dataset).toBe(report.dataset);
    expect(parsed.generatedAt).toBe(report.generatedAt);
    expect(parsed.questions!.map((q) => q.questionId)).toEqual(['q0', 'q1']);
    // The measurement survives: every record still says how much it was shown.
    expect(parsed.questions!.map((q) => q.evidenceTurns)).toEqual([5, 5]);
  });

  it('bounds the ablation evidence vector too, or the reduction cannot make room', () => {
    // ## The defect this pins
    //
    // A report carries the evidence twice: `questions[].turns` and the ablation's
    // own `featureRetrievedContexts`. A reducer that bounds only the first cannot
    // make the artifact fit, because the second copy is still whole -- which is
    // exactly the state run `38044858147` published: 258 MB, of which 256 MB was
    // the untruncated ablation vector while every record was already down to
    // seventeen turns.
    //
    // The serializer below refuses any text still containing the last turn, so
    // the writer can only succeed if BOTH copies were bounded. Before the fix the
    // loop tightened to the floor and threw, because bounding `questions` never
    // removed the turn from the vector.
    const retrieved = Array.from({ length: 5 }, (_, i) => `turn ${i}`).join('\n');
    const report = {
      ...reportWithEvidence(5, 2),
      ablation: { featureRetrievedContexts: [retrieved, retrieved] },
    } as unknown as AblationReport;
    const exploding: ReportWriterDeps = {
      serialize: (value) => {
        const text = JSON.stringify(value);
        if (text.includes('turn 4')) throw new RangeError('Invalid string length');
        return text;
      },
    };

    const result = serializeReportOrReduce(report, exploding, { maxTurnsPerRecord: 2 });

    expect(result.reduced).toBe(true);
    const parsed = JSON.parse(result.json) as {
      ablation: { featureRetrievedContexts: (string | null)[] };
    };
    // Both copies bounded: the dropped turn is gone from the vector as well.
    for (const text of parsed.ablation.featureRetrievedContexts) {
      expect(text).not.toContain('turn 4');
    }
  });

  it('leaves the ablation vector alone when the report carries none', () => {
    // `featureRetrievedContexts` is optional on `AblationResult`. A report that
    // never captured it must reduce without inventing the field, or the artifact
    // would claim a measurement the run did not make.
    const report = reportWithEvidence(5, 1);
    const exploding: ReportWriterDeps = {
      serialize: (value) => {
        const text = JSON.stringify(value);
        if (text.includes('"turn 4"')) throw new RangeError('Invalid string length');
        return text;
      },
    };

    const result = serializeReportOrReduce(report, exploding, { maxTurnsPerRecord: 2 });

    expect(result.reduced).toBe(true);
    const parsed = JSON.parse(result.json) as { ablation: Record<string, unknown> };
    expect('featureRetrievedContexts' in parsed.ablation).toBe(false);
  });
});
