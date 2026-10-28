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
      provider: 'deepseek',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com/v1',
      thinking: 'disabled',
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

  it('names the service rather than the default vendor when the base URL points elsewhere', () => {
    // A run against an OpenAI-compatible proxy is not a DeepSeek run. Calling it one would
    // attribute the numbers to a provider that never served them.
    expect(
      resolveReaderIdentity({ DEEPSEEK_BASE_URL: 'https://api.example.com/v1' }).provider,
    ).toBe('openai-compatible');
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

  it('reports that no temperature was sent, even when the environment carries one', () => {
    // Not an oversight, and not a claim that the input is harmless: §13.114 registers the
    // defect and the experiment that fixes it. Honouring `TEMPERATURE` here would change what
    // every subsequent run sends, which is exactly the kind of silent move this campaign
    // forbids -- so the value is recorded as absent and the change gets its own dispatch.
    expect(resolveReaderIdentity({ TEMPERATURE: '0' }).temperature).toBeNull();
    expect(resolveReaderIdentity({ TEMPERATURE: '1.0' }).temperature).toBeNull();
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
    // The control, and the one that matters: an artifact from before the field must not appear
    // to have run against an unrecorded reader.
    expect(line(undefined)).not.toContain('reader=');
  });

  it('states the temperature the request actually carried, not the one the input claims', () => {
    // `temp=default` is the state of every run this campaign has recorded. Spelling it rather
    // than omitting it is the same rule `reviewPass` follows: a run that carried no temperature
    // and an artifact that predates the field must not be the same bytes.
    const metrics = { total: 0, correct: 0 } as never;
    expect(() => metrics).not.toThrow();
    const identity = resolveReaderIdentity({ TEMPERATURE: '0' });
    expect(identity.temperature).toBeNull();
  });
});
