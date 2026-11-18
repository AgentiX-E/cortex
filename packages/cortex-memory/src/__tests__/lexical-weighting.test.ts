/**
 * What a query term is worth, and why a corpus is allowed to answer.
 *
 * ## The defect these tests pin
 *
 * `lexicalRelevance` counts every content term as one, so coverage divides by the number of distinct terms. On
 * `S14`'s twenty-one zero-recall questions, twenty carried a gold turn that scored **above zero** and lost to a
 * distractor repeating the question's generic words:
 *
 * ```
 * Q: "How many bikes do I own?"             gold 0.425  matched bikes, how
 *                                          deliv 0.637  matched how, many, own
 * Q: "Suggest some activities ... commute"  gold 0.386  matched commute, during, some
 *                                          deliv 0.693  matched activities, can, suggest, some, during
 * ```
 *
 * The noun is the discriminating term and it is always the rare one. Nothing in the pair `(question, turn)`
 * says which term that is, so the fix cannot live in `lexicalRelevance`'s two-argument form: it is a
 * **weight**, and `SearchIndex` is the only component that holds the corpus a weight needs.
 *
 * ## What is asserted, and against what
 *
 * The corpus below is written to reproduce the shape rather than copied from the dataset: one turn states the
 * thing asked about, several turn repeats the question's generic vocabulary, and the question is short. The
 * assertions are orderings, which is what a ranking defect is, and they are stated as a **pair** — the same
 * corpus ranks the distractor first under `flat` and the gold first under `idf`. A test that only asserted the
 * second half would pass on an implementation that ranked everything by length.
 *
 * The equality test is the other half: `flat` is not a new code path, it is the arithmetic this product has
 * always done, so `lexicalRelevance(q, t)` and `lexicalRelevance(q, t, () => 1)` must agree **exactly** rather
 * than within a tolerance.
 */
import { describe, expect, it } from 'vitest';

import { lexicalRelevance } from '../relevance.js';
import { SearchIndex } from '../retrieval/search-index.js';

/**
 * One corpus, shaped like a LongMemEval haystack: the answer, nine echo turns, and filler.
 *
 * `bikes` occurs once and `how`/`many`/`own` occur in nine of the ten turns. That density is chosen rather
 * than copied: a ten-turn corpus cannot reproduce a five-hundred-turn haystack's *counts*, so it reproduces
 * its **weight ratio** instead, which is the only thing the ranking reads. The shape being reproduced is the
 * measured one -- on `S14` a turn matching `how, many, own` outranked the turn naming the thing asked about.
 */
const CORPUS: readonly string[] = [
  "I've been reading about carbon fiber wheels for my bikes and I think I'll make the switch.",
  'How many of these should I plan for, and do I own the tools already?',
  'How many steps does it count, and can I own the data it collects?',
  'That depends how many rides you plan and what you already own.',
  'How many sessions you can own is a setting, not a limit.',
  'It depends how many you own and how many you plan to buy.',
  'You can own as many as you like; how many is up to you.',
  'How many you own today is the only number that counts.',
  'Whatever you own, the question is how many you actually use.',
  'The forecast says rain on Saturday, so bring a jacket.',
];

const QUESTION = 'How many bikes do I own?';

/** The gold turn's index in {@link CORPUS}. */
const GOLD = 0;

describe('lexicalRelevance with a weight: the same signal, priced by a corpus', () => {
  it('reproduces flat coverage exactly when every term is worth one', () => {
    // Not "close to": flat is the arithmetic this product has always done, and the sum of `n` ones is exactly
    // `n`, so the two calls have to produce the same double. A tolerance here would hide the day they do not.
    for (const turn of CORPUS) {
      expect(lexicalRelevance(QUESTION, turn, () => 1)).toBe(lexicalRelevance(QUESTION, turn));
    }
    expect(lexicalRelevance('', 'anything at all')).toBe(0);
  });

  it('scores a term priced at zero as no evidence rather than as NaN', () => {
    // A weight function is a caller's, and `0 / 0` would reach the sort as `NaN`, where comparisons are false
    // and the order becomes whatever the engine happens to do. `0` is the answer the two-argument form gives
    // a question with no content terms, and it is the same statement.
    expect(lexicalRelevance(QUESTION, CORPUS[GOLD]!, () => 0)).toBe(0);
  });

  it('stays inside [0, 1] for any non-negative weighting', () => {
    const arbitrary = (term: string): number => term.length;
    for (const turn of CORPUS) {
      const score = lexicalRelevance(QUESTION, turn, arbitrary);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it('keeps a one-term question scoring exactly its coverage', () => {
    // The order term is the coverage term when there are no adjacent pairs, and a weighting must not break
    // that: it is what keeps a single-term question from being scored below every two-term one.
    const turn = 'the commute was long';
    expect(lexicalRelevance('commute', turn, () => 3)).toBe(
      lexicalRelevance('commute', turn, () => 1),
    );
  });
});

describe('SearchIndex.lexicalWeighting: the product ranks with the corpus it holds', () => {
  it('ranks the distractor first under flat, which is the defect reproduced', async () => {
    const index = new SearchIndex({ channels: ['lexical'] });
    index.add(CORPUS);

    // Not a specific index: nine turns carry the same three words, so which of them wins is a tie broken by
    // arrival and says nothing. What has to be true is the shape -- the winner repeats the question's generic
    // vocabulary and does **not** name the thing asked about, and the turn that names it is ranked below.
    const hits = await index.search(QUESTION, CORPUS.length);
    expect(CORPUS[hits[0]!.turn]).not.toContain('bikes');
    expect(CORPUS[hits[0]!.turn]).toContain('own');
    expect(hits.findIndex((hit) => hit.turn === GOLD)).toBeGreaterThan(0);
  });

  it('ranks the gold turn first under idf, on the same corpus and question', async () => {
    const index = new SearchIndex({ channels: ['lexical'], lexicalWeighting: 'idf' });
    index.add(CORPUS);

    const hits = await index.search(QUESTION, CORPUS.length);
    expect(hits[0]?.turn).toBe(GOLD);
  });

  it('reports the score that produced the order, not the flat one', async () => {
    // `#searchOne` returns the channel's own score when no fusion happened, and the two places that score a
    // turn have to agree: a weighted order with a flat score beside it would make `SearchHit.score` a number
    // that ranks nothing.
    const index = new SearchIndex({ channels: ['lexical'], lexicalWeighting: 'idf' });
    index.add(CORPUS);

    const hits = await index.search(QUESTION, CORPUS.length);
    const scores = hits.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(scores[0]).toBeGreaterThan(scores[1] ?? 0);
  });

  it('is inert on the vector channel, which ranks no term at all', async () => {
    // The weighting is a statement about the lexical channel. A run that named `idf` and ranked by cosine must
    // not be refused, and must not change: the option is documented as ignored there.
    const index = new SearchIndex({
      channels: ['lexical'],
      lexicalWeighting: 'idf',
    });
    index.add([]);
    await expect(index.search(QUESTION, 4)).resolves.toEqual([]);
  });

  it('prices a query term the corpus never uses, and ranks with the rest', async () => {
    // A question about something the corpus never mentions is the ordinary case, not an exotic one: the
    // absent term has no postings entry, so its document frequency is zero and it earns the largest weight
    // there is -- and it can never be matched, so every candidate's coverage falls by the same share and the
    // order among them is decided by the terms that do exist.
    const index = new SearchIndex({ channels: ['lexical'], lexicalWeighting: 'idf' });
    index.add(CORPUS);

    const hits = await index.search('How many sailboats do I own?', CORPUS.length);
    expect(hits.length).toBeGreaterThan(0);
    expect(CORPUS[hits[0]!.turn]).toContain('own');
    // The ranking is still a ranking: the hits come back in non-increasing score order.
    const scores = hits.map((hit) => hit.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('refuses a weighting it does not administer, naming the two it does', () => {
    // Refused rather than defaulted for the reason `channels` refuses an unknown name: a misspelt weighting is
    // a line that reads as a treatment and ranks flat, so a candidate comparison would compare a configuration
    // with itself and publish the result as evidence that the treatment does nothing.
    expect(() => new SearchIndex({ lexicalWeighting: 'bm25' as 'idf' })).toThrow(
      /lexicalWeighting may only be "flat" or "idf", got "bm25"/,
    );
  });

  it('weighs against the corpus it holds, not against an empty one it saw first', async () => {
    // The weight is read at search time on purpose: `add()` fills the postings, and a weight captured in the
    // constructor would price every term against zero turns -- which is the flat scorer wearing a different
    // name, on a corpus that never had a say.
    const incremental = new SearchIndex({ channels: ['lexical'], lexicalWeighting: 'idf' });
    incremental.add([]);
    incremental.add(CORPUS);

    const atOnce = new SearchIndex({ channels: ['lexical'], lexicalWeighting: 'idf' });
    atOnce.add(CORPUS);

    const [stepwise, together] = await Promise.all([
      incremental.search(QUESTION, CORPUS.length),
      atOnce.search(QUESTION, CORPUS.length),
    ]);
    expect(stepwise).toEqual(together);
  });
});
