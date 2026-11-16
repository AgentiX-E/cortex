/**
 * What the vector channel does when the embedder cannot answer.
 *
 * ## The three deployments this separates
 *
 * A retrieval stack has one input it cannot supply by itself: the model that turns text into a vector.
 * `S14` priced its absence at 5.60 points (85.75% against 91.40%), which makes "run without it" a real
 * configuration rather than a broken one — the product has supported `embed` absent since the lexical
 * index existed.
 *
 * What it did not support is the third case: **the embedder is configured and then stops answering
 * mid-run**. Run `43866639154` is that case. An exhausted provider balance threw out of `#vectorOrder`,
 * through `lookup`, and killed a two-hour run at repetition 3 of 8 with `432` graded answers in memory.
 * The repair is not to swallow the error — a caller that asked for a vector channel and silently got
 * lexical scoring would believe the channel was working — but to make the degradation a **policy the
 * caller states and a count the artifact carries**.
 *
 * ## The two places it can fail, which are different
 *
 * `prime()` embeds the corpus once; `#vectorOrder` embeds the question. They fail for the same reason and
 * have different consequences:
 *
 *  - **A question that cannot be embedded** loses one retrieval's vector channel. The corpus vectors are
 *    intact, so the next question works if the provider recovers.
 *  - **A corpus that cannot be embedded** loses the channel for every question on that index. The corpus
 *    is embedded in batches, so the half-embedded case is reachable — and a partial table would be worse
 *    than none, because `#vectors[position]` has to correspond to `#turns[position]` and a short table
 *    would score every turn against its neighbour's vector. `prime()` therefore assigns only after the
 *    last batch, and these tests pin that the degraded path leaves the table empty rather than short.
 */
import { describe, it, expect } from 'vitest';
import { SearchIndex, foldIndexCost, type SearchIndexOptions } from '../retrieval/search-index.js';

const CORPUS = [
  'the kettle is in the kitchen and it boils water',
  'a bicycle needs two wheels and a chain',
  'the meeting moved to Thursday afternoon',
];

const REFUSAL = 'Embedding provider has no quota left: 429 Too Many Requests';

/**
 * An embedder that serves the corpus and then refuses.
 *
 * The shape of run `43866639154` rather than a hypothetical: the corpus came from the store, so `prime()`
 * needed no model call, and the first text that did need one was the question. A fake that refused from
 * the first call would exercise `prime()` and never reach the path that killed the run.
 */
function corpusThenRefusal(message = REFUSAL) {
  let refusing = false;
  const calls: number[] = [];
  const embed = async (texts: string[]): Promise<Float64Array[]> => {
    calls.push(texts.length);
    if (refusing) throw new Error(message);
    return texts.map(() => new Float64Array([1, 0, 0, 0]));
  };
  return {
    embed: embed as unknown as (texts: string[]) => Promise<Float64Array[]>,
    refuse: () => {
      refusing = true;
    },
    calls,
  };
}

function build(options: Partial<SearchIndexOptions> = {}): SearchIndex {
  const index = new SearchIndex({ k: 3, ...options });
  index.add(CORPUS);
  return index;
}

describe('a question the embedder cannot vectorise', () => {
  it('throws by default, because a silent fallback is a claim the caller did not make', async () => {
    // The default has to be the honest one. `indexEmbedding` in an artifact means the vector channel
    // ranked; a deployment that quietly scored lexically instead would publish numbers under a
    // configuration it did not run.
    const { embed, refuse } = corpusThenRefusal();
    const index = build({ embed });
    await index.prime();
    refuse();
    await expect(index.search('kettle')).rejects.toThrow(/no quota left/);
  });

  it('counts the degradation when the caller asks for the lexical fallback', async () => {
    const { embed, refuse } = corpusThenRefusal();
    const index = build({ embed, onEmbedFailure: 'lexical' });
    await index.prime();
    refuse();

    const hits = await index.search('kettle');
    // The lexical channel is intact: the turn sharing a term is first.
    expect(hits.length).toBeGreaterThan(0);
    expect(CORPUS[hits[0]!.turn]).toContain('kettle');

    const census = index.census();
    expect(census.embedDegraded).toBe(1);
    // The corpus vectors are still there, so this is one retrieval degraded rather than a lexical index.
    expect(census.vectors).toBe(CORPUS.length);
    expect(census.channels).toContain('vector');
    // And the provider's own words survive: "the balance is empty" and "the endpoint is wrong" have
    // different repairs, and the artifact is where a reader looks for which one it was.
    expect(census.embedFailure).toContain('no quota left');
  });

  it('keeps counting across questions rather than reporting the last one only', async () => {
    // A run is hundreds of retrievals. Reporting only the most recent degradation would let a run with
    // 400 failures and a run with one print the same table.
    const { embed, refuse } = corpusThenRefusal();
    const index = build({ embed, onEmbedFailure: 'lexical' });
    await index.prime();
    refuse();
    await index.search('kettle');
    await index.search('bicycle');
    await index.search('meeting');
    expect(index.census().embedDegraded).toBe(3);
  });

  it('still throws on a width mismatch, which is a client defect and not a provider failure', async () => {
    // The distinction the `try` is placed to preserve. `#vectorOrder` also refuses a ragged width, and
    // that refusal has to escape: two embedders wired together produces plausible, wrong rankings, and
    // no policy should be allowed to hide it behind a lexical fallback.
    let firstCall = true;
    const embed = async (texts: string[]): Promise<Float64Array[]> => {
      const width = firstCall ? 4 : 2;
      firstCall = false;
      return texts.map(() => new Float64Array(width).fill(1));
    };
    const primed = new SearchIndex({ k: 3, onEmbedFailure: 'lexical', embed: embed as never });
    primed.add(['short turn']);
    await primed.prime();
    await expect(primed.search('short')).rejects.toThrow(/dimensions/);
    expect(primed.census().embedDegraded).toBe(0);
  });
});

describe('a corpus the embedder cannot vectorise', () => {
  it('degrades to a lexical index instead of failing the answer', async () => {
    // `CortexMemory` builds one index per question, so `prime()` runs on every question and a refusal
    // there loses the whole retrieval stack rather than one ranking. The degraded result has to be the
    // configuration the product already ships for a deployment with no embedder.
    const embed = async (): Promise<Float64Array[]> => {
      throw new Error(REFUSAL);
    };
    const index = build({ embed: embed as never, onEmbedFailure: 'lexical' });
    await index.prime();

    const census = index.census();
    expect(census.embedDegraded).toBe(1);
    expect(census.vectors).toBe(0);
    expect(census.channels).not.toContain('vector');
    expect(census.channels).toContain('lexical');
    expect(census.embedFailure).toContain('no quota left');

    const hits = await index.search('kettle');
    expect(CORPUS[hits[0]!.turn]).toContain('kettle');
  });

  it('leaves the vector table empty rather than short, because a short one is worse', async () => {
    // The corpus is embedded in batches, so a refusal on the second batch is reachable. Assigning what
    // arrived would leave `#vectors[i]` describing `#turns[j]` — every turn scored against another
    // turn's vector, producing a ranking that looks like a disagreement and is a shifted table.
    let call = 0;
    const embed = async (texts: string[]): Promise<Float64Array[]> => {
      call += 1;
      // The first batch arrives; the second is refused. A caller sees a real partial success.
      if (call === 2) throw new Error(REFUSAL);
      return texts.map(() => new Float64Array([1, 0, 0, 0]));
    };
    const primed = new SearchIndex({
      k: 3,
      batch: 2,
      onEmbedFailure: 'lexical',
      embed: embed as never,
    });
    primed.add(CORPUS);
    await primed.prime();

    const census = primed.census();
    expect(census.embedDegraded).toBe(1);
    // Zero, not two: the two vectors that arrived cannot be indexed without lying about which turn they
    // describe, so the degraded path drops them and says so.
    expect(census.vectors).toBe(0);
  });

  it('still throws by default, so a batch cap cannot silently become a lexical index', async () => {
    const embed = async (): Promise<Float64Array[]> => {
      throw new Error(REFUSAL);
    };
    const index = build({ embed: embed as never });
    await expect(index.prime()).rejects.toThrow(/no quota left/);
  });
});

describe('a failure that is not an Error', () => {
  it('keeps the reason when the question could not be embedded', async () => {
    // `embed` is an injected function, so nothing constrains what it rejects with. Losing a non-Error
    // rejection to `String(error)` on the wrong branch would record the string "undefined" as the
    // reason, and the reason is the only thing that tells "the balance is empty" from "the endpoint is
    // wrong" -- a distinction with different repairs.
    const embed = async (texts: string[]): Promise<Float64Array[]> => {
      if (texts.length === 1) return Promise.reject('the provider is out of balance');
      return texts.map(() => new Float64Array([1, 0, 0, 0]));
    };
    const index = build({ embed, onEmbedFailure: 'lexical' });
    await index.prime();
    await index.search('kettle');
    expect(index.census().embedFailure).toBe('the provider is out of balance');
    expect(index.census().embedDegraded).toBe(1);
  });

  it('keeps the reason when the corpus could not be embedded', async () => {
    const embed = async (): Promise<Float64Array[]> => Promise.reject({ code: 1113 });
    const index = build({ embed: embed as never, onEmbedFailure: 'lexical' });
    await index.prime();
    // `String` on an object yields `[object Object]`, which is the honest rendering of a rejection
    // that named nothing a reader can act on -- better than dropping the fact that one happened.
    expect(index.census().embedFailure).toBe('[object Object]');
    expect(index.census().embedDegraded).toBe(1);
  });
});

describe('the degradation is counted where the bill is summed', () => {
  it('reports zero and no message on a run where the embedder worked', async () => {
    // The field is always present, so an artifact cannot distinguish "no failures" from "the field
    // predates the run" by absence. Zero is the reading for a healthy vector channel.
    const { embed } = corpusThenRefusal();
    const index = build({ embed, onEmbedFailure: 'lexical' });
    await index.prime();
    await index.search('kettle');
    const census = index.census();
    expect(census.embedDegraded).toBe(0);
    expect(census.embedFailure).toBeNull();
    expect(census.channels).toContain('vector');
  });

  it('folds into the run total, where a per-question census cannot reach', async () => {
    // `#lastIndex` is overwritten by the next question, so the run total is taken where the censuses are
    // produced. A field present in one and absent from the other would make the per-question table show a
    // degradation the run total denied.
    const { embed, refuse } = corpusThenRefusal();
    const index = build({ embed, onEmbedFailure: 'lexical' });
    await index.prime();
    refuse();
    await index.search('kettle');
    const cost = foldIndexCost(undefined, index.census());
    expect(cost.embedDegraded).toBe(1);
    const again = foldIndexCost(cost, index.census());
    expect(again.embedDegraded).toBe(2);
  });
});
