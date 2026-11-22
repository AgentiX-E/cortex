/**
 * The cheap instrument that decides whether the expensive dispatch is worth buying.
 *
 * ## The question it answers
 *
 * §14.98.5 pre-registers a two-step dispatch whose acceptance is a paired gain on 121 multi-session
 * questions, at a cost of roughly 14 CNY. Before spending that there is a question that costs an
 * order of magnitude less and can cancel the dispatch outright: **does a reader's own query surface
 * gold turns that the single static retrieval missed?**
 *
 * Every reading in this campaign says it will not. `AUDIT-MR-ENUMERATION.md` §3 measured that a
 * wrong answer already carries its gold in the prompt, with a median best rank of 0, and §9
 * re-measured it on the repaired order with none of the 1,832 gold turns missing. A multi-step
 * retrieval adds evidence only where the evidence was missing. If `newGold` is zero across the
 * population, the mechanism has nothing to buy, and its dispatch would buy a confirmation of that.
 *
 * If `newGold` is not zero, its size says how much is at stake, and `foundNotCarried` separates the
 * two repairs that would follow: a reader that finds gold the room then discards is a budget
 * question, not a retrieval question.
 *
 * ## Why it lives here and not in `bench/`
 *
 * The bench entry is excluded from coverage as an entry point, and `cortex-memory/bench/run-ablation.ts`
 * records why in detail: every decision that lived in an entry point was a decision no test could
 * reach, and three of them shipped wrong. So the arithmetic is here, inside the coverage boundary,
 * and the entry point only builds the case list, calls this, and writes the JSON.
 *
 * ## What it does not do
 *
 * It does not answer the question and it does not grade anything. A judge costs more than the
 * reader, and the question above is about **where the gold is**, which the dataset already says.
 * That is why a probe over 121 questions is affordable and a judged dispatch is not.
 */
import type { LLM } from '@agentix-e/cortex-core';

import { carriedIds, composeAgentPrompt } from './compose.js';
import { retrieveStepwise } from './loop.js';
import type { AgentTrace, Renderer, Retrieval } from './types.js';

/** One question, as the probe needs it. Nothing here is `cortex-eval`'s shape. */
export type ProbeCase = {
  readonly id: string;
  readonly question: string;
  /** The haystack, in the order the dataset lists it. Ids are positions in this array. */
  readonly turns: readonly string[];
  /** Turn id to session id, when the dataset has boundaries. */
  readonly sessionOf?: readonly number[];
  /** The gold turns, rendered exactly as `turns` renders them, so membership is string equality. */
  readonly goldTurns: readonly string[];
};

export type ProbeOptions<Config> = {
  readonly llm: LLM;
  /**
   * Builds the retriever for one case's haystack.
   *
   * A factory rather than a retriever, because every LongMemEval-S question brings its own corpus
   * and a shared index would be a corpus no question has. `indexRetrieval(new SearchIndex(), ...)`
   * is the common implementation; a caller with a hosted store supplies its own.
   */
  readonly retrievalFor: (
    turns: readonly string[],
    sessionOf: readonly number[] | undefined,
  ) => Retrieval;
  /** The renderer the arm prints through, so `foundNotCarried` is measured at the arm's width. */
  readonly renderer: Renderer<Config>;
  /** The renderer's own options: the room, the contract, the ask. Opaque here. */
  readonly config: Config;
  /** Reader decisions per question. `0` measures the single retrieval this is compared against. */
  readonly maxSteps?: number;
  readonly k?: number;
  readonly digestChars?: number;
  readonly digestTurns?: number;
};

/**
 * What one question cost and where its gold ended up.
 *
 * The trace travels whole rather than as four copied counters. `stop`, `calls`, `queries` and
 * `promptChars` are the loop's own reading of the same run, and a probe that restated them would be
 * a second place for the cost of a question to be defined -- the shape this campaign has already
 * paid for once, when a census counted the turns a budget *offered* instead of the turns it
 * *delivered*.
 */
export type ProbeCaseResult = {
  readonly id: string;
  readonly trace: AgentTrace;
  /** Turns the reader's own searches added that the seed retrieval had not returned. */
  readonly added: number;
  /** Of `added`, how many were gold. The number this instrument exists for. */
  readonly newGold: number;
  /** Gold turns the seed retrieval alone had returned. The baseline the reader is measured against. */
  readonly goldSeed: number;
  /** Gold turns the loop selected, before the room. */
  readonly goldSelected: number;
  /** Gold turns the composed prompt actually carries. */
  readonly goldCarried: number;
  readonly goldTotal: number;
};

export type ProbeReport = {
  readonly cases: number;
  readonly maxSteps: number;
  readonly calls: number;
  readonly promptChars: number;
  readonly queries: number;
  /** Questions on which the reader issued at least one search. */
  readonly askedQuestions: number;
  /** Questions on which a reader's search added evidence the seed did not return. */
  readonly addedQuestions: number;
  /** Questions on which a reader's search added **gold**. The instrument's headline. */
  readonly gainedQuestions: number;
  readonly newGold: number;
  /** Gold the single static retrieval already had. The baseline the reader competes with. */
  readonly goldSeed: number;
  readonly goldSelected: number;
  readonly goldCarried: number;
  readonly goldTotal: number;
  /** Gold the loop selected and the room then dropped. A budget question, not a retrieval one. */
  readonly foundNotCarried: number;
  readonly perCase: readonly ProbeCaseResult[];
};

/**
 * Run the loop over each case and report where the gold went.
 *
 * One retriever per case, because that is what the protocol is: every LongMemEval-S question brings
 * its own haystack, so a shared index would be a corpus no question has. `retrievalFor` is the
 * caller's, so the probe measures whatever index the arm runs -- it does not build one of its own
 * and then report a number about a different stack.
 */
export async function probeMultiStep<Config>(
  cases: readonly ProbeCase[],
  options: ProbeOptions<Config>,
): Promise<ProbeReport> {
  const maxSteps = options.maxSteps ?? 1;
  const perCase: ProbeCaseResult[] = [];

  for (const probeCase of cases) {
    const retrieval = options.retrievalFor(probeCase.turns, probeCase.sessionOf);
    const result = await retrieveStepwise(probeCase.question, {
      retrieval,
      llm: options.llm,
      maxSteps,
      ...(options.k === undefined ? {} : { k: options.k }),
      ...(options.digestChars === undefined ? {} : { digestChars: options.digestChars }),
      ...(options.digestTurns === undefined ? {} : { digestTurns: options.digestTurns }),
    });

    // Gold by text equality rather than by similarity: the dataset's gold turns are produced by the
    // same renderer that produced `turns`, so this is a comparison of one function's output with
    // itself. A fuzzy match here would let the probe claim evidence the reader never saw.
    const goldTexts = new Set(probeCase.goldTurns);
    const goldIds = new Set<number>();
    for (const [id, text] of probeCase.turns.entries()) {
      if (goldTexts.has(text)) goldIds.add(id);
    }

    const composed = composeAgentPrompt(probeCase.question, probeCase.turns, result.selected, {
      renderer: options.renderer,
      config: options.config,
    });
    const carried = new Set(carriedIds(composed));

    // The seed's own hits, read from the trace rather than re-queried: re-running the retrieval
    // would be a second chance for the index to answer differently, and the trace already recorded
    // what it said.
    // `slice(0, 1).flatMap` rather than `steps[0]?.hits ?? []`: the loop always records the seed, so
    // the fallback would be a branch no population can take, and an unreachable branch is a behaviour
    // nobody has observed.
    const seedIds = new Set(result.trace.steps.slice(0, 1).flatMap((step) => step.hits));
    // Step 0 is the seed and is not what this instrument measures: "the reader added gold" is a
    // statement about the steps a **reader** asked for. Including the seed would report every gold
    // turn the static retrieval already had as a gain, which is the one number that could justify a
    // dispatch that should be cancelled.
    const addedIds = result.trace.steps.slice(1).flatMap((step) => step.added);

    perCase.push({
      id: probeCase.id,
      trace: result.trace,
      added: addedIds.length,
      newGold: addedIds.filter((id) => goldIds.has(id)).length,
      goldSeed: [...seedIds].filter((id) => goldIds.has(id)).length,
      goldSelected: result.selected.filter((id) => goldIds.has(id)).length,
      goldCarried: [...carried].filter((id) => goldIds.has(id)).length,
      goldTotal: goldIds.size,
    });
  }

  const sum = (pick: (row: ProbeCaseResult) => number): number =>
    perCase.reduce((total, row) => total + pick(row), 0);

  return {
    cases: perCase.length,
    maxSteps,
    calls: sum((row) => row.trace.calls),
    promptChars: sum((row) => row.trace.promptChars),
    queries: sum((row) => row.trace.queries),
    askedQuestions: perCase.filter((row) => row.trace.queries > 0).length,
    addedQuestions: perCase.filter((row) => row.added > 0).length,
    gainedQuestions: perCase.filter((row) => row.newGold > 0).length,
    newGold: sum((row) => row.newGold),
    goldSeed: sum((row) => row.goldSeed),
    goldSelected: sum((row) => row.goldSelected),
    goldCarried: sum((row) => row.goldCarried),
    goldTotal: sum((row) => row.goldTotal),
    foundNotCarried: sum((row) => row.goldSelected - row.goldCarried),
    perCase,
  };
}
