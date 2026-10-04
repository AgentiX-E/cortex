/**
 * Retrieval-quality diagnostics for LongMemEval-style datasets. Before tuning an
 * abstention threshold by hand, measure the retrieval signal: for each answerable
 * question, retrieve the top-k turns via the shared retrieval implementation and
 * record whether a turn marked `has_answer` was actually recalled. The resulting
 * score distributions and recall@k make threshold selection a data-driven
 * decision. A separate determinism probe verifies the embedding provider returns
 * stable vectors across repeated calls.
 

 *
 * ## Module-private exports
 *
 * Some declarations below are deliberately not exported. They are used only inside
 * this file, appear in no package barrel, and are referenced by no test or tool —
 * so `export` would advertise a consumer that does not exist. The `export-census`
 * tool reports them as `referenced-locally`, and
 * `packages/cortex-eval/src/__tests__/export-surface.test.ts` pins the set from both
 * sides. Restoring an `export` is a deliberate act: add it when a real caller
 * appears, not in advance of one.
*/
import type { EmbeddingModel, LLM } from '@agentix-e/cortex-core';
import {
  sessionsToContext,
  turnText,
  type LongMemEvalInstance,
  type LongMemEvalTurn,
} from './datasets/longmemeval-loader.js';
import {
  retrieveTopKByQueries,
  retrieveTopKSessions,
  retrieveByQueries,
  type SessionHit,
} from './retrieval.js';
import {
  buildQueryExpansionPrompt,
  buildMultiSessionQueryExpansionPrompt,
  parseQueryExpansion,
} from './natural-language-memory.js';

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
 * Result of the embedding determinism probe.
 *
 * `dimension` travels with `maxAbsDiff` because a drift of zero is only a fact
 * about an embedding of a known width. The audit's §6 finding was that the
 * artifact carried `embeddingMaxAbsDiff: 0` with no field identifying the
 * provider, model, or dimension — and a reader comparing two such artifacts
 * cannot tell a 1024-dimension Zhipu run from a 256-dimension hash-fallback run,
 * because both are deterministic and both read `0`. Reporting the width here is
 * what makes the number interpretable next to the provenance block, and reading
 * it off the vectors rather than from the configured value is what makes it
 * evidence of what the provider actually returned rather than of what was asked
 * for.
 */
export type EmbeddingDeterminism = {
  /** Maximum absolute element-wise difference between two embeddings of one text. */
  maxAbsDiff: number;
  /** Width of the vectors the provider returned. */
  dimension: number;
};

/**
 * Probe the embedding provider for determinism: embed each text twice and report
 * the maximum absolute element-wise difference across both runs, plus the width
 * of the vectors returned. A `maxAbsDiff` near zero means the provider is
 * deterministic; a large value means repeated calls drift, which would confound
 * retrieval scores.
 */
export async function checkEmbeddingDeterminism(
  embedding: EmbeddingModel,
  texts: string[],
): Promise<EmbeddingDeterminism> {
  let maxDiff = 0;
  let dimension = 0;
  for (const text of texts) {
    const [v1] = await embedding.embed([text]);
    const [v2] = await embedding.embed([text]);
    const a = v1 ?? new Float64Array(0);
    const b = v2 ?? new Float64Array(0);
    dimension = Math.max(dimension, a.length, b.length);
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      maxDiff = Math.max(maxDiff, Math.abs(a[i]! - b[i]!));
    }
  }
  return { maxAbsDiff: maxDiff, dimension };
}

/** Options controlling how the recall diagnostics perform retrieval. */
type RetrievalDiagnosticOptions = {
  /**
   * LLM used to expand the question into concrete retrieval phrases. When
   * present, the diagnostics mirror the production expanded-query retrieval
   * (recall over dispersed evidence is the recall the system actually achieves);
   * when absent, only the bare question is searched.
   */
  llm?: LLM;
};

/**
 * Expand a question into retrieval phrases via the LLM, or [] without one.
 *
 * Exported because the recall curve (`recall-curve.ts`) must expand queries the
 * same way this module does: a diagnostic that measured bare-question retrieval
 * while the graded path expands would report a ceiling for a different pipeline.
 * Sharing the helper is what keeps the two measurements comparable.
 */
export async function expandDiagnosticQueries(
  llm: LLM | undefined,
  question: string,
  promptBuilder: (question: string) => string,
): Promise<string[]> {
  if (!llm) {
    return [];
  }
  const raw = await llm.complete(promptBuilder(question), { temperature: 0 });
  return parseQueryExpansion(raw);
}

/** Compute retrieval recall and score distributions over answerable questions. */
export async function computeRetrievalDiagnostics(
  instances: readonly LongMemEvalInstance[],
  embedding: EmbeddingModel,
  topK = 5,
  options: RetrievalDiagnosticOptions = {},
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
      // `dates === undefined ? undefined : dates[i]` rather than `dates?.[i]`.
      // Identical semantics, but the optional-chain spelling is invisible to the
      // v8 coverage provider: it emits a single sub-range for `a?.[i]` -- the
      // receiver, not the guard -- so the branch Istanbul derives from it carries
      // one location and never increments. Measured two ways: on a synthetic
      // `a?.[i]` that was called with both a defined and an undefined receiver,
      // v8 still reported exactly one sub-range (whereas the sibling `a?.b` and a
      // plain ternary both reported two); and on this very line, a dateless
      // instance produced the prefix-free context text, proving the undefined
      // path runs while its count stayed at zero.
      //
      // The explicit ternary also matches how the dateless case is reasoned about
      // below, where "there is no date for this session" is a thing the code means
      // rather than a null-safety reflex.
      const date = dates === undefined ? undefined : dates[i];
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

    const queries = [
      inst.question,
      ...(await expandDiagnosticQueries(options.llm, inst.question, buildQueryExpansionPrompt)),
    ];
    const hits = await retrieveTopKByQueries(embedding, queries, context, topK);
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
  options: RetrievalDiagnosticOptions = {},
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

    const baseHits = await retrieveTopKSessions(embedding, inst.question, sessions, topK);
    const expansionQueries = await expandDiagnosticQueries(
      options.llm,
      inst.question,
      buildMultiSessionQueryExpansionPrompt,
    );
    const expandedHits =
      expansionQueries.length > 0
        ? await retrieveByQueries(embedding, expansionQueries, sessions, topK)
        : [];
    // Merge base and expanded hits by session id, keeping the highest score —
    // the same merge the production multi-session path performs.
    const merged = new Map<string, SessionHit>();
    for (const hit of [...baseHits, ...expandedHits]) {
      const existing = merged.get(hit.id);
      if (!existing || hit.score > existing.score) {
        merged.set(hit.id, hit);
      }
    }
    const hits = [...merged.values()].sort((a, b) => b.score - a.score);
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

/**
 * Which traffic the transport-retry counters in an artifact describe.
 *
 * `retryableFetch` is the single choke point for every remote call in the
 * workspace, so the process-level aggregate is deliberately shared: it cannot
 * attribute a retry to the embedding backend rather than the LLM after the fact,
 * because both pass through the same loop. Naming the caller's intent here is the
 * honest alternative to inventing a per-provider breakdown that does not exist.
 * An artifact that presents the shared total as the embedding's alone would be
 * reporting a number it cannot substantiate.
 */
export type TransportRetryScope = {
  provider: 'embedding' | 'llm';
};

/**
 * The transport-retry counters as they appear in `benchmark-diagnostics.json`.
 *
 * `scope` is always `'process'`: see {@link TransportRetryScope} for why a
 * per-provider split is unavailable rather than simply unrequested. `provider`
 * records what the section is being read for, so a reader can tell the embedding
 * section's counters from any future LLM section's.
 */
export type TransportRetryReport = TransportRetrySnapshot & {
  provider: TransportRetryScope['provider'];
  scope: 'process';
};

/** The counter fields, restated here so the artifact's shape is visible in one place. */
type TransportRetrySnapshot = {
  /** Remote requests actually issued, including the first attempt of each call. */
  attempts: number;
  /** Retries actually performed. */
  retried: number;
  /** Attempts answered with HTTP 429. */
  rateLimited: number;
  /** Retries whose delay came from a `Retry-After` header. */
  retryAfterHonoured: number;
  /** Calls made. */
  calls: number;
  /** Calls that retried at least once. */
  retriedCalls: number;
  /** Calls that never retried. */
  cleanCalls: number;
  /** `retriedCalls / calls` -- per call, never per retry. */
  retryRate: number;
};

/**
 * Format a transport-retry snapshot for inclusion in a report.
 *
 * Takes a **snapshot**, not the aggregate. The process-level aggregate is
 * reachable only through `retryStats()` in `cortex-llm`, and this function pairs
 * with it: passing the snapshot keeps the counter's write path (`record()`) out
 * of every caller that only needs to read, so a reporter cannot accidentally
 * contribute to the numbers it is describing.
 *
 * The function is pure. Adding a snapshot to an artifact must not change what the
 * next snapshot reads, or a run that writes two reports would describe the second
 * with the first's readings folded in.
 */
export function transportRetryReport(
  snapshot: TransportRetrySnapshot,
  scope: TransportRetryScope,
): TransportRetryReport {
  return {
    provider: scope.provider,
    scope: 'process',
    attempts: snapshot.attempts,
    retried: snapshot.retried,
    rateLimited: snapshot.rateLimited,
    retryAfterHonoured: snapshot.retryAfterHonoured,
    calls: snapshot.calls,
    retriedCalls: snapshot.retriedCalls,
    cleanCalls: snapshot.cleanCalls,
    retryRate: snapshot.retryRate,
  };
}

/**
 * Renders the first few ids of a population for a log line.
 *
 * Truncation is stated, not implied. `… +241 more` tells a reader that the
 * artifact holds a longer list; a bare five-element preview would let someone
 * conclude the population is five questions when the count printed one line
 * above says 270. The artifact carries the full list either way -- this is the
 * copy for whoever is watching the run, not the record.
 *
 * It lives here rather than beside its caller because `bench/**` is excluded
 * from coverage as a CLI entry point, and this has three branches worth testing:
 * an empty population, one that exactly fills the preview, and one that
 * overflows. The middle branch is the one that matters -- `<= limit` and
 * `< limit` differ only there, and the wrong one appends `… +0 more`, a line
 * claiming there is more to see when there is not.
 */
export function formatIdPreview(ids: readonly string[], limit = 5): string {
  if (ids.length === 0) {
    return '(none)';
  }
  const shown = ids.slice(0, limit).join(', ');
  return ids.length <= limit ? shown : `${shown} … +${ids.length - limit} more`;
}
