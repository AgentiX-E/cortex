/**
 * A run must learn the provider is refusing **before** it commits hours to it.
 *
 * ## The two runs this pins
 *
 * `38520676669` graded two repetitions of both systems, died on `TypeError: terminated`
 * after three hours and eight minutes, and the record could not say why.
 * `38566578567` -- dispatched after a repair that made the record name the failing call --
 * died **before grading a single question**, and the stack named the cause exactly:
 *
 *     progress: no question was started before the failure
 *     Error: Embedding request failed: 429 Too Many Requests —
 *       {"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}
 *         at OpenAIEmbedding.embed (packages/cortex-ai/src/embedding/openai.ts:61:13)
 *         at async embedManyCached (retrieval.ts:256)
 *         at async buildTurnIndex (retrieval.ts:397)
 *         at async retrieveTopKByQueries (retrieval.ts:981)
 *         at async buildRetrievalRelevanceIndex (relevance-index.ts:169)
 *         at async main (bench/run-ablation.ts:233)
 *
 * The provider says the account has no credit. It took **thirty minutes** of embedding the
 * relevance index to find that out, because the first call that fails is the one that
 * happens to fall after the balance runs out -- and the harness has no cheaper way to ask.
 *
 * ## What a preflight can and cannot do
 *
 * It cannot prevent the balance running out mid-run, and this file does not claim to: in
 * `38566578567` about nine thousand five hundred embedding requests were served before the
 * provider started refusing, so an account that is funded at t=0 can be empty at t=30m.
 *
 * What it does is make the state observable for one request instead of for a run. Every
 * dispatch from here pays a fraction of a cent to learn, in seconds, whether the provider
 * will serve it at all -- and the answer arrives as the provider's own words, which is the
 * only part of the failure that says what to DO about it.
 */
import { describe, expect, it } from 'vitest';
import type { EmbeddingModel } from '@agentix-e/cortex-core';

import { preflightEmbedding } from '../embedding-preflight.js';

/** A provider that answers every request with `vectors`. */
function answering(vectors: number[][]): { model: EmbeddingModel; seen: string[][] } {
  const seen: string[][] = [];
  return {
    seen,
    model: {
      embed: async (texts: string[]) => {
        seen.push([...texts]);
        return vectors.map((v) => Float64Array.from(v));
      },
      dimension: () => vectors[0]?.length ?? 0,
    },
  };
}

/**
 * The exact refusal `38566578567` recorded, verbatim.
 *
 * It is a fixture rather than a paraphrase because the whole value of the preflight is
 * that it relays the provider's own words: `429 Too Many Requests` alone reads as a rate
 * limit, which is a condition you wait out, and this account's condition is the opposite
 * of that.
 */
const QUOTA_BODY =
  '429 Too Many Requests — {"error":{"code":"1113","message":"余额不足或无可用资源包,请充值。"}}';

describe('preflightEmbedding', () => {
  it('accepts a provider that answers with one vector of the declared dimension', async () => {
    const { model } = answering([[1, 0, 0]]);
    const verdict = await preflightEmbedding(model);

    expect(verdict.ok).toBe(true);
    expect(verdict.vectors).toBe(1);
    expect(verdict.dimension).toBe(3);
    expect(verdict.message).toBe('');
  });

  it('relays the provider’s own refusal, because that is what says what to do', async () => {
    // The load-bearing assertion. A verdict that reported only "the embedding is
    // unreachable" would be true and useless: the actionable half is that the account is
    // out of credit, and only the body carries it.
    const model: EmbeddingModel = {
      embed: async () => {
        throw new Error(`Embedding request failed: ${QUOTA_BODY}`);
      },
      dimension: () => 1024,
    };

    const verdict = await preflightEmbedding(model);

    expect(verdict.ok).toBe(false);
    expect(verdict.vectors).toBe(0);
    expect(verdict.message).toContain('余额不足');
    expect(verdict.message).toBe(`Embedding request failed: ${QUOTA_BODY}`);
  });

  it('issues exactly one request, so the check cannot itself spend a budget', async () => {
    // A preflight that batched would be a check with a cost, and the reason to run it is
    // to avoid spending on a line that cannot run. One request of one short text is the
    // smallest thing that can answer the question.
    const { model, seen } = answering([[1, 0, 0]]);
    await preflightEmbedding(model);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(seen[0]![0]!.length).toBeGreaterThan(0);
  });

  it('asks with a constant text, so the answer is attributable and cannot depend on the dataset', async () => {
    // The other half of "one request": a check whose input came from the dataset would
    // make the verdict a function of which question happened to be first.
    const first = answering([[1, 0, 0]]);
    const second = answering([[1, 0, 0]]);
    await preflightEmbedding(first.model);
    await preflightEmbedding(second.model);

    expect(first.seen).toEqual(second.seen);
  });

  it('refuses a provider that answers with the wrong dimension', async () => {
    // Reachable and usable are different claims. A provider that answers with a vector of
    // the wrong length would corrupt every cosine downstream and would fail at question
    // three hundred rather than at the check -- which is the failure mode the preflight
    // exists to move forward.
    const model: EmbeddingModel = {
      embed: async () => [Float64Array.from([1, 2])],
      dimension: () => 1024,
    };

    const verdict = await preflightEmbedding(model);

    expect(verdict.ok).toBe(false);
    expect(verdict.dimension).toBe(2);
    expect(verdict.message).toContain('2');
    expect(verdict.message).toContain('1024');
  });

  it('refuses an empty answer', async () => {
    const model: EmbeddingModel = { embed: async () => [], dimension: () => 8 };
    const verdict = await preflightEmbedding(model);

    expect(verdict.ok).toBe(false);
    expect(verdict.vectors).toBe(0);
  });

  it('resolves rather than throwing, on a non-Error throw', async () => {
    // The verdict IS the error channel here: a preflight that threw would be caught by the
    // entry point's top-level handler and reported as an unexpected failure, which is the
    // opposite of what a check that failed on purpose should look like.
    const model: EmbeddingModel = {
      embed: async () => {
        throw 'quota';
      },
      dimension: () => 4,
    };

    const verdict = await preflightEmbedding(model);

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toBe('quota');
  });
});
