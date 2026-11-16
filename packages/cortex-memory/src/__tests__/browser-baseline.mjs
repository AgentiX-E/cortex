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

/**
 * A deterministic vector channel: a hashed bag of words, integer-only, no model.
 *
 * ## Why not a constant vector
 *
 * The first version of this baseline returned `[1, 0, 0]` for every text, which exercises the *plumbing* --
 * the index asks for vectors, gets an array of the right width, stores it, and reads it back -- and measures
 * nothing about the channel itself: with one vector for every text, every cosine is 1 and the ranking the
 * vectors produce is the arrival order wearing a different name. A run that cannot distinguish "the vector
 * channel works" from "the vector channel is a constant" is a run whose green result is about the shape of
 * an array.
 *
 * So the channel is a real one, as far as a probe can afford: lowercase, split on non-alphanumerics, hash
 * each token with FNV-1a, add `+1` or `-1` into one of sixteen buckets by the hash's sign and modulus, then
 * L2-normalise. Two properties matter and both are asserted:
 *
 *   - **it discriminates** -- different texts produce different vectors, so the dense channel can order them;
 *   - **it is identical in both runtimes** -- integer arithmetic only, no `crypto`, no locale-sensitive
 *     collation, no iteration over an object's keys. The digest equality between `node:sqlite` and OPFS is
 *     therefore also an equality of the vectors the two runtimes fed the index, which is what makes
 *     `the two runtimes embed the same texts` a check and not a hope.
 *
 * It is not a semantic model and this file does not pretend otherwise: a hashed bag of words has no notion
 * of similarity beyond shared tokens. The point is a channel that *varies with the text*, computed the same
 * way twice.
 */
export const EMBED_DIMS = 16;

export function hashedEmbed(texts, counters) {
  return texts.map((text) => {
    const vector = new Array(EMBED_DIMS).fill(0);
    for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token === '') continue;
      let hash = 0x811c9dc5;
      for (let index = 0; index < token.length; index += 1) {
        hash ^= token.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      vector[hash % EMBED_DIMS] += (hash & 0x80000000) === 0 ? 1 : -1;
    }
    let norm = 0;
    for (const value of vector) norm += value * value;
    norm = Math.sqrt(norm) || 1;
    const unit = vector.map((value) => Number((value / norm).toFixed(12)));
    if (counters !== undefined) {
      counters.texts += 1;
      counters.vectors.add(JSON.stringify(unit));
    }
    return unit;
  });
}

/** The counters a run reports: how many texts it embedded, and how many distinct vectors that produced. */
export function embedCounters() {
  return { calls: 0, texts: 0, vectors: new Set() };
}

export function embedReport(counters) {
  return { calls: counters.calls, texts: counters.texts, distinct: counters.vectors.size };
}

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
  const counters = embedCounters();
  const embed = (texts) => {
    counters.calls += 1;
    return Promise.resolve(hashedEmbed(texts, counters));
  };
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
    embed: embedReport(counters),
  };
}
