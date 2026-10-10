/**
 * The noise-quantification CLI: how many questions does the endpoint move on its
 * own?
 *
 * This is the number that decides whether ANY A/B delta is a finding. §20 records
 * a C5 comparison whose two arms differed by 2 questions and whose delta could
 * not be interpreted, because the floor it was judged against was measured
 * WITHIN a single run. P4 then ran the same configuration twice, a day apart, and
 * the endpoint moved 25 of 500 questions -- so the within-run floor bounded
 * nothing.
 *
 * `variance.ts` already has the arithmetic (`summarizeVariance`,
 * `compareQuestionVectors`, `requiredEffectSize`) and it was already tested. What
 * it never had was a CALLER with real data: its `RunObservation` carries counts,
 * and its vector comparison needs per-question vectors that no artifact produced.
 * The per-question roster (this iteration) supplies them, and this tool is the
 * consumer that turns N config-identical reports into the floor.
 *
 * The tests below drive the tool as a subprocess against real persisted report
 * shapes, because the contract that matters is its behaviour on the files an
 * operator actually has: the artifact set from a dispatched run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { QuestionRecord } from '../question-record.js';

const REPO_ROOT = resolve(__dirname, '../../../..');
const SCRIPT = join(REPO_ROOT, 'tools', 'quantify-endpoint-noise.mjs');

let dir: string;

/**
 * Run the tool and capture stdout. A non-zero exit is surfaced rather than
 * swallowed: every verdict this tool reports is a successful exit, so a non-zero
 * code means the tool itself failed and must not be read as a measured floor.
 */
function run(args: string[]): string {
  return execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
}

function runExpectingFailure(args: string[]): { status: number | undefined; stderr: string } {
  try {
    execFileSync('node', [SCRIPT, ...args], { encoding: 'utf8', stdio: 'pipe' });
  } catch (error) {
    const e = error as { status?: number; stderr?: string };
    return { status: e.status, stderr: String(e.stderr ?? '') };
  }
  throw new Error('expected the tool to exit non-zero');
}

/** One graded question, correct or not. */
function record(id: string, correct: boolean, capability = 'IE'): QuestionRecord {
  return {
    questionId: id,
    question: `question ${id}`,
    capability,
    groundTruth: '85',
    answer: correct ? '85' : '240',
    correct,
    grounded: true,
    turns: [{ index: 0, text: 'the record says 85' }],
    // One turn, carried in full: these two must agree with `turns` or the record
    // claims a reduction that never happened.
    evidenceTurns: 1,
    evidenceChars: 'the record says 85'.length,
  };
}

/**
 * Write a persisted report with a given correctness pattern.
 *
 * `correct` is a list of booleans in dataset order; the ids are `q0..qN`. This
 * is the shape `bench/run.ts` writes: a JSON object whose `questions` array is
 * the roster.
 */
function writeReport(name: string, correct: readonly boolean[], capability = 'IE'): string {
  const questions = correct.map((c, i) => record(`q${i}`, c, capability));
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify(
      {
        embedding: { provider: 'zhipu', dimensions: 1024 },
        dataset: 'longmemeval',
        questionCount: questions.length,
        questions,
      },
      null,
      2,
    ),
  );
  return path;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'endpoint-noise-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('the tool reports the endpoint movement between config-identical runs', () => {
  it('reports zero movement when two runs graded every question the same way', () => {
    // The ideal: the endpoint is fully reproducible, so any arm that moves even
    // one question clears the floor. Reported as 0 rather than as "stable" --
    // `summarizeVariance` is explicit that one run cannot demonstrate stability,
    // and neither can two that happen to agree.
    const a = writeReport('same-a.json', [true, true, true, true]);
    const b = writeReport('same-b.json', [true, true, true, true]);
    const out = run([a, b]);

    expect(out).toContain('observations: 2');
    expect(out).toContain('range: 0 questions');
    expect(out).toContain('minQuestionsStrictlyGreaterThan: 1');
  });

  it('counts the questions that flipped, and names them', () => {
    // A count is not a roster. The tool must say WHICH questions moved, because
    // "2 questions moved" and "the same 2 questions moved in both halves of a
    // perfectly symmetric pattern" are different diagnoses -- the second is what
    // §20 saw and could not name.
    const a = writeReport('flip-a.json', [true, true, true, false]);
    const b = writeReport('flip-b.json', [true, false, true, false]);
    const out = run([a, b]);

    expect(out).toContain('changed: 1');
    expect(out).toContain('(0 in, 1 out');
    // The id, not just the count.
    expect(out).toContain('correct -> wrong  q1');
  });

  it('names both directions separately', () => {
    // A flip INTO correct and a flip OUT of correct are different events, and a
    // net-zero delta produced by one of each is not "no change".
    const a = writeReport('both-a.json', [true, false, true]);
    const b = writeReport('both-b.json', [false, true, true]);
    const out = run([a, b]);

    expect(out).toContain('(1 in, 1 out');
    expect(out).toContain('changed: 2');
    // THE FINDING THIS WHOLE TOOL EXISTS FOR, and the reason the count-based
    // floor alone is unsafe.
    //
    // Net accuracy is IDENTICAL across these two runs (2/3 each), so the
    // count-based range is 0. But 2 of the 3 questions actually moved, so the
    // bar must be derived from the ROSTER. Until §25 the tool printed the range
    // as the bar and a warning below it; the bar an arm would be judged against
    // was the understated one.
    expect(out).toContain('range: 0 questions');
    expect(out).toContain('changed: 2');
    expect(out).toContain('66.67%');
    // The bar now comes from the roster: 2 moved, so an arm must move 3.
    expect(out).toContain('minQuestionsStrictlyGreaterThan: 3');
    expect(out).toContain('floor source: the ROSTER, not the score');
  });

  it('keeps the score range as the bar when the roster moved no further', () => {
    // The roster figure joins the range, it does not replace it. Here the score
    // swung one question and exactly one question moved, so nothing is being
    // hidden and the bar is the ordinary one.
    const a = writeReport('agree-a.json', [true, true, false, false]);
    const b = writeReport('agree-b.json', [true, false, false, false]);
    const out = run([a, b]);

    expect(out).toContain('range: 1 questions');
    expect(out).toContain('changed: 1');
    expect(out).toContain('minQuestionsStrictlyGreaterThan: 2');
    expect(out).toContain('floor source: the score range');
  });

  it('derives the minimum clearing effect from the observed range', () => {
    // Three runs, correct counts 1/2/3 over 4 questions: range 2, and up to 2
    // questions move between a pair, so an arm must move strictly MORE than 2.
    // Strictly, because matching the noise is not clearing it.
    const a = writeReport('range-a.json', [true, false, false, false]);
    const b = writeReport('range-b.json', [true, true, false, false]);
    const c = writeReport('range-c.json', [true, true, true, false]);
    const out = run([a, b, c]);

    expect(out).toContain('observations: 3');
    expect(out).toContain('range: 2 questions');
    expect(out).toContain('minQuestionsStrictlyGreaterThan: 3');
  });

  it('reports the overall accuracy of each run so drift is visible', () => {
    const a = writeReport('acc-a.json', [true, true, false, false]);
    const b = writeReport('acc-b.json', [true, false, false, false]);
    const out = run([a, b]);
    expect(out).toContain('series (correct per run): 2, 1');
  });
});

describe('the tool breaks the movement down per capability', () => {
  it('measures each capability over its own questions', () => {
    // A capability-specific floor is what makes a per-capability claim decidable.
    // The overall floor would forbid a real ABS effect on a 30-question sample
    // that the IE population's movement inflated.
    const a = join(dir, 'cap-a.json');
    const b = join(dir, 'cap-b.json');
    const make = (name: string, pattern: Array<[string, boolean]>): string => {
      const path = join(dir, name);
      writeFileSync(
        path,
        JSON.stringify({
          questions: pattern.map(([cap, correct], i) => record(`q${i}`, correct, cap)),
        }),
      );
      return path;
    };
    void a;
    void b;
    const x = make('cap-x.json', [
      ['IE', true],
      ['IE', true],
      ['ABS', false],
      ['ABS', false],
    ]);
    const y = make('cap-y.json', [
      ['IE', false],
      ['IE', true],
      ['ABS', false],
      ['ABS', false],
    ]);
    const out = run([x, y]);

    expect(out).toContain('IE');
    expect(out).toContain('ABS');
    // IE moved once; ABS never moved and must report its own zero rather than
    // inheriting the overall figure.
    expect(out).toMatch(/ABS\s+.*\b0\b/);
  });
});

describe('the tool refuses to fabricate a floor', () => {
  it('refuses to derive a floor from a single run', () => {
    // One run cannot demonstrate stability: with n=1 there is no spread, so any
    // bar derived from it is invented rather than measured. The tool refuses
    // before it reaches the arithmetic, and says why in the terms that matter --
    // that a single run can only fail to demonstrate instability.
    const a = writeReport('single.json', [true, false, true]);
    const { status, stderr } = runExpectingFailure([a]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('at least two reports');
    expect(stderr).toContain('invented rather than measured');
  });

  it('surfaces the arithmetic layer refusing a spread it cannot measure', async () => {
    // The guard above and `requiredEffectSize`'s own guard are two different
    // checks on the same property, and this pins the second. Without it, a
    // future change that relaxed the CLI's length check would silently fall
    // through to a fabricated bar -- and the library's error would reach the
    // operator as a stack trace instead of a refusal.
    const { requiredEffectSize, summarizeVariance } = await import('../variance.js');
    const one = summarizeVariance([{ runId: 'only', perCapability: {}, correct: 1, total: 3 }]);
    expect(one.sufficient).toBe(false);
    expect(() => requiredEffectSize(one)).toThrow(/at least two observations/);
  });

  it('refuses a report with no per-question roster', () => {
    // The state every archived artifact is in. The tool must say so, because the
    // alternative -- treating the absence as "no movement" -- would report the
    // most favourable possible floor from an artifact that measured nothing.
    const path = join(dir, 'no-roster.json');
    writeFileSync(path, JSON.stringify({ dataset: 'longmemeval', questionCount: 3 }));
    const { status, stderr } = runExpectingFailure([path]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('no per-question roster');
  });

  it('refuses runs that graded different question sets', () => {
    // Two runs over different questions have no paired comparison. Comparing
    // them by index would align unrelated questions and produce a plausible
    // number from meaningless data -- the error `compareQuestionVectors` throws
    // to prevent one layer down.
    const a = writeReport('set-a.json', [true, true, true]);
    const bPath = join(dir, 'set-b.json');
    writeFileSync(
      bPath,
      JSON.stringify({
        questions: [record('other', true), record('q1', true), record('q2', true)],
      }),
    );
    const { status, stderr } = runExpectingFailure([a, bPath]);
    expect(status).not.toBe(0);
    expect(stderr).toContain('different question sets');
  });

  it('exits non-zero with usage when given no arguments', () => {
    const { status } = runExpectingFailure([]);
    expect(status).not.toBe(0);
  });

  it('refuses a run whose records omit the answer key', () => {
    // THE GAP, and why it matters to THIS tool specifically.
    //
    // This tool does not read `answer` -- it reads `correct`, which the builder
    // always writes. So a missing record is invisible in the vector itself, and
    // visible only in what the gap does to it: `correct` is `false` for a
    // question nobody recorded, exactly as it is for a question the arm got
    // wrong. A run with a gap therefore presents its missing records as wrong
    // answers, and the comparison against another run counts them as flips.
    //
    // That inflates the floor -- the number every A/B verdict is measured
    // against. The two consequences are opposite and both bad: a floor that is
    // too high rejects real effects, and a floor built partly from recording
    // gaps is not describing the endpoint at all.
    const clean = writeReport('gap-clean.json', [true, true, true]);
    const gapped = join(dir, 'gap-gapped.json');
    writeFileSync(
      gapped,
      JSON.stringify({
        questions: [
          record('q0', true),
          // `answer` deleted: the runner takes it from the question's trace, and
          // a question with no trace gets no key at all.
          (() => {
            const { answer: _omitted, ...withoutAnswer } = record('q1', false);
            return withoutAnswer;
          })(),
          record('q2', true),
        ],
      }),
    );

    const { status, stderr } = runExpectingFailure([clean, gapped]);
    expect(status).not.toBe(0);
    expect(stderr).toContain("no 'answer' key");
    expect(stderr).toContain('inflating the floor');
  });

  it('still accepts an explicit null, because that is a recorded abstention', () => {
    // The discriminator. `null` is the reader abstaining, which IS a real
    // observation about the endpoint and belongs in the noise figure; only the
    // ABSENT key is a gap. A guard that rejected both would throw away exactly
    // the abstention behaviour an ABS-targeted arm is meant to change.
    const a = join(dir, 'null-a.json');
    const b = join(dir, 'null-b.json');
    const withNull = (id: string) => ({ ...record(id, false), answer: null });
    writeFileSync(a, JSON.stringify({ questions: [record('q0', true), withNull('q1')] }));
    writeFileSync(b, JSON.stringify({ questions: [record('q0', true), record('q1', false)] }));
    // Both are recorded, so the tool judges; whether they differ is the
    // arithmetic's business, not this guard's.
    const out = run([a, b]);
    expect(out).toContain('observations: 2');
  });

  it('accepts a directory and reads every report in it', () => {
    // The artifact set an operator actually has after a dispatch is a directory
    // of unzipped files, not a hand-written argument list.
    const sub = join(dir, 'set');
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, 'run-1.json'),
      JSON.stringify({ questions: [record('q0', true), record('q1', false)] }),
    );
    writeFileSync(
      join(sub, 'run-2.json'),
      JSON.stringify({ questions: [record('q0', true), record('q1', true)] }),
    );
    const out = run([sub]);
    expect(out).toContain('observations: 2');
    expect(out).toContain('changed: 1');
  });
});

describe('the tool refuses to present a cross-configuration comparison as a floor', () => {
  /**
   * Write a report whose `featureConfig` is recorded.
   *
   * `featureConfig` is what separates "two runs of the same thing" from "two
   * different things", and it is exactly what the tool used to read and then
   * ignore: it printed both configurations and *still* titled the block
   * `(same configuration, repeated)`.
   */
  function writeConfigured(
    name: string,
    correct: readonly boolean[],
    featureConfig: Record<string, boolean>,
  ): string {
    const questions = correct.map((c, i) => record(`q${i}`, c));
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({ featureConfig, questions }, null, 2));
    return path;
  }

  it('warns when two runs recorded DIFFERENT configurations', () => {
    // The C5 arms, reproduced: `retrievalSides` off in one arm and on in the
    // other. Their movement is the SWITCH, not the endpoint, so the number
    // computed from them is not a floor. The tool knows this -- it printed both
    // configs -- but it then asserted sameness anyway in the block title.
    const a = writeConfigured('cfg-a.json', [true, true, true, true], {
      retrievalSides: false,
      reranker: true,
    });
    const b = writeConfigured('cfg-b.json', [true, true, false, true], {
      retrievalSides: true,
      reranker: true,
    });
    const out = run([a, b]);

    expect(out).toContain('DIFFERENT configurations');
    expect(out).not.toContain('same configuration, repeated');
  });

  it('does not warn when every run recorded the SAME configuration', () => {
    // The guard must not fire on the case the tool exists for.
    const config = { retrievalSides: false, reranker: true };
    const a = writeConfigured('cfg-same-a.json', [true, true, true, true], config);
    const b = writeConfigured('cfg-same-b.json', [true, true, true, false], config);
    const out = run([a, b]);

    expect(out).toContain('same configuration, repeated');
    expect(out).not.toContain('DIFFERENT configurations');
  });

  it('does not warn when the runs agree on every key, even if key order differs', () => {
    // `featureConfig` is serialized from an object literal, so key order is not
    // stable across producers. A comparison that depended on it would warn on
    // identical configurations and train the reader to ignore the warning.
    const a = writeConfigured('cfg-order-a.json', [true, true], {
      reranker: true,
      retrievalSides: false,
    });
    const b = writeConfigured('cfg-order-b.json', [true, true], {
      retrievalSides: false,
      reranker: true,
    });
    const out = run([a, b]);

    expect(out).toContain('same configuration, repeated');
  });

  it('names the key that differs, because "they differ" is not actionable', () => {
    const a = writeConfigured('cfg-key-a.json', [true, true], { retrievalSides: false });
    const b = writeConfigured('cfg-key-b.json', [true, true], { retrievalSides: true });
    const out = run([a, b]);

    expect(out).toContain('retrievalSides');
  });
});
