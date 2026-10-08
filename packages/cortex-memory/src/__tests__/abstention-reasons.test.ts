/**
 * The abstention path must be able to state **why** it declined.
 *
 * ## The gap these tests close
 *
 * `answerAbstention` has three distinct ways to return `null`:
 *
 * 1. `turns.length === 0` — the write gate admitted nothing, so there is no
 *    evidence at all.
 * 2. `!this.#retrievalAdmitted(turns)` — the retrieval gate computed a decision
 *    and it was `retrieve: false`.
 * 3. the model was consulted and answered `UNANSWERABLE`.
 *
 * All three collapse to the same `Answer` value (`null`), and no artifact
 * records which one fired. That was survivable while only one of them was
 * reachable. It stopped being survivable at §10.10 of
 * `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md`: an arm armed with
 * `retrievalThreshold: 0.25` reported a `+46.40pp` abstention movement, the
 * movement was attributed to the retrieval gate in writing, and the attribution
 * was wrong — the gate was inert and the model had produced all `479` of the
 * abstentions. **Neither the run's artifact nor its log could have contradicted
 * the wrong reading**, because the reason was discarded before anything durable
 * was written.
 *
 * The reference CLI in `packages/cortex-eval/bench/run.ts` does emit a
 * `decisionReasons` census (`{ empty, threshold, llm, answered }`). The
 * cortex-memory arm does not, so an arm experiment — the only place an arming
 * change is ever measured — is exactly the place the census is missing. These
 * tests require the tally to be produced **by the system under test**, so both
 * bench entry points can read it and the two can no longer disagree.
 *
 * ## Why the assertions are behavioural, and why they count calls
 *
 * §37 recorded an escape where a guard asserted on source text and a real break
 * matched nothing. A textual assertion is especially useless here, because the
 * vocabulary ("threshold", "llm") already appears throughout this package's
 * comments. What is asserted instead is the observable consequence: the model is
 * called in exactly one of the three cases, and the tally says exactly that.
 *
 * The `seen`-length assertions are what make the tally trustworthy. A tally is a
 * claim about a decision, and a decision can be misreported — so each test pins
 * the tally against the call log it is describing, not against itself.
 */
import { describe, expect, it } from 'vitest';
import type { LLM, MemoryValue, ValueFunction } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import { ABSTAIN_TOKEN } from '../parse.js';
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

function system(options: Partial<CortexMemoryOptions> & { llm: LLM }): CortexMemory {
  return new CortexMemory({
    now: NOW,
    gate: { threshold: 0, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY },
    ...options,
  });
}

describe('the abstention path reports which mechanism declined', () => {
  it('counts an empty admission as `empty`, and does not consult the model', async () => {
    const seen: string[] = [];
    // Reaching case 1 needs an admission that empties for a reason that is
    // neither gate, and the only such reason is the session budget. Note that a
    // first two drafts of this test got it wrong in instructive ways:
    //
    // - passing the flat context made the model answer, because the budget is not
    //   consulted on that path at all;
    // - passing `sessions` with `sessionBudget: 0` ALSO made the model answer,
    //   because the abstention path did not apply the budget even when it had the
    //   sessions. That second failure was not a bad fixture. It was the defect
    //   pinned in `session-budget-on-every-path.test.ts`, and it is why this
    //   fixture now has to close the write gate to empty the admission.
    //
    // With `threshold: 1` no turn passes `decideWrite`, so the admission is empty
    // before the retrieval gate is reached.
    const memory = system({
      llm: recordingLlm(seen),
      gate: { threshold: 1, retrievalThreshold: 0, sessionBudget: Number.POSITIVE_INFINITY },
    });

    const answer = await memory.answerAbstention('Where did I travel?', [
      'user: I went to Lisbon.',
    ]);

    expect(answer).toBeNull();
    expect(seen).toHaveLength(0);
    expect(memory.abstentionReasons()).toEqual({
      empty: 1,
      threshold: 0,
      llm: 0,
      answered: 0,
    });
  });

  it('counts a closed retrieval gate as `threshold`, and does not consult the model', async () => {
    const seen: string[] = [];
    // The write gate admits everything; the retrieval gate is the only thing
    // that can produce this abstention. `constantValue(0.1)` against a `0.9` cut
    // closes it by arithmetic rather than by relying on `sourceTrust`.
    const memory = system({
      llm: recordingLlm(seen),
      gate: {
        threshold: 0,
        retrievalThreshold: 0.9,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: constantValue(0.1),
      },
    });

    const answer = await memory.answerAbstention('Where did I travel?', [
      'user: I went to Lisbon.',
    ]);

    expect(answer).toBeNull();
    expect(seen).toHaveLength(0);
    expect(memory.abstentionReasons()).toEqual({
      empty: 0,
      threshold: 1,
      llm: 0,
      answered: 0,
    });
  });

  it('counts a model-side decline as `llm`, and consults the model exactly once', async () => {
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen, 'INSUFFICIENT_EVIDENCE'),
      gate: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: constantValue(1),
      },
    });

    const answer = await memory.answerAbstention('Where did I travel?', [
      'user: I went to Lisbon.',
    ]);

    expect(answer).toBeNull();
    expect(seen).toHaveLength(1);
    expect(memory.abstentionReasons()).toEqual({
      empty: 0,
      threshold: 0,
      llm: 1,
      answered: 0,
    });
  });

  it('counts a returned answer as `answered`', async () => {
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen, 'Lisbon'),
      gate: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: constantValue(1),
      },
    });

    const answer = await memory.answerAbstention('Where did I travel?', [
      'user: I went to Lisbon.',
    ]);

    expect(answer).toBe('Lisbon');
    expect(seen).toHaveLength(1);
    expect(memory.abstentionReasons()).toEqual({
      empty: 0,
      threshold: 0,
      llm: 0,
      answered: 1,
    });
  });

  it('accumulates across questions rather than reporting the last one', async () => {
    // The census is worthless for a 500-question arm if it is a boolean or a
    // last-write-wins field: §10.10's wrong reading turned on a *proportion*
    // (479 of 500), which no single-question record can express.
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen, 'Lisbon'),
      gate: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: constantValue(1),
      },
    });

    await memory.answerAbstention('Where did I travel?', ['user: I went to Lisbon.']);
    await memory.answerAbstention('Where did I travel?', ['user: I went to Lisbon.']);
    await memory.answerAbstention('Where did I stay?', ['user: I stayed in Porto.']);

    expect(memory.abstentionReasons()).toEqual({
      empty: 0,
      threshold: 0,
      llm: 0,
      answered: 3,
    });
  });

  it('reports the tally as a copy, so a caller cannot corrupt the census', async () => {
    // The report is written from this object. If it were returned by reference,
    // any consumer that mutated what it read would silently change the numbers a
    // later reader sees, which is the same class of defect as a shared cache.
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen, 'Lisbon'),
      gate: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: constantValue(1),
      },
    });

    await memory.answerAbstention('Where did I travel?', ['user: I went to Lisbon.']);

    const first = memory.abstentionReasons();
    first.answered = 999;

    expect(memory.abstentionReasons().answered).toBe(1);
  });
});

describe('the census measures ONE route, and the artifact must not read it as the whole arm', () => {
  /**
   * The scope of the four counters, pinned because it was misread.
   *
   * `#reasons` is written in exactly one method, `answerAbstention`, and
   * `runBenchmark` dispatches that method **only** for `capability === 'ABS'`.
   * So the census is a census of the abstention route, not of the run.
   *
   * §55 read the §12.5 artifact's `abstentionReasons.llm = 120` as "the model
   * declined 120 times" and §55.4 turned that into the next investigation:
   * read the 30 ABS outputs for a common decline pattern. Both readings are
   * wrong in the same way. 30 ABS questions x 4 runs = exactly 120, ABS gold IS
   * abstention, and ABS scored **30/30 correct** -- so those 120 calls are the
   * capability PASSING, and the artifact's own per-capability table already said
   * so (`ABS: total=30 base=30 feat=30 b+f-=0`).
   *
   * The real loss is invisible to this field: 449 of 470 non-ABS questions
   * abstained, and `answerAbstention` never ran for any of them. A field that
   * looks like a run-wide census and reports one route is how a 95.5% non-ABS
   * abstention rate came to be investigated as an ABS problem.
   *
   * These tests assert the SCOPE rather than a count, because the count is
   * already covered and the scope is what was wrong.
   */

  it('counts nothing for a question answered on a non-abstention route', async () => {
    // The decisive shape. `answerSessions` is the MR route, and it is not the
    // abstention path, so a decline reached through it must leave the census at
    // zero. If this ever tallies, the field has silently widened to the run and
    // every prior artifact's numbers change meaning.
    const memory = system({
      llm: recordingLlm([], ABSTAIN_TOKEN),
      gate: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: constantValue(1),
      },
    });

    const answer = await memory.answerSessions('How many trips did I take?', [
      ['user: I went to Lisbon.', 'assistant: Noted.'],
    ]);

    expect(answer).toBeNull();
    expect(memory.abstentionReasons()).toEqual({
      empty: 0,
      threshold: 0,
      llm: 0,
      answered: 0,
    });
  });

  it('counts a decline on the temporal route as nothing, for the same reason', async () => {
    // TR is the arm's largest single loss (84 questions the baseline answered and
    // the feature did not) and it does not touch this census at all. Asserted
    // separately from the session route rather than folded into it: the two are
    // different methods, and a future edit could wire one to the counter without
    // the other.
    const memory = system({
      llm: recordingLlm([], ABSTAIN_TOKEN),
      gate: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: constantValue(1),
      },
    });

    const answer = await memory.answerTemporal(
      'When did I go to Lisbon?',
      ['user: I went to Lisbon.'],
      '2024-01-01',
      [['user: I went to Lisbon.']],
    );

    expect(answer).toBeNull();
    expect(memory.abstentionReasons()).toEqual({
      empty: 0,
      threshold: 0,
      llm: 0,
      answered: 0,
    });
  });

  it('tallies a decline on the abstention route, which is the route it measures', async () => {
    // The positive control. Without it the two tests above would pass on a
    // counter that never increments at all, which is the defect shape they are
    // written to distinguish themselves from.
    const memory = system({
      llm: recordingLlm([], ABSTAIN_TOKEN),
      gate: {
        threshold: 0,
        retrievalThreshold: 0,
        sessionBudget: Number.POSITIVE_INFINITY,
        valueFunction: constantValue(1),
      },
    });

    const answer = await memory.answerAbstention('Where did I travel?', [
      'user: I went to Lisbon.',
    ]);

    expect(answer).toBeNull();
    expect(memory.abstentionReasons()).toEqual({
      empty: 0,
      threshold: 0,
      llm: 1,
      answered: 0,
    });
  });
});
