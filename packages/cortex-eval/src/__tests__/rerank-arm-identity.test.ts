/**
 * The arm's reranking switch is its own variable, and the artifact names what it built.
 *
 * ## The two failures this suite exists to prevent
 *
 * **Conflation.** `run-ablation.ts` builds both sides of the A/B in one process. If the arm read
 * `CORTEX_RERANK` — the variable the reference pipeline's arm already wires — then one dispatch would
 * hand a reranker to the treatment *and* to the paired control, and the resulting delta would compare
 * two reranked systems while the artifact claimed a single variable. That is the class of defect
 * §13.110 charged a whole run for on the reader axis, so the separation is asserted in both
 * directions rather than assumed.
 *
 * **An unnameable stage.** The counters say whether the stage executed; the identity says which model
 * it was. An artifact with only the counters cannot attribute a delta, and one with only the identity
 * cannot tell a `401` from an agreement. Both are asserted through the real report renderer, because a
 * field that exists in the JSON and never reaches the Markdown is a field no reader of the artifact
 * will see.
 */
import { describe, it, expect } from 'vitest';
import {
  createMemoryArmReranker,
  createRerankerFromEnv,
  resolveRerankBounds,
  resolveRerankIdentity,
} from '../rerank-factory.js';
import {
  assertRerankReachesRanking,
  toMemoryArmConfig,
  toRerankRecord,
} from '../bench-memory-arm.js';
import { formatAblationReport } from '../report.js';
import { DEFAULT_RELEVANCE_TOP_K } from '../relevance-index.js';
import type { RerankCensus } from '../rerank-census.js';

const GATE = {
  enabled: true,
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
  confidenceSignal: 'none',
  promptContract: 'abstention',
  ask: 'route',
  relevanceSignal: 'none',
  relevanceTopK: DEFAULT_RELEVANCE_TOP_K,
  relevanceUnits: 'turn',
  evidenceTurnsPerRecord: 256,
} as const;

const CENSUS: RerankCensus = { calls: 500, pairs: 128_000, fallbacks: 0, changed: 412, clipped: 3 };

describe('the arm switch is not the reference pipeline switch', () => {
  it('leaves the arm off when only the reference pipeline is enabled', () => {
    // The conflation guard. `CORTEX_RERANK=on` is what `bench-arm-options.ts` reads for the control's
    // own arm; the memory arm must not inherit it.
    expect(resolveRerankIdentity({ CORTEX_RERANK: 'on' }, { arm: true })).toEqual({
      provider: 'none',
    });
    expect(createMemoryArmReranker({ CORTEX_RERANK: 'on' }, {})).toBeUndefined();
  });

  it('leaves the reference pipeline off when only the arm is enabled', () => {
    const env = { CORTEX_MEMORY_RERANK: 'on', RERANK_API_KEY: 'k' };
    expect(resolveRerankIdentity(env)).toEqual({ provider: 'none' });
    expect(createRerankerFromEnv(env)).toBeUndefined();
  });

  it('resolves the arm on its own variable', () => {
    expect(resolveRerankIdentity({ CORTEX_MEMORY_RERANK: 'on' }, { arm: true })).toMatchObject({
      provider: 'openai-compatible',
    });
  });
});

describe('the identity names the service that will answer', () => {
  it('reports the published default when nothing is configured but the switch', () => {
    expect(resolveRerankIdentity({ CORTEX_MEMORY_RERANK: 'on' }, { arm: true })).toEqual({
      provider: 'openai-compatible',
      model: 'rerank-v3.5',
      host: 'api.cohere.com',
    });
  });

  it('names a non-default endpoint by its host, and never echoes the URL', () => {
    // The credential rule: a base URL can carry a query string, so the artifact records `URL.host`
    // and never the string it was handed.
    const identity = resolveRerankIdentity(
      {
        CORTEX_MEMORY_RERANK: 'on',
        CORTEX_MEMORY_RERANK_BASE_URL: 'https://open.bigmodel.cn/api/paas/v4?token=leak',
        CORTEX_MEMORY_RERANK_MODEL: 'rerank',
      },
      { arm: true },
    );
    expect(identity).toEqual({
      provider: 'openai-compatible',
      model: 'rerank',
      host: 'open.bigmodel.cn',
    });
    expect(JSON.stringify(identity)).not.toContain('token');
  });

  it('reports no host for the local cross-encoder, which talks to no service', () => {
    expect(
      resolveRerankIdentity(
        { CORTEX_MEMORY_RERANK: 'on', CORTEX_MEMORY_RERANK_PROVIDER: 'local' },
        { arm: true },
      ),
    ).toEqual({ provider: 'local', model: 'Xenova/ms-marco-MiniLM-L-6-v2', host: null });
  });

  it('resolves without a credential, because the identity is not a permission', () => {
    // The reader axis established this: if the record can only be produced by a process that could
    // also score, a report rendered from a replayed artifact cannot state what scored it.
    expect(() => createMemoryArmReranker({ CORTEX_MEMORY_RERANK: 'on' }, {})).toThrow(
      /RERANK_API_KEY/,
    );
    expect(() =>
      resolveRerankIdentity({ CORTEX_MEMORY_RERANK: 'on' }, { arm: true }),
    ).not.toThrow();
  });

  it('refuses a backend name in the enable slot, naming both variables', () => {
    // The mistake the two adjacent variables invite, and the one that cost a whole offline rerun
    // before the reference pipeline's factory was fixed.
    expect(() => resolveRerankIdentity({ CORTEX_MEMORY_RERANK: 'local' }, { arm: true })).toThrow(
      /CORTEX_MEMORY_RERANK="local" is a backend name/,
    );
  });

  it('refuses an unknown value rather than reading it as off', () => {
    expect(() => resolveRerankIdentity({ CORTEX_MEMORY_RERANK: 'yolo' }, { arm: true })).toThrow(
      /Unknown CORTEX_MEMORY_RERANK value/,
    );
  });
});

describe('the stage reaches the artifact', () => {
  const identity = resolveRerankIdentity({ CORTEX_MEMORY_RERANK: 'on' }, { arm: true });

  const record = (
    rerank: ReturnType<typeof toMemoryArmConfig>['rerank'],
  ): ReturnType<typeof toMemoryArmConfig> =>
    toMemoryArmConfig(GATE, undefined, undefined, undefined, rerank);

  const render = (rerank: ReturnType<typeof toMemoryArmConfig>['rerank']): string => {
    const metrics = {
      total: 0,
      correct: 0,
      accuracy: 0,
      abstentionRate: 0,
      abstentionCorrectRate: 0,
      abstentionAwareAccuracy: 0,
      perCapability: {},
    } as never;
    return formatAblationReport({
      dataset: 'fixture',
      questionCount: 0,
      baseline: { name: 'reference-pipeline', metrics },
      feature: { name: 'cortex-memory', metrics },
      ablation: {
        feature: 'cortex-memory',
        baselineAggregate: { min: 0, max: 0, avg: 0, median: 0 },
        featureAggregate: { min: 0, max: 0, avg: 0, median: 0 },
        delta: 0,
        pValue: Number.NaN,
        significant: false,
        effectSize: Number.NEGATIVE_INFINITY,
        baselineConfidence: { lower: 0, upper: 0 },
        featureConfidence: { lower: 0, upper: 0 },
        mcnemarPValue: 1,
        mcnemarSignificant: false,
        discordant: { baselineCorrectFeatureIncorrect: 0, baselineIncorrectFeatureCorrect: 0 },
        discordantQuestions: {
          baselineCorrectFeatureIncorrect: [],
          baselineIncorrectFeatureCorrect: [],
        },
        baselineMetrics: metrics,
        featureMetrics: metrics,
        featureCorrect: [],
        perCapability: {},
      } as never,
      generatedAt: '1970-01-01T00:00:00.000Z',
      memoryArmConfig: record(rerank),
    });
  };

  it('projects the identity and the census together', () => {
    expect(record({ ...identity, census: CENSUS })).toMatchObject({
      rerank: {
        provider: 'openai-compatible',
        model: 'rerank-v3.5',
        host: 'api.cohere.com',
        census: CENSUS,
      },
    });
  });

  it('omits the field entirely when the caller recorded nothing', () => {
    expect('rerank' in toMemoryArmConfig(GATE)).toBe(false);
  });

  it('renders the treatment on the configuration line', () => {
    expect(render({ ...identity, census: CENSUS })).toContain(
      '`rerank=openai-compatible:rerank-v3.5@api.cohere.com`',
    );
  });

  it('renders the control as `none` rather than omitting it', () => {
    // "Dispatched the control" and "predates the field" must not be the same bytes.
    expect(render({ provider: 'none' })).toContain('`rerank=none`');
  });

  it('renders the four counters in a section of their own', () => {
    const markdown = render({ ...identity, census: CENSUS });
    expect(markdown).toContain('## Rerank stage');
    expect(markdown).toContain('| 500 | 128000 | 0 | 412 (82.4%) |');
    expect(markdown).toContain('| 3 |');
  });

  it('names an assembly failure when the stage fell back, instead of printing a null result', () => {
    // The registered reading of §13.115: `fallbacks > 0` is unreadable, not negative. A report that
    // printed the counters without this sentence would let the delta be read as the reranker's.
    const markdown = render({
      ...identity,
      census: { calls: 500, pairs: 128_000, fallbacks: 500, changed: 0, clipped: 0 },
    });
    expect(markdown).toContain('Assembly failure, not a null result');
    expect(markdown).toContain('500 of 500 invocations');
  });

  it('distinguishes "ran and agreed" from "never ran"', () => {
    const agreed = render({
      ...identity,
      census: { calls: 500, pairs: 128_000, fallbacks: 0, changed: 0, clipped: 0 },
    });
    expect(agreed).toContain('The stage ran and reordered nothing');
    expect(agreed).not.toContain('Assembly failure');
  });

  it('says the arm is unmeasured when the census is missing', () => {
    // Not zeroed: `fallbacks: 0` is the most reassuring number in the record and must not be
    // fabricated for a run that could not measure it.
    const markdown = render({ ...identity });
    expect(markdown).toContain('no count below is available');
    expect(markdown).not.toContain('| 0 | 0 | 0 |');
  });

  it('renders the limits on the configuration line, because they change what the counters mean', () => {
    const rendered = render({
      ...resolveRerankIdentity({ CORTEX_MEMORY_RERANK: 'on' }, { arm: true }),
      bounds: { maxDocuments: 128, maxDocumentChars: 4096 },
      census: CENSUS,
    });
    expect(rendered).toContain(
      '`rerank=openai-compatible:rerank-v3.5@api.cohere.com/max=128turns,4096chars`',
    );
  });

  it('renders no section at all for the control', () => {
    expect(render({ provider: 'none' })).not.toContain('## Rerank stage');
  });
});

describe('the wire limits belong to the deployment, not to the library', () => {
  it('declares nothing when the deployment says nothing', () => {
    // Undeclared is the state of every run before the field and the correct state for a local
    // cross-encoder, which reads whole strings. Defaulting to one vendor's numbers would make a
    // Cohere deployment silently clip to Zhipu's limit.
    expect(resolveRerankBounds({})).toEqual({ maxDocuments: null, maxDocumentChars: null });
  });

  it('reads the numbers Zhipu publishes', () => {
    // 128 documents of at most 4,096 characters, from the endpoint's own reference page. These are
    // the numbers the workaround exists for: 129 documents is a rejected call, and one document of
    // 4,097 characters rejects the whole call rather than that document.
    expect(
      resolveRerankBounds({
        CORTEX_MEMORY_RERANK_MAX_DOCUMENTS: '128',
        CORTEX_MEMORY_RERANK_MAX_DOCUMENT_CHARS: '4096',
      }),
    ).toEqual({ maxDocuments: 128, maxDocumentChars: 4096 });
  });

  it('refuses zero rather than clipping every passage to nothing', () => {
    expect(() => resolveRerankBounds({ CORTEX_MEMORY_RERANK_MAX_DOCUMENT_CHARS: '0' })).toThrow(
      /positive integer/,
    );
    expect(() => resolveRerankBounds({ CORTEX_MEMORY_RERANK_MAX_DOCUMENTS: '128.5' })).toThrow(
      /positive integer/,
    );
  });

  it('treats a blank value as undeclared, because a dispatch leaves unused inputs empty', () => {
    expect(
      resolveRerankBounds({ CORTEX_MEMORY_RERANK_MAX_DOCUMENTS: '  ' }).maxDocuments,
    ).toBeNull();
  });
});

describe('the record is assembled where a test can reach it', () => {
  const identity = resolveRerankIdentity({ CORTEX_MEMORY_RERANK: 'on' }, { arm: true });
  const bounds = { maxDocuments: 128, maxDocumentChars: 4096 };

  it('carries identity, limits and census together for a treatment', () => {
    // Three together, because any one alone is the ambiguity §13.115 registers: which model, how wide
    // its wire limits were, and whether it actually answered.
    expect(toRerankRecord(identity, bounds, CENSUS)).toEqual({
      ...identity,
      bounds,
      census: CENSUS,
    });
  });

  it('spells the control as `none` and carries nothing else', () => {
    // A control has nothing to count and no model to name; a zeroed census here would claim the stage
    // ran and found nothing.
    expect(toRerankRecord({ provider: 'none' }, bounds, CENSUS)).toEqual({ provider: 'none' });
  });

  it('omits the census when the index could not report one', () => {
    // The replayed-artifact case: an identity without a census is honest, a zeroed census is not.
    const record = toRerankRecord(identity, bounds, undefined);
    expect('census' in record).toBe(false);
  });
});

describe('a reranker the ranking cannot reach is refused', () => {
  it('accepts the two signals that build a pool', () => {
    const stage = { provider: 'openai-compatible' as const };
    expect(() => assertRerankReachesRanking('retrieval', stage)).not.toThrow();
    expect(() => assertRerankReachesRanking('retrieval-hybrid', stage)).not.toThrow();
  });

  it('refuses the signals that build none, and names the variable to change', () => {
    // `none` spends arrival order and `retrieval-session` scores a session as one unit; neither leaves
    // a pool for a cross-encoder to permute, so the stage would fire zero times while the artifact
    // named it. The message has to say which line of the dispatch to change.
    for (const signal of ['none', 'retrieval-session']) {
      expect(() => assertRerankReachesRanking(signal, { provider: 'openai-compatible' })).toThrow(
        /CORTEX_MEMORY_RELEVANCE/,
      );
    }
  });

  it('says nothing when the run is the control', () => {
    expect(() => assertRerankReachesRanking('none', { provider: 'none' })).not.toThrow();
    expect(() => assertRerankReachesRanking('none', undefined)).not.toThrow();
  });
});
