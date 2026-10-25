/**
 * The adapter, tested against the product's own functions rather than against a description of them.
 *
 * The invariant that matters is the eighth test: for one input, the adapter's hits equal
 * `admitSessions` + `selectSessionBudget` applied by hand. If the adapter ever grows a private copy of
 * selection logic, that test fails — which is the only mechanical defence against the defect this whole line
 * of work was started to fix (an ablation that reimplemented the mechanism it was measuring).
 */

import { describe, expect, it } from 'vitest';
import { admissionOptionsFrom } from '../admission.js';
import { admitSessions, selectSessionBudget } from '../sessionize.js';
import { CortexSessionProvider, type ProviderSession } from '../provider.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 1);

const SESSIONS: readonly ProviderSession[] = [
  {
    id: 's1',
    at: T0,
    turns: [
      { role: 'user', content: 'I live in London and work as an engineer in the city.' },
      { role: 'assistant', content: 'Noted: London, engineer.' },
    ],
  },
  {
    id: 's2',
    at: T0 + 10 * DAY,
    turns: [{ role: 'user', content: 'We adopted a second cat and now have two cats.' }],
  },
  {
    id: 's3',
    at: T0 + 20 * DAY,
    turns: [{ role: 'user', content: 'I moved to Berlin last month for a new job.' }],
  },
];

function providerOf(options: { now?: number; sessionBudget?: number; threshold?: number } = {}) {
  return new CortexSessionProvider({ now: options.now ?? T0 + 30 * DAY, ...options });
}

describe('CortexSessionProvider: the product retrieval as a provider', () => {
  it('reports what it ingested', async () => {
    const provider = providerOf();
    expect(await provider.ingest(SESSIONS)).toEqual({ sessions: 3, turns: 4, skipped: [] });
  });

  it('returns whole sessions rather than individual turns', async () => {
    const provider = providerOf();
    await provider.ingest(SESSIONS);
    const hits = await provider.search('where does the user live', { limit: 10 });
    expect(hits.length).toBeGreaterThan(0);
    const first = hits[0]!.text;
    // The session with two turns is what the product budgets in, so the boundary survives.
    expect(first.includes('London') && first.includes('Noted: London')).toBe(true);
  });

  it('carries the session timestamp, so a hit can be placed in time', async () => {
    const provider = providerOf();
    await provider.ingest(SESSIONS);
    const hits = await provider.search('anything', { limit: 10 });
    expect(hits.every((hit) => typeof hit.at === 'number')).toBe(true);
  });

  it('honours the limit', async () => {
    const provider = providerOf();
    await provider.ingest(SESSIONS);
    expect(await provider.search('anything', { limit: 1 })).toHaveLength(1);
  });

  it('excludes a session that had not happened yet when a date is given', async () => {
    const provider = providerOf();
    await provider.ingest(SESSIONS);
    const hits = await provider.search('anything', { limit: 10, asOf: T0 + 5 * DAY });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.at).toBe(T0);
  });

  it('admits everything at threshold zero, which is what an identity gate means', async () => {
    const provider = providerOf({ threshold: 0 });
    await provider.ingest(SESSIONS);
    expect(await provider.search('anything', { limit: 10 })).toHaveLength(3);
  });

  it('admits less at a high threshold, so the gate is not silently inert', async () => {
    const open = providerOf({ threshold: 0 });
    await open.ingest(SESSIONS);
    const closed = providerOf({ threshold: 0.99 });
    await closed.ingest(SESSIONS);
    const openHits = await open.search('anything', { limit: 10 });
    const closedHits = await closed.search('anything', { limit: 10 });
    expect(closedHits.length).toBeLessThan(openHits.length);
  });

  it('spends the session budget, which is the step this adapter exists to expose', async () => {
    const unbounded = providerOf({ sessionBudget: Number.POSITIVE_INFINITY });
    await unbounded.ingest(SESSIONS);
    const bounded = providerOf({ sessionBudget: 1 });
    await bounded.ingest(SESSIONS);
    expect(await unbounded.search('anything', { limit: 10 })).toHaveLength(3);
    // One session's worth of room: `selectSessionBudget` never returns empty, so exactly one is offered.
    expect(await bounded.search('anything', { limit: 10 })).toHaveLength(1);
  });

  it('lets the limit act as the ceiling when no budget was configured', async () => {
    // The harness's `limit` is a top-k, so a provider that ignored it would be running a different experiment
    // while claiming to run this one. It is a ceiling on **hits**, not on turns: the budget spends a turn
    // count, so a limit of two can still admit one session of three turns and no second session. That is the
    // product's unit, and the adapter does not translate it.
    const provider = providerOf();
    await provider.ingest(SESSIONS);
    const hits = await provider.search('anything', { limit: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('takes the smaller of the budget and the limit, so neither can silently override the other', async () => {
    const provider = providerOf({ sessionBudget: 3 });
    await provider.ingest(SESSIONS);
    expect(await provider.search('anything', { limit: 1 })).toHaveLength(1);
  });

  it('equals the product functions applied by hand, which is the whole contract', async () => {
    const provider = providerOf({ sessionBudget: 3 });
    await provider.ingest(SESSIONS);
    const hits = await provider.search('ignored', { limit: 10 });

    const gate = admissionOptionsFrom(T0 + 30 * DAY, {
      threshold: 0,
      retrievalThreshold: 0,
      sessionBudget: 3,
    });
    const expected = selectSessionBudget(
      admitSessions(
        SESSIONS.map((session) => session.turns.map((turn) => turn.content)),
        gate,
      ),
      3,
    ).map((session) => session.turns.map((turn) => turn.content).join('\n'));

    expect(hits.map((hit) => hit.text)).toEqual(expected);
  });

  it('returns nothing before anything was ingested', async () => {
    expect(await providerOf().search('anything', { limit: 5 })).toEqual([]);
  });

  it('forgets everything on reset', async () => {
    const provider = providerOf();
    await provider.ingest(SESSIONS);
    await provider.reset();
    expect(await provider.search('anything', { limit: 5 })).toEqual([]);
  });

  it('declares the cost of building its store', () => {
    // `embedding` because the product's relevance is vector-based. A comparison that hid this would be
    // comparing a model-built store against a lexical index without saying so.
    expect(providerOf().build).toBe('embedding');
  });

  it('does not read the query, and that is reported rather than fixed here', async () => {
    // The session budget ranks by recency and length, not by the question. Two different questions over one
    // store therefore return the same sessions — a property of the product, surfaced by the harness rather
    // than hidden by the adapter.
    const provider = providerOf();
    await provider.ingest(SESSIONS);
    const first = await provider.search('where does the user live', { limit: 10 });
    const second = await provider.search('how many cats are there', { limit: 10 });
    expect(first.map((hit) => hit.text)).toEqual(second.map((hit) => hit.text));
  });
});
