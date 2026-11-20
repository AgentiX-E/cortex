/**
 * The product's own retrieval: an index it builds, not a callback it is handed.
 *
 * These are the tests the audit in `docs/AUDIT-SEMANTIC-REACH.md` §8 asks for. Until this module existed,
 * `cortex-memory` could rank turns only through `relevanceFor`, a synchronous `(question, turn) => number`
 * supplied by the caller -- so "retrieval" was a thing the harness did and the product consumed, and the
 * product alone could not answer a question from sessions it had been handed without falling back to
 * arrival order. The four properties below are what make the difference real:
 *
 * 1. the lexical channel **is** `lexicalRelevance`, so the product has one definition of relevance and not
 *    two;
 * 2. the vector channel is reached through an injected batch embedder, so the module stays model-free and
 *    I/O-free by construction while still using a model when one is offered;
 * 3. fusion is by rank (RRF), so a channel cannot win an argument by reporting larger numbers;
 * 4. a stage that degrades says so in a census, because a reranker that silently returns the input order
 *    produces an accuracy indistinguishable from a reranker that agreed every time.
 */
import { describe, expect, it } from 'vitest';

import { lexicalRelevance } from '../relevance.js';
import { SearchIndex } from '../retrieval/search-index.js';

/**
 * A deterministic stand-in for an embedding model.
 *
 * Each text becomes a bag over a fixed concept vocabulary, with synonyms mapped to the same concept. That
 * is enough to test everything the module claims about the vector channel -- ranking, fusion, batching --
 * without a model, a key or a network, and it is the same discipline `relevance.test.ts` follows for the
 * lexical signal: the mechanism is what is under test, not the encoder.
 */
const CONCEPTS: readonly (readonly string[])[] = [
  ['car', 'automobile', 'vehicle'],
  ['train', 'railway', 'rail'],
  ['price', 'cost', 'fare'],
  ['when', 'date', 'year'],
];
const DIRECTIONS = CONCEPTS.length;

function embed(texts: readonly string[]): Promise<readonly (readonly number[])[]> {
  return Promise.resolve(
    texts.map((text) => {
      const words = new Set(text.toLowerCase().match(/[a-z]+/g) ?? []);
      const vector = new Array<number>(DIRECTIONS).fill(0);
      for (let axis = 0; axis < CONCEPTS.length; axis += 1) {
        for (const word of CONCEPTS[axis]!)
          if (words.has(word)) vector[axis] = (vector[axis] ?? 0) + 1;
      }
      return vector;
    }),
  );
}

/** A scorer that agrees with the input order, so a test can isolate what the reranker moved. */
const agree = (pairs: readonly { candidateId: string }[]) =>
  Promise.resolve(pairs.map((_, position) => 1 / (position + 1)));

describe('SearchIndex lexical channel', () => {
  it('ranks by the signal the product already ships, not by a second definition of relevance', async () => {
    // The index narrows the candidate set with postings; it must not change what a score means. If it did,
    // a run with the index and a run with `relevanceFor = lexicalRelevance` would differ in the ranking
    // while both called themselves lexical, and neither delta could be attributed.
    const turns = [
      'I bought a used car last spring for twelve thousand',
      'the car needed new tyres in the autumn',
      'we talked about the weather for a while',
    ];
    const index = new SearchIndex();
    index.add(turns);
    const hits = await index.search('how much did the car cost', 3);
    const expected = turns
      .map((turn, position) => ({
        position,
        score: lexicalRelevance('how much did the car cost', turn),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.position - b.position);
    expect(hits.map((hit) => hit.turn)).toEqual(expected.map((entry) => entry.position));
    expect(hits.map((hit) => hit.score)).toEqual(expected.map((entry) => entry.score));
  });

  it('does not offer a turn that shares no term with the question', async () => {
    // The postings list is a filter and the filter has to be exact: `lexicalRelevance` scores an unrelated
    // turn at 0, and a candidate at 0 can never be selected ahead of a positive one, so admitting it would
    // only make the sort larger.
    const index = new SearchIndex();
    index.add(['the car needed new tyres', 'we talked about the weather']);
    const hits = await index.search('car tyres', 5);
    expect(hits.map((hit) => hit.turn)).toEqual([0]);
    expect(hits[0]!.score).toBeGreaterThan(0);
  });
});

describe('SearchIndex vector channel', () => {
  it('recovers a paraphrase the lexical channel cannot see, and says which channel found it', async () => {
    // "automobile" and "car" share no term, so the lexical channel scores the second turn at 0 and never
    // offers it. The vector channel does, and the fused list has to carry it -- otherwise the injected
    // embedder is a configuration the product accepts and never uses.
    const index = new SearchIndex({ embed });
    index.add(['the automobile needed new tyres', 'we talked about the weather for a while']);
    await index.prime();
    const hits = await index.search('what did the car need', 2);
    expect(hits.map((hit) => hit.turn).sort()).toEqual([0]);
    const census = index.census();
    expect(census.vectors).toBe(2);
    expect(census.embedCalls).toBe(2); // one batch for the turns, one for the question
    expect(census.channels).toContain('vector');
  });

  it('fuses by rank, so a channel cannot win by reporting larger numbers', async () => {
    // RRF is the reason the fusion is not a weighted sum: cosine lives in [0, 1] and the lexical score in
    // [0, 1] as well, but any future channel (BM25, graph distance) does not, and adding them requires a
    // normaliser that has to be tuned per corpus. Scaling one channel's scores by six orders of magnitude
    // therefore must leave the order unchanged.
    const scaled = (texts: readonly string[]): Promise<readonly (readonly number[])[]> =>
      embed(texts).then((vectors) => vectors.map((vector) => vector.map((value) => value * 1e6)));
    const turns = ['the car cost twelve thousand', 'the automobile cost nine thousand'];
    const plain = new SearchIndex({ embed });
    plain.add(turns);
    await plain.prime();
    const loud = new SearchIndex({ embed: scaled });
    loud.add(turns);
    await loud.prime();
    const a = await plain.search('what did the car cost', 2);
    const b = await loud.search('what did the car cost', 2);
    expect(b.map((hit) => hit.turn)).toEqual(a.map((hit) => hit.turn));
  });

  it('refuses an embedder that returns the wrong number of vectors', async () => {
    // A short reply is an error rather than a silent truncation. `cortex-ai`'s reranker records the same
    // decision for the same reason: the dropped items would keep their input order, so a failed batch and
    // an agreeing batch would produce one accuracy.
    const short = (texts: readonly string[]) => embed(texts.slice(0, 1));
    const index = new SearchIndex({ embed: short });
    index.add(['the car cost twelve thousand', 'the automobile cost nine thousand']);
    await expect(index.prime()).rejects.toThrow(/2 texts.*1 vector/s);
  });

  it('refuses to grow after the vectors were computed', async () => {
    // An index primed over two turns and then given a third has a vector table that does not cover the
    // corpus. Nothing downstream can detect that, so the only honest moment to refuse is here.
    const index = new SearchIndex({ embed });
    index.add(['the car cost twelve thousand']);
    await index.prime();
    expect(() => index.add(['the automobile cost nine thousand'])).toThrow(/primed/);
  });
});

describe('SearchIndex rerank', () => {
  it('reorders the head and never drops a candidate', async () => {
    // Reranking is a permutation. `rerank.ts` states the rule -- "no candidate is ever lost" -- and this
    // asserts the product honours it through the injection point, because a reranker that filters would
    // silently shorten the pool the budget draws from.
    const index = new SearchIndex({
      rerank: (pairs) => Promise.resolve(pairs.map((_, at) => 1 / (at + 1))),
    });
    index.add(['the car cost twelve thousand', 'the car needed tyres', 'the car was red']);
    const hits = await index.search('car', 3);
    expect(hits).toHaveLength(3);
    expect(new Set(hits.map((hit) => hit.turn)).size).toBe(3);
    expect(index.census().rerankCalls).toBe(1);
  });

  it('counts a reranker that threw instead of reporting the fused order as its verdict', async () => {
    // `rerankHits` degrades to the input order on every failure, which is the right behaviour for the
    // prompt and the wrong thing to read as agreement. The census is what makes the difference visible:
    // `rerankCalls: 1, rerankDegraded: 1` says the stage ran and did nothing.
    const index = new SearchIndex({
      rerank: () => Promise.reject(new Error('401 from the endpoint')),
    });
    index.add(['the car cost twelve thousand', 'the car needed tyres']);
    const hits = await index.search('car', 2);
    expect(hits).toHaveLength(2);
    const census = index.census();
    expect(census.rerankCalls).toBe(1);
    expect(census.rerankDegraded).toBe(1);
  });
});

describe('SearchIndex lookup', () => {
  it('turns a search into the synchronous scorer the prompt builder takes', async () => {
    // The prompt's selection is synchronous by construction (`PromptOptions.relevanceFor`), and the
    // retrieval is not. Resolving the question once and handing back a map lookup is what lets the product
    // own retrieval without turning the prompt builder into an async function.
    const index = new SearchIndex();
    index.add(['the car cost twelve thousand', 'we talked about the weather']);
    const score = await index.lookup('how much did the car cost');
    expect(score('how much did the car cost', 'the car cost twelve thousand')).toBeGreaterThan(0);
    expect(score('how much did the car cost', 'we talked about the weather')).toBe(0);
  });

  it('ignores the question it is handed, because the question was already resolved', async () => {
    // The scorer takes the prompt's signature, and the prompt passes its question on every call. If the
    // lookup used that argument, the map would be queried with the question text, miss on every turn and
    // score them all zero -- an index that reports a healthy census and changes nothing. Asserting the
    // values are equal across two different questions is what pins the parameter that is *not* read.
    const index = new SearchIndex();
    index.add(['the car cost twelve thousand']);
    const score = await index.lookup('how much did the car cost');
    expect(score('a completely different question', 'the car cost twelve thousand')).toBe(
      score('how much did the car cost', 'the car cost twelve thousand'),
    );
  });

  it('answers a corpus it was never given without throwing', async () => {
    // A question whose terms appear nowhere is the ordinary case for an abstention question, not an error.
    const index = new SearchIndex({ embed });
    index.add(['the car cost twelve thousand']);
    await index.prime();
    const hits = await index.search('which orchestra played', 5);
    expect(hits).toEqual([]);
    const score = await index.lookup('which orchestra played');
    expect(score('which orchestra played', 'the car cost twelve thousand')).toBe(0);
  });

  it('handles an empty corpus without calling the embedder', async () => {
    let calls = 0;
    const index = new SearchIndex({
      embed: (texts) => {
        calls += 1;
        return embed(texts);
      },
    });
    await index.prime();
    expect(await index.search('anything', 3)).toEqual([]);
    expect(calls).toBe(0);
    expect(index.census().turns).toBe(0);
  });
});

describe('SearchIndex without optional channels', () => {
  it('is deterministic across two identical builds', async () => {
    // Ties are broken by position, so the result is a function of the inputs alone. Without this, a paired
    // run would report a difference that came from the sort.
    const build = async () => {
      const index = new SearchIndex();
      index.add([
        'the car cost twelve thousand',
        'the car cost nine thousand',
        'the car cost nothing',
      ]);
      return (await index.search('the car cost', 3)).map((hit) => hit.turn);
    };
    expect(await build()).toEqual(await build());
  });

  it('keeps the reranker out of a search whose pool is already the whole corpus', async () => {
    // `agree` reproduces the input order exactly, so a run that used it can only have moved something if
    // the reranker was consulted and its answer differed. Asserting the permutation is identity is how the
    // test separates "the stage ran" from "the stage changed the order" -- the two states §13.151.5 keeps
    // apart on purpose.
    const index = new SearchIndex({ rerank: agree });
    index.add(['the car cost twelve thousand', 'the car needed tyres']);
    const before = new SearchIndex();
    before.add(['the car cost twelve thousand', 'the car needed tyres']);
    expect((await index.search('car', 2)).map((hit) => hit.turn)).toEqual(
      (await before.search('car', 2)).map((hit) => hit.turn),
    );
  });
});

describe('SearchIndex degenerate inputs', () => {
  it('accepts an empty corpus and stays queryable', async () => {
    // `answerSessions` calls `add` with whatever the admission gate kept, and a gate that kept nothing still
    // reaches this line. The loop then runs zero times, which is a state the postings map has to survive.
    const index = new SearchIndex();
    expect(() => index.add([])).not.toThrow();
    expect(await index.search('anything at all', 4)).toEqual([]);
    expect(index.census()).toMatchObject({ turns: 0, terms: 0, vectors: 0 });
  });

  it('treats an embedder that returns nothing for the query as no vector channel', async () => {
    // A client that answers a one-text batch with an empty array has not returned a short batch of the
    // corpus -- the turns are embedded and the query is not, which is a different failure and has to be
    // survivable: the vector channel contributes nothing and the lexical channel is still a ranking. The
    // short *corpus* batch is the one refused, above, because there the missing vector is a turn.
    const question = 'car cost';
    const index = new SearchIndex({
      embed: (texts) =>
        texts.length === 1 && texts[0] === question ? Promise.resolve([]) : embed(texts),
    });
    index.add(['the car cost twelve thousand']);
    await index.prime();
    const hits = await index.search(question, 3);
    expect(hits.map((hit) => hit.turn)).toEqual([0]);
    expect(index.census().embedCalls).toBe(2);
  });

  it('counts a reranker that answers a short list, and keeps the fused order', async () => {
    // `rerankHits` refuses a short reply by degrading to its input, so the order a caller sees is still a
    // permutation. What it cannot say is *why*, and `rerankDegraded` is the field that says why.
    const index = new SearchIndex({
      rerank: (pairs) => Promise.resolve(pairs.slice(0, 1).map(() => 1)),
    });
    index.add(['the car cost twelve thousand', 'the car needed tyres']);
    const hits = await index.search('car', 2);
    expect(hits).toHaveLength(2);
    expect(index.census().rerankCalls).toBe(1);
    expect(index.census().rerankDegraded).toBe(1);
  });
});

describe('SearchIndex refusals', () => {
  it('refuses a query embedded at a different width from the corpus', async () => {
    // A partial comparison (`min` of the widths) would produce a cosine over whichever components happen to
    // line up: plausible numbers, a wrong ranking, and nothing in the artifact to say so.
    // The query comes back at two dimensions while the corpus sits at three.
    const narrowed = new SearchIndex({
      embed: (texts) =>
        Promise.resolve(texts.map((text) => (text === 'car cost' ? [1, 0] : [1, 0, 0]))),
    });
    narrowed.add(['the car cost twelve thousand']);
    await narrowed.prime();
    await expect(narrowed.search('car cost', 3)).rejects.toThrow(/2 dimensions.*0 to 3/s);
  });

  it('answers a question with no content terms without scoring anything', async () => {
    // "who of the and" is a question the tokeniser empties. `lexicalRelevance` answers 0 for it by
    // construction, so a candidate set built from its postings would be empty anyway -- the guard states
    // that rather than running the loop to discover it.
    const index = new SearchIndex();
    index.add(['the car cost twelve thousand']);
    expect(await index.search('who of the and', 3)).toEqual([]);
  });
});

describe('SearchIndex on a corpus that repeats itself', () => {
  it('scores a verbatim duplicate once, at the best position it was found', async () => {
    // The lookup is keyed by turn text, and a corpus can repeat a turn -- LongMemEval's distractor
    // sessions do. `search` is best-first, so the first occurrence is the best one and the second must not
    // overwrite it with a worse score.
    const index = new SearchIndex();
    index.add(['the car cost twelve thousand', 'the car cost twelve thousand']);
    const score = await index.lookup('car cost');
    expect(score('car cost', 'the car cost twelve thousand')).toBeGreaterThan(0);
    expect(index.census().turns).toBe(2);
  });
});

describe('SearchIndex query plan', () => {
  it('ranks a question as the several queries the plan names, and recalls what one phrasing cannot', async () => {
    // The mechanism these four tests exist for: an abstract question and the wording its evidence uses are
    // different queries. "what did the automobile cost" shares no content term with "railway repairs were
    // expensive" and the vector channel scores the pair at zero -- the car axis against the train axis -- so
    // the turn is unreachable by the question and reachable by a phrase. That is the shape `cortex-eval`'s
    // `retrieveTopKByQueries` was written for (§33.4), and until this option existed the product could not
    // express it at all.
    const turns = ['railway repairs were expensive', 'the automobile cost twelve thousand'];
    const alone = new SearchIndex({ embed });
    alone.add(turns);
    await alone.prime();
    // Async on purpose: an expansion is a model call, and a synchronous-only signature would have made the
    // one caller this option exists for precompute a table keyed by question before the index was built.
    const planned = new SearchIndex({
      embed,
      queryPlan: async () => ['what did the automobile cost', 'railway repairs'],
    });
    planned.add(turns);
    await planned.prime();

    expect((await alone.search('what did the automobile cost', 2)).map((hit) => hit.turn)).toEqual([
      1,
    ]);
    expect(
      (await planned.search('what did the automobile cost', 2)).map((hit) => hit.turn),
    ).toEqual([1, 0]);
    expect(planned.census().queries).toBe(2);
    expect(alone.census().queries).toBe(1);
  });

  it('fuses by agreement, so a turn two phrasings both rank highly outranks either one’s best', async () => {
    // Reciprocal rank fusion over the per-query lists, with k = 60: the turn both phrasings reach scores
    // 1/62 + 1/62 = 0.03226, while each phrasing's own first choice scores 1/61 = 0.01639. The corpus is
    // one word per axis so the arithmetic is the whole expectation rather than an approximation of it.
    const index = new SearchIndex({
      embed,
      channels: ['vector'],
      queryPlan: () => ['car', 'train'],
    });
    index.add(['car', 'train', 'car train']);
    await index.prime();
    expect((await index.search('anything', 3)).map((hit) => hit.turn)).toEqual([2, 0, 1]);

    // The halves, so the assertion above is about agreement and not about the corpus having one order.
    const car = new SearchIndex({ embed, channels: ['vector'] });
    car.add(['car', 'train', 'car train']);
    await car.prime();
    const train = new SearchIndex({ embed, channels: ['vector'] });
    train.add(['car', 'train', 'car train']);
    await train.prime();
    expect((await car.search('car', 3)).map((hit) => hit.turn)).toEqual([0, 2]);
    expect((await train.search('train', 3)).map((hit) => hit.turn)).toEqual([1, 2]);
  });

  it('embeds the whole query set in one request, because the bill is per text and the cap is per text', async () => {
    // Four phrases are four texts in one batch. A loop of one-text requests would price the same work at four
    // calls, and `embedCalls` is the number a report prints beside the texts precisely so this cannot pass
    // unnoticed: the pair (2 calls, 6 texts) says "one batch for two turns, one for four queries".
    const index = new SearchIndex({
      embed,
      queryPlan: () => ['car cost', 'train fare', 'railway repairs', 'automobile price'],
    });
    index.add(['the car cost twelve thousand', 'the train fare was nine thousand']);
    await index.prime();
    await index.search('what did the car cost', 2);
    const census = index.census();
    expect(census.embedCalls).toBe(2);
    expect(census.embedTexts).toBe(6);
    expect(census.queries).toBe(4);
  });

  it('drops blanks and duplicates before spending a request, and says how many survived', async () => {
    // A duplicate query would vote twice for one ranking: the fusion would weight the phrasings the plan
    // repeated, and the census would report a query set the run never issued. Trimming is part of the same
    // statement -- a phrase with a trailing space embeds to the same text and would count twice.
    const index = new SearchIndex({
      embed,
      queryPlan: () => ['car cost', 'car cost ', '', '   ', 'automobile'],
    });
    index.add(['the car cost twelve thousand']);
    await index.prime();
    await index.search('what did the car cost', 1);
    const census = index.census();
    expect(census.queries).toBe(2);
    expect(census.embedTexts).toBe(3);
  });

  it('answers from the question when the plan names nothing, rather than from no query at all', async () => {
    // `[]` is a plan that spoke and said nothing -- an expansion that refused, a table with no entry. Ranking
    // on it would return no evidence for every such question, and the prompt would look assembled while the
    // retrieval had silently stopped. The fallback is the question, and the census says the run issued one
    // query so a reader cannot mistake it for a plan that acted.
    const turns = ['the car cost twelve thousand', 'the train fare was nine thousand'];
    const index = new SearchIndex({ embed, queryPlan: () => [] });
    index.add(turns);
    await index.prime();
    const plain = new SearchIndex({ embed });
    plain.add(turns);
    await plain.prime();
    const question = 'what did the car cost';
    expect(await index.search(question, 2)).toEqual(await plain.search(question, 2));
    expect(index.census().queries).toBe(1);

    const blank = new SearchIndex({ embed, queryPlan: () => ['  ', '\t'] });
    blank.add(turns);
    await blank.prime();
    expect(await blank.search(question, 2)).toEqual(await plain.search(question, 2));
  });

  it('treats a plan naming one query as the single-query run it is', async () => {
    // The registered path returns the lexical channel's own scores; a one-element fusion would re-base them
    // on rank -- the same order, different numbers, and a prompt that differs wherever two turns tie. An
    // expansion arm whose model returned nothing must cost what its control costs, or the arm has measured
    // two changes and reported one.
    const turns = [
      'the car cost twelve thousand',
      'the car cost nine thousand',
      'we talked about weather',
    ];
    const planned = new SearchIndex({ embed, queryPlan: (question) => [question] });
    planned.add(turns);
    await planned.prime();
    const plain = new SearchIndex({ embed });
    plain.add(turns);
    await plain.prime();
    const question = 'what did the car cost';
    expect(await planned.search(question, 3)).toEqual(await plain.search(question, 3));
    expect(planned.census().queries).toBe(1);
  });

  it('refuses a partial reply to the query batch, and treats an empty one as no vector channel', async () => {
    // Two answers to one request, and the two absences mean different things. An **empty** reply is a client
    // that produced nothing: the lexical channel is still a ranking, and the census counts the degradation the
    // way it counts one on the single-query path. A **partial** reply is worse than either -- the queries that
    // answered would carry the fusion alone, so the order would describe a query set the run never issued, and
    // nothing downstream could tell that from a plan with fewer phrases.
    const corpus = ['the car cost twelve thousand', 'the train fare was nine thousand'];
    const partial = new SearchIndex({
      embed: (texts) => (texts.includes('train fare') ? embed(texts.slice(0, 1)) : embed(texts)),
      queryPlan: () => ['car cost', 'train fare', 'railway repairs'],
    });
    partial.add(corpus);
    await partial.prime();
    await expect(partial.search('what did the car cost', 2)).rejects.toThrow(
      /3 queries.*1 vector/s,
    );

    const empty = new SearchIndex({
      embed: (texts) => (texts.includes('train fare') ? Promise.resolve([]) : embed(texts)),
      queryPlan: () => ['car cost', 'train fare'],
    });
    empty.add(corpus);
    await empty.prime();
    const hits = await empty.search('what did the car cost', 2);
    // The lexical ranking, unchanged: an empty reply is a channel that did not run this retrieval, not a
    // failure, so `embedDegraded` stays 0 and the census still reports the vector table the corpus built.
    // Both turns share a term with one of the two phrases, so the plan widened the lexical channel even though
    // the vector one produced nothing -- which is exactly the claim: the retrieval degraded, the queries did not.
    expect(hits.map((hit) => hit.turn)).toEqual([0, 1]);
    expect(empty.census()).toMatchObject({
      embedDegraded: 0,
      vectors: 2,
      embedTexts: 4,
      queries: 2,
    });
  });

  it('lets a plan’s failure escape instead of answering from the bare question', async () => {
    // A plan that throws is configuration, not weather: an endpoint answering 401 or a table that is not
    // there. Catching it would rank the question alone and publish the control's accuracy under the
    // treatment's name -- the one reading this repository cannot recover from, because the artifact has no
    // field that would disagree.
    const index = new SearchIndex({
      embed,
      queryPlan: () => Promise.reject(new Error('expansion endpoint answered 401')),
    });
    index.add(['the car cost twelve thousand']);
    await index.prime();
    await expect(index.search('what did the car cost', 1)).rejects.toThrow(/401/);
  });

  it('widens the lexical channel alone when no embedder is configured', async () => {
    // The manual says a plan works without an embedding provider, and this is the sentence behind it: the
    // phrases are ranked by postings, fused by the same RRF, and nothing is embedded because there is nothing
    // to embed with. A household with no quota gets the recall the phrases buy and pays nothing for it.
    const turns = ['the automobile cost twelve thousand', 'railway repairs were expensive'];
    const index = new SearchIndex({
      queryPlan: () => ['what did the car cost', 'railway repairs'],
    });
    index.add(turns);
    await index.prime();
    const hits = await index.search('what did the car cost', 2);
    expect(hits.map((hit) => hit.turn).sort()).toEqual([0, 1]);
    expect(index.census()).toMatchObject({ queries: 2, embedCalls: 0, embedTexts: 0 });
    expect(index.census().channels).toEqual(['lexical']);

    // The same ranking when the channel is withheld by name rather than by omission, so the two ways of saying
    // "no vectors here" cannot be two behaviours.
    const withheld = new SearchIndex({
      channels: ['lexical'],
      queryPlan: () => ['what did the car cost', 'railway repairs'],
    });
    withheld.add(turns);
    await withheld.prime();
    expect(await withheld.search('what did the car cost', 2)).toEqual(hits);
  });

  it('answers nothing for a plan over an empty corpus, without calling the embedder', async () => {
    // `answerSessions` calls `add` with whatever the admission gate kept, and a gate that kept nothing still
    // reaches the retrieval -- now with a plan in hand. A batch of zero corpus vectors is not a reason to embed
    // the phrases, and a fused list of nothing is not an error: it is the abstention question's ordinary case.
    let calls = 0;
    const index = new SearchIndex({
      embed: (texts) => {
        calls += 1;
        return embed(texts);
      },
      queryPlan: () => ['car cost', 'train fare'],
    });
    await index.prime();
    expect(await index.search('what did the car cost', 3)).toEqual([]);
    expect(calls).toBe(0);
    expect(index.census().queries).toBe(2);
  });

  it('reports the most recent search’s query count, not a run total', async () => {
    // The index lives for one question, so the count is the question's query set. Summing it would describe
    // a corpus, and the number a reader needs is "did the plan act on this question".
    let named: string[] = ['car', 'train'];
    const index = new SearchIndex({ embed, channels: ['vector'], queryPlan: () => named });
    index.add(['car', 'train']);
    await index.prime();
    await index.search('car', 1);
    named = ['car', 'train', 'car train'];
    await index.search('car', 1);
    expect(index.census().queries).toBe(3);
  });
});

describe('SearchIndex channel selection', () => {
  it('never embeds a corpus or a query when the vector channel is withheld', async () => {
    // `channels: ['lexical']` is a cost decision as well as a ranking one: a deployment that has decided
    // against vectors should not pay for a corpus it will not score, and the counter is the proof.
    let calls = 0;
    const counted = (texts: readonly string[]) => {
      calls += 1;
      return embed(texts);
    };
    const index = new SearchIndex({ embed: counted, channels: ['lexical'] });
    index.add(['the car cost twelve thousand', 'the train fare was nine thousand']);
    await index.prime();
    const hits = await index.search('what did the car cost', 2);
    const plain = new SearchIndex();
    plain.add(['the car cost twelve thousand', 'the train fare was nine thousand']);
    expect(hits).toEqual(await plain.search('what did the car cost', 2));
    expect(calls).toBe(0);
    expect(index.census()).toMatchObject({ embedCalls: 0, embedTexts: 0, vectors: 0 });
    expect(index.census().channels).toEqual(['lexical']);
  });

  it('ranks by vectors alone, and builds no postings to do it', async () => {
    // The other half of the same option: dense-only is the configuration `cortex-eval` dispatches as
    // `retrieval` beside `retrieval-hybrid`, so a deployment that wants it must be able to ask. With the
    // lexical channel withheld, a question sharing no term with the evidence still reaches it -- and a
    // lexically unrelated turn is still excluded, because zero cosine is not evidence.
    const index = new SearchIndex({ embed, channels: ['vector'] });
    index.add(['the automobile was expensive', 'railway repairs were expensive']);
    await index.prime();
    const hits = await index.search('what did the car cost', 2);
    expect(hits.map((hit) => hit.turn)).toEqual([0]);
    const lexical = new SearchIndex({ channels: ['lexical'] });
    lexical.add(['the automobile was expensive', 'railway repairs were expensive']);
    // The control: the same corpus and question through the lexical channel alone shares no term, so the
    // dense hit above is the vector channel's and not a lexical coincidence.
    expect(await lexical.search('what did the car cost', 2)).toEqual([]);
    expect(index.census()).toMatchObject({ terms: 0, vectors: 2 });
    expect(index.census().channels).toEqual(['vector']);
  });

  it('reads the same channel set in any order', async () => {
    // The list is a set. Two spellings of one configuration that ranked differently would be a second free
    // parameter, and the one a report printed would depend on how the caller typed it.
    const turns = ['the car cost twelve thousand', 'the train fare was nine thousand'];
    const forward = new SearchIndex({ embed, channels: ['lexical', 'vector'] });
    forward.add(turns);
    await forward.prime();
    const reversed = new SearchIndex({ embed, channels: ['vector', 'lexical'] });
    reversed.add(turns);
    await reversed.prime();
    const question = 'what did the car cost';
    expect(await reversed.search(question, 2)).toEqual(await forward.search(question, 2));
    expect(reversed.census().channels).toEqual(['lexical', 'vector']);
  });

  it('refuses a channel set that ranks on nothing', async () => {
    // An index with no channel answers every question with no evidence while its census reads healthy:
    // turns counted, no failures, no degradation. That is the one failure nothing downstream can detect.
    expect(() => new SearchIndex({ channels: [] })).toThrow(/at least one channel/);
  });

  it('refuses a vector-only index with no embedder', async () => {
    // Nothing to rank with, so every search would return no evidence -- and the refusal is on the explicit
    // claim only. `['lexical', 'vector']` without an embedder stays legal: that is the ordinary lexical
    // index, and the census says the vector channel did not run.
    expect(() => new SearchIndex({ channels: ['vector'] })).toThrow(/no embedder|embed/);
    expect(() => new SearchIndex({ channels: ['lexical', 'vector'] })).not.toThrow();
  });

  it('refuses a channel name it does not administer', async () => {
    // Names arrive from configuration. A name that ranked nothing would read as a treatment in whatever
    // block recorded it, which is the same defect class as a dispatch naming a signal the product ignores.
    expect(() => new SearchIndex({ channels: ['graph' as 'lexical'] })).toThrow(/may only name/);
  });
});

describe('SearchIndex.lastPool, the ranking the index actually offered', () => {
  const TURNS = [
    'I bought a used car last spring for twelve thousand',
    'the car needed new tyres in the autumn',
    'we talked about the weather for a while',
    'the train fare was nine thousand',
  ];

  it('is empty before any query, rather than the corpus', async () => {
    // The distinction the field exists for: "no ranking has run" is not "the ranking offered everything".
    // A pool initialised to the corpus would make every gold turn look surfaced on a run that never searched.
    const index = new SearchIndex();
    index.add(TURNS);
    expect(index.lastPool()).toEqual([]);
    await index.search('how much did the car cost', 2);
    expect(index.lastPool().length).toBeGreaterThan(0);
  });

  it('is the search result in the search order, texts rather than positions', async () => {
    // Positions are not identities: a caller asking "where did this gold turn rank" holds text, and two
    // positions can carry one text. Both the order and the unit are load-bearing here.
    const index = new SearchIndex();
    index.add(TURNS);
    const hits = await index.search('how much did the car cost', 4);
    expect(index.lastPool()).toEqual(hits.map((hit) => TURNS[hit.turn]));
    expect(index.lastPool()[0]).toBe(TURNS[0]!);
  });

  it('keeps one entry per text, at the position of its best score', async () => {
    // The same rule `lookup` uses to build its scorer. Two entries for one text would make the pool's length
    // describe the corpus rather than the ranking, and a gold turn's rank would depend on which copy the
    // caller's `indexOf` found first.
    const repeated = [
      'the car cost twelve thousand',
      'the car cost twelve thousand',
      'a parcel arrived',
    ];
    const index = new SearchIndex();
    index.add(repeated);
    await index.search('what did the car cost', 3);
    expect(index.lastPool().filter((text) => text === repeated[0])).toHaveLength(1);
    expect(index.lastPool()[0]).toBe('the car cost twelve thousand');
  });

  it('replaces the previous pool instead of accumulating across questions', async () => {
    // The defect this pins is the one a 500-question run hides: a pool that grew would rank this question's
    // gold against the last one's candidates, and every rank would still look like a plausible number.
    const index = new SearchIndex();
    index.add(TURNS);
    await index.search('how much did the car cost', 1);
    expect(index.lastPool()).toEqual([TURNS[0]]);
    await index.search('when did the train fare change', 1);
    expect(index.lastPool()).toEqual([TURNS[3]]);
    expect(index.lastPool()).toHaveLength(1);
  });

  it('omits a turn the search did not return, so its absence is readable', async () => {
    // `-1` from a consumer's `indexOf` is the only spelling of "never surfaced", and it has to mean that:
    // a pool padded with the whole corpus would report every gold as ranked and cut.
    const index = new SearchIndex();
    index.add(TURNS);
    await index.search('how much did the car cost', 2);
    expect(index.lastPool()).not.toContain('we talked about the weather for a while');
  });

  it('is bounded by k, and returns the same order the scorer does', async () => {
    // The pool and the scores are two views of one ranking; a pool wider than `k` would let a consumer rank
    // a gold turn the prompt's selection never saw a score for.
    const index = new SearchIndex();
    index.add(TURNS);
    const scorer = await index.lookup('how much did the car cost', 2);
    const pool = index.lastPool();
    expect(pool).toHaveLength(2);
    for (const text of pool) expect(scorer('', text)).toBeGreaterThanOrEqual(scorer('', TURNS[2]!));
  });
});
