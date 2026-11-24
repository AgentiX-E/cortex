/**
 * The reading `test/preference-route/result.json` records, and the arithmetic that has to hold in it.
 *
 * ## Why a test reads a reading
 *
 * The reading itself cannot be re-derived here: it comes out of two 60 MB artifacts that are not in
 * this repository, and re-taking it costs a dispatch (about ¥6) plus a 62 MB download. What the
 * campaign has instead is `tools/readings-census.mjs`, which pins the file's bytes by hash -- and a
 * hash says the file was not edited, not that it adds up.
 *
 * The round this file was written in made exactly that distinction expensive. The document said the
 * treatment converted **7** questions and the artifact said the arm moved from **137 to 145**, and
 * both sentences were written into the same section on the same day: 137 + 7 is 144. The missing
 * question was a flip on a prompt whose bytes never moved, which belongs to the *guard* and not to the
 * attribution. Nothing in the tree could have caught it, because the two numbers lived in two
 * paragraphs.
 *
 * So the numbers are recorded once, in one object, and this file asserts the identities between them.
 * It does not assert that a number is *right* -- only the artifact can say that -- it asserts that the
 * numbers cannot disagree with each other while the document quotes them side by side.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const READING_PATH = new URL('../../test/preference-route/result.json', import.meta.url);

interface Bucket {
  readonly n: number;
  readonly up: number;
  readonly down: number;
  readonly goldCarried: number;
}

interface Pass {
  readonly min: number;
  readonly avg: number;
  readonly max: number;
}

interface Reading {
  readonly population: { readonly preferenceQuestions: number };
  readonly repetition1: {
    readonly controlCorrect: number;
    readonly treatmentCorrect: number;
    readonly total: number;
  };
  readonly fourPass: { readonly control: Pass; readonly treatment: Pass };
  readonly paired: {
    readonly up: number;
    readonly down: number;
    readonly buckets: { readonly identicalPrompt: Bucket; readonly changedPrompt: Bucket };
  };
  readonly preference: {
    readonly control: { readonly correct: number; readonly wrong: number };
    readonly treatment: { readonly correct: number; readonly wrong: number };
    readonly stillWrong: readonly string[];
  };
  readonly singleVariable: {
    readonly questionsWithIdenticalEvidence: number;
    readonly deliveredPromptDeltaChars: number;
    readonly evidenceDrifted: readonly string[];
    readonly conversionsOnDriftedQuestions: number;
  };
  readonly failureStates: {
    readonly control: { readonly long_prose: number; readonly other: number };
    readonly treatment: { readonly long_prose: number; readonly other: number };
  };
  readonly cost: {
    readonly llmCalls: number;
    readonly featurePromptTokens: number;
    readonly callsPerQuestionPass: number;
    readonly controlCallsPerQuestionPass: number;
    readonly promptTokensPerQuestion: number;
  };
}

const reading = JSON.parse(readFileSync(READING_PATH, 'utf8')) as Reading;

const total = (bucket: { long_prose: number; other: number }): number =>
  bucket.long_prose + bucket.other;

describe('the preference route reading', () => {
  it('moves by exactly what its own two buckets moved by', () => {
    const { controlCorrect, treatmentCorrect } = reading.repetition1;
    const { identicalPrompt, changedPrompt } = reading.paired.buckets;
    const delta = treatmentCorrect - controlCorrect;

    // The three ways to count the same movement. A reading where they disagree is a reading whose
    // document is quoting two different experiments in adjacent sentences.
    expect(delta).toBe(reading.paired.up - reading.paired.down);
    expect(delta).toBe(
      identicalPrompt.up - identicalPrompt.down + changedPrompt.up - changedPrompt.down,
    );
    expect(reading.paired.up).toBe(identicalPrompt.up + changedPrompt.up);
    expect(reading.paired.down).toBe(identicalPrompt.down + changedPrompt.down);
  });

  it('splits the population into the two buckets without losing a question', () => {
    const { identicalPrompt, changedPrompt } = reading.paired.buckets;

    expect(identicalPrompt.n + changedPrompt.n).toBe(reading.repetition1.total);
    // A tie is a question that did not move, so up + down + tie is the bucket.
    expect(identicalPrompt.up + identicalPrompt.down).toBeLessThanOrEqual(identicalPrompt.n);
    expect(changedPrompt.up + changedPrompt.down).toBeLessThanOrEqual(changedPrompt.n);
  });

  it('counts the converted questions as the preference population, not as the whole movement', () => {
    const { control, treatment } = reading.preference;
    const { changedPrompt } = reading.paired.buckets;

    // The conversions are all in the changed-prompt bucket, and all of them are preference questions.
    expect(treatment.correct - control.correct).toBe(changedPrompt.up - changedPrompt.down);
    // The population closes both ways: correct and wrong sum to it, and the named failures are the
    // wrong ones.
    expect(control.correct + control.wrong).toBe(reading.population.preferenceQuestions);
    expect(treatment.correct + treatment.wrong).toBe(reading.population.preferenceQuestions);
    expect(reading.preference.stillWrong).toHaveLength(treatment.wrong);
  });

  it('keeps the untouched bucket on the guard rather than the attribution', () => {
    const { identicalPrompt } = reading.paired.buckets;

    // One flip, no loss, and no gold turn carried in or out: the digest self-check. The document quotes
    // this as the guard's `1 up, 0 down`, which is the same single question and not a second one.
    expect(identicalPrompt.up).toBe(1);
    expect(identicalPrompt.down).toBe(0);
    expect(identicalPrompt.goldCarried).toBe(0);
  });

  it('quotes a sign test consistent with its own up and down counts', () => {
    const { changedPrompt } = reading.paired.buckets;

    // The exact one-sided sign test at `down === 0` is 2^-up; `tools/readout-arm-run.py` prints the
    // two-sided value, which is twice this. Recomputed here so the quoted p cannot drift away from the
    // counts it was computed from.
    const oneSided = Math.pow(2, -changedPrompt.up);
    expect(oneSided).toBeCloseTo(0.0078, 4);
    expect(oneSided * 2).toBeCloseTo(0.0156, 4);
  });

  it('reports the first repetition and the four-pass mean as two scales, not one', () => {
    const { controlCorrect, treatmentCorrect } = reading.repetition1;
    const { control, treatment } = reading.fourPass;

    // Each repetition-1 count has to sit inside its own arm's four-pass range, or the two numbers are
    // not the same experiment.
    expect(controlCorrect).toBeGreaterThanOrEqual(control.min);
    expect(controlCorrect).toBeLessThanOrEqual(control.max);
    expect(treatmentCorrect).toBeGreaterThanOrEqual(treatment.min);
    expect(treatmentCorrect).toBeLessThanOrEqual(treatment.max);

    // The mean delta is smaller than the first-pass delta, which is the fact that stops the larger
    // number being quoted as the effect.
    expect(treatment.avg - control.avg).toBeLessThan(treatmentCorrect - controlCorrect);
    expect(treatment.avg - control.avg).toBeCloseTo(4.25, 2);
  });

  it('accounts for the conversions in the failure taxonomy', () => {
    const moved = reading.paired.up - reading.paired.down;

    expect(total(reading.failureStates.control)).toBe(13);
    expect(total(reading.failureStates.treatment)).toBe(5);
    expect(total(reading.failureStates.control) - total(reading.failureStates.treatment)).toBe(
      moved,
    );
    // `long_prose` is the state the contract was written for, and it is where most of the movement is.
    expect(
      reading.failureStates.control.long_prose - reading.failureStates.treatment.long_prose,
    ).toBe(6);
  });

  it('keeps every conversion on a question whose evidence did not also move', () => {
    const drifted = new Set(reading.singleVariable.evidenceDrifted);

    expect(reading.singleVariable.conversionsOnDriftedQuestions).toBe(0);
    expect(reading.singleVariable.questionsWithIdenticalEvidence + drifted.size).toBe(
      reading.population.preferenceQuestions,
    );
    // The block's own length, which is what "only the contract moved" means to the character.
    expect(reading.singleVariable.deliveredPromptDeltaChars).toBe(125);
  });

  it('derives the prompt-token figure from the token count and the pass count it names', () => {
    const passes = reading.repetition1.total * 4;
    const derived = reading.cost.featurePromptTokens / passes;

    expect(derived).toBeCloseTo(reading.cost.promptTokensPerQuestion, 2);
    // The call count C3 registered as `unchanged` came out below the control's, which is the direction
    // the criterion was protecting: the points were not bought with extra calls.
    expect(reading.cost.llmCalls / passes).toBeCloseTo(reading.cost.callsPerQuestionPass, 2);
    expect(reading.cost.callsPerQuestionPass).toBeLessThan(
      reading.cost.controlCallsPerQuestionPass,
    );
  });
});
