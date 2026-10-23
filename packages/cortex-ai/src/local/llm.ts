/**
 * Generation on this machine: the `LLM` adapter the `./local` entry was missing.
 *
 * ## The gap this closes
 *
 * Before step 9 nothing needed generation offline, so `./local` could ship embeddings and a
 * cross-encoder and be complete. The proposal layer needs a model, and the entry that exists for
 * deployments without a network could not produce one -- which made "offline" true for retrieval and
 * false for the card queue. That is invisible from a test suite that injects an `LLM` at every seam,
 * and visible the moment somebody tries to run the product without a key.
 *
 * ## Three decisions
 *
 * 1. **The same `dtype` pin as the embedding path.** `@huggingface/transformers` 4 defaults to fp32
 *    where 2.x defaulted to quantized weights. For embeddings that changed the vectors (measured:
 *    min cosine 0.988); for generation it changes which weights answer, which is worse, because the
 *    output is prose and nothing downstream compares it to a stored value.
 * 2. **Sampling only when asked.** `temperature: 0` means `do_sample: false` and no temperature in
 *    the options at all. Passing `temperature` with sampling off is how a run that claims to be
 *    deterministic stops being one.
 * 3. **A chat message by default, a raw string on request.** Instruction-tuned checkpoints expect
 *    their template; a base checkpoint does not have one, and a caller who knows that should not
 *    have to reimplement this adapter to say so.
 *
 * ## What is not here
 *
 * No batching, no KV-cache management, no token counting. A local model on a laptop is slow enough
 * that one document at a time is the only shape that fits, and the proposal layer calls it once per
 * card.
 */
import type { CompleteOptions, JsonSchema, LLM } from '@agentix-e/cortex-core';
import { parseJson } from '../llm/openai-compatible.js';
import { preparePipeline, type LocalPipelineOptions } from './pipelines.js';

/** One turn of a chat, as transformers.js accepts it. */
export type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string };

/** What the pipeline returns before this adapter normalises it. Structural, for the same reason. */
export type TextGenerationOutput =
  { generated_text?: unknown } | { generated_text?: unknown }[] | undefined;

/** A `text-generation` pipeline. */
export type TextGenerationPipeline = (
  input: string | ChatMessage[],
  options?: {
    max_new_tokens?: number;
    do_sample?: boolean;
    temperature?: number;
    return_full_text?: boolean;
  },
) => Promise<TextGenerationOutput>;

export type LocalLLMOptions = LocalPipelineOptions & {
  /**
   * Tokens a single completion may add. A product default rather than a measured one: 192 covers
   * every reply the proposal prompt produced on the 60-sentence set, and a cap is what stops a
   * model that starts repeating itself from holding the caller for a minute.
   */
  maxNewTokens?: number;
  /** Send the prompt as a user message (default) or verbatim as a raw string. */
  messages?: boolean;
};

/**
 * Read the text out of whatever the pipeline returned.
 *
 * Two shapes are ordinary: a string completion, or the whole message array with the assistant's turn
 * last. An adapter that handles one and not the other returns `''` on the other, which is
 * indistinguishable from a model that said nothing -- so both are handled and both are tested.
 */
function textOf(output: TextGenerationOutput): string {
  const first = Array.isArray(output) ? output[0] : output;
  const generated = first?.generated_text;
  if (typeof generated === 'string') return generated.trim();
  if (!Array.isArray(generated)) return '';
  const last = generated[generated.length - 1] as { content?: unknown } | undefined;
  return typeof last?.content === 'string' ? last.content.trim() : '';
}

class LocalLLM implements LLM {
  constructor(
    private readonly generator: TextGenerationPipeline,
    private readonly defaults: { maxNewTokens: number; messages: boolean },
  ) {}

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const temperature = opts.temperature ?? 0;
    const sampled = temperature > 0;
    const input: string | ChatMessage[] = this.defaults.messages
      ? [{ role: 'user', content: prompt }]
      : prompt;
    const output = await this.generator(input, {
      max_new_tokens: opts.maxTokens ?? this.defaults.maxNewTokens,
      do_sample: sampled,
      return_full_text: false,
      ...(sampled ? { temperature } : {}),
    });
    return textOf(output);
  }

  async completeStructured<T>(
    prompt: string,
    schema: JsonSchema,
    opts: CompleteOptions = {},
  ): Promise<T> {
    // No JSON mode and no grammar constraint on this path: the schema goes into the prompt and the
    // parse is the check. Saying so matters -- a caller who assumed a grammar would believe the
    // output is valid JSON because it was asked to be.
    const guided = `${prompt}\n\nRespond with JSON matching this schema:\n${JSON.stringify(schema)}`;
    return parseJson<T>(await this.complete(guided, opts));
  }
}

/** Load `model` and return it as an `LLM`. Throws when the peer or the weights are unavailable. */
export async function createLocalLLM(options: LocalLLMOptions): Promise<LLM> {
  const { module, args } = await preparePipeline(options);

  const generator = (await module.pipeline(
    'text-generation',
    options.model,
    args,
  )) as TextGenerationPipeline;

  return new LocalLLM(generator, {
    maxNewTokens: options.maxNewTokens ?? 192,
    messages: options.messages ?? true,
  });
}
