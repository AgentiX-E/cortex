#!/usr/bin/env node
/**
 * Fold a sharded dispatch's artifacts into one readable population.
 *
 * ## Why this file exists
 *
 * `S12` is registered on 500 corpora asked twice, four repetitions, both sides -- 8,000 graded
 * question-runs. Run `43590434060` measured the throughput of one job at four workers (2 h 09 m) and
 * run `43609290786` measured it again at thirty-two workers (the same 2 h): the wall clock is spent
 * computing, not waiting, so a wider pool does not move it. The only lever left is **more
 * processes**, and `semantic-carry.yml` splits the population by corpus into `shards` jobs.
 *
 * A split dispatch produces N artifacts that each describe a sixteenth of the population. Sixteen
 * artifacts are not a population, and adding their deltas would be an average of averages computed
 * over disjoint samples -- a number that looks like the reading and answers nothing. This tool
 * exists so that the reading is taken from the questions, once, over the whole population.
 *
 * ## What it emits, and what it deliberately does not
 *
 * A **merged evidence** document, not a synthesised report. It carries exactly the keys the reading
 * scripts read -- `questions` (for ids and order), `ablation.baselineCorrectByRun` and
 * `ablation.featureCorrectByRun` (the paired verdict vectors), `population`, `semanticCarry`,
 * `supersession`, `memoryArmConfig`, `runs` -- with the per-question vectors concatenated in shard
 * order and the censuses summed.
 *
 * It does **not** emit `baseline.metrics`, `feature.metrics`, `ablation.pValue`, `ablation.delta`,
 * the confidence intervals or `perCapability`. Those are functions of the whole population computed
 * by `runAblation`, and this tool cannot call it: `runAblation` answers questions, it does not
 * summarise verdicts. Writing them here would be a second implementation of the arm's statistics,
 * and the two would agree until one of them was edited -- the failure `AUDIT-EVAL-CONTRACTS.md`
 * records for the exported protocol types. So they are named in `merged.notRecomputed` with the
 * reason, and the reader is sent to the analysis script, which recomputes the numbers the rows
 * actually read (`semantic_carry_analysis.py` takes `deltaQuestions`, `n` and the McNemar counts off
 * the vectors and needs none of the omitted fields).
 *
 * What it does compute is the one number a human looks for first: the per-repetition accuracy of
 * each side over the merged population, and their mean difference. That is a sum of counts, not a
 * statistic -- `correct / total` per run -- and it is labelled `merged.readings` so it cannot be
 * mistaken for `ablation.delta`.
 *
 * ## The three refusals
 *
 * A merge is only meaningful over parts of **one** experiment, so three defects are refused rather
 * than repaired. Each of them produces a plausible-looking document:
 *
 * 1. **Different layers.** Two shards whose `passShape`, `memoryArmConfig`, `featureConfig`,
 *    `datasetFingerprint` or `runs` differ were not the same dispatch -- a job that ran with the
 *    carry off, or with three repetitions instead of four, contributes a population that is not the
 *    other's.
 * 2. **Missing shards.** Fifteen of sixteen is not a smaller population, it is a population with a
 *    hole, and its `n` would be quoted as if it were whole. The missing indices are named.
 * 3. **Overlapping shards.** The same question answered twice inflates its weight in every count
 *    below, and a shard index typo (two jobs taking shard 3) is exactly how that happens.
 *
 * ## Usage
 *
 *   node tools/merge-ablation.mjs --dir <downloaded-artifacts> --shards 16 --out merged.json
 *
 * `--dir` is searched recursively for `*ablation-report.json`; the shard index is read from each
 * document's own `population.shard`, never from the file name -- a name is assigned by the upload
 * step and a merge that trusted it would be trusting the thing under test.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Keys that must be identical across every shard: one dispatch, one configuration. */
const LAYER_KEYS = [
  'dataset',
  'datasetFingerprint',
  'runs',
  'passShape',
  'memoryArmConfig',
  'featureConfig',
];

/**
 * Keys **inside** `memoryArmConfig` that are censuses rather than configuration.
 *
 * The arm folds per-run readings into the configuration block: `admission` carries
 * `candidates`/`admitted`/`rejected` for the questions this job graded, which differ between two
 * shards of one dispatch for the only reason they should -- they read different corpora. Comparing
 * the block whole therefore refuses every real sharded dispatch, which is what run `43622841638`'s
 * merge job did: `shard 1 differs from shard 0 in memoryArmConfig`, with `candidates` 10020 against
 * 9428 and every configured field identical.
 *
 * A list rather than a rule ("skip keys that contain counts") because the direction of the mistake
 * matters: a new **configuration** field must join the comparison by default, and a new census has
 * to be named here deliberately. The reverse default would let two genuinely different dispatches
 * merge whenever the differing field happened to look numeric.
 */
const CENSUS_IN_CONFIG = new Set(['admission']);

/** `memoryArmConfig` with its censuses removed, for the layer comparison only. */
function configurationOnly(config) {
  if (config === null || typeof config !== 'object') return config;
  const kept = {};
  for (const [key, value] of Object.entries(config)) {
    if (!CENSUS_IN_CONFIG.has(key)) kept[key] = value;
  }
  return kept;
}

/**
 * Canonical JSON, so two objects that differ only in key insertion order compare equal.
 *
 * `JSON.stringify` preserves insertion order, and `memoryArmConfig` is assembled by spreads at
 * several call sites -- so a future reordering would make sixteen identical configurations look like
 * sixteen different ones, and the refusal would fire on a correct dispatch. Sorting is the repair,
 * and doing it here rather than at the comparison keeps the message able to print the difference.
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Every `*ablation-report.json` under `dir`, at any depth. */
function findReports(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) found.push(...findReports(path));
    else if (entry.endsWith('ablation-report.json')) found.push(path);
  }
  return found.sort();
}

function readReport(path) {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  if (document === null || typeof document !== 'object') {
    throw new Error(`${path}: not an object`);
  }
  const shard = document.population?.shard;
  if (shard === undefined) {
    throw new Error(
      `${path} carries no population.shard, so it is not one part of a split dispatch. Merging an ` +
        'unsplit run with sharded ones would double-count the questions it already answers; a single ' +
        'artifact needs no merge.',
    );
  }
  return { path, document, shard };
}

/**
 * Recursively add the numbers of `addition` into `base`, and refuse anything that is not the same
 * shape on both sides.
 *
 * A census that gained a field between two shards is a census whose definition changed mid-dispatch,
 * and silently skipping the field would publish a total that omits one job's contribution.
 */
function foldNumbers(base, addition, path) {
  for (const [key, value] of Object.entries(addition)) {
    const here = `${path}.${key}`;
    const there = base[key];
    if (typeof value === 'number') {
      if (typeof there !== 'number') {
        throw new Error(
          `${here} is a number in one shard and ${there === undefined ? 'absent' : typeof there} ` +
            'in another, so the two artifacts do not share a census definition and their sum would ' +
            'be a total of different things.',
        );
      }
      base[key] = there + value;
    } else if (Array.isArray(value)) {
      if (!Array.isArray(there)) {
        throw new Error(`${here} is an array in one shard and not in another; refusing to merge.`);
      }
      base[key] = [...there, ...value];
    } else if (value !== null && typeof value === 'object') {
      if (there === null || typeof there !== 'object' || Array.isArray(there)) {
        throw new Error(`${here} is an object in one shard and not in another; refusing to merge.`);
      }
      foldNumbers(there, value, here);
    }
    // Strings, booleans and nulls are carried from the first shard: they are identities (`feature`,
    // `reviewPass`) rather than counts, and the layer check above is what proves they agree.
  }
  return base;
}

/** `correct / total` per repetition for one side, from the concatenated bitstrings. */
function perRunAccuracy(vectors) {
  return vectors.map((bits) => {
    const correct = [...bits].filter((bit) => bit === '1').length;
    return bits.length === 0 ? 0 : correct / bits.length;
  });
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function merge(dir, shards) {
  if (!Number.isInteger(shards) || shards < 1) {
    throw new Error(`--shards ${shards} is not a positive whole number.`);
  }
  const paths = findReports(dir);
  if (paths.length === 0) {
    throw new Error(
      `no *ablation-report.json under ${dir}. The download step writes one per shard; an empty ` +
        'directory means the artifacts were not downloaded or the upload step never ran.',
    );
  }
  const parts = paths.map(readReport);

  // 1. One layer.
  const reference = parts[0];
  for (const part of parts.slice(1)) {
    for (const key of LAYER_KEYS) {
      const left = canonical(
        key === 'memoryArmConfig'
          ? configurationOnly(reference.document[key])
          : reference.document[key],
      );
      const right = canonical(
        key === 'memoryArmConfig' ? configurationOnly(part.document[key]) : part.document[key],
      );
      if (left !== right) {
        throw new Error(
          `shard ${part.shard.index} (${part.path}) differs from shard ${reference.shard.index} ` +
            `in \`${key}\`, so the artifacts are not parts of one dispatch. Two configurations ` +
            'merged would produce a population nobody ran; re-dispatch rather than merging.',
        );
      }
    }
    if (part.document.population.windows !== reference.document.population.windows) {
      throw new Error(
        `shard ${part.shard.index} graded ${part.document.population.windows} windows per corpus ` +
          `and shard ${reference.shard.index} graded ${reference.document.population.windows}, so ` +
          'the two are different populations.',
      );
    }
    if (part.document.population.marker !== reference.document.population.marker) {
      throw new Error(
        'the shards disagree on the window marker, so their ids cannot be read by one parser.',
      );
    }
  }

  // 2. Every shard, once.
  const seen = new Map();
  for (const part of parts) {
    const { index, shards: of } = part.shard;
    if (of !== shards) {
      throw new Error(
        `shard ${index} declares ${of} shards and the merge was asked for ${shards}. One of the ` +
          'two is wrong, and a merge over a count nobody agrees on is a merge over an unknown ' +
          'fraction of the population.',
      );
    }
    if (seen.has(index)) {
      throw new Error(
        `shard ${index} appears at ${seen.get(index)} and at ${part.path}. Two artifacts claiming ` +
          'one shard means either a duplicated download or two jobs given the same index -- and ' +
          'either way its questions would be counted twice.',
      );
    }
    seen.set(index, part.path);
  }
  const missing = [];
  for (let index = 0; index < shards; index += 1) {
    if (!seen.has(index)) missing.push(index);
  }
  if (missing.length > 0) {
    throw new Error(
      `the merge is missing shard(s) ${missing.join(', ')} of ${shards}. A partial merge is not a ` +
        'smaller population: the questions those shards would have answered are absent from every ' +
        'count, and the result would be quoted with the full denominator.',
    );
  }
  const ordered = [...parts].sort((left, right) => left.shard.index - right.shard.index);

  // 3. Disjoint questions, and self-consistent lengths.
  const questions = [];
  const owners = new Map();
  for (const part of ordered) {
    const rows = part.document.questions;
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`shard ${part.shard.index} carries no questions; refusing to merge it.`);
    }
    for (const row of rows) {
      const id = row.questionId;
      if (owners.has(id)) {
        throw new Error(
          `question ${JSON.stringify(id)} appears in shard ${owners.get(id)} and in shard ` +
            `${part.shard.index}, so the shards overlap. Every count below would weight it twice.`,
        );
      }
      owners.set(id, part.shard.index);
      questions.push(row);
    }
  }

  const runs = reference.document.runs;
  const vectors = { baseline: [], feature: [] };
  for (const side of ['baseline', 'feature']) {
    const key = `${side}CorrectByRun`;
    const perShard = ordered.map((part) => part.document.ablation[key]);
    if (perShard.some((list) => !Array.isArray(list) || list.length !== runs)) {
      throw new Error(
        `a shard does not carry ${runs} \`${key}\` bitstrings, so its verdicts are not aligned ` +
          'with the repetitions the report declares.',
      );
    }
    // Checked per shard and before concatenation, so the message names the artifact that is wrong
    // rather than the sum it produced.
    for (const part of ordered) {
      for (const [run, bits] of part.document.ablation[key].entries()) {
        if (bits.length !== part.document.questions.length) {
          throw new Error(
            `shard ${part.shard.index} run ${run} carries ${bits.length} verdicts for ` +
              `${part.document.questions.length} questions, so its bitstring is not aligned with ` +
              'its own roster. Concatenated, every later question would shift by the difference.',
          );
        }
      }
    }
    for (let run = 0; run < runs; run += 1) {
      vectors[side].push(perShard.map((list) => list[run]).join(''));
    }
  }
  const mergedCount = questions.length;
  for (const bits of [...vectors.baseline, ...vectors.feature]) {
    if (bits.length !== mergedCount) {
      throw new Error(
        `a concatenated bitstring carries ${bits.length} verdicts for ${mergedCount} questions, ` +
          "so at least one shard's vectors are not aligned with its own roster.",
      );
    }
  }

  const baselineAccuracy = perRunAccuracy(vectors.baseline);
  const featureAccuracy = perRunAccuracy(vectors.feature);
  const document = {
    kind: 'merged-ablation',
    dataset: reference.document.dataset,
    questionCount: mergedCount,
    runs,
    population: {
      windows: reference.document.population.windows,
      // Summed, not `first x shards`. The parts are not equal: 78 corpora over 16 shards is
      // fourteen jobs with 5 and two with 4, so multiplying one part by the count reports 80 -- a
      // population 2.6 % larger than the dispatch, which is exactly the kind of arithmetic a reader
      // cannot check from the merged document alone.
      corpora: ordered.reduce((sum, part) => sum + part.document.population.corpora, 0),
      marker: reference.document.population.marker,
      ...(reference.document.population.shard === undefined
        ? {}
        : { merged: { shards, parts: shards } }),
    },
    memoryArmConfig: reference.document.memoryArmConfig,
    featureConfig: reference.document.featureConfig,
    passShape: reference.document.passShape,
    datasetFingerprint: reference.document.datasetFingerprint,
    ablation: {
      baselineCorrectByRun: vectors.baseline,
      featureCorrectByRun: vectors.feature,
      // Deprecated mirrors of the first repetition, which the artifact has always carried. Written
      // because every existing reader of a single artifact reads them; the bitstrings above are what
      // the reading script actually takes.
      baselineCorrect: [...vectors.baseline[0]].map((bit) => bit === '1'),
      featureCorrect: [...vectors.feature[0]].map((bit) => bit === '1'),
    },
    questions,
    merged: {
      shards,
      parts: ordered.map((part) => ({
        index: part.shard.index,
        questions: part.document.questions.length,
        corpora: part.document.population.corpora,
        path: part.path,
      })),
      // The one number a human looks for first, labelled so it cannot be read as `ablation.delta`:
      // a difference of two ratios over the merged population, not the arm's paired statistic.
      readings: {
        baselineAccuracyPerRun: baselineAccuracy,
        featureAccuracyPerRun: featureAccuracy,
        baselineMeanAccuracy: mean(baselineAccuracy),
        featureMeanAccuracy: mean(featureAccuracy),
        deltaMeanAccuracy: mean(featureAccuracy) - mean(baselineAccuracy),
        deltaQuestionsInFirstRun: [...vectors.feature[0]].filter(
          (bit, at) => bit !== vectors.baseline[0][at],
        ).length,
      },
      notRecomputed: [
        'baseline.metrics',
        'feature.metrics',
        'ablation.delta',
        'ablation.pValue',
        'ablation.effectSize',
        'ablation.baselineConfidence',
        'ablation.featureConfidence',
        'ablation.discordant',
        'ablation.perCapability',
        'ablation.transitions',
        'memoryArmConfig.admission',
        'costEfficiency',
      ],
      notRecomputedWhy:
        'These are functions of the whole population produced by `runAblation`, which answers ' +
        'questions rather than summarising verdicts; a second implementation here would agree with ' +
        'the first until one of them was edited. `admission` is a per-job census that the arm folds ' +
        'into the configuration block, so it is excluded from the layer comparison rather than ' +
        'summed: its `min`/`max`/`mean`/`distinct` are not counts and a sum of them would be ' +
        'nonsense. The rows that matter are read from the vectors: `semantic_carry_analysis.py` ' +
        'takes `deltaQuestions`, `n` and the McNemar counts off `ablation.featureCorrectByRun` and ' +
        '`ablation.baselineCorrectByRun`, which this document carries for exactly that reason.',
    },
  };

  // Censuses are counts, so they are summed. `semanticCarry` and `supersession` are the two the
  // rows read; `llmUsage`, `usageBySide` and `transportRetry` are carried because a cost audit of
  // the merged dispatch needs them and a sum of tokens is a sum of tokens.
  for (const key of [
    'semanticCarry',
    'supersession',
    'llmUsage',
    'usageBySide',
    'transportRetry',
  ]) {
    const first = ordered[0].document[key];
    if (first === undefined) continue;
    const folded = JSON.parse(JSON.stringify(first));
    for (const part of ordered.slice(1)) {
      const value = part.document[key];
      if (value === undefined) {
        throw new Error(
          `shard ${part.shard.index} carries no \`${key}\` while shard ${ordered[0].shard.index} ` +
            'does, so the two were produced by different builds and their totals are not one total.',
        );
      }
      foldNumbers(folded, value, key);
    }
    document[key] = folded;
  }
  return document;
}

function parseArgs(argv) {
  const options = { shards: undefined, dir: undefined, out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${argument} needs a value`);
      return argv[index];
    };
    if (argument === '--dir') options.dir = next();
    else if (argument === '--out') options.out = next();
    else if (argument === '--shards') options.shards = Number(next());
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unrecognised argument ${argument}`);
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help || options.dir === undefined || options.out === undefined) {
    console.log(
      [
        'usage: node tools/merge-ablation.mjs --dir <artifacts> --shards N --out <merged.json>',
        '',
        "Folds one sharded dispatch's per-shard artifacts into one population. Refuses shards from",
        'different layers, a missing shard, and two shards carrying the same question.',
      ].join('\n'),
    );
    return options.help ? 0 : 2;
  }
  const document = merge(options.dir, options.shards);
  writeFileSync(options.out, `${JSON.stringify(document, null, 2)}\n`);
  const { readings } = document.merged;
  console.log(
    `merged ${document.merged.shards} shards -> ${document.questionCount} questions ` +
      `(${document.population.corpora} corpora x ${document.population.windows} windows), ` +
      `${document.runs} repetition(s)`,
  );
  console.log(
    `  accuracy per run: baseline ${readings.baselineAccuracyPerRun
      .map((value) => value.toFixed(4))
      .join(', ')} | feature ${readings.featureAccuracyPerRun
      .map((value) => value.toFixed(4))
      .join(', ')}`,
  );
  console.log(
    `  mean: baseline ${readings.baselineMeanAccuracy.toFixed(4)} | feature ` +
      `${readings.featureMeanAccuracy.toFixed(4)} | difference ` +
      `${readings.deltaMeanAccuracy.toFixed(4)}`,
  );
  console.log(`  wrote ${options.out}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`refusing: ${error.message}`);
    process.exitCode = 1;
  }
}

export { merge };
