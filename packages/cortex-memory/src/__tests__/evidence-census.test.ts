/**
 * Which path a question actually took, and which roles the window it was shown actually contained.
 *
 * ## The two questions this file makes answerable from an artifact
 *
 * Screening run `43465626013` failed its own audit with
 * `FAIL roles evidenceRoles=['user'] on ['multi-session','temporal']; 4 window(s) carry an assistant
 * turn`. Settling whether that meant "the filter stopped working" or "the audit read the wrong set"
 * took a manual reconstruction of four records, and the reconstruction found a third answer neither
 * reading had: the four records were declines that had inherited the previous question's capture.
 *
 * Both questions the audit could not settle were questions about **the run**, and neither had a field:
 *
 *   1. which route did this question take? The audit inferred it from `capability`, which is the
 *      dataset's word for a shape rather than the arm's word for a path, and the two disagree exactly
 *      when a path declines before it builds a prompt.
 *   2. which roles did the window it was shown contain? The audit re-derived this with its own copy of
 *      the dataset's prefix regex, so a divergence between the audit's parser and the product's
 *      classifier would have read as a filter defect.
 *
 * `lastRoute` answers the first with the product's own value, and `lastRoleCensus` answers the second
 * with the product's own classifier -- the one the filter itself used, so the two cannot disagree.
 *
 * ## Why the census has an `unclassified` bucket rather than folding it into a role
 *
 * The filter's contract (`types.ts`, `evidenceRoles`) says a turn whose role cannot be read is
 * **kept**: dropping it would turn a classifier bug into an empty prompt, which reads as a dataset
 * with no evidence. So `unclassified > 0` is not a filter defect and `assistant > 0` under
 * `evidenceRoles: ['user']` is. A census that merged them could not tell those apart, which is the
 * whole reason the audit's line was ambiguous.
 *
 * The bucket is named `unclassified` and not `unknown` because a classifier is free to return the
 * string `"unknown"` as a role -- the classifier's vocabulary is the caller's, not this package's --
 * and a field called `unknown` would then mean two things at once. `counts` holds whatever strings the
 * classifier returns; `unclassified` holds the turns it returned **nothing** for.
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { TURN_CAP_ROUTES } from '../types.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

/** An LLM that records every prompt it is asked and always answers `answer`. */
function recordingLlm(seen: string[], answer = 'Berlin'): LLM {
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

/** A value function that returns a fixed value, so the gate is the only variable. */
function constantValue(value: number): ValueFunction {
  return (_memory: MemoryValue) => value;
}

const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: constantValue(1),
} as const;

/** The dataset's prefix, reproduced here rather than imported: the product owns the filter, not the format. */
function roleOf(turn: string): string | undefined {
  const match = /^\[[^\]]*\]\s*(user|assistant)\s*:/i.exec(turn);
  return match?.[1]?.toLowerCase();
}

const USER_TURN = '[2023/05/20 (Sat) 10:00] user: I moved to Berlin in March.';
const ASSISTANT_TURN = '[2023/05/20 (Sat) 10:01] assistant: Berlin is a good choice.';

function memory(options: Partial<CortexMemoryOptions> = {}, seen: string[] = []): CortexMemory {
  return new CortexMemory({
    llm: recordingLlm(seen),
    now: NOW,
    gate: OPEN_GATE,
    ...options,
  } as CortexMemoryOptions);
}

describe('the route a question took', () => {
  it('is null before any question is asked', () => {
    // The third state, and the reason this is not a default of `'flat'`: "no question answered yet" and
    // "the last question took the flat path" are different facts, and a run that reported the second for
    // the first would make the first question of every pass look like a flat question.
    expect(memory().lastRoute()).toBeNull();
  });

  it('reports the path rather than the capability', async () => {
    // Six entries, six names, and the names are `TURN_CAP_ROUTES`' rather than this file's. A route
    // spelled here and not there would be a seventh path the cap planner has no configuration for, which
    // is the failure `test_ask_table_parity.py` was written for after a union grew without its table.
    const cases: readonly [string, (m: CortexMemory) => Promise<unknown>][] = [
      ['flat', async (m) => m.answer('q', [USER_TURN])],
      ['multi-session', async (m) => m.answerSessions('q', [[USER_TURN]])],
      ['temporal', async (m) => m.answerTemporal('q', [USER_TURN], '2023/05/20 (Sat)')],
      ['abstention', async (m) => m.answerAbstention('q', [USER_TURN])],
      ['assistant', async (m) => m.answerAssistant('q', [ASSISTANT_TURN])],
      ['knowledge-update', async (m) => m.answerKnowledgeUpdate('q', [USER_TURN])],
    ];
    for (const [expected, ask] of cases) {
      const system = memory();
      await ask(system);
      expect(system.lastRoute(), expected).toBe(expected);
    }
  });

  it('survives a decline, because the route is where the question entered and not what a reader was shown', async () => {
    // The distinction the audit needed. Every other per-question slot is `null` after a decline -- that is
    // what `#resetPerQuestion` is for, and what the previous round's defect was about -- but the route is
    // the one fact a decline still carries: "this question took the multi-session path and closed before
    // the reader" is exactly the finding that would have settled `43465626013` from the artifact alone.
    const system = memory();
    await system.answerSessions('q', []);
    expect(system.lastRoute()).toBe('multi-session');
    expect(system.lastRetrievedContext()).toBeNull();
  });

  it('describes the current question rather than the first one that ever ran', async () => {
    // One instance answers every question of a pass, so a field set once would report the first route on
    // all 500 records -- which is the misattribution class, arriving through the field added to end it.
    const system = memory();
    await system.answerSessions('q1', [[USER_TURN]]);
    await system.answer('q2', [USER_TURN]);
    expect(system.lastRoute()).toBe('flat');
  });
});

describe('the roles the window actually carried', () => {
  it('is null when no classifier was injected', async () => {
    // Not `{ counts: {}, unclassified: n }`: "this arm cannot classify" and "this arm classified every
    // turn as unreadable" are different, and only the second is a statement about the corpus.
    const system = memory();
    await system.answer('q', [USER_TURN, ASSISTANT_TURN]);
    expect(system.lastRoleCensus()).toBeNull();
  });

  it('counts the window it was shown, by the classifier the filter itself used', async () => {
    const system = memory({ roleOf });
    await system.answer('q', [USER_TURN, ASSISTANT_TURN, 'no prefix at all']);
    expect(system.lastRoleCensus()).toEqual({
      counts: { user: 1, assistant: 1 },
      unclassified: 1,
      total: 3,
    });
  });

  it('accounts for every delivered turn, so the artifact cannot drift from the window beside it', async () => {
    // The self-check the audit did not have. `total` is on the same set as `turns`, so
    // `user + assistant + unclassified === turns.length` is checkable in the artifact rather than inferred
    // from two lists; a census taken one layer away (on the offer rather than the delivery) would satisfy
    // its own arithmetic and still describe a different window, which is why this compares to the accessor
    // and not to the input.
    const system = memory({ roleOf });
    await system.answer('q', [USER_TURN, ASSISTANT_TURN]);
    const delivered = system.lastRetrievedContext();
    expect(delivered).not.toBeNull();
    const census = system.lastRoleCensus();
    expect(census?.total).toBe(delivered?.length);
  });

  it('reports zero of a role the filter excluded, which is what proves the filter ran', async () => {
    // The number the audit of `43465626013` could not read: `assistant: 0` beside
    // `evidenceRoles: ['user']` is the filter working, and `assistant > 0` would be the filter not
    // running. Under the same options the window itself has no assistant turn, so the two agree.
    const system = memory({ roleOf, evidenceRoles: ['user'] });
    await system.answer('q', [USER_TURN, ASSISTANT_TURN]);
    expect(system.lastRoleCensus()).toEqual({ counts: { user: 1 }, unclassified: 0, total: 1 });
    expect(system.lastRetrievedContext()).toEqual([USER_TURN]);
  });

  it('keeps an unclassifiable turn and counts it as unclassified rather than as a role', async () => {
    // The escape hatch, as a number. The turn is delivered -- dropping it would let a classifier bug empty
    // the evidence -- so a census that reported `assistant: 1` for it would accuse the filter of a defect
    // the filter did not commit, and one that reported nothing would leave the arithmetic short.
    const system = memory({ roleOf, evidenceRoles: ['user'] });
    await system.answer('q', [USER_TURN, 'a turn with no prefix']);
    expect(system.lastRoleCensus()).toEqual({ counts: { user: 1 }, unclassified: 1, total: 2 });
    expect(system.lastRetrievedContext()).toEqual([USER_TURN, 'a turn with no prefix']);
  });

  it("does not reserve the classifier's vocabulary, so a role named `unknown` is a role", async () => {
    // The reason the bucket is `unclassified`. A classifier that returns the string `"unknown"` is making a
    // claim about the turn; one that returns `undefined` is making none. Folding them would make a census
    // field mean two things, one layer below where that class of defect was last found.
    const system = memory({
      roleOf: (turn: string) => (turn.includes('assistant') ? 'unknown' : undefined),
    });
    await system.answer('q', [USER_TURN, ASSISTANT_TURN]);
    expect(system.lastRoleCensus()).toEqual({
      counts: { unknown: 1 },
      unclassified: 1,
      total: 2,
    });
  });

  it('is cleared by a decline, because a window that was never shown has no roles', async () => {
    // The previous round's defect, checked on the new fields before it can recur: a decline clears every
    // per-question reader-side slot, and a census that survived would describe the previous question's
    // window under this question's name -- which is precisely what put four records in `43465626013`.
    const system = memory({ roleOf });
    await system.answer('q1', [USER_TURN, ASSISTANT_TURN]);
    expect(system.lastRoleCensus()).not.toBeNull();
    await system.answerSessions('q2', []);
    expect(system.lastRoleCensus()).toBeNull();
  });

  it('returns a copy, so a consumer cannot rewrite the numbers a later reader sees', async () => {
    // The census is serialised straight into the artifact. A returned reference to internal state would let
    // an arm's writer mutate what the next question's reader compares against, and the defect would appear
    // as a corpus fact.
    const system = memory({ roleOf });
    await system.answer('q', [USER_TURN, ASSISTANT_TURN]);
    const first = system.lastRoleCensus();
    expect(first).not.toBeNull();
    (first as { counts: Record<string, number> }).counts.user = 99;
    expect(system.lastRoleCensus()?.counts.user).toBe(1);
  });

  it('describes the re-selected window when a second consultation replaces the evidence', async () => {
    // The audit pass reads the same window the answer came from, and `#recordCoverage` is called again
    // after it. A census written only on the first pass would describe evidence the final answer did not
    // see -- the `§13.262` split between delivery and coverage, arriving on the new field.
    const seen: string[] = [];
    const system = memory(
      {
        roleOf,
        reviewPass: 'audit',
        llm: {
          complete: async (prompt: string) => {
            seen.push(prompt);
            // First call answers; the audit call returns a list, which the audit reads as a selection.
            return seen.length === 1 ? 'Berlin' : '1. ' + USER_TURN;
          },
          completeStructured: async () => {
            throw new Error('unused by this package');
          },
        } as LLM,
      },
      seen,
    );
    await system.answerSessions('q', [[USER_TURN, ASSISTANT_TURN]]);
    const census = system.lastRoleCensus();
    const delivered = system.lastRetrievedContext();
    expect(census?.total).toBe(delivered?.length);
  });
});

describe('the census describes the delivery, not the offer', () => {
  it('counts the turns that survived the budget rather than the ones admission produced', async () => {
    // The `§13.262` split, on the new field. The offer (`admitted`) and the delivery (`assembled.carried`)
    // are the same set only when nothing bound, and run `38044858147` is the case where a 24,000-character
    // budget met 506,338 characters of evidence on every question. A census taken on the offer would satisfy
    // its own arithmetic, describe a window the reader never saw, and — read beside `turns` — disagree with
    // the delivery for reasons a reader would have to reconstruct.
    const system = memory({ roleOf, maxPromptChars: 420 });
    const turns = Array.from(
      { length: 12 },
      (_, i) => `[2023/05/20 (Sat) 10:${i}] user: turn ${i}`,
    );
    await system.answer('q', turns);
    const delivered = system.lastRetrievedContext();
    const offered = system.lastAdmittedEvidence();
    expect(offered).not.toBeNull();
    expect(delivered).not.toBeNull();
    // The premise, asserted rather than assumed: if the budget did not bind, this test would pass while
    // proving nothing about which layer the census reads.
    expect(offered?.turns).toBe(12);
    expect(delivered?.length).toBeLessThan(12);
    expect(system.lastRoleCensus()?.total).toBe(delivered?.length);
  });
});

describe('every route states itself', () => {
  it('is entered by a literal name that exists in TURN_CAP_ROUTES, one call per route', async () => {
    // A structural test rather than a behavioural one, and it exists because the behavioural set is a list
    // this file maintains: a seventh route added to `TURN_CAP_ROUTES` and to a public method, but not to the
    // six cases above, would leave `lastRoute()` reporting the previous question's path on every question of
    // that route — the misattribution class, arriving through the field added to end it. The count is exact
    // so a route that states itself twice is also red: two entries for one path means one of them is wrong.
    const source = readFileSync(new URL('../memory.ts', import.meta.url), 'utf8');
    const stated = [...source.matchAll(/#enterRoute\('([^']+)'\)/g)].map((match) => match[1]);
    expect(new Set(stated).size).toBe(stated.length);
    expect([...stated].sort()).toEqual([...TURN_CAP_ROUTES].sort());
  });
});
