/**
 * The mark that travels with the statement a later turn replaces.
 *
 * ## What this file has to be able to fail at
 *
 * Three claims, each of which a wrong implementation would satisfy in a different way:
 *
 *   - **reach.** The routes whose prompt moves between `off` and `mark` is exactly the four the option
 *     declares, so a route that moves undeclared fails and one declared but inert fails too. This is the
 *     one claim a "the marker is in the prompt" assertion cannot make.
 *   - **arithmetic.** With `mark` on, the delivered prompt is longer than the control's by
 *     `SUPERSEDED_MARKER.length` times the number of marked turns, and deleting the marker from the
 *     treatment reproduces the control **byte for byte**. That is a stronger statement than "the evidence
 *     is untouched": it says the mark is the only difference and its size is computable.
 *   - **the census is the cap's, not the mark's.** `mark` does not change `turnWindow`; `collapse` adds
 *     exactly one to `cut` per collapsed turn and leaves `marked` alone, because it emits no elision.
 *
 * The fixture is `a2f3aa27`'s own wording — 1250 in May, "close to 1300" two-thirds of the way into the
 * window, gold `1300` — so the population is the artifact's rather than one written to agree with the
 * mechanism.
 *
 * ## The boundary case is constructed on purpose
 *
 * The mark is charged to the budget (see `PromptOptions.superseded`), so a prompt within one marker of its
 * room delivers a shorter set with the mark on than with it off. That is a real consequence of putting the
 * mark inside the evidence rather than beside it, and the last suite builds the case by arithmetic instead
 * of leaving it to be discovered on a dispatch.
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import type { AdmittedTurn } from '../admission.js';
import { buildPrompt } from '../prompt.js';
import { CortexMemory } from '../memory.js';
import {
  SUPERSEDED_COLLAPSED,
  SUPERSEDED_MARKER,
  renderSupersededInline,
  supersededTurns,
  type SupersededMarks,
} from '../superseded.js';

const NOW = 1_759_470_000_000;

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

const FIRST = 'I have got 1250 followers on Instagram now, so insights would help.';
const SECOND = 'I think I am close to 1300 followers on Instagram now, honestly.';
const QUESTION = 'How many followers do I have on Instagram now?';
const UNRELATED = 'What day of the week is the recycling collected?';

/** A turn as the window holds it. `id` is the content, so a mark can be tied back by reading it. */
function turn(content: string, ordinal = 0): AdmittedTurn {
  return {
    id: content,
    content,
    value: 0.5,
    confidence: 1,
    source: 'unknown',
    sourceTrust: 0.5,
    type: 'episodic',
    tags: [],
    createdAt: 0,
    lastAccessedAt: 0,
    stability: 1,
    difficulty: 5,
    reads: 0,
    memoryType: 'episodic',
    activation: 0.5,
    decay: 0.5,
    rehearsalCount: 0,
    ordinal,
  } as AdmittedTurn;
}

function recorder(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return '1300';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function build(seen: string[], rendering: 'off' | 'mark' | 'collapse' | undefined): CortexMemory {
  return new CortexMemory({
    llm: recorder(seen),
    now: NOW,
    name: 'cortex-memory',
    gate: { ...GATE },
    ...(rendering === undefined ? {} : { supersededRendering: rendering }),
  });
}

const ROUTES: ReadonlyArray<
  readonly [string, (m: CortexMemory, question: string) => Promise<unknown>]
> = [
  ['abstention', (m, question) => m.answerAbstention(question, [FIRST, SECOND])],
  ['multi-session', (m, question) => m.answerSessions(question, [[FIRST], [SECOND]])],
  ['temporal', (m, question) => m.answerTemporal(question, [FIRST, SECOND], '2023/06/01')],
  ['knowledge-update', (m, question) => m.answerKnowledgeUpdate(question, [FIRST, SECOND])],
  ['assistant', (m, question) => m.answerAssistant(question, [FIRST, SECOND])],
  ['flat', (m, question) => m.answer(question, [FIRST, SECOND])],
];

async function promptUnder(
  drive: (m: CortexMemory, question: string) => Promise<unknown>,
  rendering: 'off' | 'mark' | 'collapse' | undefined,
  question: string,
): Promise<string> {
  const seen: string[] = [];
  await drive(build(seen, rendering), question);
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

/**
 * The five routes the mark reaches.
 *
 * One more than `conflicts`, and the extra one is multi-session: the side block is excluded there because
 * it would flatten the boundaries, and a mark appended to a turn inside its own block does not. The
 * exclusion would also have made the mechanism unreachable from `assembleMemory`, whose only asking method
 * is `askStored` → this route. `assemble.test.ts` asserts that reach through the composed product.
 */
const DECLARED = ['assistant', 'flat', 'knowledge-update', 'multi-session', 'temporal'];

describe('the mark reaches exactly the five declared routes', () => {
  it('moves the five declared routes and not the abstention one', async () => {
    const moved: string[] = [];
    for (const [name, drive] of ROUTES) {
      const off = await promptUnder(drive, 'off', QUESTION);
      const on = await promptUnder(drive, 'mark', QUESTION);
      if (off !== on) moved.push(name);
    }
    expect(moved.sort()).toEqual(DECLARED);
  });

  it('leaves the abstention route byte-identical', async () => {
    const drive = ROUTES.find(([routeName]) => routeName === 'abstention')![1];
    expect(await promptUnder(drive, 'mark', QUESTION)).toBe(
      await promptUnder(drive, 'off', QUESTION),
    );
  });

  it('is absent when the window states no pair, on every route', async () => {
    for (const [name, drive] of ROUTES) {
      expect(await promptUnder(drive, 'mark', UNRELATED)).toBe(
        await promptUnder(drive, 'off', UNRELATED),
      );
      void name;
    }
  });
});

describe('the mark is the only difference between the arms', () => {
  for (const name of DECLARED) {
    it(`${name}: deleting the marker reproduces the control byte for byte`, async () => {
      const drive = ROUTES.find(([routeName]) => routeName === name)![1];
      const off = await promptUnder(drive, 'off', QUESTION);
      const on = await promptUnder(drive, 'mark', QUESTION);
      // Exactly one statement is replaced on this pair, so exactly one marker is emitted.
      expect(on.split(SUPERSEDED_MARKER)).toHaveLength(2);
      expect(on.length - off.length).toBe(SUPERSEDED_MARKER.length);
      expect(on.replace(SUPERSEDED_MARKER, '')).toBe(off);
    });
  }

  it('marks the earlier statement and not the later one', async () => {
    const prompt = await promptUnder(ROUTES[5]![1], 'mark', QUESTION);
    // The marker follows the turn that states 1250, which is where that turn ends.
    expect(prompt).toContain(`${FIRST}${SUPERSEDED_MARKER}`);
    expect(prompt).toContain(SECOND);
    expect(prompt).not.toContain(`${SECOND}${SUPERSEDED_MARKER}`);
  });
});

describe('collapse', () => {
  const turns = [turn(FIRST, 0), turn(SECOND, 1)];

  it('replaces the earlier turn with the sentence at issue and a shorter mark', async () => {
    const off = await promptUnder(ROUTES[5]![1], 'off', QUESTION);
    const on = await promptUnder(ROUTES[5]![1], 'collapse', QUESTION);
    expect(on).toContain(`1. ${SUPERSEDED_COLLAPSED}${FIRST}`);
    expect(on).not.toContain(SUPERSEDED_MARKER);
    // The turn's own numbering survives, so the reader can still tie the statement to the evidence.
    expect(on).not.toContain(`1. ${FIRST}`);
    // This turn **is** the sentence, so the arm costs the label and saves nothing: the arithmetic is
    // asserted in both directions (see the long-turn case below) rather than assumed to be a saving.
    expect(on.length).toBe(off.length + SUPERSEDED_COLLAPSED.length);
  });

  it('is charged to the audit as a cut, because the delivered text is not the turn', () => {
    const control = buildPrompt(QUESTION, turns, 'knowledge-update');
    const collapsed = buildPrompt(QUESTION, turns, 'knowledge-update', {
      superseded: { rendering: 'collapse', turns: new Map([[FIRST, FIRST]]) },
    });
    expect(control.turnWindow).toEqual({ cut: 0, marked: 0, whole: 2 });
    expect(collapsed.turnWindow).toEqual({ cut: 1, marked: 0, whole: 1 });
  });

  it('buys room on a turn longer than the sentence, which is what the arm is for', () => {
    const long = turn(
      `${FIRST} ${'The rest of this turn is about the shop and its orders. '.repeat(6)}`,
    );
    const control = buildPrompt(QUESTION, [long, turn(SECOND, 1)], 'knowledge-update');
    const collapsed = buildPrompt(QUESTION, [long, turn(SECOND, 1)], 'knowledge-update', {
      superseded: { rendering: 'collapse', turns: new Map([[long.id, FIRST]]) },
    });
    expect(collapsed.prompt).toContain(`${SUPERSEDED_COLLAPSED}${FIRST}`);
    expect(collapsed.prompt.length).toBe(
      control.prompt.length - long.content.length + SUPERSEDED_COLLAPSED.length + FIRST.length,
    );
    expect(collapsed.prompt.length).toBeLessThan(control.prompt.length);
  });
});

describe('supersededTurns', () => {
  it('names the earlier statement when the window states two values', () => {
    const found = supersededTurns(QUESTION, [turn(FIRST, 0), turn(SECOND, 1)]);
    expect(found).toEqual([{ id: FIRST, sentence: FIRST }]);
  });

  it('skips a middle statement that repeats the value that survived', () => {
    const restated = 'Still close to 1300 followers on Instagram, so the insights help.';
    const found = supersededTurns(QUESTION, [turn(FIRST, 0), turn(SECOND, 1), turn(restated, 2)]);
    expect(found.map((entry) => entry.id)).toEqual([FIRST]);
  });

  it('names every statement the latest one replaces, not only the earliest', () => {
    const later = 'Now Instagram says I am at 1400 followers, which is nice.';
    const found = supersededTurns(QUESTION, [turn(FIRST, 0), turn(SECOND, 1), turn(later, 2)]);
    expect(found.map((entry) => entry.id)).toEqual([FIRST, SECOND]);
  });

  it('is empty when the window states the subject once', () => {
    expect(supersededTurns(QUESTION, [turn(FIRST, 0)])).toEqual([]);
  });

  it('is empty when the question shares no term with the evidence', () => {
    expect(supersededTurns(UNRELATED, [turn(FIRST, 0), turn(SECOND, 1)])).toEqual([]);
  });
});

describe('renderSupersededInline', () => {
  it('is the identity when off', () => {
    expect(renderSupersededInline('text', 'sentence', 'off')).toBe('text');
  });

  it('appends the marker when marking', () => {
    expect(renderSupersededInline('text', 'sentence', 'mark')).toBe(`text${SUPERSEDED_MARKER}`);
  });

  it('discards the text and keeps the sentence when collapsing', () => {
    expect(renderSupersededInline('text', 'sentence', 'collapse')).toBe(
      `${SUPERSEDED_COLLAPSED}sentence`,
    );
  });
});

describe('the mark is charged to the budget, and the boundary case says so', () => {
  const turns = [turn(FIRST, 0), turn(SECOND, 1)];
  const marks: SupersededMarks = {
    rendering: 'mark',
    turns: new Map([[FIRST, FIRST]]),
  };

  it('leaves the delivered set alone while the prompt is inside its room', () => {
    const control = buildPrompt(QUESTION, turns, 'knowledge-update');
    const marked = buildPrompt(QUESTION, turns, 'knowledge-update', { superseded: marks });
    expect(marked.carried.map((entry) => entry.id)).toEqual(
      control.carried.map((entry) => entry.id),
    );
    expect(marked.prompt.length - control.prompt.length).toBe(SUPERSEDED_MARKER.length);
  });

  it('delivers less evidence in the same room, which is the price of putting it inside', () => {
    // Six turns of the same size, one of them marked, and a room that buys three of them. The marked
    // arm's third turn no longer fits once its marker is counted, so it delivers two.
    const filler = (index: number): string =>
      `Note ${index} about the Instagram followers and the insights I get from them.`;
    const block = [
      turn(`${filler(1)} ${FIRST}`),
      turn(filler(2), 1),
      turn(filler(3), 2),
      turn(filler(4), 3),
    ];
    const room = buildPrompt(QUESTION, block, 'knowledge-update').evidenceChars;
    const capped = buildPrompt(QUESTION, block, 'knowledge-update', { maxEvidenceChars: room });
    const marked = buildPrompt(QUESTION, block, 'knowledge-update', {
      maxEvidenceChars: room,
      superseded: { rendering: 'mark', turns: new Map([[block[0]!.id, FIRST]]) },
    });
    expect(capped.evidenceChars).toBe(room);
    expect(capped.carried.length).toBeGreaterThan(marked.carried.length);
  });

  it('does not move the census when the cap did not cut the marked turn', () => {
    const control = buildPrompt(QUESTION, turns, 'knowledge-update', { maxTurnChars: 400 });
    const marked = buildPrompt(QUESTION, turns, 'knowledge-update', {
      maxTurnChars: 400,
      superseded: marks,
    });
    expect(marked.turnWindow).toEqual(control.turnWindow);
    expect(marked.prompt.length - control.prompt.length).toBe(SUPERSEDED_MARKER.length);
  });
});
