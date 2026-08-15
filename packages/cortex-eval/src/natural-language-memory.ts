/**
 * A natural-language retrieval-augmented QA memory system for LongMemEval-style
 * benchmarks. It ingests conversational turns, retrieves the most relevant turns
 * by embedding similarity, generates an answer with an LLM grounded in the
 * retrieved context, and abstains either when retrieval confidence is too low or
 * when the LLM reports the answer is absent from the context.
 */
import type { EmbeddingModel, LLM } from '@agentix-e/cortex-core';
import { BruteForceVectorIndex } from '@agentix-e/cortex-core';
import type { Answer, MemorySystem } from './types.js';
import { fnv1a } from './embedding.js';

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
};

const DEFAULT_ABSTAIN_TOKEN = 'UNANSWERABLE';

export class NaturalLanguageMemorySystem implements MemorySystem {
  readonly name: string;
  private readonly options: NaturalLanguageMemorySystemOptions;
  private readonly index = new BruteForceVectorIndex();
  private readonly turns = new Map<string, string>();

  constructor(name: string, options: NaturalLanguageMemorySystemOptions) {
    this.name = name;
    this.options = options;
  }

  async answer(question: string, context: string[]): Promise<Answer> {
    await this.ingest(context);

    const [queryVec] = await this.options.embedding.embed([question]);
    const topK = this.options.topK ?? 5;
    const hits = await this.index.search(queryVec!, topK);
    if (hits.length === 0) {
      return this.options.enableAbstention === false ? 'unknown' : null;
    }
    const abstentionEnabled = this.options.enableAbstention !== false;
    if (
      abstentionEnabled &&
      this.options.abstainThreshold != null &&
      hits[0]!.score < this.options.abstainThreshold
    ) {
      return null;
    }

    const retrieved = hits.map((h) => this.turns.get(h.id) ?? '').join('\n');
    const prompt = buildQaPrompt(question, retrieved, this.options.abstainToken);
    const raw = await this.options.llm.complete(prompt);
    const parsed = parseQaAnswer(raw, this.options.abstainToken);
    if (parsed === null && !abstentionEnabled) {
      return 'unknown';
    }
    return parsed;
  }

  private async ingest(context: string[]): Promise<void> {
    for (const turn of context) {
      const id = `t-${fnv1a(turn)}`;
      if (this.turns.has(id)) {
        continue;
      }
      const [vec] = await this.options.embedding.embed([turn]);
      await this.index.add(id, vec!);
      this.turns.set(id, turn);
    }
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
    `Answer the question using ONLY the context below. If the answer is not in the context, respond with exactly: ${abstainToken}`,
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
