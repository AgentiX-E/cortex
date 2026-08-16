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
import { expandContextWindow, retrieveTopK, retrieveTopKSessions } from './retrieval.js';

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
   * Multi-session aggregation answering: retrieve whole sessions and inject their
   * (bounded) content so the LLM can aggregate evidence spread across sessions.
   * Whole sessions are injected instead of turn-level focusing because aggregation
   * evidence is dispersed and turn-level focusing compresses it away.
   */
  async answerSessions(question: string, sessions: string[][]): Promise<Answer> {
    const sessionTopK = this.options.sessionTopK ?? DEFAULT_SESSION_TOP_K;
    const sessionHits = await retrieveTopKSessions(
      this.options.embedding,
      question,
      sessions,
      sessionTopK,
    );
    const maxChars = this.options.maxSessionChars ?? DEFAULT_MAX_SESSION_CHARS;
    const retrieved = sessionHits.map((h) => truncateText(h.text, maxChars)).join('\n\n');
    // Threshold on the top-1 session score keeps abstention consistent across
    // the turn-level and session-level paths.
    return this.respondWith(
      question,
      sessionHits[0]?.score ?? 0,
      retrieved,
      buildAggregationQaPrompt,
    );
  }

  private async respondWith(
    question: string,
    top1Score: number,
    retrieved: string,
    promptBuilder: PromptBuilder,
  ): Promise<Answer> {
    const abstentionEnabled = this.options.enableAbstention !== false;
    if (retrieved === '') {
      const answer = abstentionEnabled ? null : 'unknown';
      this.emitTrace(question, 0, answer === null, 'empty', { retrieved, answer });
      return answer;
    }
    if (
      abstentionEnabled &&
      this.options.abstainThreshold != null &&
      top1Score < this.options.abstainThreshold
    ) {
      this.emitTrace(question, top1Score, true, 'threshold', { retrieved, answer: null });
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
        });
        return 'unknown';
      }
      this.emitTrace(question, top1Score, true, 'llm', { retrieved, llmRaw: raw, answer: null });
      return null;
    }
    this.emitTrace(question, top1Score, false, 'answered', {
      retrieved,
      llmRaw: raw,
      answer: parsed,
    });
    return parsed;
  }

  private emitTrace(
    question: string,
    top1Score: number,
    abstained: boolean,
    reason: AbstainReason,
    extra: { retrieved?: string; llmRaw?: string; answer?: Answer },
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

/** Parse the LLM response; returns null when it abstains or returns empty. */
export function parseQaAnswer(raw: string, abstainToken: string = DEFAULT_ABSTAIN_TOKEN): Answer {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toUpperCase() === abstainToken.toUpperCase()) {
    return null;
  }
  return trimmed.replace(/^["']+|["']+$/g, '');
}
