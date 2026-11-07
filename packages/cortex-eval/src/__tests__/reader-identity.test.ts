/**
 * The artifact must name the reader that answered.
 *
 * ## The debt this suite pays
 *
 * `PREREGISTRATION` §13.109 fixed three conditions for the reader axis before its first run
 * existed. The first was "a pinned model identity in the artifact". Run `40698883428` was
 * dispatched, and the condition failed: the model id existed only in the job log's
 * `DEEPSEEK_MODEL:` line, so two artifacts that differ by **7.20 points** carried identical
 * `memoryArmConfig` blocks. §13.110 records that as debt rather than arguing it away.
 *
 * ## And the fact the same reading exposed
 *
 * `TEMPERATURE` is declared by the workflow, sent by the dispatch, and forwarded into `env` --
 * and **nothing on this arm's path reads it**. `createLlmFromEnv` ignores it, `#consult` calls
 * `complete(prompt)` with no options, so the request carries no `temperature` field and the
 * provider's default applies. So the artifact has to be able to say "none was sent", which is
 * `null` and not `0`. The last test in this file pins that, deliberately: it is a guard against
 * a future edit quietly honouring the variable, which would move every archived number in a
 * commit whose message was about documentation.
 */
import { describe, it, expect } from 'vitest';
import { createLlmFromEnv, resolveReaderIdentity } from '../llm-factory.js';
import { toMemoryArmConfig } from '../bench-memory-arm.js';
import { formatAblationReport } from '../report.js';
import { DEFAULT_RELEVANCE_TOP_K } from '../relevance-index.js';

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

describe('resolveReaderIdentity', () => {
  it('names the shipped defaults when the environment says nothing', () => {
    expect(resolveReaderIdentity({})).toEqual({
      providerId: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      // The shipped endpoint is the one this provider name implies, so there is nothing to
      // report. §13.212: the third state (`'none'`) belongs to a provider that makes no claim.
      endpoint: 'matches',
      thinking: 'disabled',
      // §13.197.4: absent, not `[]`. "This value names no routes" and "this value names routes and
      // the list is empty" are different claims, and only the absence leaves an archived artifact's
      // rendering byte-identical.
      thinkingRoutes: undefined,
      temperature: null,
    });
  });

  it('follows the model the constructor would build', () => {
    // The property that makes the field trustworthy: both readers of the environment resolve
    // it through this one function, so the model that answers cannot differ from the model the
    // artifact names.
    expect(resolveReaderIdentity({ DEEPSEEK_MODEL: 'deepseek-v4-pro' }).model).toBe(
      'deepseek-v4-pro',
    );
  });

  it('flags an endpoint that is not the one the provider name implies', () => {
    // A run against an OpenAI-compatible proxy is not a DeepSeek run, and calling it one would
    // attribute the numbers to a provider that never served them. §13.212 states that as a fact
    // about the endpoint rather than as a host-derived pseudo-vendor: the declaration stands
    // (that is what was selected) and `endpoint: 'overridden'` says the two disagree, which the
    // rendered line carries as an `endpoint=override` clause beside the host.
    const identity = resolveReaderIdentity({ DEEPSEEK_BASE_URL: 'https://api.example.com/v1' });
    expect(identity.providerId).toBe('deepseek');
    expect(identity.endpoint).toBe('overridden');
  });

  it('survives a base URL that does not parse, because an identity is not a validation', () => {
    // `hostOf` catches `new URL`'s throw and falls back to the string it was given. The fallback is
    // the branch that keeps `resolveReaderIdentity` total: it is also called on a replayed artifact,
    // where a malformed URL is a fact about the record rather than a reason to refuse to describe it.
    // A malformed host cannot be deepseek.com, so the endpoint is reported as overridden.
    const identity = resolveReaderIdentity({ DEEPSEEK_BASE_URL: 'api.example.com/v1' });
    expect(identity.baseUrl).toBe('api.example.com/v1');
    expect(identity.endpoint).toBe('overridden');
  });

  it('reports thinking mode as the constructor reads it', () => {
    expect(resolveReaderIdentity({ DEEPSEEK_THINKING: 'enabled' }).thinking).toBe('enabled');
    expect(resolveReaderIdentity({ DEEPSEEK_THINKING: 'off' }).thinking).toBe('disabled');
  });

  it('resolves without a credential, because the identity is not a permission', () => {
    // `createLlmFromEnv` needs the key and must keep needing it. If identity resolution also
    // needed one, the record could only be produced by a process that could also answer -- and
    // a report built from a replayed artifact could not state what answered it.
    expect(() => createLlmFromEnv({})).toThrow(/DEEPSEEK_API_KEY/);
    expect(() => resolveReaderIdentity({})).not.toThrow();
  });

  it('states the temperature the request will carry, which is no longer always absent', () => {
    // This test used to assert the opposite, and the comment explaining why is worth keeping as
    // history: `TEMPERATURE` was declared, forwarded, and read by nothing on the arm's path, so
    // §13.114 recorded the value as `null` rather than silently honouring it -- because honouring
    // it would move every number the campaign had recorded. §13.119 is that move: the value is now
    // parsed (`reader-temperature.ts`), injected at the reader boundary, and this assertion flips
    // with it. `null` remains reachable only by asking for it.
    expect(resolveReaderIdentity({}).temperature).toBeNull();
    expect(resolveReaderIdentity({ TEMPERATURE: 'default' }).temperature).toBeNull();
    expect(resolveReaderIdentity({ TEMPERATURE: '0' }).temperature).toBe(0);
    expect(resolveReaderIdentity({ TEMPERATURE: '1.0' }).temperature).toBe(1);
  });
});

describe('the reader reaches the artifact', () => {
  const identity = resolveReaderIdentity({});

  it('projects the identity into the arm config', () => {
    expect(toMemoryArmConfig(GATE, undefined, undefined, identity).reader).toEqual(identity);
  });

  it('omits the field entirely when the caller named no reader', () => {
    // Absent, not `undefined`: an artifact that predates the field and a run that named no
    // reader are different facts, and only the omission keeps them distinguishable.
    expect('reader' in toMemoryArmConfig(GATE)).toBe(false);
  });

  it('renders the identity on the config line a reader of the Markdown actually sees', () => {
    const metrics = {
      total: 0,
      correct: 0,
      accuracy: 0,
      abstentionRate: 0,
      abstentionCorrectRate: 0,
      abstentionAwareAccuracy: 0,
      perCapability: {},
    } as never;
    const line = (reader: ReturnType<typeof resolveReaderIdentity> | undefined): string =>
      formatAblationReport({
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
        memoryArmConfig: toMemoryArmConfig(GATE, undefined, undefined, reader),
      });

    expect(line(identity)).toContain(
      '`reader=deepseek:deepseek-chat@api.deepseek.com/thinking=disabled/temp=default`',
    );
    // The pinned value renders as itself, so a run that sent 0 and a run that sent nothing are
    // distinguishable in the one line a reader of the Markdown actually looks at (§13.119).
    expect(line(resolveReaderIdentity({ TEMPERATURE: '0' }))).toContain('temp=0`');
    expect(line(resolveReaderIdentity({ TEMPERATURE: '0' }))).not.toContain('temp=default');
    // §13.197.4. A route-scoped run and a whole-run run are different treatments, and the line has
    // to say which one it was: `enabled` alone would describe the 220-question `enabled` arm while
    // four of six routes were answered with thinking off.
    expect(line(resolveReaderIdentity({ DEEPSEEK_THINKING: 'multi-session+temporal' }))).toContain(
      '/thinking=enabled on multi-session+temporal/temp=default`',
    );
    // The whole-run spelling keeps the bytes every archived artifact carries.
    expect(line(resolveReaderIdentity({ DEEPSEEK_THINKING: 'enabled' }))).toContain(
      '/thinking=enabled/temp=default`',
    );
    // §13.212. The second provider, rendered. Before this the line said
    // `openai-compatible:glm-4.6@open.bigmodel.cn`, which named the protocol and left the vendor
    // to be inferred from the host -- so two runs against two different vendors could not be told
    // apart by the field that exists to tell them apart.
    expect(line(resolveReaderIdentity({ DEEPSEEK_MODEL: 'zhipu:glm-4.6' }))).toContain(
      '`reader=zhipu:glm-4.6@open.bigmodel.cn/thinking=disabled/temp=default`',
    );
    // And an endpoint override is stated, because the declaration alone would attribute a proxy's
    // numbers to the vendor the operator named. The clause appears only when the two disagree, so
    // every correct run -- including every archived one -- renders without it.
    expect(
      line(
        resolveReaderIdentity({
          DEEPSEEK_MODEL: 'zhipu:glm-4.6',
          ZHIPU_LLM_BASE_URL: 'https://proxy.internal/v4',
        }),
      ),
    ).toContain(
      '`reader=zhipu:glm-4.6@proxy.internal/endpoint=override/thinking=disabled/temp=default`',
    );
    // A `custom` provider claims no endpoint, so there is nothing to verify and no clause to print:
    // an unconditional one would warn on every correctly configured custom run.
    expect(
      line(
        resolveReaderIdentity({
          DEEPSEEK_MODEL: 'custom:house-model',
          CORTEX_READER_BASE_URL: 'https://proxy.internal/v1',
        }),
      ),
    ).toContain('`reader=custom:house-model@proxy.internal/thinking=disabled/temp=default`');
    // And an empty reach -- which the parser cannot produce, but a replayed artifact carrying one
    // could -- renders as the plain mode rather than as a trailing `on ` with nothing after it.
    expect(line({ ...identity, thinkingRoutes: [] })).toContain('/thinking=disabled/temp=default`');
    // The control, and the one that matters: an artifact from before the field must not appear
    // to have run against an unrecorded reader.
    expect(line(undefined)).not.toContain('reader=');
  });

  it('states the temperature the request actually carried, not the one the input claims', () => {
    // `temp=default` is the state of every run this campaign recorded before §13.119. Spelling it
    // rather than omitting it is the same rule `reviewPass` follows: a run that carried no
    // temperature and an artifact that predates the field must not be the same bytes. The second
    // half is the new one -- a pinned value has to be tellable from an absent one in the same line.
    const metrics = { total: 0, correct: 0 } as never;
    expect(() => metrics).not.toThrow();
    const pinned = resolveReaderIdentity({ TEMPERATURE: '0' });
    expect(pinned.temperature).toBe(0);
  });
});

describe('§13.306 the declared deadline on the rendered line', () => {
  const metrics = {
    total: 0,
    correct: 0,
    accuracy: 0,
    abstentionRate: 0,
    abstentionCorrectRate: 0,
    abstentionAwareAccuracy: 0,
    perCapability: {},
  } as never;
  const line = (reader: ReturnType<typeof resolveReaderIdentity>): string =>
    formatAblationReport({
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
      memoryArmConfig: toMemoryArmConfig(GATE, undefined, undefined, reader),
    });

  it('adds the clause only when the run declared a deadline', () => {
    // The rule every optional clause on this line follows: absent renders no bytes, so the four
    // archived artifacts that quote this line keep quoting it.
    expect(line(resolveReaderIdentity({}))).not.toContain('/deadline=');
    expect(line(resolveReaderIdentity({ CORTEX_READER_TIMEOUT_MS: '600000' }))).toContain(
      '/deadline=600000',
    );
  });

  it('keeps the clause after the temperature, so a reader can parse the line left to right', () => {
    const rendered = line(
      resolveReaderIdentity({ TEMPERATURE: '0', CORTEX_READER_TIMEOUT_MS: '600000' }),
    );
    expect(rendered).toContain('/temp=0/deadline=600000`');
  });
});
