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
import { ASK_ROUTES, buildPrompt, type EvidenceAsk } from '../prompt.js';
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

function build(seen: string[], ask?: EvidenceAsk): CortexMemory {
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
    }).prompt;

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
    const generous = buildPrompt('q', TURNS, 'abstention', { ask: 'extractive' }).prompt;
    const tight = buildPrompt('q', TURNS, 'abstention', {
      ask: 'extractive',
      maxChars: 120,
    }).prompt;

    expect(generous).not.toContain(DECLINE_INVITATION);
    expect(tight).not.toContain(DECLINE_INVITATION);
    expect(tight.length).toBeLessThanOrEqual(120);
  });
});

/**
 * §13.21's ask: the extractive block plus one sentence about combining evidence.
 *
 * ## Why this is a separate ask rather than a longer extractive block
 *
 * `38439899858` left the multi-session route as the feature side's only net loss -- and
 * the reading localises it: all 56 of its abstentions had the gold evidence carried, and
 * every one was the bare `INSUFFICIENT_EVIDENCE` token. Lengthening the extractive block
 * would have moved four routes; this moves two, and the four that keep their own block
 * are the control that says so.
 */
describe('the aggregate ask reaches two routes and leaves the other four untouched', () => {
  /** A phrase that appears in this ask and in no other instruction block. */
  const MERGING_SENTENCE = 'combining evidence from more than one turn or session';

  it('adds the merging sentence on the multi-session route', async () => {
    const seen: string[] = [];
    await build(seen, 'aggregate').answerSessions('How many kits do I own?', [[TEXT]]);

    expect(seen).toHaveLength(1);
    expect(seen[0]!).toContain(MERGING_SENTENCE);
    // The token survives, so a model that genuinely cannot answer can still decline --
    // the same rule the extractive ask's test pins.
    expect(seen[0]!).toContain('INSUFFICIENT_EVIDENCE');
  });

  it('adds it on the flat path, whose contract is also extractive', async () => {
    const seen: string[] = [];
    await build(seen, 'aggregate').answer('How many kits do I own?', [TEXT]);

    expect(seen).toHaveLength(1);
    expect(seen[0]!).toContain(MERGING_SENTENCE);
  });

  const OTHER_ROUTES: ReadonlyArray<readonly [string, (m: CortexMemory) => Promise<unknown>]> = [
    ['abstention (ABS)', (m) => m.answerAbstention('What is my passport number?', [TEXT])],
    ['temporal (TR)', (m) => m.answerTemporal('How long ago?', [TEXT], '2023/06/01')],
    ['knowledge-update (KU)', (m) => m.answerKnowledgeUpdate('How many kits now?', [TEXT])],
    ['assistant', (m) => m.answerAssistant('What did you say about the kit?', [TEXT])],
  ];

  for (const [name, drive] of OTHER_ROUTES) {
    it(`leaves the ${name} route byte-identical`, async () => {
      // These four routes' contracts are not `extractive`, so they keep their own
      // block and must be byte-identical to `route`. This is the control that makes the
      // MR movement in §13.21's run attributable to this ask and nothing else -- and the
      // reading it protects is a real one: the run before this one moved TR by 27.6
      // points precisely because a *global* ask had replaced TR's own block.
      const aggregate: string[] = [];
      const shipped: string[] = [];
      await drive(build(aggregate, 'aggregate'));
      await drive(build(shipped, 'route'));

      expect(instructionsOf(aggregate[0]!)).toBe(instructionsOf(shipped[0]!));
    });
  }

  it('records the two routes it changes, and no others', () => {
    expect(ASK_ROUTES.aggregate).toEqual(['multi-session', 'flat']);
    // The shipped behaviour is still reached by NOT naming an ask, so `route` stays
    // empty: naming it would claim a treatment the control did not receive.
    expect(ASK_ROUTES.route).toEqual([]);
  });

  it('leaves the extractive ask unchanged, so the previous registration still reproduces', () => {
    // §13.2's no-op trap, one ask over: MR's own ask IS `extractive`, so the two asks
    // must differ on that route and the extractive one must still reach four.
    expect(ASK_ROUTES.extractive).toEqual([
      'abstention',
      'temporal',
      'knowledge-update',
      'assistant',
    ]);
  });
});

/**
 * §13.22's ask: each reached route keeps its own block and gains the merging sentence.
 *
 * ## The failure it is aimed at
 *
 * Run `38487229554` reproduced §13.21's `aggregate` reach and found the loss moved to
 * where the reach does not go. TR is 48.82% against the baseline's 64.57%, and **51 of
 * its 127 questions abstain** -- and the abstentions are not a retrieval result: 50 of
 * the 51 had the gold turn carried, and the run's abstention tally is 121 of 500 with the
 * only counted reason `llm`. The questions are the shape "how many weeks ago did I meet
 * up with my aunt", "how many days passed between X and Y", "what is the order of the
 * three trips" -- a duration, a difference or an ordering **computed across turns**, which
 * is the same structural property under which the multi-session route was declining at
 * 56 of 121 before `aggregate` moved it to 24 of 121.
 *
 * ## Why the sentence is composed rather than substituted
 *
 * §13.20 is the measurement: sending the extractive block to every route removed the
 * temporal block's date-resolution instruction and cost TR 27.6 points, and §13.21's
 * `route` ask restored it and recovered 27.6. So the temporal route needs both lines, and
 * an ask that substitutes cannot express that. The two asks therefore have to differ in
 * exactly one route's reading, which is what the byte-identity assertion below pins.
 */
describe('the computed ask composes with each route instead of replacing it', () => {
  const MERGING_SENTENCE = 'combining evidence from more than one turn or session';
  const DATE_RESOLUTION = 'Resolve every relative expression';

  it('composes on the multi-session and flat routes, matching aggregate byte for byte', async () => {
    // `multi-session`'s own block IS the extractive one, so composing with it is the same
    // operation as `aggregate`'s substitution there. Asserting equality rather than
    // describing it is what makes the single-variable claim about §13.22's run a fact:
    // the only route whose reading differs from the dispatched `aggregate` run is TR.
    for (const drive of [
      (m: CortexMemory) => m.answerSessions('How many kits do I own?', [[TEXT]]),
      (m: CortexMemory) => m.answer('How many kits do I own?', [TEXT]),
    ]) {
      const computed: string[] = [];
      const aggregate: string[] = [];
      await drive(build(computed, 'computed'));
      await drive(build(aggregate, 'aggregate'));

      expect(instructionsOf(computed[0]!)).toBe(instructionsOf(aggregate[0]!));
      expect(computed[0]!).toContain(MERGING_SENTENCE);
    }
  });

  it('keeps the temporal route’s own block and gains the sentence', async () => {
    // The one route that actually differs from the dispatched `aggregate` run, and the
    // difference has to be an addition. If the date resolution went missing here the ask
    // would reproduce §13.20's 27.6-point loss instead of testing the hypothesis.
    const seen: string[] = [];
    await build(seen, 'computed').answerTemporal('How long ago?', [TEXT], '2023/06/01');

    expect(seen).toHaveLength(1);
    expect(seen[0]!).toContain(DATE_RESOLUTION);
    expect(seen[0]!).toContain('Show the resolved date in your answer');
    expect(seen[0]!).toContain(MERGING_SENTENCE);
    // And the decline rule survives, so a temporal question the evidence cannot place is
    // still answerable with a refusal rather than a guess.
    expect(seen[0]!).toContain('INSUFFICIENT_EVIDENCE');
  });

  it('puts the sentence directly above the line that licenses declining', () => {
    // Placement is the argument, so it is asserted rather than left to the wording. The
    // sentence is an exception to the block's closing rule, and an exception separated
    // from its rule by three route-specific lines is a different instruction.
    const prompt = buildPrompt('q', TURNS, 'temporal', {
      ask: 'computed',
      questionDate: '2023/06/01',
    }).prompt;
    const lines = instructionsOf(prompt).split('\n');

    expect(lines[lines.length - 2]).toContain(MERGING_SENTENCE);
    expect(lines[lines.length - 1]).toContain('INSUFFICIENT_EVIDENCE');
  });

  const CONTROL_ROUTES: ReadonlyArray<readonly [string, (m: CortexMemory) => Promise<unknown>]> = [
    ['knowledge-update (KU)', (m) => m.answerKnowledgeUpdate('How many kits now?', [TEXT])],
    ['assistant', (m) => m.answerAssistant('What did you say about the kit?', [TEXT])],
  ];

  for (const [name, drive] of CONTROL_ROUTES) {
    it(`leaves the ${name} route byte-identical`, async () => {
      const computed: string[] = [];
      const shipped: string[] = [];
      await drive(build(computed, 'computed'));
      await drive(build(shipped, 'route'));

      expect(instructionsOf(computed[0]!)).toBe(instructionsOf(shipped[0]!));
    });
  }

  it('leaves the abstention route alone, and that omission is the load-bearing one', async () => {
    // The abstention block invites the decline -- "That is expected and is a valid
    // outcome" -- and ABS's gold IS abstention, so the merging sentence's closing clause
    // would invert the one route where declining is the correct answer. This is not
    // tidiness: it is the only route whose score moves in the opposite direction.
    const seen: string[] = [];
    await build(seen, 'computed').answerAbstention('What is my passport number?', [TEXT]);

    expect(seen[0]!).not.toContain(MERGING_SENTENCE);
    expect(seen[0]!).toContain(DECLINE_INVITATION);
    expect(ASK_ROUTES.computed).not.toContain('abstention');
  });

  it('records the three routes it changes, and leaves the earlier asks at their own reach', () => {
    // The artifact's reach comes from this table, and a reader comparing §13.21's run
    // against §13.22's has only this field to tell "the temporal route was composed with"
    // from "every route was replaced" -- two changes with the same headline shape.
    expect(ASK_ROUTES.computed).toEqual(['multi-session', 'flat', 'temporal']);
    expect(ASK_ROUTES.aggregate).toEqual(['multi-session', 'flat']);
    expect(ASK_ROUTES.route).toEqual([]);
  });
});

/**
 * The ask that makes the multi-session route enumerate before it computes.
 *
 * ## Why this exists, and what run `38828538851` measured
 *
 * §13.32 closed the *selection* axis: three allocations, two of which spend the room,
 * agree within three questions of five hundred, and the room is nearly sufficient -- a
 * perfect selector at the current window would reach 0.917 coverage. So MR's loss was
 * not in what the window holds. The failures say where it is:
 *
 * | MR, run `38828538851` | count |
 * | --- | --- |
 * | correct | 52 |
 * | wrong, of which **numeric mismatch** | 47, **41** |
 * | abstained while carrying 14–20 gold turns | 22 |
 *
 * The model has the evidence and either miscounts it or declines with it in hand. The
 * reference pipeline scores 86.78% on MR with a *smaller* window, and its prompt is the
 * difference: a two-step contract (enumerate every matching item with its date, then
 * compute per the question's kind) whose abstention clause requires the list to exist
 * first. `computed`'s one sentence asks the model to "gather every relevant piece first,
 * then compute" -- the two-step contract is what says *how*, and it is what the failing
 * rows above lack.
 *
 * ## Why it reaches the multi-session route alone
 *
 * `buildSessionPrompt` and the flat path both build with the `extractive` contract, so a
 * branch keyed on the contract cannot separate them, and this ask is about MR's failures
 * only. The scope is therefore passed by the builder that knows it: the session builder
 * says `multi-session`, `buildPrompt` says nothing. Everything else is `computed` to the
 * byte -- asserted below -- which is what keeps §13.22's TR gain and §13.26's headline
 * out of this dispatch's variable.
 */
describe('the enumerated ask adds a two-step contract on the multi-session route alone', () => {
  const MERGING_SENTENCE = 'combining evidence from more than one turn or session';
  const STEP_ONE = 'Step 1';
  const STEP_TWO = 'Step 2';

  it('carries both steps, beside the sentence that licenses combining', async () => {
    const seen: string[] = [];
    await build(seen, 'enumerated').answerSessions('How many kits do I own?', [[TEXT]]);

    const block = instructionsOf(seen[0]!);
    expect(block).toContain(STEP_ONE);
    expect(block).toContain(STEP_TWO);
    expect(block).toContain(MERGING_SENTENCE);
    // The decline rule survives and is now conditional on the list, which is the half
    // of the reference contract the failing MR rows are missing: 22 of them abstained
    // with 14 to 20 gold turns already in the window.
    expect(block).toContain('INSUFFICIENT_EVIDENCE');
    expect(block).toContain(`without first writing the ${STEP_ONE} list`);
  });

  it('puts both steps directly above the line that licenses declining', async () => {
    // Placement is the argument, as it is for the merging sentence: the two-step
    // contract is an exception to the block's closing rule, and an exception separated
    // from its rule by route-specific lines is a different instruction.
    const seen: string[] = [];
    await build(seen, 'enumerated').answerSessions('How many kits do I own?', [[TEXT]]);
    const lines = instructionsOf(seen[0]!).split('\n');

    expect(lines[lines.length - 1]).toContain('INSUFFICIENT_EVIDENCE');
    expect(lines.slice(-8, -1).join('\n')).toContain(STEP_TWO);
  });

  it('is byte-identical to computed on the flat path', async () => {
    // The flat path serves every question with no route of its own, IE among them, and
    // IE is at 88.67%. A two-step contract there would be answering a question nobody
    // asked, on a capability that is not the loss.
    const enumerated: string[] = [];
    const computed: string[] = [];
    await build(enumerated, 'enumerated').answer('How many kits do I own?', [TEXT]);
    await build(computed, 'computed').answer('How many kits do I own?', [TEXT]);

    expect(instructionsOf(enumerated[0]!)).toBe(instructionsOf(computed[0]!));
  });

  it('is byte-identical to computed on the temporal route, which is where TR lives', async () => {
    // The TR gain §13.26 measured came from the temporal route's composed block. This
    // ask must not touch it, or the dispatch would move two capabilities at once and
    // neither number would be attributable.
    const enumerated: string[] = [];
    const computed: string[] = [];
    await build(enumerated, 'enumerated').answerTemporal('How long ago?', [TEXT], '2023/06/01');
    await build(computed, 'computed').answerTemporal('How long ago?', [TEXT], '2023/06/01');

    expect(instructionsOf(enumerated[0]!)).toBe(instructionsOf(computed[0]!));
  });

  const UNTOUCHED: ReadonlyArray<readonly [string, (m: CortexMemory) => Promise<unknown>]> = [
    ['knowledge-update (KU)', (m) => m.answerKnowledgeUpdate('How many kits now?', [TEXT])],
    ['assistant', (m) => m.answerAssistant('What did you say about the kit?', [TEXT])],
    ['abstention', (m) => m.answerAbstention('What is my passport number?', [TEXT])],
  ];

  for (const [name, drive] of UNTOUCHED) {
    it(`leaves the ${name} route byte-identical`, async () => {
      const enumerated: string[] = [];
      const shipped: string[] = [];
      await drive(build(enumerated, 'enumerated'));
      await drive(build(shipped, 'route'));

      expect(instructionsOf(enumerated[0]!)).toBe(instructionsOf(shipped[0]!));
    });
  }

  it('records the routes it changes, and they are computed reach', () => {
    // The reach table names the routes whose instruction differs from the shipped ask.
    // That the set equals `computed`'s is the point rather than a coincidence: this ask
    // is `computed` plus one route, and the artifact distinguishes them by the value of
    // `ask` beside an unchanged `askRoutes`.
    expect(ASK_ROUTES.enumerated).toEqual(['multi-session', 'flat', 'temporal']);
    expect(ASK_ROUTES.computed).toEqual(['multi-session', 'flat', 'temporal']);
  });
});

/**
 * §13.92: the sweep, which is what the lists say the failure is.
 *
 * ## The measurement this file was extended for
 *
 * `--lists` on run `39367801501` reads a median Step 1 list of **2.0 items** across all 121 MR
 * records, against a window carrying 174 turns over roughly thirty sessions. On the thirty
 * questions whose gold is a small count — an integer from 2 to 10, the only ones where a list's
 * length can be compared with the gold *number* at all — **six of the ten wrong ones listed fewer
 * items than the gold count and not one listed exactly that many**. The evidence is carried: those
 * questions sit at 100% of their user gold. The model does not walk it.
 *
 * One record states the failure in its own words: two mentions of the same boots exchange, then
 * *"These two turns refer to the same exchange/pickup event, so they count as one item"*, then
 * `1` against a gold of `3`. The contract's own sentence — *"do not merge two items into one"* —
 * was read and overruled, because a rule about merging cannot supply an item that was never
 * listed.
 *
 * ## What this ask changes, and the one thing it does not
 *
 * The `enumerated` contract asks for *the* list, and a list is what the model writes: the two
 * items it happened to notice. This asks for a line **per session**, in the printed order, with
 * `none` as a valid line — so the response has to touch every block the prompt printed. Nothing
 * about the evidence, the budget or the ranking moves: the reach is the multi-session route
 * alone, and the test below pins the other five to the shipped block byte for byte.
 *
 * That scoping is the experiment's control as well as its safety: the three capabilities that
 * are not MR must reproduce their windows to the character, which is only checkable if their
 * prompts are unchanged.
 */
describe('the sweep ask walks the sessions instead of filtering them out of view', () => {
  const MERGING_SENTENCE = 'combining evidence from more than one turn or session';
  const SWEEP_RULE = 'one line for every session';
  const SESSION_SHAPE = 'Session';

  it('asks for a line per session and a count of what the lines name', async () => {
    const seen: string[] = [];
    await build(seen, 'sweep').answerSessions('How many kits do I own?', [[TEXT]]);

    const block = instructionsOf(seen[0]!);
    expect(block).toContain('Step 1');
    expect(block).toContain('Step 2');
    expect(block).toContain(SWEEP_RULE);
    // The heading the prompt prints is `Session 7` on its own line, so the instruction can
    // point at it by name rather than describing "blocks".
    expect(block).toContain(SESSION_SHAPE);
    // `none` is a legal line, and that is the whole mechanism: a session the model has nothing
    // to say about is still a session it has to look at.
    expect(block).toContain('`none`');
    // It composes with the merging sentence rather than replacing the route's block.
    expect(block).toContain(MERGING_SENTENCE);
  });

  it('keeps the decline conditional on the lines, and the close is where it decides', async () => {
    const seen: string[] = [];
    await build(seen, 'sweep').answerSessions('How many kits do I own?', [[TEXT]]);
    const lines = instructionsOf(seen[0]!).split('\n');

    // §13.56's finding: an exception placed *above* the closing rule loses to it. The sweep's
    // own rule has to be the closing line, so the token is in the last line and the count rule
    // is not.
    expect(lines[lines.length - 1]).toContain('INSUFFICIENT_EVIDENCE');
    expect(lines.slice(-6, -1).join('\n')).toContain('Step 2');
    // And the licence to decline is withdrawn by a single named item, not by a complete list.
    expect(instructionsOf(seen[0]!)).toContain('every Step 1 line says `none`');
  });

  it('changes the instruction block and nothing above it', async () => {
    // The evidence section is assembled before the block, and a treatment that moved it would be
    // two variables: the same run would report an instruction change and a different window.
    const sweep: string[] = [];
    const enumerated: string[] = [];
    await build(sweep, 'sweep').answerSessions('How many kits do I own?', [[TEXT]]);
    await build(enumerated, 'enumerated').answerSessions('How many kits do I own?', [[TEXT]]);

    const evidenceOf = (prompt: string): string =>
      prompt.slice(0, prompt.indexOf('Answer the question'));
    expect(evidenceOf(sweep[0]!)).toBe(evidenceOf(enumerated[0]!));
    // And the two blocks are different text, so an artifact cannot mistake one run for the other
    // on the strength of the `ask` value alone.
    expect(instructionsOf(sweep[0]!)).not.toBe(instructionsOf(enumerated[0]!));
  });

  const SHIPPED: ReadonlyArray<readonly [string, (m: CortexMemory) => Promise<unknown>]> = [
    ['the flat path (IE)', (m) => m.answer('How many kits do I own?', [TEXT])],
    ['temporal (TR)', (m) => m.answerTemporal('How long ago?', [TEXT], '2023/06/01')],
    ['knowledge-update (KU)', (m) => m.answerKnowledgeUpdate('How many kits now?', [TEXT])],
    ['assistant', (m) => m.answerAssistant('What did you say about the kit?', [TEXT])],
    ['abstention', (m) => m.answerAbstention('What is my passport number?', [TEXT])],
  ];

  for (const [name, drive] of SHIPPED) {
    it(`leaves ${name} on the shipped block, byte for byte`, async () => {
      const sweep: string[] = [];
      const shipped: string[] = [];
      await drive(build(sweep, 'sweep'));
      await drive(build(shipped, 'route'));

      expect(instructionsOf(sweep[0]!)).toBe(instructionsOf(shipped[0]!));
    });
  }

  it('records one route, which is the route the failure is on', () => {
    expect(ASK_ROUTES.sweep).toEqual(['multi-session']);
  });
});

/**
 * §13.103: the aggregation contract, and the three rules this arm's contract leaves implicit.
 *
 * ## The measurement this block is written against
 *
 * The reference pipeline answers **102 of 121** multi-session questions with the same model, the
 * same dataset and a smaller window. Its aggregation prompt differs from `enumerated` in three
 * concrete decisions rather than in tone, and each has a record behind it in this arm's own
 * artifacts:
 *
 *   - `0a995998` merges one drop-off and one collection into "the same exchange/pickup event" and
 *     answers `1` against a gold of 3, and `bf659f65` does the same with albums bought and
 *     downloaded. The contract has to say an exchange is two items.
 *   - `a4996e51` is asked for hours in total and declines; `73d42213` is asked for a time and
 *     declines. "Compute exactly as the question asks" does not tell the reader that a duration
 *     question is a sum or that a time question is neither a sum nor a count.
 *   - 7 of the 10 MR declines are questions whose evidence states the operands (`a1cc6108` has
 *     Alex's age and asks for the user's age at his birth). Declining has to be narrowed to
 *     "the evidence says nothing", not "the answer is not written down".
 *
 * ## What this file pins about the reach
 *
 * All five other routes keep the shipped block byte for byte. That is five controls rather than
 * three, and it is what makes a movement on MR attributable.
 */
describe('the aggregation ask states the three rules the enumerated contract leaves implicit', () => {
  const MERGING_SENTENCE = 'combining evidence from more than one turn or session';

  it("asks for an item, the question's action and a date, on one line each", async () => {
    const seen: string[] = [];
    await build(seen, 'aggregation').answerSessions('How many kits do I own?', [[TEXT]]);

    const block = instructionsOf(seen[0]!);
    expect(block).toContain('Step 1');
    expect(block).toContain(
      '`<item> | <the action the question names> | <the date it was stated>`',
    );
    // The action constraint is the rule that decides membership, and it names the substitutions
    // the reader actually made in the records: attending for leading, planning for finishing.
    expect(block).toContain('attending is not leading');
    // An exchange is two items -- the rule `0a995998` overruled without one.
    expect(block).toContain('An exchange is TWO items');
    // It composes with the merging sentence rather than replacing the route's block.
    expect(block).toContain(MERGING_SENTENCE);
  });

  it('maps the four question forms to four operations', async () => {
    const seen: string[] = [];
    await build(seen, 'aggregation').answerSessions('How many kits do I own?', [[TEXT]]);

    const block = instructionsOf(seen[0]!);
    // Each line is a form this dataset's gold actually takes. A missing one is a decision the
    // reader has to make alone, which is the state every previous attempt left it in.
    expect(block).toContain('the number of items you listed');
    expect(block).toContain('the SUM of those durations');
    expect(block).toContain('the SUM of the amounts');
    expect(block).toContain('that value or event, not a count of anything');
  });

  it('narrows declining to "the evidence says nothing"', async () => {
    const seen: string[] = [];
    await build(seen, 'aggregation').answerSessions('How many kits do I own?', [[TEXT]]);
    const block = instructionsOf(seen[0]!);
    const lines = block.split('\n');

    expect(block).toContain('only when the evidence says nothing about the question');
    // Deriving is not a reason to decline -- the sentence 7 of 10 declines needed.
    expect(block).toContain('is NOT a reason to decline');
    // §13.56: the rule has to be the closing line, because an exception above it loses to it.
    expect(lines[lines.length - 1]).toContain('INSUFFICIENT_EVIDENCE');
    // The close drops "number": a time or an event is a legitimate Step 2 answer, and a close
    // that asked for a number would push those questions into a count or a decline.
    expect(lines[lines.length - 1]).toContain('Step 2 answer');
    expect(lines[lines.length - 1]).not.toContain('Step 2 number');
  });

  it('changes the instruction block and nothing above it', async () => {
    const aggregation: string[] = [];
    const enumerated: string[] = [];
    await build(aggregation, 'aggregation').answerSessions('How many kits do I own?', [[TEXT]]);
    await build(enumerated, 'enumerated').answerSessions('How many kits do I own?', [[TEXT]]);

    const evidenceOf = (prompt: string): string =>
      prompt.slice(0, prompt.indexOf('Answer the question'));
    expect(evidenceOf(aggregation[0]!)).toBe(evidenceOf(enumerated[0]!));
    expect(instructionsOf(aggregation[0]!)).not.toBe(instructionsOf(enumerated[0]!));
  });

  /**
   * §13.104. The flat path and the temporal route read what `enumerated` gives them, not what the
   * control gives them.
   *
   * The first dispatch of this ask fell through to the shipped block, which silently removed
   * `withMergingSentence` from two routes: TR fell 21 questions and IE 9 in a run registered as a
   * single-variable test against an `enumerated` control. The two asks must differ on one route.
   */
  const ENUMERATED_EQUIVALENT: ReadonlyArray<
    readonly [string, (m: CortexMemory) => Promise<unknown>]
  > = [
    ['the flat path (IE)', (m) => m.answer('How many kits do I own?', [TEXT])],
    ['temporal (TR)', (m) => m.answerTemporal('How long ago?', [TEXT], '2023/06/01')],
  ];

  for (const [name, drive] of ENUMERATED_EQUIVALENT) {
    it(`gives ${name} exactly what enumerated gives it`, async () => {
      const aggregation: string[] = [];
      const enumerated: string[] = [];
      await drive(build(aggregation, 'aggregation'));
      await drive(build(enumerated, 'enumerated'));

      expect(instructionsOf(aggregation[0]!)).toBe(instructionsOf(enumerated[0]!));
    });
  }

  const SHIPPED: ReadonlyArray<readonly [string, (m: CortexMemory) => Promise<unknown>]> = [
    ['knowledge-update (KU)', (m) => m.answerKnowledgeUpdate('How many kits now?', [TEXT])],
    ['assistant', (m) => m.answerAssistant('What did you say about the kit?', [TEXT])],
    ['abstention', (m) => m.answerAbstention('What is my passport number?', [TEXT])],
  ];

  for (const [name, drive] of SHIPPED) {
    it(`leaves ${name} on the shipped block, byte for byte`, async () => {
      const aggregation: string[] = [];
      const shipped: string[] = [];
      await drive(build(aggregation, 'aggregation'));
      await drive(build(shipped, 'route'));

      expect(instructionsOf(aggregation[0]!)).toBe(instructionsOf(shipped[0]!));
    });
  }

  it('records the three routes enumerated reaches, and differs from it on one', () => {
    expect(ASK_ROUTES.aggregation).toEqual(['multi-session', 'flat', 'temporal']);
    expect(ASK_ROUTES.aggregation).toEqual(ASK_ROUTES.enumerated);
  });
});
