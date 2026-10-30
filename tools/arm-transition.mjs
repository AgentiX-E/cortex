#!/usr/bin/env node
/**
 * The criteria `§13.166.6` registered and `§13.174` amended, applied to a pair of artifacts.
 *
 * Six rows, not five. Two of the original five were replaced after the run they judged
 * (`41039779987`) showed what they were measuring: row 2 counted class movements among ten off-by-one
 * questions and reported five, all of which had byte-identical prompts; row 4 read total accuracy and
 * passed on +2.60 points of which +0.80 was attributable to the treatment and the rest was churn on
 * records the treatment never reached. Row 6 is new and measures the premise every cost column rests on --
 * that the repetitions resent the same bytes.
 *
 * ## Why this is a tool and not a paragraph of instructions
 *
 * The registration was written before the dispatch, in five rows, each with a threshold and a
 * consequence. Reading it by hand means comparing two printers' output question by question and
 * holding five conditions in a reader's head at once -- and the failure mode of that is not a wrong
 * verdict, it is a *confident* one: the population that converts is exactly the population a reader
 * is looking at, so the seven questions that moved are the ones that get noticed and the hundred and
 * fourteen that must not move are the ones that do not.
 *
 * Criterion 5 is the reason this cannot be a judgement call. It is an assembly check, not an outcome:
 * `promptChars` must differ on the seven named questions and be **equal** on every other MR record.
 * A change that helps and a change that leaks differ in exactly that column, and the leak is invisible
 * in any summary that reports a total.
 *
 * ## Why a non-applicable criterion is `skipped` rather than `fail`
 *
 * The thresholds are attached to populations: "at least 4 **of the 7**", "the **ten** off-by-one
 * questions". A tool that rescaled them for a different pair would report a verdict about a criterion
 * nobody registered; a tool that failed them would report a defect where the truth is that the
 * question was not asked. So each criterion carries `applicable`, computed from the before-state, and
 * the exit code counts only the ones that apply. The count of skipped criteria is printed, because a
 * reading in which four of five were skipped is a different document from one where five passed.
 *
 * ## The classification is imported, never restated
 *
 * `classify` and `censusOf` come from `mr-failure-census.mjs`, which is the same rule `§13.166.3`
 * registered and the same one `§13.166.7` pinned against the product's own shape classifier. A second
 * copy here would let this tool disagree with the census about the population it is measuring, and the
 * disagreement would look like an effect.
 */

import { readFileSync } from 'node:fs';
import { censusOf } from './mr-failure-census.mjs';

/** The registered thresholds, named once. `§13.166.6` and its `§13.174` amendments are where they change. */
const NAMED_MIN = 4;
const NAMED_POPULATION = 7;
const CAPABILITY_MAX_LOSS = 2;
/** `§13.174.3`. Losses allowed on the population the treatment actually reached, as a share of it. */
const CHANGED_MAX_LOSS_SHARE = 0.05;
/** `§13.174.4`. Net gain required on that same population, in points of the whole run. */
const ATTRIBUTABLE_MIN_POINTS = 1.0;
/** `§13.174.5`. Share of questions that must have sent one prompt on every pass. */
const REPEAT_PREMISE_MIN_SHARE = 0.95;

/**
 * Which registration this reading applies, printed rather than assumed.
 *
 * Two of the five rows were replaced after `41039779987` falsified them, and a tool that kept the old
 * numbers under the old name would let a later reader believe the run was judged by the registration it
 * was dispatched under. The row numbers are kept because they are the slots; the rules behind two of them
 * are not the rules the first registration stated.
 */
const CRITERIA_SOURCE =
  '§13.166.6 rows 1, 3, 5 as registered; row 2 superseded by §13.174.3 (losses on the reached population), ' +
  'row 4 by §13.174.4 (attributable points), row 6 new in §13.174.5 (the repeats were repeats)';

/**
 * A capability's correct count, as the average over the run's repeats.
 *
 * The average and not the single-run count, because a criterion that reads one draw of four is a
 * criterion about jitter: `40989420944`'s MR band is `83..86` over its four runs, so a `-3` on the
 * chosen draw can be inside the spread the arm already has and would be reported as a loss. The band
 * exists for exactly this reason -- `ablation.featureByCapability` carries `min`/`avg`/`max` -- and
 * `§13.82`'s per-capability line is the average too, which is what makes the registered count
 * comparable to it.
 *
 * The single-draw figure is returned beside it rather than instead of it, so the detail line can show
 * what the run's headline number moved by as well as what the band did.
 */
function featureCorrect(report, capability) {
  const band = report.ablation?.featureByCapability?.[capability];
  if (band !== undefined && typeof band.avg === 'number') return band.avg;
  const per = report.feature?.metrics?.perCapability?.[capability];
  if (per !== undefined && typeof per.correct === 'number') return per.correct;
  return undefined;
}

/** The count the run's own headline is built from, which is one draw rather than the band. */
function featureCorrectRun(report, capability) {
  const per = report.feature?.metrics?.perCapability?.[capability];
  return per !== undefined && typeof per.correct === 'number' ? per.correct : undefined;
}

/** Abstention-aware accuracy in points, which is the unit `§13.166.6` states the threshold in. */
function accuracyPoints(report) {
  const value = report.feature?.metrics?.abstentionAwareAccuracy;
  return typeof value === 'number' ? value * 100 : undefined;
}

/**
 * `promptVariants` by question id, for the records that carry the field.
 *
 * A missing key and a `null` value are different statements and both matter: missing means the run had one
 * pass, `null` means a pass declined to report its prompt. The first cannot be judged, the second is
 * evidence against the premise, so only the first is dropped.
 */
function promptVariantsById(report) {
  const map = new Map();
  for (const record of report.questions ?? []) {
    if (!Object.hasOwn(record, 'promptVariants')) continue;
    const value = record.promptVariants;
    map.set(record.questionId, typeof value === 'number' ? value : null);
  }
  return map;
}

/** `promptChars` by question id, from the record list rather than from the census. */
function promptCharsById(report) {
  const map = new Map();
  for (const record of report.questions ?? []) {
    if (typeof record.promptChars === 'number') map.set(record.questionId, record.promptChars);
  }
  return map;
}

/**
 * The witness's own reading: which bytes the passes do not share.
 *
 * A count says the prompts diverged; this says **where**, and the difference between the two is the
 * difference between a verdict and an address. `41090564131` reported `4` variants on all 500 questions
 * while two dispatches of the same configuration delivered byte-identical evidence — same turns, same
 * order, same character count — so whatever moved sits in the invariant part of the prompt, and only the
 * bytes can name it.
 *
 * The window is 60 characters on each side of the first offset, because a diff that starts mid-token is
 * still readable and a diff reported as a bare offset is not.
 */
function repeatWitnessReading(report) {
  // Inside `ablation`, because the witness is a property of the run rather than of a record and
  // `AblationResult` is where this artifact keeps the run's captures. The per-question records sit at the
  // top level; reading the witness from there would be a second address for one field.
  const witness = report.ablation?.featurePromptRepeatWitness;
  if (witness === undefined) return null;
  const first = witness.texts[0] ?? null;
  // Recomputed from the texts rather than read from `commonPrefix`, and the recomputation is the reading
  // rather than a redundancy: the stored figure is the writer's claim, and a tool that repeated it could
  // not tell a wrong claim from a right one. A disagreement is reported instead of silently resolved.
  const stored = witness.commonPrefix ?? [];
  const recomputed = witness.texts.map((text, pass) => {
    if (pass === 0 || text === null || first === null) return null;
    const limit = Math.min(text.length, first.length);
    let offset = 0;
    while (offset < limit && text.charCodeAt(offset) === first.charCodeAt(offset)) offset++;
    return offset;
  });
  const misreported = recomputed.filter((value, pass) => value !== (stored[pass] ?? null));
  const rows = witness.texts.map((text, pass) => ({
    pass,
    bytes: text === null ? null : text.length,
    shared: recomputed[pass],
  }));
  let divergence = null;
  for (let pass = 1; pass < witness.texts.length && divergence === null; pass++) {
    const other = witness.texts[pass] ?? null;
    if (first === null || other === null) {
      divergence = {
        pass,
        offset: null,
        before: '',
        after: '',
        reason: 'a pass reported no prompt',
      };
      break;
    }
    const shared = recomputed[pass] ?? null;
    if (shared === null) continue;
    if (shared === first.length && shared === other.length) continue;
    const window = 60;
    const from = Math.max(0, shared - window);
    divergence = {
      pass,
      offset: shared,
      before: first.slice(from, shared + window),
      after: other.slice(from, shared + window),
      reason: null,
    };
  }
  return {
    questionId: witness.questionId,
    index: witness.index,
    rows,
    divergence,
    // Non-empty when the artifact's own prefix lengths disagree with the bytes it carried, which is a
    // finding about the writer rather than about the run.
    misreportedPasses:
      misreported.length === 0
        ? []
        : rows.filter((row, i) => recomputed[i] !== (stored[i] ?? null)).map((row) => row.pass),
  };
}

/** Render {@link repeatWitnessReading} as lines, so the caller's output stays one shape. */
function repeatWitnessLines(reading) {
  const lines = [
    `witness \`${reading.questionId}\` (position ${reading.index}); leading bytes shared with pass 1: ` +
      reading.rows.map((row) => `${row.pass + 1}=${row.shared ?? '—'}`).join(' '),
  ];
  if (reading.misreportedPasses.length > 0) {
    lines.push(
      `  the stored prefix disagrees with the bytes on pass(es) ${reading.misreportedPasses
        .map((pass) => pass + 1)
        .join(', ')}: the writer's figure was not used`,
    );
  }
  const d = reading.divergence;
  if (d === null) {
    lines.push('  every pass sent the same bytes — the repeats were repeats on this question');
  } else if (d.reason !== null) {
    lines.push(`  pass ${d.pass + 1}: ${d.reason}`);
  } else {
    lines.push(`  pass ${d.pass + 1} diverges at byte ${d.offset}:`);
    lines.push(`    pass 1: …${d.before.replace(/\n/g, '\\n')}…`);
    lines.push(`    pass ${d.pass + 1}: …${d.after.replace(/\n/g, '\\n')}…`);
  }
  return lines;
}

/**
 * Where a pair's net gain came from, split by whether that record's prompt changed.
 *
 * ## The failure this reading exists to prevent
 *
 * `41039779987` met claim 4 with **+2.60 points**, and 69% of it was flips on records whose prompt was
 * byte-identical on both sides: 24 gained and 15 lost across 473 untouched questions, an 8.2% churn
 * rate, against **+4 gains and 0 losses** on the 27 records the treatment actually reached. The
 * mechanism was worth **+0.80 point**, below the criterion's own 1.0-point bar.
 *
 * Every field needed to see that was in the artifact. What was missing was the division, and a criterion
 * that reports a headline without it reports a number that does not measure its own claim. So the
 * division is a reading the tool prints rather than an analysis a reader has to perform.
 *
 * ## Why `promptChars` and not the classifier
 *
 * It is the only per-question field that is a property of the **prompt**, so "the mechanism reached this
 * question" is decided by whether the prompt changed, not by whether the answer's form changed. `§13.172.5`
 * is the cost of the other choice: five questions changed class with identical prompts, which a
 * classifier-based guard reads as a fallthrough and is in fact churn.
 *
 * A record missing the field on either side is counted as **unmeasured**, never as unchanged: an artifact
 * from before the field existed has no prompt comparison at all, and filing it as "identical" would report
 * a population whose prompts were never compared as one whose prompts held.
 */
export function attributionOf(before, after) {
  const beforeById = new Map();
  for (const record of before.questions ?? []) beforeById.set(record.questionId, record);
  const changed = { n: 0, gained: 0, lost: 0 };
  const unchanged = { n: 0, gained: 0, lost: 0 };
  let unmeasured = 0;
  let compared = 0;
  for (const record of after.questions ?? []) {
    const prior = beforeById.get(record.questionId);
    if (prior === undefined) continue;
    compared += 1;
    if (
      typeof prior.promptChars !== 'number' ||
      typeof record.promptChars !== 'number' ||
      typeof prior.correct !== 'boolean' ||
      typeof record.correct !== 'boolean'
    ) {
      unmeasured += 1;
      continue;
    }
    const bucket = prior.promptChars === record.promptChars ? unchanged : changed;
    bucket.n += 1;
    if (prior.correct !== record.correct) {
      if (record.correct) bucket.gained += 1;
      else bucket.lost += 1;
    }
  }
  const measured = changed.n + unchanged.n;
  const netOf = (bucket) => bucket.gained - bucket.lost;
  return {
    compared,
    measured,
    unmeasured,
    measurable: measured > 0,
    changed: { ...changed, net: netOf(changed) },
    unchanged: { ...unchanged, net: netOf(unchanged) },
    // Over the questions both artifacts hold, because that is the denominator the accuracy criterion
    // uses and the two numbers have to be commensurable for the comparison to mean anything.
    attributablePoints: measured === 0 ? null : (netOf(changed) / measured) * 100,
    churnRate: unchanged.n === 0 ? null : (unchanged.gained + unchanged.lost) / unchanged.n,
  };
}

/**
 * Read one pair of artifacts against the five criteria.
 *
 * `capability` defaults to `MR` because every registered threshold is about MR: the population, the
 * off-by-one set, the seven named questions and the assembly check all live there. Passing another
 * capability produces a reading whose first four criteria are skipped, which is the honest output for
 * a pair this registration does not describe.
 */
export function transitionOf(before, after, options = {}) {
  const capability = options.capability ?? 'MR';
  const beforeCensus = censusOf(before, capability);
  const afterCensus = censusOf(after, capability);

  const afterById = new Map(afterCensus.rows.map((row) => [row.id, row]));
  const beforeById = new Map(beforeCensus.rows.map((row) => [row.id, row]));

  // Every question either census calls reference-only. The union, not the before set: a question that
  // was not reference-only and now is has crossed the other way, and that is the regression criterion 2
  // and 3 exist to catch.
  const union = [...new Set([...beforeById.keys(), ...afterById.keys()])].sort();
  const rows = union.map((id) => {
    const from = beforeById.get(id);
    const to = afterById.get(id);
    return {
      id,
      capability: (from ?? to).capability,
      question: (from ?? to).question,
      before: from?.klass ?? null,
      after: to?.klass ?? null,
      gold: (from ?? to).gold,
      answerBefore: from?.answer ?? null,
      answerAfter: to?.answer ?? null,
      transition: `${from?.klass ?? 'answered'} -> ${to?.klass ?? 'answered'}`,
    };
  });

  // The named population is the before-state's, because the registration named it before the dispatch.
  // Reading it from the after-state would let a treatment that changed the classifier redefine the set
  // it is judged on.
  const named = beforeCensus.rows
    .filter((row) => row.shape === 'derivation')
    .map((row) => row.id)
    .sort();
  const namedSet = new Set(named);
  const namedRows = named.map((id) => {
    const from = beforeById.get(id);
    const to = afterById.get(id);
    return {
      id,
      before: from?.klass ?? null,
      after: to?.klass ?? null,
      left: to === undefined,
      question: (from ?? to)?.question,
    };
  });

  // Kept as a diagnostic, not as a criterion: `§13.174.3` retired the count over this class and kept the
  // table, because a reader comparing two readings still wants to know which questions sat in it.
  const offByOneRows = beforeCensus.rows
    .filter((row) => row.klass === 'off-by-one')
    .map((row) => row.id)
    .map((id) => {
      const to = afterById.get(id);
      return {
        id,
        after: to?.klass ?? null,
        moved: (to?.klass ?? 'answered') !== 'off-by-one',
        answerAfter: to?.answer ?? null,
      };
    });

  const capabilities = Object.keys(before.ablation?.featureByCapability ?? {}).sort();
  const perCapability = capabilities.map((name) => {
    const from = featureCorrect(before, name);
    const to = featureCorrect(after, name);
    const runFrom = featureCorrectRun(before, name);
    const runTo = featureCorrectRun(after, name);
    return {
      capability: name,
      before: from ?? null,
      after: to ?? null,
      delta: from !== undefined && to !== undefined ? to - from : null,
      runBefore: runFrom ?? null,
      runAfter: runTo ?? null,
      runDelta: runFrom !== undefined && runTo !== undefined ? runTo - runFrom : null,
    };
  });

  const beforePrompt = promptCharsById(before);
  const afterPrompt = promptCharsById(after);
  const namedPrompt = [];
  const otherPrompt = [];
  for (const record of after.questions ?? []) {
    if (record.capability !== capability) continue;
    const was = beforePrompt.get(record.questionId);
    const now = typeof record.promptChars === 'number' ? record.promptChars : undefined;
    if (was === undefined || now === undefined) continue;
    const entry = { id: record.questionId, before: was, after: now, delta: now - was };
    (namedSet.has(record.questionId) ? namedPrompt : otherPrompt).push(entry);
  }

  const accuracyBefore = accuracyPoints(before);
  const accuracyAfter = accuracyPoints(after);

  const criteria = [];
  const add = (registered, label, applicable, pass, detail) => {
    criteria.push({
      registered,
      label,
      applicable,
      verdict: !applicable ? 'skipped' : pass ? 'pass' : 'fail',
      detail,
    });
  };

  // The division `§13.172.4` performed by hand, hoisted above the criteria because two of them now read it:
  // row 2 asks what the treatment did to the population it reached, and row 4 asks what that population
  // bought. Both are statements about the same two buckets, so they are computed once.
  const attribution = attributionOf(before, after);

  const namedLeft = namedRows.filter((row) => row.left).length;
  add(
    1,
    `at least ${NAMED_MIN} of the ${NAMED_POPULATION} named questions stop being reference-only`,
    named.length === NAMED_POPULATION,
    namedLeft >= NAMED_MIN,
    named.length === NAMED_POPULATION
      ? `${namedLeft} of ${named.length} left (need ${NAMED_MIN}): ${namedRows
          .map((row) => `${row.id}${row.left ? '=left' : `=${row.after ?? 'answered'}`}`)
          .join(' ')}`
      : `the registered population is ${NAMED_POPULATION}; this pair has ${named.length}, so the ` +
          `threshold does not describe this reading`,
  );

  // `§13.174.3`. The row this replaces counted class movements among ten off-by-one questions, and
  // `41039779987` showed what that counts: all five movers had byte-identical prompts, so the movement was
  // a form classifier reacting to `"3.0"` where it had seen `"3"`, not a leak reaching a question the ask
  // never touched. A count over a form class cannot detect a leak the classifier does not model -- the
  // failure mode is the classifier's own shape space, and it is silent in exactly the direction that
  // matters (a leak the classifier calls `answered`).
  //
  // What the row is for is the population the treatment applied to. A prompt that grew can distract a
  // reader, so a small loss band is honest; a systematic one is a treatment that does harm where it works,
  // and a net loss inside that band is still a net loss on the only questions it can be blamed for.
  const changedShare =
    attribution.changed.n === 0 ? null : attribution.changed.lost / attribution.changed.n;
  add(
    2,
    `the ${attribution.changed.n} reached question(s) carry at most ${(CHANGED_MAX_LOSS_SHARE * 100).toFixed(0)}% ` +
      'losses and no net loss',
    attribution.measurable && attribution.changed.n > 0,
    changedShare !== null && changedShare <= CHANGED_MAX_LOSS_SHARE && attribution.changed.net >= 0,
    !attribution.measurable
      ? 'no record carries a prompt size on both sides, so no question can be filed as reached'
      : attribution.changed.n === 0
        ? "no question's prompt moved, so the treatment reached nothing to damage"
        : `${attribution.changed.lost} lost of ${attribution.changed.n} (${(changedShare * 100).toFixed(1)}%), ` +
          `net ${attribution.changed.net >= 0 ? '+' : ''}${attribution.changed.net}; the other ` +
          `${attribution.unchanged.n} are identical on both sides and are not evidence about the treatment`,
  );

  const losses = perCapability.filter(
    (row) => row.delta !== null && row.delta < -CAPABILITY_MAX_LOSS,
  );
  const absBefore = featureCorrect(before, 'ABS');
  const absAfter = featureCorrect(after, 'ABS');
  const absHeld =
    absBefore === undefined || absAfter === undefined ? undefined : absBefore === absAfter;
  add(
    3,
    `no capability loses more than ${CAPABILITY_MAX_LOSS}, and ABS is unchanged`,
    perCapability.some((row) => row.delta !== null),
    losses.length === 0 && absHeld !== false,
    `${perCapability
      .filter((row) => row.delta !== null)
      .map(
        (row) =>
          `${row.capability} ${row.before}->${row.after} (${row.delta >= 0 ? '+' : ''}${row.delta} ` +
          `avg; ${row.runBefore}->${row.runAfter} this draw)`,
      )
      .join(
        ', ',
      )}${absHeld === false ? ` -- ABS moved ${absBefore}->${absAfter}, which the ask cannot reach` : ''}`,
  );

  const gain =
    accuracyBefore === undefined || accuracyAfter === undefined
      ? undefined
      : accuracyAfter - accuracyBefore;
  // `§13.174.4`. The row this replaces read total accuracy, and `41039779987` met it: +2.60 points, of which
  // +0.80 came from the 27 questions whose prompt changed and the rest from 39 flips on 473 records that
  // received byte-identical prompts. A row that a variance can satisfy is not a row about the treatment,
  // and the headline it satisfied was 69% churn.
  //
  // The headline is still printed, because a reader comparing this reading with the product's own claims
  // needs it, and because the gap between it and the attributable figure is the finding.
  add(
    4,
    `the reached population buys at least ${ATTRIBUTABLE_MIN_POINTS.toFixed(1)} point`,
    attribution.measurable,
    attribution.attributablePoints !== null &&
      attribution.attributablePoints >= ATTRIBUTABLE_MIN_POINTS,
    !attribution.measurable
      ? 'no record carries a prompt size on both sides, so no gain can be attributed to the treatment'
      : `attributable ${attribution.attributablePoints >= 0 ? '+' : ''}${attribution.attributablePoints.toFixed(2)} pt ` +
          `on the ${attribution.changed.n} whose prompt changed` +
          (gain === undefined
            ? ''
            : `; headline ${accuracyBefore.toFixed(2)}% -> ${accuracyAfter.toFixed(2)}% ` +
              `(${gain >= 0 ? '+' : ''}${gain.toFixed(2)} pt) of which the rest is churn on the ` +
              `${attribution.unchanged.n} identical (${attribution.unchanged.gained}+/${attribution.unchanged.lost}-)`),
  );

  // The assembly check. `promptChars` is the only per-question field that is a property of the PROMPT
  // rather than of the answer, so it is the one column in which "the mechanism reached this question"
  // is separable from "the answer changed".
  const namedChanged = namedPrompt.filter((row) => row.delta !== 0);
  const outsideChanged = otherPrompt.filter((row) => row.delta !== 0);
  add(
    5,
    `promptChars moves on the ${named.length} named questions and is equal on the other ${otherPrompt.length}`,
    named.length > 0 && otherPrompt.length > 0,
    namedChanged.length === named.length && outsideChanged.length === 0,
    `${namedChanged.length}/${named.length} named moved; ${outsideChanged.length}/${otherPrompt.length} ` +
      `outside moved${outsideChanged.length === 0 ? '' : ` (first ${outsideChanged[0].id} ${outsideChanged[0].before}->${outsideChanged[0].after})`}` +
      `${
        namedChanged.length === named.length
          ? ''
          : `; named still equal: ${
              namedPrompt
                .filter((row) => row.delta === 0)
                .map((row) => row.id)
                .join(' ') || 'none'
            }`
      }`,
  );

  // `§13.174.5`. The premise the cost columns rest on, measured instead of assumed. `§13.147.3` predicted a
  // 60-80% prefix-cache hit share because passes 2-4 were taken to resend pass 1's bytes; two artifacts read
  // 6.47% and 11.16% and neither could say whether the provider declined to cache or the arm had sent four
  // prompts. A run that fails this row makes its own token arithmetic unreadable rather than wrong, which is
  // a different defect and is reported as one.
  const variants = promptVariantsById(after);
  const variantRows = [...variants.entries()].filter(([id]) => {
    const row = after.questions?.find((record) => record.questionId === id);
    return row === undefined || row.capability === capability;
  });
  const repeated = variantRows.filter(([, value]) => value === 1).length;
  const unverifiable = variantRows.filter(([, value]) => value === null).length;
  const divergent = variantRows.length - repeated - unverifiable;
  const repeatShare = variantRows.length === 0 ? null : repeated / variantRows.length;
  add(
    6,
    `at least ${(REPEAT_PREMISE_MIN_SHARE * 100).toFixed(0)}% of the ${variantRows.length} measured ` +
      'question(s) sent one prompt on every pass',
    variantRows.length > 0,
    repeatShare !== null && repeatShare >= REPEAT_PREMISE_MIN_SHARE,
    variantRows.length === 0
      ? 'no record carries promptVariants: the run had one pass, or predates §13.174'
      : `${repeated}/${variantRows.length} sent one prompt (${(repeatShare * 100).toFixed(1)}%); ` +
          `${divergent} divergent (${
            variantRows
              .filter(([, value]) => typeof value === 'number' && value > 1)
              .slice(0, 3)
              .map(([id, value]) => `${id}=${value}`)
              .join(' ') || 'none'
          }), ${unverifiable} unverifiable`,
  );

  const witness = repeatWitnessReading(after);

  return {
    criteriaSource: CRITERIA_SOURCE,
    promptRepeatWitness: witness,
    repeatPremise: {
      measured: variantRows.length,
      repeated,
      divergent,
      unverifiable,
      share: repeatShare,
    },
    capability,
    before: {
      population: beforeCensus.population,
      classes: beforeCensus.classes,
      accuracy: accuracyBefore ?? null,
      generation: before.generatedAt ?? null,
    },
    after: {
      population: afterCensus.population,
      classes: afterCensus.classes,
      accuracy: accuracyAfter ?? null,
      generation: after.generatedAt ?? null,
    },
    named,
    namedLeft,
    namedRows,
    offByOneRows,
    perCapability,
    rows,
    promptChars: { named: namedPrompt, outside: otherPrompt },
    attribution,
    criteria,
    applicable: criteria.filter((row) => row.applicable).length,
    skipped: criteria.filter((row) => !row.applicable).length,
    failed: criteria.filter((row) => row.verdict === 'fail').length,
  };
}

const PAD = (text, width) => String(text).padEnd(width);

/** The human reading: the five verdicts first, then the transitions that produced them. */
export function renderReading(reading) {
  const lines = [];
  lines.push(
    `criteria: capability ${reading.capability}: ` +
      `${reading.applicable} applicable, ${reading.skipped} skipped, ${reading.failed} failed`,
  );
  lines.push(`  ${reading.criteriaSource}`);
  lines.push(`  before ${reading.before.generation}  population ${reading.before.population}`);
  lines.push(`  after  ${reading.after.generation}  population ${reading.after.population}`);
  lines.push('');
  lines.push('  #  verdict  criterion');
  for (const row of reading.criteria) {
    lines.push(`  ${row.registered}  ${PAD(row.verdict, 7)}  ${row.label}`);
    lines.push(`     ${' '.repeat(7)}  ${row.detail}`);
  }
  lines.push('');
  if (reading.attribution.measurable) {
    const { changed, unchanged } = reading.attribution;
    lines.push("  attribution (the gain split by whether that record's prompt changed)");
    lines.push(`  ${PAD('population', 14)}${PAD('n', 6)}${PAD('gained', 8)}${PAD('lost', 6)}net`);
    lines.push(
      `  ${PAD('changed', 14)}${PAD(changed.n, 6)}${PAD(changed.gained, 8)}${PAD(changed.lost, 6)}${changed.net >= 0 ? '+' : ''}${changed.net}`,
    );
    lines.push(
      `  ${PAD('unchanged', 14)}${PAD(unchanged.n, 6)}${PAD(unchanged.gained, 8)}${PAD(unchanged.lost, 6)}${unchanged.net >= 0 ? '+' : ''}${unchanged.net}`,
    );
    const churn = reading.attribution.churnRate;
    lines.push(
      `  attributable ${reading.attribution.attributablePoints >= 0 ? '+' : ''}${reading.attribution.attributablePoints.toFixed(2)} pt` +
        (churn === null
          ? ''
          : `; churn ${(churn * 100).toFixed(1)}% of the ${unchanged.n} identical`),
    );
  } else if (reading.attribution.compared > 0) {
    lines.push(
      `  attribution: ${reading.attribution.unmeasured} record(s) carry no promptChars on both sides, so no ` +
        'gain can be attributed',
    );
  }
  lines.push('');
  if (reading.promptRepeatWitness === null) {
    lines.push('  prompt repeat witness: absent (the run had one pass, or predates §13.176)');
  } else {
    lines.push('  prompt repeat witness (§13.176)');
    for (const line of repeatWitnessLines(reading.promptRepeatWitness)) lines.push(`  ${line}`);
  }
  lines.push('');
  lines.push(`  transitions (${reading.rows.length} question(s) reference-only on either side)`);
  lines.push(`  ${PAD('question', 18)}${PAD('before', 14)}${PAD('after', 14)}gold`);
  for (const row of reading.rows) {
    lines.push(
      `  ${PAD(row.id, 18)}${PAD(row.before ?? 'answered', 14)}${PAD(row.after ?? 'answered', 14)}` +
        String(row.gold ?? '').slice(0, 40),
    );
  }
  return lines.join('\n');
}

function flag(argv, name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function main(argv) {
  const beforePath = flag(argv, '--before');
  const afterPath = flag(argv, '--after');
  if (beforePath === undefined || afterPath === undefined) {
    process.stderr.write(
      'usage: arm-transition.mjs --before <artifact.json> --after <artifact.json> ' +
        '[--capability MR] [--json]\n',
    );
    return 2;
  }
  const before = JSON.parse(readFileSync(beforePath, 'utf8'));
  const after = JSON.parse(readFileSync(afterPath, 'utf8'));
  const capability = flag(argv, '--capability');
  const reading = transitionOf(before, after, capability === undefined ? {} : { capability });
  if (argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(reading, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderReading(reading)}\n`);
  }
  // A skipped criterion is not a failure and not a pass. The exit code reports only the ones this
  // pair's populations actually pose, which is why the skipped count is printed beside it.
  return reading.failed > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('arm-transition.mjs')) {
  process.exitCode = main(process.argv.slice(2));
}
