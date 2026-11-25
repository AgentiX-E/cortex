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
 * `supersession`, `turnWindow`, `memoryArmConfig`, `runs` -- with the per-question vectors
 * concatenated in shard order and the censuses summed.
 *
 * `turnWindow` was missing from that list for one round, and the omission was invisible because the
 * list is prose: the four hops that carry the census end at the artifact, every one of them has a
 * test, and this tool silently rebuilt the document without it. `turn_window_analysis.py` reads the
 * field off the merged document and reports its absence as "no census", which is the same bytes as a
 * run that never counted -- so `P1` would have gone back to being unreadable at the last hop, after
 * the dispatch that was priced on the strength of it. The list below is the mechanism; this paragraph
 * is why the mechanism now includes every key a reading script names.
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
 * Keys **inside** `memoryArmConfig` that are readings rather than configuration, and what to do with
 * each when two shards disagree.
 *
 * The arm folds per-run measurements into the configuration block after the questions have been
 * answered: `admission` counts the candidates the write gate saw, `selfIndex` is the product's own
 * embedding bill, `voteCounts` counts a vote, `goldAccount` is a verdict about the pools the run
 * produced. All of them differ between two shards of one dispatch for the only reason they should --
 * they read different corpora -- so comparing the block whole refuses every real sharded dispatch.
 *
 * Two dispatches have now paid for this. Run `43622841638` refused on `admission` (`candidates`
 * 10020 against 9428, every configured field identical), which is what the original list in this file
 * was written for. Run `45543010618` refused on `selfIndex`, folded into the block a round later and
 * never named here: eight shards answered their whole population, every job succeeded, and the
 * reading was lost in the merge job. The lesson is not "add `selfIndex`". It is that a list in this
 * file cannot be kept in step with a writer in another file -- and that `restore-classify.py` needed
 * the same list and never got it.
 *
 * So the names live in `tools/arm-config-census.json`, beside a test that binds them to the
 * classification table, and **the arm declares its censuses on the artifact**
 * (`memoryArmConfig.censusKeys`). This map is the fallback for artifacts written before the
 * declaration -- which is every archived one, since they cannot be re-serialised.
 *
 * Two dispositions, because the shapes are not one:
 *
 *  - `fold` -- every leaf is a count, a flag or an identity, so the shards' values can be combined
 *    into the dispatch's. Numbers add, booleans AND (a `false` anywhere is the shard that admits the
 *    total is incomparable, and `true` would have this tool vouch for a store one job did not have),
 *    and disagreements are recorded rather than resolved.
 *  - `drop` -- the object carries `min`/`max`/`mean`/`distinct`, which are not counts, so a sum of
 *    them is not a total of anything. Excluded from the comparison, not carried, and named in
 *    `merged.notRecomputed` so its absence is visible.
 *
 * A key that is declared by the artifact and `drop` here is dropped rather than folded, and named in
 * `merged.droppedCensusKeys`: folding `admission` would add four means and call the result a reading,
 * and folding is the default for anything this file has not seen. That asymmetry is deliberate -- a
 * new census is a count until proven otherwise, and a wrong sum is visible in the artifact while a
 * silently inherited shard-0 value is not.
 */
const CENSUS_IN_CONFIG = (() => {
  const declared = JSON.parse(
    readFileSync(new URL('./arm-config-census.json', import.meta.url), 'utf8'),
  );
  const entries = [
    ...declared.fold.map((key) => [key, 'fold']),
    ...declared.drop.map((key) => [key, 'drop']),
  ];
  return new Map(entries);
})();

/** Keys one artifact declared as censuses, or an empty set for an artifact written before the field. */
function declaredCensuses(config) {
  if (config === null || typeof config !== 'object') return new Set();
  const declared = config.censusKeys;
  if (declared === undefined) return new Set();
  if (!Array.isArray(declared) || declared.some((key) => typeof key !== 'string')) {
    throw new Error(
      'memoryArmConfig.censusKeys is not an array of strings, so the artifact does not say which of ' +
        'its own fields are readings. Refusing rather than guessing, because the guess decides ' +
        'whether two dispatches are compared as one.',
    );
  }
  return new Set(declared);
}

/**
 * Every census key the parts declare, and the ones this file will not fold.
 *
 * The union rather than shard 0's list: a census present in one shard and absent in another is still
 * a census in that shard, and taking the first part's list would fold it in one direction only.
 *
 * A declared key this file knows cannot be added (`admission`'s `min`/`max`/`mean`) is returned
 * separately rather than folded: the arm declares everything it folded into the block, which is the
 * whole point of the declaration, and this file is where the knowledge that four means cannot be
 * summed lives. Returning it lets the merged document say it was dropped instead of quietly doing
 * arithmetic with it.
 */
function censusKeysOf(parts) {
  const foldable = new Set();
  const dropped = new Set();
  for (const part of parts) {
    const config = part.document.memoryArmConfig;
    for (const key of declaredCensuses(config)) {
      if (CENSUS_IN_CONFIG.get(key) === 'drop') dropped.add(key);
      else foldable.add(key);
    }
  }
  return { foldable, dropped };
}

/**
 * `memoryArmConfig` with its censuses removed, for the layer comparison only.
 *
 * `declared` comes from the artifacts and `CENSUS_IN_CONFIG` from this file; the union is what a
 * legacy artifact needs and what a declaring one does not.
 */
function configurationOnly(config, declared = new Set()) {
  if (config === null || typeof config !== 'object') return config;
  const kept = {};
  for (const [key, value] of Object.entries(config)) {
    if (key === 'censusKeys') continue;
    if (declared.has(key) || CENSUS_IN_CONFIG.has(key)) continue;
    kept[key] = value;
  }
  return kept;
}

/**
 * The paths at which two configurations differ, with both values.
 *
 * The refusal used to say `differs in memoryArmConfig` and stop. Finding out that the field was
 * `selfIndex` cost this round an 8 MB artifact download and a diff, and the tool held both values at
 * the moment it decided not to print them. A guard whose message does not say what it saw makes the
 * next reader repeat the work the guard already did.
 */
function differences(left, right, path = 'memoryArmConfig', out = []) {
  const shape = (value) =>
    value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (shape(left) !== shape(right)) {
    out.push({ path, left, right });
    return out;
  }
  if (shape(left) === 'object') {
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      differences(left[key], right[key], `${path}.${key}`, out);
    }
    return out;
  }
  if (canonical(left) !== canonical(right)) out.push({ path, left, right });
  return out;
}

/** One difference, as one line a log can be read for. */
function describe(difference) {
  const value = (input) => {
    if (input === undefined) return 'absent';
    const text = JSON.stringify(input);
    return text.length > 80 ? `${text.slice(0, 77)}...` : text;
  };
  return `${difference.path} ${value(difference.left)} against ${value(difference.right)}`;
}

/**
 * Combine one census across the shards, recording every leaf the shards disagree on.
 *
 * Returns the folded value and the disagreements, rather than throwing on a disagreement: a flag
 * that is `true` in seven jobs and `false` in one is a fact about the dispatch (a store one job did
 * not have), not a reason to discard eight shards of answers. It is recorded so that the number is
 * not quoted without it.
 */
function foldCensus(key, parts) {
  const disagreements = [];
  const walk = (values, path) => {
    const present = values.filter((value) => value !== undefined);
    if (present.length !== values.length) {
      disagreements.push({
        path,
        perShard: Object.fromEntries(
          parts.map((part, at) =>
            values[at] === undefined
              ? [String(part.shard.index), 'absent']
              : [String(part.shard.index), values[at]],
          ),
        ),
      });
    }
    if (present.length === 0) return undefined;
    const first = present[0];
    if (typeof first === 'number') return present.reduce((sum, value) => sum + value, 0);
    if (typeof first === 'boolean') {
      const folded = present.every(Boolean);
      if (present.some((value) => value !== folded)) {
        disagreements.push({
          path,
          perShard: Object.fromEntries(
            parts.map((part, at) => [String(part.shard.index), values[at]]),
          ),
        });
      }
      return folded;
    }
    if (Array.isArray(first)) return present.flat();
    if (first !== null && typeof first === 'object') {
      const keys = new Set(present.flatMap((value) => Object.keys(value)));
      const folded = {};
      for (const child of [...keys].sort()) {
        folded[child] = walk(
          values.map((value) => (value === undefined ? undefined : value[child])),
          `${path}.${child}`,
        );
      }
      return folded;
    }
    if (present.some((value) => value !== first)) {
      disagreements.push({
        path,
        perShard: Object.fromEntries(
          parts.map((part, at) => [String(part.shard.index), values[at]]),
        ),
      });
    }
    return first;
  };
  return {
    key,
    value: walk(
      parts.map((part) => part.document.memoryArmConfig?.[key]),
      `memoryArmConfig.${key}`,
    ),
    disagreements,
  };
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
  // Before the comparison, because the declaration decides what the comparison is over.
  const { foldable: declaredCensuses_, dropped: declaredDropped } = censusKeysOf(parts);
  const censuses = new Set([...declaredCensuses_, ...declaredDropped]);

  // 1. One layer.
  const reference = parts[0];
  for (const part of parts.slice(1)) {
    for (const key of LAYER_KEYS) {
      const left =
        key === 'memoryArmConfig'
          ? configurationOnly(reference.document[key], censuses)
          : reference.document[key];
      const right =
        key === 'memoryArmConfig'
          ? configurationOnly(part.document[key], censuses)
          : part.document[key];
      if (canonical(left) !== canonical(right)) {
        const named =
          key === 'memoryArmConfig'
            ? differences(left, right).map(describe).join('; ')
            : describe({ path: key, left, right });
        throw new Error(
          `shard ${part.shard.index} (${part.path}) differs from shard ${reference.shard.index} ` +
            `in \`${key}\`: ${named}. The artifacts are not parts of one dispatch, and two ` +
            'configurations merged would produce a population nobody ran; re-dispatch rather than ' +
            'merging. (A field that changes because the shards answered different questions is a ' +
            'census; the arm declares those in `memoryArmConfig.censusKeys` and this tool folds ' +
            'them instead of comparing them.)',
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
  // Which shards needed their bitstrings rebuilt, and from which field. Recorded so a reader can tell a
  // vector that was read from one that was reconstructed: the two come from different fields, and a
  // comparison across two merges should not have to infer which of the two it is holding.
  const rebuiltFrom = new Map();
  for (const side of ['baseline', 'feature']) {
    const key = `${side}CorrectByRun`;
    const mirror = `${side}Correct`;
    // ## Why a single-repetition shard may arrive without the per-run array
    //
    // `ablation.ts` writes `*.CorrectByRun` only when `runs > 1`, and the reason is sound: at one
    // repetition the vector would be a second copy of the mirror, and two arrays that must agree are two
    // arrays that can disagree. This merge then required the field unconditionally, so a screening
    // dispatch -- the cheapest pass there is, and the one an experiment starts with -- answered its whole
    // population and was refused here, after paying for it (run `44676731032`).
    //
    // The rebuild is not a guess: at one repetition there is exactly one possible bitstring, and the
    // artifact already carries it as booleans. It is refused when the mirror is absent (nothing was
    // recorded, and a zero-filled vector would read as "every answer was wrong") and when the mirror is
    // not boolean (a string `"1"` coerced with `=== true` would invert every correct answer, and the
    // merged document would report a perfect run as 0% with nothing saying why).
    const perShard = ordered.map((part) => {
      const list = part.document.ablation[key];
      if (Array.isArray(list)) return list;
      if (runs !== 1) {
        throw new Error(
          `a shard does not carry ${runs} \`${key}\` bitstrings, so its verdicts are not aligned ` +
            'with the repetitions the report declares.',
        );
      }
      const bits = part.document.ablation[mirror];
      if (!Array.isArray(bits)) {
        throw new Error(
          `a shard carries neither \`${key}\` nor \`${mirror}\`, so its verdicts are not in the ` +
            'artifact at all. At 1 repetition the merge rebuilds the one bitstring from the mirror; ' +
            'with both absent there is nothing to rebuild from, and a vector of zeroes would publish ' +
            'every answer as wrong.',
        );
      }
      if (bits.some((bit) => typeof bit !== 'boolean')) {
        throw new Error(
          `shard ${part.shard.index} carries a \`${mirror}\` that is not boolean, so the one ` +
            'bitstring this merge would rebuild from it cannot be read without inverting answers. ' +
            'Refusing rather than coercing.',
        );
      }
      const prior = rebuiltFrom.get(part.shard.index);
      rebuiltFrom.set(
        part.shard.index,
        prior === undefined ? `ablation.${mirror}` : `${prior}+ablation.${mirror}`,
      );
      return [bits.map((bit) => (bit ? '1' : '0')).join('')];
    });
    if (perShard.some((list) => !Array.isArray(list) || list.length !== runs)) {
      throw new Error(
        `a shard does not carry ${runs} \`${key}\` bitstrings, so its verdicts are not aligned ` +
          'with the repetitions the report declares.',
      );
    }
    // Checked per shard and before concatenation, so the message names the artifact that is wrong
    // rather than the sum it produced.
    //
    // The rebuilt list is the one checked, not `part.document.ablation[key]`: on the single-repetition
    // path that field does not exist, and this loop is where a rebuilt vector has to face the same
    // roster check as a read one.
    for (const [position, part] of ordered.entries()) {
      for (const [run, bits] of perShard[position].entries()) {
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

  /**
   * One per-question vector, concatenated in shard order, or `undefined` if the parts do not all carry it.
   *
   * `undefined` rather than a short array: a vector built from the parts that happened to have the field
   * would be shorter than the roster and every median computed from it would silently drop the shards
   * that did not -- the failure `concatenated bitstring carries N verdicts for M questions` refuses one
   * level up. A field that is not in every part is a field this merge cannot carry, and saying so is what
   * `notCarried` below is for.
   */
  const concatenate = (key) => {
    const values = ordered.map((part) => part.document.ablation?.[key]);
    if (values.some((value) => !Array.isArray(value))) return undefined;
    const flat = values.flat();
    if (flat.length !== mergedCount) {
      throw new Error(
        `ablation.${key} concatenates to ${flat.length} entries for ${mergedCount} questions, so at ` +
          "least one shard's vector is not aligned with its own roster.",
      );
    }
    return flat;
  };

  const baselineRoleCensuses = concatenate('baselineRoleCensuses');
  const baselinePromptChars = concatenate('baselinePromptChars');
  const ablation = {
    baselineCorrectByRun: vectors.baseline,
    featureCorrectByRun: vectors.feature,
    // Deprecated mirrors of the first repetition, which the artifact has always carried. Written
    // because every existing reader of a single artifact reads them; the bitstrings above are what
    // the reading script actually takes.
    baselineCorrect: [...vectors.baseline[0]].map((bit) => bit === '1'),
    featureCorrect: [...vectors.feature[0]].map((bit) => bit === '1'),
    // `C7`'s `F3` divides a turns median on this side by the feature's, over one roster -- so both have
    // to be here. Written on the same absence rule as `turnWindow` above: a dispatch whose arm predates
    // the fields produces a merged document without them, and `read-merged-population.py` reports that
    // as "no density reading" rather than as a ratio over half a population.
    ...(baselineRoleCensuses === undefined ? {} : { baselineRoleCensuses }),
    ...(baselinePromptChars === undefined ? {} : { baselinePromptChars }),
  };

  // Whatever a part wrote and this merge did not produce, derived rather than restated. The list of
  // carried keys used to be prose, and prose lost `turnWindow` for a full round: every hop that carried
  // the census had a test and this tool rebuilt the document without it. A derived list makes the next
  // omission visible in the artifact instead of in a reader's surprise.
  const written = new Set(ordered.flatMap((part) => Object.keys(part.document.ablation ?? {})));
  const carried = new Set(Object.keys(ablation));
  const notCarried = [...written].filter((key) => !carried.has(key)).sort();

  // The configuration block, with its readings folded rather than inherited from shard 0.
  //
  // `selfIndex.indexes` for a 500-question dispatch is the sum of eight jobs' 126, and taking the
  // first part's number would put a shard's bill on a population eight times its size. The declared
  // keys come from the artifacts; the `fold` keys of `CENSUS_IN_CONFIG` are the same treatment for
  // artifacts written before the declaration existed. `drop` keys are not in either set, so they stay
  // as the reference shard wrote them and `notRecomputed` says so.
  const foldable = [
    ...new Set([
      ...declaredCensuses_,
      ...[...CENSUS_IN_CONFIG].filter(([, how]) => how === 'fold').map(([key]) => key),
    ]),
  ].sort();
  const censusFold = foldable
    .map((key) => foldCensus(key, ordered))
    .filter((folded) => folded.value !== undefined);
  const memoryArmConfig = { ...(reference.document.memoryArmConfig ?? {}) };
  for (const folded of censusFold) memoryArmConfig[folded.key] = folded.value;
  const foldedCensusKeys = censusFold.map((folded) => folded.key).sort();
  const censusDisagreements = censusFold.flatMap((folded) => folded.disagreements);

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
    memoryArmConfig,
    featureConfig: reference.document.featureConfig,
    passShape: reference.document.passShape,
    datasetFingerprint: reference.document.datasetFingerprint,
    ablation,
    questions,
    merged: {
      shards,
      // Derived, not restated: every `ablation` key a part wrote that this merge did not produce. The
      // carried list above is code, and code can lose a field the way prose lost `turnWindow` for a
      // round -- but here the loss is named in the artifact instead of waiting for a reader holding both.
      notCarried,
      // Which numbers in `memoryArmConfig` were added rather than taken from one shard. A reader
      // cannot tell `embedTexts: 39912` from a dispatch's 39912 without this line, and the next
      // census the arm declares will not need a reader to know it was declared.
      ...(foldedCensusKeys.length === 0 ? {} : { foldedCensusKeys }),
      // Every leaf the shards disagreed on, with each shard's value. Not an error: a store that was
      // missing in one job is a fact about the dispatch, and the number it makes incomparable is
      // reported beside it instead of being discarded.
      ...(censusDisagreements.length === 0 ? {} : { censusDisagreements }),
      // Declared readings that were excluded instead of added, because their leaves are not counts.
      // Named rather than silently honoured: a reader who sees `admission` absent from the block has
      // to be able to find out that it was dropped on purpose.
      ...(declaredDropped.size === 0 ? {} : { droppedCensusKeys: [...declaredDropped].sort() }),
      parts: ordered.map((part) => ({
        index: part.shard.index,
        questions: part.document.questions.length,
        corpora: part.document.population.corpora,
        path: part.path,
        // Absent on the path that read the per-run arrays, and named on the path that rebuilt them.
        ...(rebuiltFrom.has(part.shard.index)
          ? { bitstringsFrom: rebuiltFrom.get(part.shard.index) }
          : {}),
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
  // the merged dispatch needs them and a sum of tokens is a sum of tokens. `turnWindow` is carried
  // because `turn_window_analysis.py` reads `cut` and `marked` off it to report `P1`, and every one
  // of its five numbers is a count of turns or of questions -- the two identities the four hops
  // below the artifact were written to make checkable (`cut + whole` per question, `questions` and
  // `unreported` summing to the roster) only survive the fold if the fold sums them.
  for (const key of [
    'semanticCarry',
    'supersession',
    'turnWindow',
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
