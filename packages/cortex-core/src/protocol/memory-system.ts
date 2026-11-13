/**
 * The memory-system protocol: what a measured system must accept, and what it may exploit.
 *
 * ## Why this lives in `cortex-core` rather than in the harness
 *
 * These three declarations are the contract *between* a memory system and whatever measures it, so
 * neither side may own them. They were written inside `cortex-eval` -- the harness -- and the shipping
 * class implemented them from there: `CortexMemory implements SessionAwareMemorySystem`, with
 * `import type { ... } from '@agentix-e/cortex-eval'` in `cortex-memory/src/memory.ts` and no such
 * dependency declared in that package's `package.json`. The edge was acyclic and type-only, which is why
 * every build passed, and it still meant the product's public type referred to a package a consumer of
 * the product would not have.
 *
 * Moving them here is the repair, and it is the ordinary shape of one: the only package both sides
 * already depend on is the base. `cortex-eval` re-exports them so its own public API is unchanged,
 * `cortex-memory` imports them from here, and the backwards edge is gone rather than documented.
 *
 * The prose below is the harness's, kept because each paragraph records a failure that shaped a member:
 * which question shape is routed where, and what a system that omits a member receives instead.
 */

/** A single answer: a string, or `null` to abstain. */
export type Answer = string | null;

/**
 * A memory system under evaluation.
 *
 * **The contract is wider than this type.** `runBenchmark` routes on the presence
 * of the optional members declared by `SessionAwareMemorySystem` below, so a system
 * must be conformant not only in shape but in behaviour: every optional path it
 * declares will be called, with a particular argument shape, and must return
 * `Answer`. `{ name, answer }` alone is fully conformant and receives every
 * question.
 *
 * [`memory-system-conformance.test.ts`](../../../cortex-eval/src/__tests__/memory-system-conformance.test.ts)
 * asserts that routing contract executably — which member each question shape is
 * routed to, in what order, and what happens when a member is absent. It is the
 * suite an implementation of this type is verified against, and it stayed in the
 * harness when the type moved here, because routing is what a harness does; see
 * [`docs/AUDIT-EVAL-CONTRACTS.md`](../../../docs/AUDIT-EVAL-CONTRACTS.md) for why it
 * did not exist until it was needed.
 */
export type MemorySystem = {
  name: string;
  /**
   * `sessions` is the session-grouped view of `context` when the caller has it.
   * Optional and additive: a system that wants only the flat list is unaffected,
   * and the benchmark already carries it on every question that has one.
   */
  answer: (question: string, context: string[], sessions?: string[][]) => Answer | Promise<Answer>;
};

/**
 * A memory system that can exploit session boundaries. The benchmark routes
 * session-grouped questions to `answerSessions` and falls back to `answer` with
 * the flattened context otherwise.
 */
export type SessionAwareMemorySystem = MemorySystem & {
  answerSessions: (question: string, sessions: string[][]) => Answer | Promise<Answer>;
  /**
   * Temporal-reasoning answering with the question date; optional for simpler
   * systems. Falls back to `answer` when absent.
   *
   * `sessions` is the session-grouped form of the same turns as `context`, when
   * the caller has it. It is OPTIONAL and additive: a system that wants only the
   * flat list keeps receiving exactly that. It exists because admission is
   * bounded by a turn budget, and a session boundary is what lets a system spend
   * that budget on a session retrieval already judged relevant instead of on
   * scattered neighbours. Measured on run 34915402976, correct answers admit
   * 52.4% of their evidence session against 40.0% for failures.
   */
  answerTemporal?: (
    question: string,
    context: string[],
    questionDate?: string,
    sessions?: string[][],
  ) => Answer | Promise<Answer>;
  /**
   * Single-session answering that includes assistant turns. The evidence for a
   * `single-session-assistant` question lives in an assistant turn, so the
   * user-turn-only `answer` path would drop it. Falls back to `answer` when
   * absent.
   */
  answerAssistant?: (
    question: string,
    context: string[],
    sessions?: string[][],
  ) => Answer | Promise<Answer>;
  /**
   * Single-session answering for abstention questions (the correct answer is to
   * abstain because no answer exists). Uses a conservative abstention wording
   * that does not push the model to choose among candidates. Falls back to
   * `answer` when absent.
   */
  answerAbstention?: (
    question: string,
    context: string[],
    sessions?: string[][],
  ) => Answer | Promise<Answer>;
  /**
   * Single-session answering for preference/recommendation questions. Unlike the
   * extractive `answer` path, which asks for a single fact and abstains when
   * none is present, these questions ask for a suggestion that reflects the
   * user's stated preferences. Falls back to `answer` when absent.
   */
  answerPreference?: (
    question: string,
    context: string[],
    sessions?: string[][],
  ) => Answer | Promise<Answer>;
  /**
   * Single-session answering for knowledge-update questions. These questions ask
   * which value a time qualifier selects ("previous" → the earlier value,
   * "currently/most recent" → the later value), which the generic extractive
   * prompt does not make explicit. Falls back to `answer` when absent.
   */
  answerKnowledgeUpdate?: (
    question: string,
    context: string[],
    sessions?: string[][],
  ) => Answer | Promise<Answer>;
};
