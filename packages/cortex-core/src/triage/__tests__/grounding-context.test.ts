/**
 * Grounding with a declared context: the widening, and the three properties that survive it.
 *
 * The reason this exists is `g13` — "I am planning a project in Nigeria that connects 100 rural
 * villages" split into "The project connects 100 rural villages", where the subject only exists in the
 * other clause. An atom that resolves a reference is more useful and more retrievable; the gate reads
 * one sentence, so it could not be expressed at all.
 *
 * What must not change is stated as tests rather than as intent: a word nobody said is still refused,
 * a negation is still counted against the frame alone, and every borrowed word names where it came
 * from.
 */

import { describe, expect, it } from 'vitest';
import { contentGrounded, contentGroundedIn, type GroundingSource } from '../grounding.js';

const FRAME: GroundingSource = { id: 'this-turn', text: 'It will take two years to finish.' };
const CONTEXT: GroundingSource = { id: 'last-turn', text: 'I am planning a project in Nigeria.' };

describe('contentGroundedIn: a single source behaves exactly like contentGrounded', () => {
  it('accepts and borrows nothing', () => {
    const verdict = contentGroundedIn('It will take two years.', [FRAME]);
    expect(verdict).toEqual({ ok: true, borrowed: [] });
  });

  it('refuses what contentGrounded refuses, with the same problem', () => {
    const single = contentGrounded('It will take three years.', FRAME.text);
    const multi = contentGroundedIn('It will take three years.', [FRAME]);
    expect(single.ok).toBe(false);
    expect(multi.ok).toBe(false);
    if (single.ok || multi.ok) return;
    expect(multi.problem).toBe(single.problem);
    expect(multi.detail).toBe(single.detail);
  });

  it('keeps contentGrounded free of the new field, so an existing caller sees no change', () => {
    expect(contentGrounded('It will take two years.', FRAME.text)).toEqual({ ok: true });
  });
});

describe('contentGroundedIn: borrowing from a declared context', () => {
  it('accepts a name the frame does not contain, and records where it came from', () => {
    const verdict = contentGroundedIn('The Nigeria project will take two years.', [FRAME, CONTEXT]);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.borrowed).toEqual([
      { token: 'Nigeria', sourceId: 'last-turn' },
      { token: 'project', sourceId: 'last-turn' },
    ]);
  });

  it('accepts a number the frame does not contain, and records it', () => {
    const frame: GroundingSource = { id: 'f', text: 'The sites will be ready by spring.' };
    const context: GroundingSource = { id: 'c', text: 'We have 4 sites.' };
    const verdict = contentGroundedIn('The 4 sites will be ready by spring.', [frame, context]);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.borrowed).toEqual([{ token: '4', sourceId: 'c' }]);
  });

  it('names the right source when there is more than one context', () => {
    const older: GroundingSource = { id: 'two-turns-ago', text: 'I run a bakery.' };
    const verdict = contentGroundedIn('The Nigeria bakery will take two years.', [
      FRAME,
      older,
      CONTEXT,
    ]);
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.borrowed).toEqual([
      { token: 'Nigeria', sourceId: 'last-turn' },
      { token: 'bakery', sourceId: 'two-turns-ago' },
    ]);
  });

  it('reports nothing borrowed when the frame already had everything', () => {
    const verdict = contentGroundedIn('It will take two years.', [FRAME, CONTEXT]);
    expect(verdict).toEqual({ ok: true, borrowed: [] });
  });
});

describe('contentGroundedIn: what a context may never supply', () => {
  it('still refuses a word no source contains', () => {
    const verdict = contentGroundedIn('The Kenya project will take two years.', [FRAME, CONTEXT]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.problem).toBe('new-name');
  });

  it('refuses a common word no source contains', () => {
    const verdict = contentGroundedIn('The project will need scaffolding.', [FRAME, CONTEXT]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.problem).toBe('new-word');
  });

  it('refuses a negation borrowed from another turn', () => {
    // The context says "not", the frame does not. Counting negations against the union would let a
    // sentence become negative by citing someone else's "not" -- the inversion this gate exists for.
    const negated: GroundingSource = {
      id: 'last-turn',
      text: 'I am not planning a project in Nigeria.',
    };
    const verdict = contentGroundedIn('The Nigeria project will not take two years.', [
      FRAME,
      negated,
    ]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.problem).toBe('new-negation');
  });

  it('refuses an empty atom before it looks at any source', () => {
    const verdict = contentGroundedIn('   ', [FRAME, CONTEXT]);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.problem).toBe('empty');
  });

  it('refuses to run with no source at all, because there is nothing to be faithful to', () => {
    expect(() => contentGroundedIn('anything', [])).toThrow(TypeError);
  });
});
