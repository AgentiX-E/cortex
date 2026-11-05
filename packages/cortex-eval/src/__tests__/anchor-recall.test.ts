import { describe, it, expect } from 'vitest';
import {
  resolveAnchorParameters,
  restoreAnchorNeighbourhoods,
  type ScoredTurn,
} from '../anchor-recall.js';

/**
 * The question names four terms and nothing else, so "did this hit cover something new" is a fact
 * about the fixture rather than an inference about the tokeniser. Greek letters are chosen because
 * none of them is a stopword and none is a prefix of another.
 */
const QUESTION = 'alpha beta gamma delta';

function hit(text: string, score: number): ScoredTurn {
  return { text, score };
}

/** One session of ten turns, so a position in the flat context is also a position in the session. */
const ONE_SESSION: readonly (readonly string[])[] = [
  [
    'alpha beta start',
    'unrelated remark',
    'alpha beta end',
    'third turn',
    'gamma here',
    'delta here',
    'alpha beta recorded',
    'gamma tablet',
    'delta tablet',
    'zeta filler',
  ],
];
const FLAT: readonly string[] = ONE_SESSION.flat();

/**
 * Which hits the selection chose, named rather than numbered.
 *
 * `radius: 0` is the lever: the anchors are still chosen and reported, and nothing is restored, so
 * the pool's order is the hits' order and an anchor position is a hits position. Selecting is
 * therefore tested without a corpus, and restoring without the selection's tie-breaks.
 */
function anchorsOf(hits: readonly ScoredTurn[], count?: number): string[] {
  const pool = restoreAnchorNeighbourhoods(hits, FLAT, ONE_SESSION, {
    question: QUESTION,
    radius: 0,
    ...(count === undefined ? {} : { count }),
  });
  return pool.anchors.map((position) => pool.order[position]!);
}

describe('anchor selection, read through the pool it reports', () => {
  it('takes the retriever first hit as the first anchor, whatever else is in the pool', () => {
    // The monotonicity property: the head of the pool is the retriever's own order. Without it an
    // ablation that moved nothing could not be attributed to restoration.
    expect(
      anchorsOf([hit('alpha beta recorded', 0.9), hit('gamma delta both named', 0.99)])[0],
    ).toBe('alpha beta recorded');
  });

  it('skips a hit that only repeats terms already covered', () => {
    // The second hit says nothing the first did not, so it is not an anchor even though its score is
    // close. It is skipped rather than ranked lower: a repeated statement restored around would spend
    // the radius on the same neighbourhood twice.
    expect(
      anchorsOf([
        hit('alpha beta recorded', 0.9),
        hit('alpha beta recorded again', 0.85),
        hit('gamma noted', 0.5),
      ]),
    ).toEqual(['alpha beta recorded', 'gamma noted']);
  });

  it('stops when no remaining hit names a term the question asked for', () => {
    expect(
      anchorsOf([
        hit('alpha beta recorded', 0.9),
        hit('alpha beta recorded again', 0.85),
        hit('something else entirely', 0.4),
      ]),
    ).toEqual(['alpha beta recorded']);
  });

  it('prefers a hit covering two new terms over one covering a single term', () => {
    // Coverage outranks the retriever's confidence, which is the point of a lexicographic key: the
    // low-scoring hit naming both remaining properties is the one whose neighbourhood is worth
    // restoring.
    expect(
      anchorsOf([
        hit('alpha beta recorded', 0.9),
        hit('gamma noted', 0.5),
        hit('gamma delta together', 0.1),
      ]),
    ).toEqual(['alpha beta recorded', 'gamma delta together']);
  });

  it('breaks a coverage tie on lexical novelty against the chosen anchors', () => {
    // Both candidates cover one new term and score the same, so the third key decides: the one that
    // shares no word with the anchor is the one whose neighbourhood is a different conversation.
    expect(
      anchorsOf([
        hit('alpha beta recorded', 0.9),
        hit('gamma noted alpha', 0.5),
        hit('gamma tablet', 0.5),
      ]),
    ).toEqual(['alpha beta recorded', 'gamma tablet']);
  });

  it('breaks a complete tie on the order the retriever returned', () => {
    expect(
      anchorsOf(
        [hit('alpha beta recorded', 0.9), hit('gamma tablet', 0.5), hit('delta tablet', 0.5)],
        2,
      ),
    ).toEqual(['alpha beta recorded', 'gamma tablet']);
  });

  it('caps the anchors at four by default', () => {
    // The count is a constant rather than an option because a dispatch must not be able to change a
    // mechanism while its `relevanceSignal` name says the mechanism did not change.
    expect(
      anchorsOf([
        hit('alpha recorded', 0.9),
        hit('beta noted', 0.8),
        hit('gamma tablet', 0.7),
        hit('delta tablet', 0.6),
        hit('zeta tablet', 0.5),
      ]),
    ).toHaveLength(4);
  });

  it('caps the anchors at the requested count', () => {
    expect(
      anchorsOf(
        [hit('alpha recorded', 0.9), hit('gamma noted', 0.5), hit('delta observed', 0.4)],
        2,
      ),
    ).toEqual(['alpha recorded', 'gamma noted']);
  });

  it('answers no anchors for an empty pool', () => {
    expect(anchorsOf([])).toEqual([]);
  });

  it('answers no anchors for a non-positive count', () => {
    expect(anchorsOf([hit('alpha beta recorded', 0.9)], 0)).toEqual([]);
  });

  it('counts a term the question repeats once', () => {
    // `extractLexicalKeywords` de-duplicates, so a question that says "alpha" twice must not make a
    // hit covering it once look like a single-term gain over one covering it twice.
    const pool = restoreAnchorNeighbourhoods(
      [hit('alpha recorded', 0.9), hit('alpha beta recorded', 0.5)],
      FLAT,
      ONE_SESSION,
      { question: 'alpha alpha beta', radius: 0 },
    );
    expect(pool.anchors.map((position) => pool.order[position])).toEqual([
      'alpha recorded',
      'alpha beta recorded',
    ]);
  });

  it('is deterministic across two calls', () => {
    const pool = [
      hit('alpha beta recorded', 0.9),
      hit('gamma tablet', 0.5),
      hit('delta tablet', 0.5),
      hit('gamma delta together', 0.2),
    ];
    expect(anchorsOf(pool)).toEqual(anchorsOf(pool));
  });
});

/**
 * Two sessions of four and two turns. The boundary is what the restoration must respect, so the
 * fixture puts a tempting neighbour on the other side of it: `gamma here` follows `third turn` in
 * the flat context and belongs to a different conversation.
 */
const SESSIONS: readonly (readonly string[])[] = [
  ['alpha beta start', 'unrelated remark', 'alpha beta end', 'third turn'],
  ['gamma here', 'delta here'],
];
const CONTEXT: readonly string[] = SESSIONS.flat();

describe('session-neighbourhood restoration', () => {
  it('restores the turns around an anchor inside its own session, decaying by distance', () => {
    // `decay: 0.5` is passed rather than left to the registration, so this case tests the arithmetic
    // it claims to test. What the default is belongs to its own case below, and a dispatch that
    // steepend the decay must not be able to fail a test about multiplication.
    const pool = restoreAnchorNeighbourhoods([hit('alpha beta start', 1)], CONTEXT, SESSIONS, {
      question: QUESTION,
      decay: 0.5,
    });

    expect(pool.restored).toBe(3);
    expect(pool.order).toEqual([
      'alpha beta start',
      'unrelated remark',
      'alpha beta end',
      'third turn',
    ]);
    expect(pool.scores.get('alpha beta start')).toBe(1);
    // `1 * 0.5^1`, `1 * 0.5^2`, `1 * 0.5^3` -- distance is real information, so the arithmetic is
    // asserted rather than the ordering alone.
    expect(pool.scores.get('unrelated remark')).toBeCloseTo(0.5, 12);
    expect(pool.scores.get('alpha beta end')).toBeCloseTo(0.25, 12);
    expect(pool.scores.get('third turn')).toBeCloseTo(0.125, 12);
  });

  it('does not cross the session boundary', () => {
    const pool = restoreAnchorNeighbourhoods([hit('third turn', 1)], CONTEXT, SESSIONS, {
      question: QUESTION,
    });
    expect(pool.order).not.toContain('gamma here');
    // `third turn` is last in its session, so only the three turns before it are restorable.
    expect(pool.restored).toBe(3);
  });

  it('stops at three steps, which is the default radius', () => {
    // Behaviour rather than the constant: the turn four away is the first one left out.
    const long: readonly (readonly string[])[] = [
      ['alpha beta start', 'n1', 'n2', 'n3', 'n4', 'n5'],
    ];
    const pool = restoreAnchorNeighbourhoods([hit('alpha beta start', 1)], long.flat(), long, {
      question: QUESTION,
    });
    expect(pool.restored).toBe(3);
    expect(pool.order).not.toContain('n4');
  });

  it('keeps every restored turn strictly below its anchor', () => {
    // A neighbour tying with the statement that retrieved it would be ranked as evidence the question
    // matched, which is a claim nothing measured.
    const pool = restoreAnchorNeighbourhoods([hit('alpha beta start', 0.37)], CONTEXT, SESSIONS, {
      question: QUESTION,
    });
    for (const text of pool.order.slice(1)) {
      expect(pool.scores.get(text)!).toBeLessThan(0.37);
    }
  });

  it('respects an explicit radius', () => {
    const pool = restoreAnchorNeighbourhoods([hit('alpha beta start', 1)], CONTEXT, SESSIONS, {
      question: QUESTION,
      radius: 1,
    });
    expect(pool.restored).toBe(1);
    expect(pool.order).toEqual(['alpha beta start', 'unrelated remark']);
  });

  it('leaves a turn the retriever already scored at its measured score', () => {
    // Overwriting a measured score with a decayed share would be this module contradicting a number
    // it did not produce, and it would demote a hit the retriever placed high.
    const pool = restoreAnchorNeighbourhoods(
      [hit('alpha beta start', 1), hit('alpha beta end', 0.9)],
      CONTEXT,
      SESSIONS,
      { question: QUESTION },
    );
    expect(pool.scores.get('alpha beta end')).toBe(0.9);
    expect(pool.restored).toBe(2);
  });

  it('orders the merged pool by score rather than by insertion', () => {
    const pool = restoreAnchorNeighbourhoods(
      [hit('alpha beta start', 1), hit('delta here', 0.05)],
      CONTEXT,
      SESSIONS,
      { question: QUESTION, decay: 0.5 },
    );
    expect(pool.order[0]).toBe('alpha beta start');
    // `gamma here` is restored at `0.05 * 0.5 = 0.025` around the second anchor, so it lands below
    // that anchor rather than beside it -- the merge is by score, and restoration adds knowledge of
    // turns without claiming authority over a measured hit's position.
    expect(pool.scores.get('gamma here')).toBeCloseTo(0.025, 12);
    expect(pool.order[pool.order.length - 1]).toBe('gamma here');
  });

  it('reports the anchors even when the case carries no boundaries', () => {
    // The selection does not need a boundary; only restoration does. Reporting both keeps "this case
    // had no sessions" separate from "the selection fired on nothing".
    const pool = restoreAnchorNeighbourhoods(
      [hit('alpha beta start', 1), hit('gamma here', 0.9)],
      CONTEXT,
      [],
      { question: QUESTION },
    );
    expect(pool.anchors).toHaveLength(2);
    expect(pool.restored).toBe(0);
    expect(pool.order).toEqual(['alpha beta start', 'gamma here']);
  });

  it('reports the anchors at a zero radius without restoring anything', () => {
    const pool = restoreAnchorNeighbourhoods([hit('alpha beta start', 1)], CONTEXT, SESSIONS, {
      question: QUESTION,
      radius: 0,
    });
    expect(pool.anchors).toEqual([0]);
    expect(pool.restored).toBe(0);
    expect(pool.order).toEqual(['alpha beta start']);
  });

  it('leaves the pool untouched for an empty retrieved pool', () => {
    const pool = restoreAnchorNeighbourhoods([], CONTEXT, SESSIONS, { question: QUESTION });
    expect(pool.order).toEqual([]);
    expect(pool.anchors).toEqual([]);
    expect(pool.restored).toBe(0);
  });

  it('restores nothing around a hit the context does not hold', () => {
    // A hit and a context that disagree cannot locate a boundary, so the honest answer is to restore
    // nothing rather than to guess a position.
    const pool = restoreAnchorNeighbourhoods(
      [hit('a turn from another dataset', 1)],
      CONTEXT,
      SESSIONS,
      { question: QUESTION },
    );
    expect(pool.restored).toBe(0);
    expect(pool.anchors).toEqual([0]);
    expect(pool.order).toEqual(['a turn from another dataset']);
  });

  it('reports where each anchor landed in the merged order', () => {
    const pool = restoreAnchorNeighbourhoods(
      [hit('alpha beta start', 1), hit('gamma here', 0.9)],
      CONTEXT,
      SESSIONS,
      { question: QUESTION },
    );
    // The second anchor is `gamma here` at 0.9, so the anchors are at 0 and 1. Its restored neighbour
    // `delta here` decays to 0.45, which puts it below the first anchor's nearest neighbour at 0.5 and
    // above its second at 0.25 -- the merge is by score, not by which anchor was restored first.
    expect(pool.anchors).toEqual([0, 1]);
    expect(pool.order[2]).toBe('unrelated remark');
    expect(pool.order[3]).toBe('delta here');
  });

  it('counts a neighbourhood restored around one anchor once', () => {
    // Two anchors in one session share neighbours. The second pass must not re-add them, and the count
    // is what a reader uses to tell "restoration ran" from "restoration ran twice".
    const pool = restoreAnchorNeighbourhoods(
      [hit('alpha beta start', 1), hit('alpha beta end', 0.9)],
      CONTEXT,
      SESSIONS,
      { question: QUESTION },
    );
    expect(pool.restored).toBe(2);
    expect(pool.order.filter((text) => text === 'unrelated remark')).toHaveLength(1);
  });

  it('reads the first position of a text the context repeats', () => {
    // Duplicated turn texts exist in this corpus: the loader flattens sessions that can share a
    // sentence. The pool must be a function of the input rather than of which copy was visited.
    const repeated: readonly (readonly string[])[] = [
      ['alpha beta start', 'dup'],
      ['dup', 'gamma here'],
    ];
    const pool = restoreAnchorNeighbourhoods(
      [hit('alpha beta start', 1)],
      ['alpha beta start', 'dup', 'dup', 'gamma here'],
      repeated,
      { question: QUESTION },
    );
    expect(pool.restored).toBe(1);
    expect(pool.order).toEqual(['alpha beta start', 'dup']);
  });
});

describe('boundaries that do not line up with the context', () => {
  it('treats two letterless texts as identical rather than as infinitely novel', () => {
    // `tokensOf` answers the empty set for a text with no `[a-z]` run, and `jaccard` answers 1 for
    // two empty sets. Without that rule the novelty key would divide by zero and the second hit
    // would win on `NaN > NaN === false` -- a silent tie rather than a stated one.
    const pool = restoreAnchorNeighbourhoods(
      [hit('123', 0.9), hit('456', 0.8)],
      FLAT,
      ONE_SESSION,
      {
        question: '123 456',
        radius: 0,
      },
    );
    expect(pool.anchors).toHaveLength(1);
  });

  it('restores nothing around a hit the boundaries do not cover', () => {
    // `context` is longer than the sessions say it is, so the position exists and the session does
    // not. That is a caller disagreeing with itself about its own boundary list, and the honest
    // answer is to restore nothing rather than to invent an owner.
    const long = [...FLAT, 'a turn past the last boundary'];
    const pool = restoreAnchorNeighbourhoods(
      [hit('a turn past the last boundary', 1)],
      long,
      ONE_SESSION,
      { question: QUESTION },
    );
    expect(pool.restored).toBe(0);
    expect(pool.anchors).toEqual([0]);
  });

  it('keeps the retriever order among hits the context does not hold', () => {
    // Both positions are absent and both scores are equal, so the second key decides: the retriever's
    // own order, not the texts. A comparator that fell through to a string comparison would reorder a
    // measured pool by spelling.
    const pool = restoreAnchorNeighbourhoods(
      [hit('alpha beta zulu', 1), hit('alpha beta alpha', 1)],
      FLAT,
      ONE_SESSION,
      { question: QUESTION, radius: 0 },
    );
    expect(pool.order).toEqual(['alpha beta zulu', 'alpha beta alpha']);
  });
});

describe('restoration around an anchor in the middle of a session', () => {
  it('keeps the nearer-before-farther order when two neighbours share a decay', () => {
    // An anchor with turns on both sides restores the two at equal distance at equal score, so the
    // corpus position is the only key left. Without it the pair's order would be whatever the engine
    // did, and two builds of one case could print different pools.
    const middle: readonly (readonly string[])[] = [
      ['left two', 'left one', 'alpha beta middle', 'right one', 'right two'],
    ];
    const pool = restoreAnchorNeighbourhoods([hit('alpha beta middle', 1)], middle.flat(), middle, {
      question: QUESTION,
      radius: 1,
      decay: 0.5,
    });
    expect(pool.scores.get('left one')).toBeCloseTo(0.5, 12);
    expect(pool.scores.get('right one')).toBeCloseTo(0.5, 12);
    expect(pool.order).toEqual(['alpha beta middle', 'left one', 'right one']);
  });
});

describe('the registered parameters, which the artifact has to carry', () => {
  it('resolves to the registered triple when nothing is named', () => {
    // The one place the three numbers are asserted. Every other case passes what it needs, so a
    // dispatch that moves a registered value fails here and nowhere else -- which is what makes the
    // movement a decision rather than a diff nobody noticed.
    expect(resolveAnchorParameters({})).toEqual({ count: 4, radius: 3, decay: 0.5 });
  });

  it('passes an override through rather than falling back on it', () => {
    // `??` and not `||`: zero is a value this module means (`radius: 0` is the selection-only
    // ablation, `count: 0` is an empty selection), and a falsy test would silently restore the
    // default and report a mechanism that ran when it did not.
    expect(resolveAnchorParameters({ count: 0, radius: 0, decay: 0 })).toEqual({
      count: 0,
      radius: 0,
      decay: 0,
    });
  });

  it('is the same resolver the restoration uses', () => {
    // The property that keeps the artifact and the pool one story: a pool built with no options
    // decays at exactly the registered rate.
    const { decay } = resolveAnchorParameters({});
    const pool = restoreAnchorNeighbourhoods([hit('alpha beta start', 1)], CONTEXT, SESSIONS, {
      question: QUESTION,
    });
    expect(pool.scores.get('unrelated remark')).toBeCloseTo(decay, 12);
  });
});
