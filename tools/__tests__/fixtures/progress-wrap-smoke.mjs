/// <reference types="node" />
/**
 * A wrapped provider that carries `#private` state, driven through the one method the old wrapper broke.
 *
 * `Object.create(provider, …)` made `this` an object whose prototype was the instance, and JavaScript checks
 * private-field access against the receiver -- so `reset()` threw on the first question of run 45089801550, after
 * the corpus had already been embedded. This fixture is that shape, reduced to two calls.
 */
import { CortexProductProvider } from '../../../packages/cortex-memory/dist/index.js';
import { SqliteStorage } from '../../../packages/cortex-storage/dist/storage/sqlite.js';
import { createProgressWrapper } from '../../progress-wrap.mjs';

const llm = {
  complete: () => Promise.resolve('Answer: Lisbon'),
  completeStructured: () => Promise.resolve({}),
};
let meter = { calls: 0, promptTokens: 0, completionTokens: 0 };
const embed = (texts) =>
  Promise.resolve(texts.map(() => Float64Array.from({ length: 8 }, (_, at) => ((at + 1) % 5) / 5)));

const provider = new CortexProductProvider({
  llm,
  now: Date.UTC(2023, 1, 15),
  embed,
  storage: () => new SqliteStorage(),
  usage: () => ({ ...meter }),
});
const wrapped = createProgressWrapper(null)(provider, 1);

await wrapped.ingest([
  { id: 's1', at: Date.UTC(2023, 1, 15), turns: [{ role: 'user', content: 'I moved to Lisbon.' }] },
]);
const answer = await wrapped.answer('Where did I move?');
await wrapped.reset();
await wrapped.reset();
meter = { calls: 7, promptTokens: 900, completionTokens: 40 };

process.stdout.write(
  `${JSON.stringify({
    answer,
    name: wrapped.name,
    build: wrapped.build,
    usage: wrapped.usage ?? null,
    // `search` must still be forwarded: a wrapper that dropped it would make the harness treat a
    // self-answering arm as a retrieval arm and print a 0% recall column as a retrieval failure.
    hits: (await wrapped.search('anything', { limit: 5 })).length,
    manifest: wrapped.manifest ?? null,
  })}\n`,
);
