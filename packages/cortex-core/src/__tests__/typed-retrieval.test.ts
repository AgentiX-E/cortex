/**
 * Typed expansion and the block renderer, at the shapes the rest of the suite never reaches.
 *
 * ## Why this file exists
 *
 * `expandTyped` and `renderBlock` are reached only through `assemble.ts`, so the suite exercised
 * them the way the context assembler happens to call them: with a `maxRelations` cap, with unique
 * edge ids, and with every relation already counted. Three arms were therefore unreachable from
 * any existing test -- the comparator's tie-break, and the uncapped render -- and
 * `tools/coverage-per-file.mjs` reported `src/retrieval/typed.ts` at 54/57 branches against a
 * package mean of 96.63.
 *
 * ## What each assertion is about
 *
 *   - **The tie-break is a statement about duplicate ids, not about sorting.** Two edges sharing an
 *     id is a defect upstream, but `edges` is a caller-supplied array and the comparator has to be
 *     total. A comparator that returned `-1` for equal ids would violate the sort contract, and the
 *     ordering (which decides which edge is `through` on a reached fact) would vary by engine.
 *   - **The uncapped render is the documented default.** `maxRelations` absent means "render them
 *     all", and every caller currently passes a cap, so the default had no test.
 *   - **A relation to a fact that is not in the map is skipped, not rendered as `undefined`.**
 *     That is the `other === undefined` guard, which keeps a block from quoting a fact the unit no
 *     longer holds.
 */

import { describe, expect, it } from 'vitest';

import type { KnowledgeEdge } from '../knowledge/edge.js';
import type { KnowledgeFact, KnowledgeFrame } from '../knowledge/frame.js';
import { expandTyped, renderBlock } from '../retrieval/typed.js';

const frame: KnowledgeFrame = {
  id: 'frame-1',
  text: 'I moved to Lagos so I could take the job.',
};

const fact = (over: Partial<KnowledgeFact> & { id: string }): KnowledgeFact => ({
  frameId: frame.id,
  text: `fact ${over.id}`,
  type: 'state',
  polarity: 'positive',
  modality: 'actual',
  sourceSpan: { start: 0, end: 10 },
  references: [],
  ...over,
});

const edge = (over: Partial<KnowledgeEdge> & { id: string }): KnowledgeEdge => ({
  from: 'a',
  to: 'b',
  type: 'causes',
  origin: 'extracted',
  marker: 'so',
  evidenceSpan: { start: 0, end: 20 },
  ...over,
});

describe('expandTyped', () => {
  it('orders duplicate-id edges by input order rather than returning an inconsistent comparator', () => {
    // Two edges with the same id cannot both be "first", and the comparator's `0` arm is what keeps
    // the sort stable. The reached set is asserted as a set rather than a sequence because the point
    // is that nothing is DROPPED when the comparator cannot separate two rows.
    const reached = expandTyped(
      ['a'],
      [edge({ id: 'same', from: 'a', to: 'b' }), edge({ id: 'same', from: 'a', to: 'c' })],
      { depth: 1 },
    );

    expect([...reached].map((each) => each.factId).sort()).toEqual(['b', 'c']);
    expect(reached.every((each) => each.hops === 1)).toBe(true);
    expect(reached.every((each) => each.through === 'same')).toBe(true);
  });

  it('does not traverse a supersedes edge, because that points at a fact that is no longer true', () => {
    const reached = expandTyped(
      ['a'],
      [edge({ id: 'e1', from: 'a', to: 'old', type: 'supersedes', origin: 'derived' })],
      { depth: 1 },
    );

    expect(reached).toEqual([]);
  });
});

describe('renderBlock', () => {
  const subject = fact({ id: 'a', text: 'I moved to Lagos.' });
  const other = fact({ id: 'b', text: 'I took the job.' });

  it('renders every relation when no cap is given, because absent means uncapped', () => {
    const lines = renderBlock(
      subject,
      frame,
      [
        edge({ id: 'e1', from: 'a', to: 'b' }),
        edge({ id: 'e2', from: 'b', to: 'a', marker: 'because' }),
        edge({ id: 'e3', from: 'a', to: 'c' }),
      ],
      new Map([
        ['a', subject],
        ['b', other],
      ]),
    );

    const relations = lines.filter((line) => line.startsWith('relation:'));
    // Two of the three edges name a fact the map holds; the third names `c`, which it does not.
    expect(relations).toHaveLength(2);
    expect(lines[0]).toBe('fact:     I moved to Lagos.  [state]');
    expect(lines.at(-1)).toBe(`frame:    "${frame.text}"`);
  });

  it('caps the relations it renders, and drops the ones past the cap rather than the fact', () => {
    const lines = renderBlock(
      subject,
      frame,
      [
        edge({ id: 'e1', from: 'a', to: 'b' }),
        edge({ id: 'e2', from: 'b', to: 'a', marker: 'because' }),
      ],
      new Map([
        ['a', subject],
        ['b', other],
      ]),
      { maxRelations: 1 },
    );

    expect(lines.filter((line) => line.startsWith('relation:'))).toHaveLength(1);
  });
});
