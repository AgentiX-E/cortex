/**
 * Tests for the cross-encoder reranking stage (roadmap measure B1).
 *
 * Why this module exists: cortex retrieves with a bi-encoder (embedding cosine)
 * and fuses channels by reciprocal rank, but it never re-scores the fused pool
 * against the question with a model that can see both at once. Published memory
 * systems that reach >=95% on LongMemEval all run a re-scoring pass as the last
 * retrieval stage; cortex has none (a repository-wide search for `rerank`
 * returns zero implementations). This suite pins the contract of the pure
 * reranking stage before the stage itself exists.
 *
 * The tests are deliberately written against a *fake* scorer, not a mock of the
 * reranker: the reranker under test is real code, and only the model boundary
 * (which would otherwise require a network call) is replaced. That keeps the
 * arithmetic, ordering, tie-breaking, and degrade paths under genuine test.
 */

import { describe, expect, it } from 'vitest';

import {
  fuseRerank,
  rerankHits,
  type RerankCandidate,
  type RerankScoreFn,
} from '../retrieval/rerank.js';

/** Build a candidate list from ids in the order given (best-first). */
function candidates(...ids: string[]): RerankCandidate[] {
  return ids.map((id, rank) => ({
    id,
    text: `text of ${id}`,
    // Deliberately descending and widely spaced, mirroring cosine scores.
    score: 1 - rank * 0.1,
    index: rank,
  }));
}

/**
 * A deterministic scorer whose relevance is a stated lookup table. This is the
 * only stand-in in the suite: it replaces the model boundary, not the reranker.
 */
function lookupScorer(table: Record<string, number>): RerankScoreFn {
  return async (pairs) => pairs.map((pair) => table[pair.candidateId] ?? 0);
}

describe('rerankHits', () => {
  it('reorders candidates by descending cross-encoder score', async () => {
    const input = candidates('a', 'b', 'c');
    const result = await rerankHits(input, 'q', lookupScorer({ a: 0.1, b: 0.9, c: 0.5 }));

    expect(result.map((hit) => hit.id)).toEqual(['b', 'c', 'a']);
  });

  it('preserves every candidate so no recall is lost', async () => {
    const input = candidates('a', 'b', 'c', 'd');
    const result = await rerankHits(input, 'q', lookupScorer({ a: 0, b: 0, c: 0, d: 0 }));

    expect(result).toHaveLength(4);
    expect(new Set(result.map((hit) => hit.id))).toEqual(new Set(['a', 'b', 'c', 'd']));
  });

  it('carries extra caller fields through untouched', async () => {
    // The real callers' hits carry positional fields the reranker never reads:
    // `RetrievalHit` has `index`, `SessionHit` has `sessionIndex`. Pass-through
    // is what lets admission use the reordered positions afterwards, so it is
    // asserted with both shapes rather than a hypothetical one.
    const turnHits = [
      { id: 'x', text: 'payload-x', score: 0.7, index: 41 },
      { id: 'y', text: 'payload-y', score: 0.6, index: 7 },
    ];
    const byTurn = await rerankHits(turnHits, 'q', lookupScorer({ x: 0.2, y: 0.8 }));
    expect(byTurn[0]).toEqual({ id: 'y', text: 'payload-y', score: 0.6, index: 7 });

    const sessionHits = [
      { id: 's1', text: 'session one', score: 0.9, sessionIndex: 3 },
      { id: 's2', text: 'session two', score: 0.4, sessionIndex: 8 },
    ];
    const bySession = await rerankHits(sessionHits, 'q', lookupScorer({ s1: 0, s2: 1 }));
    expect(bySession[0]).toEqual({ id: 's2', text: 'session two', score: 0.4, sessionIndex: 8 });
  });

  it('breaks ties by original rank so the order stays deterministic', async () => {
    const input = candidates('first', 'second', 'third');
    const result = await rerankHits(
      input,
      'q',
      lookupScorer({ first: 0.5, second: 0.5, third: 0.5 }),
    );

    expect(result.map((hit) => hit.id)).toEqual(['first', 'second', 'third']);
  });

  it('returns an empty list without calling the scorer when given no candidates', async () => {
    let calls = 0;
    const scorer: RerankScoreFn = async (pairs) => {
      calls += pairs.length;
      return [];
    };

    expect(await rerankHits([], 'q', scorer)).toEqual([]);
    expect(calls).toBe(0);
  });

  it('passes the question and each candidate text to the scorer', async () => {
    const seen: { question: string; candidateId: string; text: string }[] = [];
    const scorer: RerankScoreFn = async (pairs) => {
      for (const pair of pairs) {
        seen.push({ question: pair.question, candidateId: pair.candidateId, text: pair.text });
      }
      return pairs.map(() => 0);
    };

    await rerankHits(candidates('a', 'b'), 'the question', scorer);

    expect(seen).toEqual([
      { question: 'the question', candidateId: 'a', text: 'text of a' },
      { question: 'the question', candidateId: 'b', text: 'text of b' },
    ]);
  });

  it('falls back to the input order when the scorer throws', async () => {
    const input = candidates('a', 'b', 'c');
    const scorer: RerankScoreFn = async () => {
      throw new Error('provider unavailable');
    };

    expect(await rerankHits(input, 'q', scorer)).toEqual(input);
  });

  it('falls back to the input order when the scorer returns the wrong arity', async () => {
    const input = candidates('a', 'b', 'c');
    // A truncated response would otherwise silently drop candidates.
    const scorer: RerankScoreFn = async () => [0.5];

    expect(await rerankHits(input, 'q', scorer)).toEqual(input);
  });

  it('falls back to the input order when a score is not finite', async () => {
    const input = candidates('a', 'b', 'c');
    const scorer: RerankScoreFn = async (pairs) => pairs.map(() => Number.NaN);

    expect(await rerankHits(input, 'q', scorer)).toEqual(input);
  });

  it('treats a non-array scorer result as a failure rather than a crash', async () => {
    const input = candidates('a', 'b');
    const scorer = (async () => undefined) as unknown as RerankScoreFn;

    expect(await rerankHits(input, 'q', scorer)).toEqual(input);
  });

  it('accepts finite negative scores, which some providers emit as logits', async () => {
    const input = candidates('a', 'b');
    const result = await rerankHits(input, 'q', lookupScorer({ a: -3.5, b: -1.25 }));

    expect(result.map((hit) => hit.id)).toEqual(['b', 'a']);
  });
});

describe('fuseRerank', () => {
  it('appends the reranked pool behind the protected head', async () => {
    const head = candidates('h1', 'h2');
    const pool = candidates('p1', 'p2');
    const fused = await fuseRerank(head, pool, 'q', lookupScorer({ p1: 0.1, p2: 0.9 }));

    expect(fused.map((hit) => hit.id)).toEqual(['h1', 'h2', 'p2', 'p1']);
  });

  it('does not duplicate a candidate present in both head and pool', async () => {
    const head = [{ id: 'shared', text: 't', score: 0.9, index: 0 }];
    const pool = [
      { id: 'shared', text: 't', score: 0.8, index: 0 },
      { id: 'only', text: 'u', score: 0.7, index: 1 },
    ];
    const fused = await fuseRerank(head, pool, 'q', lookupScorer({ shared: 0.9, only: 0.1 }));

    expect(fused.map((hit) => hit.id)).toEqual(['shared', 'only']);
    expect(fused.filter((hit) => hit.id === 'shared')).toHaveLength(1);
  });

  it('leaves the protected head in its original order even when the scorer disagrees', async () => {
    const head = candidates('h1', 'h2');
    const pool = candidates('p1');
    const fused = await fuseRerank(head, pool, 'q', lookupScorer({ h1: 0, h2: 0, p1: 1 }));

    // h1/h2 come first in their original order: the head is a fixed prefix, so
    // the abstention signal read from it cannot move when reranking changes.
    expect(fused.slice(0, 2).map((hit) => hit.id)).toEqual(['h1', 'h2']);
  });

  it('returns the head unchanged when the pool is empty', async () => {
    const head = candidates('h1', 'h2');
    let calls = 0;
    const scorer: RerankScoreFn = async () => {
      calls += 1;
      return [];
    };

    expect(await fuseRerank(head, [], 'q', scorer)).toEqual(head);
    expect(calls).toBe(0);
  });

  it('returns the reranked pool when the head is empty', async () => {
    const pool = candidates('p1', 'p2');
    const fused = await fuseRerank([], pool, 'q', lookupScorer({ p1: 0.2, p2: 0.8 }));

    expect(fused.map((hit) => hit.id)).toEqual(['p2', 'p1']);
  });

  it('honours a head budget of zero by reranking the whole pool', async () => {
    const head = candidates('h1');
    const pool = candidates('p1', 'p2');
    const fused = await fuseRerank(head, pool, 'q', lookupScorer({ h1: 0, p1: 0.1, p2: 1 }), {
      headSize: 0,
    });

    expect(fused.map((hit) => hit.id)).toEqual(['p2', 'p1', 'h1']);
  });

  it('caps the head at the head budget, still preserving its order', async () => {
    const head = candidates('h1', 'h2', 'h3');
    const pool = candidates('p1');
    const fused = await fuseRerank(head, pool, 'q', lookupScorer({ p1: 1 }), { headSize: 1 });

    expect(fused.map((hit) => hit.id)).toEqual(['h1', 'p1', 'h2', 'h3']);
  });

  it('degrades to head-then-pool when the scorer fails, losing no candidate', async () => {
    const head = candidates('h1');
    const pool = candidates('p1', 'p2');
    const scorer: RerankScoreFn = async () => {
      throw new Error('down');
    };
    const fused = await fuseRerank(head, pool, 'q', scorer);

    expect(fused.map((hit) => hit.id)).toEqual(['h1', 'p1', 'p2']);
  });

  it('deduplicates a candidate shared between the head tail and the pool', async () => {
    const head = candidates('h1', 'dup');
    const pool = candidates('dup', 'p1');
    // headSize 1 pins only h1, so `dup` is rerankable and arrives twice.
    const fused = await fuseRerank(head, pool, 'q', lookupScorer({ dup: 0.9, p1: 0.1 }), {
      headSize: 1,
    });

    expect(fused.map((hit) => hit.id)).toEqual(['h1', 'dup', 'p1']);
    expect(fused.filter((hit) => hit.id === 'dup')).toHaveLength(1);
  });

  it('preserves the head-tail ordering when the scorer fails during dedup', async () => {
    const head = candidates('h1', 'h2');
    const pool = candidates('h2', 'p1');
    const scorer: RerankScoreFn = async () => {
      throw new Error('down');
    };
    const fused = await fuseRerank(head, pool, 'q', scorer, { headSize: 1 });

    // h1 pinned, then the unseen remainder of head then pool, deduped in order.
    expect(fused.map((hit) => hit.id)).toEqual(['h1', 'h2', 'p1']);
  });

  it('returns the pinned prefix when every rerankable candidate is a duplicate of it', async () => {
    const head = candidates('h1');
    const pool = candidates('h1');
    let calls = 0;
    const scorer: RerankScoreFn = async () => {
      calls += 1;
      return [];
    };

    expect(await fuseRerank(head, pool, 'q', scorer)).toEqual(head);
    expect(calls).toBe(0);
  });

  it('treats a negative head budget as zero', async () => {
    const head = candidates('h1');
    const pool = candidates('p1');
    const fused = await fuseRerank(head, pool, 'q', lookupScorer({ h1: 0, p1: 1 }), {
      headSize: -5,
    });

    expect(fused.map((hit) => hit.id)).toEqual(['p1', 'h1']);
  });
});
