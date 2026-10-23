import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { OpenAICompatibleLLM } from '../llm/openai-compatible.js';
import { PROFILE_ENV, readApiKey, resolveLlmProfile } from '../profile.js';

/**
 * The configuration reaches a socket, or it is a decoration.
 *
 * Every other test of `resolveLlmProfile` checks what it *returns*. This one checks what happens
 * next: a profile resolved as `remote` is turned into a client, the client posts to the resolved
 * base URL, and the model and key on the wire are the ones the profile named. Without it, a
 * refactor could keep all twenty parsing tests green while the request went somewhere else -- and
 * the failure would show up as "the API is down" in a run that never called it.
 *
 * The server is real HTTP on loopback, which also exercises the exemption in
 * `assertUsableBaseUrl`: a plaintext base URL is refused unless it is the local machine, and that
 * exemption is worth nothing if nothing ever uses it.
 */

type Seen = { path: string; authorization: string | undefined; model: unknown };
const seen: Seen[] = [];
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw) as { model?: unknown };
      seen.push({
        path: req.url ?? '',
        authorization: req.headers.authorization,
        model: body.model,
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('a remote profile, driven through a real socket', () => {
  it('posts to the resolved base URL with the model and key the profile named', async () => {
    const env = {
      [PROFILE_ENV.model]: 'a-model-from-env',
      [PROFILE_ENV.baseUrl]: baseUrl,
      [PROFILE_ENV.apiKey]: 'sk-loopback-only',
    };
    const profile = resolveLlmProfile({ backend: 'remote' }, env);
    expect(profile).toMatchObject({ backend: 'remote', baseUrl });
    // Narrowed rather than cast: the union is the contract, and a test that reached `baseUrl` off
    // `LlmProfile` would not compile -- which is how `pnpm build` caught it after `vitest` passed.
    if (profile.backend !== 'remote') throw new Error('fixture: expected a remote profile');

    const client = new OpenAICompatibleLLM({
      baseUrl: profile.baseUrl,
      apiKey: readApiKey(env),
      model: profile.model,
    });
    await client.complete('hello');

    const last = seen.at(-1);
    expect(last?.path).toBe('/chat/completions');
    expect(last?.authorization).toBe('Bearer sk-loopback-only');
    expect(last?.model).toBe('a-model-from-env');
  });

  it('normalises the trailing slash before a path is appended to it', async () => {
    // `https://host/` + `/chat/completions` is `//chat/completions`, which some gateways 404. The
    // profile strips it, and this asserts the stripping survives into the request.
    const env = {
      [PROFILE_ENV.model]: 'm',
      [PROFILE_ENV.baseUrl]: `${baseUrl}/`,
      [PROFILE_ENV.apiKey]: 'k',
    };
    const profile = resolveLlmProfile({ backend: 'remote' }, env);
    if (profile.backend !== 'remote') throw new Error('fixture: expected a remote profile');
    const client = new OpenAICompatibleLLM({
      baseUrl: profile.baseUrl,
      apiKey: readApiKey(env),
      model: profile.model,
    });
    await client.complete('hello');
    expect(seen.at(-1)?.path).toBe('/chat/completions');
  });
});
