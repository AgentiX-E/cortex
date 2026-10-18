/**
 * Per-question artefact: the record an ablation must persist for its own verdict
 * to be auditable.
 *
 * Three readers need this and none can be served by an aggregate:
 *
 *   1. **The B7 criterion** (`tools/read-b7-criterion.mjs`). It recomputes the
 *      target roster from the run's own inputs and then applies the three
 *      clauses. Until this existed it failed with "no per-question array found"
 *      on every archived report, because the artifacts carried counts and
 *      discordant IDS but no per-question roster. A criterion that cannot be
 *      executed is not a criterion.
 *
 *   2. **Noise quantification** (`variance.ts`). `compareQuestionVectors` takes
 *      two `boolean[]` vectors aligned by question id. Nothing produced those
 *      vectors, so the module that exists to answer "how many questions does the
 *      endpoint move on its own?" had no real caller and no real data. That is
 *      the P4 lesson restated: a delta is not a measurement unless the noise it
 *      must clear has been measured, and the noise cannot be measured from
 *      counts.
 *
 *   3. **A reader asking "which questions moved"**. `docs/09-...` §20 records an
 *      A/B whose two arms differed by two questions and whose artifacts could
 *      not name them. A count is not a roster.
 *
 * ## What this module does NOT do
 *
 * It does not score anything and it does not decide correctness. `correct` is
 * passed in, and when a correctness vector is supplied it is authoritative --
 * because the vector is what the scorer returned, while a caller-set `correct`
 * is that caller's summary of it. Two sources for one boolean is how a report
 * and the vector inside it come to disagree.
 *
 * ## Why `turns` is derived here rather than stored pre-split
 *
 * `computeTargetCohort` clusters over `turns`, and a single blob would place
 * every candidate in one turn, so no two clusters could form and every question
 * would classify `unseparable`. The derived split is therefore load-bearing for
 * the criterion, not cosmetic.
 */

import type { TurnLike } from './candidate-context.js';
import type { AdmittedEvidence, GoldOverlap, RetrievedTurns } from './types.js';
import type { FeatureConfig } from './report.js';

/**
 * One graded question, with everything a downstream reader needs to re-derive a
 * verdict about it.
 *
 * Field names follow `CohortQuestion` in `b7-cohort.ts` for the four fields the
 * criterion consumes (`questionId`, `question`, `groundTruth`, `answer`) plus
 * `grounded`, so the criterion reader transcribes rather than translates. A
 * translation layer between two spellings of the same field is a place for them
 * to drift apart silently.
 */
export type QuestionRecord = {
  /** Stable identifier. Ids, not indices — an index is meaningful only relative
   * to a dataset order that is not itself recorded, so ids survive reordering. */
  readonly questionId: string;
  readonly question: string;
  readonly capability: string;
  /**
   * The dataset's gold answer. `string | number` because LongMemEval stores some
   * golds as JSON numbers, and coercing here would make `85` and `"85"`
   * indistinguishable downstream. `null` is a gold of "no answer", which is a
   * real value and not an absence.
   */
  readonly groundTruth?: string | number | null;
  /**
   * What the system produced. `null` means it abstained; `undefined` means
   * nobody recorded an answer. The criterion has a branch for the first and
   * none for the second, and conflating them reports a recording gap as reader
   * behaviour.
   */
  readonly answer?: string | number | null;
  /**
   * The system's raw model output for this question, before it was parsed.
   *
   * ## Why `answer` above cannot stand in for it
   *
   * `answer` is the parsed value, and `Answer` is `string | null`. `parseAnswer`
   * recognises a decline from the **last non-empty line only**, after stripping
   * a label like `Answer:` and comparing case-insensitively, so the bare token,
   * a labelled token and an explanation followed by the token all arrive as
   * `null`. Dispatch `37792539133` carried the first real roster built from this
   * shape and 115 of its 120 records read `null`; the 29 baseline-correct
   * questions the read exists to explain were three behaviours collapsed into
   * one value.
   *
   * `undefined` means nobody captured raw output for this question, `null` means
   * the model was not consulted (a machine-derived abstention) or the system
   * exposes none. The two are different statements, which is the same
   * distinction `answer` above draws one field earlier.
   */
  readonly rawOutput?: string | null;
  /** The scorer's verdict for this question. */
  readonly correct: boolean;
  /**
   * Whether the upstream classifier called this a grounded failure at all.
   * `false` excludes the question from B7 before clustering, so a change in the
   * classifier cannot silently enlarge the target set.
   */
  readonly grounded: boolean;
  /** The retrieved context the reader was shown, split into admission order. */
  readonly turns: readonly TurnLike[];
  /**
   * How many turns were **admitted** for this question, before any bound.
   *
   * ## Why this is not `turns.length`
   *
   * Run `38003036421` completed all four runs of all five hundred questions and
   * then died writing the JSON with `RangeError: Invalid string length`: the
   * memory arm carries the evidence **unbounded**, and carries it twice -- once
   * in `ablation.featureRetrievedContexts`, once as `turns[].text` here. The
   * report that would have documented the run could not be written, and the
   * artifact could not distinguish a measurement that failed to serialize from a
   * run that never measured.
   *
   * The fix is to bound what is carried without bounding what is measured. This
   * field is the measurement: it is the true count and is **never** reduced.
   * `turns` may be, and when it is, `turns.length !== evidenceTurns` is the
   * signal.
   *
   * `§13.11.3`'s first prediction -- MR/TR records carry a non-empty evidence
   * vector -- is decided by `evidenceTurns > 0`, so it survives any bound. The
   * second, that abstention records are not uniformly empty, is decided by
   * comparing this field against the population, and survives likewise.
   *
   * ## Why "admitted" and not "shown to the reader", which is what this said
   *
   * This field counts the turns of the captured context -- `lastRetrievedContext`,
   * which is what was **passed to** `buildPrompt`. It is not what the prompt
   * carried: `buildPrompt` calls `fitToBudget` when the assembled prompt exceeds
   * `maxChars`, and that truncates the evidence. The arm never sets
   * `maxPromptChars`, so the budget is `DEFAULT_MAX_PROMPT_CHARS` (24,000) on
   * every question, while run `38044858147` averaged 506,338 characters of
   * evidence per question.
   *
   * So on that run this field reports 3,016-4,528 while the model received at most
   * 24,000 characters -- roughly 150-160 turns, an overstatement of about twenty
   * times. The number is still the right one for `§13.11.3`, whose two predictions
   * ask whether retrieval *produced* evidence.
   *
   * ## What this field became, twice
   *
   * It counts the **offer**: what admission produced, before the prompt builder's
   * budget. It derived that from the captured context until §13.15 changed what the
   * capture holds, and neither of the two consequences was visible without a run.
   *
   * `§13.11.5`'s ranking question -- was the gold turn inside what the model saw --
   * needs membership, not a size, so `turns` had to become the **delivery**; that is
   * repaired. But `turns` and this field then derived from one string, so this stopped
   * describing the offer: run `38142407062` shows it at a median of **141** where the
   * previous run showed 3,016-4,528. The artifact could no longer say how much evidence
   * existed, which is what `§13.11.3` reads and what makes the budget's effect legible.
   *
   * It now comes from its own capture, `MemorySystem.lastAdmittedEvidence`, and is
   * **absent** when the system cannot report it -- a real state, distinct from zero,
   * and reached by every test double in the arm's own suite.
   *
   * The three states a reader can read from this field and `turns` together:
   *
   *   - absent -- the system cannot report the offer; `turns` still says what was read
   *   - `turns.length < evidenceTurns` -- a budget or a bound removed turns
   *   - `turns.length === evidenceTurns` -- nothing was removed
   */
  readonly evidenceTurns?: number | undefined;
  /**
   * The size in characters of the admitted evidence, un-reduced.
   *
   * Carried beside `evidenceTurns` because the two fail differently: a question
   * can be shown one enormous turn or a thousand small ones, and a bound chosen
   * on turn count alone would be defeated by the first. A reader deciding
   * whether the bound engaged needs both, and a reader auditing the bound's cost
   * needs `evidenceChars`.
   *
   * The offer's size, for the reason `evidenceTurns` states -- and absent for the
   * same reason too. This is the field that makes the gap measurable at all: 506,338
   * characters against a 24,000-character budget is the whole of it.
   */
  readonly evidenceChars?: number | undefined;
  /**
   * The characters of evidence the prompt actually carried, when it is known.
   *
   * ## Why this is beside `evidenceChars` rather than replacing it
   *
   * `evidenceChars` is the **offer**: the admitted context, which is what
   * `§13.11.3`'s two predictions are read from. This is the **delivery**: what
   * survived the prompt builder's character budget, which is what `§13.11.5`'s
   * ranking question needs. They are different questions about the same run, and a
   * single field cannot answer both.
   *
   * Run `38044858147` is why the second one had to exist. Its `evidenceChars`
   * averages 506,338 against a 24,000-character budget, so the artifact described
   * a model that saw twenty times more evidence than it did -- and the field it
   * was read from is documented as "how many turns the reader was shown".
   *
   * Absent when the system under test exposes no such accessor. Absent is not
   * zero: a system that cannot report it has not reported a prompt that carried
   * nothing, and the two must not render the same way.
   */
  readonly promptChars?: number | undefined;
  /**
   * How much of the dataset's gold evidence the reader's context contained.
   *
   * ## Why this field is the point of `§13.18`
   *
   * `§13.11.5` asks whether the gold turn was inside what the model saw, and it is
   * the question that decides whether an abstention is a retrieval failure or a
   * model failure. Run `38250133116` could not answer it: the predicate available to
   * a reader of the artifact alone was a substring match on `groundTruth`, and the
   * artifact refuted that predicate in three lines -- `3` matched `3. **Humidity:**`,
   * `2` matched `2. What are your short-term goals`, `3` matched `3. store reusable
   * produce bags`. A prediction whose metric can be moved by list markers cannot be
   * falsified, and a pre-registration whose outcome cannot be falsified is the §7.3
   * side-channel defect turned on the registration itself.
   *
   * ## Why it is measured against the pre-bound context
   *
   * `carried` is counted in `QuestionRecordInput.retrieved`, the captured context
   * **before** `evidenceBound` reduced it. That is deliberate and it is the same rule
   * `evidenceTurns` follows: `§13.12`'s bound exists to keep the artifact writable,
   * and a measurement that moved when a writability guard was tuned would make two
   * runs incomparable for a reason that is not about the system.
   *
   * ## Absent, never zero, when nothing could be measured
   *
   * `undefined` covers two situations a reader must not read as "the gold turn was
   * missed": the dataset named no gold evidence (every `_abs` question), and no
   * carried context was recorded at all (a caller with no trace). Both are *not
   * measured*, and a zero would render them as a measured miss -- the collapse
   * `§13.11.2` requires an absence never to make.
   */
  readonly goldOverlap?: GoldOverlap | undefined;
  /**
   * The switches this record was produced under, stamped per record.
   *
   * Per record rather than once beside the array: a reader handed one record out
   * of the array — which is what a diff or a filtered subset gives them — must
   * still be able to see which configuration produced it. Absent when no
   * configuration was recorded; omitted rather than defaulted to all-off,
   * because a fabricated "everything off" reads as evidence about a run nobody
   * recorded.
   */
  readonly featureConfig?: FeatureConfig | undefined;
};

/** One question's inputs, before the record is assembled. */
export type QuestionRecordInput = {
  readonly questionId: string;
  readonly question: string;
  readonly capability: string;
  readonly groundTruth?: string | number | null;
  readonly answer?: string | number | null;
  /** The system's raw model output, when a caller captured it. */
  readonly rawOutput?: string | null;
  /** The caller's summary of the verdict; overridden by `correctness` if given. */
  readonly correct: boolean;
  readonly grounded: boolean;
  /**
   * The evidence the reader received, as the units its capture reports.
   *
   * ## Why this is a list and not the joined text, since §13.16.6
   *
   * It was `string` -- the captured context, turns joined with newlines -- and
   * `toTurns` split it back on the same newline. The round trip cannot tell a turn
   * whose content spans newlines from several turns, so `QuestionRecord.turns` and
   * every count derived from it measured **lines**: 84.9% of the MR roster's entries
   * on run `38142407062` were continuation lines, about 6.6 lines per turn.
   *
   * A list cannot lose the boundary, which is why the repair is here rather than in a
   * cleverer split. The memory arm passes the turn list its own assembler selected.
   *
   * ## The unit differs by producer, and that is stated rather than hidden
   *
   * `buildRecordsFromDataset` passes the **lines** of `DecisionTrace.retrieved`, which
   * is a rendered string whose upstream contract (`expandContextWindow*`) returns text
   * and not a list. That producer's unit is therefore still lines, and repairing it
   * means changing what `retrieveTurns` hands its two prompt builders -- a separate
   * registered change, because it reaches the reference pipeline's admission rather
   * than this arm's capture.
   *
   * The consequence is that a record's `turns` means turns for the memory arm and lines
   * for a trace product, and the two products are read by different readers. A reader
   * that compared them would be comparing units, which is why the field is documented
   * per producer here instead of being given one uniform gloss.
   */
  readonly retrieved: RetrievedTurns;
  /**
   * How much evidence admission produced, before any budget. `null` if unknown.
   *
   * ## Why this is required and nullable, rather than optional or numeric
   *
   * **Required**, so every producer states it and the compiler enumerates the
   * producers. That is not ceremony: `retrieved` is the **delivery** since §13.15, so a
   * producer that silently omitted the offer would leave the record deriving both from
   * one string -- which is exactly what happened, invisibly, until run `38142407062`
   * showed `evidenceTurns` fall from 3,016-4,528 to a median of 141. It also covers the
   * reducer's own rebuild: `withEvidenceBound` remaps records through this type, so a
   * field it forgets to forward is now a compile error rather than an artifact that
   * quietly reports the wrong number. `featureConfig` and `promptChars` were each
   * dropped that way once.
   *
   * **Nullable**, because a system may legitimately have no accessor for it -- the
   * arm's own test doubles have none -- and the two dishonest alternatives are a
   * fabricated zero, which reads as a system that admitted nothing, and a fallback to
   * `retrieved`, which is the collapse above. `null` reaches the record as an **absent**
   * `evidenceTurns`, the same way a `null` `promptChars` does.
   *
   * `AdmittedEvidence` rather than two numbers, so the pair cannot be transposed on
   * the way through four hops.
   */
  readonly admitted: AdmittedEvidence | null;
  /**
   * The evidence characters the prompt carried, when the caller can report it.
   *
   * `null` is treated as absent rather than as zero: it means the system exposes
   * no such accessor, which is not the same statement as a prompt that carried
   * nothing. Absent either way, so a reader cannot see a `null` where a number
   * belongs.
   */
  readonly promptChars?: number | null | undefined;
  /**
   * How much of the dataset's gold evidence `retrieved` contained, or `null`.
   *
   * ## Why the caller measures it and this type only carries it
   *
   * The measurement needs the **pre-bound** context -- `retrieved` as captured,
   * before `evidenceBound` reduced it -- and `buildQuestionRecords` is not the only
   * producer that knows that string: the reducer re-enters through this same type
   * with a context it has already reduced, so a value computed here would be
   * recomputed there against a shorter context and would fall as the bound tightened.
   * A writability guard must not move a measurement.
   *
   * So the shape is the one `admitted` already uses, for the same reason: the
   * producer measures once, the type carries the result, and the reducer **forwards**
   * it rather than deriving it. `goldOverlapOf` below is the single implementation of
   * the measurement, so the arm and `buildRecordsFromDataset` cannot disagree about
   * what coverage means.
   *
   * Required and nullable, so a producer that forgets it is a compile error rather
   * than an artifact whose coverage is absent for an unstated reason.
   */
  readonly goldOverlap: GoldOverlap | null;
};

/**
 * The marker appended as a final turn when a record's evidence was reduced.
 *
 * ## Why a marker rather than a flag
 *
 * A boolean field would say "this was reduced" and leave a reader unable to see
 * *how much* -- and the `turns` array would then read as a complete record whose
 * `turns` happened to be short. The marker travels inside the array it describes,
 * so it cannot be separated from the thing it is a statement about: a reader who
 * filters or diffs `turns` carries the disclosure with them.
 *
 * It is deliberately not a valid turn: `commit` boundaries and the clustering
 * criterion both treat it as text, and a marker that could be mistaken for
 * evidence would let a reduction enlarge the target set.
 *
 * The three states this distinguishes, per `§13.11.2`'s requirement that an
 * absence must never render as a value:
 *
 * | State | `turns` | `evidenceTurns` |
 * | --- | --- | --- |
 * | reader shown nothing | `[]` | `0` |
 * | shown, carried in full | complete | `turns.length` |
 * | shown, reduced | prefix + this marker | the true count |
 */
export const REDUCED_TURNS_MARKER = '[evidence reduced:';

/**
 * The marker for a bound that dropped `dropped` of `total` turns.
 *
 * ## Why writing and reading share this function
 *
 * `evidenceReductionOf` reads the dropped and total counts back out of the marker,
 * because after §13.16 the record no longer holds a pre-bound count of its own --
 * `evidenceTurns` is the offer and `turns` is the delivery. A format written in one
 * place and parsed in another is two owners of one format, and the failure mode is
 * silent: a marker that stopped matching would make a reduced report look complete.
 * `markerCounts` below is the only reader and this is the only writer.
 */
function markerText(dropped: number, total: number): string {
  return `${REDUCED_TURNS_MARKER} ${dropped} of ${total} turns not carried]`;
}

/**
 * The counts a marker names, or `null` when this turn is not a marker.
 *
 * `null` for a turn that is not a marker is the ordinary case and not an error --
 * every unbounded record has one. A marker whose numbers cannot be read would be a
 * defect in `markerText`, which is why the parse is anchored on that template rather
 * than on a loose pattern: the digits between the fixed words are the only part that
 * can vary, so a match is a positive statement about the format.
 */
function markerCounts(turn: TurnLike | undefined): { dropped: number; total: number } | null {
  if (turn === undefined || !turn.text.startsWith(REDUCED_TURNS_MARKER)) return null;
  const match = /^(\d+) of (\d+) turns not carried\]$/.exec(
    turn.text.slice(REDUCED_TURNS_MARKER.length).trim(),
  );
  if (match === null) return null;
  return { dropped: Number(match[1]), total: Number(match[2]) };
}

/**
 * How much of each record's evidence to carry, when a bound is wanted.
 *
 * Absent means carry everything -- the pre-existing behaviour, kept as the
 * default so no existing caller changes meaning. Present bounds `turns` only;
 * `evidenceTurns` and `evidenceChars` are never reduced.
 */
export type EvidenceBoundOptions = {
  /**
   * The maximum number of real turns to carry per record, before the marker.
   *
   * Must be at least 1. A bound of `0` would carry no evidence at all while
   * still reporting `evidenceTurns > 0`, which is the "reduced reads as absent"
   * confusion this type exists to prevent -- so it is rejected rather than
   * silently clamped.
   */
  readonly maxTurnsPerRecord: number;
};

/**
 * The floor below which a bound stops.
 *
 * One turn is the smallest amount of evidence that is still evidence: a record
 * carrying zero turns while reporting `evidenceTurns > 0` is exactly the
 * "reduced reads as absent" confusion `EvidenceBoundOptions` exists to prevent.
 */
const MIN_TURNS_PER_RECORD = 1;

/**
 * Reject a bound that would carry no evidence at all.
 *
 * Shared by both places a bound is applied, so the two cannot drift into
 * disagreeing about which bounds are legal -- a bound the record builder rejects
 * but the context bound silently clamps would put the two copies of the evidence
 * in different states.
 */
function requireValidBound(bound: EvidenceBoundOptions): void {
  if (bound.maxTurnsPerRecord < MIN_TURNS_PER_RECORD) {
    throw new Error(
      `maxTurnsPerRecord must be at least ${MIN_TURNS_PER_RECORD}, got ` +
        `${String(bound.maxTurnsPerRecord)}. A bound of 0 would carry no evidence while ` +
        'still reporting evidenceTurns > 0, which makes a reduced record read as one whose ' +
        'reader was shown nothing.',
    );
  }
}

/**
 * Number the units of a retrieved context, in the order the reader saw them.
 *
 * ## Why this no longer splits anything, since §13.16.6
 *
 * It took the joined text and split it on newlines, which made a turn whose content
 * spans newlines several turns and could not be told apart from several turns. The
 * capture now reports the units it actually holds, so this numbers them and does not
 * re-derive them -- the boundary is not guessed at and therefore cannot be lost.
 *
 * The units are the producing capture's own: turns for the memory arm, lines for a
 * trace that carried a rendered string. `QuestionRecordInput.retrieved` documents why
 * the two differ and what repairing the second would reach.
 *
 * ## Why blanks are still dropped
 *
 * A blank unit carries no content terms, so it can never be clustered, and keeping it
 * only inflates the index space a reader has to walk. `contextRadius`-style neighbours
 * are not reconstructible from the reported units, which is why the record is a faithful
 * transcription of what the reader saw rather than a reconstruction of the hits list.
 */
function toTurns(retrieved: RetrievedTurns, bound?: EvidenceBoundOptions): TurnLike[] {
  const turns: TurnLike[] = [];
  for (const text of retrieved) {
    if (text.trim().length === 0) continue;
    turns.push({ index: turns.length, text });
  }
  if (bound === undefined || turns.length <= bound.maxTurnsPerRecord) {
    return turns;
  }
  const dropped = turns.length - bound.maxTurnsPerRecord;
  const kept = turns.slice(0, bound.maxTurnsPerRecord);
  // The marker is the LAST turn, so a reader who reads `turns` in order sees the
  // disclosure after the evidence it qualifies rather than before it.
  kept.push({
    index: kept.length,
    text: markerText(dropped, turns.length),
  });
  return kept;
}

/**
 * The same bound, applied to the ablation's own copy of the evidence.
 *
 * ## Why this has to exist
 *
 * The arm persists the evidence twice: this vector and `questions[].turns`. §69
 * bounded the first and left this one alone, and run `38044858147` measured the
 * result -- a 258 MB artifact in which the records were down to seventeen turns
 * each while **256 MB** of it was the untruncated ablation vector. A bound that
 * reaches one of two copies is not a bound: the artifact is still one order of
 * magnitude from V8's 537 MB string limit, and a larger dataset or a longer
 * question set puts it back over.
 *
 * ## Why it reuses `toTurns` rather than re-slicing
 *
 * The two copies must describe the same thing. Cutting here with a second
 * implementation -- a `slice` on the raw units, say -- would keep a different prefix
 * whenever an empty unit is present, because `toTurns` drops blanks before counting.
 * The caller-visible invariant is that `boundRetrievedContexts(texts, b)[i]` equals
 * `records[i].turns.map((t) => t.text)`, and going through one function is what makes
 * that true by construction rather than by coincidence.
 *
 * Since §13.16.6 the value is a list of the capture's own units, so the bound cuts the
 * list and never re-encodes a boundary it would have to re-guess.
 *
 * `null` passes through: it is "no reader was consulted", which a bound has nothing to
 * say about, and collapsing it to `[]` would erase the distinction in the one place the
 * vector still expresses it.
 *
 * @returns The input array itself when no bound is given, so an unbounded caller
 * keeps exactly the data it passed rather than a copy of it.
 */
export function boundRetrievedContexts(
  contexts: readonly (RetrievedTurns | null)[],
  bound?: EvidenceBoundOptions,
): readonly (RetrievedTurns | null)[] {
  if (bound === undefined) return contexts;
  requireValidBound(bound);
  return contexts.map((units) =>
    units === null ? null : toTurns(units, bound).map((turn) => turn.text),
  );
}

/**
 * Assemble the per-question records for one arm.
 *
 * `correctness`, when supplied, is the authority for `correct` and must align
 * with `inputs`; a length mismatch throws rather than truncating. A vector and a
 * record list that are off by one align every question after the gap against the
 * wrong one, and `compareQuestionVectors` would then compare two runs on that
 * basis and return a plausible number derived from meaningless data — which is
 * the specific error `variance.ts` throws to prevent one layer down. Catching it
 * here keeps the cause visible at the point of construction.
 *
 * Duplicate ids throw for the same class of reason: ids are the join key for
 * every comparison this artefact feeds, and a map built from a duplicated key
 * silently keeps one record and drops the other, so a moved question would read
 * as stable.
 */
export function buildQuestionRecords(
  inputs: readonly QuestionRecordInput[],
  featureConfig?: FeatureConfig,
  correctness?: readonly boolean[],
  evidenceBound?: EvidenceBoundOptions,
): QuestionRecord[] {
  if (correctness !== undefined && correctness.length !== inputs.length) {
    throw new Error(
      `correctness vector length ${correctness.length} is not ${inputs.length}, the number of question records`,
    );
  }
  if (evidenceBound !== undefined) requireValidBound(evidenceBound);

  const seen = new Set<string>();
  const records: QuestionRecord[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]!;
    if (seen.has(input.questionId)) {
      throw new Error(`duplicate question id in per-question records: ${input.questionId}`);
    }
    seen.add(input.questionId);

    records.push({
      questionId: input.questionId,
      question: input.question,
      capability: input.capability,
      ...(input.groundTruth === undefined ? {} : { groundTruth: input.groundTruth }),
      ...(input.answer === undefined ? {} : { answer: input.answer }),
      ...(input.rawOutput === undefined ? {} : { rawOutput: input.rawOutput }),
      correct: correctness === undefined ? input.correct : correctness[i]!,
      grounded: input.grounded,
      turns: toTurns(input.retrieved, evidenceBound),
      // The offer, from the input and never from `retrieved` -- see
      // `QuestionRecordInput.admitted` for why the fallback would be invisible. Omitted
      // when unknown, because a reader must be able to tell "not measured" from
      // "measured as nothing", and the two fields are written together or not at all.
      ...(input.admitted === null
        ? {}
        : { evidenceTurns: input.admitted.turns, evidenceChars: input.admitted.chars }),
      // `null` is the caller saying "this system cannot report it", which is not a
      // prompt that carried nothing -- so it is omitted rather than written.
      ...(input.promptChars === undefined || input.promptChars === null
        ? {}
        : { promptChars: input.promptChars }),
      ...(input.goldOverlap === null ? {} : { goldOverlap: input.goldOverlap }),
      ...(featureConfig === undefined ? {} : { featureConfig }),
    });
  }
  return records;
}

/**
 * The one implementation of the gold-coverage measurement.
 *
 * ## Why it is a function and not two lines in each producer
 *
 * Two producers measure it -- the memory arm from its captured context, and
 * `buildRecordsFromDataset` from a trace -- and a third forwards the result. A
 * measurement written twice is a measurement that can differ between producers, and
 * the difference would be invisible: both would report a coverage figure and a reader
 * comparing runs would be comparing two definitions.
 *
 * ## Why the comparison is membership and not a substring search
 *
 * `goldTurns` and `retrieved` are both produced by `turnText`, so a gold turn is
 * either the whole of one carried unit or it is not present at all. That makes this a
 * membership test between two applications of one renderer rather than a
 * natural-language match, and the distinction is what `§13.18.2` cost: a substring
 * search on the answer text matched `3. **Humidity:**` for a gold of `3`.
 *
 * ## Why the list makes this exact rather than padded, since §13.16.6
 *
 * It searched `'\n' + retrieved + '\n'` for `'\n' + turn + '\n'` until §13.16.6, so
 * that a gold which is a prefix of another turn -- `[d] user: I went` inside
 * `[d] user: I went to Lisbon` -- was not reported as covered. The padding was a
 * workaround for having destroyed the boundary in the first place: it reconstructed
 * the test "this text is one of the carried units" from a joined string. With the
 * units in hand the test is that statement itself, and the workaround -- and the
 * single-separator assumption it rests on -- is gone.
 *
 * ## Why `null` rather than a zero object
 *
 * `[]` and an absent annotation both mean "there is nothing to measure", and a
 * `{carried: 0, total: 0}` would render them as a measured miss -- the collapse
 * `§13.11.2` forbids. `null` is what reaches the record as an absent `goldOverlap`.
 */
export function goldOverlapOf(
  retrieved: RetrievedTurns,
  goldTurns: readonly string[] | undefined,
  /**
   * The gold turns the ranking offered, **best first**, or `undefined` when no ranking was
   * consulted.
   *
   * The order is now load-bearing: `pool` counts it and `goldRanks` records each gold turn's
   * position in it. A caller that passes an unordered set produces a `pool` that is right and
   * a `goldRanks` that is arbitrary, which the index's `rankedCandidatesFor` exists to make
   * impossible.
   *
   * A `readonly string[]` rather than a predicate over one, because the caller already
   * holds the index's candidates and a predicate here would invite a second definition of
   * membership beside this one. `GoldOverlap.pool` documents the partition the three
   * counts make and why an absent pool is absent rather than zero.
   */
  poolGold?: readonly string[] | undefined,
): GoldOverlap | null {
  if (goldTurns === undefined || goldTurns.length === 0) return null;
  // Membership on the carried units themselves. The test is "this gold text is one of
  // the units the reader received", which is the question `§13.11.5` asks, and it is
  // asked of the list rather than reconstructed by padding a joined string. The same
  // class of defect as `§13.18.2`'s answer-text search, and it cannot recur here: a
  // bare substring search is not expressible against a list of units.
  const carried = goldTurns.filter((gold) => retrieved.includes(gold)).length;
  const ranks =
    poolGold === undefined ? undefined : goldTurns.map((gold) => poolGold.indexOf(gold));
  return {
    carried,
    total: goldTurns.length,
    // Spread rather than assigned `undefined`, so a caller that consulted no ranking
    // gets the two-field object it got before this parameter existed -- byte-identical in
    // JSON, which is what keeps every archived artifact's meaning unchanged.
    ...(ranks === undefined
      ? {}
      : {
          pool: ranks.filter((rank) => rank >= 0).length,
          // `indexOf` returns -1 for a gold turn the ranking did not surface, which is
          // exactly the encoding `goldRanks` documents: the array is the curve.
          goldRanks: ranks,
        }),
  };
}

/**
 * What a bound did to a record set, or `null` when it did nothing.
 *
 * ## Why this is derived rather than tallied during construction
 *
 * A caller that incremented counters while building would hold a second source
 * for what the records already say, and the two could disagree -- `§12.7`'s
 * shape, where a value is reported one way and stored another. Deriving it from
 * the records means a report's reduction manifest and its records cannot
 * contradict each other, and it lets the manifest be computed after the fact by
 * a reader that was handed only the artifact.
 *
 * `null` rather than a zero-valued object, because "no bound was applied" and "a
 * bound was applied and dropped nothing" are different facts about a run, and a
 * manifest that renders them identically would make a decorative bound look like
 * a working one. `§13.12.5` predicts the reducible set is non-empty; this is what
 * makes that prediction falsifiable.
 */
export function evidenceReductionOf(records: readonly QuestionRecord[]): EvidenceReduction | null {
  // The marker is the signal, and since §13.16 it is the ONLY signal: the comparison
  // this used to make -- `turns.length !== evidenceTurns` -- stopped meaning "the
  // bound bit" the moment `evidenceTurns` became the offer, and would have fired on
  // every record of every run, reporting a bound that never engaged.
  const reduced = records.filter((record) => markerCounts(record.turns.at(-1)) !== null);
  if (reduced.length === 0) return null;

  let turnsCarried = 0;
  let turnsMeasured = 0;
  let charsMeasured = 0;
  let droppedTurns = 0;
  for (const record of records) {
    const marker = markerCounts(record.turns.at(-1));
    // Real turns only, so `turnsCarried` does not count the disclosure as evidence.
    turnsCarried += marker === null ? record.turns.length : record.turns.length - 1;
    if (marker !== null) {
      droppedTurns += marker.dropped;
      // The pre-bound size lives in the marker and nowhere else once `evidenceTurns`
      // is the offer, so it is read from the one writer of that format.
      turnsMeasured += marker.total;
    } else {
      turnsMeasured += record.turns.length;
    }
    // Summed over the records that can report it. A system with no accessor
    // contributes nothing measurable rather than a zero that would be read as an offer
    // of no characters -- and on this arm every record has it, so the sum IS the offer.
    // The bound's own effect is reported by `droppedTurns`, which comes from the markers
    // and therefore does not depend on this field at all.
    charsMeasured += record.evidenceChars ?? 0;
  }
  return {
    reducedQuestionIds: reduced.map((record) => record.questionId),
    turnsCarried,
    turnsMeasured,
    charsMeasured,
    droppedTurns,
    maxTurnsPerRecord: Math.max(...reduced.map((record) => record.turns.length - 1)),
  };
}

/**
 * The per-question correctness vector of a record set, in record order.
 *
 * Derived from the records rather than kept as a second array. Two arrays that
 * must agree are two arrays that can disagree, and the disagreement would be
 * invisible until a comparison reported a flip that never happened.
 */
export function correctnessVector(records: readonly QuestionRecord[]): boolean[] {
  return records.map((record) => record.correct);
}

/**
 * The reverse of the record construction: the offer a record holds, or `null`.
 *
 * ## Why this is exported and shared
 *
 * Every reader that round-trips an artifact back through `buildQuestionRecords` --
 * the reducer, and both `tools/*.mjs` readers -- needs it, and each of them would
 * otherwise hand-roll the same two-field reconstruction. Three hand-rolled copies of
 * one mapping is three places for it to drift, and the drift would be invisible: a
 * reader that reconstructed the offer differently from the writer would report a
 * different run from the same file.
 *
 * Typed on the two fields rather than on `QuestionRecord` so a reader holding a parsed
 * artifact -- which is not yet a record -- can call it, which is exactly the situation
 * `tools/read-b7-criterion.mjs` is in.
 *
 * `null` when either field is absent: the two are written together or not at all, and
 * a record that reports only one of them is a record this function refuses to
 * half-read.
 */
export function admittedFromRecord(record: {
  readonly evidenceTurns?: number | undefined;
  readonly evidenceChars?: number | undefined;
}): AdmittedEvidence | null {
  if (record.evidenceTurns === undefined || record.evidenceChars === undefined) return null;
  return { turns: record.evidenceTurns, chars: record.evidenceChars };
}

/**
 * The offer, for a producer whose `retrieved` is the offer.
 *
 * Correct only where no budget sits between admission and the record -- a trace read
 * back from disk, or a fixture. The arm must NOT use this: its `retrieved` is the
 * delivery, and counting the delivery as the offer is precisely the defect run
 * `38142407062` exposed. Naming it for the situation rather than for the arithmetic
 * is what keeps that distinction visible at each call site.
 */
function admittedFrom(units: RetrievedTurns): AdmittedEvidence {
  let chars = 0;
  for (const unit of units) chars += unit.length;
  return {
    // Counted the way `toTurns` counts the delivery, so the offer and the delivery
    // are on one unit -- which, for THIS producer, is the line. See `unitsOfTrace`.
    turns: toTurns(units).length,
    // The size the joined form would have had: the units plus the separators between
    // them. Computed rather than joined, because joining builds the whole string.
    chars: chars + Math.max(0, units.length - 1),
  };
}

/**
 * The units of a trace's rendered context, which are **lines**.
 *
 * ## Why this producer's unit is not the turn, stated where it is needed
 *
 * `DecisionTrace.retrieved` is a **rendered string**: `retrieveTurns` composes it from
 * `expandContextWindowBounded`/`BySession`, whose contract is text, and hands the same
 * text to the answer prompt's builder. `respondWith` already records what follows from
 * that -- "`retrieved` has already been through session completion and truncation, so a
 * newline in it is not a turn boundary" -- and it is the reason that method takes an
 * optional `turns` argument for the one reader that needs real units.
 *
 * So this producer cannot report turns and does not pretend to: its units are the lines
 * of the rendered context, which is the unit the records of this product have always
 * carried. Repairing it means giving the trace its own turn list, which reaches
 * `retrieveTurns`' two prompt consumers rather than this arm's capture -- a separate
 * change, registered rather than folded in here.
 *
 * Split rather than wrapped in a one-element list, because a single unit cannot be
 * clustered and `computeTargetCohort` would then classify every question `unseparable`
 * -- a silent regression in the B7 criterion rather than in a count.
 */
function unitsOfTrace(trace: RecordableTrace | undefined): RetrievedTurns {
  return trace?.retrieved === undefined ? [] : trace.retrieved.split('\n');
}

/** The question ids of a record set, in record order, for vector comparison. */
export function recordIds(records: readonly QuestionRecord[]): string[] {
  return records.map((record) => record.questionId);
}

/**
 * What an evidence bound did to a record set.
 *
 * Present only when something was actually dropped -- see
 * {@link evidenceReductionOf} for why absence is `null` rather than zeros.
 */
export type EvidenceReduction = {
  /** Ids of the records whose `turns` ends with a reduction marker. */
  readonly reducedQuestionIds: readonly string[];
  /** The number of turns actually carried across all records, after the bound. */
  readonly turnsCarried: number;
  /**
   * The number of turns measured across all records, before the bound.
   *
   * The bound's own pre-image, read from the markers. It is **not**
   * `sum(evidenceTurns)`, which is the offer: a record can be bounded without the
   * budget touching it and budgeted without the bound noticing, and the two numbers
   * answer different questions.
   */
  readonly turnsMeasured: number;
  /**
   * The characters of evidence **offered** across all records.
   *
   * The offer and not the bound's pre-image, because the bound does not report
   * characters: a marker names turns. Stated here rather than left to a reader to
   * infer, since the field sits beside a turn count that is on the other axis.
   */
  readonly charsMeasured: number;
  /**
   * The real turns the bound dropped across all records.
   *
   * Reported directly rather than left as `turnsMeasured - turnsCarried`, which is
   * what it used to be and which stopped being true when `turnsMeasured` became the
   * bound's pre-image and `turnsCarried` stopped counting the markers.
   */
  readonly droppedTurns: number;
  /** The largest number of real turns any reduced record carries. */
  readonly maxTurnsPerRecord: number;
};

/**
 * The minimum a question must expose for a record to be built from it.
 *
 * Stated structurally rather than importing `Question`, so this module does not
 * depend on the dataset type: the same builder serves LongMemEval instances and
 * synthetic datasets, and a caller that has only a question id and a gold is not
 * forced to fabricate the rest.
 */
export type RecordableQuestion = {
  readonly id: string;
  readonly question: string;
  readonly capability: string;
  /** `null` is the dataset's "no answer" gold, a real value and not an absence. */
  readonly expected: string | null;
  /**
   * The dataset's gold turns, when it names them. Optional because most datasets do
   * not, and absent then -- which is what makes `goldOverlap` absent rather than
   * zero on those datasets.
   */
  readonly goldTurns?: readonly string[] | undefined;
};

/**
 * What one question's decision trace contributes to its record.
 *
 * A structural subset of `DecisionTrace` on purpose. `question-record.ts` must
 * not import `natural-language-memory.ts`: that module is a system
 * implementation, this one is artefact assembly, and depending on it would make
 * the record shape track the one system that currently produces traces.
 */
export type RecordableTrace = {
  readonly question: string;
  /** Context injected into the LLM; empty or absent when the reader abstained. */
  readonly retrieved?: string | undefined;
  readonly answer?: string | number | null | undefined;
  /** Read by the caller's groundedness classifier, not by this module. */
  readonly llmRaw?: string | undefined;
};

/**
 * Assemble per-question records from a dataset, a trace stream and a scorer.
 *
 * The join is by **question text**, which is what `DecisionTrace` carries. Two
 * questions with identical text therefore share a trace, and that is a real
 * limitation rather than an oversight: the alternative is to reconstruct the
 * trace-to-question mapping from call ORDER, which is invisible to this function
 * and silently wrong if any path short-circuits. Text is at least falsifiable --
 * a dataset with a repeated question produces records that obviously share a
 * trace, where an order-based join produces records that look fine and are not.
 *
 * `grounded` is supplied by the caller as a predicate rather than inferred here.
 * Groundedness is a property of the failure classifier, not of the record, and
 * an inlined guess would become a second implementation of it that a dataset
 * change could not break.
 */
export function buildRecordsFromDataset(
  questions: readonly RecordableQuestion[],
  traces: readonly RecordableTrace[],
  correctness: readonly boolean[],
  isGrounded: (input: {
    question: RecordableQuestion;
    trace: RecordableTrace | undefined;
  }) => boolean,
  featureConfig?: FeatureConfig,
): QuestionRecord[] {
  if (correctness.length !== questions.length) {
    throw new Error(
      `correctness vector length ${correctness.length} is not ${questions.length}, the number of questions`,
    );
  }

  // Last trace wins, matching the consumer in `bench/run.ts`, which scans the
  // trace list in reverse. A system may emit more than one trace for a question
  // -- the abstention retry re-queries -- and the LAST one describes the answer
  // that was actually scored.
  const traceByQuestion = new Map<string, RecordableTrace>();
  for (const trace of traces) {
    traceByQuestion.set(trace.question, trace);
  }

  return buildQuestionRecords(
    questions.map((question, i) => {
      const trace = traceByQuestion.get(question.question);
      const units = unitsOfTrace(trace);
      return {
        questionId: question.id,
        question: question.question,
        capability: question.capability,
        groundTruth: question.expected,
        // `answer` is taken from the trace when a trace exists, and left absent
        // when none does. It is NOT defaulted to `null`: `null` means the reader
        // abstained, which is a finding, and a missing trace means nobody
        // recorded what happened, which is a gap. The criterion has a branch for
        // the first and none for the second.
        ...(trace === undefined ? {} : { answer: trace.answer ?? null }),
        correct: correctness[i]!,
        grounded: isGrounded({ question, trace }),
        retrieved: units,
        // This producer reads a trace, and a trace has no budget: what the reader
        // received IS what admission produced. So the offer is counted from the same
        // units, rather than defaulted to zero -- a zero here would report a system
        // that admitted nothing while the record carried evidence.
        admitted: admittedFrom(units),
        // Absent, and absent by necessity rather than by omission since §13.16.6.
        //
        // The gold measurement asks whether a **gold turn** is one of the units the
        // reader received, and this producer's units are lines of a rendered context --
        // so the question it would answer is not the question being asked. It used to be
        // answerable here, by searching the rendered string for the gold text between two
        // newlines, and that search was correct precisely because the gold turn was
        // compared against the whole rendered context rather than against its lines.
        // With the units in hand there is no such haystack, and a line-unit membership
        // test would report a covered gold as uncovered whenever the turn spans a line.
        //
        // A wrong number is worse than an absent one -- that is `§13.11.2`'s rule -- so
        // this reports nothing rather than a measured-looking zero. Both readers of this
        // product (`read-b7-criterion.mjs`, `quantify-endpoint-noise.mjs`) forward the
        // field and neither decides anything with it; the B7 criterion clusters over
        // `turns`. Restoring it means giving the trace the turn list `respondWith`
        // already receives, which is registered separately.
        goldOverlap: null,
      };
    }),
    featureConfig,
  );
}
