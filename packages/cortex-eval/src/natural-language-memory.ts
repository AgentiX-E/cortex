/**
 * A natural-language retrieval-augmented QA memory system for LongMemEval-style
 * benchmarks. It retrieves the most relevant conversational turns by embedding
 * similarity, generates an answer with an LLM grounded in the retrieved context,
 * and abstains either when retrieval confidence is too low or when the LLM
 * reports the answer is absent from the context.
 *
 * Retrieval and embedding are delegated to the shared `retrieval.ts` module so
 * the system and the diagnostics harness use identical logic.
 */
import type { EmbeddingModel, LLM } from '@agentix-e/cortex-core';
import type { Answer, SessionAwareMemorySystem } from './types.js';
import {
  expandContextWindow,
  retrieveByQueries,
  retrieveTopK,
  retrieveTopKSessions,
  type SessionHit,
} from './retrieval.js';

export { clearEmbeddingCache } from './retrieval.js';

export type AbstainReason = 'empty' | 'threshold' | 'llm' | 'answered';

export type DecisionTrace = {
  question: string;
  top1Score: number;
  abstained: boolean;
  reason: AbstainReason;
  /** Context actually injected into the LLM (empty when abstained pre-LLM). */
  retrieved?: string;
  /** Raw LLM response (undefined when the LLM was not called). */
  llmRaw?: string;
  /** Final answer returned to the benchmark. */
  answer?: Answer;
  /** Query-expansion phrases used for targeted session recall (MR only). */
  expansionQueries?: string[];
};

export type NaturalLanguageMemorySystemOptions = {
  embedding: EmbeddingModel;
  llm: LLM;
  /** Number of retrieved turns passed to the LLM (default 15). */
  topK?: number;
  /** Number of retrieved sessions passed to the LLM in session mode (default 10). */
  sessionTopK?: number;
  /** Number of neighbouring turns to include around each turn hit (default 1). */
  contextRadius?: number;
  /** Per-session character budget when aggregating sessions (default 2000). */
  maxSessionChars?: number;
  /** When true, expand the question into concrete phrases before MR recall (default true). */
  enableQueryExpansion?: boolean;
  /** Top sessions recalled per expansion phrase (default 3). */
  queryExpansionTopKPerQuery?: number;
  /** Abstain before calling the LLM when the best similarity is below this value. */
  abstainThreshold?: number;
  /** The LLM's abstention marker (default UNANSWERABLE). */
  abstainToken?: string;
  /** When false, the system never abstains (baseline behavior); default true. */
  enableAbstention?: boolean;
  /** LLM sampling temperature; default 0 for deterministic evaluation. */
  temperature?: number;
  /** Optional callback for per-question decision tracing (diagnostic). */
  onDecision?: (trace: DecisionTrace) => void;
};

const DEFAULT_ABSTAIN_TOKEN = 'UNANSWERABLE';
const DEFAULT_TEMPERATURE = 0;
const DEFAULT_TOP_K = 15;
const DEFAULT_SESSION_TOP_K = 10;
const DEFAULT_CONTEXT_RADIUS = 1;
const DEFAULT_MAX_SESSION_CHARS = 2000;
const DEFAULT_QUERY_EXPANSION_TOP_K = 3;

type PromptBuilder = (question: string, context: string, abstainToken?: string) => string;

export class NaturalLanguageMemorySystem implements SessionAwareMemorySystem {
  readonly name: string;
  private readonly options: NaturalLanguageMemorySystemOptions;

  constructor(name: string, options: NaturalLanguageMemorySystemOptions) {
    this.name = name;
    this.options = options;
  }

  /** Turn-level answering for the flattened `MemorySystem.answer` contract. */
  async answer(question: string, context: string[]): Promise<Answer> {
    const topK = this.options.topK ?? DEFAULT_TOP_K;
    const hits = await retrieveTopK(this.options.embedding, question, context, topK);
    const retrieved =
      hits.length === 0
        ? ''
        : expandContextWindow(
            context,
            hits.map((h) => h.index),
            this.options.contextRadius ?? DEFAULT_CONTEXT_RADIUS,
          );
    return this.respondWith(question, hits[0]?.score ?? 0, retrieved, buildQaPrompt);
  }

  /**
   * Multi-session aggregation answering: expand the abstract question into
   * concrete retrieval phrases, recall evidence sessions for both the question
   * and each phrase, then inject their (bounded) content so the LLM can aggregate
   * evidence spread across sessions.
   */
  async answerSessions(question: string, sessions: string[][]): Promise<Answer> {
    const { hits, expansionQueries } = await this.retrieveSessionsForQuestion(question, sessions);
    const maxChars = this.options.maxSessionChars ?? DEFAULT_MAX_SESSION_CHARS;
    const retrieved = hits.map((h) => truncateText(h.text, maxChars)).join('\n\n');
    // Threshold on the top-1 session score keeps abstention consistent across
    // the turn-level and session-level paths.
    return this.respondWith(
      question,
      hits[0]?.score ?? 0,
      retrieved,
      buildAggregationQaPrompt,
      expansionQueries,
    );
  }

  private async retrieveSessionsForQuestion(
    question: string,
    sessions: string[][],
  ): Promise<{ hits: SessionHit[]; expansionQueries: string[] }> {
    const sessionTopK = this.options.sessionTopK ?? DEFAULT_SESSION_TOP_K;
    const baseHits = await retrieveTopKSessions(
      this.options.embedding,
      question,
      sessions,
      sessionTopK,
    );

    if (this.options.enableQueryExpansion === false) {
      return { hits: baseHits, expansionQueries: [] };
    }

    const expansionPrompt = buildQueryExpansionPrompt(question);
    const expansionRaw = await this.options.llm.complete(expansionPrompt, {
      temperature: this.options.temperature ?? DEFAULT_TEMPERATURE,
    });
    const expansionQueries = parseQueryExpansion(expansionRaw);
    if (expansionQueries.length === 0) {
      return { hits: baseHits, expansionQueries: [] };
    }

    const perQueryK = this.options.queryExpansionTopKPerQuery ?? DEFAULT_QUERY_EXPANSION_TOP_K;
    const expandedHits = await retrieveByQueries(
      this.options.embedding,
      expansionQueries,
      sessions,
      perQueryK,
    );

    // Merge base and expanded hits, keeping the highest score per session.
    const merged = new Map<string, SessionHit>();
    for (const hit of [...baseHits, ...expandedHits]) {
      const existing = merged.get(hit.id);
      if (!existing || hit.score > existing.score) {
        merged.set(hit.id, hit);
      }
    }
    return {
      hits: [...merged.values()].sort((a, b) => b.score - a.score),
      expansionQueries,
    };
  }

  private async respondWith(
    question: string,
    top1Score: number,
    retrieved: string,
    promptBuilder: PromptBuilder,
    expansionQueries: string[] = [],
  ): Promise<Answer> {
    const abstentionEnabled = this.options.enableAbstention !== false;
    if (retrieved === '') {
      const answer = abstentionEnabled ? null : 'unknown';
      this.emitTrace(question, 0, answer === null, 'empty', {
        retrieved,
        answer,
        expansionQueries,
      });
      return answer;
    }
    if (
      abstentionEnabled &&
      this.options.abstainThreshold != null &&
      top1Score < this.options.abstainThreshold
    ) {
      this.emitTrace(question, top1Score, true, 'threshold', {
        retrieved,
        answer: null,
        expansionQueries,
      });
      return null;
    }

    const prompt = promptBuilder(question, retrieved, this.options.abstainToken);
    const raw = await this.options.llm.complete(prompt, {
      temperature: this.options.temperature ?? DEFAULT_TEMPERATURE,
    });
    const parsed = parseQaAnswer(raw, this.options.abstainToken);
    if (parsed === null) {
      if (!abstentionEnabled) {
        this.emitTrace(question, top1Score, false, 'answered', {
          retrieved,
          llmRaw: raw,
          answer: 'unknown',
          expansionQueries,
        });
        return 'unknown';
      }
      this.emitTrace(question, top1Score, true, 'llm', {
        retrieved,
        llmRaw: raw,
        answer: null,
        expansionQueries,
      });
      return null;
    }
    this.emitTrace(question, top1Score, false, 'answered', {
      retrieved,
      llmRaw: raw,
      answer: parsed,
      expansionQueries,
    });
    return parsed;
  }

  private emitTrace(
    question: string,
    top1Score: number,
    abstained: boolean,
    reason: AbstainReason,
    extra: {
      retrieved?: string;
      llmRaw?: string;
      answer?: Answer;
      expansionQueries?: string[];
    },
  ): void {
    this.options.onDecision?.({ question, top1Score, abstained, reason, ...extra });
  }
}

/** Build a grounded QA prompt with an explicit abstention instruction. */
export function buildQaPrompt(
  question: string,
  context: string,
  abstainToken: string = DEFAULT_ABSTAIN_TOKEN,
): string {
  return [
    'You are answering questions based on a conversation memory.',
    'Read the context carefully and extract the answer to the question.',
    'Answer with ONLY the answer phrase (a word, name, number, or short phrase), with no explanation.',
    `Respond with exactly "${abstainToken}" ONLY if the context contains no relevant information at all.`,
    '',
    'Context:',
    context,
    '',
    `Question: ${question}`,
    '',
    'Answer:',
  ].join('\n');
}

/**
 * Build a multi-session aggregation prompt. Unlike single-session extraction,
 * this instructs the LLM to combine evidence across sessions, deduplicate, and
 * compute a final count/list, which is what LongMemEval multi-session questions
 * require.
 */
export function buildAggregationQaPrompt(
  question: string,
  context: string,
  abstainToken: string = DEFAULT_ABSTAIN_TOKEN,
): string {
  return [
    'You are answering a question based on MULTIPLE conversation sessions.',
    'The answer may require combining information spread across several sessions.',
    'Read ALL context carefully. Identify EVERY relevant item or event mentioned, remove duplicates, and compute the final answer.',
    'Answer with ONLY the final answer (a number, name, or short list), with no explanation.',
    `Respond with exactly "${abstainToken}" ONLY if the context contains no relevant information at all.`,
    '',
    'Context:',
    context,
    '',
    `Question: ${question}`,
    '',
    'Answer:',
  ].join('\n');
}

/** Bound a session's length so aggregation injects signal without overflowing. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n[truncated]`;
}

/**
 * Build a query-expansion prompt that asks the LLM to turn an abstract question
 * into the concrete phrases whose mention would be evidence for the answer. The
 * expanded phrases are used for targeted recall of dispersed evidence sessions.
 */
export function buildQueryExpansionPrompt(question: string): string {
  return [
    'You are helping retrieve evidence from a conversation memory.',
    'Given a question, list the concrete phrases or entities whose mention would be evidence for the answer.',
    'Output ONLY a comma-separated list of short phrases, with no explanation and no numbering.',
    '',
    `Question: ${question}`,
    '',
    'Phrases:',
  ].join('\n');
}

/** Parse a comma/newline/semicolon-separated list of phrases into a clean list. */
export function parseQueryExpansion(raw: string): string[] {
  return raw
    .split(/[,;\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Parse the LLM response; returns null when it abstains or returns empty. */
export function parseQaAnswer(raw: string, abstainToken: string = DEFAULT_ABSTAIN_TOKEN): Answer {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toUpperCase() === abstainToken.toUpperCase()) {
    return null;
  }
  return trimmed.replace(/^["']+|["']+$/g, '');
}
