/**
 * Evidence by role: a filter on **which turns may enter the room**, not on what the room
 * does with them.
 *
 * ## The measurement this exists for
 *
 * §13.82 read the 48,000-character run and found that on the multi-session route **51.9% of
 * the rendered characters are assistant turns** (48.1% user). The reference pipeline reaches
 * 85.95% on that capability with a 24,000-character budget and restricts retrieval to user
 * turns; this arm reaches 68.60% with 48,000 and does not. The difference is stated in both
 * systems' code and is measurable in the artifact, which is why §13.83 registers the filter
 * as the next variable instead of another budget increase.
 *
 * ## Why the product takes a classifier rather than a parser
 *
 * `cortex-memory` cannot know that a benchmark's haystack prefixes a turn with `[date] role:`.
 * Baking that format in would make the product's behaviour a fact about one dataset, and the
 * next dataset would either be unsupported or silently unfiltered -- the §10.10 defect (a
 * recorded configuration that does not reach the decision it names). So the product accepts a
 * `roleOf` callback and a list of roles to keep, and the **caller** supplies the format. The
 * tests below use their own parser for exactly that reason: importing the arm's would test the
 * arm through the product.
 *
 * ## The three states, and why `undefined` is not a fourth role
 *
 *   - `evidenceRoles` absent: no filter runs, and the prompt is byte-identical to the archived
 *     one. This is asserted by comparison rather than by inspection, because the claim is
 *     about reproducibility of every prior run.
 *   - a role the filter excludes: the turn does not reach the prompt.
 *   - `roleOf` returns `undefined`: the turn is **kept**. A turn whose role cannot be read is
 *     not evidence of the excluded role, and dropping it would let a classifier bug silently
 *     empty the evidence -- the failure mode that looks like a dataset with no facts.
 */
import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
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

/** The gate configuration every test here shares, so the only variable is the filter. */
const OPEN_GATE = {
  threshold: 0,
  retrievalThreshold: 0,
  sessionBudget: Number.POSITIVE_INFINITY,
  valueFunction: constantValue(1),
} as const;

/** The dataset's prefix, reproduced here rather than imported: see the module docstring. */
function roleOf(turn: string): string | undefined {
  const match = /^\[[^\]]*\]\s*(user|assistant)\s*:/i.exec(turn);
  return match?.[1]?.toLowerCase();
}

function system(options: Partial<CortexMemoryOptions> & { llm: LLM }): CortexMemory {
  return new CortexMemory({ now: NOW, gate: OPEN_GATE, ...options });
}

const USER_TURN = '[2023/02/15 (Wed) 03:14] user: I need to pick up two jackets.';
const ASSISTANT_TURN =
  '[2023/02/15 (Wed) 03:15] assistant: Here are three suggestions for storing jackets.';
const UNLABELED_TURN = 'a turn from a format whose roles cannot be read';

describe('evidence roles', () => {
  it('drops an excluded role from the prompt on a route the filter reaches', async () => {
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen),
      evidenceRoles: ['user'],
      evidenceRolesRoutes: ['flat'],
      roleOf,
    });

    await memory.answer('What do I need to pick up?', [USER_TURN, ASSISTANT_TURN]);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(USER_TURN);
    expect(seen[0]).not.toContain(ASSISTANT_TURN);
  });

  it('leaves a route the filter does not reach byte-identical to the unfiltered prompt', async () => {
    // Byte equality rather than a containment check: every archived artifact must stay
    // reproducible from the code, and a filter that runs on a route it was not scoped to
    // would change the prompt while every count above it still said "unreached".
    const withFilter: string[] = [];
    const without: string[] = [];
    const base = { llm: recordingLlm(without) as LLM, roleOf };

    await system({ ...base }).answer('What do I need?', [USER_TURN, ASSISTANT_TURN]);
    await system({
      ...base,
      llm: recordingLlm(withFilter),
      evidenceRoles: ['user'],
      evidenceRolesRoutes: ['multi-session'],
    }).answer('What do I need?', [USER_TURN, ASSISTANT_TURN]);

    expect(withFilter[0]).toBe(without[0]);
    expect(withFilter[0]).toContain(ASSISTANT_TURN);
  });

  it('keeps a turn whose role cannot be read', async () => {
    // `undefined` is "this classifier does not know", not "the excluded role". A filter that
    // dropped unknown turns would turn a parser bug into an empty prompt, which reads as a
    // dataset with no evidence rather than as the defect it is.
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen),
      evidenceRoles: ['user'],
      roleOf,
    });

    await memory.answer('What do I need?', [USER_TURN, UNLABELED_TURN]);

    expect(seen[0]).toContain(UNLABELED_TURN);
  });

  it('declines before the reader when the filter removes every turn', async () => {
    // The same state as admitting nothing: `empty`, no request. Not an empty prompt, which
    // would spend a call to be told there is no evidence.
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen),
      evidenceRoles: ['user'],
      roleOf,
    });

    const answer = await memory.answer('What do I need?', [ASSISTANT_TURN]);

    expect(answer).toBeNull();
    expect(seen).toHaveLength(0);
    expect(memory.abstentionReasons().empty).toBe(1);
    expect(memory.lastRetrievedContext()).toBeNull();
  });

  it('filters each session on the session-aware path and drops a session left empty', async () => {
    // The multi-session route is the one the filter exists for, and it does not go through
    // the flat admission path: a filter applied only there would leave this route untouched
    // while the artifact's config line claimed the opposite.
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen),
      evidenceRoles: ['user'],
      evidenceRolesRoutes: ['multi-session'],
      roleOf,
    });

    await memory.answerSessions('What do I need?', [[USER_TURN], [ASSISTANT_TURN]]);

    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain(USER_TURN);
    expect(seen[0]).not.toContain(ASSISTANT_TURN);
  });

  it('spends the session budget on the sessions the filter can use', async () => {
    // The budget and the filter are two spenders of one room, and the order between them is a
    // behaviour: if the budget selects first, it can spend the whole room on a session the filter
    // then empties, and the question is declined with admissible evidence sitting in the next
    // session. Found by this test, not by a run -- the registered configuration's session budget
    // is unbounded, so the defect was latent rather than visible.
    const seen: string[] = [];
    const byRole: ValueFunction = (memory: MemoryValue) =>
      memory.content.includes('assistant') ? 1 : 0.2;
    const memory = new CortexMemory({
      llm: recordingLlm(seen),
      now: NOW,
      gate: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: 1,
        valueFunction: byRole,
      },
      evidenceRoles: ['user'],
      evidenceRolesRoutes: ['multi-session'],
      roleOf,
    });

    const answer = await memory.answerSessions('What do I need?', [[ASSISTANT_TURN], [USER_TURN]]);

    expect(answer).not.toBeNull();
    expect(seen[0]).toContain(USER_TURN);
  });

  it('reports the filtered list as the offer, so the artifact describes what was shown', async () => {
    // The record's `retrieved` is the delivery and `admittedEvidence` is the offer. Both are
    // measured after the filter because both describe the evidence the reader could have been
    // shown; a filter applied after the capture would leave the artifact reporting a room the
    // model never saw.
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen),
      evidenceRoles: ['user'],
      roleOf,
    });

    await memory.answer('What do I need?', [USER_TURN, ASSISTANT_TURN]);

    expect(memory.lastRetrievedContext()).toEqual([USER_TURN]);
    expect(memory.lastAdmittedEvidence()?.turns).toBe(1);
  });

  it('declines on the temporal path when the filter removes every turn', async () => {
    // The temporal route reaches the filter through its own builder, so an emptied list there is
    // the same state as an emptied list anywhere else: a decline before the reader, not an empty
    // prompt.
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen),
      evidenceRoles: ['user'],
      evidenceRolesRoutes: ['temporal'],
      roleOf,
    });

    const answer = await memory.answerTemporal('How long ago?', [ASSISTANT_TURN], '2023/03/01');

    expect(answer).toBeNull();
    expect(seen).toHaveLength(0);
    expect(memory.abstentionReasons().empty).toBe(1);
  });

  it('declines when every session is left empty by the filter', async () => {
    // The session-aware path drops sessions it empties; when it drops all of them there is no
    // boundary left to render and no evidence to answer from, which is `empty` rather than a
    // prompt that opens with a heading and holds nothing.
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen),
      evidenceRoles: ['user'],
      evidenceRolesRoutes: ['multi-session'],
      roleOf,
    });

    const answer = await memory.answerSessions('What do I need?', [
      [ASSISTANT_TURN],
      [ASSISTANT_TURN],
    ]);

    expect(answer).toBeNull();
    expect(seen).toHaveLength(0);
    expect(memory.abstentionReasons().empty).toBe(1);
  });

  it('refuses a filter that has no classifier, rather than silently doing nothing', async () => {
    // The inert-configuration class: a value the artifact records and the run does not apply.
    expect(() => system({ llm: recordingLlm([]), evidenceRoles: ['user'] })).toThrow(/roleOf/);
  });

  it('refuses an empty role list, which would admit no evidence at all', async () => {
    expect(() => system({ llm: recordingLlm([]), evidenceRoles: [], roleOf })).toThrow(
      /at least one role/,
    );
  });
});
