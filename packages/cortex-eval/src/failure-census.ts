/**
 * Failure census: where the questions the system actually fails are.
 *
 * ## Why this is not a report of the accuracy number
 *
 * The A2 accuracy is one figure, and every planning decision made from it so far
 * has been made from that figure alone. `benchmark-report.json` says 80.2%, or
 * 401 correct of 500, and the roadmap spends it on capability ranking without
 * ever asking *which* questions are missing.
 *
 * That gap in the record is what this module closes. The per-question
 * diagnostics the benchmark already writes carry the capability, the verdict,
 * and the reason for every question; nothing needed to locate the failures was
 * missing from the artifacts, only from the reading of them.
 *
 * ## The two axes, which are not the same axis
 *
 * A failed question has an outcome and a decision:
 *
 *   - **Outcome** -- correct or not. One bit.
 *   - **Decision** -- did the system answer, or did it refuse? A second bit.
 *
 * They are independent, and the combinations mean different things:
 *
 *   - *refused and wrong* -- the system declined something it should have
 *     answered. Announcing "I do not know" is a safe failure mode but it is
 *     still a failure, and it is the one the abstention threshold controls.
 *   - *answered and wrong* -- the system asserted something false. This is the
 *     dangerous mode and no guard currently targets it.
 *
 * A census that reports "36 failures" without this split cannot distinguish a
 * threshold set too high from a reader that hallucinates, and those are opposite
 * fixes.
 *
 * ## Which arm the diagnostics measure
 *
 * The diagnostics are written from the **feature** arm, not the baseline: the
 * A2 records sum to 430 correct, which is `feature.metrics.correct`, while the
 * baseline is 401. Any decomposition of "the questions the system fails" is
 * therefore a decomposition of 70 questions, not 99, and the two numbers must
 * not be used interchangeably. The counting here reads the records themselves
 * and never assumes which arm produced them.
 *
 * ## Why the capability is inferred rather than defaulted
 *
 * The multi-session diagnostics are filtered to MR before being written, so
 * those records carry no `capability` field. Treating an absent field as unknown
 * would drop all 121 MR questions from a 500-question census and leave the
 * per-capability table summing to 379 with nothing in the artifact saying why --
 * the same silent-denominator defect that `AUDIT-SILENT-DENOMINATOR.md` records.
 */

/** The subset of a per-question diagnostic this census reads. */
export type DiagnosticRecord = {
  readonly question_id: string;
  /**
   * The capability, present on single-session records and **absent** on
   * multi-session ones, which are MR by construction.
   */
  readonly capability?: string;
  readonly question: string;
  readonly correct: boolean;
  readonly decision: {
    /** Final decision reason; the retry path can flip a refusal into an answer. */
    readonly reason: string;
    readonly abstained: boolean;
  };
};

/** Per-capability slice of the census. */
export type CapabilityCensus = {
  readonly total: number;
  readonly correct: number;
  readonly failed: number;
  /** Failures where the system answered. */
  readonly failedAnswered: number;
  /** Failures where the system refused. */
  readonly failedRefused: number;
};

export type FailureCensus = {
  readonly total: number;
  readonly correct: number;
  readonly failed: number;
  /** Questions the system answered by refusing. */
  readonly abstained: number;
  readonly failedAnswered: number;
  readonly failedRefused: number;
  /** `failedRefused / failed`, or 0 when there are no failures. */
  readonly failedRefusedRate: number;
  /** Ids of failures the system answered. */
  readonly failedAnsweredIds: readonly string[];
  /** Ids of failures the system refused. */
  readonly failedRefusedIds: readonly string[];
  readonly byCapability: Readonly<Record<string, CapabilityCensus>>;
};

/** Capability of a diagnostic record, inferred from the record's own shape. */
function capabilityOf(record: DiagnosticRecord): string {
  // The multi-session diagnostics contain MR questions only, and omit the field
  // rather than repeating it. Inferring is not a guess here: a record without a
  // capability came from the file that has exactly one.
  return record.capability ?? 'MR';
}

/**
 * Mutable accumulator.
 *
 * Separate from `CapabilityCensus` on purpose: the exported type is `readonly`
 * so a consumer cannot mutate a census, and accumulation needs to increment.
 * Deriving one from the other by dropping `readonly` would let an increment
 * site drift from the published shape without a type error.
 */
type MutableCensus = {
  total: number;
  correct: number;
  failed: number;
  failedAnswered: number;
  failedRefused: number;
};

function emptyCensus(): MutableCensus {
  return { total: 0, correct: 0, failed: 0, failedAnswered: 0, failedRefused: 0 };
}

/**
 * Decompose a set of per-question diagnostics into a failure census.
 *
 * Total, correct and failed are all reported, and the per-capability counts are
 * guaranteed to sum to them -- a property the tests assert directly rather than
 * leaving to inspection, because a per-capability table that quietly disagrees
 * with its own total is exactly the defect this module is written against.
 */
export function decomposeFailures(options: {
  readonly records: readonly DiagnosticRecord[];
}): FailureCensus {
  const byCapability: Record<string, MutableCensus> = {};
  const failedAnsweredIds: string[] = [];
  const failedRefusedIds: string[] = [];
  let correct = 0;
  let abstained = 0;

  for (const record of options.records) {
    const capability = capabilityOf(record);
    const bucket = (byCapability[capability] ??= emptyCensus());

    bucket.total += 1;
    if (record.correct) {
      correct += 1;
      bucket.correct += 1;
    } else {
      bucket.failed += 1;
      // The reason is read as the record's final state. A retry that converts a
      // refusal into an answer leaves `reason: 'answered'`, and counting it as a
      // refusal would attribute the failure to the threshold.
      if (record.decision.abstained) {
        bucket.failedRefused += 1;
        failedRefusedIds.push(record.question_id);
      } else {
        bucket.failedAnswered += 1;
        failedAnsweredIds.push(record.question_id);
      }
    }
    if (record.decision.abstained) {
      abstained += 1;
    }
  }

  const total = options.records.length;
  const failed = total - correct;
  const failedRefused = failedRefusedIds.length;

  return {
    total,
    correct,
    failed,
    abstained,
    failedAnswered: failedAnsweredIds.length,
    failedRefused,
    failedRefusedRate: failed === 0 ? 0 : failedRefused / failed,
    failedAnsweredIds,
    failedRefusedIds,
    byCapability,
  };
}
