/**
 * The deterministic reader: an instrument for retrieval, not a reader.
 *
 * ## The question this exists to make answerable without a model
 *
 * `S14` priced the vector channel at 5.60 points and `docs/ANALYSIS-LEXICAL-ZERO-RECALL.md`
 * turned that price into a direction: one cliff at zero recall (21 questions at 19.0%) and a
 * plateau from the first gold turn on (82.9 / 91.2 / 89.8). The repair that follows is a change
 * to **lexical scoring** -- BM25's `k1`/`b`, stemming, stop words, field weights, phrase windows
 * -- and every one of those is deterministic code over a deterministic corpus. None of them
 * needs a reader, which means none of them needs a paid call, which means the cheap place to
 * evaluate them is the retrieval path alone.
 *
 * The obstacle is that the retrieval path is not separable from the reader in this repository,
 * and deliberately so: the delivered evidence is what `CortexMemory` *handed* the reader
 * (`lastRetrievedContext`), not what some parallel implementation believes it would have handed
 * over. An instrument that reimplemented "index, fusion, room, render" would be a second
 * definition of the product's own assembly, and the first thing it would measure is the drift
 * between the two.
 *
 * So the instrument is the product, with the one component that costs money replaced by a
 * constant. Retrieval, fusion, room arithmetic, truncation and rendering all run for real; the
 * reply is fixed; the judge is fixed.
 *
 * ## What it refuses to be read as
 *
 * Not a measurement of accuracy. A run under this mode reports the accuracy of a constant, which
 * is a number about the constant. Everything that reads a result -- `tools/readout-arm-run.py`,
 * the acceptance matrix, the reports -- must therefore be able to tell such a run from a real
 * one, which is why `run-ablation.ts` writes `offline-instrument.json` beside the report instead
 * of quietly producing an artifact shaped like every other artifact.
 *
 * ## Why the reply is an answer rather than a refusal
 *
 * `reviewBareDecline` acts on a reply that parses to nothing **and** reads as a decline; a
 * refusal here would take that branch on all five hundred questions and the run would measure a
 * mechanism nobody configured. `offline instrument` parses as an answer, so the second
 * consultation stays where `replyRepair: 'off'` and `reviewBareDecline` in the dispatched
 * configuration put it. The neutrality of the reply is not assumed either: `run-ablation.ts`
 * asserts that the product built exactly one index per question and says so when it did not.
 */

import type { CompleteOptions, JsonSchema, LLM } from '@agentix-e/cortex-core';

/** The variable that turns the reader and the judge into instruments. */
export const OFFLINE_INSTRUMENT_VARIABLE = 'CORTEX_ARM_OFFLINE';

/**
 * What the reader answers, on every question, in every run.
 *
 * A phrase rather than a token because `parse.ts` has a numeric path and a verbatim path, and a
 * bare number would be read by the first of them -- which is a *different* downstream route than
 * the one an ordinary prose answer takes. An instrument should exercise the ordinary route.
 */
export const OFFLINE_INSTRUMENT_REPLY = 'offline instrument';

/**
 * What the judge answers, on every question.
 *
 * `incorrect` rather than `correct` because the two errors are not symmetric: a constant
 * `correct` would raise every published accuracy to 100% and look like a result, while a constant
 * `incorrect` leaves only what the structural and exact channels matched. Neither is a
 * measurement, and the smaller number is the one nobody will quote by accident.
 */
export const OFFLINE_INSTRUMENT_VERDICT = 'incorrect';

/**
 * Whether this process is an offline instrument.
 *
 * `'1'` only. A truthiness test would accept `'0'`, and the workflow that dispatches this mode
 * passes the value through a `workflow_dispatch` input whose empty state arrives as `''` -- so
 * "the operator did not ask for an instrument" and "the operator asked for one" have to be two
 * distinct spellings, and `'1'` is the one the dispatch writes.
 */
export function offlineInstrumentRequested(
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return (env[OFFLINE_INSTRUMENT_VARIABLE] ?? '').trim() === '1';
}

/** An `LLM` whose answers are fixed, with the number of questions it was asked. */
type OfflineInstrument = LLM & {
  /** Reader calls so far. Zero means the reader was never reached. */
  readonly calls: () => number;
  /** Structured calls so far, which a configured extraction route would produce. */
  readonly structuredCalls: () => number;
};

/**
 * The instrument, as the one interface both factories already produce.
 *
 * `completeStructured` returns an empty object rather than throwing. The structured path is used
 * by the temporal and fact extractors, and a run that configured one of those would be measuring
 * an extraction whose input was already fixed -- the object says "nothing was extracted" in the
 * shape the callers destructure, so the mechanism under it proceeds on an empty set instead of
 * the run dying twenty minutes in. Refusing here would make the instrument silently
 * configuration-dependent, which is the same defect class as a guard whose firing condition
 * cannot occur.
 */
export function offlineInstrument(): OfflineInstrument {
  let calls = 0;
  let structuredCalls = 0;
  return {
    calls: () => calls,
    structuredCalls: () => structuredCalls,
    complete: (_prompt: string, _opts?: CompleteOptions): Promise<string> => {
      calls += 1;
      return Promise.resolve(OFFLINE_INSTRUMENT_REPLY);
    },
    completeStructured: <T>(
      _prompt: string,
      _schema: JsonSchema,
      _opts?: CompleteOptions,
    ): Promise<T> => {
      structuredCalls += 1;
      return Promise.resolve({} as T);
    },
  };
}

/**
 * The two configuration facts an offline run cannot be read under if they are wrong.
 *
 * ## Why `self-index` and why `none`
 *
 * The instrument exists to price a change to the **product's** lexical ranking. Under any other
 * `relevanceSignal` the ranking belongs to the harness, and the delivered evidence would be a
 * measurement of the harness's retrieval with the product's name on it; under a configured
 * `indexEmbedding` the run would pay for vectors it does not need and, worse, would be measuring
 * a channel the lexical candidates do not touch -- so an improvement would be attributed to a
 * scoring change that never ran.
 *
 * ## Why this refuses rather than warns
 *
 * A warned run produces a full artifact with plausible numbers, and the warning lives in a log
 * that expires. The registration this instrument serves
 * (`cortex-docs/docs/PREREGISTRATION-LEXICAL-RECALL.md`) puts the calibration gate before any
 * candidate comparison; a run whose configuration could not produce a comparable reading has to
 * die before the first question, not after the five hundredth.
 */
export function assertOfflineInstrumentConfiguration(config: {
  readonly relevanceSignal: string;
  /**
   * `undefined` is a value this has to handle rather than a type to narrow away: the arm parses an
   * unset variable as `undefined`, and an unset `indexEmbedding` is the registered `injected` -- so
   * the state that must be refused is exactly the one a required field would have made unreachable.
   */
  readonly indexEmbedding?: string | undefined;
}): void {
  if (config.relevanceSignal !== 'self-index') {
    throw new Error(
      `CORTEX_ARM_OFFLINE=1 measures the product's own lexical ranking, so relevanceSignal must be ` +
        `"self-index"; this run named ${JSON.stringify(config.relevanceSignal)}. Any other signal ` +
        'ranks in the harness, and the delivered evidence would be a reading of that ranking.',
    );
  }
  if (config.indexEmbedding !== 'none') {
    throw new Error(
      `CORTEX_ARM_OFFLINE=1 measures the lexical channel, so indexEmbedding must be "none"; this run ` +
        `named ${spell(config.indexEmbedding)}. With a vector channel configured the run pays for ` +
        'embeddings it does not need and measures a channel the lexical candidates never touch -- an ' +
        'improvement would then be credited to a change that did not run.',
    );
  }
}

/**
 * A value as a message should print it, with `undefined` spelled out.
 *
 * `JSON.stringify(undefined)` is `undefined` -- the value, not the string -- so a template literal
 * interpolating it renders "undefined" for a reader and `''` for a machine that rounds it through
 * some other path. `(unset)` says which fact produced the refusal: an operator who never set the
 * variable is reading a different message than one who set it wrongly.
 */
function spell(value: string | undefined): string {
  return value === undefined ? '(unset)' : JSON.stringify(value);
}

/**
 * One index per question per run: the assertion that the fixed reply did not change the retrieval.
 *
 * ## What this is guarding
 *
 * The instrument's neutral component is the *reply*, and its only way to disturb the measurement
 * is to make the product retrieve twice -- a bare-decline retry, a second consultation, a window
 * that rebuilds its index. Those mechanisms are configured off in the registered arm, but
 * "configured off" is a claim about a configuration and this is a check on what happened: the
 * product's own census counts the indexes it built, so a second pass is visible in the artifact
 * rather than inferred from the options.
 *
 * ## Why the count and not the equality of delivered turns
 *
 * Because two passes over one question can deliver identical evidence -- a retry that re-reads the
 * same turns is harmless to `goldOverlap` and still doubles the cost of every comparison this
 * instrument is used for. The count is the cheap invariant; the delivered turns are checked
 * against the archived `S14` artifact by `tools/lexical-recall-calibrate.py`, which is the test
 * that the path is the same one.
 */
export function assertOfflineInstrumentReached(
  report: {
    readonly questionCount: number;
    /**
     * Optional because the report's own type says so: `memoryArmConfig` is absent on a report whose
     * arm never ran, and a signature that required it would have made this assertion unreachable for
     * exactly the run that most needs to fail it.
     */
    readonly memoryArmConfig?:
      { readonly selfIndex?: { readonly indexes: number } | undefined } | undefined;
  },
  runs: number,
): void {
  const census = report.memoryArmConfig?.selfIndex;
  if (census === undefined) {
    throw new Error(
      'CORTEX_ARM_OFFLINE=1 requires the product to have built an index, and this report carries ' +
        'no selfIndex census -- the run measured a system that rebuilt nothing, so there is no ' +
        'delivered evidence to account for.',
    );
  }
  const expected = report.questionCount * runs;
  if (census.indexes !== expected) {
    throw new Error(
      `the instrument built ${census.indexes} index(es) over ${report.questionCount} question(s) x ` +
        `${runs} run(s), where one retrieval per question per run is ${expected}. A second index ` +
        'means the fixed reply reached a mechanism that re-retrieves (a bare-decline retry, a ' +
        'second consultation, or a paired arm that builds the product on both sides), and the ' +
        "delivered evidence would then be that mechanism's rather than one retrieval's.",
    );
  }
}
