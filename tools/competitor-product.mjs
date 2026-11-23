#!/usr/bin/env node
/**
 * The shipped product, wired for the competitor harness.
 *
 * `tools/competitor-harness.mjs` measures competitors through `--sut`, which launches a driver in its own
 * process. The product cannot go through that boundary: its memory is a library, and a driver would have to
 * re-implement the assembly, which is the defect the whole comparator exists to avoid. So this module builds
 * the three things `CortexProductProvider` asks for and nothing else — a chat client, an embedder and a
 * store — from the same environment every other arm reads.
 *
 * ## The two model channels, and why they are not one
 *
 * **Chat goes through the metering proxy** (`SUT_LLM_BASE_URL`), with `X-Sut-Label` naming the arm. That is
 * what makes the token column come from the proxy's own count rather than from a vendor's self-report, and
 * it is the same channel Mastra, Mem0 and MemCog already use. A run whose product arm called DeepSeek
 * directly would print a cost of zero for the most expensive row in the table.
 *
 * **Embedding goes straight to Zhipu**, because the proxy relays chat completions and nothing else. That is
 * not a gap in the ledger: embedding cost is counted by the product's own index census (`embedCalls`,
 * `embedTexts`), which the arm's artifact already carries, and the two channels are reported separately
 * rather than summed into a number that would hide which half was billed.
 *
 * ## What fails loudly
 *
 * Every missing credential. A product arm that silently degraded to lexical retrieval would print under the
 * same name as the registered arm and would be a different system — the failure `product-provider.ts` names
 * in its first decision.
 */

import { OpenAIEmbedding } from '../packages/cortex-ai/dist/index.js';
import { CortexProductProvider } from '../packages/cortex-memory/dist/index.js';
import { SqliteStorage } from '../packages/cortex-storage/dist/storage/sqlite.js';

/**
 * A chat client for the product, speaking the one protocol the proxy relays.
 *
 * `completeStructured` is part of the `LLM` contract and the product may call it; it is implemented by asking
 * for JSON in the prompt and parsing the reply, which is what the product's own OpenAI-compatible client does
 * — the same behaviour, reached without a dependency that cannot carry a header.
 */
function chatClient({ baseUrl, apiKey, model, label, temperature }) {
  // The arm's own spend, as the provider reported it. Counted here rather than requested from the proxy
  // because the two are different numbers: the proxy counts a job, this counts an arm, and a row that read
  // the job's total would attribute every other arm's calls to this one.
  const meter = { calls: 0, promptTokens: 0, completionTokens: 0 };

  const call = async (prompt, options = {}) => {
    const body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: options.temperature ?? temperature,
      ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
    };
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        // The proxy groups spend by this header. Without it the arm's calls land under `unlabelled` and the
        // row's cost column reports zero, which is indistinguishable from a free system.
        'X-Sut-Label': label,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 600_000),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(
        `product arm chat call failed: ${String(response.status)} ${response.statusText} ${detail.slice(0, 400)}`,
      );
    }
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') {
      throw new Error(
        `product arm chat call returned no message content: ${JSON.stringify(payload).slice(0, 400)}`,
      );
    }
    // The provider's own accounting, when the relayed body carried any. A body without `usage` leaves the
    // counters where they are, which is the honest reading: the arm's cost is then unknown, not zero.
    const usage = payload?.usage;
    if (usage !== undefined && usage !== null) {
      meter.calls += 1;
      meter.promptTokens += Number(usage.prompt_tokens ?? 0);
      meter.completionTokens += Number(usage.completion_tokens ?? 0);
    }
    return content;
  };

  return {
    /** What this arm spent, read by `CortexProductProvider.usage` when the table asks for a cost. */
    usage: () => ({ ...meter }),
    complete: (prompt, options) => call(prompt, options),
    completeStructured: async (prompt, schema) => {
      const reply = await call(
        `${prompt}\n\nRespond with JSON matching this schema:\n${JSON.stringify(schema)}`,
      );
      try {
        return JSON.parse(reply);
      } catch {
        // A model that wrapped its JSON in a fence is common enough to be worth one repair rather than a
        // failed question; anything else is a genuine parse failure and is reported as one.
        const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(reply);
        if (fenced === null)
          throw new Error(`product arm structured reply was not JSON: ${reply.slice(0, 200)}`);
        return JSON.parse(fenced[1]);
      }
    },
  };
}

/**
 * Build the product arm from the environment the workflow already exports.
 *
 * The label is a parameter rather than a constant so a second configuration of the product could be run in
 * one job (the ablation its own workflow does); today there is one, and its spend lands under
 * `cortex-product/answer`.
 */
export function createProductProvider(env = process.env, options = {}) {
  const baseUrl = env['SUT_LLM_BASE_URL'];
  if (baseUrl === undefined || baseUrl === '') {
    throw new Error(
      'the product arm needs SUT_LLM_BASE_URL: its chat calls must go through the metering proxy, or the ' +
        "row's cost column reports zero for the most expensive system in the table",
    );
  }
  const model = env['SUT_LLM_MODEL'] ?? 'deepseek-chat';
  const label = options.label ?? 'cortex-product/answer';
  const temperature = Number(env['TEMPERATURE'] ?? '0');
  const zhipuKey = env['ZHIPU_API_KEY'];
  if (zhipuKey === undefined || zhipuKey === '') {
    throw new Error(
      'the product arm needs ZHIPU_API_KEY: the registered arm is self-index with an injected embedder, and ' +
        'an assembly without one is a lexical system that would print under the same name',
    );
  }

  const embedder = new OpenAIEmbedding({
    baseUrl: env['ZHIPU_EMBED_BASE_URL'] ?? 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: zhipuKey,
    model: env['ZHIPU_EMBED_MODEL'] ?? 'embedding-3',
    dimensions: Number(env['ZHIPU_EMBED_DIMENSIONS'] ?? '1024'),
  });

  const llm = chatClient({
    baseUrl,
    // The proxy overwrites authorization with its own upstream key, so this is a presence token rather than
    // a credential; it is read from the environment anyway so a direct-to-provider run is one variable away.
    apiKey: env['SUT_LLM_API_KEY'] ?? 'unused-by-the-metering-proxy',
    model,
    label,
    temperature: Number.isFinite(temperature) ? temperature : 0,
  });

  return new CortexProductProvider({
    llm,
    // The arm's own spend, from the provider's own accounting in each relayed response. Without this the row
    // would print `not measured` beside an accuracy, and "cost unknown" and "cost nothing" would be one column.
    usage: llm.usage,
    // Every question in this protocol is asked at the dataset's own date; a single clock for the run is what
    // makes the recency arithmetic reproducible, and it is the same choice the session adapter makes.
    now: Date.now(),
    embed: (texts) => embedder.embed([...texts]),
    // A fresh store per question: `reset` is `mode: isolated`'s requirement, and the corpus is the only
    // per-question state. The embedding cache lives inside the provider and deliberately survives it.
    storage: () => new SqliteStorage(),
    label: options.name ?? 'cortex-product',
  });
}
