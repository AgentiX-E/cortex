/**
 * Retrieval-quality diagnostics for LongMemEval-style datasets. Before tuning an
 * abstention threshold by hand, measure the retrieval signal: for each answerable
 * question, embed the query and every turn, retrieve the top-k, and record
 * whether a turn marked `has_answer` was actually recalled. The resulting score
 * distributions and recall@k make threshold selection a data-driven decision.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';
import { cosineSimilarity } from '@agentix-e/cortex-core';
import type { LongMemEvalInstance, LongMemEvalTurn } from './datasets/longmemeval-loader.js';

/** Zhipu embedding-3 accepts at most 64 inputs per request. */
const EMBED_BATCH = 64;

export type RetrievalDiagnostic = {
  totalQuestions: number;
  answerableQuestions: number;
  /** Fraction of answerable questions whose answer turn is the top-1 hit. */
  recallAt1: number;
  /** Fraction of answerable questions whose answer turn is within the top-k hits. */
  recallAt5: number;
  /** Top-1 cosine scores for questions whose answer turn was recalled (ascending). */
  hitScores: number[];
  /** Top-1 cosine scores for questions whose answer turn was missed (ascending). */
  missScores: number[];
  /** A data-driven abstention threshold: the 25th percentile of hit scores. */
  recommendedThreshold: number;
};

/** Flatten all sessions into a single ordered turn list, preserving `has_answer`. */
export function flattenTurns(sessions?: LongMemEvalTurn[][]): LongMemEvalTurn[] {
  const out: LongMemEvalTurn[] = [];
  for (const session of sessions ?? []) {
    for (const turn of session) {
      out.push(turn);
    }
  }
  return out;
}

/** The nearest-rank value at percentile `p` of an already-sorted numeric array. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1));
  return sorted[idx]!;
}

async function embedAll(embedding: EmbeddingModel, texts: string[]): Promise<Float64Array[]> {
  const result: Float64Array[] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const chunk = texts.slice(start, start + EMBED_BATCH);
    result.push(...(await embedding.embed(chunk)));
  }
  return result;
}

/** Compute retrieval recall and score distributions over answerable questions. */
export async function computeRetrievalDiagnostics(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  topK = 5,
): Promise<RetrievalDiagnostic> {
  const hitScores: number[] = [];
  const missScores: number[] = [];
  let answerable = 0;
  let recallAt1 = 0;
  let recallAt5 = 0;

  for (const inst of instances) {
    const turns = flattenTurns(inst.haystack_sessions);
    const answerIndices: number[] = [];
    for (let i = 0; i < turns.length; i++) {
      if (turns[i]!.has_answer === true) {
        answerIndices.push(i);
      }
    }
    // Abstention questions have no evidence turn, so they carry no retrieval signal.
    if (answerIndices.length === 0) {
      continue;
    }
    answerable++;

    const [queryVec] = await embedding.embed([inst.question]);
    const turnTexts = turns.map((t) => `${t.role}: ${t.content}`);
    const turnVecs = await embedAll(embedding, turnTexts);

    const scored = turns.map((_, i) => ({
      idx: i,
      score: cosineSimilarity(queryVec!, turnVecs[i]!),
    }));
    scored.sort((a, b) => b.score - a.score);

    const top1Idx = scored[0]!.idx;
    const topKIdxs = scored.slice(0, topK).map((s) => s.idx);
    const hitAt1 = answerIndices.includes(top1Idx);
    const hitAtK = topKIdxs.some((idx) => answerIndices.includes(idx));
    if (hitAt1) {
      recallAt1++;
    }
    if (hitAtK) {
      recallAt5++;
    }

    if (hitAt1) {
      hitScores.push(scored[0]!.score);
    } else {
      missScores.push(scored[0]!.score);
    }
  }

  const sortedHits = [...hitScores].sort((a, b) => a - b);
  return {
    totalQuestions: instances.length,
    answerableQuestions: answerable,
    recallAt1: answerable === 0 ? 0 : recallAt1 / answerable,
    recallAt5: answerable === 0 ? 0 : recallAt5 / answerable,
    hitScores: sortedHits,
    missScores: [...missScores].sort((a, b) => a - b),
    recommendedThreshold: percentile(sortedHits, 0.25),
  };
}
