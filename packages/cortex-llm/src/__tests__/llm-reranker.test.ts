/**
 * Tests for the LLM-as-reranker adapter (roadmap measure B1, provider-agnostic path).
 *
 * Why this adapter exists alongside the two in `rerank.ts`. A cross-encoder scores a
 * `question</s></s>passage` pair jointly and emits a scalar; a bi-encoder (the embedding
 * layer) encodes the two sides independently and therefore cannot express interaction;
 * an LLM emits a token sequence. Providers that publish no dedicated `/rerank` endpoint —
 * DeepSeek among them — can still act as a reranker if the reranker is an LLM *caller*
 * rather than an HTTP client bound to the `/rerank` convention. That is the entire point:
 * reranking must not be a single point of lock-in to a vendor that ships a rerank API.
 *
 * The granularity is listwise: one completion per distinct question returning a JSON array
 * of scores. Per-pair scoring would cost `questions x candidates` calls and would become
 * unaffordable the moment `RERANK_CANDIDATE_POOL` widens the pool — and the widest pool is
 * exactly the configuration the B1 A/B needs to test.
 *
 * The failure contract matters more than the happy path. `rerankHits` in cortex-core
 * treats a short score array as a failure and returns the input order, so a bucket that
 * cannot be parsed must contribute NO scores rather than a fabricated middle value.
 * A fabricated score would silently reorder the candidates and turn a provider hiccup
 * into an apparent (and false) experimental result.
 *
 * The LLM boundary is an injected object implementing `LLM`; no network is performed and
 * no module is mocked.
 */

import { describe, expect, it } from 'vitest';

import type { LLM } from '@agentix-e/cortex-core';
import {
  LLMReranker,
  buildListwiseRerankPrompt,
  parseListwiseScores,
} from '../rerank/llm-reranker.js';

/** A stand-in for the LLM boundary that records every prompt it was handed. */
function recordingLlm(replies: readonly string[]): LLM & { prompts: string[] } {
  const prompts: string[] = [];
  let index = 0;
  return {
    prompts,
    complete: async (prompt: string) => {
      prompts.push(prompt);
      const reply = replies[index];
      index += 1;
      return reply ?? '';
    },
    // The reranker only ever calls `complete`; the structured method is present
    // because `LLM` requires it, and it throws rather than returning a plausible
    // value so that a future implementation routing scoring through it fails here
    // instead of silently scoring everything the same.
    completeStructured: async () => {
      throw new Error('LLMReranker must not use completeStructured');
    },
  };
}

const PAIRS = [
  { question: 'q1', candidateId: 'a', text: 'alpha' },
  { question: 'q1', candidateId: 'b', text: 'beta' },
  { question: 'q2', candidateId: 'c', text: 'gamma' },
] as const;

describe('buildListwiseRerankPrompt', () => {
  it('numbers the candidates so the reply indices are unambiguous', () => {
    const prompt = buildListwiseRerankPrompt('when did it happen', ['alpha', 'beta']);

    expect(prompt).toContain('0');
    expect(prompt).toContain('1');
    expect(prompt).toContain('alpha');
    expect(prompt).toContain('beta');
    expect(prompt).toContain('when did it happen');
  });

  it('states that the reply must be a JSON array, since the parser requires it', () => {
    expect(buildListwiseRerankPrompt('q', ['a'])).toMatch(/json/i);
  });
});

describe('parseListwiseScores', () => {
  it('parses a bare JSON array', () => {
    expect(parseListwiseScores('[0.9, 0.1]', 2)).toEqual([0.9, 0.1]);
  });

  it('parses an array wrapped in prose, which models emit despite instructions', () => {
    expect(parseListwiseScores('Here are the scores:\n[0.9, 0.1]\nDone.', 2)).toEqual([0.9, 0.1]);
  });

  it('parses a fenced code block', () => {
    expect(parseListwiseScores('```json\n[0.5, 0.5]\n```', 2)).toEqual([0.5, 0.5]);
  });

  it('rejects an array of the wrong length rather than padding it', () => {
    // A padded score would reorder candidates on fabricated data.
    expect(parseListwiseScores('[0.9]', 2)).toBeNull();
    expect(parseListwiseScores('[0.9, 0.1, 0.4]', 2)).toBeNull();
  });

  it('rejects non-finite entries', () => {
    expect(parseListwiseScores('[0.9, null]', 2)).toBeNull();
    expect(parseListwiseScores('[0.9, "x"]', 2)).toBeNull();
  });

  it('rejects a non-array payload', () => {
    expect(parseListwiseScores('{"scores":[0.9,0.1]}', 2)).toBeNull();
    expect(parseListwiseScores('', 2)).toBeNull();
  });

  it('accepts an empty expectation without consulting the text', () => {
    expect(parseListwiseScores('anything', 0)).toEqual([]);
  });
});

describe('LLMReranker', () => {
  it('returns an empty array without calling the model when there are no pairs', async () => {
    const llm = recordingLlm([]);
    const reranker = new LLMReranker({ llm });

    expect(await reranker.score([])).toEqual([]);
    expect(llm.prompts).toEqual([]);
  });

  it('scores every pair in the order supplied, bucketed by question', async () => {
    const llm = recordingLlm(['[0.9, 0.1]', '[0.4]']);
    const reranker = new LLMReranker({ llm });

    expect(await reranker.score([...PAIRS])).toEqual([0.9, 0.1, 0.4]);
    // One completion per distinct question, not per pair.
    expect(llm.prompts).toHaveLength(2);
  });

  it('asks for deterministic scoring, because the A/B compares two orderings', async () => {
    const seen: (number | undefined)[] = [];
    const llm: LLM = {
      complete: async (_prompt: string, opts?: { temperature?: number }) => {
        seen.push(opts?.temperature);
        return '[0.5]';
      },
      completeStructured: async () => {
        throw new Error('LLMReranker must not use completeStructured');
      },
    };

    await new LLMReranker({ llm }).score([{ question: 'q', candidateId: 'a', text: 't' }]);

    expect(seen).toEqual([0]);
  });

  it('omits an unparseable bucket so the caller falls back instead of ranking on invented scores', async () => {
    const llm = recordingLlm(['not json at all', '[0.4]']);
    const reranker = new LLMReranker({ llm });

    // The q1 bucket contributes nothing; only q2's position is filled. The array is
    // short, which `rerankHits` reads as a failure and answers with the input order.
    expect(await reranker.score([...PAIRS])).toEqual([0.4]);
  });

  it('propagates a provider error rather than degrading it to a zero score', async () => {
    const llm: LLM = {
      complete: async () => {
        throw new Error('provider exploded');
      },
      completeStructured: async () => {
        throw new Error('LLMReranker must not use completeStructured');
      },
    };

    await expect(
      new LLMReranker({ llm }).score([{ question: 'q', candidateId: 'a', text: 't' }]),
    ).rejects.toThrow(/provider exploded/);
  });

  it('sends each candidate text to the model exactly once per question', async () => {
    const llm = recordingLlm(['[0.9, 0.1]']);
    await new LLMReranker({ llm }).score([...PAIRS]);

    expect(llm.prompts[0]).toContain('alpha');
    expect(llm.prompts[0]).toContain('beta');
    expect(llm.prompts[0]).not.toContain('gamma');
  });
});
