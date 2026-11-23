/// <reference types="node" />
/**
 * One question through the product arm, against a stand-in for both model endpoints.
 *
 * The wiring this exercises is the one thing a unit test cannot see: the arm's chat calls have to reach the
 * metering proxy **with the label header**, because that header is what makes the row's cost attributable, and
 * its embeddings have to reach the embedder at all, because the registered arm is self-index. A stand-in
 * answers both so the assertions are about the requests, not about a model's quality.
 */
import { createProductProvider } from '../../competitor-product.mjs';

const provider = createProductProvider(process.env, { name: 'cortex-product' });
await provider.ingest([
  {
    id: 's1',
    at: Date.UTC(2023, 1, 15),
    turns: [
      { role: 'user', content: '[2023/02/15 (Wed) 03:14] user: I moved to Porto in January.' },
      { role: 'assistant', content: '[2023/02/15 (Wed) 03:15] assistant: Noted, Porto.' },
    ],
  },
]);
const answer = await provider.answer('Where did I move?');
process.stdout.write(
  `${JSON.stringify({
    answer,
    promptBytes: provider.lastPromptText()?.length ?? 0,
    build: provider.build,
    usage: provider.usage ?? null,
  })}\n`,
);
