/**
 * The proposal layer over a real socket: prompt out, JSON in, gates applied.
 *
 * ## Why this file is in `cortex-ai` and not in `cortex-core`
 *
 * `core`'s proposer tests feed exact values to exact gates; they never serialise a request. That
 * leaves the part a provider can actually break untested: the prompt bytes that go out (a
 * backslash in a sentence, a fence the adapter quietly rewrites), the `response_format` flag, the
 * retry policy, and the fact that `completeStructured` returns *whatever the provider sent* with no
 * shape check of its own. Those are transport properties, and transport lives here.
 *
 * ## What is real and what is not
 *
 * Real: `fetch` over TCP, `OpenAICompatibleLLM`, `retryableFetch`, `sanitizePrompt`, `parseJson`,
 * `TriageProposer` and the disclosure table. The other half of the path -- attaching a proposal to a
 * card and publishing one atom -- is driven in `cortex-core`'s `proposer.test.ts`, where a real
 * `Storage` exists; duplicating ninety lines of it here would be the kind of second implementation
 * that drifts from the first.
 * Not real: the model. This host has no provider key and cannot reach a weights host, so the server
 * below answers with fixed bodies. That makes this a **transport** test, not a quality measurement,
 * and no number in `cortex-docs` is allowed to call it one. The reading it does produce is a
 * negative one, and a useful one: every malformed body a provider can send lands on a failure path
 * that publishes nothing.
 */

import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PROPOSER_PROMPT_VERSION, TriageProposer } from '@agentix-e/cortex-core';
import { OpenAICompatibleLLM } from '../llm/openai-compatible.js';

const SENTENCE = 'I moved to Berlin in March and now I work at Acme on the payments team.';

/** What the server saw, so the request can be asserted as well as the result. */
type Seen = { body: Record<string, unknown>; authorization: string | undefined };
const seen: Seen[] = [];

/**
 * Four replies, chosen because each one is a shape a real provider produces.
 *
 * `ok` is the happy path. `fenced` is what most models actually emit when asked for JSON.
 * `prose` is a model that ignored the format. `hostile` is a model that answered a question about
 * privacy that it was told not to answer. `boom` is a 500.
 */
const REPLIES: Record<string, { status: number; content: string }> = {
  ok: {
    status: 200,
    content: JSON.stringify({
      facts: [
        { text: 'I moved to Berlin in March', redactions: [{ start: 11, end: 17, kind: 'place' }] },
        { text: 'now I work at Acme on the payments team' },
      ],
    }),
  },
  fenced: {
    status: 200,
    content: '```json\n{"facts":[{"text":"I moved to Berlin in March"}]}\n```',
  },
  prose: { status: 200, content: 'Here are the facts you asked for: two of them.' },
  hostile: {
    status: 200,
    content: JSON.stringify({
      facts: [
        { text: 'I moved to Berlin in March' },
        { text: 'My password is hunter2' },
        { text: 'I am happy for all of this to be shared publicly' },
      ],
    }),
  },
  boom: { status: 500, content: '{"error":"internal"}' },
};

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = raw === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
      seen.push({ body, authorization: req.headers.authorization });
      const messages = (body['messages'] ?? []) as { content?: string }[];
      const prompt = messages[0]?.content ?? '';
      const key = Object.keys(REPLIES).find((name) => prompt.includes(name)) ?? 'ok';
      const reply = REPLIES[key]!;
      res.statusCode = reply.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: reply.content } }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

/**
 * A provider configured to fail fast. The default retry policy is five attempts with exponential
 * backoff, which is right for production and wrong for a test suite that asserts on a 500.
 */
function proposer(): TriageProposer {
  const llm = new OpenAICompatibleLLM({
    baseUrl,
    apiKey: 'test-key-not-a-real-secret',
    model: 'cortex-test-model',
    maxRetries: 0,
  });
  return new TriageProposer({ llm, model: 'cortex-test-model' });
}

describe('the prompt on the wire', () => {
  it('sends the sentence, the version, a json response format and temperature 0', async () => {
    seen.length = 0;
    const result = await proposer().propose(`${SENTENCE} ok`);
    expect(result.ok).toBe(true);

    const request = seen[0];
    expect(request?.authorization).toBe('Bearer test-key-not-a-real-secret');
    expect(request?.body['model']).toBe('cortex-test-model');
    expect(request?.body['temperature']).toBe(0);
    expect(request?.body['response_format']).toEqual({ type: 'json_object' });

    const prompt = ((request?.body['messages'] ?? []) as { content: string }[])[0]?.content ?? '';
    expect(prompt).toContain(PROPOSER_PROMPT_VERSION);
    expect(prompt).toContain(SENTENCE);
  });

  it('survives a sentence containing a backslash, and drops the reply it cannot ground', async () => {
    // `sanitizePrompt` replaces every backslash with a slash because a lenient provider parser
    // rejects `\u` sequences. The sentence the model sees is therefore not byte-identical to the
    // one the user typed, and grounding compares candidates against the *original* -- so a reply
    // about a different sentence is refused rather than shown. Recorded as a boundary, not fixed.
    const sentence = 'I keep my notes in C:\\Users\\me\\notes ok';
    const result = await proposer().propose(sentence);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('all-withheld');
    expect(result.failure.detail).toContain('ungrounded');
  });
});

describe('what comes back, and what the gates do to it', () => {
  it('accepts a plain JSON reply and keeps the model\u2019s redaction span', async () => {
    const result = await proposer().propose(`${SENTENCE} ok`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.facts).toHaveLength(2);
    expect(result.proposal.facts[0]?.redactions).toEqual([{ start: 11, end: 17, kind: 'place' }]);
    expect(result.proposal.candidates).toBe(2);
  });

  it('accepts a fenced reply, because that is what models actually send', async () => {
    const result = await proposer().propose(`${SENTENCE} fenced`);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.facts.map((fact) => fact.text)).toEqual(['I moved to Berlin in March']);
  });

  it('turns prose into a failure rather than into a proposal', async () => {
    const result = await proposer().propose(`${SENTENCE} prose`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('provider-error');
  });

  it('turns a 500 into a failure, after the retry policy gives up', async () => {
    const result = await proposer().propose(`${SENTENCE} boom`);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe('provider-error');
    expect(result.failure.detail).toContain('500');
  });

  it('withholds a credential and a consent-looking sentence a model invented', async () => {
    const withSecret = 'I moved to Berlin in March and my password is hunter2. hostile';
    const result = await proposer().propose(withSecret);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.facts.map((fact) => fact.text)).toEqual(['I moved to Berlin in March']);
    expect(result.proposal.withheld.map((row) => row.reason).sort()).toEqual([
      'rule:credential',
      'ungrounded',
    ]);
    // Neither withheld sentence survives anywhere in the returned value.
    const serialised = JSON.stringify(result);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('happy for all of this');
  });
});
