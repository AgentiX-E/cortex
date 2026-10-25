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
import { lexicalRelevance } from '../relevance.js';
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
    // while claiming to run this one.
    const provider = providerOf();
    await provider.ingest(SESSIONS);
    const hits = await provider.search('anything', { limit: 2 });
    expect(hits.length).toBeLessThanOrEqual(2);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('keeps the harness top-k and the product turn budget in their own units', async () => {
    // The defect this pins was invisible on the synthetic set, where one session is one turn, so "ten turns"
    // and "ten sessions" were the same number. On LongMemEval-S a session carries about ten turns, and folding
    // the top-k into the turn budget admitted **one** session per question: `recall@k 25.4%` against a lexical
    // index's 93.6%, which measured the adapter's unit error rather than the product.
    const wide = [
      {
        id: 'w0',
        at: T0,
        turns: Array.from({ length: 6 }, (_, i) => ({
          role: 'user' as const,
          content: `alpha note ${i}`,
        })),
      },
      {
        id: 'w1',
        at: T0 + DAY,
        turns: Array.from({ length: 6 }, (_, i) => ({
          role: 'user' as const,
          content: `beta note ${i}`,
        })),
      },
      {
        id: 'w2',
        at: T0 + 2 * DAY,
        turns: Array.from({ length: 6 }, (_, i) => ({
          role: 'user' as const,
          content: `gamma note ${i}`,
        })),
      },
    ];
    const provider = providerOf();
    await provider.ingest(wide);
    // Ten turns is less than two of these sessions; a top-k of two must still return two.
    expect(await provider.search('alpha beta gamma', { limit: 2 })).toHaveLength(2);
    expect(await provider.search('alpha beta gamma', { limit: 3 })).toHaveLength(3);
  });

  it('spends a configured turn budget across whole sessions, never splitting one', async () => {
    // The product's unit, unchanged: a session is admitted whole or not at all, so a budget of six admits one
    // six-turn session and no second. The top-k cannot make it admit more.
    const wide = [
      {
        id: 'w0',
        at: T0,
        turns: Array.from({ length: 6 }, (_, i) => ({
          role: 'user' as const,
          content: `alpha ${i}`,
        })),
      },
      {
        id: 'w1',
        at: T0 + DAY,
        turns: Array.from({ length: 6 }, (_, i) => ({
          role: 'user' as const,
          content: `beta ${i}`,
        })),
      },
    ];
    const provider = providerOf({ sessionBudget: 6 });
    await provider.ingest(wide);
    const hits = await provider.search('alpha beta', { limit: 10 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.text).toContain('alpha 0');
    expect(hits[0]!.text).not.toContain('beta 0');
  });

  it('equals the product functions applied by hand, which is the whole contract', async () => {
    const provider = providerOf({ sessionBudget: 3 });
    await provider.ingest(SESSIONS);
    const question = 'ignored';
    const hits = await provider.search(question, { limit: 10 });

    const gate = admissionOptionsFrom(T0 + 30 * DAY, {
      threshold: 0,
      retrievalThreshold: 0,
      sessionBudget: 3,
    });
    // The adapter must call `selectSessionBudget` with the same signal it ranks hits by, so the invariant is
    // restored with `lexicalRelevance` on both sides rather than with a weaker expectation.
    const relevance = (session: { turns: readonly { content: string }[] }): number =>
      session.turns.reduce(
        (best, turn) => Math.max(best, lexicalRelevance(question, turn.content)),
        0,
      );

    const expected = selectSessionBudget(
      admitSessions(
        SESSIONS.map((session) => session.turns.map((turn) => turn.content)),
        gate,
      ),
      3,
      relevance,
    )
      .map((session) => ({
        index: session.index,
        text: session.turns.map((turn) => turn.content).join('\n'),
        score: relevance(session),
      }))
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .map((entry) => entry.text);

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

  it('declares a model-free build, because the ranking signal reads no model', () => {
    // `embedding` would have been a false statement about the cost side of the ledger: `lexicalRelevance` is a
    // term-overlap function, and a comparison that says otherwise misreports what the run spent.
    expect(providerOf().build).toBe('none');
  });

  it('reads the query, and returns different sessions for different questions', async () => {
    // The previous release asserted the opposite — two questions over one store returned identical sessions,
    // because `bestValue` is constant and the ranking fell through to arrival order. The reversal is the
    // measurement: `all-gold` on the synthetic set moved from 8.3% to 100% when this changed, and the defect
    // was found by a harness rather than by a reader.
    const provider = providerOf();
    await provider.ingest(SESSIONS);
    const asked = await provider.search('moved to Berlin', { limit: 1 });
    const unrelated = await provider.search('two cats', { limit: 1 });
    expect(asked.map((hit) => hit.text)).not.toEqual(unrelated.map((hit) => hit.text));
    expect(asked[0]!.text).toContain('Berlin');
    expect(unrelated[0]!.text).toContain('cats');
  });

  it('falls back to arrival order when two questions cover their turns equally well', () => {
    // A limitation, asserted rather than left to be rediscovered. Coverage is normalised on the question, so
    // two questions that each match one of three terms in different sessions score identically, and the
    // tie-break is `session.index`. A term-weighting (IDF over the store, or an embedding) would separate them,
    // and either changes every number this signal produces — so it is a registered experiment, not an edit.
    const shared = lexicalRelevance('where does the user live', SESSIONS[0]!.turns[0]!.content);
    const other = lexicalRelevance('how many cats are there', SESSIONS[1]!.turns[0]!.content);
    expect(shared).toBe(other);
  });

  it('ranks its hits, because the position of a hit is read as its rank', async () => {
    // The product re-sorts selected sessions into arrival order before writing a prompt — a later session
    // listed first makes relative-time questions unanswerable. A retrieval interface is read for rank instead,
    // so presenting chronologically here would report a rank the selection never assigned. `s3` is the most
    // recent session and would be last in arrival order.
    const provider = providerOf();
    await provider.ingest(SESSIONS);
    const hits = await provider.search('moved to Berlin for a new job', { limit: 10 });
    expect(hits[0]!.text).toContain('Berlin');
    expect(hits.map((hit) => hit.score ?? 0)).toEqual(
      [...hits.map((hit) => hit.score ?? 0)].sort((a, b) => b - a),
    );
  });
});
