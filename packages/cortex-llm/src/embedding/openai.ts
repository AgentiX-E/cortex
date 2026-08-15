/**
 * OpenAI-compatible embedding adapter. Normalizes remote float32 outputs to
 * Float64Array so downstream Cortex math retains full precision.
 */
import type { EmbeddingModel } from '@agentix-e/cortex-core';

export type OpenAIEmbeddingOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  fetchFn?: typeof fetch;
};

export class OpenAIEmbedding implements EmbeddingModel {
  private readonly options: OpenAIEmbeddingOptions;

  constructor(options: OpenAIEmbeddingOptions) {
    this.options = options;
  }

  dimension(): number {
    return this.options.dimensions;
  }

  async embed(texts: string[]): Promise<Float64Array[]> {
    const fetchFn = this.options.fetchFn ?? fetch;
    const body: Record<string, unknown> = { model: this.options.model, input: texts };
    // Variable-dimension models (e.g. Zhipu embedding-3) require an explicit
    // `dimensions` parameter; omitting it yields 400 Bad Request.
    if (this.options.dimensions > 0) {
      body['dimensions'] = this.options.dimensions;
    }
    const res = await fetchFn(`${this.options.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Embedding request failed: ${res.status} ${res.statusText}`);
    }
    const json = (await res.json()) as { data?: { embedding?: number[] }[] };
    const data = json.data ?? [];
    return data.map((d) => new Float64Array(d.embedding ?? []));
  }
}
