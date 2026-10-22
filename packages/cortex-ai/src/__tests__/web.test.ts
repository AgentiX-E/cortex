/**
 * The platform language model: what it reports, and what it refuses.
 *
 * The refusal paths carry most of this file's weight, and deliberately so. "This browser has no
 * built-in model" is the state a user is actually in -- Chrome's Prompt API needs a supported
 * platform, a flag on some channels, and a multi-gigabyte download -- so a wrong answer there is
 * worse than an absent feature: it turns "not available on this device" into an exception thrown
 * from the middle of a conversation.
 *
 * The first test needs no injection at all: in Node the platform object genuinely is absent, so
 * `checkAvailability()` is being asked a real question about a real environment.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  PlatformLanguageModelAdapter,
  checkAvailability,
  readPlatform,
  type PlatformLanguageModel,
  type PlatformSession,
} from '../web/platform-language-model.js';
import * as webEntry from '../web/index.js';

afterEach(() => {
  delete (globalThis as { LanguageModel?: unknown }).LanguageModel;
});

/** A platform double: the API surface, driven by the test. */
function platform(
  status: Awaited<ReturnType<NonNullable<PlatformLanguageModel['availability']>>> = 'available',
  answer = 'answer',
): { platform: PlatformLanguageModel; calls: Record<string, unknown>[]; destroyed: () => number } {
  const calls: Record<string, unknown>[] = [];
  let destroyed = 0;
  return {
    calls,
    destroyed: () => destroyed,
    platform: {
      availability: async () => status,
      create: async (options) => {
        calls.push(options ?? {});
        return {
          prompt: async (text: string) => `${answer}:${text}`,
          destroy: () => {
            destroyed += 1;
          },
        };
      },
    },
  };
}

describe('checkAvailability', () => {
  it('reports absent in an environment that has no platform object', async () => {
    // No injection: this is the truth in Node, and it is the truth in every browser without the API.
    const report = await checkAvailability();
    expect(report).toEqual({
      available: false,
      status: 'absent',
      reason:
        'this environment has no built-in language model (globalThis.LanguageModel is undefined)',
    });
  });

  it('reports unavailable when the platform object has no probe', async () => {
    // Guessing "available" here would move the failure to the first prompt, where the caller gets
    // an exception instead of a sentence it can show.
    const report = await checkAvailability({ create: async () => ({ prompt: async () => '' }) });
    expect(report.status).toBe('unavailable');
    expect(report.reason).toContain('no availability() probe');
  });

  it('reports a non-Error thrown by the probe', async () => {
    // A platform shim can throw a string. Dropping the reason because it is not an Error would
    // leave "unavailable" with no explanation, which is the outcome this probe exists to avoid.
    const report = await checkAvailability({
      availability: async () => {
        throw 'not implemented';
      },
    });
    expect(report.reason).toContain('not implemented');
  });

  it('turns a throwing probe into a report rather than an exception', async () => {
    const report = await checkAvailability({
      availability: async () => {
        throw new Error('worker crashed');
      },
    });
    expect(report).toMatchObject({ available: false, status: 'unavailable' });
    expect(report.reason).toContain('worker crashed');
  });

  it.each([
    ['available', true, 'the model is on this device'],
    ['downloadable', false, 'the model is not on this device; create() would start a download'],
    ['downloading', false, 'the model is being downloaded'],
    ['unavailable', false, 'the platform reports no model'],
  ] as const)('maps %s to available=%s', async (status, available, reason) => {
    const report = await checkAvailability({ availability: async () => status });
    expect(report).toMatchObject({ available, status, reason });
  });

  it('an unknown status string is treated as no model, not as usable', async () => {
    const report = await checkAvailability({
      availability: async () => 'half-installed' as never,
    });
    expect(report).toMatchObject({ available: false, status: 'unavailable' });
  });
});

describe('readPlatform', () => {
  it('prefers the injected object over the global', () => {
    const injected: PlatformLanguageModel = { availability: async () => 'available' };
    (globalThis as { LanguageModel?: unknown }).LanguageModel = {
      availability: async () => 'unavailable',
    };
    expect(readPlatform(injected)).toBe(injected);
    expect(readPlatform()).not.toBe(injected);
  });

  it('returns undefined rather than throwing when nothing is installed', () => {
    expect(readPlatform()).toBeUndefined();
  });
});

describe('PlatformLanguageModelAdapter', () => {
  it('creates a session with the options it was built with', async () => {
    const { platform: fake, calls } = platform();
    const adapter = new PlatformLanguageModelAdapter({
      platform: fake,
      systemPrompt: 'be brief',
      temperature: 0.2,
      topK: 3,
      maxOutputTokens: 64,
    });

    expect(await adapter.complete('hi')).toBe('answer:hi');
    expect(calls[0]).toEqual({
      initialPrompts: [{ role: 'system', content: 'be brief' }],
      temperature: 0.2,
      topK: 3,
      maxOutputTokens: 64,
    });
  });

  it('omits what it was not given', async () => {
    const { platform: fake, calls } = platform();
    const adapter = new PlatformLanguageModelAdapter({ platform: fake });
    await adapter.complete('hi');
    expect(calls[0]).toEqual({});
  });

  it('reuses one session while the sampling stays the same', async () => {
    const { platform: fake, calls } = platform();
    const adapter = new PlatformLanguageModelAdapter({ platform: fake });
    await adapter.complete('one');
    await adapter.complete('two');
    expect(calls).toHaveLength(1);
  });

  it('rebuilds the session when a call asks for a different temperature', async () => {
    // The platform fixes sampling at creation. Silently keeping the old session would make the
    // second call's `temperature` a lie that no assertion downstream could catch.
    const { platform: fake, calls, destroyed } = platform();
    const adapter = new PlatformLanguageModelAdapter({ platform: fake });
    await adapter.complete('one');
    await adapter.complete('two', { temperature: 0.9 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.temperature).toBe(0.9);
    expect(destroyed()).toBe(1);
  });

  it('refuses a downloadable model instead of starting a multi-gigabyte download', async () => {
    const { platform: fake, calls } = platform('downloadable');
    const adapter = new PlatformLanguageModelAdapter({ platform: fake });
    await expect(adapter.complete('hi')).rejects.toThrow(/allowDownload/);
    expect(calls).toHaveLength(0);
  });

  it('starts the download only when the caller allowed it', async () => {
    const { platform: fake, calls } = platform('downloadable');
    const adapter = new PlatformLanguageModelAdapter({ platform: fake, allowDownload: true });
    expect(await adapter.complete('hi')).toBe('answer:hi');
    expect(calls).toHaveLength(1);
  });

  it('refuses when the platform reports no model at all', async () => {
    const { platform: fake } = platform('unavailable');
    const adapter = new PlatformLanguageModelAdapter({ platform: fake });
    await expect(adapter.complete('hi')).rejects.toThrow(/not usable here/);
  });

  it('refuses when the platform object cannot create a session', async () => {
    const adapter = new PlatformLanguageModelAdapter({
      platform: { availability: async () => 'available' },
    });
    await expect(adapter.complete('hi')).rejects.toThrow(/no create\(\)/);
  });

  it('discards a session that failed, so the next call starts clean', async () => {
    // Reusing a failed session turns one transient error into every subsequent call returning the
    // same thing, which reads as a model problem rather than as the stale state it is.
    let attempt = 0;
    let destroyed = 0;
    const fake: PlatformLanguageModel = {
      availability: async () => 'available',
      create: async () => {
        attempt += 1;
        const failing = attempt;
        return {
          prompt: async () => {
            if (failing === 1) throw new Error('first session broke');
            return 'recovered';
          },
          destroy: () => {
            destroyed += 1;
          },
        };
      },
    };
    const adapter = new PlatformLanguageModelAdapter({ platform: fake });
    await expect(adapter.complete('a')).rejects.toThrow('first session broke');
    expect(await adapter.complete('b')).toBe('recovered');
    expect(destroyed).toBe(1);
    expect(attempt).toBe(2);
  });

  it('propagates the platform error unchanged', async () => {
    const failure = new Error('quota exceeded');
    const adapter = new PlatformLanguageModelAdapter({
      platform: {
        availability: async () => 'available',
        create: async () => ({
          prompt: async () => {
            throw failure;
          },
        }),
      },
    });
    await expect(adapter.complete('a')).rejects.toBe(failure);
  });

  it('parses structured output, and says so when the model did not comply', async () => {
    // There is no JSON mode on the platform API: the schema goes into the prompt and the parse is
    // the check. A caller that assumed a grammar constraint would be relying on nothing.
    const adapter = new PlatformLanguageModelAdapter({
      platform: {
        availability: async () => 'available',
        create: async () => ({ prompt: async () => '{"answer": 1}' }),
      },
    });
    expect(
      await adapter.completeStructured('q', {
        type: 'object',
        properties: { answer: { type: 'number' } },
      }),
    ).toEqual({ answer: 1 });

    const disobedient = new PlatformLanguageModelAdapter({
      platform: {
        availability: async () => 'available',
        create: async () => ({ prompt: async () => 'I would rather not.' }),
      },
    });
    await expect(disobedient.completeStructured('q', { type: 'object' })).rejects.toThrow();
  });

  it('destroys the session, and tolerates being asked twice', async () => {
    const { platform: fake, destroyed } = platform();
    const adapter = new PlatformLanguageModelAdapter({ platform: fake });
    await adapter.complete('a');
    adapter.destroy();
    adapter.destroy();
    expect(destroyed()).toBe(1);
  });

  it('works without a destroy method on the session', async () => {
    const session: PlatformSession = { prompt: async () => 'ok' };
    const adapter = new PlatformLanguageModelAdapter({
      platform: { availability: async () => 'available', create: async () => session },
    });
    await adapter.complete('a');
    expect(() => adapter.destroy()).not.toThrow();
  });

  it('finds the platform on the global when none is injected', async () => {
    const { platform: fake } = platform('available', 'global');
    (globalThis as { LanguageModel?: unknown }).LanguageModel = fake;
    const adapter = new PlatformLanguageModelAdapter();
    expect(await adapter.complete('x')).toBe('global:x');
    expect((await adapter.availability()).available).toBe(true);
  });

  it('is reachable from the ./web entry', () => {
    expect(webEntry.PlatformLanguageModelAdapter).toBe(PlatformLanguageModelAdapter);
    expect(typeof webEntry.checkAvailability).toBe('function');
  });
});
