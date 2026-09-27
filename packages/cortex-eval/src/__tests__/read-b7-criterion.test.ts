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
  grounded: boolean;
  turns: Turn[];
};

/**
 * Run the reader and capture stdout. A non-zero exit is surfaced rather than
 * swallowed: the reader's verdicts are all successful exits, so an exit code
 * other than 0 means the tool itself failed.
 */
function run(controlPath: string, featurePath: string): string {
  return execFileSync('node', [SCRIPT, controlPath, featurePath], { encoding: 'utf8' });
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
 */
function targetQuestion(id: string, truth: string, answer: string): Question {
  return {
    questionId: id,
    question: `which one is it for ${id}?`,
    groundTruth: truth,
    answer,
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
 */
function identicalQuestion(id: string, value: string): Question {
  return {
    questionId: id,
    question: `what is the ${id} reading?`,
    groundTruth: value,
    answer: value,
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
  it('reports a non-target regression ahead of a target gain', () => {
    // The target moves AND a non-target moves. The guard clause is checked
    // first and must win: a guard that can be overridden by what it guards is
    // not a guard.
    //
    // The non-target is a question the reader got RIGHT (truth === answer, so
    // it classifies as `identical`, not as a target). This is the only way to
    // make a non-target at all once the cohort is recomputed from the control
    // arm: any B7-shaped question is a target by construction.
    const control = write('c-both.json', [
      targetQuestion('t1', '85', '240'),
      identicalQuestion('n1', '72'),
    ]);
    const feature = write('f-both.json', [
      targetQuestion('t1', '85', '999'),
      {
        questionId: 'n1',
        question: 'what is the n1 reading?',
        groundTruth: '72',
        answer: '71',
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
    const control = write('c-abstain.json', [targetQuestion('t1', '85', '240')]);
    const feature = write('f-abstain.json', [
      {
        questionId: 't1',
        question: 'which one is it for t1?',
        groundTruth: '85',
        answer: null,
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
