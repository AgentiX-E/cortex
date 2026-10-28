/**
 * What *kind* of change each discordant question represents, not just how many changed.
 *
 * ## The problem this solves
 *
 * A paired ablation already reports two counts: `bought` (wrong under the baseline, right under the
 * treatment) and `sold` (right under the baseline, wrong under the treatment). Both are correct, both are
 * printed, and together they still do not say which of two very different things happened:
 *
 * - the reader **started speaking** where it used to decline, or
 * - the reader **spoke correctly** where it used to speak wrongly.
 *
 * Both produce a bought question. The first is a change in response shape — the abstention path, the prompt,
 * the decline retry — and the second is a change in what the model knows or can find. A +3 net built from
 * four recovered and one declined is not the same finding as a +3 built from four corrected and one missed,
 * and no artifact in this repository could tell them apart: `correct` is a boolean, so "declined" and
 * "answered wrongly" are the same value everywhere downstream of the scorer.
 *
 * This module splits each side of the ledger along that line. The input it needs is already in hand — the two
 * sides' answers and their correctness vectors, aligned with the dataset — and the rule for a decline is the
 * one the scorer already uses: `answer === null`, which is what `metrics.ts` tests when it counts abstentions.
 * There is deliberately no second definition of "abstention" here; a private predicate would be able to
 * disagree with the scorer about the same answer, and that disagreement would be silent.
 *
 * ## The two flows, and why they are reported as pairs
 *
 * | | baseline answer | baseline declined |
 * | --- | --- | --- |
 * | **treatment answered** | `corrected` (bought) | `recovered` (bought) |
 * | **treatment declined** | `missed` (sold) | `declined` (sold) |
 *
 * `recovered` against `declined` is the **decline flow** — questions that crossed the abstention line in
 * either direction. `corrected` against `missed` is the **content flow** — questions that stayed on the
 * answering side and changed verdict. A net that is entirely decline flow says the increment moved the
 * response shape; a net that is entirely content flow says it moved what the system knows; a net that mixes
 * the two is a sum of two mechanisms and needs to be split before it is claimed as one.
 *
 * ## The identity this must satisfy
 *
 * `recovered + corrected` is exactly the bought count and `declined + missed` is exactly the sold count, so
 * this is a **refinement** of the paired counts and not a second measurement of them. `answer-transition.test.ts`
 * asserts the identity against the real `runAblation`, which is what keeps the refinement from drifting into
 * a rival definition: if the two ever disagree, one of them is wrong and the build says so.
 *
 * ## What this does not claim
 *
 * It does not say why a decline appeared or vanished: an over-length prompt, a stricter parse, a different
 * system prompt and a genuine refusal all arrive as `null`. `rawOutput` is the field that separates those,
 * and it is captured on the feature side only. This module answers "did the decline line move", which is the
 * question that decides whether to look at the raw output at all.
 */

import type { Answer, AnswerTransition } from './types.js';

export type { AnswerTransition };

type TransitionInput = {
  readonly baselineAnswers: readonly Answer[];
  readonly featureAnswers: readonly Answer[];
  readonly baselineCorrect: readonly boolean[];
  readonly featureCorrect: readonly boolean[];
};

/**
 * Classify every discordant question in a paired run.
 *
 * Concordant questions — right in both, wrong in both — are not counted at all: they carry no information
 * about a change, which is the same reason McNemar conditions on the discordant pairs. The denominators a
 * reader needs are on the result's own aggregates.
 *
 * Throws on a length mismatch rather than reading the shorter vector. The three vectors are aligned by
 * index with the dataset, so a mismatch means the caller paired two different question sets, and every
 * number this function could return from that input would be arithmetic over unpaired data that reads
 * exactly like a real result.
 */
export function classifyTransitions(input: TransitionInput): AnswerTransition {
  const { baselineAnswers, featureAnswers, baselineCorrect, featureCorrect } = input;
  const total = baselineCorrect.length;
  if (featureCorrect.length !== total) {
    throw new Error(
      `transition classification needs aligned correctness vectors, got ${total} baseline against ` +
        `${featureCorrect.length} feature — the two sides are not the same question set`,
    );
  }
  if (baselineAnswers.length !== total || featureAnswers.length !== total) {
    throw new Error(
      `transition classification needs one answer per question, got ${baselineAnswers.length} baseline ` +
        `and ${featureAnswers.length} feature answers against ${total} verdicts`,
    );
  }

  let recovered = 0;
  let corrected = 0;
  let declined = 0;
  let missed = 0;

  for (let index = 0; index < total; index += 1) {
    const before = baselineCorrect[index] === true;
    const after = featureCorrect[index] === true;
    if (before === after) continue;

    if (after) {
      // Bought. Which half of the ledger it belongs to is decided by whether the baseline spoke at all.
      // `=== null` and not a falsy test: an empty string is an answer the parser produced, and counting it
      // as a decline here would disagree with `metrics.ts` about the same question.
      if (baselineAnswers[index] === null) recovered += 1;
      else corrected += 1;
    } else if (featureAnswers[index] === null) {
      declined += 1;
    } else {
      missed += 1;
    }
  }

  return { recovered, corrected, declined, missed };
}

/**
 * Whether the net change is carried by the decline flow, the content flow, or both.
 *
 * ## Why this is a function and not a sentence in a report
 *
 * The distinction is the whole point of the split, and it is the thing a reader will get wrong when looking
 * at four numbers. `'decline'` means every question that changed verdict crossed the abstention line in one
 * direction or the other: the increment changed **whether** the system speaks. `'content'` means none did:
 * it changed **what** the system says. `'both'` means two mechanisms moved together, and the net is their
 * sum — which is the case where a net figure must not be reported as a single effect.
 *
 * `'none'` is the ordinary null result and is not a failure of this function: nothing changed, so nothing
 * carried the net, and the report says so rather than leaving an empty table to be interpreted.
 */
export function dominantFlow(
  transition: AnswerTransition,
): 'decline' | 'content' | 'both' | 'none' {
  const decline = transition.recovered + transition.declined;
  const content = transition.corrected + transition.missed;
  if (decline === 0 && content === 0) return 'none';
  if (content === 0) return 'decline';
  if (decline === 0) return 'content';
  return 'both';
}
