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
import type { Answer, MemorySystem } from './types.js';
import { expandContextWindow, retrieveTopK } from './retrieval.js';

export { clearEmbeddingCache } from './retrieval.js';

export type AbstainReason = 'empty' | 'threshold' | 'llm' | 'answered';

export type DecisionTrace = {
  question: string;
  top1Score: number;
  abstained: boolean;
  reason: AbstainReason;
};

export type NaturalLanguageMemorySystemOptions = {
  embedding: EmbeddingModel;
  llm: LLM;
  /** Number of retrieved turns passed to the LLM (default 10). */
  topK?: number;
  /** Number of neighbouring turns to include around each hit (default 1). */
  contextRadius?: number;
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
const DEFAULT_CONTEXT_RADIUS = 1;

export class NaturalLanguageMemorySystem implements MemorySystem {
  readonly name: string;
  private readonly options: NaturalLanguageMemorySystemOptions;

  constructor(name: string, options: NaturalLanguageMemorySystemOptions) {
    this.name = name;
    this.options = options;
  }

  async answer(question: string, context: string[]): Promise<Answer> {
    const topK = this.options.topK ?? DEFAULT_TOP_K;
    const hits = await retrieveTopK(this.options.embedding, question, context, topK);
    const trace = (top1Score: number, abstained: boolean, reason: AbstainReason): void => {
      this.options.onDecision?.({ question, top1Score, abstained, reason });
    };

    if (hits.length === 0) {
      const answer = this.options.enableAbstention === false ? 'unknown' : null;
      trace(0, answer === null, 'empty');
      return answer;
    }
    const abstentionEnabled = this.options.enableAbstention !== false;
    if (
      abstentionEnabled &&
      this.options.abstainThreshold != null &&
      hits[0]!.score < this.options.abstainThreshold
    ) {
      trace(hits[0]!.score, true, 'threshold');
      return null;
    }

    // Expand each hit into its local context window so the LLM sees coherent
    // dialogue rather than isolated single turns.
    const retrieved = expandContextWindow(
      context,
      hits.map((h) => h.index),
      this.options.contextRadius ?? DEFAULT_CONTEXT_RADIUS,
    );
    const prompt = buildQaPrompt(question, retrieved, this.options.abstainToken);
    const raw = await this.options.llm.complete(prompt, {
      temperature: this.options.temperature ?? DEFAULT_TEMPERATURE,
    });
    const parsed = parseQaAnswer(raw, this.options.abstainToken);
    if (parsed === null) {
      if (!abstentionEnabled) {
        trace(hits[0]!.score, false, 'answered');
        return 'unknown';
      }
      trace(hits[0]!.score, true, 'llm');
      return null;
    }
    trace(hits[0]!.score, false, 'answered');
    return parsed;
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

/** Parse the LLM response; returns null when it abstains or returns empty. */
export function parseQaAnswer(raw: string, abstainToken: string = DEFAULT_ABSTAIN_TOKEN): Answer {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toUpperCase() === abstainToken.toUpperCase()) {
    return null;
  }
  return trimmed.replace(/^["']+|["']+$/g, '');
}
