import { describe, expect, it } from 'vitest';

import {
  OFFLINE_INSTRUMENT_REPLY,
  OFFLINE_INSTRUMENT_VARIABLE,
  OFFLINE_INSTRUMENT_VERDICT,
  assertOfflineInstrumentConfiguration,
  assertOfflineInstrumentReached,
  offlineInstrument,
  offlineInstrumentRequested,
} from '../offline-instrument.js';
import { createJudgeFromEnv, createReadersFromEnv } from '../llm-factory.js';
import { createLlmJudge, parseJudgeResponse } from '../judge.js';

/**
 * An environment with no credential in it.
 *
 * The point of every test below that builds a reader is that the instrument does not *have* a
 * provider, so an environment carrying a key would let a broken branch pass by accident: the
 * factory would take the ordinary path, build a real client, and return a reader that answers over
 * the network. Absence is the fixture.
 */
const NO_KEY = { DEEPSEEK_MODEL: 'offline-instrument' } as const;

describe('offlineInstrumentRequested', () => {
  it('is on only for the spelling the dispatch writes', () => {
    expect(offlineInstrumentRequested({ [OFFLINE_INSTRUMENT_VARIABLE]: '1' })).toBe(true);
    expect(offlineInstrumentRequested({ [OFFLINE_INSTRUMENT_VARIABLE]: ' 1 ' })).toBe(true);
  });

  it('is off for every other value, including the ones that read as true', () => {
    // `'0'` is the case a truthiness test gets wrong, and `'true'` is the case a human operator
    // gets wrong when typing the dispatch input. Both mean "not an instrument", and both would
    // otherwise turn a paid benchmark into a constant that reports 0% accuracy.
    for (const raw of ['', '0', 'true', 'yes', 'off', undefined]) {
      expect(offlineInstrumentRequested({ [OFFLINE_INSTRUMENT_VARIABLE]: raw })).toBe(false);
    }
  });

  it('is off when the variable is absent from a completely empty environment', () => {
    expect(offlineInstrumentRequested({})).toBe(false);
  });
});

describe('offlineInstrument', () => {
  it('answers with the documented reply and counts the calls it was asked for', async () => {
    const llm = offlineInstrument();
    expect(llm.calls()).toBe(0);
    expect(await llm.complete('anything at all')).toBe(OFFLINE_INSTRUMENT_REPLY);
    expect(await llm.complete('a second prompt')).toBe(OFFLINE_INSTRUMENT_REPLY);
    expect(llm.calls()).toBe(2);
  });

  it('answers a structured request with an empty object rather than throwing', async () => {
    // The temporal and fact extractors destructure this call. A throw here would make the
    // instrument usable only on the routes that do not extract, which is a configuration
    // dependence nobody would see until a run with `temporal` on died at question one.
    const llm = offlineInstrument();
    const schema = { type: 'object' as const, properties: {}, required: [] };
    expect(await llm.completeStructured('extract', schema)).toEqual({});
    expect(llm.structuredCalls()).toBe(1);
    expect(llm.calls()).toBe(0);
  });

  it('keeps the two counters apart', async () => {
    const llm = offlineInstrument();
    await llm.complete('one');
    await llm.completeStructured('two', { type: 'object' });
    await llm.complete('three');
    expect(llm.calls()).toBe(2);
    expect(llm.structuredCalls()).toBe(1);
  });
});

describe('createReadersFromEnv under the instrument', () => {
  it('builds a reader with no credential in the environment', () => {
    // The absence of a key is the whole test: `requireKey` is what an ordinary run hits first, so a
    // branch placed after it would be unreachable in exactly the environment the instrument runs in.
    const { llm, readerByRoute } = createReadersFromEnv({
      ...NO_KEY,
      [OFFLINE_INSTRUMENT_VARIABLE]: '1',
    });
    expect(readerByRoute).toBeUndefined();
    return expect(llm.complete('question')).resolves.toBe(OFFLINE_INSTRUMENT_REPLY);
  });

  it('still refuses an environment with no credential when it is not an instrument', () => {
    // Pinned beside the branch above because the repair could have been "stop requiring the key", and
    // that repair would have made every ordinary run build a client with an empty bearer token and
    // collect a 401 on all five hundred questions.
    expect(() => createReadersFromEnv({ ...NO_KEY })).toThrow(/DEEPSEEK_API_KEY is required/);
  });

  it('ignores a thinking reach that would otherwise build a second client', () => {
    // `CORTEX_ARM_OFFLINE` answered before the reach is read, so a dispatch that also set
    // `DEEPSEEK_THINKING=multi-session` gets one instrument and no route map. The alternative -- a
    // per-route map of instruments -- would put two counters behind one census line.
    const { llm, readerByRoute } = createReadersFromEnv({
      ...NO_KEY,
      [OFFLINE_INSTRUMENT_VARIABLE]: '1',
      DEEPSEEK_THINKING: 'multi-session',
    });
    expect(readerByRoute).toBeUndefined();
    expect(llm).toBeDefined();
  });
});

describe('createJudgeFromEnv under the instrument', () => {
  it('answers the verdict with no credential in the environment', async () => {
    const judge = createJudgeFromEnv({ ...NO_KEY, [OFFLINE_INSTRUMENT_VARIABLE]: '1' });
    expect(await judge.complete('was this correct?')).toBe(OFFLINE_INSTRUMENT_VERDICT);
  });

  it('produces a verdict the scoring path reads as a verdict', async () => {
    // The value has to survive `parseJudgeResponse`, because the alternative is a constant that the
    // parser classifies as unparsable -- the run would then report every question as `unjudged` and
    // the census would say the scoring instrument never fired.
    expect(parseJudgeResponse(OFFLINE_INSTRUMENT_VERDICT)).toBe(false);
    const judge = createLlmJudge(
      createJudgeFromEnv({ ...NO_KEY, [OFFLINE_INSTRUMENT_VARIABLE]: '1' }),
    );
    await expect(
      judge(
        'What degree did I graduate with?',
        OFFLINE_INSTRUMENT_REPLY,
        'Business Administration',
      ),
    ).resolves.toBe(false);
  });

  it('still refuses an environment with no credential when it is not an instrument', () => {
    expect(() => createJudgeFromEnv({ ...NO_KEY })).toThrow(/DEEPSEEK_API_KEY is required/);
  });
});

describe('assertOfflineInstrumentConfiguration', () => {
  it('accepts the registered pair: the product ranks, and nothing is embedded', () => {
    expect(() =>
      assertOfflineInstrumentConfiguration({
        relevanceSignal: 'self-index',
        indexEmbedding: 'none',
      }),
    ).not.toThrow();
  });

  it('refuses a signal the harness owns, and says what would have been measured', () => {
    expect(() =>
      assertOfflineInstrumentConfiguration({
        relevanceSignal: 'retrieval',
        indexEmbedding: 'none',
      }),
    ).toThrow(/relevanceSignal must be "self-index".*"retrieval"/s);
  });

  it('names an unset index embedding as unset, because that is the registered default', () => {
    // The likeliest way to get here is not a typo but an omission: the arm parses an unset variable as
    // `undefined`, and `undefined` IS the registered `injected`. The message has to say which of the two
    // happened -- an operator who never set the variable and one who set it wrongly read different
    // repairs -- and `JSON.stringify(undefined)` renders nothing at all.
    expect(() => assertOfflineInstrumentConfiguration({ relevanceSignal: 'self-index' })).toThrow(
      /indexEmbedding must be "none"; this run named \(unset\)/,
    );
  });

  it('refuses a vector channel, because the run would pay for a channel it cannot move', () => {
    expect(() =>
      assertOfflineInstrumentConfiguration({
        relevanceSignal: 'self-index',
        indexEmbedding: 'injected',
      }),
    ).toThrow(/indexEmbedding must be "none".*"injected"/s);
  });
});

describe('assertOfflineInstrumentReached', () => {
  const report = (
    indexes: number | undefined,
    questionCount = 500,
  ): Parameters<typeof assertOfflineInstrumentReached>[0] => ({
    questionCount,
    memoryArmConfig: indexes === undefined ? {} : { selfIndex: { indexes } },
  });

  it('passes on exactly one index per question per run', () => {
    expect(() => assertOfflineInstrumentReached(report(500), 1)).not.toThrow();
    expect(() => assertOfflineInstrumentReached(report(2000), 4)).not.toThrow();
  });

  it('refuses a census that is absent, because nothing was rebuilt', () => {
    expect(() => assertOfflineInstrumentReached(report(undefined), 1)).toThrow(
      /no selfIndex census/,
    );
  });

  it('refuses a second index and prints both counts', () => {
    // The message has to carry the two numbers: a triage reader holding only "the instrument
    // retrieved twice" cannot tell a paired arm from a retry, and the two have different repairs.
    expect(() => assertOfflineInstrumentReached(report(1000), 1)).toThrow(
      /built 1000 index\(es\) over 500 question\(s\) x 1 run\(s\), where one retrieval per question per run is 500/s,
    );
  });

  it('refuses a run that built fewer indexes than questions, which is a different defect', () => {
    // Fewer means questions were answered without an index at all -- a filter that reached them
    // before retrieval. The equality is the assertion rather than an upper bound because both
    // directions are wrong and neither is the instrument working.
    expect(() => assertOfflineInstrumentReached(report(499), 1)).toThrow(/built 499 index/);
  });
});
