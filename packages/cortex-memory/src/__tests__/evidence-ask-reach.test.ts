/**
 * Which routes does the §13 ask actually change?
 *
 * ## The measurement this file is written against
 *
 * `37827496757` retired the rendering hypothesis (§12.10): the rendering reached all
 * six routes and MR stayed 0/17 and TR 0/17. What it left behind is a gap it measured
 * but did not explain:
 *
 *     arm       abstentionRate   accuracy
 *     feature        95.8%         14.2%
 *     baseline       63.3%         38.3%
 *
 * The baseline abstains 32.5 points less on the same evidence with the same open gate,
 * and the only thing it does not have is the four-line instruction block that tells the
 * model declining is "expected and valid". So the ask is the candidate.
 *
 * ## Why this file exists before the code did
 *
 * §13 registers the experiment with a prediction (`MR >= 7/17`, `TR >= 8/17`) and a
 * reachable falsifier (both below `4/17`). A run can only test that if the artifact says
 * which routes the ask actually reached -- and the ask has a trap the rendering did not:
 *
 *   **MR's own ask IS `extractive`.** `buildSessionPrompt` hardcodes it. So dispatching
 *   `ask: 'extractive'` leaves MR's prompt BYTE-IDENTICAL, and §13's headline prediction
 *   is about MR. A run reporting only the ask's name would read as a treatment MR never
 *   received -- `bcf66463`'s failure, on a new axis, in the experiment designed to learn
 *   from it.
 *
 * These tests drive the routes and read the prompt. Asserting the name appears in the
 * source would pass on an arm that never dispatched it, which is the lesson the previous
 * round already paid for.
 */

import { describe, expect, it } from 'vitest';
import { createMemory } from '@agentix-e/cortex-core';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { ASK_ROUTES, buildPrompt } from '../prompt.js';
import type { AdmittedTurn } from '../admission.js';

const NOW = 1_759_470_000_000;

const GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  sourceTrust: 0.5,
} as const;

const TEXT = 'I bought a 1/48 scale Spitfire kit.';

const TURNS: AdmittedTurn[] = [{ ...createMemory({ content: TEXT }), ordinal: 0 }];

function recorder(seen: string[], answer: string): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return answer;
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

function build(seen: string[], ask?: 'route' | 'extractive'): CortexMemory {
  return new CortexMemory({
    llm: recorder(seen, 'Spitfire'),
    now: NOW,
    name: 'cortex-memory',
    gate: { ...GATE },
    ...(ask === undefined ? {} : { ask }),
  });
}

/** The instruction block, from the first instruction line to the end. */
function instructionsOf(prompt: string): string {
  const at = prompt.indexOf('Answer the question');
  return at === -1 ? prompt : prompt.slice(at);
}

/**
 * The abstention ask's distinctive line.
 *
 * `That is expected and is a valid outcome` appears in the abstention and
 * `abstention-evidence-blocks` blocks and nowhere else, so it separates "this route
 * still carries the invitation to decline" from "it does not" without depending on
 * exact wording elsewhere in the block.
 */
const DECLINE_INVITATION = 'expected and is a valid outcome';

describe('the extractive ask removes the invitation to decline wherever it lands', () => {
  const ROUTES: ReadonlyArray<readonly [string, (m: CortexMemory) => Promise<unknown>]> = [
    ['abstention (ABS)', (m) => m.answerAbstention('What is my passport number?', [TEXT])],
    ['temporal (TR)', (m) => m.answerTemporal('How long ago?', [TEXT], '2023/06/01')],
    ['knowledge-update (KU)', (m) => m.answerKnowledgeUpdate('How many kits now?', [TEXT])],
    ['assistant', (m) => m.answerAssistant('What did you say about the kit?', [TEXT])],
  ];

  for (const [name, drive] of ROUTES) {
    it(`removes it on the ${name} route`, async () => {
      const seen: string[] = [];
      await drive(build(seen, 'extractive'));

      expect(seen).toHaveLength(1);
      expect(seen[0]!).not.toContain(DECLINE_INVITATION);
      // The token survives, so a model that genuinely cannot answer can still decline.
      // An ask that removed the token would not be "answer harder", it would be "never
      // abstain", and the scorer could not tell the two apart.
      expect(seen[0]!).toContain('INSUFFICIENT_EVIDENCE');
    });
  }

  for (const [name, drive] of ROUTES) {
    it(`leaves the ${name} route's shipped ask in place when unset`, async () => {
      // The other half of the single-variable claim: absent must reproduce the shipped
      // prompt byte for byte, or every prior artifact stops being comparable.
      const armed: string[] = [];
      const shipped: string[] = [];
      await drive(build(armed));
      await drive(build(shipped, 'route'));

      expect(instructionsOf(armed[0]!)).toBe(instructionsOf(shipped[0]!));
    });
  }

  it('records the four routes the ask changes, and no others', () => {
    // The artifact's reach comes from this table, so it is asserted directly rather than
    // only through a rendered string.
    expect(ASK_ROUTES.extractive).toEqual([
      'abstention',
      'temporal',
      'knowledge-update',
      'assistant',
    ]);
    expect(ASK_ROUTES.route).toEqual([]);
  });
});

describe('MR and the flat path are no-ops under the ask, and that is the trap', () => {
  it('leaves the MR prompt byte-identical under the extractive ask', async () => {
    // MR IS the route §13 predicts movement on, and its own ask is already
    // `extractive` (`buildSessionPrompt` hardcodes it). A run that measured MR under
    // this option without knowing that would report a treatment and measure the
    // control -- which is why `ASK_ROUTES.extractive` omits MR and why this test pins
    // the no-op rather than the change.
    const shipped: string[] = [];
    const armed: string[] = [];
    await build(shipped).answerSessions('Which kit did I buy?', [[TEXT]]);
    await build(armed, 'extractive').answerSessions('Which kit did I buy?', [[TEXT]]);

    expect(armed[0]).toBe(shipped[0]);
    expect(ASK_ROUTES.extractive).not.toContain('multi-session');
  });

  it('leaves the flat prompt byte-identical under the extractive ask', async () => {
    // The same trap on the other route whose contract is already `extractive`. It is
    // absent from the reach list for the same measured reason as MR.
    const shipped: string[] = [];
    const armed: string[] = [];
    await build(shipped).answer('What did I buy?', [TEXT]);
    await build(armed, 'extractive').answer('What did I buy?', [TEXT]);

    expect(armed[0]).toBe(shipped[0]);
    expect(ASK_ROUTES.extractive).not.toContain('flat');
  });

  it('still carries the session note on MR, so the ask did not displace the route', async () => {
    // The no-op above must not be achieved by dropping MR's own instructions. If the
    // ask silently replaced MR's block, the byte-identity would be a coincidence of two
    // different failures cancelling, and the test above would not notice.
    const seen: string[] = [];
    await build(seen, 'extractive').answerSessions('Which kit did I buy?', [[TEXT]]);

    expect(seen[0]!).toContain('do not merge facts across sessions');
    expect(seen[0]!).toContain('Session 1');
  });
});

describe('the ask composes with the rendering without either moving the other', () => {
  it('applies the rendering and the ask together, and each is visible', async () => {
    // §13.2 holds the rendering fixed while the ask moves, so the two must be
    // independently expressible. This is the one test that drives both at once, and it
    // asserts each took effect by its own marker.
    const prompt = buildPrompt('q', TURNS, 'temporal', {
      rendering: 'sourced',
      ask: 'extractive',
      questionDate: '2023/06/01',
    });

    // The rendering moved: the source id is present.
    expect(prompt).toContain(`[${TURNS[0]!.id}]`);
    // The ask moved: the temporal block's date line is gone, because the extractive
    // block has no relative-time instruction.
    expect(prompt).not.toContain('2023-06-01');
    expect(prompt).not.toContain('Resolve every relative expression');
    // And the token survives both.
    expect(prompt).toContain('INSUFFICIENT_EVIDENCE');
  });

  it('uses the same instruction block whether or not the prompt is over budget', async () => {
    // `fitToBudget` and the fast path are two code paths to the same prompt, and a
    // previous version of this function disagreed between its branches. Adding a second
    // axis to the instruction block is a second chance to reintroduce that, so the ask
    // is asserted on the truncating path too.
    const generous = buildPrompt('q', TURNS, 'abstention', { ask: 'extractive' });
    const tight = buildPrompt('q', TURNS, 'abstention', { ask: 'extractive', maxChars: 120 });

    expect(generous).not.toContain(DECLINE_INVITATION);
    expect(tight).not.toContain(DECLINE_INVITATION);
    expect(tight.length).toBeLessThanOrEqual(120);
  });
});
