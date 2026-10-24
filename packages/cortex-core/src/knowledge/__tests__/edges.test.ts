/**
 * The edge gate, the span arithmetic underneath it, and the one derived link.
 *
 * The suite is organised around the three ways an edge can be wrong, because each one has a distinct
 * cost:
 *
 * - **unlicensed** — a `then` producing `causes`. This is the causal hallucination, and it is the one
 *   that would corrupt a benchmark score rather than merely a card.
 * - **unlocatable** — a span that does not cover its own marker. The edge looks checkable and is not.
 * - **self-asserted derived** — an `elaborates` or `supersedes` claimed as if it had been read.
 */

import { describe, expect, it } from 'vitest';
import { checkEdge, deriveSupersedes, edgeId, extractedSpan, type KnowledgeEdge } from '../edge.js';
import {
  checkFact,
  covers,
  envelope,
  locate,
  type KnowledgeFact,
  type KnowledgeFrame,
} from '../frame.js';
import {
  DERIVED_EDGE_TYPES,
  EDGE_TYPES,
  EXTRACTED_EDGE_TYPES,
  FACT_TYPES,
  licensedEdgeTypes,
  licenceClassOf,
  isEdgeType,
  isFactType,
  isModality,
  isPolarity,
} from '../taxonomy.js';

const FRAME: KnowledgeFrame = {
  id: 'f0',
  text: 'By the way, I just finished an online course, so I want to apply the skills.',
};

function factOf(overrides: Partial<KnowledgeFact> = {}): KnowledgeFact {
  return {
    id: 'a1',
    frameId: 'f0',
    text: 'I finished an online course.',
    type: 'event',
    polarity: 'positive',
    modality: 'actual',
    sourceSpan: { start: 12, end: 44 },
    references: [],
    ...overrides,
  };
}

function edgeOf(overrides: Partial<KnowledgeEdge> = {}): KnowledgeEdge {
  return {
    id: 'causes:a1>a2',
    from: 'a1',
    to: 'a2',
    type: 'causes',
    origin: 'extracted',
    marker: 'so',
    evidenceSpan: { start: 12, end: FRAME.text.length },
    ...overrides,
  };
}

/** A fact with one optional field absent — absent, not `undefined`, which the compiler distinguishes. */
function without(fact: KnowledgeFact, key: 'subject' | 'predicate' | 'at'): KnowledgeFact {
  const copy: Record<string, unknown> = { ...fact };
  delete copy[key];
  return copy as unknown as KnowledgeFact;
}

const FACTS = new Map<string, KnowledgeFact>([
  ['a1', factOf()],
  [
    'a2',
    factOf({ id: 'a2', text: 'I want to apply the skills.', sourceSpan: { start: 45, end: 74 } }),
  ],
]);

describe('taxonomy: the licence table is the defence, so it is asserted directly', () => {
  it('never lets a temporal marker buy a causal edge', () => {
    const licensed = licensedEdgeTypes('temporal');
    expect(licensed).not.toContain('causes');
    expect(licensed).not.toContain('enables');
    expect(licensed).not.toContain('prevents');
    expect([...licensed]).toEqual(['before', 'after', 'during']);
  });

  it('licenses nothing when there is no marker', () => {
    expect(licensedEdgeTypes(null)).toEqual([]);
  });

  it('partitions the edge types: every type is either extracted or derived, never both', () => {
    expect([...EXTRACTED_EDGE_TYPES, ...DERIVED_EDGE_TYPES].sort()).toEqual([...EDGE_TYPES].sort());
    for (const type of EXTRACTED_EDGE_TYPES) expect(DERIVED_EDGE_TYPES).not.toContain(type);
  });

  it('gives every extracted type a class and every derived type none', () => {
    for (const type of EXTRACTED_EDGE_TYPES) expect(licenceClassOf(type), type).not.toBeNull();
    for (const type of DERIVED_EDGE_TYPES) expect(licenceClassOf(type), type).toBeNull();
  });

  it('rejects values outside the closed sets', () => {
    expect(isFactType('preference')).toBe(true);
    expect(isFactType('opinion')).toBe(false);
    expect(isFactType(7)).toBe(false);
    expect(isEdgeType('causes')).toBe(true);
    expect(isEdgeType('similar-to')).toBe(false);
    expect(isPolarity('negated')).toBe(true);
    expect(isPolarity('neutral')).toBe(false);
    expect(isModality('planned')).toBe(true);
    expect(isModality('future')).toBe(false);
  });

  it('declares a type for the two reviewed shapes that motivated the taxonomy', () => {
    // `g04`'s relational statement and `g12`'s contingency are the two the design leans on.
    expect(FACT_TYPES).toContain('relation');
    expect(FACT_TYPES).toContain('goal');
  });
});

describe('locate: the span is computed from the words, not reported', () => {
  it('covers the run the fact kept', () => {
    const span = locate('I finished an online course', FRAME.text);
    // "I" is not an anchor (two characters, and the frame says "I" twice), so the envelope starts at
    // the first content word rather than stretching to the pronoun in the next clause.
    expect(FRAME.text.slice(span.start, span.end)).toBe('finished an online course');
  });

  it('falls back to the whole frame when the fact shares no word with it', () => {
    expect(locate('Paris is expensive', 'I moved in March.')).toEqual({ start: 0, end: 17 });
  });

  it('takes the envelope over a scattered match rather than a contiguous run', () => {
    const frame = 'I am planning a project in Nigeria that connects 100 villages.';
    const span = locate('The project connects 100 villages', frame);
    expect(frame.slice(span.start, span.end)).toBe('project in Nigeria that connects 100 villages');
  });

  it('folds a possessive so "Joe\'s shop" matches "Joe"s sentence', () => {
    const frame = "I will check Joe's Tackle Shop website.";
    const span = locate("Joe's website", frame);
    expect(frame.slice(span.start, span.end)).toBe("Joe's Tackle Shop website");
  });

  it('is a pure function: the same question twice is the same answer', () => {
    expect(locate('online course', FRAME.text)).toEqual(locate('online course', FRAME.text));
  });
});

describe('envelope and covers', () => {
  it('wraps every span given', () => {
    expect(
      envelope([
        { start: 5, end: 7 },
        { start: 1, end: 3 },
      ]),
    ).toEqual({ start: 1, end: 7 });
  });

  it('refuses an empty list, because there is nothing to cover', () => {
    expect(() => envelope([])).toThrow(TypeError);
  });

  it('treats adjacency as containment and an empty overlap as not', () => {
    expect(covers({ start: 0, end: 10 }, { start: 0, end: 10 })).toBe(true);
    expect(covers({ start: 0, end: 10 }, { start: 10, end: 12 })).toBe(false);
  });
});

describe('checkFact: a fact must point at its own frame', () => {
  it('accepts a well-formed fact', () => {
    expect(checkFact(factOf(), FRAME)).toBeNull();
  });

  it('refuses a blank statement', () => {
    expect(checkFact(factOf({ text: '   ' }), FRAME)?.problem).toBe('blank');
  });

  it('refuses a fact bound to another frame', () => {
    expect(checkFact(factOf({ frameId: 'f9' }), FRAME)?.problem).toBe('frame-mismatch');
  });

  it('refuses a span that is not a range', () => {
    expect(checkFact(factOf({ sourceSpan: { start: 5, end: 4 } }), FRAME)?.problem).toBe(
      'span-outside-frame',
    );
    expect(checkFact(factOf({ sourceSpan: { start: -1, end: 4 } }), FRAME)?.problem).toBe(
      'span-outside-frame',
    );
  });

  it('refuses a span that points at nothing', () => {
    expect(checkFact(factOf({ sourceSpan: { start: 4, end: 4 } }), FRAME)?.problem).toBe(
      'span-empty',
    );
  });

  it('refuses a vocabulary the type system would have caught and JSON did not', () => {
    // Every one of these arrives by deserialising a stored card, so the compiler never sees it.
    expect(checkFact(factOf({ type: 'opinion' as never }), FRAME)?.problem).toBe('unknown-type');
    expect(checkFact(factOf({ polarity: 'neutral' as never }), FRAME)?.problem).toBe(
      'unknown-polarity',
    );
    expect(checkFact(factOf({ modality: 'future' as never }), FRAME)?.problem).toBe(
      'unknown-modality',
    );
  });

  it('refuses a span past the end of the frame', () => {
    expect(
      checkFact(factOf({ sourceSpan: { start: 0, end: FRAME.text.length + 1 } }), FRAME)?.problem,
    ).toBe('span-outside-frame');
  });
});

describe('checkEdge: licence, marker and span', () => {
  it('accepts a causal edge licensed by "so"', () => {
    expect(checkEdge(edgeOf(), { frame: FRAME, facts: FACTS })).toBeNull();
  });

  it('refuses a causal edge licensed only by a temporal marker', () => {
    const verdict = checkEdge(edgeOf({ marker: 'then', evidenceSpan: { start: 0, end: 10 } }), {
      frame: { id: 'f1', text: 'I finished the course, then I applied it.' },
      facts: FACTS,
    });
    expect(verdict?.problem).toBe('unlicensed-type');
  });

  it('refuses a marker that is not in the sentence at all', () => {
    expect(
      checkEdge(edgeOf({ marker: 'therefore' }), { frame: FRAME, facts: FACTS })?.problem,
    ).toBe('marker-not-in-frame');
  });

  it('refuses an extracted edge with no marker', () => {
    const base = edgeOf();
    const bare: KnowledgeEdge = {
      id: base.id,
      from: base.from,
      to: base.to,
      type: base.type,
      origin: base.origin,
      evidenceSpan: base.evidenceSpan!,
    };
    expect(checkEdge(bare, { frame: FRAME, facts: FACTS })?.problem).toBe('missing-marker');
  });

  it('refuses an extracted edge with no span', () => {
    const base = edgeOf();
    const bare: KnowledgeEdge = {
      id: base.id,
      from: base.from,
      to: base.to,
      type: base.type,
      origin: base.origin,
      marker: base.marker!,
    };
    expect(checkEdge(bare, { frame: FRAME, facts: FACTS })?.problem).toBe('missing-span');
  });

  it('refuses a span that does not cover its own marker', () => {
    expect(
      checkEdge(edgeOf({ evidenceSpan: { start: 0, end: 20 } }), { frame: FRAME, facts: FACTS })
        ?.problem,
    ).toBe('span-not-covering-marker');
  });

  it('refuses a span outside the frame', () => {
    expect(
      checkEdge(edgeOf({ evidenceSpan: { start: 12, end: FRAME.text.length + 5 } }), {
        frame: FRAME,
        facts: FACTS,
      })?.problem,
    ).toBe('span-outside-frame');
  });

  it('refuses a self-loop', () => {
    expect(checkEdge(edgeOf({ to: 'a1' }), { frame: FRAME, facts: FACTS })?.problem).toBe(
      'self-loop',
    );
  });

  it('refuses an endpoint that is not a fact of this frame', () => {
    expect(checkEdge(edgeOf({ to: 'zz' }), { frame: FRAME, facts: FACTS })?.problem).toBe(
      'unknown-endpoint',
    );
  });

  it('refuses an unknown type', () => {
    expect(
      checkEdge(edgeOf({ type: 'similar-to' as never }), { frame: FRAME, facts: FACTS })?.problem,
    ).toBe('unknown-type');
  });

  it('refuses a derived link of an extracted type', () => {
    expect(
      checkEdge(edgeOf({ origin: 'derived', type: 'causes' }), { frame: FRAME, facts: FACTS })
        ?.problem,
    ).toBe('unlicensed-type');
  });

  it('refuses an extracted link of a derived type', () => {
    expect(checkEdge(edgeOf({ type: 'elaborates' }), { frame: FRAME, facts: FACTS })?.problem).toBe(
      'derived-type-extracted',
    );
  });

  it('accepts a derived link with no marker and no span', () => {
    const derived: KnowledgeEdge = {
      id: edgeId('supersedes', 'a2', 'a1'),
      from: 'a2',
      to: 'a1',
      type: 'supersedes',
      origin: 'derived',
    };
    expect(checkEdge(derived, { frame: FRAME, facts: FACTS })).toBeNull();
  });
});

describe('extractedSpan: the envelope that shows what the marker connects', () => {
  it('covers both endpoints and the marker', () => {
    expect(
      extractedSpan({ start: 30, end: 40 }, { start: 50, end: 60 }, { start: 42, end: 44 }),
    ).toEqual({
      start: 30,
      end: 60,
    });
  });
});

describe('deriveSupersedes: computed from slots, and silent when the slots are absent', () => {
  const older = factOf({
    id: 'k1',
    text: 'My best 5K time is 27:12.',
    subject: 'user',
    predicate: '5k time',
    at: 100,
  });
  const newer = factOf({
    id: 'k2',
    text: 'My best 5K time is 25:50.',
    subject: 'user',
    predicate: '5K Time',
    at: 200,
  });

  it('links the later fact to the earlier one, in that direction', () => {
    const edges = deriveSupersedes([newer, older]);
    expect(edges).toEqual([
      {
        id: 'supersedes:k2>k1',
        from: 'k2',
        to: 'k1',
        type: 'supersedes',
        origin: 'derived',
      },
    ]);
  });

  it('folds case and padding in the slot key', () => {
    expect(
      deriveSupersedes([older, { ...newer, subject: ' USER ', predicate: '5k time' }]),
    ).toHaveLength(1);
  });

  it('says nothing when the slots are missing', () => {
    expect(deriveSupersedes([older, without(newer, 'subject')])).toEqual([]);
  });

  it('says nothing when a time is missing', () => {
    expect(deriveSupersedes([older, without(newer, 'at')])).toEqual([]);
  });

  it('says nothing when the two statements are the same', () => {
    expect(deriveSupersedes([older, { ...newer, text: older.text }])).toEqual([]);
  });

  it('chains three statements rather than linking every pair', () => {
    const middle = factOf({
      id: 'k3',
      text: 'My best 5K time is 26:30.',
      subject: 'user',
      predicate: '5k time',
      at: 150,
    });
    const edges = deriveSupersedes([older, newer, middle]);
    // Ordered by the chain's own direction: each fact supersedes its predecessor, so the edges come
    // out oldest-pair-first even when the input is shuffled.
    expect(edges.map((edge) => edge.id)).toEqual(['supersedes:k3>k1', 'supersedes:k2>k3']);
  });

  it('keeps two different slots apart', () => {
    const other = { ...newer, id: 'k4', predicate: 'marathon time' };
    expect(deriveSupersedes([older, other])).toEqual([]);
  });

  it('is deterministic: the same input in any order gives the same edges', () => {
    const middle = factOf({
      id: 'k3',
      text: 'My best 5K time is 26:30.',
      subject: 'user',
      predicate: '5k time',
      at: 150,
    });
    const forward = deriveSupersedes([older, middle, newer]).map((edge) => edge.id);
    const backward = deriveSupersedes([newer, middle, older]).map((edge) => edge.id);
    expect(forward).toEqual(backward);
  });

  it('breaks a tie on identical times by id, so a run twice cannot disagree', () => {
    // Different text on purpose: two facts with the same text are one statement recorded twice and
    // are covered by the test above. Here the only thing deciding the direction is the id.
    const twin = { ...newer, id: 'k0', text: 'My best 5K time is 28:04.' };
    const edges = deriveSupersedes([newer, twin]);
    expect(edges.map((edge) => edge.id)).toEqual(['supersedes:k2>k0']);
  });
});
