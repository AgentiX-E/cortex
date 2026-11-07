/**
 * Tests for `effectivePromptChars`, the field that says which room each route assembled under.
 *
 * ## The defect it closes
 *
 * `42355323615` was dispatched with `cortex_memory_max_prompt_chars=multi-session:48460`. That
 * syntax sets a **route map**, so `effectivePromptChars`' two predecessors recorded
 * `{maxPromptCharsByRoute: {multi-session: 48460}}` and no `maxPromptChars` at all. Five routes
 * then took the product default, and the artifact never said which number that was.
 *
 * Three readers existed for that field and all three were wrong in a different way:
 *
 *  - `tools/cost-ledger.py` read `maxPromptChars` only, found nothing, and reported the run as
 *    **uncapped** -- in the row whose entire purpose is to say whether the window filled. The run
 *    had delivered 47,830 of 48,460 characters, i.e. 98.7%.
 *  - The registration gate reported `declared but unchanged: ['cortex_memory_max_prompt_chars']`,
 *    which was true and misleading at once: the input moved and the field it names did not.
 *  - A human reading the JSON had to know that `DEFAULT_MAX_PROMPT_CHARS` was 24,000 before §13.82
 *    and 48,000 after, because four docstrings in this package still claimed 24,000.
 *
 * The tests below pin the resolution, not the dispatch syntax: whatever an input does, the artifact
 * states the room the prompt was assembled under, per route, on every run.
 */

import { describe, expect, it } from 'vitest';

import { cortextMemoryArmOptions, toMemoryArmConfig } from '../bench-memory-arm.js';
import { ALL_TURN_CAP_ROUTES, PROMPT_ROOM_DEFAULT } from '../turn-cap-routes.js';

function config(env: Record<string, string> = {}) {
  return toMemoryArmConfig(cortextMemoryArmOptions({ CORTEX_MEMORY: '1', ...env }));
}

describe('effectivePromptChars', () => {
  it('records the product default on all six routes when no budget was dispatched', () => {
    // The absent state is the ordinary case -- every archived run before §13.213 -- and it is the
    // one the artifact used to answer with silence. It now answers with the number.
    const recorded = config().effectivePromptChars;
    expect(recorded).toBeDefined();
    expect(Object.keys(recorded ?? {}).sort()).toEqual([...ALL_TURN_CAP_ROUTES].sort());
    for (const route of ALL_TURN_CAP_ROUTES) {
      expect(recorded?.[route]).toBe(PROMPT_ROOM_DEFAULT);
    }
  });

  it('records a scalar budget on every route', () => {
    const recorded = config({ CORTEX_MEMORY_MAX_PROMPT_CHARS: '96000' }).effectivePromptChars;
    for (const route of ALL_TURN_CAP_ROUTES) {
      expect(recorded?.[route]).toBe(96_000);
    }
  });

  it('records the default on the routes a redistribution left alone', () => {
    // The `42355323615` shape, reproduced: one route named, five untouched. The test exists because
    // this is the exact artifact that made the cost row report "uncapped".
    const armConfig = config({ CORTEX_MEMORY_MAX_PROMPT_CHARS: 'multi-session:48460' });
    expect(armConfig.maxPromptChars).toBeUndefined();
    expect(armConfig.maxPromptCharsByRoute).toEqual({ 'multi-session': 48_460 });

    const recorded = armConfig.effectivePromptChars;
    expect(recorded?.['multi-session']).toBe(48_460);
    for (const route of ALL_TURN_CAP_ROUTES.filter((route) => route !== 'multi-session')) {
      expect(recorded?.[route]).toBe(PROMPT_ROOM_DEFAULT);
    }
  });

  it('is present on every run, not only the ones that moved a budget', () => {
    // A field rendered only when it departs from a default cannot be the evidence that the default
    // was taken: absence would mean both "took the default" and "predates the field".
    for (const env of [
      {},
      { CORTEX_MEMORY_MAX_PROMPT_CHARS: '96000' },
      { CORTEX_MEMORY_MAX_PROMPT_CHARS: 'multi-session:48460' },
      { CORTEX_MEMORY_MAX_PROMPT_CHARS: 'multi-session:48460,temporal:52000' },
    ]) {
      expect(config(env).effectivePromptChars).toBeDefined();
    }
  });

  it('never claims a room wider than the one the prompt was clipped to', () => {
    // Weak-form invariant, checked against the constant the resolution uses: a recorded room below
    // the default would mean a run that lowered its budget, which the artifact must show rather
    // than normalise away.
    const lowered = config({ CORTEX_MEMORY_MAX_PROMPT_CHARS: '24000' }).effectivePromptChars;
    for (const route of ALL_TURN_CAP_ROUTES) {
      expect(lowered?.[route]).toBe(24_000);
    }
  });
});
