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
   * Answered when `decideRetrieval` values the best candidate at or above this.
   *
   * A separate field from {@link threshold} because the two decisions answer
   * different questions and a run may legitimately want opposite settings:
   *
   *   `threshold`          -- is this turn worth *keeping*?
   *   `retrievalThreshold` -- is the kept evidence good enough to *answer from*?
   *
   * Collapsing them was a real defect, found by dispatch `37094200823`. The arm
   * ran with `threshold: 0` (keep everything -- the identity configuration), and
   * with one shared field that also meant "answer from anything", so the
   * abstention path had no gate and every abstention in the run was the model's
   * wording rather than the layer's decision. The measured result was 6.40%
   * against the reference pipeline's 85.20%, with a 95.40% abstention rate --
   * the shape of a system that declines everything.
   *
   * Unlike {@link threshold}, `0` here means "answer whenever anything was
   * admitted", which is the identity configuration for this gate.
   */
  retrievalThreshold: number;
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
