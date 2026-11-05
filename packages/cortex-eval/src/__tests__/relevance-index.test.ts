import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildRetrievalRelevanceIndex,
  DEFAULT_RELEVANCE_TOP_K,
  type RelevanceIndex,
} from '../relevance-index.js';
import { clearEmbeddingCache } from '../retrieval.js';
import { tableEmbedding } from './test-embedding.js';

/**
 * The index is geometry, so these fixtures place turns at exact angles.
 *
 * `tableEmbedding` returns the zero vector for an unknown text, and the zero
 * vector's cosine against anything is `0` — not a number the assertions here can
 * mistake for a real hit, because every expected score below is either strictly
 * positive or `floorOf(index)`.
 */
const DIM = 2;

/** A question's own direction, and three turns at known cosines against it. */
const GEOMETRY: Readonly<Record<string, readonly number[]>> = {
  'how many bikes do I own': [1, 0],
  'the answer turn': [1, 0], // cosine 1.0
  'a near turn': [0.8, 0.6], // cosine 0.8
  'an orthogonal turn': [0, 1], // cosine 0.0
  'a third turn': [0.6, 0.8], // cosine 0.6
};

function embedding(): ReturnType<typeof tableEmbedding> {
  return tableEmbedding(GEOMETRY, DIM);
}

/**
 * The score the index gives a turn it holds no measurement for.
 *
 * Read from the index rather than imported as a constant, so the assertion is about
 * the ordering the consumer depends on and not about the literal this module happens
 * to use for it. The floor is deliberately not exported for the same reason.
 */
function floorOf(index: RelevanceIndex): number {
  return index.relevanceFor('a question the index never saw', 'a turn the index never saw');
}

beforeEach(() => {
  // The embedding cache is process-wide, and a cached vector from another suite
  // would make a geometric fixture inherit that suite's arithmetic.
  clearEmbeddingCache();
});

describe('buildRetrievalRelevanceIndex', () => {
  it('scores a turn by its cosine against the question that retrieved it', async () => {
    const index = await buildRetrievalRelevanceIndex(embedding(), [
      {
        question: 'how many bikes do I own',
        context: ['the answer turn', 'a near turn', 'an orthogonal turn'],
      },
    ]);

    expect(index.relevanceFor('how many bikes do I own', 'the answer turn')).toBeCloseTo(1, 10);
    expect(index.relevanceFor('how many bikes do I own', 'a near turn')).toBeCloseTo(0.8, 10);
    expect(index.relevanceFor('how many bikes do I own', 'an orthogonal turn')).toBeCloseTo(0, 10);
  });

  it('orders a turn the question names above one it does not', async () => {
    const index = await buildRetrievalRelevanceIndex(embedding(), [
      {
        question: 'how many bikes do I own',
        context: ['an orthogonal turn', 'a near turn', 'the answer turn'],
      },
    ]);

    const relevant = index.relevanceFor('how many bikes do I own', 'the answer turn');
    const distract = index.relevanceFor('how many bikes do I own', 'an orthogonal turn');
    expect(relevant).toBeGreaterThan(distract);
  });

  it('uses the retriever it is given, so the signal can move without moving the index', async () => {
    // §13.63. The partition §13.62 built says the pool's reach is the larger loss -- 1026
    // MR gold turns never surfaced against 903 cut by the budget -- so the next variable is
    // *how candidates are retrieved*, and the index has to accept one rather than hardwire
    // the dense ranker. The injected retriever below returns a fixed pool, which is what
    // makes "the index used it" observable without an embedding.
    const seen: { queries: readonly string[]; topK: number }[] = [];
    const index = await buildRetrievalRelevanceIndex(
      embedding(),
      [{ question: 'how many bikes do I own', context: ['the answer turn', 'a near turn'] }],
      {
        topK: 7,
        retrieve: (queries, _context, topK) => {
          seen.push({ queries, topK });
          return Promise.resolve([{ id: 't-1', text: 'an injected turn', score: 0.5, index: 0 }]);
        },
      },
    );

    expect(seen).toEqual([{ queries: ['how many bikes do I own'], topK: 7 }]);
    expect([...index.candidatesFor('how many bikes do I own')]).toEqual(['an injected turn']);
    expect(index.scoredPairs).toBe(1);
  });

  it('names the turns it scored, which is what makes the pool measurable', async () => {
    // §13.61.7: the campaign could not ask "did the budget cut this gold turn, or did the
    // ranking never surface it", because the artifact recorded what was delivered and not
    // what was chosen from. `candidatesFor` is that missing half -- the set a selection
    // chose from -- and it is the index's own answer rather than a second derivation.
    const index = await buildRetrievalRelevanceIndex(embedding(), [
      { question: 'how many bikes do I own', context: ['the answer turn', 'a near turn'] },
    ]);

    const pool = index.candidatesFor('how many bikes do I own');
    expect([...pool].sort()).toEqual(['a near turn', 'the answer turn']);
    // The membership is the same predicate `relevanceFor` answers with, so a turn the
    // lookup scores cannot be absent from the pool, and one at the floor cannot be in it.
    for (const turn of pool) {
      expect(index.relevanceFor('how many bikes do I own', turn)).toBeGreaterThan(floorOf(index));
    }
  });

  it('keeps the ranking it was given, so a gold turn has a position and not only a membership', async () => {
    // §13.65. §13.64.7 left one question unanswerable: MR's 903 budget-cut gold turns are
    // either ordered below the cut -- where the order is the lever -- or far below it, where
    // no order helps. A set cannot say which. The index discards the ranking for *selection*
    // (the consumer orders by score), but it must keep it for *measurement*, and the two
    // views are one ordered array rather than two structures.
    const index = await buildRetrievalRelevanceIndex(embedding(), [
      {
        question: 'how many bikes do I own',
        context: ['an orthogonal turn', 'the answer turn', 'a near turn'],
      },
    ]);

    const ranked = index.rankedCandidatesFor('how many bikes do I own');
    // Best-first by cosine: 1.0, 0.8, 0.0.
    expect(ranked).toEqual(['the answer turn', 'a near turn', 'an orthogonal turn']);
    // The set is the same array read as membership, so the two cannot disagree.
    expect([...index.candidatesFor('how many bikes do I own')].sort()).toEqual([...ranked].sort());
  });

  it('answers with an empty pool for a question it never scored', async () => {
    // Total, like `relevanceFor`: an unknown question is a real state -- a caller reading
    // a record whose question the index did not cover -- and throwing there would turn a
    // reporting gap into a failed run. Empty is the statement, not `undefined`.
    const index = await buildRetrievalRelevanceIndex(embedding(), [
      { question: 'how many bikes do I own', context: ['a near turn'] },
    ]);

    expect(index.candidatesFor('a question the index never saw').size).toBe(0);
    // The ordered view answers the same way, because it is the same array: a caller that
    // measured ranks for an unknown question gets no positions rather than a throw.
    expect(index.rankedCandidatesFor('a question the index never saw')).toEqual([]);
  });

  it('gives a turn outside the index the unscored floor', async () => {
    const index = await buildRetrievalRelevanceIndex(embedding(), [
      { question: 'how many bikes do I own', context: ['a near turn'] },
    ]);

    expect(index.relevanceFor('how many bikes do I own', 'never retrieved')).toBe(floorOf(index));
  });

  it('gives every turn of an unasked question the unscored floor', async () => {
    const index = await buildRetrievalRelevanceIndex(embedding(), [
      { question: 'how many bikes do I own', context: ['a near turn'] },
    ]);

    expect(index.relevanceFor('a question the index never saw', 'a near turn')).toBe(
      floorOf(index),
    );
  });

  it('keeps the floor strictly below every cosine the index can produce', async () => {
    // The floor is an ordinal claim, not a similarity: it must lose to a
    // maximally anti-correlated turn, whose cosine is -1. If it were 0 the
    // selection would order an unscored turn above a real one.
    const antiCorrelated = await buildRetrievalRelevanceIndex(
      tableEmbedding({ q: [1, 0], opposed: [-1, 0] }, DIM),
      [{ question: 'q', context: ['opposed'] }],
    );

    expect(antiCorrelated.relevanceFor('q', 'opposed')).toBeCloseTo(-1, 10);
    expect(floorOf(antiCorrelated)).toBeLessThan(-1);
  });

  it('keeps only the top k turns, and floors the rest', async () => {
    const index = await buildRetrievalRelevanceIndex(
      embedding(),
      [
        {
          question: 'how many bikes do I own',
          context: ['an orthogonal turn', 'a third turn', 'a near turn', 'the answer turn'],
        },
      ],
      { topK: 2 },
    );

    expect(index.scoredPairs).toBe(2);
    expect(index.relevanceFor('how many bikes do I own', 'the answer turn')).toBeCloseTo(1, 10);
    expect(index.relevanceFor('how many bikes do I own', 'a near turn')).toBeCloseTo(0.8, 10);
    expect(index.relevanceFor('how many bikes do I own', 'a third turn')).toBe(floorOf(index));
    expect(index.relevanceFor('how many bikes do I own', 'an orthogonal turn')).toBe(
      floorOf(index),
    );
  });

  it('defaults the width when no option is given', async () => {
    const context = Array.from({ length: DEFAULT_RELEVANCE_TOP_K + 5 }, (_, i) => `turn ${i}`);
    const index = await buildRetrievalRelevanceIndex(
      tableEmbedding({ q: [1, 0], ...Object.fromEntries(context.map((t) => [t, [1, 0]])) }, DIM),
      [{ question: 'q', context }],
    );

    expect(index.topK).toBe(DEFAULT_RELEVANCE_TOP_K);
    expect(index.scoredPairs).toBe(DEFAULT_RELEVANCE_TOP_K);
  });

  it('counts the questions it covered and the pairs it scored', async () => {
    const index = await buildRetrievalRelevanceIndex(embedding(), [
      { question: 'how many bikes do I own', context: ['a near turn', 'a third turn'] },
      { question: 'how many bikes do I own', context: ['the answer turn'] },
    ]);

    expect(index.questions).toBe(2);
    expect(index.scoredPairs).toBe(3);
  });

  it('measures nothing against an empty context', async () => {
    const index = await buildRetrievalRelevanceIndex(embedding(), [
      { question: 'how many bikes do I own', context: [] },
    ]);

    expect(index.questions).toBe(1);
    expect(index.scoredPairs).toBe(0);
    expect(index.relevanceFor('how many bikes do I own', 'the answer turn')).toBe(floorOf(index));
  });

  it('answers the same question the same way when it appears twice', async () => {
    // The key is the question's text, and the arm asks each question once — so a
    // repeat is not a scenario the arm creates. It is the property that makes the
    // lookup total: the second entry overwrites the first rather than making the
    // answer depend on which copy the reader happens to compare against.
    const index = await buildRetrievalRelevanceIndex(embedding(), [
      { question: 'how many bikes do I own', context: ['an orthogonal turn', 'a near turn'] },
      { question: 'how many bikes do I own', context: ['a near turn'] },
    ]);

    expect(index.relevanceFor('how many bikes do I own', 'a near turn')).toBeCloseTo(0.8, 10);
    expect(index.relevanceFor('how many bikes do I own', 'an orthogonal turn')).toBe(
      floorOf(index),
    );
  });

  it('namespaces its scores by question', async () => {
    const index = await buildRetrievalRelevanceIndex(
      tableEmbedding({ asked: [1, 0], unasked: [0, 1], shared: [0.8, 0.6] }, DIM),
      [{ question: 'asked', context: ['shared'] }],
    );

    expect(index.relevanceFor('asked', 'shared')).toBeCloseTo(0.8, 10);
    expect(index.relevanceFor('unasked', 'shared')).toBe(floorOf(index));
  });

  it('reads no field but the question and its context', async () => {
    // The non-oracle property, stated as a measurement rather than a promise: the
    // ground truth is not a parameter, so two cases that differ only in an
    // unread field produce one index. This is the assertion that would fail if a
    // later revision reached for the answer key to sharpen the signal.
    const withTruth = await buildRetrievalRelevanceIndex(embedding(), [
      {
        question: 'how many bikes do I own',
        context: ['the answer turn'],
        expected: 'three',
      } as { question: string; context: string[] },
    ]);
    const withoutTruth = await buildRetrievalRelevanceIndex(embedding(), [
      { question: 'how many bikes do I own', context: ['the answer turn'] },
    ]);

    expect(withTruth.relevanceFor('how many bikes do I own', 'the answer turn')).toBe(
      withoutTruth.relevanceFor('how many bikes do I own', 'the answer turn'),
    );
    expect(withTruth.scoredPairs).toBe(withoutTruth.scoredPairs);
  });

  it('is a pure lookup, so repeated reads cannot drift', async () => {
    const index = await buildRetrievalRelevanceIndex(embedding(), [
      { question: 'how many bikes do I own', context: ['a near turn', 'the answer turn'] },
    ]);

    const first = index.relevanceFor('how many bikes do I own', 'a near turn');
    index.relevanceFor('how many bikes do I own', 'the answer turn');
    index.relevanceFor('never retrieved', 'never retrieved');
    expect(index.relevanceFor('how many bikes do I own', 'a near turn')).toBe(first);
  });
});

describe('buildRetrievalRelevanceIndex with query expansion', () => {
  /**
   * A geometry where the activity turn is orthogonal to the question and identical to
   * the phrase: this is the §13.96 shape in miniature -- the evidence is carried, but the
   * question's own words point nowhere near it.
   */
  const EXPANDED = {
    'how many projects did I lead': [1, 0],
    'activity turn': [0, 1],
    'led a consumer-research project': [0, 1],
  } as const;

  it('lets a phrase surface a turn the question alone scores at zero', async () => {
    const bare = await buildRetrievalRelevanceIndex(tableEmbedding(EXPANDED, DIM), [
      { question: 'how many projects did I lead', context: ['activity turn'] },
    ]);
    const expanded = await buildRetrievalRelevanceIndex(tableEmbedding(EXPANDED, DIM), [
      {
        question: 'how many projects did I lead',
        queries: ['led a consumer-research project'],
        context: ['activity turn'],
      },
    ]);

    expect(bare.relevanceFor('how many projects did I lead', 'activity turn')).toBeCloseTo(0, 10);
    expect(expanded.relevanceFor('how many projects did I lead', 'activity turn')).toBeCloseTo(
      1,
      10,
    );
    // The key stays the question: a phrase changes the ranking, never the namespace.
    expect(expanded.relevanceFor('led a consumer-research project', 'activity turn')).toBe(
      floorOf(expanded),
    );
  });

  it('retrieves the question first and the phrases after it', async () => {
    // Order is the contract the fusion relies on: `retrieveTopKByQueries` weights every
    // ranking equally, and the question is the ranking a run must never lose. The
    // assertion is on the call, because the score alone cannot show which query produced it.
    const seen: (readonly string[])[] = [];
    await buildRetrievalRelevanceIndex(
      tableEmbedding(EXPANDED, DIM),
      [
        {
          question: 'how many projects did I lead',
          queries: ['led a consumer-research project', 'ran a review'],
          context: ['activity turn'],
        },
      ],
      {
        retrieve: (queries) => {
          seen.push([...queries]);
          return Promise.resolve([{ id: 't', text: 'activity turn', score: 0.5, index: 0 }]);
        },
      },
    );

    expect(seen).toEqual([
      ['how many projects did I lead', 'led a consumer-research project', 'ran a review'],
    ]);
  });

  it('treats an empty phrase list as the bare question', async () => {
    // Absent and empty are the same state by contract, so a caller that passes the
    // expansion's map through unconditionally cannot accidentally change a control run.
    const absent = await buildRetrievalRelevanceIndex(tableEmbedding(EXPANDED, DIM), [
      { question: 'how many projects did I lead', context: ['activity turn'] },
    ]);
    const empty = await buildRetrievalRelevanceIndex(tableEmbedding(EXPANDED, DIM), [
      {
        question: 'how many projects did I lead',
        queries: [],
        context: ['activity turn'],
      },
    ]);

    expect(empty.relevanceFor('how many projects did I lead', 'activity turn')).toBe(
      absent.relevanceFor('how many projects did I lead', 'activity turn'),
    );
    expect(empty.scoredPairs).toBe(absent.scoredPairs);
  });
});

/**
 * §13.256's increment, at the layer that owns the pool.
 *
 * The fixture states the case the mechanism exists for: two sessions, a question naming four
 * terms, and a retriever that surfaces the first statement and one turn from the second session.
 * The gold-shaped turn -- `third turn` -- is the one no ranking offered.
 */
describe('buildRetrievalRelevanceIndex anchors', () => {
  const SESSIONS: readonly (readonly string[])[] = [
    ['alpha beta start', 'unrelated remark', 'alpha beta end', 'third turn'],
    ['gamma here', 'delta here'],
  ];
  const CONTEXT: readonly string[] = SESSIONS.flat();
  const QUESTION = 'alpha beta gamma delta';
  const HITS = [
    { id: 'a', text: 'alpha beta start', score: 1, index: 0 },
    { id: 'b', text: 'gamma here', score: 0.9, index: 4 },
  ];

  /**
   * `sessions === null` omits the field entirely, which is the archived state of every case: absent
   * and empty are different inputs even where they produce the same pool.
   */
  function build(
    options: Parameters<typeof buildRetrievalRelevanceIndex>[2],
    sessions: readonly (readonly string[])[] | null = SESSIONS,
  ): ReturnType<typeof buildRetrievalRelevanceIndex> {
    return buildRetrievalRelevanceIndex(
      tableEmbedding({}, DIM),
      [
        {
          question: QUESTION,
          context: CONTEXT,
          ...(sessions === null ? {} : { sessions }),
        },
      ],
      { topK: 2, retrieve: () => Promise.resolve(HITS), ...options },
    );
  }

  it('scores a turn the retriever never surfaced when restoration is configured', async () => {
    // The whole point: `third turn` is two steps from the anchor inside its own session, and no
    // ranking offered it. Before this option it carried the floor and the budget could only buy it
    // by accident.
    // The decay is named rather than defaulted: this case is about a never-surfaced turn acquiring a
    // score at all, and the registered rate belongs to `anchor-recall.test.ts`'s own case. Without the
    // override, moving the registration would rewrite an expectation that is not about it.
    const withAnchors = await build({ anchors: { decay: 0.5 } });
    const without = await build({});

    expect(without.relevanceFor(QUESTION, 'third turn')).toBeLessThan(0);
    expect(withAnchors.relevanceFor(QUESTION, 'third turn')).toBeCloseTo(0.125, 12);
  });

  it('reports the pool as a candidate set that agrees with the scores', async () => {
    // The equivalence `relevance-index.test.ts` asserts for the retriever's own hits has to survive
    // a widened pool, or `candidatesFor` would describe a pool the selection cannot see.
    const index = await build({ anchors: {} });
    const floor = index.relevanceFor('a question the index never saw', 'a turn it never saw');
    const ranked = index.rankedCandidatesFor(QUESTION);
    for (const text of ranked) {
      expect(index.relevanceFor(QUESTION, text)).toBeGreaterThan(floor);
      expect(index.candidatesFor(QUESTION).has(text)).toBe(true);
    }
    expect(ranked).toContain('third turn');
  });

  it('reports the parameters the pool was built with, not the ones the caller named', async () => {
    // §13.257. `{ anchors: {} }` names the mechanism and no numbers, so the record has to answer with
    // the numbers that ran -- otherwise two dispatches of `retrieval-anchored` at different decays
    // would publish artifacts a reader could not tell apart, which is exactly the comparison this
    // campaign now has to make.
    const index = await build({ anchors: {} });
    // The registered triple, spelled out rather than read from the module: a test that imported the
    // resolver would agree with any dispatch that moved it, and the point of this case is that moving
    // the registration is visible in a test that fails.
    expect(index.anchors).toEqual({
      questions: 1,
      anchors: 2,
      restored: 4,
      count: 4,
      radius: 3,
      decay: 0.5,
    });
  });

  it('reports the parameters a caller overrode', async () => {
    // The other direction: a dispatch that moves a parameter must see the movement in the record, or
    // the field would be a constant dressed as provenance.
    const index = await build({ anchors: { radius: 1, decay: 0.25 } });
    expect(index.anchors).toMatchObject({ count: 4, radius: 1, decay: 0.25 });
  });

  it('counts the added turns in scoredPairs and in its own census', async () => {
    const index = await build({ anchors: {} });
    // Two retrieved hits plus the anchor neighbourhoods: three around the first anchor and one
    // around the second.
    expect(index.scoredPairs).toBe(6);
    // `toMatchObject` rather than `toEqual`: this case is about the counts, and the parameters are
    // pinned once in their own case below -- a deep equality here would make every dispatch that moves
    // the registered decay fail a test that is not about the decay.
    expect(index.anchors).toMatchObject({ questions: 1, anchors: 2, restored: 4 });
  });

  it('reports reach separately from effect when the case carries no boundaries', async () => {
    // `questions: 1, restored: 0` is a mechanism that ran and had nothing to restore, which is a
    // different finding from "the field is absent because it never ran".
    const index = await build({ anchors: {} }, []);
    // The selection needs no boundary, so it still fires: two anchors, nothing restored. That is the
    // reading that keeps "this case had no sessions" apart from "nothing was selected".
    expect(index.anchors).toMatchObject({ questions: 1, anchors: 2, restored: 0 });
    expect(index.rankedCandidatesFor(QUESTION)).toEqual(['alpha beta start', 'gamma here']);
  });

  it('treats a case without boundaries as a case with none', async () => {
    // `entry.sessions ?? []` is a branch a reader can see and a run cannot: a dataset that does not
    // carry sessions must reach the same pool as one that carries an empty list.
    const index = await build({ anchors: {} }, null);
    expect(index.anchors).toMatchObject({ questions: 1, anchors: 2, restored: 0 });
  });

  it('leaves the pool byte-identical when the option is absent', async () => {
    // The compatibility guarantee every archived artifact rests on.
    const index = await build({});
    expect(index.anchors).toBeUndefined();
    expect(index.scoredPairs).toBe(2);
    expect(index.rankedCandidatesFor(QUESTION)).toEqual(['alpha beta start', 'gamma here']);
  });

  it('keeps the retriever head first and restoration below it', async () => {
    const index = await build({ anchors: {} });
    expect(index.rankedCandidatesFor(QUESTION)[0]).toBe('alpha beta start');
    // Every restored turn sits below the lower of the two measured hits, so restoration cannot
    // displace a hit the retriever ranked above its own anchor.
    for (const text of ['unrelated remark', 'alpha beta end', 'third turn', 'delta here']) {
      expect(index.relevanceFor(QUESTION, text)).toBeLessThan(0.9);
    }
  });

  it('restores around the pool the reranker produced', async () => {
    // Restoration runs last, so the anchor is whatever the cross-encoder put first. Here the reranker
    // promotes the second session's turn, and the neighbourhood restored is that session's.
    const index = await build({
      anchors: {},
      // The scorer answers one number per candidate, in the order it was handed them; reversing the
      // numbers is what promotes the second session's turn without inventing a second retriever.
      rerank: (pairs) => Promise.resolve(pairs.map((_, position) => (position === 0 ? 0.1 : 0.9))),
    });
    expect(index.rankedCandidatesFor(QUESTION)[0]).toBe('gamma here');
    expect(index.relevanceFor(QUESTION, 'delta here')).toBeCloseTo(0.5, 12);
  });
});
