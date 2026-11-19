/**
 * The latch: one refusal closes the account for the rest of the process.
 *
 * ## What these tests are written against
 *
 * `44354315890` recorded `refusedCalls 431 / retriedCalls 0` against an account that had said
 * "余额不足" on the first one. Every assertion below is a statement about that arithmetic: the second
 * call must not reach the provider, the count must say how many did, and the error the caller sees must
 * stay the same type so that nothing above this layer learns a second vocabulary for one condition.
 *
 * ## Why the fake counts its own calls
 *
 * Because "did not reach the provider" is invisible from the outside -- a wrapper that threw a
 * convincing error after forwarding the request would satisfy every assertion written against the error
 * alone. The counter on the inner model is the only observer that can tell a latch from a lie.
 */

import { describe, expect, it, vi } from 'vitest';
import { EmbeddingQuotaExhaustedError } from '@agentix-e/cortex-ai';
import type { EmbeddingIdentity, EmbeddingModel } from '@agentix-e/cortex-core';
import { latchQuota, quotaLatchReading } from '../embedding-latch.js';

const IDENTITY: EmbeddingIdentity = {
  provider: 'zhipu',
  model: 'embedding-3',
  endpoint: 'https://open.bigmodel.cn/api/paas/v4',
  dimensions: 3,
};

/** A client that answers `[1,2,3]` and can be told to refuse instead. */
function fakeModel(options: { identity?: boolean; fail?: () => unknown } = {}): EmbeddingModel & {
  calls: number;
} {
  const model = {
    calls: 0,
    embed(texts: string[]): Promise<Float64Array[]> {
      model.calls += 1;
      const failure = options.fail?.();
      if (failure !== undefined) return Promise.reject(failure);
      return Promise.resolve(texts.map(() => new Float64Array([1, 2, 3])));
    },
    dimension: () => 3,
    ...(options.identity === false ? {} : { identity: () => IDENTITY }),
  };
  return model;
}

/** The refusal Zhipu returns when the balance is gone, as the client builds it. */
function quotaRefusal(detail = '{"error":{"code":"1113","message":"余额不足"}}'): Error {
  return new EmbeddingQuotaExhaustedError(
    `Embedding provider has no quota left: 429 Too Many Requests — ${detail}`,
    429,
    detail,
  );
}

describe('the latch closes on the first refusal', () => {
  it('refuses the second call without forwarding it, and says so in the counts', async () => {
    const inner = fakeModel({ fail: () => quotaRefusal() });
    const embedding = latchQuota(inner);

    await expect(embedding.embed(['a'])).rejects.toThrow(/no quota left/);
    expect(inner.calls).toBe(1);

    await expect(embedding.embed(['b'])).rejects.toThrow(/closed the latch/);
    expect(inner.calls).toBe(1);

    const reading = quotaLatchReading();
    expect(reading).not.toBeNull();
    expect(reading).toMatchObject({
      // One call left the process, one was refused by the provider, one was refused here.
      calls: 1,
      refusedByProvider: 1,
      refusedAfterLatch: 1,
      closure: { atCall: 1, status: 429, detail: '{"error":{"code":"1113","message":"余额不足"}}' },
    });
  });

  it('keeps refusing, and keeps counting, however many calls follow', async () => {
    const inner = fakeModel({ fail: () => quotaRefusal() });
    const embedding = latchQuota(inner);
    await expect(embedding.embed(['a'])).rejects.toThrow();
    for (let i = 0; i < 20; i += 1) {
      await expect(embedding.embed([`x${i}`])).rejects.toThrow(/no quota left/);
    }
    expect(inner.calls).toBe(1);
    expect(quotaLatchReading()).toMatchObject({
      calls: 1,
      refusedByProvider: 1,
      refusedAfterLatch: 20,
    });
  });

  it('names the first refusal in every later message, so a reader can price the run', async () => {
    const inner = fakeModel({ fail: () => quotaRefusal('{"error":{"code":"1113"}}') });
    const embedding = latchQuota(inner);
    await expect(embedding.embed(['a'])).rejects.toThrow();
    // The provider's own words survive into the local refusal: the first message is the only evidence
    // that this was a balance and not a key, and a wrapper that replaced it would delete that.
    await expect(embedding.embed(['b'])).rejects.toThrow(/1113/);
  });

  it('repeats the type and the status rather than inventing its own', async () => {
    const inner = fakeModel({ fail: () => quotaRefusal() });
    const embedding = latchQuota(inner);
    await expect(embedding.embed(['a'])).rejects.toThrow(EmbeddingQuotaExhaustedError);
    // Caught rather than matched by message, because the classification above this layer is by type.
    const second = await embedding.embed(['b']).catch((error: unknown) => error);
    expect(second).toBeInstanceOf(EmbeddingQuotaExhaustedError);
    expect((second as EmbeddingQuotaExhaustedError).status).toBe(429);
  });
});

describe('what does not close the latch', () => {
  it('a non-quota failure is rethrown and the next call still reaches the provider', async () => {
    let failing = true;
    const inner = fakeModel({
      fail: () => (failing ? new Error('Embedding request failed: 400 Bad Request') : undefined),
    });
    const embedding = latchQuota(inner);

    await expect(embedding.embed(['a'])).rejects.toThrow(/400/);
    failing = false;
    await expect(embedding.embed(['b'])).resolves.toHaveLength(1);
    expect(inner.calls).toBe(2);
    expect(quotaLatchReading()).toMatchObject({
      calls: 2,
      refusedByProvider: 0,
      refusedAfterLatch: 0,
      closure: null,
    });
  });

  it('an empty batch is forwarded like any other, and a success leaves the latch open', async () => {
    const inner = fakeModel();
    const embedding = latchQuota(inner);
    await expect(embedding.embed([])).resolves.toEqual([]);
    expect(quotaLatchReading()).toMatchObject({ calls: 1, closure: null });
  });
});

describe('a refusal that is already in flight when the latch closes', () => {
  it('counts as a provider refusal and does not move the boundary', async () => {
    // The real shape: the workers of a pass share one client, so several requests are in the provider's
    // hands when the first one comes back refused. Both cost a request; only the first says when.
    const inner = fakeModel({ fail: () => quotaRefusal() });
    const embedding = latchQuota(inner);
    const settled = await Promise.allSettled([embedding.embed(['a']), embedding.embed(['b'])]);
    expect(settled.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(inner.calls).toBe(2);
    expect(quotaLatchReading()).toMatchObject({
      calls: 2,
      refusedByProvider: 2,
      refusedAfterLatch: 0,
      closure: { atCall: 1, status: 429 },
    });
  });
});

describe('the wrapper forwards what the index needs', () => {
  it('forwards dimension', () => {
    expect(latchQuota(fakeModel()).dimension()).toBe(3);
  });

  it('forwards identity when the model states one', () => {
    // Load-bearing rather than tidy: `EmbeddingSpace` refuses to query a non-empty index whose space is
    // unstated, so a decorator that dropped this would make every vector index in the process unsearchable.
    expect(latchQuota(fakeModel()).identity?.()).toEqual(IDENTITY);
  });

  it('stays silent about identity when the model does, rather than answering undefined', () => {
    expect(latchQuota(fakeModel({ identity: false })).identity).toBeUndefined();
  });
});

describe('the reading is published, not returned', () => {
  it('reports null in a process that never built a latching client', async () => {
    // A fresh module registry, because the value is module state by design: the failure record is
    // written outside the scope where the client was built. `44354315890`'s handler could not have
    // closed over it either.
    vi.resetModules();
    const fresh = await import('../embedding-latch.js');
    expect(fresh.quotaLatchReading()).toBeNull();
  });

  it('reads the client built most recently, which in a one-embedding process is the only one', () => {
    const first = latchQuota(fakeModel());
    const second = latchQuota(fakeModel());
    expect(first).not.toBe(second);
    expect(quotaLatchReading()).toMatchObject({ calls: 0, closure: null });
  });
});
