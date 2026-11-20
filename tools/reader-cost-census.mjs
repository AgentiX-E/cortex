#!/usr/bin/env node
/**
 * Where a run's tokens actually went, recomputed from the artifact.
 *
 * ## The defect this is written against
 *
 * `AblationReport.llmUsage` carries five numbers and `usageBySide` carries them per side, and both are
 * correct. Neither answers the question constraint 17 asks: **of the tokens this run spent, which part
 * bought something the reader used?** The artifact says 6,351,698 prompt and 1,454,369 completion tokens
 * on the feature side of `S17`; it does not say that the answers it delivered total 62,000 characters of
 * text, and no field anywhere relates the two.
 *
 * That relation is the only one that can price a prompt change. A run whose completion budget is 36 times
 * the text it ships is spending on something, and the artifact cannot say on what -- which is the same shape
 * `judge-channel-census.mjs` was written for on the grading side: a log line said "scorer channels:
 * structural, exact, numeric, judge", and a log line is not a population.
 *
 * ## What this computes, and what each number can be used for
 *
 * | read | what it prices |
 * | --- | --- |
 * | `cacheHitShare` | prompt ordering. A provider bills a prefix hit at a fraction of a miss, so this is the share of the prompt that already costs less |
 * | `promptTokensPerCall` | the room a question gets. Moving it moves this number and nothing else |
 * | `completionTokensPerCall` | how much the model writes per answer |
 * | `deliveredCharsPerCall` | how much of that writing the artifact ships |
 * | `undeliveredShare` | the part of the completion the run paid for and no reader sees |
 *
 * ## Why the delivered part is ESTIMATED rather than read
 *
 * No artifact records token counts per question -- `llmUsage` is process-wide and `questions[]` carries
 * characters. So the delivered side is `rawOutput.length / CHARS_PER_TOKEN`, and the constant is stated here
 * rather than buried: 3.5 is the usual figure for English prose and is wrong for CJK by a factor of two. The
 * estimate is therefore a LOWER bound on the delivered share for English-heavy artifacts and is reported with
 * the assumption printed beside it, because a precise-looking ratio computed from a wrong constant is worse
 * than a coarse one that names its own error.
 *
 * ## Why a zero-call tool rather than a change to the artifact
 *
 * Adding a field to `CostEfficiency` costs a contract change, a classification entry, a schema test and a
 * re-record of the baseline; running this over an existing artifact costs nothing and answers the same
 * question for every artifact already on disk. If the reading turns out to be load-bearing it can be promoted
 * into the artifact later, with a measurement behind it rather than a hypothesis.
 *
 * Usage:
 *   node tools/reader-cost-census.mjs <artifact.json>
 *   node tools/reader-cost-census.mjs <artifact.json> --out evidence/reader-cost.json
 *   node tools/reader-cost-census.mjs <artifact.json> --check   # exit 1 unless every field is computable
 */

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Characters per token, for the delivered-text estimate only.
 *
 * Stated as a named constant rather than inlined so the assumption travels with the number, and set to the
 * English figure because every artifact this campaign has produced answers in English. A CJK artifact would
 * need `1.5`, and the report prints which constant was used rather than leaving a reader to guess.
 */
const CHARS_PER_TOKEN = 3.5;

/** A side's own totals, or `null` when the artifact predates `usageBySide`. */
function side(usage) {
  if (usage === null || typeof usage !== 'object') return null;
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  const calls = num(usage.calls);
  const promptTokens = num(usage.promptTokens);
  const completionTokens = num(usage.completionTokens);
  const cacheHitPromptTokens = num(usage.cacheHitPromptTokens);
  if (calls === null || promptTokens === null || completionTokens === null) return null;
  return { calls, promptTokens, completionTokens, cacheHitPromptTokens: cacheHitPromptTokens ?? 0 };
}

/**
 * The feature side's delivered text, over the questions the artifact carries.
 *
 * `rawOutput` rather than `answer`: the answer is the extractor's verdict and the raw output is what the
 * provider charged for. A run whose extractor threw away 90% of the completion should read as such, and
 * measuring `answer` would hide exactly that.
 */
function delivered(questions) {
  let chars = 0;
  let counted = 0;
  let nulls = 0;
  for (const question of questions) {
    const raw = question?.rawOutput;
    if (typeof raw === 'string') {
      chars += raw.length;
      counted += 1;
    } else {
      nulls += 1;
    }
  }
  return { chars, counted, nulls };
}

/** Round to a fixed number of decimals, and never render `NaN` or `Infinity` as a number. */
function round(value, places = 2) {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * One side's reading.
 *
 * `deliveredTokens` is the estimate and `undeliveredTokens` is the difference between what the provider
 * charged and that estimate, floored at zero: a run whose delivered text is LONGER than its completion count
 * is an artifact whose sides disagree, not a run that saved tokens, and clamping keeps the share in `[0, 1]`
 * rather than publishing a negative cost.
 */
function readSide(name, usage, deliveredChars, deliveredQuestions) {
  const perCall = {
    promptTokens: usage.calls === 0 ? null : usage.promptTokens / usage.calls,
    completionTokens: usage.calls === 0 ? null : usage.completionTokens / usage.calls,
    cacheHitShare:
      usage.promptTokens === 0 ? null : usage.cacheHitPromptTokens / usage.promptTokens,
  };
  // Delivered text per call, over the questions that produced one rather than over the calls.
  //
  // `questions[]` carries the LAST pass's output -- `benchmark.ts` assigns `rawOutputs[index]`, so a later pass
  // overwrites an earlier one -- which means the artifact holds one output per question and `runs` outputs per
  // question are paid for. Dividing the characters by `runs` would spread one pass's text over four passes'
  // tokens and understate the gap by exactly the repetition count; dividing by the questions compares like
  // with like, and the repetition is then visible in the ratio rather than cancelled out of it.
  const deliveredCharsPerCall =
    deliveredQuestions === 0 ? null : deliveredChars / deliveredQuestions;
  const deliveredTokens =
    deliveredCharsPerCall === null ? null : deliveredCharsPerCall / CHARS_PER_TOKEN;
  const undeliveredTokens =
    deliveredTokens === null || perCall.completionTokens === null
      ? null
      : Math.max(0, perCall.completionTokens - deliveredTokens);
  return {
    side: name,
    calls: usage.calls,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    cacheHitPromptTokens: usage.cacheHitPromptTokens,
    promptTokensPerCall: round(perCall.promptTokens),
    completionTokensPerCall: round(perCall.completionTokens),
    cacheHitShare: round(perCall.cacheHitShare, 4),
    deliveredCharsPerCall: round(deliveredCharsPerCall),
    deliveredTokensPerCall: round(deliveredTokens),
    undeliveredTokensPerCall: round(undeliveredTokens),
    undeliveredShare:
      undeliveredTokens === null ||
      perCall.completionTokens === null ||
      perCall.completionTokens === 0
        ? null
        : round(undeliveredTokens / perCall.completionTokens, 4),
  };
}

/**
 * The whole reading.
 *
 * Present-but-uncomputable is `null` with a `reason`, and that distinction is the point: an artifact with no
 * `usageBySide` and one whose feature side called nothing are different states, and a zero would merge them
 * into the second -- which is the rule `usage.ts` states for an absent `usage` block one layer down.
 */
function census(artifact) {
  const bySide = artifact?.usageBySide;
  const questions = Array.isArray(artifact?.questions) ? artifact.questions : [];
  const runs = typeof artifact?.runs === 'number' && artifact.runs > 0 ? artifact.runs : 1;
  const text = delivered(questions);

  const featureUsage = side(bySide?.feature);
  const baselineUsage = side(bySide?.baseline);
  if (featureUsage === null) {
    return {
      ok: false,
      reason: 'this artifact carries no computable `usageBySide.feature`',
      runs,
    };
  }
  const feature = readSide('feature', featureUsage, text.chars, text.counted);
  const baseline =
    baselineUsage === null
      ? null
      : // The baseline delivers its own text and the artifact does not keep it, so its delivered share is
        // not computable. Reporting `null` rather than reusing the feature's characters is the difference
        // between "not measured" and "measured as equal".
        {
          ...readSide('baseline', baselineUsage, 0, 0),
          deliveredCharsPerCall: null,
          deliveredTokensPerCall: null,
          undeliveredTokensPerCall: null,
          undeliveredShare: null,
        };
  return {
    ok: true,
    runs,
    questions: questions.length,
    delivered: { chars: text.chars, counted: text.counted, missing: text.nulls },
    charsPerToken: CHARS_PER_TOKEN,
    feature,
    baseline,
  };
}

/** The lines a human reads, which must stand alone without the JSON. */
function render(reading) {
  if (!reading.ok) return [`reader cost: NOT COMPUTABLE -- ${reading.reason}`];
  const lines = [];
  const f = reading.feature;
  lines.push(
    `feature: ${f.calls} call(s) over ${reading.runs} pass(es) -- ` +
      `${f.promptTokens} prompt / ${f.completionTokens} completion tokens`,
  );
  lines.push(
    `  per call: ${f.promptTokensPerCall} prompt (cache ${(f.cacheHitShare * 100).toFixed(1)}%), ` +
      `${f.completionTokensPerCall} completion`,
  );
  lines.push(
    `  delivered: ${f.deliveredCharsPerCall} chars/call over ${reading.delivered.counted} question(s)` +
      (reading.delivered.missing > 0 ? `, ${reading.delivered.missing} with no raw output` : ''),
  );
  lines.push(
    `  undelivered: ${f.undeliveredTokensPerCall} of ${f.completionTokensPerCall} completion tokens/call ` +
      `(${(f.undeliveredShare * 100).toFixed(1)}%), estimated at ${reading.charsPerToken} chars/token`,
  );
  if (reading.baseline !== null) {
    const b = reading.baseline;
    lines.push(
      `baseline: ${b.calls} call(s) -- ${b.promptTokensPerCall} prompt ` +
        `(cache ${(b.cacheHitShare * 100).toFixed(1)}%), ${b.completionTokensPerCall} completion per call`,
    );
  }
  return lines;
}

function main(argv) {
  const args = argv.slice(2);
  const path = args.find((arg) => !arg.startsWith('--'));
  if (path === undefined) {
    process.stderr.write(
      'usage: reader-cost-census.mjs <artifact.json> [--out <file>] [--check]\n',
    );
    return 2;
  }
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  const reading = census(artifact);
  for (const line of render(reading)) process.stdout.write(`${line}\n`);
  const outIndex = args.indexOf('--out');
  if (outIndex !== -1 && args[outIndex + 1] !== undefined) {
    writeFileSync(args[outIndex + 1], `${JSON.stringify(reading, null, 2)}\n`);
  }
  if (args.includes('--check') && !reading.ok) return 1;
  return 0;
}

if (process.argv[1] !== undefined && process.argv[1].endsWith('reader-cost-census.mjs')) {
  process.exitCode = main(process.argv);
}

export { census, render, CHARS_PER_TOKEN };
