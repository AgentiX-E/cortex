#!/usr/bin/env node
/**
 * The shape of a within-job pair: what the treatment added, per question, and what it cost.
 *
 * ## Why this is a reader and not a dispatch
 *
 * `PREREG-TURN-FILL.md` §9.1 records `P1` as **partly verified**: the configuration reached the
 * artifact and twelve questions flipped at `temperature 0`, so at least twelve prompts differed --
 * but the *shape* that section predicts (215 questions up, 285 unchanged) lives in the per-question
 * vectors, and the artifact carrying them is 63 MB. The first attempt to read it was a download that
 * moved at 25 KB/s, which is forty minutes to read four hundred kilobytes of integers. That is the
 * instrument being the bottleneck for the third time in this campaign, and the repair is the same one
 * `prompt-digest-pair.yml` was built for: put the reading where the artifact already is.
 *
 * So this file computes the shape from any pair report, on a runner or in a sandbox, in one pass.
 *
 * ## What it can read, and the one thing it cannot
 *
 * The pair artifact carries `questions[].promptChars` on the treatment side and
 * `ablation.baselinePromptChars` -- the **length** of the control side's prompt -- and nothing else
 * about the control's prompt. So "the prompt did not change" is read here as **"the prompt's length
 * did not change"**, and the distinction is not pedantic: §9.1's twelve flips at `temperature 0`
 * prove that two prompts of equal length can differ, and this tool prints how many of those flips
 * happened on questions whose length was level. If any did, then a level length is not evidence of an
 * unchanged prompt, and the 285 in `P1` is an upper bound on identity rather than a count of it.
 *
 * The gap is closed for artifacts written after `ablation.baselinePromptDigests` existed: the control's
 * prompt text is already captured by the arm, so its fingerprint is a hash of a string the arm is
 * holding, sixteen hex characters per question rather than the 12 MB the texts would cost. This tool
 * reads that vector when it is present and reports **`identity: unreadable`** when it is not, so an
 * artifact that predates the field is labelled weaker rather than silently read as if a level length had
 * settled the question.
 *
 * ## The gates: passed, breached, or unreadable -- never assumed
 *
 * §4 of the pre-registration lists five gates. Each is evaluated against the fields it names, and a
 * gate whose field is absent is reported **unreadable with the field named**, because the alternative
 * -- defaulting a missing vector to zero -- is how a validation that cannot fail gets written.
 * `population` is the one gate that cannot be evaluated exactly from the artifact: it is phrased over
 * the 215 questions the room census named as having slack, and the artifact does not carry that set.
 * It is therefore reported as a **necessary** condition over the whole population and labelled so.
 *
 * ## Which breaches are meant to turn a job red
 *
 * `--fail-on-defect` exits `1` when `internal control` or `guard` breaches and stays `0` otherwise. The
 * split is not arbitrary: those two are the gates whose breach means the code is wrong rather than the
 * arm being unprofitable. `population` and `cost` breach on a legitimate negative result -- a fill that
 * spends nothing is a reading, and a job that goes red for it trains its reader to ignore red. A
 * refusal always exits non-zero, because an artifact the instrument cannot read is not a result.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export class Refusal extends Error {}

const PASS = 'pass';
const BREACH = 'breach';
const UNREADABLE = 'unreadable';

/** The registered thresholds, from `PREREG-TURN-FILL.md` §4. Named once, quoted by every gate. */
export const GATES = {
  /** `multi-session`: the room the cap left, measured per question. */
  internalControlMaxDelta: 108,
  /** mean `promptChars` up, over the population. */
  costMeanDelta: 627,
  /** the bill, treatment over control. */
  costBillRatio: 1.02,
  /** questions whose prompt rose. Necessary over 500, phrased over 215. */
  populationRise: 200,
  /** the largest single-capability drop, in questions, that §13.72 tolerates. */
  guardCapabilityDrop: 3,
};

/** The gates whose breach is a defect rather than a reading. See the header. */
export const DEFECT_GATES = ['internal control', 'guard'];

/**
 * What a million tokens cost, in CNY, by the class the provider bills it as.
 *
 * The same three numbers `PREREG-TURN-FILL.md` §8 used to project this dispatch, and the reason money
 * and tokens are two readings rather than one: a cached input token costs **one tenth** of an uncached
 * one. `MEASURE-SPEND-MINIMUM.md` §206.5 forbids rebuilding a rate from `llmUsage` totals, because a
 * total cannot say which tokens were cache hits; this applies the published rate to the split the
 * artifact *does* carry, which is the opposite direction and is what the dispatcher's projection does.
 */
export const RATES_CNY_PER_MILLION = { cachedInput: 0.2, input: 2.0, output: 3.0 };

function refuse(message) {
  throw new Refusal(message);
}

/**
 * The control side's prompt lengths, or a refusal that says which pairing produced the absence.
 *
 * A `reference` pairing evaluates the baseline as an archived pipeline that exposes no prompt, so its
 * vector is present and all-`null` -- 500 entries of "no reading" rather than an absent field. Both
 * shapes reach here as "cannot be paired", and both have to be refused rather than summarised: an
 * all-null vector averaged with `?? 0` would produce 500 identical prompts and a shape table that says
 * the treatment changed nothing, which is exactly the null this file exists to keep honest.
 */
function controlLengths(report, count) {
  const ablation = report.ablation ?? {};
  const vector = ablation.baselinePromptChars;
  if (!Array.isArray(vector)) {
    refuse(
      'ablation.baselinePromptChars is absent: this artifact has no control side in the job, so it ' +
        'is not a within-job pair and there is no shape to read',
    );
  }
  if (vector.length !== count) {
    refuse(
      `ablation.baselinePromptChars has ${vector.length} entries against ${count} questions: the ` +
        'vectors are not in one order, so a per-question comparison would pair a question with ' +
        "another question's prompt",
    );
  }
  const readable = vector.filter((value) => typeof value === 'number').length;
  if (readable === 0) {
    const pairing = ablation.featureConfig ?? report.featureConfig ?? {};
    refuse(
      'ablation.baselinePromptChars is present and carries no number: the baseline side of this ' +
        `pairing (${JSON.stringify(pairing)}) exposes no prompt length, so the shape is unknown ` +
        'rather than flat',
    );
  }
  return vector;
}

/**
 * Per-question deltas, with the capability and route each one belongs to.
 *
 * ## The two field names that look like twins and are not
 *
 * `ablation.baselinePromptChars` is the **whole** prompt the control's reader was sent: it is
 * `baseFirst.promptTexts.map(text => text.length)`. `questions[].promptChars` is that side's
 * **evidence** characters, and `questions[].deliveredPromptChars` is the whole prompt. The first
 * version of this file compared the control's total against the treatment's evidence and reported 333
 * questions **falling** by a mean of 306 characters -- a number that is almost exactly the prompt
 * overhead (median 669 over 500 questions), which is what a constant bias looks like when it is
 * mistaken for a reading.
 *
 * So the treatment side is `deliveredPromptChars` here, and an artifact without it is refused rather
 * than silently read through the wrong field.
 */
function rows(report, control) {
  return report.questions.map((question, index) => {
    const feature = question.deliveredPromptChars;
    if (typeof feature !== 'number') {
      refuse(
        `questions[${index}] (${question.questionId ?? 'unnamed'}) carries no deliveredPromptChars: ` +
          'the control side of this pair records the whole prompt, so comparing it with the ' +
          "treatment's evidence characters would subtract two different quantities",
      );
    }
    const before = control[index];
    if (typeof before !== 'number') {
      return {
        questionId: question.questionId ?? `#${index}`,
        capability: question.capability ?? '?',
        route: question.route ?? '?',
        control: null,
        feature,
        delta: null,
      };
    }
    return {
      questionId: question.questionId ?? `#${index}`,
      capability: question.capability ?? '?',
      route: question.route ?? '?',
      control: before,
      feature,
      delta: feature - before,
    };
  });
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** `delta` is `feature - control`; "level" is `0`, and level is not identity -- see the header. */
function shapeOf(pairs) {
  const comparable = pairs.filter((row) => row.delta !== null);
  const rose = comparable.filter((row) => row.delta > 0);
  const level = comparable.filter((row) => row.delta === 0);
  const fell = comparable.filter((row) => row.delta < 0);
  const deltas = comparable.map((row) => row.delta);
  const worst = comparable.reduce(
    (best, row) => (best === null || row.delta > best.delta ? row : best),
    null,
  );
  return {
    compared: comparable.length,
    unpaired: pairs.length - comparable.length,
    rose: rose.length,
    level: level.length,
    fell: fell.length,
    charactersAdded: deltas.reduce((sum, delta) => sum + delta, 0),
    meanDelta: comparable.length === 0 ? null : Math.round((deltas.reduce((a, b) => a + b, 0) / comparable.length) * 10) / 10,
    medianDelta: median(deltas),
    maxDelta: worst === null ? null : worst.delta,
    maxDeltaQuestion: worst === null ? null : worst.questionId,
  };
}

/** A table of one grouping key, sorted by characters added so the biggest mover is the first row. */
function groupBy(pairs, key) {
  const groups = new Map();
  for (const row of pairs) {
    if (row.delta === null) continue;
    const bucket = groups.get(row[key]) ?? { key: row[key], rose: 0, level: 0, fell: 0, added: 0 };
    if (row.delta > 0) bucket.rose += 1;
    else if (row.delta < 0) bucket.fell += 1;
    else bucket.level += 1;
    bucket.added += row.delta;
    groups.set(row[key], bucket);
  }
  return [...groups.values()].sort((a, b) => b.added - a.added);
}

/**
 * The flips that happened while the prompt's length was level.
 *
 * This is the reading the header says cannot be taken any other way. `temperature 0` means one prompt
 * has one answer, so a question that moved was sent a different prompt; if its length is unchanged,
 * then equal length did not mean equal prompt. The count is therefore a lower bound on how many
 * level-length questions are not byte-identical, and it is the reason `P1`'s 285 is reported as an
 * upper bound rather than a count.
 */
function levelFlips(report, pairs) {
  const discordant = report.ablation?.discordantQuestions;
  if (discordant === undefined || discordant === null) {
    return { readable: false, reason: 'ablation.discordantQuestions is absent' };
  }
  const byId = new Map(pairs.map((row) => [row.questionId, row]));
  const moved = [
    ...(discordant.baselineCorrectFeatureIncorrect ?? []),
    ...(discordant.baselineIncorrectFeatureCorrect ?? []),
  ];
  const unknown = moved.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    return {
      readable: false,
      reason: `discordantQuestions names ${unknown.length} question(s) absent from questions[]`,
    };
  }
  const level = moved.filter((id) => byId.get(id).delta === 0);
  return {
    readable: true,
    moved: moved.length,
    level: level.length,
    levelQuestionIds: level,
  };
}

/**
 * Which questions were sent the same bytes, when the artifact can say.
 *
 * The cross-tabulation is the point: `identical` and `changed` alone would leave the interesting cell
 * unnamed -- the questions whose **length** was level and whose **prompt** was not. That cell is the
 * existence proof that a length comparison is an upper bound on identity, and on run `45923435343` it is
 * non-empty by construction (twelve flips at `temperature 0`), which is why `P1`'s 285 is reported as a
 * bound rather than a count.
 */
function identityOf(report, pairs) {
  const digests = report.ablation?.baselinePromptDigests;
  if (!Array.isArray(digests)) {
    return {
      readable: false,
      reason:
        'ablation.baselinePromptDigests is absent: this artifact predates the field, so "same length" ' +
        'cannot be separated from "same prompt" here',
    };
  }
  if (digests.length !== pairs.length) {
    return {
      readable: false,
      reason: `ablation.baselinePromptDigests has ${digests.length} entries against ${pairs.length} questions`,
    };
  }
  let identical = 0;
  let changed = 0;
  let changedAtLevelLength = 0;
  let identicalAtChangedLength = 0;
  const changedIds = [];
  pairs.forEach((row, index) => {
    const before = digests[index];
    const after = report.questions[index].promptDigest;
    if (typeof before !== 'string' || typeof after !== 'string') return;
    if (before === after) {
      identical += 1;
      if (row.delta !== null && row.delta !== 0) identicalAtChangedLength += 1;
    } else {
      changed += 1;
      changedIds.push(row.questionId);
      if (row.delta === 0) changedAtLevelLength += 1;
    }
  });
  return {
    readable: true,
    identical,
    changed,
    changedAtLevelLength,
    identicalAtChangedLength,
    changedIds,
  };
}

/**
 * The prompt overhead, so a reader can see the two quantities are different.
 *
 * `deliveredPromptChars - promptChars` is the instruction block, the question and the framing: a median
 * of **669** characters over run `45923435343`'s 500 questions, which is the size of the bias the first
 * version of this tool was reading as a delta.
 */
function overheadOf(report) {
  const values = report.questions
    .map((question) => {
      const delivered = question.deliveredPromptChars;
      const evidence = question.promptChars;
      return typeof delivered === 'number' && typeof evidence === 'number' ? delivered - evidence : null;
    })
    .filter((value) => value !== null);
  return values.length === 0 ? null : median(values);
}

/** The bill, both sides, from the arm's own counters rather than from a rate applied to tokens. */
function billOf(report) {
  const sides = report.usageBySide;
  if (sides === undefined || sides === null) {
    return { readable: false, reason: 'usageBySide is absent' };
  }
  if (sides.baseline === undefined || sides.feature === undefined) {
    return { readable: false, reason: 'usageBySide does not carry both sides' };
  }
  const total = (side) => side.promptTokens + side.completionTokens;
  const control = total(sides.baseline);
  const feature = total(sides.feature);
  if (control === 0) {
    return { readable: false, reason: 'the control side reports no tokens, so the ratio is undefined' };
  }
  const money = (side) => {
    const cached = side.cacheHitPromptTokens;
    if (typeof cached !== 'number') return null;
    const uncached = side.promptTokens - cached;
    if (uncached < 0) return null;
    return (
      (cached / 1e6) * RATES_CNY_PER_MILLION.cachedInput +
      (uncached / 1e6) * RATES_CNY_PER_MILLION.input +
      (side.completionTokens / 1e6) * RATES_CNY_PER_MILLION.output
    );
  };
  const controlMoney = money(sides.baseline);
  const featureMoney = money(sides.feature);
  return {
    readable: true,
    controlTokens: control,
    featureTokens: feature,
    promptTokens: { control: sides.baseline.promptTokens, feature: sides.feature.promptTokens },
    cacheHitPromptTokens: {
      control: sides.baseline.cacheHitPromptTokens ?? null,
      feature: sides.feature.cacheHitPromptTokens ?? null,
    },
    cacheShare: {
      control:
        typeof sides.baseline.cacheHitPromptTokens === 'number'
          ? Math.round((sides.baseline.cacheHitPromptTokens / sides.baseline.promptTokens) * 1000) / 1000
          : null,
      feature:
        typeof sides.feature.cacheHitPromptTokens === 'number'
          ? Math.round((sides.feature.cacheHitPromptTokens / sides.feature.promptTokens) * 1000) / 1000
          : null,
    },
    money: { control: controlMoney, feature: featureMoney },
    moneyRatio:
      controlMoney === null || featureMoney === null || controlMoney === 0
        ? null
        : Math.round((featureMoney / controlMoney) * 10000) / 10000,
    ratio: Math.round((feature / control) * 10000) / 10000,
  };
}

/** The largest drop any capability took, in questions, from the two sides' own metrics. */
function capabilityGuard(report) {
  const baseline = report.baseline?.metrics?.perCapability;
  const feature = report.feature?.metrics?.perCapability;
  if (baseline === undefined || feature === undefined) {
    return { readable: false, reason: 'baseline.metrics.perCapability or feature.metrics.perCapability is absent' };
  }
  const drops = Object.keys(baseline).map((capability) => ({
    capability,
    delta: (feature[capability]?.correct ?? 0) - (baseline[capability]?.correct ?? 0),
  }));
  const worst = drops.reduce((best, row) => (best === null || row.delta < best.delta ? row : best), null);
  return { readable: true, worst, drops };
}

/**
 * Every gate `PREREG-TURN-FILL.md` §4 names, each with its own verdict.
 *
 * A gate is `unreadable` when the field it needs is absent, and the reason names the field. That is
 * the whole design: the three states exist so that "I could not check" can never be printed as "it
 * held".
 */
export function gates(report, shape, pairs, bill, guard) {
  const multiSession = pairs.filter((row) => row.route === 'multi-session' && row.delta !== null);
  const internal = multiSession.reduce(
    (best, row) => (best === null || row.delta > best.delta ? row : best),
    null,
  );
  // The superset property is per question, so **any** fall on this route is a breach -- and a
  // largest-rise reducer cannot see one, because a question that rose masks a question that fell.
  // Both halves are computed and the fall is checked first, since it is the more serious of the two.
  const internalFall = multiSession
    .filter((row) => row.delta < 0)
    .sort((a, b) => a.delta - b.delta)[0];

  // On `multi-session` the control's whole window fits, so the fill has nothing to add and cannot
  // remove anything either. The bound is two-sided for that reason: above `108` the treatment reached
  // room the cap had already taken (which cannot happen), and below `0` it delivered **less** than the
  // prefix did, which is the superset property failing rather than the arm being cheap. A one-sided
  // upper bound would print PASS over a defect, which is the shape `§208.10` records.
  const internalVerdict =
    internal === null
      ? UNREADABLE
      : internalFall !== undefined || internal.delta > GATES.internalControlMaxDelta
        ? BREACH
        : PASS;
  const internalDetail =
    internal === null
      ? 'no question on the multi-session route carries both lengths'
      : internalFall !== undefined
        ? `multi-session fell by ${-internalFall.delta} characters (${internalFall.questionId}): the ` +
          'fill delivered less room than the prefix on a route where the prefix loses nothing, so the ' +
          'superset property failed rather than the arm being cheap'
        : `largest rise on multi-session is ${internal.delta} characters (${internal.questionId}) against the cap's ${GATES.internalControlMaxDelta}`;

  return [
    { gate: 'internal control', verdict: internalVerdict, detail: internalDetail },
    {
      gate: 'superset',
      verdict: UNREADABLE,
      detail:
        'not readable from a pair artifact: the control side records its prompt length and not the ' +
        'turns it delivered, so containment is proven at selection time and asserted by ' +
        'evidence-turn-fill.test.ts on four corpora. The artifact can only show that the treatment ' +
        'never delivered less room, which is the `cost` row',
    },
    {
      // The registered bound is evaluated on **tokens**, and the reason is an audit rather than a
      // preference. `AUDIT-CACHE-CREDIT.md` §0 measured this artifact's `cacheHitPromptTokens` against the
      // prompts it claims to describe: the control side was credited **96.4%** of its prompt tokens on a
      // shard whose 63 prompts share **22 characters** of prefix at the longest, and on a run whose own two
      // repetitions bound the achievable credit at 50%. A byte-identical repeat is credited 82.7%, not
      // 100%. A price built on that counter cannot veto a mechanism -- it refused `resolution: 'layered'`
      // at 1.55x and the mechanism was adopted anyway, at +0.07% prompt tokens.
      //
      // This file first evaluated the bound on money (cached input at a tenth of uncached), read **2.357**
      // on this dispatch, and would have reported a 2.36x cost increase that the counter cannot support.
      // The money row is printed below as a diagnostic and is never a verdict.
      gate: 'cost: bill',
      verdict: bill.readable ? (bill.ratio <= GATES.costBillRatio ? PASS : BREACH) : UNREADABLE,
      detail: bill.readable
        ? `treatment/control tokens is ${bill.ratio} against ${GATES.costBillRatio}`
        : bill.reason,
    },
    {
      // The number a price would need, and the reason it is not one: see the `cost: bill` row.
      gate: 'cost: money (diagnostic)',
      verdict: UNREADABLE,
      detail:
        bill.readable && bill.moneyRatio !== null
          ? `a cache-weighted price reads ${bill.moneyRatio} (${bill.money.control.toFixed(2)} against ` +
            `${bill.money.feature.toFixed(2)} CNY) because the credited cache-hit share moved ` +
            `${bill.cacheShare.control} to ${bill.cacheShare.feature}. NOT A READING: ` +
            'AUDIT-CACHE-CREDIT.md measured this counter against the prompts and it cannot produce the ' +
            'credit it reports'
          : 'the cache split is absent on a side, so no price can be computed at all',
    },
    {
      gate: 'cost: prompt growth',
      verdict:
        shape.meanDelta === null
          ? UNREADABLE
          : shape.meanDelta <= GATES.costMeanDelta
            ? PASS
            : BREACH,
      detail:
        shape.meanDelta === null
          ? 'no paired question'
          : `mean delta is ${shape.meanDelta} characters against ${GATES.costMeanDelta}`,
    },
    {
      gate: 'population',
      verdict: shape.compared === 0 ? UNREADABLE : shape.rose >= GATES.populationRise ? PASS : BREACH,
      detail:
        `${shape.rose} of ${shape.compared} rose, against a floor of ${GATES.populationRise}. ` +
        'NECESSARY AND NOT SUFFICIENT: the registered form is "at least 200 of the 215 census ' +
        'questions", and the census set is not on the artifact -- a run could clear this row and ' +
        'still miss the named population',
    },
    {
      gate: 'guard',
      verdict: guard.readable
        ? guard.worst.delta > -GATES.guardCapabilityDrop
          ? PASS
          : BREACH
        : UNREADABLE,
      detail: guard.readable
        ? `largest capability drop is ${-guard.worst.delta} (${guard.worst.capability}) against ${GATES.guardCapabilityDrop}`
        : guard.reason,
    },
  ];
}

/** The whole reading, as data. Every field is derived from the artifact; nothing is defaulted. */
export function readout(report) {
  const questions = report.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    refuse('questions[] is absent or empty: this artifact is not a per-question report');
  }
  const control = controlLengths(report, questions.length);
  const pairs = rows(report, control);
  const shape = shapeOf(pairs);
  const bill = billOf(report);
  const guard = capabilityGuard(report);
  return {
    dataset: report.dataset ?? null,
    questionCount: questions.length,
    shape,
    byCapability: groupBy(pairs, 'capability'),
    byRoute: groupBy(pairs, 'route'),
    levelFlips: levelFlips(report, pairs),
    identity: identityOf(report, pairs),
    overheadMedian: overheadOf(report),
    bill,
    capability: guard,
    gates: gates(report, shape, pairs, bill, guard),
    unpairedQuestionIds: pairs.filter((row) => row.delta === null).map((row) => row.questionId),
  };
}

function pad(text, width, right = false) {
  const value = String(text);
  return right ? value.padStart(width) : value.padEnd(width);
}

function table(result) {
  const lines = [];
  const { shape } = result;
  lines.push(`pair shape -- ${result.dataset ?? 'unknown dataset'}, ${result.questionCount} questions`);
  lines.push(
    `  compared ${shape.compared}   rose ${shape.rose}   level ${shape.level}   fell ${shape.fell}` +
      (shape.unpaired === 0 ? '' : `   unpaired ${shape.unpaired}`),
  );
  lines.push(
    `  characters added ${shape.charactersAdded}   mean ${shape.meanDelta}   median ${shape.medianDelta}` +
      `   max ${shape.maxDelta} (${shape.maxDeltaQuestion})`,
  );
  if (result.overheadMedian !== null) {
    lines.push(
      `  prompt overhead (delivered minus evidence) median ${result.overheadMedian}: the control side ` +
        'records the whole prompt, so this is what a comparison against `promptChars` would subtract',
    );
  }
  if (result.identity.readable) {
    lines.push(
      `  identity: ${result.identity.identical} identical prompts, ${result.identity.changed} changed, ` +
        `${result.identity.changedAtLevelLength} of them at a level length`,
    );
  } else {
    lines.push(`  identity: unreadable -- ${result.identity.reason}`);
  }
  if (result.levelFlips.readable) {
    lines.push(
      `  flips at temperature 0: ${result.levelFlips.moved}, of which ${result.levelFlips.level} on a ` +
        'level length -- equal length is not equal prompt',
    );
  } else {
    lines.push(`  flips: unreadable -- ${result.levelFlips.reason}`);
  }
  if (result.bill.readable) {
    lines.push(
      `  bill: control ${result.bill.controlTokens} tokens, treatment ${result.bill.featureTokens}, ` +
        `ratio ${result.bill.ratio}`,
    );
    if (result.bill.moneyRatio !== null) {
      lines.push(
        `  price (diagnostic, not money): control ${result.bill.money.control.toFixed(2)} CNY, treatment ` +
          `${result.bill.money.feature.toFixed(2)} CNY, ratio ${result.bill.moneyRatio}; the credited ` +
          `cache-hit share moved ${result.bill.cacheShare.control} to ${result.bill.cacheShare.feature}`,
      );
    }
  } else {
    lines.push(`  bill: unreadable -- ${result.bill.reason}`);
  }
  const groupTable = (title, groups) => {
    lines.push('', title);
    lines.push(`  ${pad('group', 18)}${pad('rose', 6, true)}${pad('level', 7, true)}${pad('fell', 6, true)}${pad('added', 9, true)}`);
    for (const group of groups) {
      lines.push(
        `  ${pad(group.key, 18)}${pad(group.rose, 6, true)}${pad(group.level, 7, true)}${pad(group.fell, 6, true)}${pad(group.added, 9, true)}`,
      );
    }
  };
  groupTable('by capability', result.byCapability);
  groupTable('by route', result.byRoute);
  lines.push('', 'gates (PREREG-TURN-FILL.md §4)');
  for (const gate of result.gates) {
    lines.push(`  ${pad(gate.verdict.toUpperCase(), 12)}${pad(gate.gate, 24)}${gate.detail}`);
  }
  return lines.join('\n');
}

function selfTest() {
  const errors = [];
  let count = 0;
  const eq = (label, actual, expected) => {
    count += 1;
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      errors.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  };

  const base = () => ({
    dataset: 'fixture',
    questions: [
      { questionId: 'a', capability: 'MR', route: 'multi-session', deliveredPromptChars: 110, promptChars: 60 },
      { questionId: 'b', capability: 'MR', route: 'multi-session', deliveredPromptChars: 100, promptChars: 55 },
      { questionId: 'c', capability: 'IE', route: 'flat', deliveredPromptChars: 300, promptChars: 150 },
      { questionId: 'd', capability: 'IE', route: 'flat', deliveredPromptChars: 250, promptChars: 120 },
    ],
    ablation: {
      baselinePromptChars: [100, 100, 200, null],
      discordantQuestions: { baselineCorrectFeatureIncorrect: ['b'], baselineIncorrectFeatureCorrect: [] },
    },
    baseline: { metrics: { perCapability: { MR: { correct: 2 }, IE: { correct: 2 } } } },
    feature: { metrics: { perCapability: { MR: { correct: 1 }, IE: { correct: 2 } } } },
    usageBySide: {
      baseline: { promptTokens: 1000, completionTokens: 10, cacheHitPromptTokens: 900 },
      feature: { promptTokens: 1010, completionTokens: 10, cacheHitPromptTokens: 900 },
    },
  });

  const result = readout(base());
  eq('compared excludes the unpaired question', result.shape.compared, 3);
  eq('unpaired is named', result.unpairedQuestionIds, ['d']);
  eq('rose counts the two rises', result.shape.rose, 2);
  eq('level counts the one level', result.shape.level, 1);
  eq('fell is empty', result.shape.fell, 0);
  eq('characters added is the sum of deltas', result.shape.charactersAdded, 10 + 0 + 100);
  eq('median of 10, 0, 50', result.shape.medianDelta, 10);
  eq('max delta question', result.shape.maxDeltaQuestion, 'c');
  eq('a flip on a level length is counted', result.levelFlips.level, 1);
  eq('and the total moved is one', result.levelFlips.moved, 1);
  eq('bill ratio rounds to four places', result.bill.ratio, 1.0099);
  eq('guard finds MR dropping one', result.capability.worst.capability, 'MR');
  eq(
    'internal control passes at 10 against 108',
    result.gates.find((gate) => gate.gate === 'internal control').verdict,
    PASS,
  );
  eq(
    'population fails at 2 against 200',
    result.gates.find((gate) => gate.gate === 'population').verdict,
    BREACH,
  );
  eq(
    'superset is always unreadable from a pair artifact',
    result.gates.find((gate) => gate.gate === 'superset').verdict,
    UNREADABLE,
  );

  const refused = (label, mutate) => {
    count += 1;
    const report = base();
    mutate(report);
    try {
      readout(report);
      errors.push(`${label}: expected a refusal, got a reading`);
    } catch (error) {
      if (!(error instanceof Refusal)) errors.push(`${label}: refused with ${error?.name ?? typeof error}`);
    }
  };
  refused('no control vector at all', (report) => {
    delete report.ablation.baselinePromptChars;
  });
  refused('a control vector of the wrong length', (report) => {
    report.ablation.baselinePromptChars = [1, 2];
  });
  refused('an all-null control vector', (report) => {
    report.ablation.baselinePromptChars = [null, null, null, null];
  });
  refused('a question with no delivered prompt', (report) => {
    delete report.questions[0].deliveredPromptChars;
  });
  refused('a question with only evidence characters', (report) => {
    delete report.questions[0].deliveredPromptChars;
    report.questions[0].promptChars = 110;
  });
  refused('no per-question records', (report) => {
    report.questions = [];
  });

  // A gate whose field is missing must say so, not pass.
  const noBill = base();
  delete noBill.usageBySide;
  const noBillResult = readout(noBill);
  eq(
    'a missing bill is unreadable rather than within budget',
    noBillResult.gates.find((gate) => gate.gate === 'cost: bill').verdict,
    UNREADABLE,
  );
  const noGuard = base();
  delete noGuard.feature.metrics;
  eq(
    'a missing capability census is unreadable rather than clean',
    readout(noGuard).gates.find((gate) => gate.gate === 'guard').verdict,
    UNREADABLE,
  );
  const noFlips = base();
  delete noFlips.ablation.discordantQuestions;
  eq('a missing discordant census refuses to claim flips', readout(noFlips).levelFlips.readable, false);

  // Fingerprints: the one cell that a length comparison cannot name is a changed prompt whose length
  // was level, and it has to be counted rather than folded into "level".
  const withDigests = base();
  withDigests.questions[0].promptDigest = 'aaaaaaaaaaaaaaaa';
  withDigests.questions[1].promptDigest = 'bbbbbbbbbbbbbbbb';
  withDigests.questions[2].promptDigest = 'cccccccccccccccc';
  withDigests.questions[3].promptDigest = 'dddddddddddddddd';
  withDigests.ablation.baselinePromptDigests = [
    'aaaaaaaaaaaaaaaa',
    'eeeeeeeeeeeeeeee',
    'ffffffffffffffff',
    null,
  ];
  const identity = readout(withDigests).identity;
  eq('one prompt is identical', identity.identical, 1);
  eq('two changed', identity.changed, 2);
  eq('one changed at a level length', identity.changedAtLevelLength, 1);
  eq('the changed ids are named', identity.changedIds, ['b', 'c']);
  eq('a missing digest vector is unreadable', readout(base()).identity.readable, false);

  if (errors.length > 0) {
    console.error(`pair-shape-readout self-test FAILED\n  ${errors.join('\n  ')}`);
    process.exitCode = 1;
    return;
  }
  console.log(`pair-shape-readout self-test: ${count} assertions, all passed`);
}

const invokedDirectly =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    selfTest();
  } else {
    const path = args.find((arg) => !arg.startsWith('--'));
    if (path === undefined) {
      console.error(
        'usage: node tools/pair-shape-readout.mjs <report.json> [--json] [--fail-on-defect] | --self-test',
      );
      process.exitCode = 2;
    } else {
      try {
        const result = readout(JSON.parse(readFileSync(path, 'utf8')));
        console.log(args.includes('--json') ? JSON.stringify(result, null, 2) : table(result));
        const defect = result.gates.find(
          (gate) => DEFECT_GATES.includes(gate.gate) && gate.verdict === BREACH,
        );
        if (args.includes('--fail-on-defect') && defect !== undefined) {
          console.error(`defect: ${defect.gate} breached -- ${defect.detail}`);
          process.exitCode = 1;
        }
      } catch (error) {
        if (error instanceof Refusal) {
          console.error(`refused: ${error.message}`);
          process.exitCode = 1;
        } else {
          throw error;
        }
      }
    }
  }
}
