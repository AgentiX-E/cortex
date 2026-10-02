/**
 * Public types for `cortex-memory`.
 *
 * The composition layer's job is to make `cortex-core`'s value gates
 * *reachable*. Before this package existed, `decideWrite`, `decideRetrieval`,
 * `consolidate` and `resolveContradiction` had zero production callers — they
 * were covered by their own unit tests and imported by the barrel, and nothing
 * else. See `docs/AUDIT-CODE-VS-DOCS.md` §6.
 */
import type { LLM, ValueFunction } from '@agentix-e/cortex-core';

/** The knobs the admission gates expose. */
export type GateOptions = {
  /**
   * Admitted when `decideWrite` values the memory at **or above** this. `0`
   * admits everything and `1` admits nothing, because the default value
   * function is bounded by `confidence * sourceTrust * (0.5 + 0.5 * recency)`
   * and `recency < 1` strictly. Both extremes are asserted in the tests: a gate
   * that only ever opens and a gate that only ever closes are equally
   * indistinguishable from a gate that is not wired.
   */
  threshold: number;
  /**
   * Upper bound on how many admitted turns may reach the prompt, counted across
   * all presented sessions. Bounding is the point — see
   * `selectSessionBudget` for why a session is admitted whole or not at all.
   */
  sessionBudget: number;
  /** Replaces `cortex-core`'s `defaultValueFunction` when supplied. */
  valueFunction?: ValueFunction;
};

/** Construction options for {@link CortexMemory}. */
export type CortexMemoryOptions = {
  /**
   * The text generator. Injected rather than constructed, so this package
   * depends on `cortex-core`'s `LLM` contract and not on any provider. The
   * benchmark arm that supplies a real provider does so in step 3; nothing here
   * owns an API key or a network call.
   */
  llm: LLM;
  /**
   * Epoch milliseconds used for every time-stamped decision. Injected because
   * admission value depends on age, and a test that cannot pin the clock cannot
   * assert on a value.
   */
  now: number;
  /** Which gate configuration to apply. */
  gate: GateOptions;
  /** Report attribution label; defaults to `cortex-memory`. */
  name?: string;
  /** Upper bound on prompt length in UTF-16 code units. */
  maxPromptChars?: number;
};
