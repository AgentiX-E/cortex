/**
 * The assembly gate: does a split keep every relation the sentence stated?
 *
 * Every frame in this suite is a real card from the reviewed set, because the point of the gate is to
 * refuse the two things a reviewer actually saw -- `g00` split into two unrelated facts, and `g05`
 * reduced to its second half -- and to accept the shapes that were fine.
 */

import { describe, expect, it } from 'vitest';
import { buildKnowledgeUnit, censusOf, type BuildUnitInput } from '../unit.js';
import type { KnowledgeEdge } from '../edge.js';
import type { KnowledgeFact, KnowledgeFrame } from '../frame.js';

/** `g00` from the second review round. Two facts, joined by "so". */
const G00: KnowledgeFrame = {
  id: 'g00',
  text: "By the way, I just finished an online course on data analysis using Python, so I'm interested in applying my new skills to improve my SEO strategies.",
};

const G00_FIRST: KnowledgeFact = {
  id: 'a1',
  frameId: 'g00',
  text: 'I just finished an online course on data analysis using Python.',
  type: 'event',
  polarity: 'positive',
  modality: 'actual',
  sourceSpan: { start: 12, end: 68 },
  references: [],
};

const G00_SECOND: KnowledgeFact = {
  id: 'a2',
  frameId: 'g00',
  text: 'I am interested in applying my new skills to improve my SEO strategies.',
  type: 'preference',
  polarity: 'positive',
  modality: 'actual',
  sourceSpan: { start: 73, end: 145 },
  references: [],
};

const G00_CAUSAL: KnowledgeEdge = {
  id: 'causes:a1>a2',
  from: 'a1',
  to: 'a2',
  type: 'causes',
  origin: 'extracted',
  marker: 'so',
  evidenceSpan: { start: 0, end: G00.text.length },
};

/** `g18` from the same round: one fact that carries its own marker. */
const G18: KnowledgeFrame = {
  id: 'g18',
  text: 'By the way, speaking of TV shows, I also watch Brooklyn Nine-Nine during my lunch break at work.',
};

const G18_FACT: KnowledgeFact = {
  id: 'b1',
  frameId: 'g18',
  text: 'I watch Brooklyn Nine-Nine during my lunch break at work.',
  type: 'state',
  polarity: 'positive',
  modality: 'actual',
  sourceSpan: { start: 38, end: 91 },
  references: [],
};

/** `g04`: no marker in the sentence at all, so there is no relation for the split to lose. */
const G04: KnowledgeFrame = {
  id: 'g04',
  text: "By the way, I've been really enjoying editing my photos in Lightroom - the online communities I've joined have been super helpful in learning new techniques and getting feedback on my work.",
};

const G04_RELATIONAL: KnowledgeFact = {
  id: 'c1',
  frameId: 'g04',
  text: 'Online communities help me learn new techniques.',
  type: 'relation',
  polarity: 'positive',
  modality: 'actual',
  sourceSpan: { start: 80, end: 158 },
  references: [],
};

function build(
  input: Partial<BuildUnitInput> & Pick<BuildUnitInput, 'frame' | 'facts'>,
): ReturnType<typeof buildKnowledgeUnit> {
  return buildKnowledgeUnit({ edges: [], ...input });
}

describe('buildKnowledgeUnit: a relation the sentence states must be represented', () => {
  it('refuses a split that drops "so" and offers no edge', () => {
    const result = build({ frame: G00, facts: [G00_FIRST, G00_SECOND] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.problem).toBe('unresolved-marker');
  });

  it('accepts the same split once the edge carries the marker', () => {
    const result = build({ frame: G00, facts: [G00_FIRST, G00_SECOND], edges: [G00_CAUSAL] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unit.unresolved).toEqual([]);
    expect(result.unit.edges).toHaveLength(1);
  });

  it('records instead of refusing under the migration policy, and says how many were lost', () => {
    const result = build({ frame: G00, facts: [G00_FIRST, G00_SECOND], policy: 'record' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.unit.unresolved).toHaveLength(1);
    expect(result.unit.unresolved[0]!.token).toBe('so');
    expect(censusOf(result.unit).unresolved).toBe(1);
  });

  it('accepts a fact that carries its marker, because the marker then scopes that fact', () => {
    expect(build({ frame: G18, facts: [G18_FACT] }).ok).toBe(true);
  });

  it('accepts a sentence with no marker: there is no relation to lose', () => {
    expect(build({ frame: G04, facts: [G04_RELATIONAL] }).ok).toBe(true);
  });

  it('accepts the relational shape even when the sentence does have a marker elsewhere', () => {
    // The relation may be *stated* rather than *linked*. Requiring an edge for a sentence the model
    // already distilled into a relational proposition would punish the better output.
    const frame: KnowledgeFrame = {
      id: 'r1',
      text: 'I joined two photography communities, so they help me learn techniques.',
    };
    const fact: KnowledgeFact = {
      id: 'd1',
      frameId: 'r1',
      text: 'Photography communities help me learn techniques.',
      type: 'relation',
      polarity: 'positive',
      modality: 'actual',
      sourceSpan: { start: 0, end: frame.text.length },
      references: [],
    };
    expect(build({ frame, facts: [fact] }).ok).toBe(true);
  });

  it('does not let one relational fact discharge two connectives', () => {
    const frame: KnowledgeFrame = {
      id: 'r2',
      text: 'I joined two communities because I like feedback, so they help me learn.',
    };
    const fact: KnowledgeFact = {
      id: 'd2',
      frameId: 'r2',
      text: 'Communities help me learn.',
      type: 'relation',
      polarity: 'positive',
      modality: 'actual',
      sourceSpan: { start: 0, end: frame.text.length },
      references: [],
    };
    const result = build({ frame, facts: [fact] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.problem).toBe('unresolved-marker');
  });
});

describe('buildKnowledgeUnit: grounding and borrowing', () => {
  const context: KnowledgeFrame = { id: 'earlier', text: 'I am planning a project in Nigeria.' };
  const frame: KnowledgeFrame = { id: 'later', text: 'It will take two years.' };

  const borrowing: KnowledgeFact = {
    id: 'e1',
    frameId: 'later',
    text: 'The Nigeria project will take two years.',
    type: 'state',
    polarity: 'positive',
    modality: 'actual',
    sourceSpan: { start: 0, end: frame.text.length },
    references: [
      { token: 'Nigeria', sourceId: 'earlier' },
      { token: 'project', sourceId: 'earlier' },
    ],
  };

  it('accepts a word borrowed from a declared context, when it is recorded', () => {
    expect(build({ frame, facts: [borrowing], context: [context] }).ok).toBe(true);
  });

  it('refuses a borrowed word that was not recorded', () => {
    const result = build({ frame, facts: [{ ...borrowing, references: [] }], context: [context] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.problem).toBe('unrecorded-borrowing');
  });

  it('refuses a word that no source contains, recorded or not', () => {
    const invented = { ...borrowing, text: 'The Nigeria project will take three years.' };
    const result = build({ frame, facts: [invented], context: [context] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.problem).toBe('ungrounded');
  });

  it('refuses a borrow the context does not support', () => {
    const result = build({
      frame,
      facts: [{ ...borrowing, references: [{ token: 'project', sourceId: 'earlier' }] }],
      context: [{ id: 'earlier', text: 'I am planning something in Nigeria.' }],
    });
    // "project" is now absent from both sources; the recorded receipt cannot make it true.
    expect(result.ok).toBe(false);
  });

  it('never lets a negation be borrowed, because that inverts a claim with another turn"s grammar', () => {
    const negated = { ...borrowing, text: 'The Nigeria project will not take two years.' };
    const result = build({
      frame,
      facts: [negated],
      context: [{ id: 'earlier', text: 'I am not planning a project in Nigeria.' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.problem).toBe('ungrounded');
  });
});

describe('buildKnowledgeUnit: structural refusals', () => {
  it('refuses two facts under one id', () => {
    const result = build({ frame: G18, facts: [G18_FACT, { ...G18_FACT }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.problem).toBe('duplicate-id');
  });

  it('refuses two edges under one id', () => {
    const result = build({
      frame: G00,
      facts: [G00_FIRST, G00_SECOND],
      edges: [G00_CAUSAL, { ...G00_CAUSAL }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.problem).toBe('duplicate-id');
  });

  it('reports a bad fact before it looks at any edge', () => {
    const result = build({
      frame: G00,
      facts: [{ ...G00_FIRST, sourceSpan: { start: 0, end: G00.text.length + 1 } }],
      edges: [G00_CAUSAL],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.problem).toBe('fact');
    if (result.problem.problem !== 'fact') return;
    expect(result.problem.detail.problem).toBe('span-outside-frame');
  });

  it('refuses an edge whose endpoints are not in the unit', () => {
    const result = build({ frame: G00, facts: [G00_FIRST], edges: [G00_CAUSAL] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.problem).toBe('edge');
    if (result.problem.problem !== 'edge') return;
    expect(result.problem.detail.problem).toBe('unknown-endpoint');
  });
});

describe('censusOf: what a unit contains', () => {
  it('counts facts and edges by type, and only types that occur', () => {
    const result = build({ frame: G00, facts: [G00_FIRST, G00_SECOND], edges: [G00_CAUSAL] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(censusOf(result.unit)).toEqual({
      facts: 2,
      edges: 1,
      factsByType: { event: 1, preference: 1 },
      edgesByType: { causes: 1 },
      unresolved: 0,
    });
  });

  it('counts nothing for an empty unit', () => {
    const result = build({ frame: G04, facts: [] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(censusOf(result.unit)).toEqual({
      facts: 0,
      edges: 0,
      factsByType: {},
      edgesByType: {},
      unresolved: 0,
    });
  });
});
