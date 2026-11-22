/**
 * Composition as a seam: what the selector guarantees before any renderer sees it.
 *
 * ## Why this file no longer asserts what the prompt says
 *
 * It did, when the renderer was imported here. The rendering semantics -- numbering, the room's cut
 * taken from the front, one score per distinct text -- moved to `cortex-memory` with `renderInOrder`
 * and are tested there. What remains is this module's own claim: a selection arrives normalised
 * (unique, in range, in the reader's order) and the caller's config arrives untouched.
 *
 * ## Why the network of assertions below matters more than it looks
 *
 * Both guarantees are invisible in an artifact when they break. A duplicate id is a turn printed
 * twice, which reads as a wider room rather than as a bug; an out-of-range id is a prompt that
 * silently carries one turn fewer than the trace reports as selected. The cases that would catch
 * either have to assert the *input the renderer received*, which is why the recorder exists instead
 * of a real renderer.
 *
 * The byte-for-byte equivalence between "this selection through the registered renderer" and "the
 * registered assembly" is asserted in `cortex-eval`, the one package that may see both sides --
 * `cortex-ai` must not depend on `cortex-memory`, and `cortex-memory` must not depend on this
 * package. Putting that case here would have reintroduced the edge this refactor removed.
 */
import { describe, expect, it } from 'vitest';

import { carriedIds, composeAgentPrompt } from '../../agent/compose.js';
import type { Renderer } from '../../agent/types.js';

/** A renderer with no imports and no knowledge of this repository. */
type Tagged = { readonly tag: string };
type TaggedInput = Parameters<Renderer<Tagged>>[0];

function recorder(): {
  seen: { value: TaggedInput | null };
  renderer: Renderer<Tagged>;
} {
  const seen: { value: TaggedInput | null } = { value: null };
  return {
    seen,
    renderer: (input) => {
      seen.value = input;
      return {
        prompt: `<${String(input.ordered.length)} turns>`,
        evidenceChars: 0,
        carried: input.ordered.map((ordinal) => ({ ordinal })),
      };
    },
  };
}

describe('composeAgentPrompt', () => {
  it('passes the normalised order and the config through untouched', () => {
    const spy = recorder();
    const out = composeAgentPrompt('q', ['a', 'b', 'c'], [2, 2, 9, 1], {
      renderer: spy.renderer,
      config: { tag: 'anything' },
    });
    expect(spy.seen.value?.ordered).toEqual([2, 1]);
    expect(spy.seen.value?.config).toEqual({ tag: 'anything' });
    expect(spy.seen.value?.turns).toEqual(['a', 'b', 'c']);
    expect(spy.seen.value?.question).toBe('q');
    expect(out.prompt).toBe('<2 turns>');
    expect(carriedIds(out)).toEqual([2, 1]);
  });

  it('keeps the reader order rather than sorting it', () => {
    // The order is the whole selection signal: a loop that chose 2 before 0 and was printed 0 before
    // 2 would have made a choice no reader can see. Sorting here would still produce a valid prompt,
    // which is why the assertion has to be on the exact sequence.
    const spy = recorder();
    composeAgentPrompt('q', ['a', 'b', 'c', 'd'], [3, 0, 2], {
      renderer: spy.renderer,
      config: { tag: 't' },
    });
    expect(spy.seen.value?.ordered).toEqual([3, 0, 2]);
  });

  it('drops an id the corpus does not hold rather than passing it on', () => {
    const spy = recorder();
    composeAgentPrompt('q', ['a', 'b'], [0, 1, 2, -1], {
      renderer: spy.renderer,
      config: { tag: 't' },
    });
    expect(spy.seen.value?.ordered).toEqual([0, 1]);
  });

  it('drops a non-integer id, which no array index can name', () => {
    const spy = recorder();
    composeAgentPrompt('q', ['a', 'b', 'c'], [1.5, Number.NaN, 2], {
      renderer: spy.renderer,
      config: { tag: 't' },
    });
    expect(spy.seen.value?.ordered).toEqual([2]);
  });

  it('calls the renderer exactly once, so a bill has one charge per composed prompt', () => {
    let calls = 0;
    composeAgentPrompt('q', ['a'], [0], {
      renderer: (input) => {
        calls += 1;
        return {
          prompt: '',
          evidenceChars: 0,
          carried: input.ordered.map((ordinal) => ({ ordinal })),
        };
      },
      config: { tag: 't' },
    });
    expect(calls).toBe(1);
  });

  it('hands an empty order through instead of short-circuiting', () => {
    // A caller that reached this with nothing selected has a fact worth rendering -- the
    // no-evidence prompt -- and returning a blank object here would be a second way to say it.
    const spy = recorder();
    const out = composeAgentPrompt('q', ['a'], [], {
      renderer: spy.renderer,
      config: { tag: 't' },
    });
    expect(spy.seen.value?.ordered).toEqual([]);
    expect(out.prompt).toBe('<0 turns>');
  });
});
