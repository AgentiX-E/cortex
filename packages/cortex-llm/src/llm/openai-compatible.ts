/**
 * OpenAI-compatible LLM adapter. Talks to any OpenAI-compatible /chat/completions
 * endpoint via fetch. Structured output uses JSON mode + schema-guided prompt.
 */
import type { CompleteOptions, JsonSchema, LLM } from '@agentix-e/cortex-core';

export type OpenAICompatibleLLMOptions = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Injectable fetch for testability and environments without global fetch. */
  fetchFn?: typeof fetch;
};

export class OpenAICompatibleLLM implements LLM {
  private readonly options: OpenAICompatibleLLMOptions;

  constructor(options: OpenAICompatibleLLMOptions) {
    this.options = options;
  }

  async complete(prompt: string, opts: CompleteOptions = {}): Promise<string> {
    const body = buildChatBody(this.options.model, prompt, opts);
    const res = await this.post('/chat/completions', body);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return json.choices?.[0]?.message?.content ?? '';
  }

  async completeStructured<T>(
    prompt: string,
    schema: JsonSchema,
    opts: CompleteOptions = {},
  ): Promise<T> {
    const guided = `${prompt}\n\nRespond with JSON matching this schema:\n${JSON.stringify(schema)}`;
    const raw = await this.complete(guided, opts);
    return parseJson<T>(raw);
  }

  private async post(path: string, body: unknown): Promise<Response> {
    const fetchFn = this.options.fetchFn ?? fetch;
    const res = await fetchFn(`${this.options.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.options.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`LLM request failed: ${res.status} ${res.statusText}`);
    }
    return res;
  }
}

export function buildChatBody(
  model: string,
  prompt: string,
  opts: CompleteOptions,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: prompt }],
  };
  if (opts.temperature != null) {
    body['temperature'] = opts.temperature;
  }
  if (opts.maxTokens != null) {
    body['max_tokens'] = opts.maxTokens;
  }
  if (opts.schema != null) {
    body['response_format'] = { type: 'json_object' };
  }
  return body;
}

/** Extract the first JSON object from a possibly-fenced LLM response. */
export function parseJson<T>(raw: string): T {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1]! : trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`LLM did not return a JSON object: ${raw.slice(0, 200)}`);
  }
  return JSON.parse(candidate.slice(start, end + 1)) as T;
}
