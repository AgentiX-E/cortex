/**
 * The reranker reorders the pool, and the artifact can say whether it ran.
 *
 * ## What the registration demands, and what this suite therefore pins
 *
 * `PREREGISTRATION` §13.115 registers the cross-encoder stage with one instrument —
 * `rerankCensus.{calls, pairs, fallbacks, changed, clipped}` — and one reading rule: **`fallbacks > 0` is an
 * assembly failure, not a null result.** That rule is only executable if three things are true, and
 * each one is asserted here against the real build path rather than against the wrapper:
 *
 *  1. the order that reaches the budget is the reranker's, not the retriever's — otherwise `changed`
 *     would count a reordering nobody consumed;
 *  2. the number `relevanceFor` returns stays above the unscored floor **for every scale**, which is
 *     why it is a ladder over the order rather than the provider's own score (a local cross-encoder
 *     answers in negative logits, and writing those through would put a scored turn below the floor
 *     and break the equivalence `candidatesFor` is asserted on);
 *  3. a degraded call leaves the question **exactly as it was** — retrieval order, retrieval scores —
 *     so a reader who sees `fallbacks: 1` knows which single question carries no rerank.
 *
 * The last test is the composition guard: a reranker and a non-zero `temporalWeight` refuse at
 * construction, because both rewrite the same number by unrelated rules and this project has not
 * registered an order for them.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { RerankPair } from '@agentix-e/cortex-core';
import { buildRetrievalRelevanceIndex, type RelevanceIndex } from '../relevance-index.js';
import { clearEmbeddingCache } from '../retrieval.js';
import { tableEmbedding } from './test-embedding.js';

const DIM = 2;

/**
 * Four turns at decreasing cosine against the question, so the retrieval order is
 * `answer`, `near`, `third`, `orthogonal` and any change is the reranker's doing.
 */
const GEOMETRY: Readonly<Record<string, readonly number[]>> = {
  'how many bikes do I own': [1, 0],
  'the answer turn': [1, 0], // cosine 1.0
  'a near turn': [0.8, 0.6], // cosine 0.8
  'a third turn': [0.6, 0.8], // cosine 0.6
  'an orthogonal turn': [0, 1], // cosine 0.0
};

const QUESTION = 'how many bikes do I own';
const CONTEXT = ['the answer turn', 'a near turn', 'a third turn', 'an orthogonal turn'];

function embedding(): ReturnType<typeof tableEmbedding> {
  return tableEmbedding(GEOMETRY, DIM);
}

/** The score the index gives a turn it holds no measurement for. */
function floorOf(index: RelevanceIndex): number {
  return index.relevanceFor('a question the index never saw', 'a turn the index never saw');
}

/** A scorer that answers per (question, passage) by a table keyed on the passage text. */
function tableReranker(table: Readonly<Record<string, number>>): {
  score: (pairs: readonly RerankPair[]) => Promise<readonly number[]>;
  calls: RerankPair[][];
} {
  const calls: RerankPair[][] = [];
  return {
    calls,
    score: (pairs) => {
      calls.push([...pairs]);
      return Promise.resolve(pairs.map((pair) => table[pair.text] ?? 0));
    },
  };
}

beforeEach(() => {
  // The embedding cache is process-wide and a cached vector from another suite would make a
  // geometric fixture inherit that suite's arithmetic.
  clearEmbeddingCache();
});

describe('the reranker decides the pool order', () => {
  it('puts the cross-encoder best turn first even when the retriever ranked it last', async () => {
    const index = await buildRetrievalRelevanceIndex(
      embedding(),
      [{ question: QUESTION, context: [...CONTEXT] }],
      // The retriever's last turn is the reranker's first.
      { rerank: tableReranker({ 'an orthogonal turn': 0.99 }).score },
    );

    expect(index.rankedCandidatesFor(QUESTION)[0]).toBe('an orthogonal turn');
    expect(index.relevanceFor(QUESTION, 'an orthogonal turn')).toBeGreaterThan(
      index.relevanceFor(QUESTION, 'the answer turn'),
    );
  });

  it('ranks all four retrieved turns on one scale, so no turn is left on the retriever scale', async () => {
    // The property a narrower pool would break: every score above the floor must come from the same
    // ranking. A run that reranked the top two and left the rest on cosine would put 0.6 (cosine)
    // and 0.5 (a ladder position) in the same sort without either meaning the same thing.
    const index = await buildRetrievalRelevanceIndex(
      embedding(),
      [{ question: QUESTION, context: [...CONTEXT] }],
      { rerank: tableReranker({ 'a near turn': 0.9 }).score },
    );

    const scores = CONTEXT.map((turn) => index.relevanceFor(QUESTION, turn)).sort((a, b) => b - a);
    // Strictly decreasing, all above the floor, all inside (0, 1].
    for (let i = 0; i < scores.length; i += 1) {
      expect(scores[i]!).toBeGreaterThan(scores[i + 1] ?? Number.NEGATIVE_INFINITY);
      expect(scores[i]!).toBeGreaterThan(floorOf(index));
      expect(scores[i]!).toBeLessThanOrEqual(1);
    }
  });

  it('keeps a scored turn above the floor even when the provider answers in negative logits', async () => {
    // A local ms-marco cross-encoder returns unbounded logits. Writing them through would put a
    // scored turn below `UNSCORED_RELEVANCE`, which is the one equivalence the module's own type
    // says cannot break: "in `candidatesFor`" iff "scored above the floor".
    const index = await buildRetrievalRelevanceIndex(
      embedding(),
      [{ question: QUESTION, context: [...CONTEXT] }],
      { rerank: tableReranker({ 'a near turn': -8.5, 'a third turn': -12 }).score },
    );

    expect(index.relevanceFor(QUESTION, 'a third turn')).toBeGreaterThan(floorOf(index));
    expect(index.candidatesFor(QUESTION).size).toBe(4);
  });

  it('reports how many questions it touched, not how many positions moved', async () => {
    const reranker = tableReranker({ 'an orthogonal turn': 0.99 });
    const index = await buildRetrievalRelevanceIndex(
      embedding(),
      [
        { question: QUESTION, context: [...CONTEXT] },
        { question: 'how many bikes do I own', context: [...CONTEXT] },
      ],
      { rerank: reranker.score },
    );

    // Two cases, one question text: the counters are per call, so both are counted even though the
    // lookup is keyed by question. A per-question dedupe here would make the census understate the
    // cost by however many times the arm happened to ask the same text.
    expect(index.rerank).toEqual({ calls: 2, pairs: 8, fallbacks: 0, changed: 2, clipped: 0 });
  });

  it('says nothing at all when no reranker was configured', async () => {
    const index = await buildRetrievalRelevanceIndex(embedding(), [
      { question: QUESTION, context: [...CONTEXT] },
    ]);

    expect('rerank' in index).toBe(false);
    // And the control is byte-identical to the pre-existing behaviour: cosine, not a ladder.
    expect(index.relevanceFor(QUESTION, 'a near turn')).toBeCloseTo(0.8, 10);
  });
});

describe('a degraded call leaves the question as the retriever left it', () => {
  it('keeps the retrieval order and the retrieval scores when the scorer throws', async () => {
    const index = await buildRetrievalRelevanceIndex(
      embedding(),
      [{ question: QUESTION, context: [...CONTEXT] }],
      {
        rerank: () => Promise.reject(new Error('401 Unauthorized')),
      },
    );

    expect(index.rankedCandidatesFor(QUESTION)).toEqual(CONTEXT);
    // The cosine, not a ladder position. This is what makes `fallbacks` readable: one run holds one
    // meaning for `relevanceFor`, and the questions that failed are untouched by the stage.
    expect(index.relevanceFor(QUESTION, 'a near turn')).toBeCloseTo(0.8, 10);
    expect(index.rerank).toEqual({ calls: 1, pairs: 4, fallbacks: 1, changed: 0, clipped: 0 });
  });

  it('counts a partial reply as a fallback rather than ranking on the scores it did get', async () => {
    const index = await buildRetrievalRelevanceIndex(
      embedding(),
      [{ question: QUESTION, context: [...CONTEXT] }],
      { rerank: () => Promise.resolve([0.9]) },
    );

    expect(index.rankedCandidatesFor(QUESTION)).toEqual(CONTEXT);
    expect(index.rerank?.fallbacks).toBe(1);
  });
});

describe('a pool the provider cannot take is refused before it is retrieved', () => {
  it('throws when the corpus width exceeds the declared documents limit', async () => {
    // Zhipu's /rerank accepts 128 documents and rejects the call above that. A 256-wide pool would
    // therefore fall back on every question, and the registration reads 500 fallbacks as an assembly
    // failure -- an expensive way to learn a documented number.
    const retrieve = vi.fn(() => Promise.resolve([]));
    await expect(
      buildRetrievalRelevanceIndex(embedding(), [{ question: QUESTION, context: [...CONTEXT] }], {
        topK: 256,
        rerank: tableReranker({}).score,
        rerankMaxDocuments: 128,
        retrieve,
      }),
    ).rejects.toThrow(/wider than the reranker accepts/);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('accepts a pool that fits, and hands the whole pool to the scorer', async () => {
    // The property the refusal protects: one call per question, every retrieved turn scored on one
    // scale. A narrower pool would leave the rest on the retriever's scale.
    const reranker = tableReranker({});
    const index = await buildRetrievalRelevanceIndex(
      embedding(),
      [{ question: QUESTION, context: [...CONTEXT] }],
      { topK: 4, rerank: reranker.score, rerankMaxDocuments: 128 },
    );

    expect(reranker.calls).toHaveLength(1);
    expect(reranker.calls[0]).toHaveLength(4);
    expect(index.rerank).toMatchObject({ calls: 1, pairs: 4, fallbacks: 0 });
  });

  it('clips a passage to the declared per-document limit and says how often', async () => {
    // A turn longer than the endpoint's limit rejects the whole call, so the clip is what keeps the
    // stage from failing questions for a reason that has nothing to do with relevance.
    const seen: string[] = [];
    const index = await buildRetrievalRelevanceIndex(
      embedding(),
      [{ question: QUESTION, context: [...CONTEXT] }],
      {
        rerankMaxDocumentChars: 3,
        rerank: (pairs) => {
          seen.push(...pairs.map((pair) => pair.text));
          return Promise.resolve(pairs.map(() => 1));
        },
      },
    );

    expect(seen.every((text) => text.length <= 3)).toBe(true);
    expect(index.rerank?.clipped).toBe(4);
    // The candidates themselves are untouched: the reader still sees whole turns, and the index still
    // reports four candidates for the question.
    expect(index.candidatesFor(QUESTION).size).toBe(4);
  });
});

describe('the stage refuses a composition it has no definition for', () => {
  it('throws when a reranker and a temporal weight are configured together', async () => {
    await expect(
      buildRetrievalRelevanceIndex(embedding(), [{ question: QUESTION, context: [...CONTEXT] }], {
        rerank: tableReranker({}).score,
        temporalWeight: 0.5,
      }),
    ).rejects.toThrow(/temporalWeight/);
  });

  it('refuses before spending a retrieval call', async () => {
    // The refusal is a construction-time guard, not a mid-run discovery: getting it wrong halfway
    // through a 500-question index build would cost the run before it reported anything.
    const retrieve = vi.fn(() => Promise.resolve([]));
    await expect(
      buildRetrievalRelevanceIndex(embedding(), [{ question: QUESTION, context: [...CONTEXT] }], {
        rerank: tableReranker({}).score,
        temporalWeight: 0.5,
        retrieve,
      }),
    ).rejects.toThrow();
    expect(retrieve).not.toHaveBeenCalled();
  });
});
