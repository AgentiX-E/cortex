#!/usr/bin/env node
/**
 * Price the retrieval axis before any retrieval mechanism is dispatched.
 *
 * ## Why §13.126's ceiling of five questions is the wrong measurement
 *
 * §13.126 computed the ceiling of "every mechanism that changes the **order** of what was already
 * retrieved" as the count of wrong questions whose **best** gold turn sits at rank ten or beyond. It
 * got five, and five is right for that question. It is not right for this one, and the difference is
 * the whole of §13.150.
 *
 * `goldRanks` is a list, one entry per eligible gold turn. `carried` is how many of those turns the
 * reader was shown. A question with seventeen golds, twelve carried and a best rank of eight is
 * invisible to §13.126's count -- the *first* gold is near the top, so the question is filed under
 * "the reader had what it needed". The five turns it was **not** shown are the region a mechanism that
 * changes *which* region is retrieved can act on, and no permutation of the delivered list can
 * produce them.
 *
 * So there are two ceilings on the retrieval axis, they bound different mechanisms, and they are not
 * interchangeable:
 *
 * | mechanism | what it changes | ceiling |
 * | --- | --- | --- |
 * | reranking, fusion weight, any permutation | the order of the delivered turns | questions whose **best** gold is deep (§13.126) |
 * | query expansion, per-entity retrieval, a deeper pool | **which** turns are delivered | questions with at least one eligible gold **not delivered** (this tool) |
 *
 * The second is the larger one on every capability, and on MR and TR the first is a strict subset of
 * it -- which is why §13.126's "the retrieval axis can move at most five questions" was a true
 * statement about permutations being read as a statement about retrieval.
 *
 * ## Why this needs no model call, and what that does *not* buy
 *
 * `goldOverlap` is written by every arm artifact, so the ledger below is arithmetic over published
 * records. What it cannot say is whether a sub-query would in fact surface the missing gold: the pool
 * the artifact recorded is the one the **original** question retrieved, and `expand` would query with
 * different keys. A gold outside that pool is therefore *addressable* in principle and *unproven* in
 * fact, and this tool reports it as addressable rather than as reachable. §13.150.5 states the
 * dispatch that would settle it.
 *
 * ## The three buckets, stated so a reader can check the arithmetic
 *
 * For one question, with `total` eligible golds, `pool` of them surfaced by the index, and `carried`
 * of them delivered to the reader:
 *
 * - **delivered** -- `carried`. Already in the prompt. A region change cannot add it.
 * - **deep in the pool**, `max(0, pool - carried)` -- the index saw it and the delivery did not. A
 *   region change can promote it without any index change, which makes this the **cheapest** target.
 *   A lower bound: a record whose `carried` exceeds `pool` evidently delivered turns the pool did not
 *   rank, so the identity `pool - carried` is an inequality in general and this tool reports the tight
 *   side of it.
 * - **outside the pool**, `missing - deepInPool` where `missing = max(0, total - carried)`. Neither
 *   the index nor the reader has it. If `expand` is "one retrieval per named thing", these are exactly
 *   what a per-entity query can reach that a single whole-question query did not.
 *
 * ## Usage
 *
 *     node tools/expand-resolution.mjs --artifact <report.json> [--json]
 *
 * Exit 2 is malformed input, exit 1 is an artifact that cannot support the reading, exit 0 is a reading.
 */

import { readFileSync } from 'node:fs';
import process from 'node:process';

/**
 * The capability order this campaign reports in, fixed so two runs print comparable tables.
 * A capability the artifact carries that is not listed here is appended rather than dropped.
 */
const CAPABILITY_ORDER = ['IE', 'MR', 'KU', 'TR', 'ABS'];

/**
 * Month and weekday names, as the cue class LongMemEval's time-aware query expansion reads.
 *
 * Lowercase because the match is case-insensitive: a question that opens a month name is as much a
 * temporal cue as one that writes it mid-sentence, and capitalisation is a typing habit rather than a
 * semantic distinction here.
 */
const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

/**
 * The cue families a rule-based decomposer reads, each as a regular expression over the lowercased
 * question, and each naming a **different retrieval key** rather than a different phrasing of one.
 *
 * ## The first version of this table was wrong in a way the roster could have told it
 *
 * It shipped three families -- an absolute named period, a cardinality word, a conjunction -- and on the
 * 44 reachable questions of `40751394094` it found a question it could split **9** times. Reading the
 * questions themselves showed why: they almost never name a month. They say `in the last month`,
 * `in the past three months`, `two weeks ago`, `most recently`. The absolute-period family matched 5 of
 * the 83 wrong questions (6.0%) while the relative one matches 16 (19.3%), and the 9-of-44 that the
 * first table reached was a measurement of the wrong cue, not of the mechanism.
 *
 * Families are separated because they fail differently and because they are **not interchangeable as
 * keys**: a named or relative period scopes a retrieval to a window, a cardinality word scopes it to
 * "one turn per item", an ordering word scopes it to "every dated event in a range", a magnitude word
 * scopes it to "the number attached to this attribute". A question that fires two of them is a question
 * where one retrieval would have to satisfy two constraints at once, which is the case a single
 * whole-question query blurs.
 */
const CUE_FAMILIES = [
  {
    name: 'absolute-period',
    pattern: new RegExp(`\\b(?:${[...MONTHS, ...WEEKDAYS].join('|')})\\b|\\b(?:19|20)\\d{2}\\b`),
  },
  {
    // `last month`, `the past three months`, `two weeks ago`, `yesterday`, `most recently`. The family
    // that carries this roster and that the first version of this table did not have.
    name: 'relative-period',
    pattern:
      /\b(?:last|past|next|previous|this|coming)\s+(?:\w+\s+){0,2}(?:day|week|month|year|quarter|decade)s?\b|\b(?:ago|yesterday|today|tomorrow|recently|currently|now|previously|still)\b/,
  },
  {
    name: 'cardinality',
    pattern: /\bhow many\b|\bhow much\b|\btotal\b|\bnumber of\b|\baltogether\b|\bcombine\b/,
  },
  {
    // Order-of-events questions: the answer is a sequence, so the retrieval key is "every dated event
    // in the range", which is a different query from any single fact lookup.
    name: 'ordering',
    pattern:
      /\bwhat is the order\b|\bearliest\b|\blatest\b|\bwhich came first\b|\bbefore\b|\bafter\b|\bmost recent\b|\bhow long\b/,
  },
  {
    // A magnitude or a rate: the answer is a number attached to one attribute, and the retrieval key is
    // that attribute together with its unit.
    name: 'magnitude',
    pattern: /\bpercentage\b|\bpercent\b|\bdiscount\b|\bhow old\b|\bdifference\b|\baverage\b/,
  },
  {
    name: 'conjunction',
    pattern: /\b(?:and|or|both|either|neither|versus|vs)\b/,
  },
];

/**
 * How many distinct retrieval keys the rule families name for this question, as a lower bound.
 *
 * One per family, plus one more for a conjunction -- `X and Y` names two operands, so it asks for one
 * retrieval per operand *and* the combined phrase, which is the reference pipeline's own retention rule
 * (`buildQueryExpansionPromptWith`, `decomposeConjunctions`). Counting the family and stopping would
 * price a two-operand question as one key.
 *
 * This is a **lower bound** and the reason is stated rather than implied: the reference pipeline's
 * `analyzeQuery` also resolves relative dates against `now`, which cannot be done from the question text
 * alone, and it names operands by part of speech rather than by cue word. A question this tool scores as
 * 1 is one no rule of these families splits; it is not one that a better decomposer could not split.
 */
function subQueriesOf(question) {
  const text = String(question).toLowerCase();
  const fired = CUE_FAMILIES.filter((cue) => cue.pattern.test(text)).map((cue) => cue.name);
  const extra = fired.includes('conjunction') ? 1 : 0;
  return { count: Math.max(1, fired.length + extra), fired };
}

/**
 * What one question's record says about the region its reader was given.
 *
 * Returns `null` when the record cannot support the reading, rather than a zeroed object: an absent
 * `goldOverlap` means "this question has no gold turns to measure" (the §13.11.2 rule the product's own
 * `goldOverlapOf` documents), and rendering that as `{missing: 0}` would file a question nothing can
 * describe as a question whose evidence was complete.
 */
function ledgerOf(record) {
  const overlap = record.goldOverlap;
  if (overlap === null || typeof overlap !== 'object') return null;
  const { total, carried } = overlap;
  if (!Number.isInteger(total) || !Number.isInteger(carried)) return null;
  if (total <= 0) return null;
  if (carried < 0 || carried > total) {
    throw new Error(
      `question ${record.questionId}: carried ${carried} is outside 0..${total}. A record whose delivery ` +
        'exceeds its own denominator is malformed, and a ceiling computed from it would be a number ' +
        'nothing bounds.',
    );
  }
  // `pool` is optional: artifacts written before `poolGold` existed carry the two-field object, and a
  // missing pool is "the index was not asked" rather than "the index found nothing" (§13.123.1's
  // reason for adding the field). Treating it as zero would file every such question's missing golds
  // as outside-pool, which is a different and stronger claim than the record makes.
  const pool = Number.isInteger(overlap.pool) ? overlap.pool : null;
  if (pool !== null && (pool < 0 || pool > total)) {
    throw new Error(
      `question ${record.questionId}: pool ${pool} is outside 0..${total}. The pool is a subset of the ` +
        'eligible golds by construction, so a larger count means the two were computed over different ' +
        'sets and the split below would be arithmetic on mixed denominators.',
    );
  }
  // `goldRanks` is one entry per eligible gold, so a list of another length was computed over another
  // set. Both numbers would still look plausible -- `permutation` would be right about the questions it
  // saw and silent about the golds the list omitted -- which is why this is refused rather than tolerated.
  if (Array.isArray(overlap.goldRanks) && overlap.goldRanks.length !== total) {
    throw new Error(
      `question ${record.questionId}: goldRanks carries ${overlap.goldRanks.length} entries for ${total} ` +
        'eligible golds. The list is one entry per gold, so a different length means the ranks and the ' +
        'denominator were computed over different sets.',
    );
  }
  const missing = total - carried;
  // The tight side of the identity, for the reason the module docstring states.
  const deepInPool = pool === null ? null : Math.max(0, Math.min(pool, total) - carried);
  return {
    total,
    pool,
    carried,
    missing,
    deepInPool,
    outsidePool: deepInPool === null ? null : Math.max(0, missing - deepInPool),
  };
}

/** How many sub-queries the three rule classes split this question into, as a lower bound. */
/**
 * Read one artifact into per-capability rows.
 *
 * A question whose record cannot support the ledger is counted as **unjudgeable** and excluded from
 * every ceiling: a denominator that includes questions nothing can describe is a denominator that can
 * only grow, and the point of a ceiling is that it is attainable.
 */
function readArtifact(artifact) {
  const records = artifact.questions;
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error(
      'artifact carries no `questions` array. This tool reads the roster the arm published; a report ' +
        'without one is a different product and its ceilings would be invented.',
    );
  }
  const rows = new Map();
  const unjudgeable = [];
  for (const record of records) {
    if (typeof record.correct !== 'boolean') {
      throw new Error(
        `question ${record.questionId}: \`correct\` is ${typeof record.correct}, not a boolean. Python's ` +
          '`True` is an `int`) and a truthiness test would file it as a correct answer, which is the ' +
          'shape §13.107 refuses for every counter in this campaign.',
      );
    }
    const capability = record.capability;
    if (!rows.has(capability)) {
      rows.set(capability, {
        questions: 0,
        correct: 0,
        wrong: 0,
        unjudgeable: 0,
        reachable: 0,
        deepInPoolQuestions: 0,
        outsidePoolQuestions: 0,
        deepInPoolGold: 0,
        outsidePoolGold: 0,
        permutation: 0,
        decomposable: 0,
        reachableAndDecomposable: 0,
        correctDecomposable: 0,
        subQueries: 0,
      });
    }
    const row = rows.get(capability);
    row.questions += 1;
    const ledger = ledgerOf(record);
    if (ledger === null) {
      // A correct question with no measurable gold is still correct; only the ceiling needs the ledger.
      row.correct += record.correct ? 1 : 0;
      row.wrong += record.correct ? 0 : 1;
      row.unjudgeable += record.correct ? 0 : 1;
      continue;
    }
    if (record.correct) {
      row.correct += 1;
      // The holdout. The families were read off the wrong questions' own text, so their coverage of
      // those questions is a fitted quantity and cannot be cited as evidence that the rules generalise.
      // Coverage of the **correct** questions is measured on text the rules were not chosen against, and
      // a rule set that scored high on one and low on the other would be a rule set written to fit.
      if (subQueriesOf(record.question).count > 1) row.correctDecomposable += 1;
      continue;
    }
    row.wrong += 1;
    const sub = subQueriesOf(record.question);
    row.subQueries += sub.count;
    if (sub.count > 1) row.decomposable += 1;
    if (ledger.missing > 0) {
      row.reachable += 1;
      if (sub.count > 1) row.reachableAndDecomposable += 1;
    }
    // §13.126's count, computed here rather than in the printer so the two ceilings come from one
    // pass over one ledger. `best` is the smallest non-negative rank, and a question whose golds were
    // all outside the pool has no rank to compare -- it is not a permutation target at all, because a
    // permutation needs something already delivered to permute.
    const ranks = Array.isArray(record.goldOverlap?.goldRanks)
      ? record.goldOverlap.goldRanks.filter((rank) => Number.isInteger(rank) && rank >= 0)
      : [];
    if (ranks.length > 0 && Math.min(...ranks) >= 10) row.permutation += 1;
    if (ledger.deepInPool !== null && ledger.deepInPool > 0) {
      row.deepInPoolQuestions += 1;
      row.deepInPoolGold += ledger.deepInPool;
    }
    if (ledger.outsidePool !== null && ledger.outsidePool > 0) {
      row.outsidePoolQuestions += 1;
      row.outsidePoolGold += ledger.outsidePool;
    }
  }
  return { rows, unjudgeable };
}

/** The capability names, in the campaign's order, with any extras appended in first-seen order. */
function capabilityNames(rows) {
  const extras = [...rows.keys()].filter((capability) => !CAPABILITY_ORDER.includes(capability));
  return [...CAPABILITY_ORDER, ...extras].filter((capability) => rows.has(capability));
}

function parseArguments(argv) {
  const parsed = { artifact: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') {
      parsed.json = true;
    } else if (flag === '--artifact') {
      parsed.artifact = argv[index + 1] ?? null;
      index += 1;
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
  }
  if (parsed.artifact === null) throw new Error('--artifact is required');
  return parsed;
}

function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(options.artifact, 'utf8'));
  } catch (error) {
    process.stderr.write(`cannot read ${options.artifact}: ${error.message}\n`);
    return 2;
  }
  let reading;
  try {
    reading = readArtifact(artifact);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
  const names = capabilityNames(reading.rows);
  const totals = {
    questions: 0,
    correct: 0,
    wrong: 0,
    reachable: 0,
    deepInPoolQuestions: 0,
    outsidePoolQuestions: 0,
    deepInPoolGold: 0,
    outsidePoolGold: 0,
    decomposable: 0,
    correctDecomposable: 0,
  };
  for (const name of names) {
    for (const key of Object.keys(totals)) totals[key] += reading.rows.get(name)[key];
  }
  if (options.json) {
    const body = {
      capabilities: Object.fromEntries(names.map((name) => [name, reading.rows.get(name)])),
      totals,
      // The point equivalent is the ceiling expressed in the unit the roster is scored in, because a
      // count of questions and a share of the roster are the same fact and only one of them is what a
      // reader compares a published accuracy against.
      ceilingPoints: totals.questions === 0 ? 0 : (100 * totals.reachable) / totals.questions,
    };
    process.stdout.write(`${JSON.stringify(body, null, 2)}\n`);
    return 0;
  }
  const lines = [];
  lines.push(`artifact ${options.artifact}`);
  lines.push(
    `roster ${totals.questions} questions, ${totals.correct} correct (${((100 * totals.correct) / totals.questions).toFixed(2)}%), ${totals.wrong} wrong`,
  );
  lines.push('');
  lines.push('The region ledger, per capability, over the wrong questions only:');
  lines.push(
    `  ${'cap'.padEnd(5)}${'wrong'.padStart(7)}${'carried=total'.padStart(15)}${'missing gold'.padStart(14)}` +
      `${'deep in pool'.padStart(14)}${'outside pool'.padStart(14)}${'reachable'.padStart(11)}`,
  );
  for (const name of names) {
    const row = reading.rows.get(name);
    const carriedAll = row.wrong - row.reachable - row.unjudgeable;
    lines.push(
      `  ${name.padEnd(5)}${String(row.wrong).padStart(7)}${String(carriedAll).padStart(15)}` +
        `${String(row.reachable).padStart(14)}${String(row.deepInPoolGold).padStart(14)}` +
        `${String(row.outsidePoolGold).padStart(14)}${String(row.reachable).padStart(11)}`,
    );
  }
  lines.push('');
  lines.push(
    'The two ceilings on the retrieval axis, which bound different mechanisms and are not interchangeable:',
  );
  lines.push(
    `  ${'cap'.padEnd(5)}${'wrong'.padStart(7)}${'permutation (§13.126)'.padStart(23)}${'region (this tool)'.padStart(19)}${'region, points'.padStart(16)}`,
  );
  for (const name of names) {
    const row = reading.rows.get(name);
    lines.push(
      `  ${name.padEnd(5)}${String(row.wrong).padStart(7)}${String(row.permutation).padStart(23)}` +
        `${String(row.reachable).padStart(19)}${((100 * row.reachable) / Math.max(1, row.questions)).toFixed(2).padStart(16)}`,
    );
  }
  lines.push('');
  lines.push('The rule-based decomposition, over every wrong question with a measurable ledger:');
  lines.push(
    `  ${'cap'.padEnd(5)}${'wrong'.padStart(7)}${'decomposable'.padStart(14)}${'share'.padStart(9)}${'reachable & decomposable'.padStart(26)}`,
  );
  for (const name of names) {
    const row = reading.rows.get(name);
    lines.push(
      `  ${name.padEnd(5)}${String(row.wrong).padStart(7)}${String(row.decomposable).padStart(14)}` +
        `${`${((100 * row.decomposable) / Math.max(1, row.wrong)).toFixed(1)}%`.padStart(9)}` +
        `${String(row.reachableAndDecomposable).padStart(26)}`,
    );
  }
  lines.push('');
  lines.push(
    'The holdout the rule set has to survive: the same families read against the questions the arm got RIGHT,',
  );
  lines.push('on text they were not chosen against. A rule set fitted to the failures scores high on one and low on the other.');
  lines.push(
    `  ${'cap'.padEnd(5)}${'wrong, split'.padStart(14)}${'share'.padStart(9)}${'correct, split'.padStart(17)}${'share'.padStart(9)}${'delta'.padStart(10)}`,
  );
  for (const name of names) {
    const row = reading.rows.get(name);
    const wrongShare = (100 * row.decomposable) / Math.max(1, row.wrong);
    const correctShare = (100 * row.correctDecomposable) / Math.max(1, row.correct);
    lines.push(
      `  ${name.padEnd(5)}${`${row.decomposable}/${row.wrong}`.padStart(14)}${`${wrongShare.toFixed(1)}%`.padStart(9)}` +
        `${`${row.correctDecomposable}/${row.correct}`.padStart(17)}${`${correctShare.toFixed(1)}%`.padStart(9)}` +
        `${`${(wrongShare - correctShare).toFixed(1)}`.padStart(10)}`,
    );
  }
  lines.push('');
  lines.push(
    `Region ceiling: ${totals.reachable} of ${totals.wrong} wrong questions, which is ` +
      `${((100 * totals.reachable) / totals.questions).toFixed(2)} points of the ${totals.questions}-question roster.`,
  );
  lines.push(
    `  Of the missing golds, ${totals.deepInPoolGold} were surfaced by the index and not delivered -- the cheap ` +
      'target, since promoting them needs no new retrieval -- and ' +
      `${totals.outsidePoolGold} were never surfaced at all.`,
  );
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

process.exitCode = main();
