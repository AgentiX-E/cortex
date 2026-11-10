/**
 * `EmbeddingSpace`: the model that wrote a vector, bound to the index that holds it.
 *
 * ## Why this file exists
 *
 * `VectorIndex` has no notion of who produced the vectors it stores, and `EmbeddingModel` had no way
 * to say it. Width is refused two layers down (`dot` throws on a length mismatch), so the only
 * substitution that survives to a search is the one width cannot catch — a same-width model swap,
 * where every add succeeds and every score is a number between two unrelated spaces. `AUDIT-MODEL-
 * PORTABILITY.md` §7.0 finds the same shape in the literature (Goyal & Ray, arXiv:2609.05339: the
 * same store gains ten points one way and loses thirteen the other), and states that this repository
 * had a provenance record for the benchmark's cache and none for a deployment's index.
 *
 * So the assertions here are about **which combinations are refused**, not about the arithmetic of
 * cosine similarity, which `math.test.ts` covers:
 *
 *   - a non-empty index whose space nobody states is refused, because "assume it is the current
 *     model" is the substitution itself;
 *   - a stated space is checked against the model's own identity, comparing all four fields, and the
 *     refusal names every one that differs rather than the first;
 *   - the model is checked against itself (`identity().dimensions` against `dimension()`), because
 *     every later width check trusts the identity;
 *   - the two ways a model can answer wrongly — too few vectors, or the wrong width — are refusals
 *     rather than truncated work, since position is the only link between a text and its vector.
 *
 * The last block measures the failure the refusals prevent: two same-width embedders over the same
 * texts, where the mixed combination returns a confident ranking that is a different ranking.
 */

import { describe, expect, it } from 'vitest';
import { BruteForceVectorIndex } from '../vector/brute-force.js';
import {
  EmbeddingSpace,
  EmbeddingSpaceError,
  type EmbeddingSpaceRefusal,
} from '../vector/embedding-space.js';
import type { EmbeddingIdentity, EmbeddingModel } from '../interfaces/embedding.js';

/**
 * A model over a fixed table of texts, at a given width, optionally naming itself.
 *
 * Built as an object with a conditional spread rather than as a class with an optional method:
 * `exactOptionalPropertyTypes` is on in this repository, so `identity?: () => X` may be *absent* but
 * may not be *undefined*, and a class that assigns `undefined` is not an `EmbeddingModel`.
 */
function tableModel(
  table: Record<string, number[]>,
  width: number,
  declared?: EmbeddingIdentity,
): EmbeddingModel {
  return {
    dimension: () => width,
    embed: async (texts: string[]) =>
      texts.map((text) => new Float64Array(table[text] ?? new Array<number>(width).fill(0))),
    ...(declared === undefined ? {} : { identity: () => declared }),
  };
}

/** A model that answers with the wrong number of vectors, or the wrong width. */
function brokenModel(mode: 'short' | 'wide', declared?: EmbeddingIdentity): EmbeddingModel {
  return {
    dimension: () => 3,
    embed: async (texts: string[]) =>
      mode === 'short'
        ? texts.slice(1).map(() => new Float64Array([1, 0, 0]))
        : texts.map(() => new Float64Array([1, 0, 0, 0])),
    ...(declared === undefined ? {} : { identity: () => declared }),
  };
}

const spaceA: EmbeddingIdentity = {
  provider: 'zhipu',
  model: 'embedding-3',
  endpoint: 'https://open.bigmodel.cn/api/paas/v4',
  dimensions: 3,
};

const spaceB: EmbeddingIdentity = {
  provider: 'hash',
  model: null,
  endpoint: null,
  dimensions: 3,
};

const TABLE: Record<string, number[]> = {
  'kitchen faucet': [1, 0, 0],
  'kitchen mat': [0, 1, 0],
  toaster: [0, 0, 1],
  'kitchen faucet replaced': [0.9, 0.1, 0],
};

async function refusalOf(run: () => Promise<unknown>): Promise<EmbeddingSpaceError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(EmbeddingSpaceError);
    return error as EmbeddingSpaceError;
  }
  throw new Error('expected a refusal and got a result');
}

describe('EmbeddingSpace — the space it binds', () => {
  it('records the model identity on a fresh index and searches in it', async () => {
    const index = new BruteForceVectorIndex();
    const space = await EmbeddingSpace.open({
      model: tableModel(TABLE, 3, spaceA),
      index,
    });
    expect(space.identity).toEqual(spaceA);
    await space.add('a', 'kitchen faucet');
    await space.add('b', 'kitchen mat');
    await space.add('c', 'toaster');
    expect(await space.size()).toBe(3);
    const hits = await space.search('kitchen faucet replaced', 2);
    expect(hits.map((hit) => hit.id)).toEqual(['a', 'b']);
  });

  it('carries per-entry metadata through to the index so a filter still works', async () => {
    const index = new BruteForceVectorIndex();
    const space = await EmbeddingSpace.open({ model: tableModel(TABLE, 3, spaceA), index });
    await space.add('a', 'kitchen faucet', { tags: ['kitchen'] });
    await space.add('b', 'toaster', { tags: ['appliance'] });
    const hits = await space.search('kitchen mat', 2, { tags: ['kitchen'] });
    expect(hits.map((hit) => hit.id)).toEqual(['a']);
  });

  it('opens an empty index whose model does not name itself, and says the space is unknown', async () => {
    const space = await EmbeddingSpace.open({
      model: tableModel(TABLE, 3),
      index: new BruteForceVectorIndex(),
    });
    // `null`, not a filled-in guess: naming a space the model never stated is the substitution the
    // class exists to refuse, and a caller persisting `null` learns that it must state one next time.
    expect(space.identity).toBeNull();
    await space.add('a', 'toaster');
    expect(await space.size()).toBe(1);
  });
});

describe('EmbeddingSpace — the three refusals at open', () => {
  it('refuses a non-empty index whose space the caller did not state', async () => {
    const index = new BruteForceVectorIndex();
    await index.add('a', new Float64Array([1, 0, 0]));
    const error = await refusalOf(() =>
      EmbeddingSpace.open({ model: tableModel(TABLE, 3, spaceA), index }),
    );
    expect(error.reason).toBe<EmbeddingSpaceRefusal>('unstated');
    expect(error.message).toContain('holds 1 vector');
    // The model names itself and that is deliberately not enough: the question is who wrote the
    // vectors already in the index, and a model's self-description is a fact about the model.
    expect(await index.size()).toBe(1);
  });

  it('refuses a stated space when the model cannot say who it is', async () => {
    const index = new BruteForceVectorIndex();
    await index.add('a', new Float64Array([1, 0, 0]));
    const error = await refusalOf(() =>
      EmbeddingSpace.open({
        model: tableModel(TABLE, 3),
        index,
        stored: spaceA,
      }),
    );
    expect(error.reason).toBe<EmbeddingSpaceRefusal>('unidentifiable');
    expect(error.message).toContain('zhipu/embedding-3');
  });

  it('refuses each field of a stated space that differs, naming all of them', async () => {
    const cases: ReadonlyArray<readonly [Partial<EmbeddingIdentity>, string]> = [
      [{ provider: 'hash' }, 'provider'],
      [{ model: 'embedding-2' }, 'model'],
      [{ endpoint: 'https://example.test/v1' }, 'endpoint'],
      [{ dimensions: 4 }, 'dimensions'],
    ];
    for (const [change, field] of cases) {
      const index = new BruteForceVectorIndex();
      await index.add('a', new Float64Array([1, 0, 0]));
      const stored: EmbeddingIdentity = { ...spaceA, ...change };
      const error = await refusalOf(() =>
        EmbeddingSpace.open({ model: tableModel(TABLE, 3, spaceA), index, stored }),
      );
      expect(error.reason).toBe<EmbeddingSpaceRefusal>('mismatch');
      expect(error.message).toContain(`differing: ${field}`);
      expect(error.message).toContain('no error to see');
    }
  });

  it('names every differing field at once rather than the first', async () => {
    const index = new BruteForceVectorIndex();
    await index.add('a', new Float64Array([1, 0, 0]));
    const error = await refusalOf(() =>
      EmbeddingSpace.open({
        model: tableModel(TABLE, 3, spaceA),
        index,
        stored: {
          provider: 'hash',
          model: null,
          endpoint: 'https://elsewhere.test',
          dimensions: 3,
        },
      }),
    );
    expect(error.message).toContain('differing: provider, model, endpoint');
  });

  it('reopens an index whose stated space matches, and searches the existing vectors', async () => {
    const index = new BruteForceVectorIndex();
    const first = await EmbeddingSpace.open({ model: tableModel(TABLE, 3, spaceA), index });
    await first.add('a', 'kitchen faucet');
    const reopened = await EmbeddingSpace.open({
      model: tableModel(TABLE, 3, spaceA),
      index,
      stored: spaceA,
    });
    expect(reopened.identity).toEqual(spaceA);
    expect((await reopened.search('kitchen faucet', 1))[0]?.id).toBe('a');
  });

  it('refuses a model whose identity disagrees with its own dimension()', async () => {
    const error = await refusalOf(() =>
      EmbeddingSpace.open({
        model: tableModel(TABLE, 3, { ...spaceA, dimensions: 4 }),
        index: new BruteForceVectorIndex(),
      }),
    );
    expect(error.reason).toBe<EmbeddingSpaceRefusal>('width');
    expect(error.message).toContain('disagrees with itself');
  });
});

describe('EmbeddingSpace — vectors the caller embedded in batches', () => {
  it('accepts a precomputed vector at the space width and finds it by a precomputed query', async () => {
    // A caller that embeds a hundred turns per request to respect a provider's cap cannot use
    // `add`. It used to reach the index directly, which is the path most vectors in a real run take
    // and therefore the path that would have been left unchecked.
    const index = new BruteForceVectorIndex();
    const space = await EmbeddingSpace.open({ model: tableModel(TABLE, 3, spaceA), index });
    await space.addVector('a', new Float64Array([1, 0, 0]), { tags: ['kitchen'] });
    await space.addVector('b', new Float64Array([0, 1, 0]));
    expect(await space.size()).toBe(2);
    const hits = await space.searchVector(new Float64Array([0.9, 0.1, 0]), 2, {
      tags: ['kitchen'],
    });
    expect(hits.map((hit) => hit.id)).toEqual(['a']);
  });

  it('refuses both precomputed entry points at the wrong width', async () => {
    const space = await EmbeddingSpace.open({
      model: tableModel(TABLE, 3, spaceA),
      index: new BruteForceVectorIndex(),
    });
    const added = await refusalOf(() => space.addVector('a', new Float64Array([1, 0])));
    expect(added.reason).toBe<EmbeddingSpaceRefusal>('width');
    const searched = await refusalOf(() => space.searchVector(new Float64Array([1, 0]), 1));
    expect(searched.reason).toBe<EmbeddingSpaceRefusal>('width');
  });
});

describe('EmbeddingSpace — the two ways a model answers wrongly', () => {
  it('refuses a short list of vectors instead of shifting text against vector', async () => {
    const space = await EmbeddingSpace.open({
      model: brokenModel('short', spaceA),
      index: new BruteForceVectorIndex(),
    });
    const error = await refusalOf(() => space.embed(['a', 'b']));
    expect(error.reason).toBe<EmbeddingSpaceRefusal>('count');
    expect(error.message).toContain('1 vector(s) for 2 text(s)');
  });

  it('refuses a vector at the wrong width and names its position and the space', async () => {
    const space = await EmbeddingSpace.open({
      model: brokenModel('wide', spaceA),
      index: new BruteForceVectorIndex(),
    });
    const error = await refusalOf(() => space.embed(['a']));
    expect(error.reason).toBe<EmbeddingSpaceRefusal>('width');
    expect(error.message).toContain('vector 0 has 4 dimensions where this space is 3');
    expect(error.message).toContain('zhipu/embedding-3');
  });

  it('says "the model" rather than naming a space when the index is unstated', async () => {
    const space = await EmbeddingSpace.open({
      // A model that names no space at all: the empty index opens, and the width refusal is the
      // only one available, so its message must not claim a space that was never stated.
      model: brokenModel('wide'),
      index: new BruteForceVectorIndex(),
    });
    const error = await refusalOf(() => space.embed(['a']));
    expect(error.message).toContain('the model');
    expect(error.message).not.toContain(' at ');
  });
});

describe('EmbeddingSpace — the substitution the refusals prevent', () => {
  it('two models of one width rank the same store differently, and the width check cannot see it', async () => {
    const corpus = ['kitchen faucet', 'kitchen mat', 'toaster'];
    const modelOne = tableModel(TABLE, 3, spaceA);
    // Same width, unrelated space: the axes are rotated one position, which is what two unrelated
    // 1024-dimension models look like to a cosine — comparable numbers, no relation.
    const rotated: Record<string, number[]> = {
      'kitchen faucet': [0, 1, 0],
      'kitchen mat': [0, 0, 1],
      toaster: [1, 0, 0],
      'kitchen faucet replaced': [0.1, 0.9, 0],
    };
    const modelTwo = tableModel(rotated, 3, spaceB);

    const ownSpace = await EmbeddingSpace.open({
      model: modelOne,
      index: new BruteForceVectorIndex(),
    });
    for (const text of corpus) await ownSpace.add(text, text);
    const own = await ownSpace.search('kitchen faucet replaced', 3);

    const foreign = await modelTwo.embed(['kitchen faucet replaced']);
    const index = new BruteForceVectorIndex();
    for (const text of corpus) {
      const [vector] = await modelOne.embed([text]);
      await index.add(text, vector as Float64Array);
    }
    const mixed = await index.search(foreign[0] as Float64Array, 3);

    // Both searches return three hits with scores in range -- nothing in the index can tell.
    expect(own).toHaveLength(3);
    expect(mixed).toHaveLength(3);
    expect(own[0]?.id).toBe('kitchen faucet');
    expect(mixed[0]?.id).toBe('kitchen mat');
    // And the combination that produced the second ranking is refused by name when it is attempted
    // through the space, which is the difference between a wrong answer and a refused query.
    const error = await refusalOf(() =>
      EmbeddingSpace.open({ model: modelTwo, index, stored: spaceA }),
    );
    expect(error.reason).toBe<EmbeddingSpaceRefusal>('mismatch');
  });
});
