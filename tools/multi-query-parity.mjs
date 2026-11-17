#!/usr/bin/env node
/**
 * Does the product's multi-query rank the way the instrument's does?
 *
 *     node tools/multi-query-parity.mjs            # compare and exit 0/1
 *     CORTEX_MULTI_QUERY_PARITY_FAULT=plan-ignored node tools/multi-query-parity.mjs
 *
 * ## The claim this turns into a check
 *
 * §33.4 of the plan: the instrument could fuse several rankings per question (`cortex-eval`'s
 * `retrieveTopKByQueries`) and the product could not (`SearchIndex` took one query). The fusion has since moved
 * into `SearchIndex.queryPlan`. "Moved" is a claim about two implementations agreeing, and a claim about two
 * implementations is worth exactly as much as the test that compares them -- so this compares them, item by
 * item, on one corpus, one query set and one deterministic embedder, and prints the first divergent position
 * when they disagree.
 *
 * ## Why the comparison is on the **vector** channel
 *
 * Because that is the channel both sides own. The instrument retrieves turns by cosine; the product fuses
 * cosine with `lexicalRelevance`, and `lexicalRelevance` is deliberately not the instrument's keyword-count
 * channel -- comparing the two hybrid orders would be comparing two definitions of lexical relevance and
 * calling the difference a defect. `SearchIndex.channels` exists for the same reason its census field does, and
 * it is what makes this a statement about the fusion instead of a statement about one of its inputs.
 *
 * ## Why the embedder is `HashEmbedding`
 *
 * Three reasons and the third is the one that matters: it is deterministic across runs and platforms, it needs
 * no key or network so this gate can run on every commit, and it is a *real* embedding model in the sense the
 * instrument already uses for reproducible evaluation (`packages/cortex-eval/src/embedding.ts`). A fake written
 * here would make agreement a statement about one fixture's arithmetic.
 *
 * ## The statement, its precondition, and the one difference it excludes
 *
 * On a corpus where **every query reaches at least `TOP_K` turns with positive similarity**, the two sequences
 * must be equal item for item. That precondition is asserted, not assumed, and it exists because the two sides
 * genuinely differ when it fails:
 *
 * - the product excludes zero-similarity turns (`#orderByVector`), and the instrument keeps them;
 * - a kept zero-similarity turn still **votes**: it occupies a rank in that query's list, so it accumulates
 *   `1/(60 + rank + 1)`, and the packaging turn in the thin fixture outranks a real hit on inertia alone.
 *
 * So the equality is a claim about the *fusion*, and the precondition is the boundary of that claim rather than a
 * convenience. `CORTEX_MULTI_QUERY_PARITY_FIXTURE=thin` runs the same comparison on a corpus where a turn shares
 * no token with any query: `positives` falls below `TOP_K`, the statement is reported as `unmet`, and no
 * comparison is made. The Python test asserts that this run reports `unmet` -- which is what keeps the
 * precondition from being a line nobody has ever seen fire.
 *
 * ## The faults, and why each is a real defect rather than a contrivance
 *
 * | fault | what it reproduces |
 * | --- | --- |
 * | `plan-ignored` | the caller built the index without `queryPlan` -- the exact configuration this round removes |
 * | `query-dropped` | an expansion that returned phrases and a run that passed only the question to the instrument |
 * | `score-merge` | a fusion that adds similarities instead of ranks, which is the alternative every RRF argument in this repository is against |
 *
 * Each must turn the gate red. A gate whose guards have only been observed passing may be evaluating nothing,
 * and this repository has already paid for that shape once (`tools/__tests__/test_erasure_census.py` records it).
 */
import process from 'node:process';

import { HashEmbedding } from '../packages/cortex-eval/dist/embedding.js';
import { retrieveTopKByQueries } from '../packages/cortex-eval/dist/retrieval.js';
import { SearchIndex } from '../packages/cortex-memory/dist/retrieval/search-index.js';

/** The constant the instrument fuses at, stated here so a mismatch names both sides' value. */
const RRF_K = 60;

/** How many turns each per-query ranking contributes, and how many the final list carries. */
const TOP_K = 4;

/**
 * Eight turns of ordinary transcript, and three queries an expansion would plausibly produce.
 *
 * The queries are written the way an expansion writes them -- an activity plus its object -- because that is
 * the workload: `retrieveTopKByQueries` exists so "how many projects" can reach a turn that says "led a
 * consumer-research project". Nothing here is tuned to a token; the numbers the gate reports come from the
 * sequences, not from the fixture.
 */
const CORPUS = [
  'I led a consumer-research project for the packaging team in March',
  'the project shipped the inventory dashboard with the finance team in April',
  'I interviewed four warehouse staff about the packaging change',
  'the interviews with warehouse staff moved the project timeline to June',
  'I led the dashboard rewrite with two interns over the summer',
  'the packaging team reviewed the project with me in September',
  'we ran a second round of interviews with the finance team',
  'I presented the consumer-research findings to the packaging team',
];

const QUERIES = [
  'how many projects did I lead',
  'led a consumer-research project',
  'interviews with warehouse staff',
];

/**
 * A corpus with a turn no query reaches, so the one difference between the two sides can act.
 *
 * The product excludes zero-similarity turns and the instrument keeps them. That difference is invisible on the
 * dense fixture -- every turn there is positive for at least one query -- so the second statement needs a turn
 * that shares nothing, and `sunny skies reigned yesterday` is that turn -- its words are disjoint from the three
 * queries at the token level, which is what the filter reads. A turn that merely looks unrelated is not enough:
 * `the weather was cold in the morning` shares `the` with every query and scores above zero on the hashing
 * embedder, which is how the first draft of this fixture failed to test anything. Without it the prefix statement would be an equality statement spelled differently.
 */
const THIN_CORPUS = [
  'led a consumer-research project',
  'the packaging team signed off',
  'warehouse staff interviews were scheduled',
  'sunny skies reigned yesterday',
];

const embedding = new HashEmbedding(4096);

/** The product's batch signature takes `string[]`; `EmbeddingModel.embed` is exactly that. */
const embed = (texts) => embedding.embed(texts);

const fault = process.env.CORTEX_MULTI_QUERY_PARITY_FAULT ?? '';

/** The corpus this run compares on. `thin` is the second statement; anything else is the first. */
const thin = process.env.CORTEX_MULTI_QUERY_PARITY_FIXTURE === 'thin';
const corpus = thin ? THIN_CORPUS : CORPUS;

/** Cosine, as the tool states it rather than as either side computes it -- see `precondition` below. */
function cosine(a, b) {
  let dot = 0;
  let left = 0;
  let right = 0;
  for (let axis = 0; axis < a.length; axis += 1) {
    dot += a[axis] * b[axis];
    left += a[axis] * a[axis];
    right += b[axis] * b[axis];
  }
  if (left === 0 || right === 0) return 0;
  return dot / Math.sqrt(left * right);
}

/**
 * How many of this corpus's turns each query scores above zero on.
 *
 * Read before the comparison, because the two sides differ on exactly this set: the product drops turns at
 * zero similarity (`#orderByVector`), and the instrument keeps them. The first statement is only about the
 * ranking when that difference cannot act, and asserting the count is what makes that a fact about the run
 * rather than a hope about the fixture.
 */
async function positives(queries) {
  const turnVectors = await embedding.embed([...corpus]);
  const queryVectors = await embedding.embed([...queries]);
  return queryVectors.map(
    (query) => turnVectors.filter((turn) => cosine(query, turn) > 0).length,
  );
}

async function productSequence(queries) {
  const index = new SearchIndex({
    embed,
    channels: ['vector'],
    k: TOP_K,
    // `plan-ignored` is the configuration this round removes: an index whose caller never passed the plan.
    ...(fault === 'plan-ignored' ? {} : { queryPlan: () => queries }),
  });
  index.add(corpus);
  await index.prime();
  const hits = await index.search(queries[0], TOP_K);
  return { sequence: hits.map((hit) => corpus[hit.turn]), census: index.census() };
}

/**
 * Fusion by summed similarity, which is the alternative `RRF` is chosen against.
 *
 * Not a second implementation of the product: this is the *fault*, and it exists so the gate can be shown to
 * reject a fusion that ranks by magnitude. It reproduces the shape `SearchIndex` would have if `#fuse`
 * accumulated scores instead of ranks.
 */
async function scoreMergeSequence(queries) {
  const turnVectors = await embedding.embed([...corpus]);
  const queryVectors = await embedding.embed([...queries]);
  const totals = new Map();
  for (let position = 0; position < corpus.length; position += 1) {
    let total = 0;
    for (const query of queryVectors) total += cosine(query, turnVectors[position]);
    if (total > 0) totals.set(corpus[position], total);
  }
  return [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_K).map((entry) => entry[0]);
}

async function instrumentSequence(queries) {
  // `query-dropped` is a run that handed the retrieval the question alone: the instrument's own multi-query
  // path was there all along, and this is what using it and not using it look like.
  const asked = fault === 'query-dropped' ? [queries[0]] : queries;
  const hits = await retrieveTopKByQueries(embedding, [...asked], [...corpus], TOP_K);
  if (fault === 'score-merge') return scoreMergeSequence(asked);
  return hits.map((hit) => hit.text);
}

function firstDivergence(left, right) {
  const depth = Math.max(left.length, right.length);
  for (let at = 0; at < depth; at += 1) {
    if (left[at] !== right[at]) return at;
  }
  return -1;
}

async function main() {
  const counts = await positives(QUERIES);
  const product = await productSequence(QUERIES);
  const instrument = await instrumentSequence(QUERIES);
  const dense = counts.every((count) => count >= TOP_K);
  const mismatch = dense ? firstDivergence(product.sequence, instrument) : -1;

  const report = {
    statement: dense ? 'equal' : 'unmet',
    fixture: thin ? 'thin' : 'dense',
    fault: fault === '' ? null : fault,
    turns: corpus.length,
    queries: QUERIES.length,
    topK: TOP_K,
    positives: counts,
    productQueries: product.census.queries,
    productChannels: product.census.channels,
    product: product.sequence,
    instrument,
    firstDivergence: mismatch,
  };
  process.stdout.write(`${JSON.stringify(report, null, 1)}\n`);

  /**
   * A thin run reports `unmet` and stops.
   *
   * It is the control on the precondition: the corpus exists so that "every query reaches `TOP_K` turns" is a
   * statement someone has seen fail. Comparing anyway would report a divergence that is a design difference --
   * the zero-similarity vote -- as a defect, and a gate that cries wolf is a gate somebody turns off.
   */
  if (!dense) {
    if (!thin) {
      process.stderr.write(
        `multi-query parity cannot compare on the dense fixture: positives ${JSON.stringify(counts)} is below ` +
          `k=${TOP_K} for at least one query, so the equality statement would be about the zero-similarity ` +
          'filter rather than about the fusion. Fix the fixture.',
      );
      process.exitCode = 1;
    }
    return;
  }

  if (mismatch !== -1) {
    process.stderr.write(
      `multi-query parity failed at position ${mismatch}: the product ranked ` +
        `${JSON.stringify(product.sequence[mismatch])} where the instrument ranked ` +
        `${JSON.stringify(instrument[mismatch])}. Both sides were given ${QUERIES.length} queries over ` +
        `${corpus.length} turns at k=${RRF_K}, so the difference is the fusion and not the input.\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (fault !== '') {
    process.stderr.write(
      `multi-query parity fault ${JSON.stringify(fault)} was not detected: the two sequences still agree, so ` +
        'this gate cannot see the defect the fault injects.\n',
    );
    process.exitCode = 1;
  }
}

await main();
