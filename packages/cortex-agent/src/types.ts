/**
 * The shapes on the boundary between the loop and the two things it borrows.
 *
 * ## Why the loop owns no corpus
 *
 * The loop never holds turns, never ranks them, and never renders them. It asks a
 * {@link Retrieval} for ids, and it hands ids back. Everything that decides *what a turn is*
 * -- deduplication, the lexical and vector channels, rank fusion, the reranker -- stays in
 * `cortex-memory`'s `SearchIndex`, which is the same code the registered arm runs. A loop that
 * carried its own ranking would be a second implementation of the measurement's central object,
 * and the first divergence between the two would be invisible: both would still answer questions.
 *
 * ## Why the reader's LLM is `cortex-core`'s `LLM` and not a provider
 *
 * Because the loop must run on a weak model, a strong model, a local model and whatever the
 * customer brings, and the only way to promise that is to depend on the interface rather than on
 * an adapter. `@agentix-e/cortex-agent` therefore does not depend on `@agentix-e/cortex-ai` at
 * all: the application constructs `OpenAICompatibleLLM`, a local model or its own implementation
 * and passes it in. Plan §14.98.3 listed `cortex-ai` as a dependency; this is the deviation and
 * the reason -- a dependency on an adapter package is a dependency on a provider list.
 */
import type { LLM } from '@agentix-e/cortex-core';
import type { SearchHit } from '@agentix-e/cortex-memory';

/**
 * The three tools, as the loop sees them.
 *
 * Named for the verbs rather than for the index, because `cortex-memory`'s `SearchIndex` is one
 * implementation of it and a caller with a stable corpus may have a better one. `indexRetrieval`
 * in `tools.ts` is the adapter for the common case.
 */
export type Retrieval = {
  /** How many turns the corpus holds. Ids are `0 .. turns - 1`, and `search` ranks a subset. */
  readonly turns: number;
  /** Ranked ids for one query. Delegates to the index; the loop does not reorder the answer. */
  search(query: string, k: number): Promise<readonly SearchHit[]>;
  /** One turn's text, verbatim, or `undefined` for an id outside the corpus. */
  read(turn: number): string | undefined;
  /** The turns of the conversation `turn` belongs to, in arrival order, `turn` included. */
  session(turn: number): readonly number[];
};

/**
 * A reader's one decision, after parsing.
 *
 * `unparsed` is a value rather than a thrown error because the loop's response to it is a
 * documented policy (stop, keep the evidence, record why) and not an exception. Run-time evidence
 * for that shape: a provider that answers `{}`, a fence that never closes, and a model that
 * explains itself before the JSON all produce answers that are recoverable, and all three killed
 * a dispatch when the first draft threw.
 */
export type Decision =
  | { readonly action: 'search'; readonly query: string }
  | { readonly action: 'session'; readonly turn: number }
  | { readonly action: 'answer' }
  | { readonly action: 'unparsed'; readonly reason: string };

/**
 * Why the loop stopped.
 *
 * Every reason is a distinct fact about the run, so an artifact can say *why* a question took the
 * number of calls it took. `step-limit` at `maxSteps: 0` is the registered arm's state and is the
 * only reason a run with no evidence of the mechanism produces.
 */
export type StopReason =
  /** The reader said the evidence above can answer. */
  | 'answered'
  /** The step budget ran out while the reader still wanted to search. */
  | 'step-limit'
  /** The last action returned nothing that was not already held: more steps cannot help. */
  | 'no-new-evidence'
  /** The reader asked for a search with a blank query. */
  | 'empty-query'
  /** The reply was not a decision. Recorded with the reason on the step. */
  | 'unparsed'
  /** The provider refused or failed. The evidence gathered so far is kept. */
  | 'llm-error'
  /** Every turn in the corpus is already held. */
  | 'corpus-exhausted'
  /** The prompts issued so far reach `budgetChars`. */
  | 'budget';

/** What one step did. */
export type AgentStep = {
  /** Zero-based. Step 0 is the seed retrieval and costs no model call. */
  readonly step: number;
  readonly action: 'seed' | 'search' | 'session' | 'answer' | 'unparsed';
  /** The query the reader wrote, or `null` when the step was not a search. */
  readonly query: string | null;
  /** Ids the tool returned, in the tool's order. Empty for `answer` and `unparsed`. */
  readonly hits: readonly number[];
  /** The subset of `hits` that was not already held. This is what a step bought. */
  readonly added: readonly number[];
  /** The subset of `hits` that was already held. A large number here is a wasted step. */
  readonly repeated: readonly number[];
  /** Characters of prompt this step issued. Zero for the seed, which calls no model. */
  readonly promptChars: number;
  /** Why the reply was not a decision, or why the call failed. `null` otherwise. */
  readonly note: string | null;
};

/** The whole run, serialisable as-is. */
export type AgentTrace = {
  readonly steps: readonly AgentStep[];
  readonly stop: StopReason;
  /** Model calls. The seed step is free, so this is at most `steps.length - 1`. */
  readonly calls: number;
  /** Searches the reader issued. Zero means the run never exercised the mechanism. */
  readonly queries: number;
  /** Total characters of prompt across every call. The bill, before tokenisation. */
  readonly promptChars: number;
  /** The evidence, in the order it was first put in front of the reader. */
  readonly selected: readonly number[];
  /** Turns in the corpus, so `selected.length === corpusTurns` is visible as coverage. */
  readonly corpusTurns: number;
};

export type AgentResult = {
  readonly trace: AgentTrace;
  /** Same array as `trace.selected`, hoisted because it is what the caller usually wants. */
  readonly selected: readonly number[];
};

/** Everything the loop is allowed to vary. */
export type StepwiseOptions = {
  readonly retrieval: Retrieval;
  readonly llm: LLM;
  /**
   * Model calls the reader may spend after the seed.
   *
   * `0` makes the loop a single retrieval: no call, no prompt, `selected` equals the seed hits.
   * That is the configuration the registered arm runs and the one §14.98.5's no-dispatch
   * condition compares question for question.
   */
  readonly maxSteps?: number;
  /** Ids the seed retrieval and every search ask for. */
  readonly k?: number;
  /**
   * Characters of each held turn the reader is shown.
   *
   * The digest is the mechanism's whole cost: the reader decides from *summaries*, not from the
   * evidence, because showing it the evidence is what the final prompt is for and paying for it
   * twice is how a two-step run becomes three times the bill.
   */
  readonly digestChars?: number;
  /** How many of the most recently added turns the digest carries. */
  readonly digestTurns?: number;
  /** Ceiling on total prompt characters across all steps, the seed included (which is zero). */
  readonly budgetChars?: number;
  /**
   * `max_tokens` for one decision.
   *
   * Not one or two: a reasoning model's thinking tokens are charged against this cap, and a cap
   * sized for the JSON alone truncates the JSON on exactly the models the mechanism is supposed to
   * help.
   */
  readonly decisionTokens?: number;
};
