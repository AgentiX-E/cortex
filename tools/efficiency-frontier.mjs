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

/**
 * The population the accuracy was read on.
 *
 * `feature.metrics` is **one repetition** and `ablation.featureAggregate` is the mean over all of them,
 * and `report.ts` documents why the second is the right one (`costEfficiency`'s `accuracySource`): the
 * numerator of every cost ratio is a sum over every repetition, so the denominator has to describe the
 * same repetitions or the ratio is two populations. This tool read `feature.metrics` in its first
 * version and therefore reported `42310779222` at 90.20% when its four repetitions average **90.85%**,
 * and `42355323615` at 91.40% when they average **91.95%** — in both cases the first repetition, which
 * happened to be the worst. The correction is the repository's own documented rule rather than a new
 * decision, which is the part worth noting: the field was named and the tool still read the other one.
 */
function accuracyOf(artifact, path, metrics, capability) {
  const aggregate = artifact?.ablation;
  if (capability === undefined) {
    const avg = aggregate?.featureAggregate?.avg;
    if (Number.isFinite(avg)) {
      return { correct: avg * metrics.total, source: 'repetition-mean' };
    }
    return { correct: metrics.correct, source: 'first-repetition' };
  }
  const avg = aggregate?.featureByCapability?.[capability]?.avg;
  const entry = metrics.perCapability?.[capability];
  if (Number.isFinite(avg) && entry !== undefined) {
    return { correct: avg, source: 'repetition-mean' };
  }
  return { correct: entry?.correct ?? null, source: 'first-repetition' };
}

/** `feature.metrics` on an ablation report, `metrics` on a bare arm report. */
function metricsOf(artifact, path) {
  const metrics = artifact?.feature?.metrics ?? artifact?.metrics;
  if (metrics === undefined || metrics === null) {
    fail(`${path} carries no metrics (looked for feature.metrics and metrics)`);
  }
  if (!Number.isInteger(metrics.correct) || !Number.isInteger(metrics.total)) {
    fail(
      `${path} carries metrics without integer correct/total counts: ${JSON.stringify(metrics)}`,
    );
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
    perCapability.push({
      capability,
      correct: accuracyOf(artifact, path, metrics, capability).correct,
      total: entry.total,
    });
  }
  if (perCapability.length === 0) fail(`${path} carries no capability breakdown`);
  const overall = accuracyOf(artifact, path, metrics);
  return {
    arm: labelOf(artifact, ordinal, labels),
    overall: { correct: overall.correct, total: metrics.total },
    accuracySource: overall.source,
    perCapability,
    runs,
    promptTokensPerQuestion: usage.promptTokens / (questionCount * runs),
    cacheHitShare:
      Number.isFinite(usage.cacheHitPromptTokens) && usage.promptTokens > 0
        ? usage.cacheHitPromptTokens / usage.promptTokens
        : 0,
  };
}

/**
 * Fields that are a **rendering of another field** rather than a configuration of their own.
 *
 * `*Routes` lists are computed from the scalar beside them (`ask` produces `askRoutes`,
 * `promptContract` produces `renderingRoutes`, `thinking` produces `thinkingRoutes`), and
 * `effectivePromptChars.*` is the room after the per-route map is applied. Counting them as differences
 * would report a one-variable pair as a three-variable one and push a caller straight back to ignoring
 * the check.
 */
const DERIVED_FIELDS = /(Routes$|^effectivePromptChars\.)/;

/**
 * The same variable written two ways.
 *
 * A room can be stated globally (`maxPromptChars: 48000`) or per route
 * (`maxPromptCharsByRoute: { 'multi-session': 48460 }`), and the artifact records whichever the dispatch
 * named. Comparing the spellings would report one variable as three and step over the alias map that
 * `cost.json`'s `roomSource` already carries. Collapsing the per-route keys onto the global one is the
 * same reading the room inference performs.
 */
const FIELD_ALIASES = [[/^maxPromptChars(ByRoute)?(\..+)?$/, 'maxPromptChars']];

function canonicalField(field) {
  for (const [pattern, name] of FIELD_ALIASES) {
    if (pattern.test(field)) return name;
  }
  return field;
}

function flattenConfig(config, prefix = '') {
  const flat = {};
  for (const [key, value] of Object.entries(config ?? {})) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(flat, flattenConfig(value, `${prefix}${key}.`));
    } else {
      flat[`${prefix}${key}`] = JSON.stringify(value ?? null);
    }
  }
  return flat;
}

/**
 * The configuration fields that differ between the reference and an arm.
 *
 * This exists because the campaign has now made the same mistake twice. `42355323615` was used as the
 * control for the 24,000-character window cut, and it differs from that arm in **two** fields — `ask`
 * (`verbatim-acts` against `verbatim`) and the room map (`maxPromptCharsByRoute` against
 * `maxPromptChars`) — so `MR −6.61` was reported as the window's cost when it belongs to the pair.
 * Against the arm that differs in one field the same cut reads `MR −0.83`, `TR −3.94` and `−2.00`
 * overall. A two-variable difference is not a controlled comparison, and the only defence that works is
 * a check rather than a resolution to be careful.
 */
function configDelta(reference, arm) {
  if (reference === undefined || arm === undefined) return undefined;
  const left = flattenConfig(reference);
  const right = flattenConfig(arm);
  const fields = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
  const differing = new Set();
  for (const field of fields) {
    if (DERIVED_FIELDS.test(field)) continue;
    if (left[field] === right[field]) continue;
    differing.add(canonicalField(field));
  }
  return [...differing].sort();
}

/**
 * A p-value, with the floor named rather than printed as zero.
 *
 * `toPrecision(3)` on 1e-96 renders `1.00e-96` and on a saturated normal tail renders `0.00`, and a printed
 * zero is a probability the arithmetic does not support: the exact fold returns an integer tail out of
 * `2^n`, so the smallest value it can return is `2^-n`, and the normal fallback saturates near 1e-16. Both
 * are far below any threshold the policy can set, which makes the reader's question "how far below" rather
 * than "is it zero".
 */
function showP(value) {
  if (value === 0) return '< 1e-16 (tail saturated)';
  return value < 1e-4 ? value.toExponential(2) : value.toPrecision(3);
}

function percent(value) {
  return `${(value * 100).toFixed(2)}%`;
}

/**
 * The policy, which is pre-registered per experiment.
 *
 * `--margin`, `--tolerance` and `--alpha` are settable because those three numbers are chosen before a
 * dispatch, and the defaults are only the values this project registered for this arm. Naming them on
 * the command line is what makes a reading reproducible a year later; a default that was never stated
 * is a policy nobody can disagree with.
 */
function policyFrom(argv) {
  const read = (flag, fallback) => {
    const index = argv.indexOf(flag);
    if (index === -1) return fallback;
    const raw = argv[index + 1];
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0)
      fail(`${flag} needs a non-negative number, got ${raw}`);
    return value;
  };
  return {
    margin: read('--margin', DEFAULT_EFFICIENCY_POLICY.margin),
    tokenTolerance: read('--tolerance', DEFAULT_EFFICIENCY_POLICY.tokenTolerance),
    alpha: read('--alpha', DEFAULT_EFFICIENCY_POLICY.alpha),
  };
}

/**
 * Per-question repetition counts, or `undefined` when the artifact predates the masks.
 *
 * `ablation.featureCorrectByRun` is one correctness mask per repetition, indexed like `questions[]`, and it
 * has been written since §13.88 — which means the data a repetition-mean paired test needs has been in every
 * four-repetition artifact this project produced, and the reader that ran on repetition 0 was discarding it.
 * A mask is a string of `'1'`/`'0'`; a boolean array is accepted too, because the field is a persisted
 * format and a future writer that emits booleans should not silently downgrade every reader to unpaired.
 */
function repetitionCounts(artifact, path) {
  const aggregate = artifact?.ablation;
  const masks = aggregate?.featureCorrectByRun;
  const questions = artifact?.questions;
  if (!Array.isArray(masks) || masks.length === 0) return undefined;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  for (const mask of masks) {
    // A mask is a string of `'1'`/`'0'` in every artifact written so far, and an array of booleans is
    // accepted because the field is a persisted format: a future writer that emits booleans must not
    // silently downgrade every reader to the unpaired fallback.
    const usable = typeof mask === 'string' || Array.isArray(mask);
    if (!usable || mask.length !== questions.length) {
      fail(
        `${path} carries a correctness mask of ${mask?.length} against ${questions.length} questions; ` +
          'the two arrays index the same population or the pairing is positional',
      );
    }
  }
  const counts = new Map();
  for (let index = 0; index < questions.length; index += 1) {
    const id = questions[index]?.questionId;
    if (typeof id !== 'string') {
      fail(
        `${path} carries a question record without a questionId; the pairing would be positional`,
      );
    }
    let right = 0;
    for (const mask of masks) {
      const cell = mask[index];
      if (cell === '1' || cell === true || cell === 1) right += 1;
    }
    counts.set(id, right);
  }
  return { counts, runs: masks.length };
}

/**
 * What the two arms did question by question, for the labels they were both read on.
 *
 * Two shapes come out of here and the library treats them differently:
 *
 * - `series` when **both** artifacts carry per-repetition masks. Each question becomes "`a` right in 3 of
 *   4, `b` in 1 of 4" and the exact sign-flip test runs on the integer differences.
 * - `discordant` when either artifact stores only one answer per question. The single answer is the
 *   evidence there is, and inventing repetitions for it would divide a p-value by a factor nothing measured.
 *
 * The join is on `questionId` and never on position, for the reason the first version of this function
 * already gave: two dispatches may enumerate in different orders, and a positional join would pair two
 * different questions while looking correct.
 */
function pairedOf(pathA, pathB, artifactA, artifactB) {
  const questionsA = Array.isArray(artifactA?.questions) ? artifactA.questions : undefined;
  const questionsB = Array.isArray(artifactB?.questions) ? artifactB.questions : undefined;
  if (questionsA === undefined || questionsB === undefined) return undefined;

  const seriesA = repetitionCounts(artifactA, pathA);
  const seriesB = repetitionCounts(artifactB, pathB);
  const canPair = seriesA !== undefined && seriesB !== undefined;

  const byId = new Map();
  for (const record of questionsA) {
    if (typeof record?.questionId !== 'string') {
      fail(
        `${pathA} carries a question record without a questionId; the pairing would be positional`,
      );
    }
    if (!canPair && typeof record.correct !== 'boolean') {
      fail(`${pathA} carries ${record.questionId} without a boolean correct field`);
    }
    byId.set(record.questionId, record);
  }

  const counters = new Map([['overall', { wonByA: 0, wonByB: 0, questions: [] }]]);
  const bucketFor = (label) => {
    if (!counters.has(label)) counters.set(label, { wonByA: 0, wonByB: 0, questions: [] });
    return counters.get(label);
  };
  let joined = 0;
  for (const record of questionsB) {
    const twin = byId.get(record?.questionId);
    if (twin === undefined) continue;
    joined += 1;
    let a;
    let b;
    if (canPair) {
      a = seriesA.counts.get(record.questionId);
      b = seriesB.counts.get(record.questionId);
      if (a === undefined || b === undefined) continue;
    } else {
      if (typeof record.correct !== 'boolean') {
        fail(`${pathB} carries ${record.questionId} without a boolean correct field`);
      }
      a = twin.correct === true ? 1 : 0;
      b = record.correct === true ? 1 : 0;
    }
    if (a > b) bucketFor('overall').wonByA += 1;
    if (b > a) bucketFor('overall').wonByB += 1;
    bucketFor('overall').questions.push({ a, b });
    // A capability bucket is only formed when both records agree on the capability: the two artifacts are
    // allowed to have regrouped their questions, and a bucket spanning two capabilities would be a paired
    // test of a population that is not the capability.
    if (twin.capability !== record.capability) continue;
    if (typeof record.capability !== 'string' || !CAPABILITIES.includes(record.capability))
      continue;
    const bucket = bucketFor(record.capability);
    if (a > b) bucket.wonByA += 1;
    if (b > a) bucket.wonByB += 1;
    bucket.questions.push({ a, b });
  }
  if (joined === 0) return undefined;

  const runs = canPair ? Math.max(seriesA.runs, seriesB.runs) : 1;
  return [...counters.entries()].map(([label, bucket]) =>
    canPair
      ? { kind: 'series', label, runs, questions: bucket.questions }
      : { kind: 'discordant', label, wonByA: bucket.wonByA, wonByB: bucket.wonByB },
  );
}

const VALUED_FLAGS = new Set(['--margin', '--tolerance', '--alpha', '--label', '--ship']);

/**
 * How far one dispatch's own repetitions move — the floor every promotion has to clear.
 *
 * ## Why this is measured per artifact and not between two dispatches
 *
 * The tempting null control is "run the same configuration twice and see how far apart the two land", and
 * this project has none: of the five full-500 artifacts, the only pair whose fields nearly match differs in
 * `relevanceUnits` (`turn` against `session-fill`), which is a substantive change and not a rerun. A first
 * version of this function accepted that pair and reported a 0.65-point floor off it — a number with the
 * shape of a measurement and the content of a confound.
 *
 * What every artifact does carry is its own repetitions: `ablation.featureCorrectByRun` is four passes of
 * **one** configuration, so the spread of their four accuracies is a direct reading of how much the runner
 * moves on its own. On `42310779222` those four read 451, 452, 460 and 454 correct — a standard deviation of
 * **0.81 points** and a standard error of **0.40** — and on `42337560027` the same figure is 0.85 and 0.43.
 *
 * ## Why the standard error and not the standard deviation
 *
 * The quantity being promoted is the **mean of the repetitions**, because that is the accuracy every other
 * row reads. The uncertainty of that mean is `sd / sqrt(runs)`. Reporting the `sd` instead would make every
 * arm with more repetitions look noisier, which is backwards.
 *
 * ## What it is not
 *
 * A **lower bound** on dispatch-to-dispatch noise. Two runs on different days with a cold prefix cache, a
 * different runner image and a provider that routes to another shard move more than four passes of one
 * process do. Nothing in the artifacts measures that, so the floor here is honest about being the part that
 * is measurable and the reader is left with the direction of the error rather than a false precision.
 */
function repetitionSpreadOf(artifact, path) {
  const masks = artifact?.ablation?.featureCorrectByRun;
  const questions = artifact?.questions;
  if (!Array.isArray(masks) || masks.length < 2) return undefined;
  if (!Array.isArray(questions) || questions.length === 0) return undefined;
  const accuracies = masks.map((mask) => {
    let right = 0;
    for (let index = 0; index < questions.length; index += 1) {
      const cell = mask[index];
      if (cell === '1' || cell === true || cell === 1) right += 1;
    }
    return right / questions.length;
  });
  const runs = accuracies.length;
  const mean = accuracies.reduce((total, value) => total + value, 0) / runs;
  const variance =
    accuracies.reduce((total, value) => total + (value - mean) * (value - mean), 0) / (runs - 1);
  const sd = Math.sqrt(variance);
  return { runs, mean, sd, se: sd / Math.sqrt(runs), accuracies };
}

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
  const shipIndex = argv.indexOf('--ship');
  const shipLabel = shipIndex === -1 ? undefined : argv[shipIndex + 1];
  if (paths.length < 2) {
    fail('needs at least two artifact paths: the reference first, then the arms compared to it');
  }
  const policy = policyFrom(argv);
  const artifacts = paths.map((path) => readArtifact(path));
  const points = paths.map((path, index) => pointOf(path, index, labels));
  // The floor is the widest per-arm standard error among the arms being compared, because a promotion has
  // to clear the noisiest side of the pair it is read from. With no per-repetition masks anywhere it stays
  // absent, and `compareEfficiency` treats absent as "not measured" rather than as zero.
  const spreads = artifacts
    .map((artifact, index) => repetitionSpreadOf(artifact, paths[index]))
    .filter((spread) => spread !== undefined);
  if (spreads.length > 0) {
    const widest = spreads.reduce((left, right) => (right.se > left.se ? right : left));
    policy.noiseFloor = {
      delta: widest.se,
      source: `per-repetition spread across ${widest.runs} repetitions, standard error of the mean`,
      points: { sd: widest.sd, se: widest.se, runs: widest.runs },
    };
    if (widest.se > policy.margin) {
      process.stderr.write(
        `efficiency-frontier: one dispatch's own repetitions move ${(100 * widest.se).toFixed(2)} points ` +
          `(standard error), which is wider than the ${(100 * policy.margin).toFixed(1)}-point margin; no ` +
          'promotion on this population can clear both floors at once, and that is the finding rather ' +
          'than a misconfiguration.\n',
      );
    }
  }
  if (labels.length > 0 && labels.length !== paths.length) {
    fail(`--label was given ${labels.length} time(s) for ${paths.length} artifact(s)`);
  }
  // Unequal repetition counts used to be a refusal, and that was one axis too many. The bill is the
  // only reading `runs` confounds -- `82355323615`'s own pair showed the share is not even a stable
  // function of it -- so refusing the whole comparison threw away a valid accuracy reading and a valid
  // context reading to protect a bill the library already knows how to exclude. The library is the
  // authority: `compareEfficiency` reports `billComparable: false` and drops the term from both the
  // promotion and the demotion clause. The tool's job is to say so loudly, not to refuse.
  //
  // Equal `runs` is also **not sufficient**, which the same pair proves: `42310779222` and
  // `42355323615` both ran four repetitions and read 78.21% and 98.34% cache hits, so the bill stays a
  // reported figure with an admissibility flag rather than a trusted one.
  const runCounts = new Set(
    artifacts.map((artifact) =>
      Number.isInteger(artifact.runs) && artifact.runs > 0 ? artifact.runs : 1,
    ),
  );
  const runsEqual = runCounts.size === 1;
  if (!runsEqual) {
    process.stderr.write(
      `efficiency-frontier: the artifacts ran ${[...runCounts].join(' and ')} repetitions, so the ` +
        'bill is not admissible as evidence (the cache-hit share moves with it). Accuracy and context ' +
        'are still read; no cost claim may be taken from this output.\n',
    );
  }

  const profiles = points.map(profileOf);
  const reference = profiles[0];

  // Pairing is per arm against the reference, because the evidence is a fact about two specific runs.
  // The argument order is the comparison's order -- the arm first, the reference second -- because
  // `wonByA` means "`a` answered it and `b` did not", and passing them the other way round leaves every
  // `resolved` flag correct (McNemar is symmetric) while inverting the sentence a reader quotes.
  const pairedByArm = profiles
    .slice(1)
    .map((profile, index) =>
      pairedOf(paths[index + 1], paths[0], artifacts[index + 1], artifacts[0]),
    );
  const verdicts = profiles.slice(1).map((profile, index) => {
    const verdict = compareEfficiency(profile, reference, policy, pairedByArm[index]);
    const delta = configDelta(artifacts[0].memoryArmConfig, artifacts[index + 1].memoryArmConfig);
    // A dominance claim needs a pair that differs in one field. Where it does not, the arithmetic is
    // still arithmetic and is still printed -- but it may not promote an arm, because the difference it
    // would promote is not attributable to the variable the comparison is named after.
    const matched = delta === undefined || delta.length <= 1;
    // A multi-field pair gets its own word. It was `incomparable` for a round, which conflated two findings
    // that call for different work: "the instrument cannot tell these apart" is answered by more repetitions,
    // and "this pair is better but two things moved" is answered by a step that moves one. `confounded` says
    // the second, and the `ladder` block is where the steps are.
    return {
      arm: profile.arm,
      ...verdict,
      configDelta: delta ?? null,
      matched,
      outcome: matched ? verdict.outcome : 'confounded',
    };
  });
  const frontier = efficiencyFrontier(points, policy);

  // Every pair in the set that differs in exactly one substantive field, whichever two arms it joins.
  //
  // The verdict list above only pairs each arm with the reference, and a chain of single-variable steps does
  // not usually run through the reference: `42310779222 (verbatim) -> 42337560027 (verbatim-acts) -> 42355323615
  // (route room)` is one field at a time and neither step touches a third arm. Reporting only reference pairs
  // hides that, and a multi-field comparison then looks unattributable when the attribution exists one row
  // down. This block is what makes the additive check possible: if two single-variable steps read +0.50 and
  // +0.60 and the pair that combines them reads +1.10, the three numbers are consistent and the pair is
  // attributable after all.
  const ladder = [];
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      const fields = configDelta(artifacts[left].memoryArmConfig, artifacts[right].memoryArmConfig);
      if (fields === undefined || fields.length !== 1) continue;
      const paired = pairedOf(paths[right], paths[left], artifacts[right], artifacts[left]);
      const verdict = compareEfficiency(profiles[right], profiles[left], policy, paired);
      ladder.push({
        from: points[left].arm,
        to: points[right].arm,
        variable: fields[0],
        deltaPoints: profiles[right].overall.value - profiles[left].overall.value,
        tokenRatio: verdict.tokenRatio,
        outcome: verdict.outcome,
        blocking: verdict.blocking,
        belowNoise: verdict.belowNoise,
        paired: verdict.paired,
      });
    }
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          policy,
          reference: { arm: reference.arm, ...reference },
          // The profile carries the derived reading; the source of that reading is a fact about the
          // point it was derived from, so both are here rather than in two places a caller has to join.
          arms: profiles.map((profile, index) => ({
            ...profile,
            accuracySource: points[index].accuracySource,
            cacheHitShare: points[index].cacheHitShare,
          })),
          verdicts,
          // The one number a gate can read. `dominating` is how many measured arms beat the configured
          // one on the three-axis order, and it is the reading that says whether the ship configuration
          // is still the best thing this project knows how to build.
          summary: {
            dominating: verdicts.filter((verdict) => verdict.outcome === 'dominated').length,
            dominated: verdicts.filter((verdict) => verdict.outcome === 'dominates').length,
            incomparable: verdicts.filter((verdict) => verdict.outcome === 'incomparable').length,
            confounded: verdicts.filter((verdict) => verdict.outcome === 'confounded').length,
            underpowered: verdicts.filter((verdict) => verdict.outcome === 'underpowered').length,
            belowNoise: verdicts.filter((verdict) => verdict.belowNoise.length > 0).length,
            matchedPairs: verdicts.filter((verdict) => verdict.matched).length,
            // The one single-variable pair, and its bill **only if the bill is admissible**. `null` is
            // the reading `C3` needs when the arms ran different repetition counts: the row can then be
            // `unrun` with a named blocker instead of quoting a ratio that is the repetition count.
            matched: (() => {
              // The **cheaper** single-variable arm, not simply the first one. `C3` asks what the bill is at
              // a reduced budget, so a one-field pair that did not reduce anything (`fill-base`, 0.998x) is a
              // single variable and not this variable. The first version of this block took the first
              // `matched` verdict and, as soon as a fifth arm was added, pointed `C3` at the arm that left
              // the budget alone.
              const single = verdicts.find(
                (verdict) => verdict.matched && verdict.tokenRatio < 1 - policy.tokenTolerance,
              );
              if (single === undefined) return null;
              return {
                arm: single.arm,
                outcome: single.outcome,
                billComparable: single.billComparable,
                billedTokenRatio: single.billComparable ? single.billedTokenRatio : null,
              };
            })(),
            pairedPairs: verdicts.filter((verdict) => verdict.pairedUsed).length,
          },
          frontier,
          ladder,
          // Which arm this project would ship, and the reading that would have to move if it stopped being
          // the best one. Written as one object so `S1` can read `shipping.accuracy` with an attestation on
          // `shipping.accuracySource` and `shipping.runs` — a criterion bound to a *label* rather than to a
          // path cannot go stale, because the label is resolved to an artifact on every run.
          shipping: (() => {
            if (shipLabel === undefined) return null;
            const index = labels.indexOf(shipLabel);
            if (index === -1) fail(`--ship names ${shipLabel}, which is not one of --label`);
            return {
              arm: shipLabel,
              accuracy: profiles[index].overall.value,
              accuracySource: points[index].accuracySource,
              runs: points[index].runs,
              promptTokensPerQuestion: profiles[index].promptTokensPerQuestion,
            };
          })(),
          // Which artifact the comparison is against, and why that is not the same question as "which
          // arm do we ship". The reference is the arm each candidate differs from in the fewest fields,
          // so that a single-variable reading exists at all; `C1` reads a *different* artifact
          // (`42355323615`, 12,137 tokens) because it prices the newest shipping candidate rather than
          // the window-cut control. The two are 0.26% apart on context and 1.2 points apart on accuracy,
          // and no row says which one "the registered arm" is -- recorded here instead of resolved,
          // because resolving it means a dispatch rather than an edit.
          // What the set is and what it is not. The reference is the first path, and every arm is compared
          // to it; the `ladder` above is the block that carries attribution when the reference is not the
          // arm a given candidate differs from in one field.
          provenance: {
            referenceArm: points[0].arm,
            armOrder: points.map((point) => point.arm),
            accuracySource: points[0].accuracySource,
            whyTheReferenceIsTheReference:
              'the first path on the command line, and the only arm every other one is read against; ' +
              'a candidate that differs from it in two fields is `confounded` rather than incomparable, ' +
              'and its attribution is the ladder one row down',
            whatTheLadderIsNot:
              'not a path. Two single-variable steps only add up when nothing interacts, and the check is ' +
              'arithmetic rather than an assumption: 0.50 for `ask` plus 0.60 for the room is 1.10, which ' +
              'is what the pair that moves both reads',
          },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const lines = [];
  lines.push(
    `policy: margin ${policy.margin} accuracy, token tolerance ${policy.tokenTolerance}, ` +
      `paired alpha ${policy.alpha}`,
  );
  lines.push(
    `pricing: a cache hit is charged at ${(CACHE_HIT_PRICE_RATIO * 100).toFixed(0)}% of a miss, ` +
      'so the billed column is below the context column by exactly the cache share',
  );
  lines.push('');
  lines.push('| arm | accuracy | read on | 95% interval | tokens/question | billed | cache |');
  lines.push('| --- | ---: | --- | --- | ---: | ---: | ---: |');
  for (const profile of profiles) {
    lines.push(
      `| ${profile.arm} | ${percent(profile.overall.value)} | ` +
        `${points.find((point) => point.arm === profile.arm)?.accuracySource ?? 'unknown'} | ` +
        `${percent(profile.overall.lower)}–${percent(profile.overall.upper)} | ` +
        `${profile.promptTokensPerQuestion.toFixed(0)} | ` +
        `${profile.billedPromptTokensPerQuestion.toFixed(0)} | ` +
        `${percent(points.find((point) => point.arm === profile.arm)?.cacheHitShare ?? 0)} |`,
    );
  }
  lines.push('');
  if (points.some((point) => point.accuracySource === 'repetition-mean')) {
    lines.push(
      'read on: accuracy is the mean over repetitions where the artifact records one; the interval is',
      'still the single-run Wilson at 500 questions, which over-covers rather than under-covers.',
      'Where both artifacts carry `ablation.featureCorrectByRun`, the paired test reads the same',
      'repetition means the accuracy does — a question is "right in three of four" and the test is exact',
      'sign-flip over the integer differences. Where one side stores only one answer per question, the',
      'pairing falls back to that answer and the test is McNemar; the two are labelled per label.',
      '',
    );
  }
  if (policy.noiseFloor !== undefined) {
    const floor = policy.noiseFloor.points;
    lines.push(
      `noise floor: one dispatch's own ${floor.runs} repetitions differ by a standard deviation of ` +
        `${(100 * floor.sd).toFixed(2)} points, so the mean it reports carries a standard error of ` +
        `${(100 * floor.se).toFixed(2)} points. A promotion must clear this and the significance level; ` +
        'a demotion is not protected by it.',
      '',
    );
  }
  for (const verdict of verdicts) {
    lines.push(
      `${verdict.arm} vs ${reference.arm}: **${verdict.outcome}** ` +
        `(context ${verdict.tokenRatio.toFixed(3)}x, billed ${verdict.billedTokenRatio.toFixed(3)}x)` +
        (verdict.billComparable ? '' : ', bill NOT comparable') +
        (verdict.blocking.length === 0 ? '' : `, blocked on ${verdict.blocking.join(', ')}`) +
        (verdict.unresolvable.length === 0
          ? ''
          : `, unresolvable on ${verdict.unresolvable.join(', ')}`) +
        (verdict.belowNoise.length === 0
          ? ''
          : `, ahead but under the noise floor on ${verdict.belowNoise.join(', ')}`),
    );
    for (const entry of verdict.paired) {
      lines.push(
        `  ${entry.label}: ${entry.wonByA} won / ${entry.wonByB} lost over ${entry.pairs} ` +
          `disagreeing question(s) [${entry.test}], exact p = ${showP(entry.pValue)}` +
          (entry.resolved ? ' -- resolved' : ' -- not significant'),
      );
    }
    if (!verdict.pairedUsed) {
      lines.push('  unpaired: no per-question records on both sides, so the margin rule decides');
    }
    if (verdict.configDelta === null) {
      lines.push(
        '  config: neither artifact records a memoryArmConfig, so the pair is not admissible',
      );
    } else if (verdict.configDelta.length === 0) {
      lines.push('  config: identical, so this pair measures a run and not a variable');
    } else if (verdict.configDelta.length === 1) {
      lines.push(`  config: single variable -- ${verdict.configDelta[0]}`);
    } else {
      lines.push(
        `  config: NOT a single-variable pair, differs on ${verdict.configDelta.join(', ')}; ` +
          'the difference is the pair and not the variable, so nothing is certified',
      );
    }
  }
  lines.push('');
  lines.push('single-variable steps in this set');
  if (ladder.length === 0) {
    lines.push('  (none: no two arms differ in exactly one field)');
  }
  for (const step of ladder) {
    const pairs = step.paired
      .filter((entry) => entry.label === 'overall')
      .map(
        (entry) =>
          `${entry.wonByA} won / ${entry.wonByB} lost over ${entry.pairs} disagreeing question(s), ` +
          `p = ${showP(entry.pValue)}`,
      );
    lines.push(
      `  ${step.from} -> ${step.to} [${step.variable}]: ${(100 * step.deltaPoints).toFixed(2)} points, ` +
        `context ${step.tokenRatio.toFixed(3)}x, ${step.outcome}` +
        (pairs.length > 0 ? ` (${pairs.join('; ')})` : ' (unpaired)') +
        (step.belowNoise.length > 0
          ? `, ahead but under the noise floor on ${step.belowNoise.join(', ')}`
          : ''),
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
