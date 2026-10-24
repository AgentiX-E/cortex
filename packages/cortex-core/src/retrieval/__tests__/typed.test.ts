/**
 * Expansion, the budget, and the block.
 *
 * The two properties worth stating outright, because both are the opposite of what a "graph memory"
 * implementation would do by default:
 *
 * 1. **Traversal never follows `supersedes`.** Walking into a replaced fact while answering "what is
 *    the current value" is how a reader ends up quoting a superseded number, which is the recorded
 *    failure this whole design is aimed at.
 * 2. **The block keeps the frame.** The delivered unit is three lines, not one, and the budget is
 *    spent on the block rather than the atom.
 */

import { describe, expect, it } from 'vitest';
import { fillBudget, fuseWithScores, reciprocalRankFusion } from '../fuse.js';
import { expandTyped, renderBlock, renderBlocks, tokenEstimate } from '../typed.js';
import type { KnowledgeEdge } from '../../knowledge/edge.js';
import type { KnowledgeFact, KnowledgeFrame } from '../../knowledge/frame.js';
import type { KnowledgeUnit } from '../../knowledge/unit.js';

const FRAME: KnowledgeFrame = {
  id: 'f0',
  text: 'I finished the course, so I applied it, but the exam was hard.',
};

function factOf(id: string, text: string, type: KnowledgeFact['type'] = 'event'): KnowledgeFact {
  return {
    id,
    frameId: 'f0',
    text,
    type,
    polarity: 'positive',
    modality: 'actual',
    sourceSpan: { start: 0, end: 10 },
    references: [],
  };
}

const A1 = factOf('a1', 'I finished the course.');
const A2 = factOf('a2', 'I applied it.');
const A3 = factOf('a3', 'The exam was hard.', 'evaluation');
const A4 = factOf('a4', 'The exam was easy.');

const EDGES: readonly KnowledgeEdge[] = [
  {
    id: 'causes:a1>a2',
    from: 'a1',
    to: 'a2',
    type: 'causes',
    origin: 'extracted',
    marker: 'so',
    evidenceSpan: { start: 0, end: 40 },
  },
  {
    id: 'contrast:a2>a3',
    from: 'a2',
    to: 'a3',
    type: 'contrast',
    origin: 'extracted',
    marker: 'but',
    evidenceSpan: { start: 40, end: 70 },
  },
  { id: 'supersedes:a4>a3', from: 'a4', to: 'a3', type: 'supersedes', origin: 'derived' },
];

describe('expandTyped: follow relations, never follow replacement', () => {
  it('reaches one hop in both directions', () => {
    expect(expandTyped(['a1'], EDGES).map((hit) => hit.factId)).toEqual(['a2']);
    expect(
      expandTyped(['a2'], EDGES)
        .map((hit) => hit.factId)
        .sort(),
    ).toEqual(['a1', 'a3']);
  });

  it('records the edge that reached each fact, so a path is reportable', () => {
    expect(expandTyped(['a1'], EDGES)[0]).toEqual({
      factId: 'a2',
      hops: 1,
      through: 'causes:a1>a2',
      type: 'causes',
    });
  });

  it('does not traverse into a superseded fact', () => {
    expect(expandTyped(['a3'], EDGES).map((hit) => hit.factId)).not.toContain('a4');
    expect(expandTyped(['a4'], EDGES)).toEqual([]);
  });

  it('goes two hops when asked, and not further', () => {
    const two = expandTyped(['a1'], EDGES, { depth: 2 });
    expect(two.map((hit) => hit.factId)).toEqual(['a2', 'a3']);
    expect(two.map((hit) => hit.hops)).toEqual([1, 2]);
  });

  it('returns nothing for an unknown seed rather than throwing', () => {
    expect(expandTyped(['nope'], EDGES)).toEqual([]);
  });

  it('honours an explicit channel set, which is what an ablation needs', () => {
    expect(expandTyped(['a2'], EDGES, { via: ['contrast'] }).map((hit) => hit.factId)).toEqual([
      'a3',
    ]);
  });

  it('is deterministic on duplicate edges between the same pair', () => {
    const twice = [...EDGES, { ...EDGES[0]!, id: 'causes:a1>a2:again' }];
    expect(expandTyped(['a1'], twice).map((hit) => hit.factId)).toEqual(['a2']);
  });
});

describe('determinism under shuffled input', () => {
  it('sorts the edge set before walking it, so input order cannot change the result', () => {
    const shuffled = [EDGES[2]!, EDGES[1]!, EDGES[0]!];
    expect(expandTyped(['a2'], shuffled).map((hit) => hit.factId)).toEqual(['a1', 'a3']);
  });

  it('stops when a hop reaches nothing, and does not loop to the requested depth', () => {
    const deep = expandTyped(['a1'], EDGES, { depth: 5 });
    expect(deep.map((hit) => hit.factId)).toEqual(['a2', 'a3']);
  });

  it('orders relations by edge id, so two renders of one unit are byte-identical', () => {
    const facts = new Map([A1, A2].map((fact) => [fact.id, fact]));
    const forward = renderBlock(A2, FRAME, EDGES, facts);
    const backward = renderBlock(A2, FRAME, [...EDGES].reverse(), facts);
    expect(forward).toEqual(backward);
  });
});

describe('renderBlock: the degenerate relations', () => {
  const facts = new Map([A1, A2, A3].map((fact) => [fact.id, fact]));

  it('skips a supersedes link whose other end is absent, in both directions', () => {
    const lonely = new Map([['a3', A3]]);
    expect(renderBlock(A3, FRAME, EDGES, lonely).some((line) => line.startsWith('status:'))).toBe(
      false,
    );
  });

  it('renders a markerless relation without inventing an empty marker slot', () => {
    const elaborated: KnowledgeEdge = {
      id: 'elaborates:a3>a2',
      from: 'a3',
      to: 'a2',
      type: 'elaborates',
      origin: 'derived',
    };
    const lines = renderBlock(A3, FRAME, [elaborated], facts);
    expect(lines).toContain('relation: -> elaborates -> "I applied it."');
    expect(lines.join('\n')).not.toContain('marker:');
  });

  it('quotes the other fact when the block does not contain it', () => {
    const partial = new Set(['a1']);
    const lines = renderBlock(A1, FRAME, EDGES, facts, { referenced: partial });
    expect(lines).toContain('relation: -> causes -> "I applied it."  (marker: "so")');
  });
});

describe('tokenEstimate: an estimate, and labelled as one', () => {
  it('is a quarter of the characters, rounded up', () => {
    expect(tokenEstimate('abcd')).toBe(1);
    expect(tokenEstimate('abcde')).toBe(2);
    expect(tokenEstimate('')).toBe(0);
  });
});

describe('renderBlock: fact, relation, frame', () => {
  const facts = new Map([A1, A2, A3, A4].map((fact) => [fact.id, fact]));

  it('emits the three lines, with the marker that licensed the relation', () => {
    expect(renderBlock(A1, FRAME, EDGES, facts)).toEqual([
      'fact:     I finished the course.  [event]',
      'relation: -> causes -> "I applied it."  (marker: "so")',
      'frame:    "' + FRAME.text + '"',
    ]);
  });

  it('renders an incoming relation from the far end with an arrow back', () => {
    const lines = renderBlock(A2, FRAME, EDGES, facts);
    expect(lines).toContain('relation: <- causes <- "I finished the course."  (marker: "so")');
    expect(lines).toContain('relation: -> contrast -> "The exam was hard."  (marker: "but")');
  });

  it('labels replacement in both directions, because either end may be the one asked about', () => {
    expect(renderBlock(A3, FRAME, EDGES, facts)).toContain(
      'status:   superseded by "The exam was easy."',
    );
    expect(renderBlock(A4, FRAME, EDGES, facts)).toContain(
      'status:   replaces "The exam was hard."',
    );
  });

  it('caps relation lines without touching the fact or the frame', () => {
    const lines = renderBlock(A2, FRAME, EDGES, facts, { maxRelations: 1 });
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('I applied it.');
    expect(lines[2]).toBe('frame:    "' + FRAME.text + '"');
  });

  it('omits a relation whose other end is not in the map rather than rendering a bare id', () => {
    const lonely = new Map([['a1', A1]]);
    expect(renderBlock(A1, FRAME, EDGES, lonely)).toEqual([
      'fact:     I finished the course.  [event]',
      'frame:    "' + FRAME.text + '"',
    ]);
  });

  it('is byte-identical across two calls, because a block is compared by eye and by diff', () => {
    expect(renderBlock(A2, FRAME, EDGES, facts)).toEqual(renderBlock(A2, FRAME, EDGES, facts));
  });
});

describe('renderBlocks: the caller owns the order', () => {
  const unit: KnowledgeUnit = {
    frame: FRAME,
    facts: [A1, A2, A3, A4],
    edges: EDGES,
    unresolved: [],
  };

  it('states the frame once and then each fact in the order asked', () => {
    const lines = renderBlocks(unit, ['a3', 'a1']);
    expect(lines[0]).toBe('frame:    "' + FRAME.text + '"');
    expect(lines.filter((line) => line.startsWith('frame:'))).toHaveLength(1);
    expect(lines[1]).toContain('The exam was hard.');
    expect(lines.find((line) => line.includes('I finished the course.'))).toBeDefined();
  });

  it('costs less than the self-contained blocks it replaces, which is why it is grouped', () => {
    const facts = new Map(unit.facts.map((fact) => [fact.id, fact]));
    const selfContained = [A1, A2]
      .map((fact) => renderBlock(fact, FRAME, EDGES, facts).join('\n'))
      .join('\n');
    const grouped = renderBlocks(unit, ['a1', 'a2']).join('\n');
    expect(tokenEstimate(grouped)).toBeLessThan(tokenEstimate(selfContained));
  });

  it('skips an id that is not in the unit', () => {
    expect(
      renderBlocks(unit, ['a1', 'nope']).filter((line) => line.startsWith('fact:')),
    ).toHaveLength(1);
  });

  it('returns nothing for an empty request', () => {
    expect(renderBlocks(unit, [])).toEqual([]);
  });
});

describe('reciprocalRankFusion: ranks, not scores', () => {
  it('ranks an item found by both channels above one found by either', () => {
    const fused = reciprocalRankFusion(
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
      (item) => item,
    );
    expect(fused[0]).toBe('b');
    expect(fused).toHaveLength(3);
  });

  it('emits an item once, at its best fused score', () => {
    const fused = reciprocalRankFusion([['a', 'b', 'a']], (item) => item);
    expect(fused).toEqual(['a', 'b']);
  });

  it('is a pure function of the lists, including ties', () => {
    const lists = [
      ['b', 'a'],
      ['a', 'b'],
    ];
    expect(reciprocalRankFusion(lists, (item) => item)).toEqual(
      reciprocalRankFusion(lists, (item) => item),
    );
  });

  it('breaks a tie by first appearance across the channels, in argument order', () => {
    expect(reciprocalRankFusion([['x'], ['y']], (item) => item)).toEqual(['x', 'y']);
  });

  it('keeps the score it used, for a report', () => {
    const scored = fuseWithScores([['a'], ['a']], (item) => item, 60);
    expect(scored).toHaveLength(1);
    expect(scored[0]!.score).toBeCloseTo(2 / 61, 10);
  });
});

describe('fillBudget: spend tokens, not slots', () => {
  const cost = (item: { cost: number }): number => item.cost;

  it('takes items until the budget is spent', () => {
    const fill = fillBudget([{ cost: 4 }, { cost: 5 }, { cost: 6 }], cost, 10);
    expect(fill.kept).toEqual([{ cost: 4 }, { cost: 5 }]);
    expect(fill.spent).toBe(9);
    expect(fill.skipped).toEqual([{ cost: 6 }]);
  });

  it('skips an item that does not fit and keeps looking, rather than stopping', () => {
    const fill = fillBudget([{ cost: 8 }, { cost: 5 }, { cost: 2 }], cost, 10);
    expect(fill.kept).toEqual([{ cost: 8 }, { cost: 2 }]);
    expect(fill.skipped).toEqual([{ cost: 5 }]);
  });

  it('keeps nothing when the budget is zero, and reports what it dropped', () => {
    const fill = fillBudget([{ cost: 1 }], cost, 0);
    expect(fill.kept).toEqual([]);
    expect(fill.spent).toBe(0);
    expect(fill.skipped).toHaveLength(1);
  });

  it('never exceeds the budget', () => {
    const fill = fillBudget([{ cost: 3 }, { cost: 3 }, { cost: 3 }], cost, 7);
    expect(fill.spent).toBeLessThanOrEqual(7);
  });
});
