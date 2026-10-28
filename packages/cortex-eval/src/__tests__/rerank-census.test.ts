/**
 * The rerank census must move exactly when the stage did not do its job.
 *
 * ## What this suite is defending
 *
 * `cortex-core`'s `rerankHits` degrades to the retrieved order on a throw, a short reply and a
 * non-finite score alike. Without counters, an arm whose provider returned `401` for all five
 * hundred questions produces the same artifact as one whose cross-encoder was consulted and agreed
 * with the retriever every time. The registered reading of the rerank increment treats that as an
 * assembly failure, which is only executable if the artifact can tell the two apart.
 *
 * So the assertions here are not "the counters increment". They are:
 *
 *  1. `fallbacks` moves **iff** `rerankHits` left the order as retrieved — driven through the real
 *     degradation path rather than asserted against the wrapper alone, because the wrapper repeats
 *     `scoreSafely`'s three predicates and a drift between the two verdicts is the failure mode that
 *     would make the counter quietly mean something else.
 *  2. `changed` moves iff the order actually moved, so a reranker that agrees with the retriever is
 *     a recorded **success**, not a silent failure.
 *  3. the census is a snapshot, not a live view, so a report rendered early cannot change after the
 *     run it describes.
 */
import { describe, it, expect } from 'vitest';
import { rerankHits, type RerankCandidate, type RerankPair } from '@agentix-e/cortex-core';
import { countedRerank } from '../rerank-census.js';

const CANDIDATES: readonly RerankCandidate[] = [
  { id: 'a', text: 'the pharmacy receipt', score: 0.9 },
  { id: 'b', text: 'a lunch order', score: 0.8 },
  { id: 'c', text: 'the return label', score: 0.7 },
];

const order = (list: readonly RerankCandidate[]): readonly string[] => list.map((item) => item.id);

/** A scorer that answers with the values given, and records what it was asked. */
function scoredTo(values: readonly number[]): {
  calls: RerankPair[][];
  score: (pairs: readonly RerankPair[]) => Promise<readonly number[]>;
} {
  const calls: RerankPair[][] = [];
  return {
    calls,
    score: (pairs) => {
      calls.push([...pairs]);
      return Promise.resolve(values);
    },
  };
}

describe('countedRerank', () => {
  it('counts one call and one pair per candidate', async () => {
    const inner = scoredTo([1, 2, 3]);
    const counted = countedRerank(inner.score);

    await rerankHits(CANDIDATES, 'when did I buy the lamp', counted.score);

    expect(counted.snapshot()).toEqual({
      calls: 1,
      pairs: 3,
      fallbacks: 0,
      changed: 0,
      clipped: 0,
    });
    // The pairs handed over are the candidates the retriever surfaced, in its order.
    expect(inner.calls[0]?.map((pair) => pair.candidateId)).toEqual(['a', 'b', 'c']);
  });

  it('records a reordering as a change, and the pair count as the cost', async () => {
    const counted = countedRerank(scoredTo([0.1, 0.2, 0.9]).score);

    const before = order(CANDIDATES);
    const after = order(await rerankHits(CANDIDATES, 'q', counted.score));
    counted.observeOrder(before, after);

    expect(after).toEqual(['c', 'b', 'a']);
    expect(counted.snapshot()).toEqual({
      calls: 1,
      pairs: 3,
      fallbacks: 0,
      changed: 1,
      clipped: 0,
    });
  });

  it('does not record agreement as a change, because agreement is the stage working', async () => {
    // The distinction the counter exists for: `changed: 0` with `fallbacks: 0` is a reranker that
    // ran and confirmed the retrieval order. Counting it as a failure would make a working stage
    // unable to report success.
    const counted = countedRerank(scoredTo([0.9, 0.8, 0.7]).score);

    const before = order(CANDIDATES);
    const after = order(await rerankHits(CANDIDATES, 'q', counted.score));
    counted.observeOrder(before, after);

    expect(after).toEqual(['a', 'b', 'c']);
    expect(counted.snapshot()).toEqual({
      calls: 1,
      pairs: 3,
      fallbacks: 0,
      changed: 0,
      clipped: 0,
    });
  });

  it('counts a thrown scorer as a fallback, and the order stands', async () => {
    const counted = countedRerank(() => Promise.reject(new Error('401 Unauthorized')));

    const after = order(await rerankHits(CANDIDATES, 'q', counted.score));

    expect(after).toEqual(['a', 'b', 'c']);
    expect(counted.snapshot()).toEqual({
      calls: 1,
      pairs: 3,
      fallbacks: 1,
      changed: 0,
      clipped: 0,
    });
  });

  it('counts a short reply as a fallback', async () => {
    // A short reply means the model did not score what it was asked to. `scoreSafely` refuses to
    // pad it, and the census must agree -- otherwise the arm reports "reranked 500 questions"
    // while a third of them were never scored.
    const counted = countedRerank(scoredTo([0.9]).score);

    const after = order(await rerankHits(CANDIDATES, 'q', counted.score));

    expect(after).toEqual(['a', 'b', 'c']);
    expect(counted.snapshot().fallbacks).toBe(1);
  });

  it('counts a non-finite score as a fallback', async () => {
    const counted = countedRerank(scoredTo([0.9, Number.NaN, 0.7]).score);

    const after = order(await rerankHits(CANDIDATES, 'q', counted.score));

    expect(after).toEqual(['a', 'b', 'c']);
    expect(counted.snapshot().fallbacks).toBe(1);
  });

  it('counts a non-array reply as a fallback', async () => {
    const counted = countedRerank(() => Promise.resolve(null as unknown as readonly number[]));

    const after = order(await rerankHits(CANDIDATES, 'q', counted.score));

    expect(after).toEqual(['a', 'b', 'c']);
    expect(counted.snapshot().fallbacks).toBe(1);
  });

  it('accumulates across questions without letting one failure hide another', async () => {
    // The shape a real run has: 500 questions, some of them failing. The counters are the only
    // thing that separates "the provider refused a third of the calls" from a bad day of ranking.
    //
    // The answers are thunks rather than promises: a `Promise.reject` built by the array literal is
    // rejected before any handler exists, and the run would report an unhandled rejection that has
    // nothing to do with the behaviour under test.
    const answers: (() => Promise<readonly number[]>)[] = [
      () => Promise.resolve([1, 2, 3]),
      () => Promise.reject(new Error('429')),
      () => Promise.resolve([3, 2, 1]),
    ];
    let call = 0;
    const counted = countedRerank(
      () => (answers[call++] ?? (() => Promise.resolve([1, 2, 3])))() as Promise<readonly number[]>,
    );

    for (const expected of [
      ['c', 'b', 'a'],
      ['a', 'b', 'c'],
      ['a', 'b', 'c'],
    ]) {
      const before = order(CANDIDATES);
      const after = order(await rerankHits(CANDIDATES, 'q', counted.score));
      counted.observeOrder(before, after);
      expect(after).toEqual(expected);
    }

    expect(counted.snapshot()).toEqual({
      calls: 3,
      pairs: 9,
      fallbacks: 1,
      changed: 1,
      clipped: 0,
    });
  });

  it('clips a passage to the declared per-document limit and counts it', async () => {
    // The provider's wire limit is not a property of the question: Zhipu's `/rerank` rejects the whole
    // call when one document exceeds 4096 characters, and this corpus carries turns up to 15,369. An
    // unclipped stage would report those questions as `fallbacks`, which the registration reads as an
    // assembly failure -- so the clip belongs to the boundary and the count belongs to the census.
    const inner = scoredTo([1, 2, 3]);
    const counted = countedRerank(inner.score, { maxDocumentChars: 20 });
    const long = [
      { id: 'a', text: 'a very long turn about the pharmacy', score: 0.9 },
      { id: 'b', text: 'a lunch order', score: 0.8 },
      { id: 'c', text: 'the return label', score: 0.7 },
    ];

    await rerankHits(long, 'q', counted.score);

    // Only the passage over the limit was shortened, and it kept its id.
    expect(inner.calls[0]?.map((pair) => pair.text)).toEqual([
      'a very long turn abo',
      'a lunch order',
      'the return label',
    ]);
    expect(inner.calls[0]?.map((pair) => pair.candidateId)).toEqual(['a', 'b', 'c']);
    expect(counted.snapshot()).toEqual({
      calls: 1,
      pairs: 3,
      fallbacks: 0,
      changed: 0,
      clipped: 1,
    });
  });

  it('clips nothing when no limit is declared', async () => {
    const inner = scoredTo([1, 2, 3]);
    const counted = countedRerank(inner.score);
    await rerankHits(CANDIDATES, 'q', counted.score);
    expect(inner.calls[0]?.map((pair) => pair.text)).toEqual([
      'the pharmacy receipt',
      'a lunch order',
      'the return label',
    ]);
    expect(counted.snapshot().clipped).toBe(0);
  });

  it('returns a snapshot rather than a live view', async () => {
    const counted = countedRerank(scoredTo([1, 2, 3]).score);
    await rerankHits(CANDIDATES, 'q', counted.score);

    const first = counted.snapshot();
    await rerankHits(CANDIDATES, 'q', counted.score);

    expect(first.calls).toBe(1);
    expect(counted.snapshot().calls).toBe(2);
  });

  it('treats a shortened candidate list as a change, never as agreement', async () => {
    // `rerankHits` never filters, so this cannot happen through the real stage -- but the comparison
    // is what decides `changed`, and a version that zipped the two lists would describe a filter as
    // agreement on the surviving prefix. Pinned as a property of the comparator.
    const counted = countedRerank(scoredTo([1, 2, 3]).score);
    counted.observeOrder(['a', 'b', 'c'], ['a', 'b']);
    expect(counted.snapshot().changed).toBe(1);
  });
});
