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
import type { PromptContract } from './prompt.js';

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
  /**
   * Source trust stamped on every memory admission constructs. In `[0, 1]`.
   *
   * Defaults to `0.5`, which is what `createMemory` establishes and what this
   * layer passed unconditionally until the ceiling was measured. It is a field
   * rather than a constant because the value function is bounded by
   * `confidence * sourceTrust * (0.5 + 0.5 * recency)`, and with `sourceTrust`
   * fixed the layer could not express a fully-trusted memory at all: the ceiling
   * was `0.5`, so `threshold > 0.5` admitted nothing and the gate was a two-state
   * switch. Dispatch `37110579101` is what made it visible -- a retrieval
   * threshold of `0` could not close a gate whose maximum observable value was
   * `0.5`, which is why the repaired program scored what the unrepaired one did.
   *
   * The field does not change the default, and that is deliberate rather than
   * incidental: a caller that sets nothing gets exactly the previous behaviour, so
   * every measurement taken before this field existed keeps its meaning. What
   * grows is the reachable set, not the shipped configuration. See
   * `docs/DESIGN-CORTEX-MEMORY.md` §6.4.
   */
  sourceTrust?: number;
  /**
   * Per-turn confidence for admission, as a function of the turn's content.
   *
   * Raises the ceiling without providing variation, and the two are separate
   * repairs in a specific order. §49 measured the second one failing on its own:
   * with `sourceTrust: 1` every admitted turn carries exactly `1`, so the
   * reachable range is the set `[0, 1]` and yet every cut inside it is still
   * all-or-nothing. The gate was reachable and useless.
   *
   * The reason is that this layer pinned all three value-function factors for
   * every turn -- `confidence` left at `createMemory`'s default, `sourceTrust` one
   * value per admission by construction, `recency` exactly `exp(0)` because
   * `lastAccessedAt === createdAt` -- so there was no per-turn difference to
   * threshold. `confidence` is the only factor with room, and this field is it.
   *
   * Supplied as a callback rather than a `number[]` so it is evaluated against the
   * turn it is deciding: a parallel array could disagree with the input order
   * without any type noticing, and admission is the last place that can notice.
   *
   * The signal itself is the caller's to own. A real quality estimate is lexical
   * overlap, retrieval rank, or an embedding score, and **none of them live in
   * this package** -- `cortex-memory` depends on `cortex-core` only and reads no
   * embedding model, so measuring turn quality here would make the composition
   * layer depend on a retrieval mechanism it is supposed to sit above. The layer
   * owns the mechanism; whoever has a measurement injects one. That is the same
   * boundary `valueFunction` and `CortexMemoryOptions.llm` already use.
   *
   * Defaults to absent, which leaves `confidence` at `createMemory`'s `1` and
   * therefore reproduces the pre-existing constant behaviour exactly. See
   * `docs/DESIGN-CORTEX-MEMORY.md` §6.5.
   */
  confidenceFor?: (turn: string) => number;
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
  /**
   * Overrides the contract the **abstention route** uses, without touching the others.
   *
   * Exists for §12.5's registered experiment. §12.4 measured that the feature side
   * repaired no question at all (`b✗f✓ = 0`) while its abstentions were the model's
   * (`reason: "llm"`), and §12.3 measured that no `retrievalThreshold` can carry the arm.
   * The surviving hypothesis is therefore about what is *presented* to the model, and
   * this field is the single variable that changes it.
   *
   * Named for the route rather than for the contract so that a caller cannot accidentally
   * rewrite the extractive or temporal routes: those are separate arms' subjects and a
   * rendering change there would be a second uncontrolled variable in a run whose whole
   * value is that it has one. The route's own contract is what decides whether this
   * applies, and a value that is not a known contract is rejected rather than defaulted
   * -- a silently-ignored override would publish an artifact claiming a rendering the run
   * never used, which is the §7.3 side-channel defect.
   *
   * Defaults to absent, so every prior artifact keeps its meaning.
   */
  promptContract?: PromptContract;
};
