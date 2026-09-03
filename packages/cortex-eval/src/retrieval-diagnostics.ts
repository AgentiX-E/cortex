/**
 * Retrieval-quality diagnostics for LongMemEval-style datasets. Before tuning an
 * abstention threshold by hand, measure the retrieval signal: for each answerable
 * question, retrieve the top-k turns via the shared retrieval implementation and
 * record whether a turn marked `has_answer` was actually recalled. The resulting
 * score distributions and recall@k make threshold selection a data-driven
 * decision. A separate determinism probe verifies the embedding provider returns
 * stable vectors across repeated calls.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';
import {
  sessionsToContext,
  turnText,
  type LongMemEvalInstance,
  type LongMemEvalTurn,
} from './datasets/longmemeval-loader.js';
import { retrieveTopK, retrieveTopKSessions } from './retrieval.js';

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

/**
 * Probe the embedding provider for determinism: embed each text twice and return
 * the maximum absolute element-wise difference across both runs. A value near
 * zero means the provider is deterministic; a large value means repeated calls
 * drift, which would confound retrieval scores.
 */
export async function checkEmbeddingDeterminism(
  embedding: EmbeddingModel,
  texts: string[],
): Promise<number> {
  let maxDiff = 0;
  for (const text of texts) {
    const [v1] = await embedding.embed([text]);
    const [v2] = await embedding.embed([text]);
    const a = v1 ?? new Float64Array(0);
    const b = v2 ?? new Float64Array(0);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
    }
  }
  return maxDiff;
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
    const sessions = inst.haystack_sessions ?? [];
    const dates = inst.haystack_dates;
    const context: string[] = [];
    const answerTexts = new Set<string>();
    for (let i = 0; i < sessions.length; i++) {
      const date = dates?.[i];
      for (const turn of sessions[i]!) {
        // The single-session path filters assistant turns before retrieval, so
        // an assistant turn is never a candidate and embedding it is pure cost.
        if (turn.role === 'assistant') {
          continue;
        }
        const text = turnText(turn, date);
        context.push(text);
        if (turn.has_answer === true) {
          answerTexts.add(text);
        }
      }
    }
    // Abstention questions have no evidence turn, so they carry no retrieval signal.
    if (answerTexts.size === 0) {
      continue;
    }
    answerable++;

    const hits = await retrieveTopK(embedding, inst.question, context, topK);
    const top1 = hits[0];
    const hitAt1 = top1 !== undefined && answerTexts.has(top1.text);
    const hitAtK = hits.some((h) => answerTexts.has(h.text));
    if (hitAt1) {
      recallAt1++;
    }
    if (hitAtK) {
      recallAt5++;
    }

    if (hitAt1) {
      hitScores.push(top1!.score);
    } else {
      // Answerable questions have non-empty context, so top-1 is always defined.
      missScores.push(top1!.score);
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

export type SessionRetrievalDiagnostic = {
  totalQuestions: number;
  answerableQuestions: number;
  /** Fraction of answerable questions whose answer session is the top-1 hit. */
  recallAt1: number;
  /** Fraction of answerable questions whose answer session is within the top-k hits. */
  recallAtK: number;
  hitScores: number[];
  missScores: number[];
  recommendedThreshold: number;
};

/**
 * Session-level recall diagnostics: for each answerable question, retrieve whole
 * sessions and record whether a session marked with `has_answer` was recalled.
 * This measures the retrieval signal that multi-session aggregation actually
 * relies on (whole-session evidence rather than isolated turns).
 */
export async function computeSessionRetrievalDiagnostics(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  topK = 5,
): Promise<SessionRetrievalDiagnostic> {
  const hitScores: number[] = [];
  const missScores: number[] = [];
  let answerable = 0;
  let recallAt1 = 0;
  let recallAtK = 0;

  for (const inst of instances) {
    // The multi-session path filters assistant turns before building the session
    // index, so the diagnostics must mirror that: an assistant turn is never a
    // retrieval candidate and its embedding is pure cost.
    const factSessions = (inst.haystack_sessions ?? []).map((session) =>
      session.filter((turn) => turn.role !== 'assistant'),
    );
    const sessions = sessionsToContext(factSessions, inst.haystack_dates);
    const answerSessionIndices = new Set<number>();
    for (let i = 0; i < factSessions.length; i++) {
      if (factSessions[i]!.some((turn) => turn.has_answer === true)) {
        answerSessionIndices.add(i);
      }
    }
    // Abstention questions have no evidence turn, so they carry no retrieval signal.
    if (answerSessionIndices.size === 0) {
      continue;
    }
    answerable++;

    const hits = await retrieveTopKSessions(embedding, inst.question, sessions, topK);
    const top1 = hits[0];
    const hitAt1 = top1 !== undefined && answerSessionIndices.has(top1.sessionIndex);
    const hitAtK = hits.some((h) => answerSessionIndices.has(h.sessionIndex));
    if (hitAt1) {
      recallAt1++;
    }
    if (hitAtK) {
      recallAtK++;
    }

    if (hitAt1) {
      hitScores.push(top1!.score);
    } else {
      // Answerable questions have non-empty sessions, so top-1 is always defined.
      missScores.push(top1!.score);
    }
  }

  const sortedHits = [...hitScores].sort((a, b) => a - b);
  return {
    totalQuestions: instances.length,
    answerableQuestions: answerable,
    recallAt1: answerable === 0 ? 0 : recallAt1 / answerable,
    recallAtK: answerable === 0 ? 0 : recallAtK / answerable,
    hitScores: sortedHits,
    missScores: [...missScores].sort((a, b) => a - b),
    recommendedThreshold: percentile(sortedHits, 0.25),
  };
}
