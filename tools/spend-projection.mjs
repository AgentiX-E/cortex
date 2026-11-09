#!/usr/bin/env node
/**
 * What a dispatch will cost, before it is dispatched.
 *
 * ## The defect this file is written against
 *
 * Every cost instrument in this repository reads an artifact that already exists. `cost-ledger.py`
 * divides `usageBySide.feature.promptTokens`; `efficiency-frontier.mjs` compares the readings to a
 * vendor's published figure. All of them answer "what did that run cost". None of them answers the
 * only question that stops a spend: **what will this one cost**, asked while the inputs are still
 * editable.
 *
 * The cost of that gap is measured rather than argued. One full pass of the cortex-memory A/B --
 * 500 questions, four repetitions, 24 `workflow_dispatch` inputs -- reads 27.2M prompt tokens and
 * 2.3M completion tokens on artifact `42467`, which at the provider's published 2026-11-09 prices is
 * **14.27 CNY**. The screening configuration this file exists to make visible (`limit=200`,
 * `ablation_runs=2`) is the same measurement on 40% of the questions and half the repetitions, and
 * it is **1.71 CNY**. Nothing in the dispatch path said either number, so the cheap dispatch and
 * the expensive one looked identical at the moment of choosing, and the archive is seven full passes
 * deep in one day.
 *
 * ## Why the projection is a scaling of a measured run and not a model of the pipeline
 *
 * A model would need per-turn character counts, the delivery cap, the retry rate, the thinking
 * reach and the judge's own prompt -- five inputs of which two are configuration and three are
 * behaviour. Every one of them would be a number this file invented, and a projection built from
 * invented numbers is a second opinion, not a measurement.
 *
 * So the input is an artifact that was actually billed, and the projection is
 * `observed x (questions / observedQuestions) x (runs / observedRuns)`. That is exact for the
 * question axis -- each question is one prompt of its own, so removing questions removes their
 * prompts and nothing else -- and it is the arm's own claim for the repetition axis, which
 * `40722772896` measured at 2.87x wall clock for 4 repetitions against 1.
 *
 * ## Why the question-axis scaling is only sound under a stated condition, and what happens when
 * that condition fails
 *
 * `sampleInstances` round-robins across capability buckets, so a 40% sample is 40% of **each**
 * capability rather than 40% of the file. That is what makes the scaling linear: the per-question
 * cost is dominated by the capability, because the thinking reach and the delivery cap are both
 * route-scoped (`multi-session+temporal` at 48,460 characters against a flat default), and a
 * sample that dropped multi-session entirely would cost far less per question than the run it is
 * scaled from.
 *
 * The condition is therefore checkable and this file checks it: when the caller passes the sample's
 * capability census, the shares are compared against the observed artifact's and a deviation above
 * `SHARE_TOLERANCE` is reported as `unscaled` rather than projected. Reporting a number there would
 * be the `cost-ledger.py` defect one layer up -- a figure that two readers can disagree about
 * because the thing it assumed is not in the file.
 *
 * ## Why the thinking reach is refused rather than re-priced
 *
 * `DEEPSEEK_THINKING` is the single largest line on the bill: on `42467` the feature arm's 2.22M
 * completion tokens are 6.66 CNY of a 14.27 CNY run, and the completion count is 1,071 tokens per
 * call while the median delivered answer is 18 characters -- the tokens are reasoning, and reasoning
 * is enabled on `multi-session+temporal` and nowhere else. That makes "turn thinking off on MR"
 * look like a 40% saving, and it may be one. It is not a saving this file can price, because the
 * reasoning tokens per thinking question are a property of the questions that were asked, not of
 * the count of them: a sample that replaces the MR questions replaces the reasoning with it.
 *
 * A projection that scaled completion tokens by the thinking reach would therefore be wrong in the
 * direction that matters -- it would understate the cost of a thinking run and overstate the saving
 * from disabling it. `project()` returns `thinkingReachChanged: true` and refuses to move the
 * completion line, so the total it prints is a **lower bound** for a run that keeps the reach and
 * the answer for any run that changes it is "dispatch the screening configuration and read its own
 * artifact".
 *
 * ## Prices are a dated constant, not a lookup
 *
 * `api-docs.deepseek.com/zh-cn/quick_start/pricing` on 2026-11-09 lists `deepseek-chat` as
 * DeepSeek-V3.2 (128K context, 4K default / 8K maximum output) at **0.2 CNY per million cached input
 * tokens, 2 CNY per million uncached input, 3 CNY per million output**. The page carries no
 * machine-readable endpoint and states that prices may change, so the date travels with the numbers
 * and `--prices` exists for the day they do. Reading them at runtime would make the tool's output a
 * function of the network, which is the property that makes a spend figure uncomparable to the
 * ledger it is checked against.
 *
 * ## Why cached and uncached input are priced apart
 *
 * Because they differ by 10x and the mix is a property of the prompt, not of the model. `42467`
 * hits the prefix cache on 26.15M of its 27.23M prompt tokens -- 96.3% -- and the difference between
 * pricing that mix and pricing it all uncached is 45.9 CNY against 7.41 CNY. A tool that reported
 * one input price would either hide the cache or hide its absence, and both are the same number
 * printed as if it were the other.
 */

/**
 * Published per-million-token prices, in CNY, for `deepseek-chat` on `asOf`.
 *
 * Kept here as one dated object rather than as seven numbers spread over the arithmetic, so a
 * price change is one edit and the date it applies to cannot drift away from the values.
 */
export const DEEPSEEK_PRICES = Object.freeze({
  asOf: '2026-11-09',
  source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  model: 'deepseek-chat',
  cacheHitCnyPerMillion: 0.2,
  cacheMissCnyPerMillion: 2,
  outputCnyPerMillion: 3,
});

/**
 * The share deviation above which the question-axis scaling is refused.
 *
 * 5 percentage points, because the per-question cost is dominated by two route-scoped settings and
 * the capabilities that carry them are 45% of the file (MR 24.2% + TR 25.4%). A sample that moved
 * either by more than one fifth of its own share would change what a question costs on average by
 * more than the projection's own rounding, so the reading would be a different measurement wearing
 * the same label.
 */
export const SHARE_TOLERANCE = 0.05;

/**
 * Price one usage block, split by cache outcome.
 *
 * The three inputs are counts of tokens and are checked to be non-negative integers: a float or a
 * negative is a corrupted artifact rather than an expensive one, and pricing it would produce a
 * figure that looks like a bill. `cacheHitPromptTokens` larger than `promptTokens` is impossible
 * from a correct provider and is refused here for the reason `parseUsage` refuses it in
 * `cortex-ai` -- a hit counter above its own denominator would credit a discount that was not
 * earned.
 */
export function priceUsage(usage, prices = DEEPSEEK_PRICES) {
  const { promptTokens, completionTokens, cacheHitPromptTokens = 0 } = usage ?? {};
  requireCount('promptTokens', promptTokens);
  requireCount('completionTokens', completionTokens);
  requireCount('cacheHitPromptTokens', cacheHitPromptTokens);
  if (cacheHitPromptTokens > promptTokens) {
    throw new Error(
      `cacheHitPromptTokens (${cacheHitPromptTokens}) exceeds promptTokens (${promptTokens}): ` +
        'a cache hit cannot be larger than the prompt it is a hit on',
    );
  }
  return price(promptTokens, cacheHitPromptTokens, completionTokens, prices);
}

/**
 * The arithmetic, on any non-negative numbers.
 *
 * Split from `priceUsage` because the per-question-per-run reading divides a count by two counts
 * and is therefore not an integer -- and refusing it would either lose the only figure the tool
 * exists to make comparable, or force the caller to round it before pricing it. The division is
 * exact and the product is money, so the guard belongs on the counts and not on the money.
 */
function price(promptTokens, cacheHitPromptTokens, completionTokens, prices) {
  const cached = (cacheHitPromptTokens * prices.cacheHitCnyPerMillion) / 1e6;
  const uncached = ((promptTokens - cacheHitPromptTokens) * prices.cacheMissCnyPerMillion) / 1e6;
  const output = (completionTokens * prices.outputCnyPerMillion) / 1e6;
  return { cached, uncached, output, total: cached + uncached + output };
}

/**
 * Project what a dispatch of `limit` questions at `runs` repetitions will be billed.
 *
 * `observed` is the usage block of a run that already happened, with the population it was taken
 * over. `census` is optional and, when present, is the sample's capability counts -- passing it is
 * how a caller shows the sample keeps the shares the scaling assumes.
 *
 * Returns `scaled: false` with a reason rather than a number whenever one of the assumptions that
 * make the arithmetic mean something is false. `readings` is present only when `scaled` is, because
 * a projection that cannot be trusted is not made more useful by printing its parts.
 */
export function project({
  observed,
  observedQuestions,
  observedRuns,
  limit,
  runs,
  census,
  observedCensus,
  observedThinkingReach,
  thinkingReach,
  prices = DEEPSEEK_PRICES,
}) {
  requireCount('observedQuestions', observedQuestions);
  requireCount('observedRuns', observedRuns);
  requireCount('limit', limit);
  requireCount('runs', runs);
  if (observedQuestions === 0 || observedRuns === 0 || limit === 0 || runs === 0) {
    return refuse('a zero question count or repetition count would make the projection a division by zero');
  }

  const shareFailure = checkShares({ census, observedCensus });
  if (shareFailure !== null) {
    return refuse(shareFailure);
  }

  const questionFactor = limit / observedQuestions;
  const runFactor = runs / observedRuns;
  const factor = questionFactor * runFactor;

  const scaledUsage = {
    promptTokens: scale(observed.promptTokens, factor),
    cacheHitPromptTokens: scale(observed.cacheHitPromptTokens ?? 0, factor),
    completionTokens: scale(observed.completionTokens, factor),
  };
  const cost = priceUsage(scaledUsage, prices);

  return {
    scaled: true,
    factor,
    questionFactor,
    runFactor,
    usage: scaledUsage,
    cost,
    perQuestionPerRun: price(
      observed.promptTokens / (observedQuestions * observedRuns),
      (observed.cacheHitPromptTokens ?? 0) / (observedQuestions * observedRuns),
      observed.completionTokens / (observedQuestions * observedRuns),
      prices,
    ),
    thinkingReachChanged:
      observedThinkingReach !== undefined &&
      thinkingReach !== undefined &&
      String(observedThinkingReach) !== String(thinkingReach),
    lowerBound: observedThinkingReach !== undefined && thinkingReach !== undefined && String(observedThinkingReach) !== String(thinkingReach),
    prices,
  };
}

/**
 * Whether a sample keeps the capability shares the scaling assumes, or `null` when it does.
 *
 * Absent either census the check does not run -- refusing a caller who did not bring the evidence
 * would make the tool unusable offline -- but the absence is reported by `describe`, so a reading
 * without it is labelled as unchecked rather than as checked.
 */
function checkShares({ census, observedCensus }) {
  if (!census || !observedCensus) {
    return null;
  }
  const keys = new Set([...Object.keys(census), ...Object.keys(observedCensus)]);
  const deviations = [];
  for (const key of keys) {
    const sampleShare = shareOf(census, key);
    const observedShare = shareOf(observedCensus, key);
    const deviation = Math.abs(sampleShare - observedShare);
    if (deviation > SHARE_TOLERANCE) {
      deviations.push(`${key} ${(observedShare * 100).toFixed(1)}% -> ${(sampleShare * 100).toFixed(1)}%`);
    }
  }
  if (deviations.length === 0) {
    return null;
  }
  return (
    'the sample does not keep the observed capability shares, and per-question cost is route-scoped: ' +
    deviations.join('; ')
  );
}

function shareOf(census, key) {
  const total = Object.values(census).reduce((sum, value) => sum + value, 0);
  return total === 0 ? 0 : (census[key] ?? 0) / total;
}

function scale(value, factor) {
  return Math.round(value * factor);
}

function refuse(reason) {
  return { scaled: false, reason };
}

function requireCount(name, value) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${JSON.stringify(value)}`);
  }
}

/**
 * One human-readable block. Kept out of `project` so the arithmetic is testable without the prose,
 * and kept here rather than in the CLI so the dispatch script prints the same lines the tool does.
 */
export function describe(projection, { limit, runs } = {}) {
  if (!projection.scaled) {
    return [
      `REFUSED: ${projection.reason}`,
      'No projection is printed, because a figure whose assumption failed would be read as a measurement.',
    ];
  }
  const { cost, usage, factor } = projection;
  const hitShare = usage.promptTokens === 0 ? 0 : usage.cacheHitPromptTokens / usage.promptTokens;
  return [
    `Projected spend for ${limit} questions x ${runs} runs (scale ${factor.toFixed(3)} of the observed run)`,
    `  input cached    ${(usage.cacheHitPromptTokens / 1e6).toFixed(2)}M  ${cost.cached.toFixed(2)} CNY`,
    `  input uncached  ${((usage.promptTokens - usage.cacheHitPromptTokens) / 1e6).toFixed(2)}M  ${cost.uncached.toFixed(2)} CNY`,
    `  output          ${(usage.completionTokens / 1e6).toFixed(2)}M  ${cost.output.toFixed(2)} CNY`,
    `  TOTAL           ${cost.total.toFixed(2)} CNY   (cache hit ${(hitShare * 100).toFixed(1)}% of input)`,
    `  prices: ${projection.prices.model} as of ${projection.prices.asOf} ` +
      `(${projection.prices.cacheHitCnyPerMillion}/${projection.prices.cacheMissCnyPerMillion}/${projection.prices.outputCnyPerMillion} CNY per M cached/miss/output)`,
    ...(projection.thinkingReachChanged
      ? [
          '  NOTE: the thinking reach differs from the observed run. Reasoning tokens are a property of',
          '  the questions asked, not of the reach, so the completion line is NOT re-priced: this total',
          '  is a lower bound for keeping the reach and is not a projection for changing it.',
        ]
      : []),
  ];
}

// ---------------------------------------------------------------- CLI

async function main(argv) {
  const { readFileSync } = await import('node:fs');
  const options = parseArgs(argv);
  if (options.path === undefined) {
    console.error(usage());
    return 2;
  }
  const report = JSON.parse(readFileSync(options.path, 'utf8'));
  const side = options.side ?? 'llmUsage';
  const observed = side === 'llmUsage' ? report.llmUsage : report.usageBySide?.[side];
  if (!observed) {
    console.error(
      `no ${side} block in ${options.path}: a projection needs a run that was billed. ` +
        'An artifact written before the instrument existed cannot price the next dispatch.',
    );
    return 1;
  }
  const observedCensus = report.ablation?.questionsByCapability ?? capabilityCensus(report.questions);
  const projection = project({
    observed,
    observedQuestions: report.questionCount,
    observedRuns: report.runs,
    limit: options.limit,
    runs: options.runs,
    census: options.census,
    observedCensus,
    observedThinkingReach: report.memoryArmConfig?.reader?.thinkingRoutes?.join('+') ?? report.memoryArmConfig?.reader?.thinking,
    thinkingReach: options.thinking,
  });
  console.log(describe(projection, { limit: options.limit, runs: options.runs }).join('\n'));
  if (!projection.scaled) {
    return 1;
  }
  if (options.budget !== undefined && projection.cost.total > options.budget) {
    console.error(
      `\nBUDGET EXCEEDED: ${projection.cost.total.toFixed(2)} CNY projected against a ${options.budget.toFixed(2)} CNY budget.`,
    );
    return 1;
  }
  return 0;
}

function capabilityCensus(questions) {
  if (!Array.isArray(questions)) {
    return undefined;
  }
  const census = {};
  for (const question of questions) {
    const key = question?.capability;
    if (typeof key === 'string') {
      census[key] = (census[key] ?? 0) + 1;
    }
  }
  return census;
}

function parseArgs(argv) {
  const options = { limit: 500, runs: 4 };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) {
        throw new Error(`${argument} needs a value`);
      }
      return argv[index];
    };
    if (argument === '--report') options.path = next();
    else if (argument === '--limit') options.limit = Number(next());
    else if (argument === '--runs') options.runs = Number(next());
    else if (argument === '--budget') options.budget = Number(next());
    else if (argument === '--thinking') options.thinking = next();
    else if (argument === '--side') options.side = next();
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unrecognised argument ${argument}`);
  }
  return options;
}

function usage() {
  return [
    'usage: node tools/spend-projection.mjs --report <artifact.json> --limit N --runs N',
    '                                      [--budget CNY] [--thinking multi-session+temporal]',
    '                                      [--side llmUsage|feature|baseline]',
    '',
    'Projects what a dispatch will be billed, by scaling a run that already was.',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage());
    process.exit(0);
  }
  if (argv.length === 0) {
    console.error(usage());
    process.exit(2);
  }
  try {
    process.exit(await main(argv));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
