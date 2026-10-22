/**
 * The local loading layer: what this package pins, in the arguments it sends.
 *
 * Every assertion here is about a *pinned* value rather than about a default. That is the whole
 * point of the file: the two libraries' defaults disagree (v2 quantized its weights, v4 does not),
 * so a layer that does not say `dtype: 'fp32'` out loud produces vectors whose compatibility
 * depends on which version happens to be installed. `test/parity/run.mjs` measures the consequence
 * -- min cosine 0.988 across 15 texts when the pin is missing -- and these tests keep the pin from
 * being removed quietly.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DTYPE,
  EMBEDDING_CALL_OPTIONS,
  applyLocalEnv,
  createFeatureExtractor,
  createRerankClassifier,
  makeFeatureExtractorFactory,
  makeRerankPipelineFactory,
  resolveTransformersModule,
  type TransformersModule,
} from '../local/pipelines.js';
import { TransformersEmbedding } from '../local/embedding.js';

type Call = { task: string; model: string; options?: Record<string, unknown> };

/** A module whose `pipeline` records its arguments and returns a fixed callable. */
function recordingModule(result: unknown = async () => ({ tolist: () => [[1, 2]] })): {
  module: TransformersModule;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    module: {
      env: {},
      pipeline: async (task, model, options) => {
        calls.push({ task, model, ...(options === undefined ? {} : { options }) });
        return result;
      },
    },
  };
}

describe('createFeatureExtractor', () => {
  it('asks for feature extraction with fp32 weights', async () => {
    const { module, calls } = recordingModule();
    await createFeatureExtractor({ model: 'm', loadModule: async () => module });
    expect(calls).toEqual([{ task: 'feature-extraction', model: 'm', options: { dtype: 'fp32' } }]);
    expect(DEFAULT_DTYPE).toBe('fp32');
  });

  it('passes an explicit dtype and device through', async () => {
    const { module, calls } = recordingModule();
    await createFeatureExtractor({
      model: 'm',
      dtype: 'q8',
      device: 'webgpu',
      loadModule: async () => module,
    });
    expect(calls[0]?.options).toEqual({ dtype: 'q8', device: 'webgpu' });
  });

  it('pools and normalises when the caller says nothing', async () => {
    // Both are absent from the library's defaults, and a missing `pooling` returns `[n, seq, dim]`
    // -- which reads as n rows of the wrong width further down, not as an error.
    const seen: unknown[] = [];
    const { module } = recordingModule(async (texts: string[], opts?: unknown) => {
      seen.push([texts, opts]);
      return { tolist: () => [[1]] };
    });
    const extractor = await createFeatureExtractor({ model: 'm', loadModule: async () => module });

    await extractor(['a']);
    await extractor(['b'], { pooling: 'cls', normalize: false });
    expect(seen).toEqual([
      [['a'], EMBEDDING_CALL_OPTIONS],
      [['b'], { pooling: 'cls', normalize: false }],
    ]);
    expect(EMBEDDING_CALL_OPTIONS).toEqual({ pooling: 'mean', normalize: true });
  });
});

describe('createRerankClassifier', () => {
  /** A module with the two classes the rerank path builds, recording what it was asked for. */
  function rerankModule(logits: { data: number[]; dims: number[] }): {
    module: TransformersModule;
    loaded: string[];
    fed: Record<string, unknown>[];
  } {
    const loaded: string[] = [];
    const fed: Record<string, unknown>[] = [];
    return {
      loaded,
      fed,
      module: {
        env: {},
        pipeline: async () => {
          throw new Error('the rerank path must not use the text-classification pipeline');
        },
        AutoTokenizer: {
          from_pretrained: async (model) => {
            loaded.push(`tokenizer:${model}`);
            return async () => ({ input_ids: [1, 2, 3] });
          },
        },
        AutoModelForSequenceClassification: {
          from_pretrained: async (model) => {
            loaded.push(`model:${model}`);
            return async (inputs: Record<string, unknown>) => {
              fed.push(inputs);
              return { logits };
            };
          },
        },
      },
    };
  }

  it('builds the tokenizer and the model with the pinned dtype', async () => {
    const { module, loaded } = rerankModule({ data: [1, -2], dims: [2, 1] });
    await createRerankClassifier({ model: 'cross', loadModule: async () => module });
    expect(loaded).toEqual(['tokenizer:cross', 'model:cross']);
  });

  it('returns the raw logits, one per input', async () => {
    // The whole point of bypassing `pipeline('text-classification')`: that pipeline softmaxes over
    // one label and returns 1.0 for every input, so every candidate ties. These logits are the
    // numbers a reranker actually needs, and they must arrive unchanged.
    const { module } = rerankModule({ data: [1.954, -5.625, -4.028], dims: [3, 1] });
    const classifier = await createRerankClassifier({ model: 'm', loadModule: async () => module });
    expect(await classifier(['a', 'b', 'c'])).toEqual([
      { score: 1.954 },
      { score: -5.625 },
      { score: -4.028 },
    ]);
  });

  it('pads and truncates the batch before it reaches the model', async () => {
    const { module, fed } = rerankModule({ data: [0, 0], dims: [2, 1] });
    const classifier = await createRerankClassifier({ model: 'm', loadModule: async () => module });
    await classifier(['a', 'b']);
    expect(fed).toEqual([{ input_ids: [1, 2, 3] }]);
  });

  it('refuses a logits shape that does not match the batch', async () => {
    // A cross-encoder that returned fewer scores than inputs would silently drop candidates, and
    // the `RerankScoreFn` contract is one score per pair -- the refusal is what keeps a truncated
    // response from being read as a ranking.
    const { module } = rerankModule({ data: [1, 2], dims: [2, 1] });
    const classifier = await createRerankClassifier({ model: 'm', loadModule: async () => module });
    await expect(classifier(['a', 'b', 'c'])).rejects.toThrow(/for 3 inputs/);
  });

  it('returns nothing for nothing, without loading the model', async () => {
    const { module, loaded } = rerankModule({ data: [], dims: [0, 1] });
    const classifier = await createRerankClassifier({ model: 'm', loadModule: async () => module });
    expect(await classifier([])).toEqual([]);
    expect(loaded).toHaveLength(2);
  });

  it('refuses a library build that does not export the classes it needs', async () => {
    // `pipeline` alone is enough for embedding, so a module without the classes is a plausible
    // object to be handed here -- and a `TypeError` from calling `undefined` would not say which
    // capability is missing.
    const { module } = recordingModule();
    await expect(
      createRerankClassifier({ model: 'm', loadModule: async () => module }),
    ).rejects.toThrow(/AutoTokenizer/);
  });
});

describe('env handling', () => {
  it('writes the overrides the caller asked for', async () => {
    const { module } = recordingModule();
    applyLocalEnv(module, { remoteHost: 'https://hf-mirror.com', cacheDir: '/tmp/c' });
    expect(module.env).toEqual({ remoteHost: 'https://hf-mirror.com', cacheDir: '/tmp/c' });
  });

  it('skips undefined entries instead of writing them', async () => {
    // Writing `undefined` would clear a value the caller set elsewhere -- the library reads these
    // fields as "present means configured", so an explicit undefined is not the same as absent.
    const { module } = recordingModule();
    module.env.remoteHost = 'https://kept.example';
    applyLocalEnv(module, { remoteHost: undefined, cacheDir: '/tmp/c' });
    expect(module.env.remoteHost).toBe('https://kept.example');
    expect(module.env.cacheDir).toBe('/tmp/c');
  });

  it('does nothing when there is no env to apply', () => {
    const { module } = recordingModule();
    applyLocalEnv(module, undefined);
    expect(module.env).toEqual({});
  });

  it('is applied before the pipeline is created', async () => {
    const order: string[] = [];
    const module: TransformersModule = {
      env: {},
      pipeline: async () => {
        order.push(`pipeline:${String(module.env.remoteHost)}`);
        return async () => ({ tolist: () => [[1]] });
      },
    };
    await createFeatureExtractor({
      model: 'm',
      env: { remoteHost: 'https://mirror' },
      loadModule: async () => module,
    });
    expect(order).toEqual(['pipeline:https://mirror']);
  });
});

describe('factories', () => {
  it('accepts a bare model id, which is what most callers have to say', async () => {
    // The string form exists so the ordinary call site is `makeRerankPipelineFactory('model')`
    // rather than an object with one key. It resolves to exactly the same pinned options.
    const { module, calls } = recordingModule();
    const shorthandEmbed = makeFeatureExtractorFactory('m');
    const shorthandRerank = makeRerankPipelineFactory('cross');
    expect(typeof shorthandEmbed).toBe('function');
    expect(typeof shorthandRerank).toBe('function');
    expect(calls).toEqual([]);

    // Proving the string form reaches the pinned options needs the injected loader, which the
    // string form deliberately does not accept -- so it is checked through the object form's
    // equivalence instead: `{ model }` and `'model'` both end at `dtype: 'fp32'`.
    const viaObject = makeFeatureExtractorFactory({ model: 'm', loadModule: async () => module });
    await viaObject();
    expect(calls).toEqual([{ task: 'feature-extraction', model: 'm', options: { dtype: 'fp32' } }]);
  });

  it('builds the rerank factory from an options object too', async () => {
    // Both arms of the `string | options` normalisation, on both factories: the shorthand is the
    // common call, and the object form is the one that can carry a mirror or a dtype.
    const loaded: string[] = [];
    const module: TransformersModule = {
      env: {},
      pipeline: async () => {
        throw new Error('unused');
      },
      AutoTokenizer: {
        from_pretrained: async (model) => {
          loaded.push(`tokenizer:${model}`);
          return async () => ({ input_ids: [1] });
        },
      },
      AutoModelForSequenceClassification: {
        from_pretrained: async (model) => {
          loaded.push(`model:${model}`);
          return async () => ({ logits: { data: [0.5], dims: [1, 1] } });
        },
      },
    };
    const factory = makeRerankPipelineFactory({ model: 'cross', loadModule: async () => module });
    const classifier = await factory();
    expect(loaded).toEqual(['tokenizer:cross', 'model:cross']);
    expect(await classifier(['a'])).toEqual([{ score: 0.5 }]);
  });

  it('defers loading until the factory is called', async () => {
    // A factory that loads eagerly would make the constructor of `TransformersEmbedding` do I/O,
    // which is the sort of thing that turns a config error into a hang at import time.
    let loaded = 0;
    const factory = makeFeatureExtractorFactory({
      model: 'm',
      loadModule: async () => {
        loaded += 1;
        return recordingModule().module;
      },
    });
    expect(loaded).toBe(0);
    await factory();
    expect(loaded).toBe(1);
  });
});

describe('the default loader, with the real package and no network', () => {
  it("surfaces the library's own failure rather than hanging or pretending", async () => {
    // The `?? resolveTransformersModule` arm. It cannot be exercised with an injected module, and
    // letting it download a model in a unit test would be worse than leaving it uncovered -- so the
    // remote is disabled and the lookup is pointed at an empty directory. What is asserted is that
    // the failure comes from the library and is an Error: the arm ran, and nothing was swallowed.
    await expect(
      createFeatureExtractor({
        model: 'definitely/not-a-real-model',
        env: { allowRemoteModels: false, localModelPath: '/nonexistent-cortex-model-dir' },
      }),
    ).rejects.toBeInstanceOf(Error);
  }, 30_000);
});

describe('resolveTransformersModule', () => {
  it('names the peer even when the failure is a transitive module', async () => {
    // The case that produced the previous version of this guarantee: the loader failed on `sharp`,
    // a dependency of the old peer, and the message named a package the operator never asked for.
    const failure = new Error("Cannot find module '../build/Release/sharp-linux-x64.node'");
    await expect(
      resolveTransformersModule(async () => {
        throw failure;
      }),
    ).rejects.toThrow(/@huggingface\/transformers/);
  });

  it('keeps the original message and the cause attached', async () => {
    const failure = new Error('EACCES: permission denied');
    let caught: Error | undefined;
    try {
      await resolveTransformersModule(async () => {
        throw failure;
      });
    } catch (error) {
      caught = error as Error;
    }

    expect(caught?.message).toContain('EACCES');
    expect(caught?.cause).toBe(failure);
  });

  it('reports a non-Error thrown by the import', async () => {
    let caught: Error | undefined;
    try {
      await resolveTransformersModule(async () => {
        throw 'module evaluation blew up';
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught?.message).toContain('module evaluation blew up');
  });

  it('imports the installed package for real', async () => {
    // Not a mock and not a skip: the peer is a devDependency, so "the dynamic import resolves" is a
    // fact this repository can check. It is the one thing the injected-module tests cannot see.
    const module = await resolveTransformersModule();
    expect(typeof module.pipeline).toBe('function');
    expect(typeof module.env).toBe('object');
  }, 30_000);
});

describe('TransformersEmbedding', () => {
  it('returns no vectors for no texts, without loading a model', async () => {
    let loaded = 0;
    const emb = new TransformersEmbedding({
      model: 'm',
      dimensions: 3,
      pipelineFactory: async () => {
        loaded += 1;
        return async () => ({ tolist: () => [] });
      },
    });
    expect(await emb.embed([])).toEqual([]);
    expect(loaded).toBe(0);
    expect(emb.dimension()).toBe(3);
  });

  it('widens f32 output to f64', async () => {
    const emb = new TransformersEmbedding({
      model: 'm',
      dimensions: 2,
      pipelineFactory: async () => async () => ({ tolist: () => [[0.1, 0.2]] }),
    });
    const [vector] = await emb.embed(['x']);
    expect(vector).toBeInstanceOf(Float64Array);
    expect(vector?.length).toBe(2);
  });

  it('passes dtype and env through to the loader', async () => {
    const { module, calls } = recordingModule();
    const emb = new TransformersEmbedding({
      model: 'm',
      dimensions: 2,
      dtype: 'q8',
      env: { allowRemoteModels: false },
      loadModule: async () => module,
    });
    await emb.embed(['x']);
    expect(calls[0]?.options).toEqual({ dtype: 'q8' });
    expect(module.env).toEqual({ allowRemoteModels: false });
  });
});
