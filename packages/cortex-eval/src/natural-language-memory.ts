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
import { retrieveTopK } from './retrieval.js';

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
  /** Number of retrieved turns passed to the LLM (default 5). */
  topK?: number;
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

export class NaturalLanguageMemorySystem implements MemorySystem {
  readonly name: string;
  private readonly options: NaturalLanguageMemorySystemOptions;

  constructor(name: string, options: NaturalLanguageMemorySystemOptions) {
    this.name = name;
    this.options = options;
  }

  async answer(question: string, context: string[]): Promise<Answer> {
    const topK = this.options.topK ?? 5;
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

    const retrieved = hits.map((h) => h.text).join('\n');
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
    `Answer with ONLY the exact answer phrase (a word, name, number, or short phrase), with no explanation and no full sentence. If the answer is not in the context, respond with exactly: ${abstainToken}`,
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
