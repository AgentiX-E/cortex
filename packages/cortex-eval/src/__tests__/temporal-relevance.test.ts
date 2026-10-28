import { describe, expect, it } from 'vitest';

import { buildRetrievalRelevanceIndex } from '../relevance-index.js';
import { temporalBoosts } from '../temporal-relevance.js';

/**
 * The temporal signal, as a pure function before it is a ranking.
 *
 * ## Why this is tested away from the index
 *
 * The same reason `session-relevance.ts` is: a signal that is only observable through a 500-question run
 * cannot be debugged, and a bucket boundary that is off by one day produces a number that looks like a
 * finding. Everything here is arithmetic on two instants, so it is decidable without a corpus, a model or a
 * key — and the index-level test only has to prove the arithmetic reaches the ordering.
 */
const DAY = 86_400_000;
const ASKED = Date.UTC(2024, 4, 20);

/**
 * The half-life the contract states, restated here rather than imported.
 *
 * A test that read the constant from the implementation would pass for any value it found there. Written out,
 * changing the implementation's half-life breaks this file — which is what a contract is for. The decay is
 * probed through `affinityFor`, because that is the value the ranking consumes and it is the only export.
 */
const HALF_LIFE_DAYS = 30;

/** One turn's affinity, via the only public surface. */
function affinity(turnAt: unknown, askedAt: unknown): number {
  return temporalBoosts({
    context: ['turn'],
    turnDates: [turnAt as number | null | undefined],
    askedAt: askedAt as number | null | undefined,
  }).affinityFor('turn');
}

describe('temporalAffinity', () => {
  it('scores a turn from the same day as 1, and never above it', () => {
    expect(affinity(ASKED, ASKED)).toBe(1);
  });

  it('halves at the half-life, which is the one constant the signal has', () => {
    // Stated as a property of the exported constant rather than of the literal 30, so changing the
    // half-life changes what this asserts instead of breaking it.
    expect(affinity(ASKED - HALF_LIFE_DAYS * DAY, ASKED)).toBeCloseTo(0.5, 10);
    expect(affinity(ASKED + HALF_LIFE_DAYS * DAY, ASKED)).toBeCloseTo(0.5, 10);
  });

  it('is symmetric, because "how far" is a distance and not a direction', () => {
    // A turn before the question and a turn after it are equally distant. Asymmetric decay would encode
    // "older is worse" as well as "further is worse", and LongMemEval's temporal questions ask about both
    // directions -- "how many days between" has no preferred order.
    const before = affinity(ASKED - 7 * DAY, ASKED);
    const after = affinity(ASKED + 7 * DAY, ASKED);
    expect(before).toBeCloseTo(after, 12);
  });

  it('decreases monotonically as the distance grows', () => {
    const distances = [0, 1, 2, 7, 30, 90, 365, 3650];
    const scores = distances.map((days) => affinity(ASKED - days * DAY, ASKED));
    for (let position = 1; position < scores.length; position += 1) {
      expect(scores[position]!).toBeLessThan(scores[position - 1]!);
    }
  });

  it('stays inside the unit interval at every distance a corpus can hold', () => {
    for (const days of [0, 1, 30, 365, 36_500, 365_000]) {
      for (const sign of [-1, 1]) {
        const value = affinity(ASKED + sign * days * DAY, ASKED);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it('scores a turn with no instant as zero rather than as distant', () => {
    // The distinction the whole signal depends on. Scoring an undated turn low would make "this turn has no
    // date" and "this turn is far from the question" the same statement, and the corpus has both: every
    // session in LongMemEval carries a date, but a synthetic arm's turns may not. A zero contribution
    // leaves such a turn exactly where the semantic signal put it.
    expect(affinity(undefined, ASKED)).toBe(0);
    expect(affinity(null, ASKED)).toBe(0);
  });

  it('scores nothing at all when the question has no instant', () => {
    // Symmetric to the row above: without an anchor there is no distance, so the signal is inert rather
    // than anchored at the epoch -- which would score the newest turn highest on every undated question
    // and look like a finding.
    expect(affinity(ASKED, undefined)).toBe(0);
    expect(affinity(ASKED, null)).toBe(0);
  });

  it('refuses an instant that is not a finite number instead of propagating it', () => {
    // `NaN` compares false against everything, so a single one would sort a turn to a position that
    // depends on the sort implementation rather than on the signal.
    expect(affinity(Number.NaN, ASKED)).toBe(0);
    expect(affinity(Number.POSITIVE_INFINITY, ASKED)).toBe(0);
    expect(affinity(ASKED, Number.NaN)).toBe(0);
  });
});

describe('temporalBoosts', () => {
  const context = ['a', 'b', 'c'];

  it('maps every turn in the context, and reports which it could score', () => {
    const boosts = temporalBoosts({
      context,
      turnDates: [ASKED, ASKED - 30 * DAY, null],
      askedAt: ASKED,
    });

    expect(boosts.affinityFor('a')).toBe(1);
    expect(boosts.affinityFor('b')).toBeCloseTo(0.5, 10);
    expect(boosts.affinityFor('c')).toBe(0);
    // The census that separates "fired" from "never fired". A zero-length population and a population of
    // zeros are the same number in any average, and they mean opposite things.
    expect(boosts.scored).toBe(2);
    expect(boosts.total).toBe(3);
  });

  it('takes the closest instant when one text appears twice', () => {
    // A repeated turn text is a real state in this corpus, and `relevanceFor` is keyed by text, so the two
    // occurrences are one lookup. `session-relevance.ts` resolved the same collision by taking the
    // best-ranked session; the equivalent here is the instant that makes the text most relevant, because
    // the signal is a property of the text as the reader will see it. Taking the first would make the
    // answer depend on arrival order.
    const duplicated = temporalBoosts({
      context: ['dup', 'dup'],
      turnDates: [ASKED - 300 * DAY, ASKED],
      askedAt: ASKED,
    });
    expect(duplicated.affinityFor('dup')).toBe(1);
    // And both census counts are in the text domain, because `affinityFor` is: two positions with one text
    // is one answer, and counting positions would overstate the signal's reach by exactly the amount it is
    // least useful -- on the corpora where turns repeat.
    expect(duplicated.scored).toBe(1);
    expect(duplicated.total).toBe(1);
  });

  it('answers zero for a turn it was not given, without throwing', () => {
    // Total, like `relevanceFor`: the index is asked about every admitted turn, and a turn from another
    // question's context is not an error at this layer.
    const boosts = temporalBoosts({ context, turnDates: [ASKED, null, null], askedAt: ASKED });
    expect(boosts.affinityFor('not-in-this-case')).toBe(0);
  });

  it('reports no scored turn when the dates array is missing or short', () => {
    // Absent dates are the state every archived run is in. The signal must then be inert rather than
    // misaligned: a shorter array zipped against a longer context would assign one turn's date to another.
    const none = temporalBoosts({ context, turnDates: undefined, askedAt: ASKED });
    expect(none.scored).toBe(0);
    expect(none.total).toBe(3);
    for (const turn of context) expect(none.affinityFor(turn)).toBe(0);

    const short = temporalBoosts({ context, turnDates: [ASKED], askedAt: ASKED });
    expect(short.scored).toBe(1);
    expect(short.affinityFor('b')).toBe(0);
  });

  it('refuses a dates array that does not line up with the context', () => {
    // The one case that is an error rather than an absence: a longer array means the caller flattened two
    // different corpora together, and silently truncating it would score the wrong turn.
    expect(() =>
      temporalBoosts({ context, turnDates: [ASKED, ASKED, ASKED, ASKED], askedAt: ASKED }),
    ).toThrow(/length/i);
  });
});

describe('the index, with the temporal weight at zero and above it', () => {
  /**
   * The wiring, which is the part that fails silently.
   *
   * A signal that is correct in isolation and never reaches the ordering is the defect this repository has
   * recorded four times — an export with no caller, a cache with no identity, a pass that was configured and
   * whose census did not exist. So the assertions here are about the ordering, and the first one is that a
   * weight of zero changes nothing at all.
   */
  const caseWithDates = {
    question: 'When did the trip happen?',
    context: ['the trip was in April', 'an unrelated note', 'another note'],
    turnDates: [ASKED, ASKED - 400 * DAY, ASKED - 800 * DAY],
    askedAt: ASKED,
  };

  /**
   * A retriever that scores by position, so the arithmetic is readable: 0.9, 0.8, 0.7.
   *
   * It honours `topK`, because the real one does and a double that ignored it would make "the index holds
   * this turn" a property of the fixture. The first draft of this test did ignore it, and the `does not
   * promote a turn it never scored` case failed against a correct implementation -- which is the fixture
   * being wrong, not the code.
   */
  const byPosition = async (
    _queries: readonly string[],
    context: readonly string[],
    topK: number,
  ) =>
    context.slice(0, topK).map((text, position) => ({
      id: `${String(position)}`,
      text,
      score: 0.9 - position * 0.1,
      index: position,
    }));

  async function indexAt(weight: number) {
    return buildRetrievalRelevanceIndex({} as never, [caseWithDates], {
      topK: 3,
      retrieve: byPosition,
      temporalWeight: weight,
    });
  }

  it('reproduces the semantic score exactly when the weight is zero', async () => {
    // The single-variable guarantee, asserted rather than assumed: every archived artifact was produced with
    // this signal absent, and a weight of zero has to mean the same thing as not naming it.
    const index = await indexAt(0);
    expect(index.relevanceFor(caseWithDates.question, 'the trip was in April')).toBeCloseTo(
      0.9,
      12,
    );
    expect(index.relevanceFor(caseWithDates.question, 'an unrelated note')).toBeCloseTo(0.8, 12);
  });

  it('adds weight times affinity to the turns it already holds', async () => {
    const index = await indexAt(0.5);
    // The formula, written into the assertion rather than a hand-computed constant: a constant would pass
    // for a wrong decay as long as the wrong decay happened to give that value at that distance.
    const sameDay = 0.9 + 0.5 * affinity(ASKED, ASKED);
    const farTurn = 0.8 + 0.5 * affinity(ASKED - 400 * DAY, ASKED);
    expect(index.relevanceFor(caseWithDates.question, 'the trip was in April')).toBeCloseTo(
      sameDay,
      12,
    );
    expect(index.relevanceFor(caseWithDates.question, 'an unrelated note')).toBeCloseTo(
      farTurn,
      12,
    );
    // And the ordering claim the signal exists for: the same-day turn, which the retriever already ranked
    // first, is now further ahead of the far one than the 0.1 cosine gap alone would put it.
    expect(index.relevanceFor(caseWithDates.question, 'the trip was in April')).toBeGreaterThan(
      index.relevanceFor(caseWithDates.question, 'an unrelated note')! + 0.1,
    );
  });

  it('does not promote a turn it never scored', async () => {
    // The signal re-orders the candidates; it does not create them. A turn outside the top-k holds no cosine,
    // and adding an affinity to the floor would let a same-day turn beat a measured one -- which would look
    // like the temporal signal working while it was really the floor leaking.
    const index = await buildRetrievalRelevanceIndex({} as never, [caseWithDates], {
      topK: 1,
      retrieve: byPosition,
      temporalWeight: 0.5,
    });
    const unscored = index.relevanceFor(caseWithDates.question, 'an unrelated note');
    expect(unscored).toBeLessThan(0);
  });

  it('leaves the case a run without dates behaves exactly as before', async () => {
    // Absent dates are the archived state. `undefined` and a zero weight must be indistinguishable, or the
    // first run that forgets to pass dates would silently change its own ranking.
    const withoutDates = await buildRetrievalRelevanceIndex(
      {} as never,
      [{ question: caseWithDates.question, context: caseWithDates.context }],
      { topK: 3, retrieve: byPosition, temporalWeight: 0.5 },
    );
    expect(withoutDates.relevanceFor(caseWithDates.question, 'the trip was in April')).toBeCloseTo(
      0.9,
      12,
    );
  });
});

describe('the census the signal publishes', () => {
  const oneCase = {
    question: 'When did the trip happen?',
    context: ['in April', 'in March'],
    turnDates: [ASKED, null],
    askedAt: ASKED,
  };
  const retriever = async (_q: readonly string[], context: readonly string[], topK: number) =>
    context.slice(0, topK).map((text, position) => ({
      id: `${String(position)}`,
      text,
      score: 0.9 - position * 0.1,
      index: position,
    }));

  it('is absent when the signal was not configured', async () => {
    // Absence and a zero are different sentences: one says the run did not carry the signal, the other says it
    // carried it and found nothing to score. Collapsing them is the defect the bare-retry census was built to
    // avoid, and the same rule applies here.
    const index = await buildRetrievalRelevanceIndex({} as never, [oneCase], {
      topK: 2,
      retrieve: retriever,
    });
    expect(index.temporal).toBeUndefined();
  });

  it('reports how many turns it could place in time, and how many it looked at', async () => {
    const index = await buildRetrievalRelevanceIndex({} as never, [oneCase], {
      topK: 2,
      retrieve: retriever,
      temporalWeight: 0.3,
    });
    // One of the two turns carries an instant. A census that reported 2 here would say the signal reached the
    // undated turn, which it did not and must not.
    expect(index.temporal).toEqual({ scored: 1, total: 2 });
  });

  it('reports a configured signal that scored nothing as zero rather than as absent', async () => {
    const undated = { question: 'when?', context: ['a', 'b'] };
    const index = await buildRetrievalRelevanceIndex({} as never, [undated], {
      topK: 2,
      retrieve: retriever,
      temporalWeight: 0.3,
    });
    expect(index.temporal).toEqual({ scored: 0, total: 2 });
  });
});
