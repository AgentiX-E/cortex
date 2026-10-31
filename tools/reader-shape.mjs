#!/usr/bin/env node
/**
 * What shape one reader's answers have, printed under every denominator the artifact supports.
 *
 *     node tools/reader-shape.mjs --report run/report.json [--label deepseek-chat] \
 *                                 [--report other/report.json --label deepseek-v4-pro] [--json]
 *
 * ## Why this is a tool and not a paragraph
 *
 * The arm's contract-compliance claim is one sentence — "the reader that obeys the closing line is the better
 * reader" — and every number under it has two defensible denominators. The median answer length of an artifact
 * is **19** over all 500 questions with a decline counted as 0 characters, and **30** over the 449 answered
 * ones. Both are medians of the same field in the same file, and they answer different questions: the second
 * silently deletes fifty-one declines from the denominator it is judged by, so a reader that declines more
 * scores better on it.
 *
 * That ambiguity cost this campaign a false correction. A reading was recomputed on the answered-only
 * denominator, compared against a published all-questions figure, declared unreproducible, and committed as a
 * whitepaper erratum — while the published figure reproduced to the character (the accounting lives in
 * `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.192.4). Prose cannot be blamed for that; prose has no
 * denominator field. So the readings move here, where each one is printed with the population in its label and
 * a reader comparing two artifacts cannot pick a denominator without seeing it.
 *
 * ## The second thing this prints, which is not a shape at all
 *
 * `bareRetry.attempted` divides by `declines` to produce a number the whitepaper published as a share, and the
 * two counts do not overlap:
 *
 *   - the numerator is a **first-pass** count on the four non-`abstention` routes — the abstention route is
 *     excluded by a `route === 'abstention'` guard, because its gold answer is a decline and a retry there
 *     would spend a call to convert a correct answer into a wrong one;
 *   - the denominator is a **final** count over all five routes — and a question the retry *converted* keeps
 *     the second reply, so it is not among the declines at all.
 *
 * `answered == attempted` on both artifacts of the reader experiment, which is the arithmetic form of "every
 * bare first-pass decline became an answer", and it is why the ratio is exact and meaningless. The line this
 * tool prints instead is the population that exists: `attempted + non-ABS final declines`, with the prose share
 * over it. On the reader pair that is 45 → 48.9% prose against 30 → 76.7%, which is the same conclusion the
 * published 45.1% → 13.2% was reaching for, on a base where the two counts are actually a partition.
 *
 * ## The invariant, and why it exits non-zero
 *
 * If the retry is on, a non-`abstention` bare decline can only survive it when the second reply declined bare
 * too. So `non-ABS bare finals <= attempted - answered` must hold, and a violation means either the route gate
 * leaked or the census is not counting the pass it claims to. That is a one-line assertion, and it is here
 * rather than in a doc because it is the only reading on this page whose failure is a bug rather than a result.
 *
 * ## What it deliberately does not read
 *
 * Accuracy. A shape reading is not a ranking: `--report` on twenty questions prints the same fields, and
 * nothing in this tool's output is comparable across question sets. `correct` is printed because it is the
 * roster every other reading is joined to, not because a difference in it means anything at this resolution.
 */

import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import process from 'node:process';

const USAGE = `reader-shape — the shape of one reader's answers, under every denominator it has

usage:
  node tools/reader-shape.mjs --report <report.json> [--label <name>] [--report ... --label ...] [--json]

  --report  a cortex-memory ablation report artifact; repeatable
  --label   the name to print for the report that precedes it; defaults to the parent directory name
  --json    emit the readings as JSON instead of lines

prints, per artifact: the roster, the declines and their capabilities, the median and p90 answer length under
BOTH denominators (all questions with a decline counted as zero, and answered-only), the rawOutput median, the
retry census, the bare declines that survive into the final record with the capability they all belong to, and
the first-pass non-abstention population the retry's reach actually partitions.

prints, when the census is present: the invariant non-ABS bare finals <= attempted - answered, with the
offending question ids when it is violated. Exit 0 when it holds, 1 when it does not, 2 when an input is
unreadable. Nothing here is comparable across question sets.
`;

const DEFAULT_LABEL = 'report';

/**
 * What counts as a prose answer rather than a stated one, in characters.
 *
 * Forty is chosen against the two shapes the arm actually produces, not against a notion of brevity: a number, a
 * date, a name and a short phrase are all under it (`41196801892`'s `MR` median is 2.5 characters), while the
 * enumeration-and-explain replies that never emit the answer run to hundreds (`TR`'s median at the same sample is
 * 627.5). The median cannot separate those two readers when the short answers dominate the draw -- the amended
 * gate of `§13.195.1` is about this number for exactly that reason.
 */
const PROSE_CHARS = 40;

/**
 * The bare-decline predicate is imported, not restated.
 *
 * The first draft of this file carried its own copy — trim, drop the token, require wrappers only — and it read
 * a labelled decline (`Answer: INSUFFICIENT_EVIDENCE`) as content. That is the exact divergence
 * `bare-decline-label.test.ts` was written to prevent, six IE questions in run `40807829150` that `parse.ts`
 * scored as declines and a hand-rolled predicate read as answers. The predicate is a pure function of the reply
 * string, so reading an archived artifact through the current rule is the *right* answer rather than
 * time-travel: "was this the token and nothing else" does not depend on when the question was run.
 *
 * It is loaded dynamically so that a missing `dist/` produces one sentence instead of a stack trace.
 */
async function loadBareDecline() {
  const url = new URL('../packages/cortex-memory/dist/abstention-recovery.js', import.meta.url);
  try {
    const module = await import(url.href);
    if (typeof module.isBareDecline !== 'function') {
      fail(`${url.pathname} does not export isBareDecline; run \`pnpm build\``);
    }
    return module.isBareDecline;
  } catch (error) {
    fail(
      `cannot import the bare-decline predicate from ${url.pathname} (run \`pnpm build\`): ${error.message}`,
    );
  }
}

function fail(message) {
  process.stderr.write(`reader-shape: ${message}\n`);
  process.exit(2);
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`cannot read ${path}: ${error.message}`);
  }
}

function parseArgs(argv) {
  const options = { json: false, reports: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    if (arg === '--report' || arg === '--label') {
      const value = argv[index + 1];
      if (value === undefined) fail(`${arg} needs a value`);
      if (arg === '--report') {
        options.reports.push({ path: value, label: undefined });
      } else {
        const last = options.reports[options.reports.length - 1];
        if (last === undefined) fail('--label must follow a --report');
        last.label = value;
      }
      index += 1;
      continue;
    }
    fail(`unrecognised argument ${arg}; see --help`);
  }
  if (options.reports.length === 0) fail('at least one --report is required; see --help');
  return options;
}

/** A quantile of an already-numeric list, using the `higher` convention the campaign's readings use. */
function quantile(values, share) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * share;
  return sorted[Math.ceil(position)];
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function countBy(records, key) {
  const counts = new Map();
  for (const record of records) {
    const value = record[key] ?? 'unknown';
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries(
    [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0])),
  );
}

/**
 * `ablation.featureAggregate`, converted from shares to counts, or `null` when the artifact carries none.
 *
 * Returned as counts because every other roster on this page is a count, and a page that mixed `0.8565` with
 * `426/500` would be inviting exactly the comparison the two representations hide: they are the same number at
 * different denominators, and 0.8565 is the *mean* while 426 is *one draw*.
 */
function aggregateOf(body, total) {
  const aggregate = body?.ablation?.featureAggregate;
  if (aggregate === null || aggregate === undefined) return null;
  const count = (share) => (typeof share === 'number' ? Math.round(share * total) : null);
  const countOf = (key) => count(aggregate[key]);
  return {
    min: countOf('min'),
    max: countOf('max'),
    avg: countOf('avg'),
    median: countOf('median'),
    share: typeof aggregate.avg === 'number' ? aggregate.avg : null,
  };
}

/** The abstention route is the one capability whose gold answer is a decline, and the only one the retry skips. */
const ABSTENTION_CAPABILITY = 'ABS';

/**
 * The reader a run used, rendered rather than printed as `[object Object]`.
 *
 * `MemoryArmConfig.reader` became a record when §13.110.1's debt was paid: provider, model, base URL, thinking
 * mode and temperature, which is the whole identity and the thing `40698883428` could not state. The first
 * version of this file interpolated it and printed `reader [object Object]` on the first artifact that had one --
 * a tool that hides the field it was written to make legible.
 */
function readerOf(body) {
  const reader = body?.memoryArmConfig?.reader ?? null;
  if (reader === null || reader === undefined) return null;
  if (typeof reader === 'string') return reader;
  const thinking =
    reader.thinking === undefined ? 'thinking not reported' : `thinking ${reader.thinking}`;
  const temperature =
    reader.temperature === null || reader.temperature === undefined
      ? 'no temperature sent'
      : `temperature ${reader.temperature}`;
  return `${reader.provider ?? 'provider?'}/${reader.model ?? 'model?'} (${thinking}, ${temperature})`;
}

function readArtifact(body, isBareDecline) {
  const questions = Array.isArray(body.questions)
    ? body.questions
    : fail('artifact has no questions[]');
  const answered = questions.filter(
    (record) => record.answer !== null && record.answer !== undefined,
  );
  const declines = questions.filter(
    (record) => record.answer === null || record.answer === undefined,
  );

  const lengthAllQuestions = questions.map((record) =>
    record.answer == null ? 0 : String(record.answer).length,
  );
  const lengthAnswered = answered.map((record) => String(record.answer).length);
  const lengthRaw = questions.map((record) => String(record.rawOutput ?? '').length);

  const bareFinals = declines.filter((record) => isBareDecline(record.rawOutput ?? null));
  const bareOutsideAbstention = bareFinals.filter(
    (record) => record.capability !== ABSTENTION_CAPABILITY,
  );
  const proseFinals = declines.filter((record) => !isBareDecline(record.rawOutput ?? null));
  const proseOutsideAbstention = proseFinals.filter(
    (record) => record.capability !== ABSTENTION_CAPABILITY,
  );

  const emptyReplies = declines.filter((record) => String(record.rawOutput ?? '').trim() === '');

  /**
   * The answer length **per capability**, which is where a compliance claim actually lives.
   *
   * The routed blocks do not close the same way: `multi-session` and `temporal` end with *"Reply with the Step 2
   * number alone"*, and `flat`/`knowledge-update` do not. One median over the roster therefore averages a route
   * that states a rule with routes that do not, and the probe that motivated this file measured exactly that: on
   * the same twenty questions, `thinking: enabled` reads an MR median of **1** character against **135**, while
   * IE's medians are 56.5 and 64. The roster median (25 against 120) is true and says less than the partition.
   */
  const lengthByCapability = {};
  for (const capability of new Set(questions.map((record) => record.capability ?? 'unknown'))) {
    const ofCapability = questions.filter(
      (record) => (record.capability ?? 'unknown') === capability,
    );
    const answeredOfCapability = ofCapability.filter((record) => record.answer != null);
    lengthByCapability[capability] = {
      n: ofCapability.length,
      answered: answeredOfCapability.length,
      medianAll: median(
        ofCapability.map((record) => (record.answer == null ? 0 : String(record.answer).length)),
      ),
      medianAnswered:
        answeredOfCapability.length === 0
          ? null
          : median(answeredOfCapability.map((record) => String(record.answer).length)),
      max:
        answeredOfCapability.length === 0
          ? null
          : Math.max(...answeredOfCapability.map((record) => String(record.answer).length)),
      // Over the answers, not over the records: a decline has no length, so counting it here would report the
      // abstention rate as a shape. `answeredOfCapability` is the population and it is stated beside every use.
      over40: answeredOfCapability.filter((record) => String(record.answer).length > PROSE_CHARS).length,
    };
  }

  const census = body.bareRetry ?? undefined;
  const attempted = typeof census?.attempted === 'number' ? census.attempted : null;
  const retried = typeof census?.answered === 'number' ? census.answered : null;

  /**
   * How many repetitions the census was summed over.
   *
   * ## The second denominator mistake this file would have made, caught by its first real multi-run artifact
   *
   * `bareRetry` is a process-wide counter, so a four-repetition run reports four runs' worth of attempts, while
   * `questions[]` carries one record per question. On `41185512391` (`runs: 4`) the census reads **111** against
   * 21 prose finals, and the first version of this file printed "first-pass non-ABS declines = 132, prose share
   * 15.9%" -- a number that mixes a summed numerator with a per-question denominator, which is the exact defect
   * §13.192.4 was written to repair at the level of prose. The reading is therefore per repetition or not at
   * all: `attempted / runs` is printed beside the census, and the share is **not computable** when `runs > 1`.
   */
  const runs = Number.isInteger(body.runs) && body.runs > 0 ? body.runs : 1;
  const attemptedPerRun = attempted === null ? null : attempted / runs;
  const retriedPerRun = retried === null ? null : retried / runs;

  // The population the retry's reach partitions: questions the pass converted, plus the ones it left declining.
  // Only meaningful when one repetition produced the census and the records.
  const firstPassOutsideAbstention =
    attemptedPerRun !== null && runs === 1 ? attemptedPerRun + proseOutsideAbstention.length : null;
  const proseShare =
    firstPassOutsideAbstention === null || firstPassOutsideAbstention === 0
      ? null
      : (proseOutsideAbstention.length / firstPassOutsideAbstention) * 100;

  return {
    dataset: body.dataset ?? null,
    questions: questions.length,
    /**
     * The sample's own coverage, which is the first thing a small artifact has to state.
     *
     * A 20-question probe covers every capability at about three questions each, and nothing else on this
     * page says so: a reader who saw `roster 12/20` would have no way to know whether the twenty were one
     * capability or five. `sampling.ts` round-robins across buckets rather than slicing, and this line is
     * where that property is either true of the artifact or not.
     */
    questionsByCapability: countBy(questions, 'capability'),
    roster: {
      correct: body.feature?.metrics?.correct ?? null,
      total: body.feature?.metrics?.total ?? questions.length,
      accuracy: body.feature?.metrics?.accuracy ?? null,
    },
    /**
     * The same roster across repetitions, when the artifact reports it.
     *
     * `feature.metrics.correct` is **one** repetition's count -- the one whose records were kept -- and on a
     * four-run artifact it is neither the mean nor the interval. `41185512391`'s records read 426 while its own
     * `ablation.featureAggregate` reads min 0.852 / max 0.860 / avg 0.8565, which is 426 to 430 with a mean of
     * 428.3. A reader who compares 426 against another run's roster is comparing one draw to one draw, the
     * mistake §6.1.6's repetition guard exists for, so the interval is printed whenever it exists.
     */
    aggregate: aggregateOf(body, body.feature?.metrics?.total ?? questions.length),
    reader: readerOf(body),
    runs,
    answered: answered.length,
    declines: declines.length,
    declinesByCapability: countBy(declines, 'capability'),
    bareFinals: {
      count: bareFinals.length,
      byCapability: countBy(bareFinals, 'capability'),
      outsideAbstention: bareOutsideAbstention.length,
      outsideAbstentionIds: bareOutsideAbstention.map((record) => record.questionId),
    },
    proseFinals: {
      count: proseFinals.length,
      outsideAbstention: proseOutsideAbstention.length,
    },
    emptyReplies: emptyReplies.length,
    length: {
      allQuestions: {
        n: lengthAllQuestions.length,
        median: median(lengthAllQuestions),
        p90: quantile(lengthAllQuestions, 0.9),
      },
      answeredOnly: {
        n: lengthAnswered.length,
        median: median(lengthAnswered),
        p90: quantile(lengthAnswered, 0.9),
      },
      rawOutput: { n: lengthRaw.length, median: median(lengthRaw) },
      byCapability: lengthByCapability,
    },
    retry: {
      reported: attempted !== null,
      attempted,
      answered: retried,
      runs,
      attemptedPerRun,
      firstPassOutsideAbstention,
      proseShare,
    },
    /** Held when a non-abstention bare decline cannot exist outside what the retry already accounted for. */
    invariant: {
      name: 'non-ABS bare finals <= (attempted - answered) / runs',
      left: bareOutsideAbstention.length,
      right: attempted === null ? null : (attempted - (retried ?? 0)) / runs,
      held:
        attempted === null
          ? null
          : bareOutsideAbstention.length <= (attempted - (retried ?? 0)) / runs,
    },
  };
}

function show(value) {
  return value === null || value === undefined ? 'not reported' : String(value);
}

function linesFor(label, reading) {
  const lines = [
    `${label}`,
    `  dataset ${show(reading.dataset)} · ${reading.questions} question(s) · ${reading.runs} repetition(s)`,
    `  reader ${show(reading.reader)}`,
    `  roster ${show(reading.roster.correct)}/${show(reading.roster.total)}${
      reading.runs === 1 ? '' : ' (one repetition, the one whose records are here)'
    } · answered ${reading.answered} · declined ${reading.declines}`,
    ...(reading.aggregate === null || reading.runs === 1
      ? []
      : [
          `  roster across ${reading.runs} repetition(s): min ${show(reading.aggregate.min)} / max ${show(
            reading.aggregate.max,
          )} / mean ${show(reading.aggregate.avg)} (${reading.aggregate.share === null ? 'no share' : reading.aggregate.share.toFixed(4)}) / median ${show(
            reading.aggregate.median,
          )}`,
        ]),
    `  questions by capability: ${Object.entries(reading.questionsByCapability)
      .map(([capability, count]) => `${capability} ${count}`)
      .join(', ')}`,
    `  declines by capability: ${Object.entries(reading.declinesByCapability)
      .map(([capability, count]) => `${capability} ${count}`)
      .join(', ')}`,
    '',
    '  answer length, all questions (a decline counts as 0 chars)',
    `    median ${show(reading.length.allQuestions.median)} · p90 ${show(reading.length.allQuestions.p90)} · n ${reading.length.allQuestions.n}`,
    '  answer length, answered only (this denominator removes the declines)',
    `    median ${show(reading.length.answeredOnly.median)} · p90 ${show(reading.length.answeredOnly.p90)} · n ${reading.length.answeredOnly.n}`,
    `  rawOutput length, all questions: median ${show(reading.length.rawOutput.median)}`,
    `  answer length by capability, answered only (median / max / answered of n): ${Object.entries(
      reading.length.byCapability,
    )
      .map(
        ([capability, value]) =>
          `${capability} ${show(value.medianAnswered)} / ${show(value.max)} / ${value.answered} of ${value.n} · ${value.over40} over ${PROSE_CHARS}`,
      )
      .join('; ')}`,
    '',
    `  bare declines in the final record: ${reading.bareFinals.count} of ${reading.declines}`,
    `    by capability: ${
      Object.entries(reading.bareFinals.byCapability)
        .map(([capability, count]) => `${capability} ${count}`)
        .join(', ') || '-'
    }`,
    `    outside ${ABSTENTION_CAPABILITY}: ${reading.bareFinals.outsideAbstention}`,
    `  empty replies among the declines: ${reading.emptyReplies}`,
    '',
  ];

  if (!reading.retry.reported) {
    lines.push(
      '  bareRetry: not reported by this artifact, so the first-pass population is unmeasured here',
      '    the abstention gate is still read: it is the one thing this artifact can say about the retry',
    );
  } else {
    lines.push(
      `  bareRetry: attempted ${reading.retry.attempted}, answered ${reading.retry.answered}${
        reading.runs === 1
          ? ''
          : ` over ${reading.runs} repetition(s) = ${reading.retry.attemptedPerRun} per run`
      }`,
      '    attempted / declines is NOT a share: the numerator is first-pass on the four non-abstention routes,',
      '    the denominator is final on all five, and the converted questions are not in the denominator',
    );
    if (reading.runs > 1) {
      lines.push(
        `    first-pass non-${ABSTENTION_CAPABILITY} declines: not computable across ${reading.runs} repetition(s) -- the census is summed over runs and the declines are one per question`,
      );
    } else {
      lines.push(
        `    first-pass non-${ABSTENTION_CAPABILITY} declines = attempted + prose finals = ${show(reading.retry.firstPassOutsideAbstention)}`,
        `    prose share of that population: ${reading.retry.proseShare === null ? 'not computable' : `${reading.retry.proseShare.toFixed(1)}%`} (${reading.proseFinals.outsideAbstention} of ${show(reading.retry.firstPassOutsideAbstention)})`,
      );
    }
  }

  const { invariant } = reading;
  if (invariant.held === null) {
    lines.push(`  invariant ${invariant.name}: not read (no census)`);
  } else {
    lines.push(
      `  invariant ${invariant.name}: ${invariant.held ? 'held' : 'VIOLATED'} (${invariant.left} vs ${invariant.right})${
        invariant.held
          ? ''
          : ` -- ${reading.bareFinals.outsideAbstentionIds.slice(0, 10).join(', ')}`
      }`,
    );
  }
  return lines;
}

function pairLines(leftLabel, left, rightLabel, right) {
  // One decimal at most: the readings are counts and characters, and a share that prints sixteen digits reads
  // like precision the 500-question denominator does not support.
  const format = (value) =>
    typeof value === 'number'
      ? Number.isInteger(value)
        ? String(value)
        : value.toFixed(1)
      : show(value);
  const capabilities = [...new Set([...Object.keys(left.length.byCapability), ...Object.keys(right.length.byCapability)])].sort();
  const row = (name, leftValue, rightValue) => {
    const delta =
      typeof leftValue === 'number' && typeof rightValue === 'number'
        ? `${rightValue - leftValue >= 0 ? '+' : ''}${(rightValue - leftValue).toFixed(1)}`
        : '-';
    return `  ${name.padEnd(38)} ${format(leftValue).padStart(8)} ${format(rightValue).padStart(8)} ${delta.padStart(9)}`;
  };
  return [
    '',
    `pair: ${leftLabel} → ${rightLabel}`,
    `  ${''.padEnd(38)} ${leftLabel.slice(0, 8).padStart(8)} ${rightLabel.slice(0, 8).padStart(8)} ${'Δ'.padStart(9)}`,
    row('roster correct', left.roster.correct, right.roster.correct),
    row('declines', left.declines, right.declines),
    row('median, all questions', left.length.allQuestions.median, right.length.allQuestions.median),
    row('p90, all questions', left.length.allQuestions.p90, right.length.allQuestions.p90),
    row('median, answered only', left.length.answeredOnly.median, right.length.answeredOnly.median),
    row('rawOutput median', left.length.rawOutput.median, right.length.rawOutput.median),
    row(
      'bare finals outside ABS',
      left.bareFinals.outsideAbstention,
      right.bareFinals.outsideAbstention,
    ),
    row('retry attempted', left.retry.attempted, right.retry.attempted),
    row('prose share (%)', left.retry.proseShare, right.retry.proseShare),
    // Per capability, because the two routed blocks do not close the same way: `multi-session` and `temporal` end
    // with "reply with the Step 2 number alone" and the others do not, so one roster median averages a route that
    // states a rule with routes that do not. `§13.195.1`'s gate is stated per capability for that reason, and a
    // gate that has to be assembled from two single-artifact printouts is a gate somebody will read wrong.
    '',
    `  per capability, answered only          ${leftLabel.slice(0, 8).padStart(8)} ${rightLabel.slice(0, 8).padStart(8)} ${'Δ'.padStart(9)}`,
    ...capabilities.flatMap((capability) => [
      row(
        `${capability} median (answered)`,
        left.length.byCapability[capability]?.medianAnswered ?? null,
        right.length.byCapability[capability]?.medianAnswered ?? null,
      ),
      row(
        `${capability} answers over ${PROSE_CHARS} chars`,
        left.length.byCapability[capability]?.over40 ?? null,
        right.length.byCapability[capability]?.over40 ?? null,
      ),
    ]),
  ];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const isBareDecline = await loadBareDecline();
  const readings = options.reports.map((entry) => {
    const body = readJson(entry.path);
    const label = entry.label ?? (basename(dirname(entry.path)) || DEFAULT_LABEL);
    return { label, path: entry.path, reading: readArtifact(body, isBareDecline) };
  });

  const violated = readings.filter((entry) => entry.reading.invariant.held === false);

  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          reports: readings.map((entry) => ({
            label: entry.label,
            path: entry.path,
            ...entry.reading,
          })),
          invariantHeld: violated.length === 0,
        },
        null,
        2,
      )}\n`,
    );
    process.exit(violated.length === 0 ? 0 : 1);
  }

  const lines = [];
  for (const entry of readings) {
    if (lines.length > 0) lines.push('', '-'.repeat(78), '');
    lines.push(...linesFor(entry.label, entry.reading));
  }
  if (readings.length === 2) {
    lines.push(
      ...pairLines(readings[0].label, readings[0].reading, readings[1].label, readings[1].reading),
    );
  }
  lines.push(
    '',
    violated.length === 0
      ? 'verdict: the retry invariant holds on every artifact read here'
      : `verdict: the retry invariant is VIOLATED on ${violated.map((entry) => entry.label).join(', ')}`,
    'note: these are shape readings, not a ranking. Nothing here is comparable across question sets.',
  );
  process.stdout.write(`${lines.join('\n')}\n`);
  process.exit(violated.length === 0 ? 0 : 1);
}

await main();
