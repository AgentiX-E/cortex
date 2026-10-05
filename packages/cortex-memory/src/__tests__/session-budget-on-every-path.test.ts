/**
 * `sessionBudget` must bound the prompt on **every** path that accepts sessions.
 *
 * ## The defect these tests were written against
 *
 * `GateOptions.sessionBudget` is documented in `types.ts` as an *unconditional*
 * claim about the gate:
 *
 *     Upper bound on how many admitted turns may reach the prompt, counted across
 *     all presented sessions. Bounding is the point -- see `selectSessionBudget`
 *     for why a session is admitted whole or not at all.
 *
 * It was not unconditional. `selectSessionBudget` had exactly one call site,
 * inside `answerSessions`. Every other session-taking path went through `#admit`,
 * which called `admitSessions` and returned its result directly:
 *
 *     if (sessions !== undefined && sessions.length > 0) {
 *       return admitSessions(sessions, admissionOptions).flatMap((s) => s.turns);
 *     }
 *
 * `admitSessions` does not know about the budget -- it admits each session and
 * returns them all. So the budget was applied on one path and silently ignored on
 * the others, and `answerAbstention` is one of the others.
 *
 * ## Why it matters more than a plumbing inconsistency
 *
 * `answerAbstention` is the path a cortex-memory arm experiment exercises: the
 * set ablation runs the abstention route, and `answerSessions` is reached only
 * for multi-session shapes. So the run that measures the arm -- the only place an
 * arming change is ever evaluated -- was running **with its budget unapplied**,
 * while the artifact recorded the budget it believed it was running with. A
 * configuration value that is recorded, printed in the dispatch line, and inert
 * is exactly the failure §10.10 of `docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md`
 * documents for `retrievalThreshold`; this is the same class of defect in a
 * second field, found by asking the same question of it.
 *
 * The bound is also what makes a prompt affordable. The flat path presented both
 * sessions' four turns where the session-aware path presented two, so the
 * unmetered path spends roughly double the prompt budget it was configured for.
 *
 * ## How the assertions are built
 *
 * The observable is the **prompt the model was handed**, not an internal count.
 * `sessionBudget` is a claim about what reaches the prompt, so the prompt is the
 * thing to measure; asserting on a private field would pass on a system that
 * computed a correct number and then ignored it.
 *
 * Each test asserts the two paths **agree**, rather than asserting a literal turn
 * count. Agreement is the property that was missing, and it is the one that
 * survives a legitimate change to how sessions are ranked.
 */
import { describe, expect, it } from 'vitest';
import type { LLM } from '@agentix-e/cortex-core';

import { CortexMemory } from '../memory.js';
import type { CortexMemoryOptions } from '../types.js';

const NOW = 1_759_470_000_000;

/** An LLM that records every prompt it is asked. */
function recordingLlm(seen: string[]): LLM {
  return {
    complete: async (prompt: string) => {
      seen.push(prompt);
      return 'Berlin';
    },
    completeStructured: async () => {
      throw new Error('unused by this package');
    },
  };
}

/**
 * Two sessions of two turns each. Every turn is equally valued, so the budget
 * has to decide by session rather than by value, which is the decision
 * `selectSessionBudget` exists to make.
 */
const SESSIONS = [
  ['user: I went to Lisbon.', 'user: It rained.'],
  ['user: I went to Porto.', 'user: It was sunny.'],
];

/** Count the numbered evidence lines in a rendered prompt. */
function evidenceTurns(prompt: string): number {
  const evidence = prompt.split('QUESTION:')[0] ?? '';
  return evidence.split('\n').filter((line) => /^\d+\. /.test(line.trim())).length;
}

function system(
  options: Partial<CortexMemoryOptions> & { llm: LLM; sessionBudget: number },
): CortexMemory {
  const { sessionBudget, ...rest } = options;
  return new CortexMemory({
    now: NOW,
    gate: { threshold: 0, retrievalThreshold: 0, sessionBudget },
    ...rest,
  });
}

describe('sessionBudget bounds the prompt on every session-taking path', () => {
  it('applies the budget on the abstention path, not only on the session path', async () => {
    // The defect, stated as behaviour. At a budget of 2 the session-aware path
    // presents one session (2 turns) and the abstention path presented all four.
    const sessionSeen: string[] = [];
    const sessionPath = system({ llm: recordingLlm(sessionSeen), sessionBudget: 2 });
    await sessionPath.answerSessions('Where did I travel?', SESSIONS);

    const abstainSeen: string[] = [];
    const abstainPath = system({ llm: recordingLlm(abstainSeen), sessionBudget: 2 });
    await abstainPath.answerAbstention('Where did I travel?', SESSIONS.flat(), SESSIONS);

    expect(sessionSeen).toHaveLength(1);
    expect(abstainSeen).toHaveLength(1);
    expect(evidenceTurns(abstainSeen[0] ?? '')).toBe(evidenceTurns(sessionSeen[0] ?? ''));
  });

  it('honours a budget that admits no session at all when a session is oversized', async () => {
    // `selectSessionBudget` admits the single highest-value session when nothing
    // fits, because answering from no evidence is worse than overrunning a soft
    // budget. So a budget of 1 over two 2-turn sessions still presents 2 turns --
    // and both paths must agree on that, since it is the rule and not a fallback.
    const sessionSeen: string[] = [];
    const sessionPath = system({ llm: recordingLlm(sessionSeen), sessionBudget: 1 });
    await sessionPath.answerSessions('Where did I travel?', SESSIONS);

    const abstainSeen: string[] = [];
    const abstainPath = system({ llm: recordingLlm(abstainSeen), sessionBudget: 1 });
    await abstainPath.answerAbstention('Where did I travel?', SESSIONS.flat(), SESSIONS);

    expect(evidenceTurns(sessionSeen[0] ?? '')).toBe(2);
    expect(evidenceTurns(abstainSeen[0] ?? '')).toBe(2);
  });

  it('presents every session when the budget is unbounded', async () => {
    // The control. Without it, a path that admitted only the first session
    // unconditionally would satisfy the tests above -- and dropping evidence is
    // the opposite failure from the one being fixed.
    const seen: string[] = [];
    const memory = system({
      llm: recordingLlm(seen),
      sessionBudget: Number.POSITIVE_INFINITY,
    });
    await memory.answerAbstention('Where did I travel?', SESSIONS.flat(), SESSIONS);

    expect(evidenceTurns(seen[0] ?? '')).toBe(4);
  });

  it('leaves the flat path unbounded, because it is handed no sessions', async () => {
    // A flat context carries no boundaries, so there is nothing for a
    // session-level budget to bound. Asserting this keeps the fix narrow: the
    // budget must reach the session-taking paths, and must not start silently
    // truncating the flat one.
    const seen: string[] = [];
    const memory = system({ llm: recordingLlm(seen), sessionBudget: 2 });
    await memory.answer('Where did I travel?', SESSIONS.flat());

    expect(evidenceTurns(seen[0] ?? '')).toBe(4);
  });
});
