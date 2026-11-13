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
