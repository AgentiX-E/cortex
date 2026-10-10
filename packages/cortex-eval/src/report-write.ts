/**
 * Writing a report must not be able to destroy a measurement.
 *
 * ## The incident this exists for
 *
 * Run `38003036421` graded all four runs of all five hundred questions -- about
 * forty minutes -- and died on the last line of the happy path:
 *
 *     RangeError: Invalid string length
 *         at JSON.stringify
 *         at main (.../packages/cortex-memory/bench/run-ablation.ts:273)
 *
 * The Markdown had been written; the JSON had not. What survived held a stack
 * trace and a document, and a complete measurement was gone. No reader could tell
 * "measured and un-writable" from "never measured".
 *
 * ## Why the repair lives here and not in the bench entry point
 *
 * `bench/**` is excluded from coverage as an entry point, so a decision written
 * there is a decision no test can reach. `bench-arm-options.ts` records the cost
 * of exactly that mistake: deleting the file, defaulting it on, and reading the
 * wrong environment variable each left every test green, *because no test could
 * import the file the line lived in*. So the decision -- what to do when the
 * artifact cannot be written -- lives in `cortex-eval`, and the entry point keeps
 * only the call.
 *
 * ## Why reduce rather than stream or split
 *
 * A streaming writer would make the artifact writable and enormous: the memory
 * arm's evidence is unbounded (`admission.ts` declines to truncate, and the arm
 * runs at `sessionBudget: unbounded`), and a multi-hundred-megabyte artifact has
 * to be uploaded, downloaded and parsed by every reader. Splitting across files
 * has the same problem plus a join step.
 *
 * Reducing keeps the measurement that the registration actually needs.
 * `§13.11.3`'s two predictions are about *whether* evidence reached a reader and
 * *how much* -- `evidenceTurns` and `evidenceChars` in every record -- not the
 * text of every turn. So the text is what gets reduced, and only as far as
 * necessary: the first bound that fits is used, not the smallest possible one.
 */

import type { AblationReport } from './report.js';
import type { AblationResult } from './types.js';
import {
  boundRetrievedContexts,
  buildQuestionRecords,
  evidenceReductionOf,
  type EvidenceReduction,
} from './question-record.js';

/**
 * What the writer needs from the runtime.
 *
 * Injected rather than imported so a test can exercise the decision with a real
 * function that throws for the size it chooses. A mock of `JSON.stringify` would
 * test the mock; a real serializer that throws on a real payload tests the
 * writer.
 */
type ReportWriterDeps = {
  /** Serialize a report. May throw, which is the case this module exists for. */
  serialize: (report: AblationReport) => string;
};

/**
 * What a reduction did, written beside the reduced report.
 *
 * ## Why the reason is carried as text
 *
 * A reader six months later has the artifact and not the log. The manifest is the
 * only place that can say *why* the report they are holding is smaller than the
 * run was, and an error class alone ("RangeError") does not distinguish a size
 * limit from a bug in the report.
 */
type ReductionManifest = {
  /** The error the full report failed to serialize with. */
  reason: string;
  /** The bound that was finally applied, in turns per record. */
  maxTurnsPerRecord: number;
  /** The bound that was attempted first, before it was tightened. */
  initialTurnsPerRecord: number;
  /** What `evidenceReductionOf` reports for the reduced records. */
  reducedQuestionIds: readonly string[];
  turnsCarried: number;
  turnsMeasured: number;
  charsMeasured: number;
};

/** The outcome of a write attempt: the JSON to persist, and what was lost. */
type ReportWriteResult = {
  json: string;
  reduced: boolean;
  manifest: ReductionManifest | null;
};

/**
 * The floor below which reduction stops.
 *
 * One turn is the smallest amount of evidence that is still evidence: a record
 * carrying zero turns while reporting `evidenceTurns > 0` is exactly the
 * "reduced reads as absent" confusion this module exists to prevent.
 */
const MIN_TURNS_PER_RECORD = 1;

/**
 * Serialize a report, reducing its carried evidence if the runtime refuses.
 *
 * Tries the report as given. On failure, retries with progressively tighter
 * evidence bounds until one fits, and returns a manifest naming what was
 * dropped. **Only a size failure triggers a reduction** -- a report that cannot
 * be serialized for any other reason is a bug in the report, and hiding it
 * behind a smaller artifact would report the bug as a property of the run.
 *
 * @throws If no bound fits, or if the failure is not a size failure. Both are
 * honest: the first means there is no artifact to write at any size, and the
 * second means the artifact is malformed rather than large.
 */
export function serializeReportOrReduce(
  report: AblationReport,
  deps: ReportWriterDeps,
  options: { maxTurnsPerRecord: number },
): ReportWriteResult {
  if (options.maxTurnsPerRecord < MIN_TURNS_PER_RECORD) {
    throw new Error(
      `maxTurnsPerRecord must be at least ${MIN_TURNS_PER_RECORD}, got ` +
        `${String(options.maxTurnsPerRecord)}. A bound of 0 would carry no evidence while ` +
        'still reporting evidenceTurns > 0, which makes a reduced record read as one whose ' +
        'reader was shown nothing.',
    );
  }

  const full = attempt(report, deps);
  if (full.json !== null) {
    return { json: full.json, reduced: false, manifest: null };
  }
  const firstError = full.error;

  // Tighten from the requested bound down to the floor. The first bound that
  // fits is used, so the artifact carries as much evidence as the runtime allows
  // rather than as little as the floor would permit.
  let bound = options.maxTurnsPerRecord;
  let lastError: SizeFailure = firstError;
  while (bound >= MIN_TURNS_PER_RECORD) {
    const reducedReport = withEvidenceBound(report, bound);
    const attemptResult = attempt(reducedReport, deps);
    if (attemptResult.json !== null) {
      // `reducedReport.questions` is narrowed, not defaulted: `withEvidenceBound`
      // returns the report unchanged when there is no cohort, and reaching this
      // line proves a cohort exists (line 129's full attempt failed, and an
      // empty cohort returns early through `withEvidenceBound`). A `?? []` here
      // would be an arm no input can reach -- an untestable claim that a missing
      // cohort is the same as an empty one.
      const reduction = evidenceReductionOf(reducedReport.questions!);
      if (reduction === null) {
        // The bound did not engage, yet the full report failed. Reducing further
        // cannot help, so this is a bug in the report rather than a size problem.
        throw describeFailure(firstError);
      }
      return {
        json: attemptResult.json,
        reduced: true,
        manifest: {
          reason: message(firstError),
          maxTurnsPerRecord: bound,
          initialTurnsPerRecord: options.maxTurnsPerRecord,
          reducedQuestionIds: reduction.reducedQuestionIds,
          turnsCarried: reduction.turnsCarried,
          turnsMeasured: reduction.turnsMeasured,
          charsMeasured: reduction.charsMeasured,
        },
      };
    }
    lastError = attemptResult.error;
    bound -= 1;
  }
  throw describeFailure(lastError);
}

/**
 * One serialization attempt, distinguishing a size failure from a real defect.
 *
 * Returns the failure rather than only a flag because the caller needs the
 * ORIGINAL error to put in the manifest: the first failure is why the report is
 * reduced, and the last one is only why the previous bound did not fit.
 *
 * A non-size failure is rethrown rather than returned, and that is the whole
 * point of the narrow `isSizeFailure`: a report that cannot be serialized for
 * any other reason is a bug in the report, and reducing the evidence for it
 * would publish the bug as a property of the run.
 */
function attempt(
  report: AblationReport,
  deps: ReportWriterDeps,
): { json: string; error: null } | { json: null; error: SizeFailure } {
  try {
    return { json: deps.serialize(report), error: null };
  } catch (error) {
    if (!isSizeFailure(error)) throw error;
    return { json: null, error };
  }
}

/**
 * Whether an error is the runtime refusing a string for its size.
 *
 * Narrow on purpose. A `RangeError` is also what an out-of-memory condition
 * raises on some paths, and a `TypeError` from a circular structure is a report
 * bug -- reducing the evidence for either would file a defect as a run property.
 * The message match is the only signal V8 gives for this specific limit.
 *
 * ## Why the shape test exists alongside `instanceof`
 *
 * `instanceof` is realm-bound. A serializer that runs in a worker, a `vm`
 * context or a second copy of the runtime throws a `RangeError` whose prototype
 * chain does not include this realm's, so the check would report "not a size
 * failure" for the one failure this module exists to absorb -- and the run would
 * die exactly as `38003036421` did, with the measurement complete and
 * unwritable. Accepting a `RangeError`-shaped object keeps the repair working
 * across realms.
 *
 * ## Why this is a type guard
 *
 * It is the only gate every accepted failure passes through, so it is where the
 * narrowing belongs: `message` then takes a value it can read directly rather
 * than re-deriving the shape and carrying an arm no input reaches.
 */
function isSizeFailure(error: unknown): error is SizeFailure {
  if (!isRangeErrorShaped(error)) return false;
  return error.message.includes('Invalid string length');
}

/**
 * Whether a value is a `RangeError`, by prototype or by shape.
 *
 * The shape test requires a string `message` -- the field the whole decision
 * turns on -- and does not require the `name` to match, because a serializer
 * that wraps a cross-realm error in a plain object may preserve the message and
 * drop the name, and that wrapper is still the failure this module exists to
 * absorb. A value with no string `message` cannot be a size failure either way,
 * since the match is on the message.
 */
function isRangeErrorShaped(error: unknown): error is SizeFailure {
  if (error instanceof RangeError) return true;
  if (error === null || typeof error !== 'object') return false;
  return typeof (error as { message?: unknown }).message === 'string';
}

/**
 * An error's text, whatever the runtime threw.
 *
 * Anything can be thrown in JavaScript, and the manifest's `reason` is the only
 * place a reader learns *why* the artifact they are holding is smaller than the
 * run was. Coercing a non-`Error` through `String` keeps that field readable
 * rather than `undefined`.
 */
/**
 * A size failure, in the two shapes one can arrive in.
 *
 * `attempt` accepts exactly these: a same-realm `RangeError`, or a
 * `RangeError`-shaped object from another realm. That is what makes the type of
 * `firstError`/`lastError` narrower than `unknown`, and it is why
 * `describeFailure` can be total over its input rather than defensive about it.
 */
type SizeFailure = Error & { readonly name: 'RangeError' };

/**
 * An error's text, for the one place a failure is described.
 *
 * ## Why the `message` field is read rather than the value coerced
 *
 * `String(someError)` is `[object Object]` -- it does NOT yield the error's
 * message. The `instanceof` branch covers a same-realm `Error`, but a
 * cross-realm `RangeError` is not an `Error` by this realm's prototype chain,
 * and coercing it would put `[object Object]` in the artifact's `reason`. The
 * manifest would then report a run failing for a reason it does not name. So an
 * object carrying a string `message` is read for that field.
 */
function message(error: SizeFailure | { message: string }): string {
  return error.message;
}

/**
 * Explain a failure that no evidence bound could fix.
 *
 * Reachable two ways, and they mean the same thing to a reader: the loop ran to
 * the floor without a fit, or the bound did not engage at all (so no smaller
 * artifact can exist). Both are report defects -- the artifact was never
 * writable, at any size -- and the message says so rather than describing a
 * reduction that did not happen.
 */
function describeFailure(error: SizeFailure): Error {
  const detail = message(error);
  return new Error(
    `the report could not be serialized at any evidence bound, so there is no artifact to ` +
      `write. The measurement existed in memory and is now lost; this is a report defect, not ` +
      `a run property. Underlying failure: ${detail}`,
  );
}

/**
 * A copy of the report whose records carry at most `bound` turns of evidence.
 *
 * Rebuilt through `buildQuestionRecords` rather than by trimming `turns` in
 * place, so the invariant that `turns`, `evidenceTurns` and the marker agree is
 * maintained by the one function that owns it. A second trimmer here would be a
 * second place for the three fields to disagree.
 *
 * ## Why `featureConfig` is read from the cohort and not from a record
 *
 * It is the builder's **second parameter**, shared by every record in the call,
 * and `QuestionRecordInput` has no such field. A reducer that forwards it per
 * record therefore loses it silently: the value goes into the call, no record
 * comes out carrying it, and the reduced report quietly lacks a configuration
 * the full report had. That is a dropped measurement dressed as a smaller one.
 *
 * The cohort value is the first record that carries one, which is sound because
 * `buildQuestionRecords` writes the same value to all of them; records that
 * disagree cannot come out of the builder, and if a report did hold such a
 * mixture the first is the honest single choice for a parameter that only takes
 * one value.
 */
function withEvidenceBound(report: AblationReport, bound: number): AblationReport {
  const records = report.questions;
  if (records === undefined || records.length === 0) return report;

  const featureConfig = records.find((record) => record.featureConfig !== undefined)?.featureConfig;

  return {
    ...report,
    // The evidence is carried twice, so the bound has to reach both copies. See
    // `withBoundedAblationEvidence` for what leaving this one alone costs.
    ablation: withBoundedAblationEvidence(report.ablation, bound),
    questions: buildQuestionRecords(
      records.map((record) => ({
        questionId: record.questionId,
        question: record.question,
        capability: record.capability,
        ...(record.groundTruth === undefined ? {} : { groundTruth: record.groundTruth }),
        ...(record.answer === undefined ? {} : { answer: record.answer }),
        ...(record.rawOutput === undefined ? {} : { rawOutput: record.rawOutput }),
        correct: record.correct,
        grounded: record.grounded,
        // The evidence is re-joined from the turns already carried, so the
        // reduction operates on the same text the record holds and cannot
        // introduce evidence the original record did not have.
        retrieved: record.turns.map((turn) => turn.text).join('\n'),
      })),
      featureConfig,
      records.map((record) => record.correct),
      { maxTurnsPerRecord: bound },
    ),
  };
}

/**
 * The ablation's own copy of the evidence, bounded by the same bound.
 *
 * ## Why the reduction has to reach this field, and why omitting it broke the net
 *
 * A report carries the reader's evidence twice: as `questions[].turns` and as
 * `ablation.featureRetrievedContexts`. Run `38044858147` published a **258 MB**
 * artifact in which every record was down to seventeen turns while **256 MB** of
 * it was this field, untruncated -- the §69 bound never reached it.
 *
 * That was survivable at 253 MB, which sits below V8's 537 MB string limit. What
 * is not survivable is the consequence for *this* module: a reduction that bounds
 * only `questions` cannot make the artifact fit, so the loop tightens to the floor
 * and throws `describeFailure` -- "the report could not be serialized at any
 * evidence bound" -- **while a writable artifact plainly exists**, one bounded
 * copy short. The safety net that exists so a measurement is never destroyed
 * would have destroyed it, and reported the run as a report defect.
 *
 * `featureRetrievedContexts` is optional on `AblationResult`, so an absent field
 * is returned as-is: a report that never captured the vector must reduce without
 * inventing it, or the artifact would claim a measurement the run did not make.
 * The same object is returned when there is nothing to bound, so the common case
 * allocates nothing.
 */
function withBoundedAblationEvidence(ablation: AblationResult, bound: number): AblationResult {
  const contexts = ablation.featureRetrievedContexts;
  if (contexts === undefined) return ablation;
  return {
    ...ablation,
    featureRetrievedContexts: boundRetrievedContexts(contexts, { maxTurnsPerRecord: bound }),
  };
}

/** Re-exported so a caller can type the manifest without importing the module. */
export type { EvidenceReduction };
