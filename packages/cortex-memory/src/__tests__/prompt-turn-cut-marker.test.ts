/**
 * The turn cap's cut, made visible.
 *
 * ## The defect this exists for
 *
 * §13.187 read the five durable MR declines against the stored `featurePromptTexts` and found
 * their evidence missing. One of them, `a4996e51`, is a different case: the turn that should
 * have answered it was **cut mid-sentence** by `maxTurnChars`, at `…I increase my work hours`,
 * and the very next turn in the same conversation asks how to phrase those hours. The cap
 * emitted a prefix with no sign that anything followed, and the contract tells the reader to
 * decline when an operand is not stated -- so the reader did exactly what it was told, on a
 * prompt that had silently lost the operand rather than never carried it.
 *
 * That is a presentation defect, not a retrieval one: the turn *was* delivered, the artifact's
 * coverage count says so, and the model saw a sentence that stops.
 *
 * ## Why the marker is an option and not the new default
 *
 * `prompt-turn-cap.test.ts` protects the byte-reproducibility of every archived prompt, and the
 * cap's own doc block records that the pre-cap renders must be reachable from the code. A
 * default of `'ellipsis'` would change the bytes of every capped run ever dispatched and make
 * its accuracy incomparable with the same configuration re-run today. So the shipped default is
 * `'none'`, which is byte-for-byte what `contentFor` already emitted, and the treatment is one
 * dispatched value.
 *
 * ## What the marker is allowed to touch
 *
 * Only a **turn the cap cut**. Two consequences are asserted below rather than assumed:
 * a marker with no cap is inert (there is no cut for it to mark), and an untruncated turn is
 * byte-identical under the marker as without it (a cap that appends `…` to text it did not cut
 * would be claiming a truncation that did not happen).
 *
 * The prompt-level clip in `fitToBudget` is deliberately out of scope. That clip spends the
 * last characters of the room, so a marker there would have to shorten the text by one unit to
 * pay for itself, which is a different trade than the one registered -- and the observed cut is
 * the per-turn one.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import type { AdmittedTurn } from '../admission.js';
import { CortexMemory } from '../memory.js';
import { buildPrompt, buildSessionPrompt } from '../prompt.js';
import type { AdmittedSession } from '../sessionize.js';
import type { CortexMemoryOptions } from '../types.js';

const CAP = 400;

/** The character the marker emits, spelled once so the arithmetic below is checkable. */
const MARK = '…';

function turn(content: string, index = 0): AdmittedTurn {
  return { index, content, id: `t${index}` } as unknown as AdmittedTurn;
}

function session(index: number, turns: readonly AdmittedTurn[]): AdmittedSession {
  return { index, turns: [...turns], size: turns.length } as unknown as AdmittedSession;
}

function render(content: string, options: Parameters<typeof buildPrompt>[3] = {}): string {
  return buildPrompt('Where did they go?', [turn(content)], 'abstention', options).prompt;
}

describe('a visible cut on the per-turn cap', () => {
  it('is the previous bytes by default, and `none` is the same state', () => {
    // Every archived capped run was produced by the default renderer, so the default has to be
    // the old output exactly -- not merely a prompt of the same length.
    const content = 'x'.repeat(1_000);
    const absent = render(content, { maxTurnChars: CAP });
    const named = render(content, { maxTurnChars: CAP, turnCutMarker: 'none' });

    expect(named).toBe(absent);
    expect(absent).toContain('x'.repeat(CAP));
    expect(absent).not.toContain(MARK);
  });

  it('is inert without a cap, because there is no cut to mark', () => {
    // `maxTurnChars` is the only cut this option governs. A marker that fired on an uncapped
    // turn would be asserting a truncation the prompt did not perform.
    const content = 'y'.repeat(1_000);
    const uncapped = render(content, {});
    const marked = render(content, { turnCutMarker: 'ellipsis' });

    expect(marked).toBe(uncapped);
    expect(uncapped).toContain(content);
  });

  it('ends a cut turn with the marker and spends none of the cap on it', () => {
    // The marker occupies one of the cap's units rather than being added beyond it: a prompt
    // one character over the configured cap is an overrun that every room calculation in the
    // allocator assumes cannot happen.
    const prompt = render('x'.repeat(1_000), { maxTurnChars: CAP, turnCutMarker: 'ellipsis' });

    expect(prompt).toContain(`1. ${'x'.repeat(CAP - 1)}${MARK}`);
    expect(prompt).not.toContain('x'.repeat(CAP));
  });

  it('backs off to a word boundary when one is close, so the marker does not cap a fragment', () => {
    // The failing turn's cut landed inside `hours`; backing off to the previous space keeps the
    // last visible word whole, which is the difference between `…I increase my work` and
    // `…I increase my wor`.
    const content = `${'a'.repeat(390)} ${'b'.repeat(609)}`;
    const prompt = render(content, { maxTurnChars: CAP, turnCutMarker: 'ellipsis' });

    expect(prompt).toContain(`1. ${'a'.repeat(390)}${MARK}`);
    // The second word is gone entirely, not merely shortened: the boundary was taken, so no part
    // of `b` may survive past the marker. The assertion is a run rather than one character
    // because the instruction block's own prose contains a `b`.
    expect(prompt).not.toContain('b'.repeat(10));
  });

  it('keeps the hard cut when the nearest boundary is far back', () => {
    // Backing off without a floor would let one early space throw away most of the window --
    // a turn that rendered 51 characters under a 400-character cap and called that a cap.
    const content = `${'a'.repeat(50)} ${'b'.repeat(949)}`;
    const prompt = render(content, { maxTurnChars: CAP, turnCutMarker: 'ellipsis' });

    expect(prompt).toContain(`1. ${'a'.repeat(50)} ${'b'.repeat(348)}${MARK}`);
  });

  it('leaves a turn it did not cut byte-identical, marker or not', () => {
    const content = 'user: I went to Lisbon in May.';
    const plain = render(content, { maxTurnChars: CAP });
    const marked = render(content, { maxTurnChars: CAP, turnCutMarker: 'ellipsis' });

    expect(marked).toBe(plain);
    expect(marked).not.toContain(MARK);
  });

  it('does not split a surrogate pair when the marker takes the last unit', () => {
    // The marker shifts the cut one unit left, which moves the pair boundary too: with the cap
    // at 400 the naive cut lands on a low surrogate, and the back-off has to happen *before*
    // the one unit the marker reserved.
    const content = `${'a'.repeat(398)}\u{1F600}tail`;
    const prompt = render(content, { maxTurnChars: CAP, turnCutMarker: 'ellipsis' });

    expect(prompt).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(prompt).toContain(`1. ${'a'.repeat(398)}${MARK}`);
  });

  it('renders nothing under a degenerate cap, exactly as the silent path does', () => {
    // `maxTurnChars: 0` is refused at the arm's boundary and is still expressible through this
    // package's API, so the two paths must agree about what it means: no text. A marker that
    // survived an empty cut would put `…` where a turn's content belongs and read as a turn that
    // was shown, which is the §13.67 defect with a mark of omission on it.
    const content = 'x'.repeat(100);
    const silent = render(content, { maxTurnChars: 0 });
    const marked = render(content, { maxTurnChars: 0, turnCutMarker: 'ellipsis' });

    expect(marked).toBe(silent);
    expect(marked).toContain('1. ');
    expect(marked).not.toContain(MARK);
  });

  it('reaches both renderings and the session route, which is the route MR uses', () => {
    // The cap is honoured, or not, in one predicate that two renderers and the session block
    // builder all call. Asserting all three here is what makes that a property of the code
    // rather than of one path: `sourced` is the §12.5 rendering and the session route is where
    // the measured cut happened.
    const content = 'x'.repeat(1_000);
    const cut = `${'x'.repeat(CAP - 1)}${MARK}`;

    const sourced = buildPrompt('Where?', [turn(content, 3)], 'abstention', {
      maxTurnChars: CAP,
      turnCutMarker: 'ellipsis',
      rendering: 'sourced',
    }).prompt;
    expect(sourced).toContain(`1. [t3] ${cut}`);

    const grouped = buildSessionPrompt('Where?', [session(0, [turn(content)])], {
      maxTurnChars: CAP,
      turnCutMarker: 'ellipsis',
    }).prompt;
    expect(grouped).toContain(cut);
    expect(grouped).not.toContain('x'.repeat(CAP));
  });

  it('still fits the same number of turns, because the marker is inside the cap', () => {
    // The cap's purpose is room. A marker that cost one extra unit per turn would reduce the
    // number of turns the same room buys, which is the opposite of what the cap is for.
    const turns = Array.from({ length: 40 }, (_, index) => turn('z'.repeat(600), index));
    const room = 4_000;

    const plain = buildPrompt('Where?', turns, 'abstention', { maxChars: room, maxTurnChars: 200 });
    const marked = buildPrompt('Where?', turns, 'abstention', {
      maxChars: room,
      maxTurnChars: 200,
      turnCutMarker: 'ellipsis',
    });

    expect(marked.carried.length).toBe(plain.carried.length);
    expect(marked.prompt.length).toBeLessThanOrEqual(room);
  });
});

/**
 * The forwarding, which is where a marker becomes inert without anything failing.
 *
 * `#promptOptions` is the one place a `CortexMemoryOptions` field becomes a `PromptOptions`
 * field, and a field it does not forward is a field the arm can configure and the prompt can
 * ignore -- the §7.4 side-channel defect that `maxTurnChars` itself was once exposed to.
 */
describe('the marker reaches the model through the system', () => {
  function recordingLlm(seen: string[]): LLM {
    return {
      complete: async (prompt: string) => {
        seen.push(prompt);
        return 'Lisbon';
      },
      completeStructured: async () => {
        throw new Error('unused by this package');
      },
    };
  }

  function system(options: Partial<CortexMemoryOptions> & { llm: LLM }): CortexMemory {
    return new CortexMemory({
      now: 1_759_470_000_000,
      gate: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: () => 1,
      },
      ...options,
    });
  }

  const CONTENT = 'w'.repeat(1_000);

  it('sends the marker to the model when it is configured', async () => {
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen),
      maxTurnChars: CAP,
      turnCutMarker: 'ellipsis',
    });

    await memory.answer('Where did they go?', [CONTENT]);

    expect(seen[0]).toContain(`${'w'.repeat(CAP - 1)}${MARK}`);
    // The record is still the turn as it arrived: the marker is presentation.
    expect(memory.lastRetrievedContext()?.[0]).toHaveLength(1_000);
  });

  it('sends the previous bytes when the marker is not configured', async () => {
    const seen: string[] = [];
    const memory = system({ llm: recordingLlm(seen), maxTurnChars: CAP });

    await memory.answer('Where did they go?', [CONTENT]);

    expect(seen[0]).not.toContain(MARK);
    expect(seen[0]).toContain('w'.repeat(CAP));
  });
});
