#!/usr/bin/env node
/**
 * The joint reading, off two artifacts.
 *
 * `C1` prices the context and `S1` prices the accuracy, and neither row can say which of two arms is
 * better. This tool is the caller `packages/cortex-eval/src/efficiency-frontier.ts` needs in order to
 * be a library rather than an advertisement, and it is also how the reading is produced: point it at
 * the artifacts of two dispatches and it prints the dominance verdict and the frontier.
 *
 * ## What it reads, and the one shape it insists on
 *
 * An artifact is a `cortex-eval` ablation report: `questionCount`, `runs`, the arm's `Metrics` under
 * `feature.metrics` (or `metrics` for a bare arm report), and the token ledger under
 * `usageBySide.feature` (or `usage`). Anything else is refused by name rather than defaulted, because
 * a missing token ledger silently becomes an accuracy-only comparison — the reading this whole module
 * exists to prevent — and a zero would be worse than an error.
 *
 * ## What it deliberately does not do
 *
 * It does not read the artifact's own accuracy *summary* fields for the population. `metrics.correct`
 * over `metrics.total` is the pair the module needs, and the reported `accuracy` is a rendering of it
 * at one of two possible populations (`§13.308`); taking the rendering and inventing a denominator
 * for it is the defect that produced a 54%-cheaper-looking arm. The counts or nothing.
 */
import { readFileSync } from 'node:fs';

// The dist path rather than the barrel, for the reason `tools/paired-flip.mjs` gives: the barrel is
// the package's public API and a tool is not a consumer of a published interface.
import {
  CACHE_HIT_PRICE_RATIO,
  DEFAULT_EFFICIENCY_POLICY,
  compareEfficiency,
  efficiencyFrontier,
  profileOf,
} from '../packages/cortex-eval/dist/efficiency-frontier.js';

const CAPABILITIES = ['IE', 'MR', 'KU', 'TR', 'ABS'];

function fail(message) {
  process.stderr.write(`efficiency-frontier: ${message}\n`);
  process.exit(2);
}

function readArtifact(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${path} is not readable JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parsed;
}

/** `feature.metrics` on an ablation report, `metrics` on a bare arm report. */
function metricsOf(artifact, path) {
  const metrics = artifact?.feature?.metrics ?? artifact?.metrics;
  if (metrics === undefined || metrics === null) {
    fail(`${path} carries no metrics (looked for feature.metrics and metrics)`);
  }
  if (!Number.isInteger(metrics.correct) || !Number.isInteger(metrics.total)) {
    fail(`${path} carries metrics without integer correct/total counts: ${JSON.stringify(metrics)}`);
  }
  return metrics;
}

/** `usageBySide.feature` on a report that split the bill, `usage` on one that did not. */
function usageOf(artifact, path) {
  const usage = artifact?.usageBySide?.feature ?? artifact?.usage;
  if (usage === undefined || usage === null) {
    fail(`${path} carries no token ledger (looked for usageBySide.feature and usage)`);
  }
  if (!Number.isFinite(usage.promptTokens) || usage.promptTokens <= 0) {
    fail(`${path} carries no prompt token count: ${JSON.stringify(usage)}`);
  }
  return usage;
}

/**
 * A name for the arm.
 *
 * `--label` wins, then whatever the artifact calls itself, then the position. The override exists
 * because two dispatches of one arm both call themselves `cortex-memory`, and the frontier is keyed on
 * the name: without an override the only reading it can produce is "compareEfficiency needs two arms",
 * which is true and useless.
 */
function labelOf(artifact, ordinal, labels) {
  const override = labels[ordinal];
  if (override !== undefined) return override;
  const candidate = artifact?.label ?? artifact?.feature?.name ?? artifact?.arm;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : `arm${ordinal}`;
}

/**
 * The point, in the units the module reads.
 *
 * `runs` is not cosmetic: `usageBySide.feature.promptTokens` is a total over every repetition, and
 * dividing it by the question count alone would report four repetitions' spend as one (§13.308).
 */
function pointOf(path, ordinal, labels) {
  const artifact = readArtifact(path);
  const metrics = metricsOf(artifact, path);
  const usage = usageOf(artifact, path);
  const runs = Number.isInteger(artifact.runs) && artifact.runs > 0 ? artifact.runs : 1;
  const questionCount = Number.isInteger(artifact.questionCount) ? artifact.questionCount : 0;
  if (questionCount <= 0) fail(`${path} carries no questionCount`);
  const perCapability = [];
  for (const capability of CAPABILITIES) {
    const entry = metrics.perCapability?.[capability];
    if (entry === undefined) continue;
    if (!Number.isInteger(entry.correct) || !Number.isInteger(entry.total)) {
      fail(`${path} carries ${capability} without integer correct/total counts`);
    }
    perCapability.push({ capability, correct: entry.correct, total: entry.total });
  }
  if (perCapability.length === 0) fail(`${path} carries no capability breakdown`);
  return {
    arm: labelOf(artifact, ordinal, labels),
    overall: { correct: metrics.correct, total: metrics.total },
    perCapability,
    runs,
    promptTokensPerQuestion: usage.promptTokens / (questionCount * runs),
    cacheHitShare:
      Number.isFinite(usage.cacheHitPromptTokens) && usage.promptTokens > 0
        ? usage.cacheHitPromptTokens / usage.promptTokens
        : 0,
  };
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * `--margin` and `--tolerance` are settable because the policy is pre-registered per experiment, and
 * the defaults are only the values this project registered for the LongMemEval arm. Naming them on the
 * command line is what makes a reading reproducible a year later.
 */
function policyFrom(argv) {
  const read = (flag, fallback) => {
    const index = argv.indexOf(flag);
    if (index === -1) return fallback;
    const raw = argv[index + 1];
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) fail(`${flag} needs a non-negative number, got ${raw}`);
    return value;
  };
  return {
    margin: read('--margin', DEFAULT_EFFICIENCY_POLICY.margin),
    tokenTolerance: read('--tolerance', DEFAULT_EFFICIENCY_POLICY.tokenTolerance),
  };
}

/** Every `--flag value` pair the tool accepts, so a path is never mistaken for a value. */
const VALUED_FLAGS = new Set(['--margin', '--tolerance', '--label']);

function main(argv) {
  const json = argv.includes('--json');
  const positional = argv.filter((argument, index) => {
    if (argument.startsWith('--')) return false;
    return !VALUED_FLAGS.has(argv[index - 1]);
  });
  const paths = positional;
  const labels = argv.reduce((acc, argument, index) => {
    if (argv[index - 1] === '--label') acc.push(argument);
    return acc;
  }, []);
  if (paths.length < 2) {
    fail('needs at least two artifact paths: the reference first, then the arms compared to it');
  }
  // Every arm has to run the same number of repetitions, and this is a refusal rather than a warning.
  // The cache-hit share moves with `runs` (one repetition misses, the rest hit), so a 4-vs-2 pair
  // reads a 6.9x bill that is the repetition count and not the system. The two axes that do not move
  // with `runs` -- accuracy and context -- are still readable, and they are readable from a tool that
  // says so out loud instead of printing a column a reader would quote.
  const runCounts = new Set();
  for (const path of paths) {
    const artifact = readArtifact(path);
    runCounts.add(Number.isInteger(artifact.runs) && artifact.runs > 0 ? artifact.runs : 1);
  }
  if (runCounts.size > 1) {
    fail(
      `the artifacts ran different repetition counts (${[...runCounts].join(', ')}); the cache-hit ` +
        'share and therefore the bill move with `runs`, so the bill is not comparable. Compare arms ' +
        'dispatched with the same number of repetitions',
    );
  }
  const policy = policyFrom(argv);
  if (labels.length > 0 && labels.length !== paths.length) {
    fail(`--label was given ${labels.length} time(s) for ${paths.length} artifact(s)`);
  }
  const points = paths.map((path, index) => pointOf(path, index, labels));
  const profiles = points.map(profileOf);
  const reference = profiles[0];
  const verdicts = profiles.slice(1).map((profile) => ({
    arm: profile.arm,
    ...compareEfficiency(profile, reference, policy),
  }));
  const frontier = efficiencyFrontier(points, policy);

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          policy,
          reference: { arm: reference.arm, ...reference },
          arms: profiles.map((profile) => ({ ...profile })),
          verdicts,
          frontier,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const lines = [];
  lines.push(`policy: margin ${policy.margin} accuracy, token tolerance ${policy.tokenTolerance}`);
  lines.push(
    `pricing: a cache hit is charged at ${(CACHE_HIT_PRICE_RATIO * 100).toFixed(0)}% of a miss, ` +
      'so the billed column is below the context column by exactly the cache share',
  );
  lines.push('');
  lines.push('| arm | accuracy | 95% interval | tokens/question | billed | cache |');
  lines.push('| --- | ---: | --- | ---: | ---: | ---: |');
  for (const profile of profiles) {
    lines.push(
      `| ${profile.arm} | ${percent(profile.overall.value)} | ` +
        `${percent(profile.overall.lower)}–${percent(profile.overall.upper)} | ` +
        `${profile.promptTokensPerQuestion.toFixed(0)} | ` +
        `${profile.billedPromptTokensPerQuestion.toFixed(0)} | ` +
        `${percent(points.find((point) => point.arm === profile.arm)?.cacheHitShare ?? 0)} |`,
    );
  }
  lines.push('');
  for (const verdict of verdicts) {
    lines.push(
      `${verdict.arm} vs ${reference.arm}: **${verdict.outcome}** ` +
        `(context ${verdict.tokenRatio.toFixed(3)}x, billed ${verdict.billedTokenRatio.toFixed(3)}x)` +
        (verdict.blocking.length === 0 ? '' : `, blocked on ${verdict.blocking.join(', ')}`) +
        (verdict.unresolvable.length === 0
          ? ''
          : `, unresolvable on ${verdict.unresolvable.join(', ')}`),
    );
  }
  lines.push('');
  lines.push(`frontier: ${frontier.front.join(', ') || '(none)'}`);
  for (const entry of frontier.dominated) {
    lines.push(`  ${entry.arm} is dominated by ${entry.by.join(', ')}`);
  }
  if (frontier.underpoweredPairs > 0) {
    lines.push(
      `  ${frontier.underpoweredPairs} pair(s) were underpowered: the margin is finer than the ` +
        'sample resolves, and a rerun of the same size will not change that',
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

// A refusal from the library is an input problem, not a crash: `profileOf` and `compareEfficiency`
// throw by name on a malformed point, and a stack trace would bury the sentence that says which arm
// and which field. Routed through `fail` so the exit code is the same 2 for every refusal.
try {
  main(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
