/**
 * Retrieval recall curve (roadmap measure B2).
 *
 * The pre-existing diagnostics report recall@1 and recall@5. That pair cannot
 * answer the question that actually decides retrieval work, because the two
 * effects a retrieval change can have are indistinguishable at a single cutoff:
 *
 *   1. **Recall improves** — the evidence turn was never in the pool and is now.
 *   2. **Ordering improves** — the evidence was always in the pool but ranked
 *      too low to be admitted.
 *
 * Only (1) is a retrieval-breadth problem, and only (2) is a reranking problem.
 * This module separates them by measuring, at each cutoff k:
 *
 *   - `recall`   — the fraction whose answer the bi-encoder's own top-k contains
 *   - `ceiling`  — the fraction whose answer is anywhere in the pool of width
 *                  `poolWidth`, i.e. the best a perfect reranker could achieve
 *   - `gain`     — `ceiling - recall`: the recall a reranker could add by
 *                  reordering alone, with no new retrieval
 *
 * Two consequences that make this the right instrument:
 *
 *   - Where `ceiling` saturates is where widening the pool stops paying. Past
 *     that k, extra candidates are cost with no recall to show for it.
 *   - Where `gain` is large, reranking is the bottleneck and breadth is not.
 *
 * Pure and synchronous: the caller supplies the rank of each question's first
 * answer turn, so this is arithmetic over an existing retrieval, not a second
 * retrieval pass.
 *
 * `computeRecallCurve` is the measurement half: it performs that retrieval at a
 * configured pool width using the same implementation the graded path uses.
 */
import type { EmbeddingModel, LLM } from '@agentix-e/cortex-core';
import { turnText, type LongMemEvalInstance } from './datasets/longmemeval-loader.js';
import { retrieveTopKByQueries } from './retrieval.js';
import { buildQueryExpansionPrompt } from './natural-language-memory.js';
import { expandDiagnosticQueries } from './retrieval-diagnostics.js';

/** The first-answer rank per question, or null when retrieval never found it. */
export type QuestionRank = {
  /**
   * Zero-based rank of the highest-ranked turn marked `has_answer`, or null if
   * no answer turn was retrieved at all. Zero-based so rank 0 is the top-1 hit
   * and `rank < k` is the cutoff test with no off-by-one.
   */
  rankOfFirstAnswer: number | null;
};

export type RecallCurveOptions = {
  /**
   * Width of the candidate pool the ranks were measured against. Defaults to
   * the widest requested cutoff.
   *
   * This must be the pool the retrieval ACTUALLY fetched, not the context
   * width: an answer at rank 30 only counts toward the ceiling if the retrieval
   * really returned 30 candidates.
   */
  poolWidth?: number;
};

export type RecallCurvePoint = {
  /** The cutoff, in candidates. */
  k: number;
  /** Questions whose first answer turn ranks below `k`. */
  recalled: number;
  /** `recalled / total`, or 0 when there are no questions. */
  recall: number;
  /** Best achievable recall if the pool were perfectly reordered. */
  ceiling: number;
  /** `ceiling - recall`, clamped at 0; the recall a reranker could unlock. */
  gain: number;
};

/**
 * Build the recall curve over the requested cutoffs.
 *
 * Cutoffs are sorted, de-duplicated, and filtered to positive integers, so the
 * caller may pass a set and get a monotone curve back.
 */
export function buildRecallCurve(
  ranks: readonly QuestionRank[],
  cutoffs: readonly number[],
  options: RecallCurveOptions = {},
): RecallCurvePoint[] {
  const ks = [...new Set(cutoffs.filter((k) => Number.isInteger(k) && k > 0))].sort(
    (a, b) => a - b,
  );
  if (ks.length === 0) {
    return [];
  }
  const poolWidth = options.poolWidth ?? ks[ks.length - 1]!;
  const total = ranks.length;
  const inPool = ranks.filter(
    (r) => r.rankOfFirstAnswer !== null && r.rankOfFirstAnswer < poolWidth,
  ).length;
  const ceiling = total === 0 ? 0 : inPool / total;

  return ks.map((k) => {
    const recalled = ranks.filter(
      (r) => r.rankOfFirstAnswer !== null && r.rankOfFirstAnswer < k,
    ).length;
    const recall = total === 0 ? 0 : recalled / total;
    return {
      k,
      recalled,
      recall,
      ceiling,
      // Clamped at 0 on purpose. When `poolWidth` is narrower than a requested
      // cutoff, achieved recall can exceed the pool ceiling; a negative gain
      // would read as "reranking hurts", when the truth is "the pool is too
      // narrow to say anything".
      gain: Math.max(0, ceiling - recall),
    };
  });
}

/** The minimum a hit must expose to be matched against the answer set. */
type TextualHit = { text: string };

/**
 * Zero-based rank of the highest-ranked hit whose text is an answer turn.
 *
 * Returns null when the answer set is empty. That case is not a detail: an
 * abstention question has no `has_answer` turn, and treating "no answer to find"
 * as "found at rank 0" would score every such question as perfect retrieval and
 * inflate every point on the curve.
 */
export function rankOfFirstAnswer(
  hits: readonly TextualHit[],
  answerTexts: ReadonlySet<string>,
): number | null {
  if (answerTexts.size === 0) {
    return null;
  }
  for (let i = 0; i < hits.length; i++) {
    if (answerTexts.has(hits[i]!.text)) {
      return i;
    }
  }
  return null;
}

/** Default cutoffs: dense near the top, then the usual pool widths. */
export const DEFAULT_CURVE_CUTOFFS = [1, 3, 5, 10, 20, 50] as const;

export type RecallCurveMeasurementOptions = {
  /**
   * Optional LLM for query expansion. The graded path expands queries, so a
   * diagnostic without expansion measures a DIFFERENT retrieval and would
   * misstate the ceiling. Omit only for a cheaper bare-question probe.
   */
  llm?: LLM;
  /** Cutoffs to report. Defaults to a curve spanning the usual pool choices. */
  cutoffs?: readonly number[];
  /** Pool width actually fetched; defaults to the widest cutoff. */
  poolWidth?: number;
};

/**
 * Measure the recall curve over a LongMemEval-style dataset.
 *
 * One retrieval pass per answerable question, at `poolWidth` depth, using the
 * same retrieval implementation the graded path uses. Questions with no answer
 * turn (abstention) are skipped: they carry no retrieval signal and would
 * otherwise be scored as misses, dragging every cutoff down by their share.
 *
 * This is the instrument B2 needs. Deciding a pool width from recall@1 and
 * recall@5 alone is a guess; deciding it from the point where `gain` reaches
 * zero and `ceiling` stops climbing is a measurement.
 */
export async function computeRecallCurve(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  options: RecallCurveMeasurementOptions = {},
): Promise<RecallCurvePoint[]> {
  const cutoffs = [...(options.cutoffs ?? DEFAULT_CURVE_CUTOFFS)];
  const poolWidth = options.poolWidth ?? Math.max(...cutoffs);
  const ranks: QuestionRank[] = [];

  for (const inst of instances) {
    const sessions = inst.haystack_sessions ?? [];
    const dates = inst.haystack_dates;
    const context: string[] = [];
    const answerTexts = new Set<string>();
    for (let i = 0; i < sessions.length; i++) {
      const date = dates?.[i];
      for (const turn of sessions[i]!) {
        // Mirrors the graded path, which filters assistant turns before
        // retrieval: an assistant turn is never a candidate, so embedding one
        // would both cost and distort the rank.
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
    if (answerTexts.size === 0 || context.length === 0) {
      continue;
    }

    const queries = [
      inst.question,
      ...(await expandDiagnosticQueries(options.llm, inst.question, buildQueryExpansionPrompt)),
    ];
    const hits = await retrieveTopKByQueries(embedding, queries, context, poolWidth);
    ranks.push({ rankOfFirstAnswer: rankOfFirstAnswer(hits, answerTexts) });
  }

  return buildRecallCurve(ranks, cutoffs, { poolWidth });
}
