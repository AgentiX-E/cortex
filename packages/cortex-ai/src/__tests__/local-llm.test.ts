/**
 * The local text-generation adapter: what an offline deployment needs to run the proposal layer.
 *
 * ## Why this file had to exist before the wiring step could be honest
 *
 * `./local` shipped embeddings and a cross-encoder reranker and **no generation**, so a deployment
 * with no network could embed, rerank and answer from evidence -- and could not propose. Step 9
 * added a component whose only input is a model, and the entry that exists for offline use could
 * not produce one. That gap is invisible in a test suite that injects an `LLM`, which is why it
 * survived: the seam was supplied by every test and by no product path.
 *
 * ## What is asserted here, and what is not
 *
 * Asserted: the pinned `dtype`, the options this adapter forwards (`max_new_tokens`, and sampling
 * only when a temperature above zero asks for it), the three response shapes the pipeline can
 * return, and the schema-guided path. Not asserted: that a given checkpoint writes good JSON --
 * `test/proposer/run.mjs` measures that against real weights, and no unit test can.
 */
import { describe, expect, it } from 'vitest';

import type { JsonSchema } from '@agentix-e/cortex-core';
import {
  createLocalLLM,
  type TextGenerationOutput,
  type TextGenerationPipeline,
} from '../local/llm.js';
import type { TransformersModule } from '../local/pipelines.js';

type Call = { input: unknown; options: Record<string, unknown> | undefined };

/** A module whose pipeline records its arguments and returns a fixed reply. */
function moduleReturning(reply: unknown, calls: Call[]): TransformersModule {
  return {
    env: {},
    pipeline: async () => {
      const generator: TextGenerationPipeline = async (input, options) => {
        calls.push({ input, options });
        return reply as TextGenerationOutput;
      };
      return generator;
    },
  };
}

const load = (module: TransformersModule) => async () => module;

describe('createLocalLLM', () => {
  it('pins dtype and asks for a text-generation pipeline', async () => {
    const calls: Call[] = [];
    const seen: { task: string; model: string; options: unknown }[] = [];
    const module: TransformersModule = {
      env: {},
      pipeline: async (task, model, options) => {
        seen.push({ task, model, options });
        return async () => [{ generated_text: 'hello' }];
      },
    };
    await createLocalLLM({ model: 'some/model', loadModule: load(module) });
    expect(seen[0]?.task).toBe('text-generation');
    expect(seen[0]?.model).toBe('some/model');
    // The same pin as the embedding path, for the same reason: v4 defaults differ from v2's, and a
    // deployment that upgrades without pinning changes its vectors (and here, its weights) silently.
    expect(seen[0]?.options).toEqual({ dtype: 'fp32' });
    expect(calls).toHaveLength(0);
  });

  it('passes an explicit dtype through, because a browser may not afford fp32', async () => {
    const seen: unknown[] = [];
    const module: TransformersModule = {
      env: {},
      pipeline: async (_task, _model, options) => {
        seen.push(options);
        return async () => [{ generated_text: 'x' }];
      },
    };
    await createLocalLLM({ model: 'm', dtype: 'q4', loadModule: load(module) });
    expect(seen[0]).toEqual({ dtype: 'q4' });
  });

  it('sends the prompt as a chat message and reads generated_text from an array reply', async () => {
    const calls: Call[] = [];
    const llm = await createLocalLLM({
      model: 'm',
      loadModule: load(moduleReturning([{ generated_text: '  the answer  ' }], calls)),
    });
    expect(await llm.complete('a question')).toBe('the answer');
    expect(calls[0]?.input).toEqual([{ role: 'user', content: 'a question' }]);
  });

  it('reads the assistant turn when the pipeline echoes the conversation back', async () => {
    // transformers.js returns the whole message array for a chat input in some versions and only
    // the completion in others. Both are ordinary, and an adapter that assumes one produces an
    // empty string on the other -- which is indistinguishable from a model that said nothing.
    const calls: Call[] = [];
    const reply = [
      {
        generated_text: [
          { role: 'user', content: 'a question' },
          { role: 'assistant', content: 'the answer' },
        ],
      },
    ];
    const llm = await createLocalLLM({
      model: 'm',
      loadModule: load(moduleReturning(reply, calls)),
    });
    expect(await llm.complete('a question')).toBe('the answer');
  });

  it('reads a bare object too, because not every version wraps the result in a list', async () => {
    const calls: Call[] = [];
    const llm = await createLocalLLM({
      model: 'm',
      loadModule: load(moduleReturning({ generated_text: 'bare' }, calls)),
    });
    expect(await llm.complete('q')).toBe('bare');
  });

  it('returns an empty string when the last message has no content', async () => {
    const calls: Call[] = [];
    const reply = [{ generated_text: [{ role: 'user', content: 'q' }, { role: 'assistant' }] }];
    const llm = await createLocalLLM({
      model: 'm',
      loadModule: load(moduleReturning(reply, calls)),
    });
    expect(await llm.complete('q')).toBe('');
  });

  it('forwards an execution device when one is asked for', async () => {
    const seen: unknown[] = [];
    const module: TransformersModule = {
      env: {},
      pipeline: async (_task, _model, options) => {
        seen.push(options);
        return async () => [{ generated_text: 'x' }];
      },
    };
    await createLocalLLM({ model: 'm', device: 'cpu', loadModule: load(module) });
    expect(seen[0]).toEqual({ dtype: 'fp32', device: 'cpu' });
  });

  it('returns an empty string rather than throwing on an empty reply', async () => {
    const calls: Call[] = [];
    const llm = await createLocalLLM({ model: 'm', loadModule: load(moduleReturning([], calls)) });
    expect(await llm.complete('a question')).toBe('');
  });

  it('disables sampling at temperature 0 and never forwards the temperature', async () => {
    const calls: Call[] = [];
    const llm = await createLocalLLM({
      model: 'm',
      loadModule: load(moduleReturning([{ generated_text: 'x' }], calls)),
    });
    await llm.complete('q', { temperature: 0, maxTokens: 32 });
    expect(calls[0]?.options).toMatchObject({ do_sample: false, max_new_tokens: 32 });
    expect(calls[0]?.options).not.toHaveProperty('temperature');
  });

  it('enables sampling when a positive temperature asks for it', async () => {
    const calls: Call[] = [];
    const llm = await createLocalLLM({
      model: 'm',
      loadModule: load(moduleReturning([{ generated_text: 'x' }], calls)),
    });
    await llm.complete('q', { temperature: 0.7 });
    expect(calls[0]?.options).toMatchObject({ do_sample: true, temperature: 0.7 });
  });

  it('defaults max_new_tokens, so a caller that forgot cannot generate forever', async () => {
    const calls: Call[] = [];
    const llm = await createLocalLLM({
      model: 'm',
      maxNewTokens: 64,
      loadModule: load(moduleReturning([{ generated_text: 'x' }], calls)),
    });
    await llm.complete('q');
    expect(calls[0]?.options).toMatchObject({ max_new_tokens: 64 });
  });

  it('sends a raw prompt when the caller says the model has no chat template', async () => {
    const calls: Call[] = [];
    const llm = await createLocalLLM({
      model: 'm',
      messages: false,
      loadModule: load(moduleReturning([{ generated_text: 'x' }], calls)),
    });
    await llm.complete('raw prompt');
    expect(calls[0]?.input).toBe('raw prompt');
  });

  it('appends the schema to the prompt and parses the reply', async () => {
    const calls: Call[] = [];
    const reply = [{ generated_text: '```json\n{"facts":[{"text":"a"}]}\n```' }];
    const llm = await createLocalLLM({
      model: 'm',
      loadModule: load(moduleReturning(reply, calls)),
    });
    const schema: JsonSchema = { type: 'object', properties: { facts: { type: 'array' } } };
    const value = await llm.completeStructured<{ facts: { text: string }[] }>('split this', schema);
    expect(value.facts[0]?.text).toBe('a');
    const sent = (calls[0]?.input as { content: string }[])[0]?.content ?? '';
    expect(sent).toContain('split this');
    expect(sent).toContain('"facts"');
  });

  it('throws when the model does not return JSON, so the caller can fail closed', async () => {
    const calls: Call[] = [];
    const llm = await createLocalLLM({
      model: 'm',
      loadModule: load(moduleReturning([{ generated_text: 'no json here' }], calls)),
    });
    await expect(llm.completeStructured('q', { type: 'object' })).rejects.toThrow(/JSON/);
  });

  it('applies env overrides before creating the pipeline', async () => {
    let host: unknown;
    const module: TransformersModule = {
      env: { remoteHost: 'https://huggingface.co' },
      pipeline: async () => {
        host = module.env.remoteHost;
        return async () => [{ generated_text: 'x' }];
      },
    };
    await createLocalLLM({
      model: 'm',
      env: { remoteHost: 'https://hf-mirror.com' },
      loadModule: load(module),
    });
    expect(host).toBe('https://hf-mirror.com');
  });
});
