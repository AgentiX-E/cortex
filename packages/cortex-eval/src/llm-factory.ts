/**
 * LLM factory: resolves a DeepSeek LLM from environment variables. DeepSeek is
 * OpenAI-compatible, so the cortex-llm adapter is reused directly.
 

 *
 * ## Module-private exports
 *
 * Some declarations below are deliberately not exported. They are used only inside
 * this file, appear in no package barrel, and are referenced by no test or tool —
 * so `export` would advertise a consumer that does not exist. The `export-census`
 * tool reports them as `referenced-locally`, and
 * `packages/cortex-eval/src/__tests__/export-surface.test.ts` pins the set from both
 * sides. Restoring an `export` is a deliberate act: add it when a real caller
 * appears, not in advance of one.
*/
import type { LLM } from '@agentix-e/cortex-core';
import { OpenAICompatibleLLM, type ThinkingMode } from '@agentix-e/cortex-llm';

export type LlmEnv = Record<string, string | undefined>;

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';
/** Per-attempt deadline for thinking-mode calls; reasoning takes far longer. */
const THINKING_TIMEOUT_MS = 300_000;

/**
 * Per-attempt request deadline for the given thinking mode. Thinking mode
 * reasons before answering, so a single call over a large retrieved context can
 * take 30-120s and blows past the adapter's 60s non-thinking default; give it a
 * 5-minute deadline instead. Non-thinking keeps the adapter default (undefined).
 */
export function resolveTimeoutMs(thinking: ThinkingMode): number | undefined {
  return thinking.type === 'enabled' ? THINKING_TIMEOUT_MS : undefined;
}

export function createLlmFromEnv(env: LlmEnv): LLM {
  const apiKey = env['DEEPSEEK_API_KEY'];
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is required for natural-language benchmark');
  }
  const baseUrl = env['DEEPSEEK_BASE_URL'] ?? DEFAULT_DEEPSEEK_BASE_URL;
  const model = env['DEEPSEEK_MODEL'] ?? DEFAULT_DEEPSEEK_MODEL;
  // DeepSeek V4-Pro enables thinking by default with effort=high, which makes
  // even a one-line QA answer reason for tens of seconds (minutes on a large
  // retrieved context) and blows past the 60s request deadline. This benchmark
  // asks shallow extract/answer questions, so disable thinking by default and
  // let DEEPSEEK_THINKING=enabled opt back in for reasoning-heavy experiments.
  const thinking: ThinkingMode =
    env['DEEPSEEK_THINKING'] === 'enabled' ? { type: 'enabled' } : { type: 'disabled' };
  const timeoutMs = resolveTimeoutMs(thinking);
  return new OpenAICompatibleLLM({
    baseUrl,
    apiKey,
    model,
    thinking,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}
