/* istanbul ignore file -- type-only declaration, no runtime code */
/**
 * LLM abstraction: a minimal completion primitive so Cortex never depends on a
 * specific provider SDK. Adapters use fetch (OpenAI-compatible) or a local model.
 */
export type CompleteOptions = {
  /** Sampling temperature in [0, 2]. */
  temperature?: number;
  /** Maximum number of tokens to generate. */
  maxTokens?: number;
  /** Optional JSON schema for structured output. */
  schema?: JsonSchema;
};

/** A minimal structural JSON-schema description (subset of JSON Schema). */
export type JsonSchema = {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  description?: string;
};

export interface LLM {
  complete(prompt: string, opts?: CompleteOptions): Promise<string>;
  completeStructured<T>(prompt: string, schema: JsonSchema, opts?: CompleteOptions): Promise<T>;
}
