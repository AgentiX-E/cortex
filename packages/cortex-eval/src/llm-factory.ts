/**
 * LLM factory: resolves a DeepSeek LLM from environment variables. DeepSeek is
 * OpenAI-compatible, so the cortex-llm adapter is reused directly.
 */
import type { LLM } from '@agentix-e/cortex-core';
import { OpenAICompatibleLLM } from '@agentix-e/cortex-llm';

export type LlmEnv = Record<string, string | undefined>;

export const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com/v1';
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-chat';

export function createLlmFromEnv(env: LlmEnv): LLM {
  const apiKey = env['DEEPSEEK_API_KEY'];
  if (!apiKey) {
    throw new Error('DEEPSEEK_API_KEY is required for natural-language benchmark');
  }
  const baseUrl = env['DEEPSEEK_BASE_URL'] ?? DEFAULT_DEEPSEEK_BASE_URL;
  const model = env['DEEPSEEK_MODEL'] ?? DEFAULT_DEEPSEEK_MODEL;
  return new OpenAICompatibleLLM({ baseUrl, apiKey, model });
}
