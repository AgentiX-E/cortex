/**
 * The option set the rerank arms are constructed with.
 *
 * Extracted from `bench/run.ts` so it can be tested. The CLI is excluded from
 * coverage as an entry point, and defect injection showed what that costs: the
 * spread that carries the B7 toggle into the arm was, from the suite's point of
 * view, unreachable code. Deleting it, defaulting it on, or reading the wrong
 * environment variable each left every test green -- because no test could
 * import the file the line lived in.
 *
 * The convention encoded here is ABSENCE for anything unconfigured. The runner
 * forwards each option on `=== true` or `!== undefined`, so an always-present
 * `false` or `undefined` would be read as configured and would make the option's
 * default unreachable. `exactOptionalPropertyTypes` in this package's tsconfig
 * is what enforces the difference.
 */
export type RerankArmOptionsInput = {
  /** Cross-encoder stage for the feature arm. Required: the arm is the reranker. */
  readonly reranker: unknown;
  /**
   * Roadmap B7, already parsed from the environment by `readToggle`.
   *
   * Required rather than optional so that adding a new caller cannot silently
   * omit it and run the control configuration while believing it enabled the
   * feature.
   */
  readonly candidateDiscrimination: boolean;
  /** Candidate pool width, when one was configured. */
  readonly rerankCandidatePool?: number | undefined;
  /** Leading hits the reranker may not move, when one was configured. */
  readonly rerankProtectedHead?: number | undefined;
  /** Sampling temperature, when one was configured. */
  readonly temperature?: number | undefined;
  /** Independent runs, when one was configured. */
  readonly runs?: number | undefined;
  /** Entity-identity sentence in the abstention prompt (shipped config: on). */
  readonly entityIdentityClause?: boolean | undefined;
};

/**
 * Builds the arm's option object, omitting every key that was not configured.
 *
 * Returns a loosely-typed record on purpose: the caller spreads it into a typed
 * call, and giving this function the runner's option type would make it a
 * pass-through with nothing to verify. What is worth verifying is which keys are
 * present, and that is what the return type exposes.
 */
export function rerankArmOptions(input: RerankArmOptionsInput): Record<string, unknown> {
  return {
    reranker: input.reranker,
    // The B7 toggle, present only when on. `true` and not the boolean, so a
    // future change to the runner's check cannot turn an explicit `false` into
    // an enabled feature.
    ...(input.candidateDiscrimination ? { candidateDiscrimination: true } : {}),
    ...(input.rerankCandidatePool === undefined
      ? {}
      : { rerankCandidatePool: input.rerankCandidatePool }),
    ...(input.rerankProtectedHead === undefined
      ? {}
      : { rerankProtectedHead: input.rerankProtectedHead }),
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
    ...(input.runs === undefined ? {} : { runs: input.runs }),
    ...(input.entityIdentityClause === undefined
      ? {}
      : { entityIdentityClause: input.entityIdentityClause }),
  };
}
