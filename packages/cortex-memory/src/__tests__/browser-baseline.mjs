/**
 * The control arm of the browser corpus suite: the same scenario, under `node:sqlite`.
 *
 * ## Why this file is here and not beside the probe
 *
 * It sits in `src/__tests__` because it is test code and the caller census has exactly two spellings
 * for that: a `__tests__` directory and a `.test.ts` suffix. It has no third. A baseline module in
 * `test/browser/` is a *reference* to `@agentix-e/cortex-storage/sqlite` from a path the census reads as
 * a product package, which reclassifies `SqliteStorage` from "the harness reaches this" to "the product
 * calls this" — and the boundary record then fails for a reason that has nothing to do with the product.
 *
 * That reclassification is a real finding and it has a number: teaching `isTestFile` the third spelling
 * (`packages/<pkg>/test/**`) adds **seven** boundary names in one go, all of `cortex-ai`'s provider
 * wiring, whose only callers are the scripts in `packages/cortex-ai/test/profile/`. Discovering that in
 * the middle of a browser round would mix two subjects and produce a boundary record written to make a
 * gate green. So the definition stays where it is, this file sits where test code already sits, and the
 * finding is written down for the round that is about the census rather than about the browser.
 *
 * ## Why it is `.mjs` and not `.test.ts`
 *
 * Because it is not a suite. Vitest collects `*.test.ts`; the probe imports this with plain Node, which
 * cannot load TypeScript, so it imports `../../dist/index.js` the way every tool in this repository does.
 * The `.mjs` suffix is also what keeps vitest from trying to run it.
 */
import { assembleMemory } from '../../dist/index.js';
import { SqliteStorage } from '@agentix-e/cortex-storage/sqlite';

/**
 * The scenario. One copy, because the digest comparison is between two runtimes.
 *
 * The session ids are chosen so that key order and arrival order disagree: `s1` sorts first and arrives
 * second. An engine that returned rows in key order would put `s1`'s two turns before `s3`'s one, and
 * the prompt digest would move — which is what makes the ordering invariant measurable in the browser
 * rather than merely asserted in a unit test on one engine.
 */
export const SCENARIO = {
  now: 1_759_470_000_000,
  secret: 'Falcon is the code name for the Helix Bio acquisition.',
  other: 'The invoice for the bicycle repair was paid late again.',
  kept: 'The quarterly numbers ship on Friday.',
  raised: 'Anke raised the rent in June.',
  question: 'What is the code name?',
  turns: [
    { sessionId: 's3', ordinal: 0, text: 'Anke raised the rent in June.' },
    { sessionId: 's1', ordinal: 0, text: 'Falcon is the code name for the Helix Bio acquisition.' },
    { sessionId: 's1', ordinal: 1, text: 'The quarterly numbers ship on Friday.' },
    { sessionId: 's2', ordinal: 0, text: 'The invoice for the bicycle repair was paid late again.' },
  ],
  arrival: [
    'Anke raised the rent in June.',
    'Falcon is the code name for the Helix Bio acquisition.',
    'The quarterly numbers ship on Friday.',
    'The invoice for the bicycle repair was paid late again.',
  ],
};

/**
 * FNV-1a over UTF-16 code units, over a string.
 *
 * The same function the page uses, and not `crypto`: the point is a digest both runtimes can compute
 * from the same bytes with no encoding step in between. A SHA-256 here would add an encoder whose
 * behaviour on astral planes is a second thing that could differ.
 */
export function digestOf(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The reader the page also uses: records the prompt, answers with a constant. */
export function recordingLlm(seen) {
  return {
    complete: async (prompt) => {
      seen.push(prompt);
      return 'Berlin';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

/** A deterministic vector channel: the ranking may use it, the digest can depend on it, nothing varies. */
export const embed = (texts) => Promise.resolve(texts.map(() => [1, 0, 0]));

/**
 * The same scenario under `node:sqlite`, which is where every published reading came from.
 *
 * This is the control arm, and it runs in the probe's own process, so a change to the product's prompt
 * moves both arms together and the equality still holds — the equality is about the *engine*, not about
 * the prompt's content. What it does catch is anything a second runtime does differently: ordering, a
 * row that loses a field through a worker, a store whose transaction is not one.
 */
export async function nodeBaseline(scenario) {
  const seen = [];
  const install = assembleMemory({
    llm: recordingLlm(seen),
    now: scenario.now,
    storage: new SqliteStorage(),
    shared: new SqliteStorage(),
    profile: 'full',
    embed,
  });
  await install.memory.remember(scenario.turns);
  await install.memory.askStored(scenario.question);
  const prompt = seen[seen.length - 1];
  if (prompt === undefined) throw new Error('the baseline produced no prompt');
  const sessions = await install.corpus.sessions();
  return {
    promptChars: prompt.length,
    promptDigest: digestOf(prompt),
    promptCount: seen.length,
    corpusSize: await install.corpus.size(),
    sessionOrder: sessions.map((session) => session.join(' | ')),
  };
}
