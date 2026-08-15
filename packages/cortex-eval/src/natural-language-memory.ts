/**
 * A natural-language retrieval-augmented QA memory system for LongMemEval-style
 * benchmarks. It ingests conversational turns, retrieves the most relevant turns
 * by embedding similarity, generates an answer with an LLM grounded in the
 * retrieved context, and abstains either when retrieval confidence is too low or
 * when the LLM reports the answer is absent from the context.
 *
 * Embeddings are deterministic and are therefore cached in a module-level map
 * shared across instances. This avoids recomputing identical vectors when the
 * same conversational turn appears across questions or across the baseline and
 * feature systems of an ablation, which would otherwise make the benchmark
 * prohibitively expensive.
 */
import type { EmbeddingModel, LLM } from '@agentix-e/cortex-core';
import { BruteForceVectorIndex } from '@agentix-e/cortex-core';
import type { Answer, MemorySystem } from './types.js';

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
};

const DEFAULT_ABSTAIN_TOKEN = 'UNANSWERABLE';
const DEFAULT_TEMPERATURE = 0;
/** Zhipu embedding-3 accepts at most 64 inputs per request. */
const EMBEDDING_BATCH_SIZE = 64;

/** Shared cache of embedding vectors keyed by source text. */
const embeddingCache = new Map<string, Float64Array>();

/** Clear the shared embedding cache (used by tests and long-running processes). */
export function clearEmbeddingCache(): void {
  embeddingCache.clear();
}

/**
 * Embed many texts in bounded batches, reusing cached vectors and persisting new
 * ones. Batching avoids one round-trip per turn, which is the dominant cost for
 * LongMemEval-scale haystacks (hundreds of turns per question).
 */
async function embedManyCached(
  embedding: EmbeddingModel,
  texts: string[],
): Promise<Float64Array[]> {
  const result = new Array<Float64Array>(texts.length);
  const missing: number[] = [];
  for (let i = 0; i < texts.length; i++) {
    const cached = embeddingCache.get(texts[i]!);
    if (cached) {
      result[i] = cached;
    } else {
      missing.push(i);
    }
  }
  for (let start = 0; start < missing.length; start += EMBEDDING_BATCH_SIZE) {
    const chunk = missing.slice(start, start + EMBEDDING_BATCH_SIZE);
    const vectors = await embedding.embed(chunk.map((i) => texts[i]!));
    for (let j = 0; j < chunk.length; j++) {
      const idx = chunk[j]!;
      const vector = vectors[j] ?? new Float64Array(0);
      embeddingCache.set(texts[idx]!, vector);
      result[idx] = vector;
    }
  }
  return result;
}

async function embedCached(embedding: EmbeddingModel, text: string): Promise<Float64Array> {
  return (await embedManyCached(embedding, [text]))[0]!;
}

export class NaturalLanguageMemorySystem implements MemorySystem {
  readonly name: string;
  private readonly options: NaturalLanguageMemorySystemOptions;

  constructor(name: string, options: NaturalLanguageMemorySystemOptions) {
    this.name = name;
    this.options = options;
  }

  async answer(question: string, context: string[]): Promise<Answer> {
    // Build a per-question index: LongMemEval questions have independent
    // haystacks, so retrieval state must not leak across questions. Embedding
    // vectors are still shared through the module-level cache.
    const index = new BruteForceVectorIndex();
    const turns = new Map<string, string>();

    const pending: string[] = [];
    for (const turn of context) {
      const id = `t-${hashText(turn)}`;
      if (!turns.has(id)) {
        pending.push(turn);
      }
    }
    if (pending.length > 0) {
      const vectors = await embedManyCached(this.options.embedding, pending);
      for (let i = 0; i < pending.length; i++) {
        const turn = pending[i]!;
        const id = `t-${hashText(turn)}`;
        await index.add(id, vectors[i]!);
        turns.set(id, turn);
      }
    }

    const queryVec = await embedCached(this.options.embedding, question);
    const topK = this.options.topK ?? 5;
    const hits = await index.search(queryVec, topK);
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

    const retrieved = hits.map((h) => turns.get(h.id) ?? '').join('\n');
    const prompt = buildQaPrompt(question, retrieved, this.options.abstainToken);
    const raw = await this.options.llm.complete(prompt, {
      temperature: this.options.temperature ?? DEFAULT_TEMPERATURE,
    });
    const parsed = parseQaAnswer(raw, this.options.abstainToken);
    if (parsed === null && !abstentionEnabled) {
      return 'unknown';
    }
    return parsed;
  }
}

/** Stable 32-bit string hash used only for internal vector-index ids. */
function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
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
