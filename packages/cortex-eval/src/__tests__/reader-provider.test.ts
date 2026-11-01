/**
 * The provider axis: a name a dispatch declares, the endpoint it resolves to, and the credential
 * that belongs to it.
 *
 * ## What these tests are arguing with
 *
 * §13.211.3 recorded that "does a stronger model help" is half-answered: every artifact in this
 * campaign is `deepseek-chat` with `thinking` on, so *"does thinking help"* has a control
 * (`41203245999`) and *"does a stronger model help"* does not. The obstacle was not the contract --
 * `DEEPSEEK_BASE_URL`, `DEEPSEEK_MODEL` and `DEEPSEEK_API_KEY` were all already read from the
 * environment -- it was that **switching meant substituting a second vendor's key into a variable
 * named after the first**, which no artifact can show and which the code cannot refuse.
 *
 * So the properties under test are the ones that turn a substitution into a declaration:
 *
 * 1. a provider is **named**, and the name is what the artifact prints;
 * 2. the name selects the **credential variable**, so a Zhipu run is refused with
 *    `ZHIPU_API_KEY is required` rather than sent to borrow DeepSeek's;
 * 3. an endpoint that is not the one the name implies is **reported**, not silently accepted --
 *    the property the old host-derived field was protecting, stated as a fact about the endpoint;
 * 4. every archived configuration resolves to the bytes it always rendered, which is what makes
 *    the change a widening rather than a re-baseline.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_DEEPSEEK_MODEL,
  readModelSelection,
  resolveReaderProvider,
  type ReaderProviderId,
} from '../reader-provider.js';

/**
 * Every provider the factory can build, stated as an exhaustive record rather than read from an
 * exported list.
 *
 * A `Record<ReaderProviderId, true>` is what makes this exhaustive: adding a provider to the union
 * fails to compile here until it is listed, so the loops below cannot silently keep covering the
 * three providers that existed when they were written. An exported array would compile either way.
 */
const EVERY_PROVIDER: Readonly<Record<ReaderProviderId, true>> = {
  deepseek: true,
  zhipu: true,
  custom: true,
};
const READER_PROVIDERS = Object.keys(EVERY_PROVIDER) as readonly ReaderProviderId[];

describe('readModelSelection', () => {
  it('falls back to the shipped provider when nothing names one', () => {
    expect(readModelSelection({})).toEqual({ id: 'deepseek', model: undefined });
    // An unfilled `workflow_dispatch` input arrives as `''`, not as an absent variable. Reading
    // it as a model id would send an empty `model` field to the provider, so it means "unset".
    expect(readModelSelection({ DEEPSEEK_MODEL: '' })).toEqual({
      id: 'deepseek',
      model: undefined,
    });
    expect(readModelSelection({ DEEPSEEK_MODEL: '   ' })).toEqual({
      id: 'deepseek',
      model: undefined,
    });
  });

  it('reads an unprefixed value as a model of the default provider', () => {
    // This is the branch every archived dispatch takes -- `model: 'deepseek-chat'` -- so it is the
    // one that has to keep meaning exactly what it meant before §13.212.
    expect(readModelSelection({ DEEPSEEK_MODEL: 'deepseek-chat' })).toEqual({
      id: 'deepseek',
      model: 'deepseek-chat',
    });
  });

  it('reads a prefix naming a shipped provider', () => {
    expect(readModelSelection({ DEEPSEEK_MODEL: 'zhipu:glm-4.6' })).toEqual({
      id: 'zhipu',
      model: 'glm-4.6',
    });
    // Explicitly naming the default provider is the same request as leaving it implicit, and it
    // has to resolve to the same thing -- otherwise an operator who spells it out gets a second
    // configuration to compare against by accident.
    expect(readModelSelection({ DEEPSEEK_MODEL: 'deepseek:deepseek-chat' })).toEqual({
      id: 'deepseek',
      model: 'deepseek-chat',
    });
  });

  it('reads a provider with no model as a request for that provider default', () => {
    // `zhipu:` is a complete statement -- "this provider, its default model" -- and not a
    // truncation. Returning `undefined` is what lets the declaration supply `glm-4.6` instead of
    // sending an empty model id.
    expect(readModelSelection({ DEEPSEEK_MODEL: 'zhipu:' })).toEqual({
      id: 'zhipu',
      model: undefined,
    });
    expect(readModelSelection({ DEEPSEEK_MODEL: 'zhipu: ' })).toEqual({
      id: 'zhipu',
      model: undefined,
    });
  });

  it('splits on the first colon, so a model id may contain one', () => {
    // An Ollama tag is the case that makes this load-bearing: `custom:qwen2.5:7b` names the
    // provider `custom` and the model `qwen2.5:7b`. Splitting on the last colon, or on every
    // colon, would lose the tag.
    expect(readModelSelection({ DEEPSEEK_MODEL: 'custom:qwen2.5:7b' })).toEqual({
      id: 'custom',
      model: 'qwen2.5:7b',
    });
  });

  it('folds the prefix case, because a dispatch input is typed by a person', () => {
    expect(readModelSelection({ DEEPSEEK_MODEL: 'ZHIPU:glm-4.6' }).id).toBe('zhipu');
    expect(readModelSelection({ DEEPSEEK_MODEL: ' Zhipu:glm-4.6 ' })).toEqual({
      id: 'zhipu',
      model: 'glm-4.6',
    });
  });

  it('refuses a prefix that is not a provider, and says how to make it one', () => {
    // The typo case. It must not fall through to "model id", because the run is not repeatable for
    // free: a run that silently answered with the DeepSeek default and printed `deepseek:...` would
    // be the artifact-describes-the-intent defect on a new axis.
    expect(() => readModelSelection({ DEEPSEEK_MODEL: 'openai:gpt-5' })).toThrow(
      /not a provider.*"deepseek", "zhipu", "custom"/s,
    );
  });

  it('turns the tag-separator mistake into the spelling that works', () => {
    // `qwen2.5:7b` looks like a provider prefix and is really a tag separator. The message has to
    // name the repair, because "unrecognised provider \"qwen2.5\"" sends an operator looking for a
    // provider called qwen rather than for the colon.
    expect(() => readModelSelection({ DEEPSEEK_MODEL: 'qwen2.5:7b' })).toThrow(
      /"custom:qwen2\.5:7b"/,
    );
  });
});

describe('resolveReaderProvider', () => {
  it('resolves the shipped provider from an empty environment', () => {
    expect(resolveReaderProvider({})).toEqual({
      id: 'deepseek',
      model: DEFAULT_DEEPSEEK_MODEL,
      baseUrl: DEFAULT_DEEPSEEK_BASE_URL,
      credentialVariable: 'DEEPSEEK_API_KEY',
      endpoint: 'matches',
    });
  });

  it('prefers the endpoint override generic to the provider-specific one', () => {
    // Two names for one fact, and the precedence is the point: `CORTEX_READER_*` is the surface a
    // user extends the factory through, so it has to win over the name the shipped workflow sets.
    expect(
      resolveReaderProvider({
        CORTEX_READER_BASE_URL: 'https://api.example.com/v1',
        DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
      }).baseUrl,
    ).toBe('https://api.example.com/v1');
    // And the provider-specific one still works alone, which is what every archived dispatch of a
    // proxy run used -- without this, naming the second provider would have broken them.
    expect(resolveReaderProvider({ DEEPSEEK_BASE_URL: 'https://api.example.com/v1' }).baseUrl).toBe(
      'https://api.example.com/v1',
    );
  });

  it('treats an empty override as absent, so an unset secret is not an endpoint', () => {
    // `ZHIPU_API_KEY` arrives as `''` when the org secret is not wired, and `??` would take it.
    // That is how a run reaches a URL nobody configured and dies on a 401 -- the failure
    // `embedding-factory` documents for the same reason.
    const provider = resolveReaderProvider({
      DEEPSEEK_BASE_URL: '',
      DEEPSEEK_MODEL: '   ',
      DEEPSEEK_API_KEY: '',
    });
    expect(provider.baseUrl).toBe(DEFAULT_DEEPSEEK_BASE_URL);
    expect(provider.model).toBe(DEFAULT_DEEPSEEK_MODEL);
    expect(provider.credentialVariable).toBe('DEEPSEEK_API_KEY');
  });

  it('matches an implied domain only at a dot boundary', () => {
    // Suffix matching is what accepts `beta.deepseek.com`; the leading dot is what rejects
    // `notdeepseek.com`, which is a different party's host with a similar name.
    expect(
      resolveReaderProvider({ DEEPSEEK_BASE_URL: 'https://beta.deepseek.com/v1' }).endpoint,
    ).toBe('matches');
    expect(
      resolveReaderProvider({ DEEPSEEK_BASE_URL: 'https://notdeepseek.com/v1' }).endpoint,
    ).toBe('overridden');
  });

  it('resolves the second provider, its endpoint and its credential', () => {
    const provider = resolveReaderProvider({ DEEPSEEK_MODEL: 'zhipu:glm-4.6' });
    expect(provider.id).toBe('zhipu');
    expect(provider.model).toBe('glm-4.6');
    expect(provider.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
    // §13.212's actual repair: the credential comes from a variable named after the provider that
    // serves the request. Before this, a Zhipu run had to put its key in `DEEPSEEK_API_KEY`, and
    // the refusal for a missing key named the wrong vendor.
    expect(provider.credentialVariable).toBe('ZHIPU_LLM_API_KEY');
    expect(provider.endpoint).toBe('matches');
  });

  it('names the seeded org secret when the specific variable is absent', () => {
    // `ZHIPU_API_KEY` is the name the org already seeds and the embedding factory already reads.
    // A reader that demanded a different name would be unusable on a runner that has the secret --
    // which is exactly the state this campaign's runner is in.
    expect(
      resolveReaderProvider({ DEEPSEEK_MODEL: 'zhipu:', ZHIPU_API_KEY: 'k' }).credentialVariable,
    ).toBe('ZHIPU_API_KEY');
    // And when neither is set the message has to name the **specific** one, not the generic
    // override, so the operator is pointed at the variable a workflow actually sets.
    expect(resolveReaderProvider({ DEEPSEEK_MODEL: 'zhipu:' }).credentialVariable).toBe(
      'ZHIPU_LLM_API_KEY',
    );
  });

  it('accepts both hosts the second provider serves', () => {
    // The mainland platform and the international one are the same vendor, so neither is an
    // override. Reporting one as an override would put a warning clause on a correct run.
    expect(
      resolveReaderProvider({
        DEEPSEEK_MODEL: 'zhipu:glm-4.6',
        ZHIPU_LLM_BASE_URL: 'https://api.z.ai/api/paas/v4',
      }).endpoint,
    ).toBe('matches');
    expect(
      resolveReaderProvider({
        DEEPSEEK_MODEL: 'zhipu:glm-4.6',
        ZHIPU_LLM_BASE_URL: 'https://proxy.internal/v4',
      }).endpoint,
    ).toBe('overridden');
  });

  it('does not let one provider variable re-point another provider', () => {
    // The collision this file avoids: `ZHIPU_BASE_URL` is the **embedding** factory's endpoint
    // variable. Had the reader reused it, a dispatch that moved the embeddings would silently have
    // moved the reader too, and the artifact would have shown two changed backends for one intent.
    const provider = resolveReaderProvider({
      DEEPSEEK_MODEL: 'zhipu:glm-4.6',
      ZHIPU_BASE_URL: 'https://embedding.example.com/v4',
      DEEPSEEK_BASE_URL: 'https://api.deepseek.com/v1',
    });
    expect(provider.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
  });

  it('lets the generic model override win over the provider default', () => {
    expect(resolveReaderProvider({ CORTEX_READER_MODEL: 'glm-4.5-air' }).model).toBe('glm-4.5-air');
    // And a model named in the selection wins over both, because the selection is what the
    // artifact records alongside the provider it belongs to.
    expect(
      resolveReaderProvider({ DEEPSEEK_MODEL: 'zhipu:glm-4.6', CORTEX_READER_MODEL: 'glm-4.5-air' })
        .model,
    ).toBe('glm-4.6');
  });

  it('makes no endpoint claim for a provider that declares none', () => {
    // Three states, and the third is why the field is not a boolean: `custom` says nothing about
    // where it points, so there is nothing to verify and nothing to report. Rendering it as
    // `overridden` would warn on every correctly configured custom run.
    const provider = resolveReaderProvider({
      DEEPSEEK_MODEL: 'custom:qwen2.5:7b',
      CORTEX_READER_BASE_URL: 'https://api.deepseek.com/v1',
    });
    expect(provider.endpoint).toBe('none');
    expect(provider.credentialVariable).toBe('CORTEX_READER_API_KEY');
  });

  it('refuses a custom provider with no endpoint, rather than borrowing one', () => {
    // The rule `EmbeddingProvenance` states for the hash fallback: naming a provider the process
    // never contacted is worse than naming none. A borrowed default would also make an
    // unconfigured dispatch look like a working one.
    expect(() => resolveReaderProvider({ DEEPSEEK_MODEL: 'custom:qwen2.5:7b' })).toThrow(
      /CORTEX_READER_BASE_URL/,
    );
  });

  it('refuses a custom provider with no model', () => {
    expect(() =>
      resolveReaderProvider({
        DEEPSEEK_MODEL: 'custom:',
        CORTEX_READER_BASE_URL: 'https://proxy.internal/v1',
      }),
    ).toThrow(/CORTEX_READER_MODEL/);
  });

  it('resolves a fully declared custom provider', () => {
    expect(
      resolveReaderProvider({
        DEEPSEEK_MODEL: 'custom:',
        CORTEX_READER_BASE_URL: 'https://proxy.internal/v1',
        CORTEX_READER_MODEL: 'house-model',
      }),
    ).toEqual({
      id: 'custom',
      model: 'house-model',
      baseUrl: 'https://proxy.internal/v1',
      credentialVariable: 'CORTEX_READER_API_KEY',
      endpoint: 'none',
    });
  });

  it('resolves without a credential, because the identity is not a permission', () => {
    // `createLlmFromEnv` refuses a missing key and must keep refusing it. If resolution also
    // needed one, the artifact's identity could only be produced by a process that could also
    // answer -- and a report built on a path running *because* the credential is wrong could not
    // say which backend it was about.
    for (const id of READER_PROVIDERS) {
      expect(() =>
        resolveReaderProvider({
          DEEPSEEK_MODEL: `${id}:model`,
          CORTEX_READER_BASE_URL: 'https://proxy.internal/v1',
        }),
      ).not.toThrow();
    }
  });

  it('names a credential variable for every provider', () => {
    // The invariant `firstNonEmptyName` relies on when it falls back to `names[0]`: every
    // declaration lists at least one variable, so a refusal always has a name to give. Stated as a
    // test rather than as a non-null assertion in the implementation, because the assertion would
    // hide the assumption instead of holding it.
    for (const id of READER_PROVIDERS) {
      const provider = resolveReaderProvider({
        DEEPSEEK_MODEL: `${id}:model`,
        CORTEX_READER_BASE_URL: 'https://proxy.internal/v1',
      });
      expect(provider.credentialVariable).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});
