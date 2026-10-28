/**
 * The abstention-line split of the discordant pairs.
 *
 * Three things are pinned here, and the third is the one that keeps this module honest:
 *
 * 1. the four cells are classified from the two answers and the two verdicts, with a decline defined exactly
 *    as `metrics.ts` defines it (`answer === null`) and nothing else;
 * 2. the two flows are named from the counts rather than asserted by a report;
 * 3. **the split is a refinement, not a rival count** — `recovered + corrected` equals the bought count that
 *    `runAblation` already publishes, asserted against the real ablation rather than against a fixture. If a
 *    future edit double-counts or drops a flip, that assertion fails and names the disagreement.
 *
 * The rendering is asserted through `formatAblationReport` rather than through a helper, because the defect
 * this repository has paid for three times is a value computed correctly, carried in the JSON, and never
 * rendered. `transitionLines` is module-private for the corresponding reason: it has one caller, and an
 * exported helper with one caller is an export the census reports as an orphan.
 */

import { describe, expect, it } from 'vitest';
import { classifyTransitions, dominantFlow } from '../answer-transition.js';
import { runAblation } from '../ablation.js';
import { exactMatchScorer } from '../metrics.js';
import { formatAblationReport, type AblationReport } from '../report.js';
import type {
  AblationResult,
  Answer,
  AnswerTransition,
  BenchmarkDataset,
  MemorySystem,
} from '../types.js';

const noFlips = { recovered: 0, corrected: 0, declined: 0, missed: 0 };

const dataset: BenchmarkDataset = {
  name: 'transition-shapes',
  questions: [
    { id: 'q1', capability: 'IE', question: 'Q1', expected: 'a', context: ['a'] },
    { id: 'q2', capability: 'MR', question: 'Q2', expected: 'a', context: ['a'] },
    { id: 'q3', capability: 'TR', question: 'Q3', expected: 'a', context: ['a'] },
    { id: 'q4', capability: 'ABS', question: 'Q4', expected: 'a', context: ['a'] },
    { id: 'q5', capability: 'IE', question: 'Q5', expected: 'a', context: ['a'] },
    { id: 'q6', capability: 'TR', question: 'Q6', expected: 'a', context: ['a'] },
  ],
};

/** A system that answers from a fixed table, so each cell of the split is exercised by one question. */
function scripted(name: string, answers: Record<string, Answer>): MemorySystem {
  return { name, answer: (question) => answers[question] ?? null };
}

function paired(baseline: MemorySystem, feature: MemorySystem): Promise<AblationResult> {
  return runAblation(dataset, baseline, feature, { runs: 1, scorer: exactMatchScorer });
}

function reportOf(ablation: AblationResult): AblationReport {
  return {
    dataset: dataset.name,
    questionCount: dataset.questions.length,
    baseline: { name: 'baseline', metrics: ablation.baselineMetrics },
    feature: { name: 'feature', metrics: ablation.featureMetrics },
    ablation,
    generatedAt: '2026-10-28T00:00:00.000Z',
  };
}

describe('classifyTransitions: four cells, each decided by two facts', () => {
  it('counts a question that stopped declining and became right as recovered', () => {
    const transition = classifyTransitions({
      baselineAnswers: [null],
      featureAnswers: ['a'],
      baselineCorrect: [false],
      featureCorrect: [true],
    });
    expect(transition).toEqual({ ...noFlips, recovered: 1 });
  });

  it('counts a question that was already speaking and became right as corrected', () => {
    const transition = classifyTransitions({
      baselineAnswers: ['b'],
      featureAnswers: ['a'],
      baselineCorrect: [false],
      featureCorrect: [true],
    });
    expect(transition).toEqual({ ...noFlips, corrected: 1 });
  });

  it('counts a question that was right and stopped speaking as declined', () => {
    const transition = classifyTransitions({
      baselineAnswers: ['a'],
      featureAnswers: [null],
      baselineCorrect: [true],
      featureCorrect: [false],
    });
    expect(transition).toEqual({ ...noFlips, declined: 1 });
  });

  it('counts a question that was right and is now wrong as missed, not as declined', () => {
    // The distinction is the reason this module exists: both are a sold question, and only one of them is a
    // change in whether the system speaks.
    const transition = classifyTransitions({
      baselineAnswers: ['a'],
      featureAnswers: ['b'],
      baselineCorrect: [true],
      featureCorrect: [false],
    });
    expect(transition).toEqual({ ...noFlips, missed: 1 });
  });

  it('treats an empty string as an answer, because the scorer does', () => {
    // `metrics.ts` counts an abstention with `answer === null`. An empty string is a value the parser
    // produced, so classifying it as a decline here would make this module and the scorer disagree about the
    // same question -- silently, since both would still produce a number.
    const transition = classifyTransitions({
      baselineAnswers: [''],
      featureAnswers: ['a'],
      baselineCorrect: [false],
      featureCorrect: [true],
    });
    expect(transition).toEqual({ ...noFlips, corrected: 1 });
  });

  it('does not count a question whose verdict did not change', () => {
    // Right in both and wrong in both carry no information about a change, which is the same reason McNemar
    // conditions on the discordant pairs. A classifier that counted them would report the corpus size.
    const transition = classifyTransitions({
      baselineAnswers: ['a', null, 'b'],
      featureAnswers: ['a', null, 'b'],
      baselineCorrect: [true, false, false],
      featureCorrect: [true, false, false],
    });
    expect(transition).toEqual(noFlips);
  });

  it('refuses two correctness vectors of different lengths rather than reading the shorter one', () => {
    expect(() =>
      classifyTransitions({
        baselineAnswers: ['a', 'b'],
        featureAnswers: ['a', 'b'],
        baselineCorrect: [true, false],
        featureCorrect: [true],
      }),
    ).toThrow(/not the same question set/);
  });

  it('refuses an answers vector that does not cover every verdict', () => {
    // The failure this prevents is specific: a caller that passed the feature's answers for a thirty-question
    // subset against a five-hundred-question verdict vector would classify by index into the wrong questions
    // and produce four plausible numbers.
    expect(() =>
      classifyTransitions({
        baselineAnswers: ['a'],
        featureAnswers: ['a', 'b'],
        baselineCorrect: [true],
        featureCorrect: [true],
      }),
    ).toThrow(/one answer per question/);
  });
});

describe('dominantFlow: the sentence a reader would otherwise guess', () => {
  it('names the decline flow when only crossings moved', () => {
    expect(dominantFlow({ recovered: 4, corrected: 0, declined: 1, missed: 0 })).toBe('decline');
  });

  it('names the content flow when no flip crossed the line', () => {
    expect(dominantFlow({ recovered: 0, corrected: 4, declined: 0, missed: 1 })).toBe('content');
  });

  it('says both when a response-shape effect and a knowledge effect are summed into one net', () => {
    expect(dominantFlow({ recovered: 2, corrected: 1, declined: 0, missed: 0 })).toBe('both');
  });

  it('says none rather than naming a flow that carried nothing', () => {
    expect(dominantFlow(noFlips)).toBe('none');
  });
});

describe('the identity, asserted against a real ablation rather than a fixture', () => {
  it('splits the two published flip counts without changing either', async () => {
    const result = await paired(
      scripted('baseline', { Q2: 'b', Q3: 'a', Q4: 'a', Q5: 'a', Q6: 'b' }),
      scripted('feature', { Q1: 'a', Q2: 'a', Q4: 'b', Q5: 'a', Q6: 'b' }),
    );
    // Q1 declined then right (recovered), Q2 wrong then right (corrected), Q3 right then declined,
    // Q4 right then wrong (missed), Q5 right in both and Q6 wrong in both (concordant, not counted).
    expect(result.transitions).toEqual({ recovered: 1, corrected: 1, declined: 1, missed: 1 });
    expect(result.transitions!.recovered + result.transitions!.corrected).toBe(
      result.discordant.baselineIncorrectFeatureCorrect,
    );
    expect(result.transitions!.declined + result.transitions!.missed).toBe(
      result.discordant.baselineCorrectFeatureIncorrect,
    );
    // A net of zero built from four flips. A net of zero is not a null result here, and the split is what
    // shows why: two questions moved each way.
    expect(dominantFlow(result.transitions!)).toBe('both');
  });

  it('names a net bought entirely by the decline flow, which is the reading a budget rise predicts', async () => {
    // Three questions stop declining and become right, two keep declining, one was answering wrongly and
    // still is. The net is +3 and every flip crossed the abstention line -- the same +3 a content-flow
    // increment would report, which is why the split is not an optional refinement.
    const result = await paired(
      scripted('baseline', { Q6: 'b' }),
      scripted('feature', { Q1: 'a', Q2: 'a', Q3: 'a', Q6: 'c' }),
    );
    expect(result.transitions).toEqual({ recovered: 3, corrected: 0, declined: 0, missed: 0 });
    expect(dominantFlow(result.transitions!)).toBe('decline');
    expect(result.discordant.baselineIncorrectFeatureCorrect).toBe(3);
    expect(result.discordant.baselineCorrectFeatureIncorrect).toBe(0);
    expect(result.transitions!.recovered + result.transitions!.corrected).toBe(
      result.discordant.baselineIncorrectFeatureCorrect,
    );
  });
});

describe('the rendered section, in the document a reader opens', () => {
  /**
   * A real ablation's report, with its split replaced so that each flow can be rendered in turn.
   *
   * The run's own split is asserted present before it is discarded, so this helper cannot render a field the
   * producer never set while appearing to test the producer.
   */
  async function rendered(transitions: AnswerTransition | undefined): Promise<string> {
    const result = await paired(
      scripted('baseline', { Q2: 'b', Q3: 'a', Q4: 'a', Q5: 'a' }),
      scripted('feature', { Q1: 'a', Q2: 'a', Q5: 'a' }),
    );
    expect(result.transitions).toBeDefined();
    const { transitions: recorded, ...rest } = result;
    expect(recorded).toBeDefined();
    const ablation: AblationResult =
      transitions === undefined ? { ...rest } : { ...rest, transitions };
    return formatAblationReport(reportOf(ablation));
  }

  it('prints the identity so a reader can check the refinement', async () => {
    const document = await rendered({ recovered: 3, corrected: 2, declined: 1, missed: 0 });
    expect(document).toContain('### What kind of change each flip was');
    expect(document).toContain('| recovered | declined | answered correctly | 3 |');
    expect(document).toContain('recovered + corrected = 5');
    expect(document).toContain('declined + missed = 1');
  });

  it('names the flow in the prose, from the counts and not from a literal', async () => {
    expect(await rendered({ recovered: 3, corrected: 0, declined: 1, missed: 0 })).toContain(
      'The decline flow carried it',
    );
    expect(await rendered({ recovered: 0, corrected: 3, declined: 0, missed: 1 })).toContain(
      'The content flow carried it',
    );
    expect(await rendered({ recovered: 2, corrected: 1, declined: 0, missed: 0 })).toContain(
      'Two mechanisms moved together',
    );
  });

  it('says nothing crossed either line when no question changed verdict', async () => {
    expect(await rendered(noFlips)).toContain('Nothing crossed either line');
  });

  it('says an artifact predates the split instead of printing four zeroes', async () => {
    // Four zeroes would read as "nothing crossed either line", which is a measurement. The sentence says the
    // measurement is absent, and the two flip counts above it still stand.
    const document = await rendered(undefined);
    expect(document).toContain('Not recorded in this artifact');
    expect(document).not.toContain('| recovered |');
  });
});
