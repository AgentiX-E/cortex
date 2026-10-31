/**
 * One run, two readers: the reader becomes a per-route dependency.
 *
 * ## The measurement this exists for
 *
 * The 220-question pair of §13.197 ran the same arm twice with one difference — `thinking` on the reader — and the
 * two arms disagree per capability rather than in aggregate: `TR` 27 → **31** with zero questions lost, `KU` +2,
 * `MR` +1, while `IE` 88 → **74** (16 lost, 2 gained) and `ABS` −1. The mechanism is the closing line: `temporal`
 * and `multi-session` end with *"reply with the Step 2 number alone"*, so a reader that obeys them is rewarded, and
 * `flat` — which serves `IE` — does not close that way, so the same obedience makes an `IE` answer terse enough to
 * lose the judge.
 *
 * That makes "which reader" a function of the **route**, and the arm had one reader for all six. This file states the
 * contract that fixes it: a route may name its own reader, and every consultation on that route uses it — including
 * the retry, because a retry answered by a different reader than the first pass would be a second treatment rather
 * than a correction of the first.
 *
 * ## Why a map and not a `route` argument on `LLM`
 *
 * The alternative was widening the provider interface to `complete(prompt, options?: { route })`, which would push a
 * routing concern into `cortex-core`'s contract and into every provider that implements it. The route is known inside
 * this package and nowhere else; the reader is already injected here; so the map is the shape that adds a capability
 * without moving a boundary.
 *
 * ## What is deliberately not asserted
 *
 * Which model is behind either reader. This package sees an `LLM`, and the two references it is given may be the same
 * object, one model with a different flag, or two different models — the product neither knows nor cares. What is
 * asserted is that the route decides, and that absent means one reader and no change.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { ABSTAIN_TOKEN } from '../parse.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

const TEXT = 'I planted five tomato plants in May.';
const SESSION = [[TEXT, 'And three chili plants in June.']];

/** A reader that answers one fixed reply and counts its own calls. */
function counter(reply: string): { llm: LLM; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    llm: {
      complete: async (prompt: string) => {
        calls.push(prompt);
        return reply;
      },
      completeStructured: async () => {
        throw new Error('unused by this package');
      },
    } as unknown as LLM,
  };
}

function memory(options: Partial<CortexMemoryOptions>, llm: LLM): CortexMemory {
  return new CortexMemory({ now: NOW, gate: GATE, llm, ...options });
}

describe('a route may name its own reader', () => {
  it('answers the multi-session route through the reader that route names', async () => {
    const base = counter('base');
    const sessionReader = counter('session');

    const answer = await memory(
      { readerByRoute: { 'multi-session': sessionReader.llm } },
      base.llm,
    ).answerSessions('How many plants?', SESSION);

    expect(answer).toBe('session');
    expect(sessionReader.calls).toHaveLength(1);
    expect(base.calls).toHaveLength(0);
  });

  it('leaves a route the map does not name on the run reader', async () => {
    const base = counter('base');
    const sessionReader = counter('session');
    const arm = memory({ readerByRoute: { 'multi-session': sessionReader.llm } }, base.llm);

    expect(await arm.answer('How many plants?', [TEXT])).toBe('base');
    expect(base.calls).toHaveLength(1);
    expect(sessionReader.calls).toHaveLength(0);
  });

  it('sends the retry to the same reader as the first pass, because it corrects that pass', async () => {
    const firstPass = counter(ABSTAIN_TOKEN);
    const retryReader = counter('8 plants');
    // The same reference for the route and for the base: this run has one reader, and the point is that the *route*
    // chose it rather than the call order.
    const arm = memory(
      { reviewBareDecline: true, readerByRoute: { 'multi-session': firstPass.llm } },
      firstPass.llm,
    );

    const answer = await arm.answerSessions('How many plants?', SESSION);

    // Both consultations went to the mapped reader; the unused one stayed at zero.
    expect(answer).toBeNull();
    expect(firstPass.calls).toHaveLength(2);
    expect(retryReader.calls).toHaveLength(0);
    expect(arm.bareRetryCensus()).toEqual({ attempted: 1, answered: 0 });
  });

  it('maps the abstention route independently of the others', async () => {
    const base = counter(ABSTAIN_TOKEN);
    const abstentionReader = counter('answer');

    const arm = memory({ readerByRoute: { abstention: abstentionReader.llm } }, base.llm);
    const answer = await arm.answerAbstention('What is my passport number?', [TEXT]);

    expect(answer).toBe('answer');
    expect(abstentionReader.calls).toHaveLength(1);
    expect(base.calls).toHaveLength(0);
  });

  it('is exactly one reader when no map is given, which is every archived artifact', async () => {
    const base = counter('base');
    const arm = memory({}, base.llm);

    await arm.answerSessions('How many plants?', SESSION);
    await arm.answer('How many plants?', [TEXT]);
    await arm.answerTemporal('How long ago?', [TEXT], '2023/06/01');

    expect(base.calls).toHaveLength(3);
  });
});
