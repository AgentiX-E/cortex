/**
 * LLM factory: resolves a DeepSeek LLM from environment variables. DeepSeek is
 * OpenAI-compatible, so the cortex-ai adapter is reused directly.
 

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
import { OpenAICompatibleLLM, type ThinkingMode } from '@agentix-e/cortex-ai';

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

/**
 * Which reader a run will use, resolved from the same environment the constructor reads.
 *
 * ## Why this exists as a separate function rather than as fields on the LLM
 *
 * Because the artifact has to state the identity, and the only way to state it without a
 * second copy of the defaults is for both the constructor and the recorder to call **this**
 * function. `PREREGISTRATION` §13.110 is the run that made the requirement concrete: two
 * artifacts differing by 7.20 points carried identical `memoryArmConfig` blocks, so the
 * model could only be recovered from a line in a job log that expires.
 *
 * ## Why `temperature` is `null` here
 *
 * Because this arm has never sent one. The workflow declares the input, the dispatch sends
 * it, `env` carries it -- and nothing below `#consult` reads it, so the request body omits
 * the field and the provider's default applies. Setting it here would move every number
 * this campaign has recorded, so the defect is **recorded** (§13.114) and fixed by its own
 * experiment rather than silently in a documentation round.
 */
export function resolveReaderIdentity(env: LlmEnv): {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly thinking: 'enabled' | 'disabled';
  readonly temperature: number | null;
} {
  const baseUrl = env['DEEPSEEK_BASE_URL'] ?? DEFAULT_DEEPSEEK_BASE_URL;
  const model = env['DEEPSEEK_MODEL'] ?? DEFAULT_DEEPSEEK_MODEL;
  // DeepSeek V4-Pro enables thinking by default with effort=high, which makes
  // even a one-line QA answer reason for tens of seconds (minutes on a large
  // retrieved context) and blows past the 60s request deadline. This benchmark
  // asks shallow extract/answer questions, so disable thinking by default and
  // let DEEPSEEK_THINKING=enabled opt back in for reasoning-heavy experiments.
  const thinking: 'enabled' | 'disabled' =
    env['DEEPSEEK_THINKING'] === 'enabled' ? 'enabled' : 'disabled';
  // Named by the service rather than by the vendor that happens to be the default: a run
  // pointed at an OpenAI-compatible proxy is not a DeepSeek run, and an artifact that called
  // it one would attribute its numbers to a provider that never served them.
  const provider = /(^|\.)deepseek\.com$/i.test(hostOf(baseUrl)) ? 'deepseek' : 'openai-compatible';
  return { provider, model, baseUrl, thinking, temperature: null };
}

/** The host of a base URL, or the string itself when it does not parse. */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export function createLlmFromEnv(env: LlmEnv): LLM {
  const apiKey = env['DEEPSEEK_API_KEY'];
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is required for natural-language benchmark');
  }
  // The identity is resolved rather than re-derived, so the model that answers and the model
  // the artifact names cannot be two different expressions of the same environment.
  const identity = resolveReaderIdentity(env);
  const thinking: ThinkingMode = { type: identity.thinking };
  const timeoutMs = resolveTimeoutMs(thinking);
  return new OpenAICompatibleLLM({
    baseUrl: identity.baseUrl,
    apiKey,
    model: identity.model,
    thinking,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}
