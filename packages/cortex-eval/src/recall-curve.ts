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
 * configured pool width using the same implementation the graded path uses. It
 * returns the curve together with the questions it left out and the reason for
 * each, because a denominator that shrinks without saying so is a silent
 * measurement loss — see `computeRecallCurve` for the measurement that exposed
 * exactly that.
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
 * Why a question was left out of the curve.
 *
 * These are three distinct situations that the shape of a `has_answer` scan
 * cannot tell apart at the place where the exclusion happens — all three present
 * as "this question contributed no answer text". They differ in whether the
 * exclusion is *intended*:
 *
 *   - `abstention`  — the question's correct answer is to refuse, so there is
 *                     nothing to retrieve. Excluding it is the point.
 *   - `derived`     — the question is answerable but its answer is an
 *                     aggregation or a value computed from the evidence
 *                     ("four", "25 minutes and 50 seconds"), so no single turn
 *                     carries it verbatim. Excluding it removes a real
 *                     answerable question from the denominator.
 *   - `no-flag`     — the question is answerable but the dataset never raised
 *                     `has_answer` on any turn. This is a data or loader
 *                     problem, and the exclusion is a silent measurement loss.
 *
 * Reporting only a count makes all three look identical, which is how a
 * 500-question run produced a curve over 428 questions with nothing in the
 * artifact saying so.
 */
export type RecallCurveExclusion = {
  /** The question's id, so the excluded set is nameable and re-checkable. */
  questionId: string;
  /** Which of the three situations this is. */
  reason: 'abstention' | 'derived' | 'no-flag';
};

export type RecallCurveResult = {
  /** The curve itself, one point per cutoff. */
  points: RecallCurvePoint[];
  /** Questions the curve was computed over. */
  considered: number;
  /** Questions left out, with the reason, so the denominator is auditable. */
  excluded: RecallCurveExclusion[];
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
 *
 * An empty answer set is not *always* an abstention question, though. The
 * caller cannot tell the difference from here, so it must not assume — see
 * `classifyExclusion` for the three situations and why the distinction matters.
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
 * Classify a question that produced no answer text.
 *
 * The order of the tests encodes the priority: an abstention question is
 * *supposed* to have no evidence turn, so it is checked first and never
 * mislabelled as a data problem. Only after that does "has no answer text"
 * become evidence of something being wrong.
 *
 * `question_id` is optional on the input type (callers measure over instances
 * assembled from several sources, and the abstention marker lives in the id), so
 * a missing id is reported as an empty string rather than throwing. An
 * unnameable exclusion is still a shortfall a reader has to see.
 */
export function classifyExclusion(
  inst: LongMemEvalInstance,
  hadContext: boolean,
): RecallCurveExclusion | null {
  if (!hadContext) {
    return null;
  }
  const id = inst.question_id ?? '';
  // An abstention question's expected answer is null and its id carries `_abs`.
  // Calling it `derived` would be wrong twice over: it is not answerable at all,
  // and its exclusion needs no fix.
  if (id.endsWith('_abs')) {
    return { questionId: id, reason: 'abstention' };
  }
  // Answerable, flagged turns exist somewhere, but none matched the joined
  // text. The grader can still answer this from the derived value, so this is
  // the "real question silently dropped" case.
  if (hasFlaggedTurn(inst)) {
    return { questionId: id, reason: 'derived' };
  }
  return { questionId: id, reason: 'no-flag' };
}

/** Whether any turn in the instance is flagged `has_answer`. */
function hasFlaggedTurn(inst: LongMemEvalInstance): boolean {
  for (const session of inst.haystack_sessions ?? []) {
    for (const turn of session) {
      if (turn.has_answer === true) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Measure the recall curve over a LongMemEval-style dataset.
 *
 * One retrieval pass per answerable question, at `poolWidth` depth, using the
 * same retrieval implementation the graded path uses.
 *
 * ## What gets excluded, and why the caller is told
 *
 * A question contributes no answer text in three different situations, and they
 * are not the same kind of event: an abstention question *should* have no
 * evidence turn, an aggregation question is answerable but has no turn carrying
 * its answer verbatim, and a question whose turns were never flagged is a data
 * problem. All three reach this function as "no answer text".
 *
 * This function used to `continue` on all three and return only the curve, so
 * the denominator silently shrank and the artifact said nothing. A 500-question
 * run produced a curve over 428 questions — the 72 missing were answerable KU
 * questions whose answers are derived values — and the only place the number
 * appeared was as an `n=` in the console line. Anyone reading
 * `benchmark-recall-curve.json` would compare its `ceiling` against an accuracy
 * measured over 500 and be comparing two different populations.
 *
 * The result therefore carries `excluded` with a per-question reason, and the
 * curve's `ceiling`/`recall` are stated against `considered`, not against the
 * input length. Reporting the shortfall is the fix: the exclusion may be
 * correct, but it may not be invisible.
 */
export async function computeRecallCurve(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  options: RecallCurveMeasurementOptions = {},
): Promise<RecallCurveResult> {
  const cutoffs = [...(options.cutoffs ?? DEFAULT_CURVE_CUTOFFS)];
  const poolWidth = options.poolWidth ?? Math.max(...cutoffs);
  const ranks: QuestionRank[] = [];
  const excluded: RecallCurveExclusion[] = [];

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
      const reason = classifyExclusion(inst, context.length > 0);
      if (reason) {
        excluded.push(reason);
      }
      continue;
    }

    const queries = [
      inst.question,
      ...(await expandDiagnosticQueries(options.llm, inst.question, buildQueryExpansionPrompt)),
    ];
    const hits = await retrieveTopKByQueries(embedding, queries, context, poolWidth);
    ranks.push({ rankOfFirstAnswer: rankOfFirstAnswer(hits, answerTexts) });
  }

  return {
    points: buildRecallCurve(ranks, cutoffs, { poolWidth }),
    considered: ranks.length,
    excluded,
  };
}
