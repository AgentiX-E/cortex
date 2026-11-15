#!/usr/bin/env node
/**
 * Two regrade readings of one artifact under two judges, and the decision rule that compares them.
 *
 *     node tools/judge-cross-vendor.mjs --same <reading.json> --cross <reading.json> [--out <file>]
 *
 * ## The question this answers, and the one it refuses to answer
 *
 * `I1`. The archived `Δ_judge` is `−3.2 points`: re-grading the recorded answers with
 * `deepseek-v4-pro` when `deepseek-chat` had graded them revoked 15 questions and rescued none. That
 * number is one sentence and it supports two readings:
 *
 *  * **stricter** -- a stronger judge demands more, so the arm is 15 questions worse than published;
 *  * **same-family** -- the artifact's judge and its reader are both DeepSeek, so a same-vendor judge
 *    may be reading a same-vendor reader kindly, and the 15 questions are the size of that kindness.
 *
 * Only a judge from another vendor can separate them, and the separation is arithmetic: `Δ` under
 * each judge, then the difference between the two `Δ`s. A gap of one question means strictness
 * explains the whole thing and favouritism is not detectable at this resolution; a gap above five
 * means `M1`'s 4.3 points are two effects and must be reported as two.
 *
 * ## Why the thresholds are here, as constants, and not in a document
 *
 * Because the plan wrote them as numbers in questions, and a rule that is applied by reading a
 * paragraph is applied differently by each reader. `≤1` and `>5` are the two lines; `2..5` is the
 * third state, and it is a state rather than something rounded to a neighbour because "not
 * detectable" and "detectable" are both false there.
 *
 * ## Why this is a tool and not a `--compare` flag on `judge-regrade.mjs`
 *
 * Because the comparison must be re-runnable for free. A mode inside the grading tool would need an
 * artifact and a judge in order to reach the comparison, so checking a published verdict would cost
 * another dispatch -- and a claim that cannot be re-checked without paying is a claim that gets
 * checked once. This reads two files and prints.
 *
 * ## What it refuses, and why each refusal is a real pair of readings that is not a comparison
 *
 *  * **one provider on both sides** -- that is not a cross-vendor comparison, and the gap it produces
 *    is a model difference wearing the name of a vendor difference;
 *  * **different populations** -- a `Δ` on 467 questions and one on 500 are not two measurements of
 *    one quantity, and the second is usually the first plus the questions the first could not grade;
 *  * **different recorded sides** -- same count of questions, different count of what the artifact
 *    called correct, means two artifacts or two filters, and neither is "the same questions twice";
 *  * **a reading with no `recordedCorrect`** -- the field is what makes `Δ` computable from the file.
 *    Reconstructing it from `artifactOnly`, `regradeOnly` and `ties` is not possible, because a tie's
 *    composition is not recorded, and a reconstructed number that is off by the two ties is exactly
 *    the size of the effect being looked for;
 *  * **a reading with no parse count** -- see below;
 *  * **more than one unreadable reply** -- `parseJudgeResponse` reads `false` for a reply it cannot
 *    parse, so an unreadable reply is counted as a rejection. One of them is inside the `≤1` decision
 *    it is being used for; more is not, and a `Δ` with five of them is a `Δ` between two reply
 *    formats until the grammar is widened.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

/**
 * The two lines the plan wrote down, in questions.
 *
 * `undetectableMax` is inclusive and `splitAbove` is strict, which is the reading of "`≤ 1`" and
 * "`> 5`" the plan states. Both boundaries are asserted from both sides in
 * `tools/__tests__/test_judge_cross_vendor.py`, because an off-by-one at a threshold changes a
 * published conclusion while every number in the table stays right.
 */
export const THRESHOLDS = { undetectableMax: 1, splitAbove: 5 };

/**
 * How many unreadable replies a reading may carry and still be used here.
 *
 * One, because one is the whole width of the `≤1` decision above: a single question of parser
 * ambiguity cannot move a gap across a boundary it is being compared to, and two can.
 */
export const MAX_UNREADABLE = 1;

function flag(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : (process.argv[index + 1] ?? '');
}

/**
 * A refusal: a message for stderr and an exit code that is not "the arithmetic came out zero".
 *
 * Named `ComparisonRefused` and not `Refusal` because `tools/` is inside the export census's walk and
 * the census attributes a caller by **name**, not by import: a local class called `Refusal` was
 * counted as a caller of `cortex-storage`'s exported `Refusal` type, which un-orphaned it in the
 * ledger without a single import. That is a limitation of the census worth knowing about (it is
 * recorded in `cortex-docs`'s audit notes) and not one to reproduce by choosing a shadowing name.
 */
class ComparisonRefused extends Error {}

/**
 * One reading, as the fields this comparison is entitled to read.
 *
 * The extraction is strict on purpose. A missing field is refused rather than defaulted, because
 * every default available here (`0` for a count, `'deepseek'` for a provider) is a value that would
 * produce a smooth-looking verdict from a file that does not say.
 */
export function describeReading(payload, label) {
  const reading = payload?.reading;
  const judge = payload?.judge;
  if (reading === undefined || judge === undefined) {
    throw new ComparisonRefused(
      `${label}: not a regrade reading (no ${reading === undefined ? '`reading`' : '`judge`'} block)`,
    );
  }
  const regrade = judge.regrade ?? {};
  const recorded = reading.recordedCorrect;
  if (typeof recorded !== 'number' || !Number.isInteger(recorded)) {
    throw new ComparisonRefused(
      `${label}: the reading does not record \`recordedCorrect\`. Two sides of a difference are what ` +
        'a difference is; re-take it with the current tools/judge-regrade.mjs, which writes the ' +
        'recorded side beside the re-graded one',
    );
  }
  const regraded = reading.regradedCorrect;
  if (typeof regraded !== 'number' || !Number.isInteger(regraded)) {
    throw new ComparisonRefused(`${label}: the reading does not record \`regradedCorrect\``);
  }
  if (typeof reading.judged !== 'number' || !Number.isInteger(reading.judged)) {
    throw new ComparisonRefused(`${label}: the reading does not record how many questions it judged`);
  }
  if (typeof regrade.providerId !== 'string' || regrade.providerId.trim() === '') {
    throw new ComparisonRefused(
      `${label}: the reading does not name the vendor of its judge (\`judge.regrade.providerId\`), ` +
        'so it cannot be compared with a judge from somewhere else',
    );
  }
  const unreadable = judge.parse?.unrecognised;
  if (typeof unreadable !== 'number' || !Number.isInteger(unreadable)) {
    throw new ComparisonRefused(
      `${label}: the reading does not say how many judge replies were \`unrecognised\`, and an ` +
        'unknown parse rate is not a zero one: a reply the parser cannot read is scored as a ' +
        'rejection, so this count is the upper bound on how much of the difference is format',
    );
  }
  if (unreadable > MAX_UNREADABLE) {
    throw new ComparisonRefused(
      `${label}: ${unreadable} judge replies were unrecognised, above the ${MAX_UNREADABLE} this ` +
        'comparison can tolerate. Widen the grammar against the recorded samples and re-take the ' +
        'reading; a gap measured with this many is a gap between two reply formats',
    );
  }
  return {
    label,
    selection: typeof regrade.selection === 'string' ? regrade.selection : null,
    providerId: regrade.providerId.trim(),
    judged: reading.judged,
    recordedCorrect: recorded,
    regradedCorrect: regraded,
    // Signed on purpose: `-15` says the judge revoked 15 more than it rescued, and a magnitude would
    // throw away the direction that makes "stricter" a hypothesis rather than a guess.
    delta: regraded - recorded,
    unreadable,
  };
}

/** The three states the gap can be in, and nothing between them. */
export function verdictFor(gapQuestions) {
  if (gapQuestions <= THRESHOLDS.undetectableMax) return 'favoritism-undetectable';
  if (gapQuestions > THRESHOLDS.splitAbove) return 'split-required';
  return 'inconclusive';
}

function pair(samePath, crossPath) {
  const same = describeReading(JSON.parse(readFileSync(samePath, 'utf8')), 'same-vendor');
  const cross = describeReading(JSON.parse(readFileSync(crossPath, 'utf8')), 'cross-vendor');
  if (same.providerId === cross.providerId) {
    throw new ComparisonRefused(
      `both readings name the same provider (${JSON.stringify(same.providerId)}): this comparison ` +
        'exists to separate strictness from same-family favouritism, and one family cannot do that',
    );
  }
  if (same.judged !== cross.judged || same.recordedCorrect !== cross.recordedCorrect) {
    throw new ComparisonRefused(
      `the two readings describe different populations: ${same.judged} judged / ` +
        `${same.recordedCorrect} recorded correct against ${cross.judged} / ` +
        `${cross.recordedCorrect}. Two deltas are only comparable on the same questions`,
    );
  }
  return { same, cross, gap: Math.abs(cross.delta - same.delta) };
}

function main() {
  const samePath = flag('--same');
  const crossPath = flag('--cross');
  if (!samePath || !crossPath) {
    console.error(
      'usage: judge-cross-vendor.mjs --same <reading.json> --cross <reading.json> [--out <file>]',
    );
    return 2;
  }
  let compared;
  try {
    compared = pair(samePath, crossPath);
  } catch (error) {
    if (error instanceof ComparisonRefused) {
      console.error(`refused: ${error.message}`);
      return 1;
    }
    throw error;
  }
  const { same, cross, gap } = compared;
  const verdict = verdictFor(gap);

  console.log(`population       ${same.judged} questions, ${same.recordedCorrect} recorded correct`);
  console.log('');
  console.log('reading        judge                          provider   delta');
  for (const reading of [same, cross]) {
    console.log(
      `  ${reading.label.padEnd(13)} ${String(reading.selection ?? '(unknown)').padEnd(30)} ` +
        `${reading.providerId.padEnd(10)} ${String(reading.delta).padStart(5)}`,
    );
  }
  console.log('');
  console.log(`gap              ${gap} question(s) between the two deltas`);
  console.log(
    `thresholds       undetectable <= ${THRESHOLDS.undetectableMax}, ` +
      `split > ${THRESHOLDS.splitAbove}, between is inconclusive`,
  );
  console.log(`verdict          ${verdict}`);
  const explanation = {
    'favoritism-undetectable':
      'the two judges move the artifact by the same number of questions to within one, so ' +
      'strictness explains the gap and same-family favouritism is not detectable here',
    inconclusive:
      'the gap is real but too small to decide between the two readings, and it is reported as ' +
      'inconclusive rather than rounded to either',
    'split-required':
      'the gap is larger than the decision line, so the published effect must be reported as two ' +
      'halves -- how much the reader is read better, and how much the judge reads wider',
  }[verdict];
  console.log(`                 ${explanation}`);

  const out = flag('--out');
  if (out) {
    const payload = {
      what: 'Two regrade readings of one artifact under two judges, and the gap between their deltas.',
      generatedAt: new Date().toISOString(),
      same,
      cross,
      gapQuestions: gap,
      thresholds: THRESHOLDS,
      maxUnreadable: MAX_UNREADABLE,
      verdict,
    };
    writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\nwrote ${out}`);
  }
  return 0;
}

if (process.argv[1] && process.argv[1].endsWith('judge-cross-vendor.mjs')) {
  process.exitCode = main();
}
