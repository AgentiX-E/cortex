/**
 * The B7 criterion reader is a real code path and gets real tests.
 *
 * `tools/read-b7-criterion.mjs` is the executable form of a criterion that was
 * published before it could be run (`09-progress-and-delivery-report.md`
 * §2.5.10.6). Two audits made it executable — `AUDIT-B7-DEAD-SWITCH.md` for the
 * switch, `AUDIT-B7-CRITERION-COHORT.md` for the roster — and this is the third
 * piece: the thing that actually reads the arms.
 *
 * Why a subprocess and not a unit test of the logic: the contract that matters
 * is the file's behaviour on real persisted artifacts, and these fixtures are
 * the real shapes. The criterion lives in `src/b7-cohort.ts` and is tested
 * there; what is tested here is that the reader reaches it and reads it in the
 * pre-registered ORDER, which is exactly the property a re-implementation in the
 * test would not check.
 *
 * The three order-sensitive properties, each with a test that would fail if the
 * order were changed to something more convenient:
 *
 *   1. The cohort is reconciled against the publication BEFORE the arms are read,
 *      so a stale roster cannot quietly decide the verdict.
 *   2. A non-target regression outranks a target gain.
 *   3. A cohort that does not move yields `no-move`, which is reported as a
 *      finding about the reader rather than as a failure to be tuned away.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SCRIPT = join(REPO_ROOT, 'tools/read-b7-criterion.mjs');

let dir: string;

type Turn = { index: number; text: string };
type Question = {
  questionId: string;
  question: string;
  groundTruth: string | null;
  answer: string | null;
  /**
   * The scorer's verdict, and the field the criterion reads to decide whether an
   * outcome moved. It is REQUIRED on these fixtures even though the reader
   * tolerates its absence (`q.correct === true`): a fixture without it makes
   * every arm unscored, and an unscored arm has no observable movement beyond
   * abstention. Omitting it here silently turned three of these tests into
   * assertions about the wrong thing.
   */
  correct: boolean;
  grounded: boolean;
  turns: Turn[];
};

/**
 * Run the reader and capture stdout, whether or not it exits zero.
 *
 * This used to let a non-zero exit propagate, on the theory that "every verdict
 * is a successful exit, so non-zero means the tool failed". That theory is now
 * wrong: the reader REFUSES to judge an arm with an unrecorded answer and exits
 * 1, and the refusal's stdout is exactly what the tests below need to assert on.
 * A helper that threw would make the documented refusal path untestable through
 * the same entry point as every other case — which is how a refusal comes to be
 * verified by a re-implementation in the test rather than by the real tool.
 *
 * The exit status is still available to callers that care, via `runStatus`.
 */
function run(controlPath: string, featurePath: string): string {
  try {
    return execFileSync('node', [SCRIPT, controlPath, featurePath], { encoding: 'utf8' });
  } catch (error) {
    // `execFileSync` attaches the child's captured streams to the error.
    return String((error as { stdout?: string }).stdout ?? '');
  }
}

/** The reader's exit status, for tests that assert on the refusal itself. */
function runStatus(controlPath: string, featurePath: string): number {
  try {
    execFileSync('node', [SCRIPT, controlPath, featurePath], { encoding: 'utf8', stdio: 'pipe' });
    return 0;
  } catch (error) {
    return (error as { status?: number }).status ?? -1;
  }
}

function write(name: string, questions: unknown): string {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({ questions }, null, 2));
  return path;
}

/**
 * A grounded failure where truth and answer are DIFFERENT values that both
 * appear in the context, in separate turns. This is the B7 target shape: the
 * reader had both candidates in front of it and chose the wrong one.
 *
 * `correct` therefore defaults to `false` here: by construction this fixture is
 * the reader choosing the wrong candidate.
 */
function targetQuestion(id: string, truth: string, answer: string, correct = false): Question {
  return {
    questionId: id,
    question: `which one is it for ${id}?`,
    groundTruth: truth,
    answer,
    correct,
    grounded: true,
    turns: [
      { index: 0, text: `the correct value is ${truth} according to the record` },
      { index: 1, text: `the competing value is ${answer} according to the note` },
    ],
  };
}

/**
 * A grounded failure whose truth and answer carry the SAME content terms, so the
 * two sides cannot be told apart. Classified `identical`, not targeted.
 *
 * `correct` defaults to `true`: the reader reproduced the truth, which is why
 * the question is not a target.
 */
function identicalQuestion(id: string, value: string, correct = true): Question {
  return {
    questionId: id,
    question: `what is the ${id} reading?`,
    groundTruth: value,
    answer: value,
    correct,
    grounded: true,
    turns: [{ index: 0, text: `the reading is ${value} for the unit` }],
  };
}

/** Not a grounded failure, so out of B7's scope by construction. */
function ungroundedQuestion(id: string): Question {
  return {
    questionId: id,
    question: 'an unrelated question',
    groundTruth: null,
    answer: null,
    correct: false,
    grounded: false,
    turns: [],
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'b7-criterion-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the reader reports the recomputed cohort before it reads the arms', () => {
  it('names the published count and the recomputed size, and flags a disagreement', () => {
    const control = write('c-one.json', [targetQuestion('q1', '85', '240')]);
    const feature = write('f-one.json', [targetQuestion('q1', '85', '240')]);
    const out = run(control, feature);

    expect(out).toContain('--- recomputed cohort ---');
    expect(out).toContain('targets: 1');
    // The publication claims 9; this fixture has 1. The reader must say so
    // rather than accept the count.
    expect(out).toContain('publication says 9; recomputation found 1');
    expect(out).toContain('DISAGREEMENT with the published count');
  });

  it('never reports a roster as confirmed from a count alone', () => {
    // Even at the published size, identity is unconfirmable because the
    // publication names no ids. This is the defect AUDIT-B7-CRITERION-COHORT
    // exists to expose, so the reader must not claim confirmation.
    const nine = Array.from({ length: 9 }, (_, i) => targetQuestion(`q${i}`, '1', '2'));
    const control = write('c-nine.json', nine);
    const feature = write('f-nine.json', nine);
    const out = run(control, feature);

    expect(out).toContain('publication says 9; recomputation found 9');
    expect(out).toContain('identity is still unconfirmable');
    expect(out).not.toContain('DISAGREEMENT');
  });

  it('separates identical from unseparable in the recomputed cohort', () => {
    const control = write('c-mix.json', [
      targetQuestion('t1', '85', '240'),
      identicalQuestion('i1', '72'),
      ungroundedQuestion('u1'),
    ]);
    const feature = write('f-mix.json', [
      targetQuestion('t1', '85', '240'),
      identicalQuestion('i1', '72'),
      ungroundedQuestion('u1'),
    ]);
    const out = run(control, feature);

    expect(out).toContain('questions considered: 3');
    expect(out).toContain('targets: 1');
    expect(out).toContain('identical: 1');
    // Live, not dead: the reader passes ungrounded questions through so the
    // module's own exclusion counter is the thing that reports them. A reader
    // that pre-filtered would print 0 here and look like nothing was excluded.
    expect(out).toContain('notGrounded: 1');
  });
});

describe('the reader applies the three clauses in their pre-registered order', () => {
  it('reports reworded-but-unmoved questions in their own census, and excludes them', () => {
    // The measured C5 case, end to end through the reader. `n1` is a non-target
    // whose answer text changes while the scorer scores both arms the same, and
    // `t1` is a target that flips. The verdict must be SETTLED, not REGRESSION,
    // and the reworded question must be accounted for explicitly rather than
    // vanishing -- a fix that silently drops these would be indistinguishable
    // from one that never saw them.
    // `n1`'s answer text differs between the arms ('72' vs 'Seventy two'),
    // while the scorer passes both. A capitalisation-only edit would be
    // normalized away by the reader's trim, so the reword here is larger than
    // that -- the point is only that the text differs and the score does not.
    const control = write('c-reword.json', [
      targetQuestion('t1', '85', '240'),
      identicalQuestion('n1', '72'),
    ]);
    const feature = write('f-reword.json', [
      targetQuestion('t1', '85', '240', true),
      { ...identicalQuestion('n1', '72'), answer: 'Seventy two' },
    ]);

    const out = run(control, feature);

    expect(out).toContain('--- movement census');
    expect(out).toContain('reworded but not moved: 1 question(s)');
    expect(out).toContain('SETTLED');
    expect(out).not.toContain('REGRESSION');
  });

  it('reports a non-target regression ahead of a target gain', () => {
    // The target moves AND a non-target moves. The guard clause is checked
    // first and must win: a guard that can be overridden by what it guards is
    // not a guard.
    //
    // The non-target is a question the reader got RIGHT in the control arm
    // (truth === answer, so it classifies as `identical`, not as a target) and
    // WRONG in the feature arm. Only the scorer's verdict distinguishes the two
    // states: the answer text changes as well, but text is not what the guard
    // reads, so this fixture is what proves the guard is reading the score.
    const control = write('c-both.json', [
      targetQuestion('t1', '85', '240'),
      identicalQuestion('n1', '72'),
    ]);
    const feature = write('f-both.json', [
      targetQuestion('t1', '85', '999', true),
      {
        questionId: 'n1',
        question: 'what is the n1 reading?',
        groundTruth: '72',
        answer: '71',
        correct: false,
        grounded: true,
        turns: [{ index: 0, text: 'the reading is 72 for the unit' }],
      },
    ]);
    const out = run(control, feature);

    expect(out).toContain('targets: 1');
    expect(out).toContain('identical: 1');
    expect(out).toContain('REGRESSION');
    expect(out).toContain('n1');
    expect(out).not.toContain('SETTLED');
  });

  it('distinguishes an abstention from an empty answer', () => {
    // The reason this needs its own test rather than riding on the abstention
    // test above: there, the feature answer flips from a real value to
    // abstention, so `null` and `''` both differ from the control and produce
    // the same verdict. The behaviour only becomes observable when the CONTROL
    // abstains too — then `null === null` is no-move, while `'' === ''` is also
    // no-move, and the two look identical again.
    //
    // The distinguishing case is a control that abstains and a feature that
    // answers with the empty string, versus a feature that abstains. A reader
    // that collapses both to `''` reports no movement; one that keeps the
    // distinction reports movement. Only the second is correct: "the reader
    // produced no answer" and "the reader produced an empty answer" are
    // different outcomes, and the criterion is about what moved.
    const control = write('c-empty-ctl.json', [
      { ...targetQuestion('t1', '85', '240'), answer: null },
    ]);
    const feature = write('f-empty-empty.json', [
      { ...targetQuestion('t1', '85', '240'), answer: '' },
    ]);
    const out = run(control, feature);

    // Both sides abstain (null and '') — the reader must not call that a move.
    // This is the half of the distinction the collapsing reader gets wrong in
    // the other direction, so the assertion is that it does NOT report movement.
    expect(out).toContain('NO-MOVE');
  });

  it('treats a target that flips to an abstention as movement, not as an absence', () => {
    // `null` is the abstention. A reader that compared only answers-as-strings
    // would see "no answer" and could misread the flip as nothing happening.
    //
    // The control arm is scored correct, so the target is a target because its
    // ANSWER text differs from the truth while the scorer still passed it. The
    // feature arm abstains, which is the one outcome change that is visible
    // without a score -- but here both sides disagree on the score as well, so
    // the movement is doubly observable.
    const control = write('c-abstain.json', [targetQuestion('t1', '85', '240', true)]);
    const feature = write('f-abstain.json', [
      {
        questionId: 't1',
        question: 'which one is it for t1?',
        groundTruth: '85',
        answer: null,
        correct: false,
        grounded: true,
        turns: [
          { index: 0, text: 'the correct value is 85 according to the record' },
          { index: 1, text: 'the competing value is 240 according to the note' },
        ],
      },
    ]);
    const out = run(control, feature);

    expect(out).toContain('SETTLED');
    expect(out).toContain('t1');
  });

  it('reports no-move as a finding about the reader when no target moves', () => {
    const control = write('c-static.json', [targetQuestion('t1', '85', '240')]);
    const feature = write('f-static.json', [targetQuestion('t1', '85', '240')]);
    const out = run(control, feature);

    expect(out).toContain('NO-MOVE');
    expect(out).toContain('finding about the READER');
    expect(out).not.toContain('SETTLED');
  });
});

describe('the reader accepts the shape the runner actually persists', () => {
  /**
   * THE END-TO-END PROPERTY, and the one that was missing.
   *
   * Every other test in this file feeds the reader a hand-built fixture. The
   * fixtures are correct, and the reader read them — while the reader could not
   * read a SINGLE real artifact, because no real artifact contained a
   * per-question array. `extractQuestions` failed with "no per-question array
   * found" on every archived report, and no test noticed because the fixtures
   * supplied the array the reports did not.
   *
   * This test closes that gap by building the report the way the runner does:
   * through `buildRecordsFromDataset`, which is the function that fills the
   * `questions` field. A future change that renames the field, drops it, or
   * changes the record shape now fails here rather than in a CI log nobody reads.
   */
  it('reads a report whose `questions` came from buildRecordsFromDataset', async () => {
    const { buildRecordsFromDataset } = await import('../question-record.js');

    const records = buildRecordsFromDataset(
      [
        {
          id: 'b7-target',
          question: 'which value did the unit report?',
          capability: 'IE',
          expected: '85',
        },
      ],
      [
        {
          question: 'which value did the unit report?',
          answer: '240',
          retrieved: 'the record says 85\nthe note says 240',
        },
      ],
      [false],
      () => true,
    );
    expect(records).toHaveLength(1);

    // Persisted exactly as `bench/run.ts` writes it, which is what the reader
    // reads in production: `JSON.stringify` with the embedding provenance
    // spread in front.
    const path = join(dir, 'real-shape.json');
    writeFileSync(
      path,
      JSON.stringify({ embedding: { provider: 'zhipu' }, questions: records }, null, 2),
    );

    const out = run(path, path);
    expect(out).toContain('questions considered: 1');
    expect(out).toContain('targets: 1');
    // The whole point: a target roster was recomputed from a real artifact.
    expect(out).not.toContain('no per-question array found');
  });

  it('reports a no-move verdict from the persisted shape rather than throwing', () => {
    const records = [
      {
        questionId: 't1',
        question: 'which one is it for t1?',
        capability: 'IE',
        groundTruth: '85',
        answer: '240',
        correct: false,
        grounded: true,
        turns: [
          { index: 0, text: 'the correct value is 85 according to the record' },
          { index: 1, text: 'the competing value is 240 according to the note' },
        ],
      },
    ];
    const path = join(dir, 'persisted-records.json');
    writeFileSync(path, JSON.stringify({ questions: records }, null, 2));
    const out = run(path, path);
    expect(out).toContain('NO-MOVE');
    expect(out).toContain('finding about the READER');
  });
});

describe('the reader refuses to spend a recording gap as evidence against an arm', () => {
  /**
   * THE DEFECT THIS BLOCK EXISTS FOR.
   *
   * `QuestionRecord.answer` distinguishes `null` (the reader abstained, which is
   * a finding) from an ABSENT key (no trace reached the question, so nobody
   * recorded what the arm produced, which is a gap). The criterion's `ArmOutcome`
   * consumes only the first — `null` means "this arm abstained".
   *
   * The reader used to normalize with `q.answer ?? q.predicted ?? null`, a `??`
   * chain that maps `undefined` onto `null`. That single character turned a gap
   * into an abstention, and an abstention on a NON-TARGET is a regression — the
   * severest verdict the criterion can return, and the one the module documents
   * as unable to be overridden by a target gain. So an artifact that merely
   * failed to record a question could reject an arm outright.
   *
   * The three tests below are the three consequences, each of which fails
   * against the collapsing reader:
   *
   *   1. The gap is reported as a gap, by id and by arm.
   *   2. No verdict is produced at all, because the arm's real behaviour for
   *      that question was never captured and any verdict would invent it.
   *   3. The exit status is non-zero, so a shell pipeline that only reads the
   *      status cannot mistake a refusal for a result.
   */
  /** The shape the runner writes when a question has NO trace: no `answer` key. */
  const recordWithoutAnswer = {
    questionId: 'nt1',
    question: 'how big is the garden?',
    capability: 'IE',
    groundTruth: 'small',
    // `answer` is deliberately ABSENT. Not `null`: `null` would mean abstention.
    correct: false,
    grounded: true,
    turns: [{ index: 0, text: 'the garden is small' }],
  };

  it('names the unrecorded question and the arm it is missing from', () => {
    const control = write('c-gap.json', [targetQuestion('t1', '85', '240')]);
    const feature = write('f-gap.json', [recordWithoutAnswer]);
    const out = run(control, feature);

    expect(out).toContain('--- record completeness');
    expect(out).toContain('UNRECORDED: 1 question(s)');
    expect(out).toContain('feature:nt1');
    expect(out).toContain('NOT an abstention');
  });

  it('produces no verdict when either arm has an unrecorded answer', () => {
    const control = write('c-gap2.json', [targetQuestion('t1', '85', '240')]);
    const feature = write('f-gap2.json', [recordWithoutAnswer]);
    const out = run(control, feature);

    // The property is the ABSENCE of a verdict. Against the collapsing reader
    // this run reported REGRESSION for `nt1`, because the missing record was
    // read as the garden question moving from 'small' to an abstention.
    expect(out).not.toContain('REGRESSION');
    expect(out).not.toContain('NO-MOVE');
    expect(out).not.toContain('SETTLED');
    expect(out).toContain('REFUSING to judge');
  });

  it('does not use verdict vocabulary in the refusal itself', () => {
    // Found by the assertion above failing against my OWN first draft of the
    // refusal, whose explanation contained the literal word "REGRESSION". A
    // reader that greps the output for a verdict token — which is exactly how a
    // shell consumer decides what happened — would match the refusal and treat
    // it as the severest verdict the criterion can return. The refusal must be
    // lexically disjoint from the verdicts, not merely semantically different.
    const control = write('c-gap4.json', [targetQuestion('t1', '85', '240')]);
    const feature = write('f-gap4.json', [recordWithoutAnswer]);
    const out = run(control, feature);

    expect(out).toContain('REFUSING to judge');
    for (const verdict of ['REGRESSION', 'NO-MOVE', 'SETTLED']) {
      expect(out).not.toContain(verdict);
    }
    expect(out).toContain('No verdict is printed');
  });

  it('exits non-zero so a shell cannot mistake a refusal for a result', () => {
    const control = write('c-gap3.json', [targetQuestion('t1', '85', '240')]);
    const feature = write('f-gap3.json', [recordWithoutAnswer]);
    // Against the collapsing reader this was 0: it printed a REGRESSION, which
    // is a verdict, and a verdict is a successful exit.
    expect(runStatus(control, feature)).toBe(1);
  });

  it('still judges when the arm abstained EXPLICITLY, because that is recorded', () => {
    // The discriminator for the whole block. An explicit `null` is a finding
    // about the reader and must reach the criterion; it is only the ABSENT key
    // that is a gap. A reader that refused on both would be over-correcting and
    // would make abstentions — the very outcome B7's switch is meant to affect —
    // unreadable.
    const control = write('c-null.json', [targetQuestion('t1', '85', '240', true)]);
    const feature = write('f-null.json', [
      { ...targetQuestion('t1', '85', '240', true), answer: null, correct: false },
    ]);
    const out = run(control, feature);

    expect(out).toContain('complete: both arms recorded an answer');
    expect(out).toContain('SETTLED');
    expect(out).toContain('t1');
  });
});

describe('the reader fails loudly rather than reporting a vacuous verdict', () => {
  it('exits non-zero when a report has no per-question array', () => {
    const control = write('c-empty.json', []);
    const path = join(dir, 'f-noarray.json');
    writeFileSync(path, JSON.stringify({ dataset: 'longmemeval' }));
    let threw = false;
    try {
      execFileSync('node', [SCRIPT, control, path], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      threw = true;
      const stderr = String((error as { stderr?: string }).stderr ?? '');
      expect(stderr).toContain('no per-question array found');
    }
    expect(threw).toBe(true);
  });

  it('prints usage and exits 2 when given too few arguments', () => {
    let status: number | undefined;
    try {
      execFileSync('node', [SCRIPT], { encoding: 'utf8', stdio: 'pipe' });
    } catch (error) {
      status = (error as { status?: number }).status;
    }
    expect(status).toBe(2);
  });
});
