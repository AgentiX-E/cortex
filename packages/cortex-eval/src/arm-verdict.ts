/**
 * The verdict on one arm, computed once, from the two artifacts' own masks.
 *
 * ## Why this exists
 *
 * Two administrations of the `conflicts` block were read by hand, and the pair produced three
 * defects that a single implementation would have refused:
 *
 * 1. `§13.353.4` compared the treatment arm's `baseline` line against the **control arm's** best
 *    repetition and called the difference a harness defect. The reference pipeline scores 0 of 72
 *    on `KU` in the archived full-file run as well; the comparison named two different systems.
 * 2. `§13.353.3` wrote its bar over "the 65 questions the control answers in every repetition".
 *    Sixty-five is `featureByCapability.KU.max` — the control's **best** repetition — and the
 *    every-repetition count is a per-question predicate only the masks can answer, which is 62.
 *    The bar is evaluated on the population it named in one case and on the population it has in
 *    the other, and the falsifier's verdict differs between them.
 * 3. Both readings were arithmetic typed into a document, so neither could be re-run.
 *
 * Both are `armVerdict`'s refusals rather than its results: `question-sets-differ` refuses the first
 * shape at its source (two artifacts over different populations are not a pair), and the
 * control-perfect set is enumerated from `correctByRun` masks only — there is no field on
 * {@link ArmQuestionReading} that a `perCapability` aggregate could be passed as.
 *
 * ## What it computes, and in what order
 *
 * The masks are strings of `0`/`1`, one character per repetition, in the artifact's own question
 * order — the shape `ablation.featureCorrectByRun` and `ablation.baselineCorrectByRun` already
 * carry. Everything else is arithmetic over those characters:
 *
 * - **cells** are (question, repetition) pairs, and `improvedCells`/`worsenedCells` are the two
 *   discordant counts. The repetition-level McNemar p-value is computed on them.
 * - **conversions** are questions the control never gets and the arm gets at least once;
 *   **regressions** are questions where the arm passes strictly fewer repetitions. A question that
 *   passes the same number in different repetitions is in neither list — a reshuffle is not a move,
 *   and the two cell counts still see it.
 * - **control-perfect** is `controlPasses === repetitions`, per question. `controlPerfectRegressions`
 *   is the falsifier's population, ordered by repetitions lost and then by id.
 * - the **question-level sign test** is on questions up against questions down, and it is reported
 *   beside the repetition-level one because they answer different questions: the first refuses a
 *   direction, the second can be significant on magnitude alone.
 *
 * ## Why a refusal rather than a warning
 *
 * `efficiency-frontier.mjs` exits 2 on unequal repetitions because a bill read across unequal
 * repetition counts is `runs` wearing a cost's name (`§13.313`). The same discipline applies here:
 * an inadmissible pair returns `comparable: false` with an empty result set, not a number with a
 * footnote. The one refusal that is opt-in is `evidence-not-identical`, because a mechanism that
 * changes retrieval is *supposed* to change the evidence; it is a precondition only for mechanisms
 * like this one, whose entire claim is that they add characters after the budget decided the set.
 */
import { mcnemarPValue } from './metrics.js';

/** One question of one artifact, as a paired reading needs it. */
type ArmQuestionReading = {
  /** The question id both artifacts must agree on. */
  readonly id: string;
  /** `'1'` per repetition the answer was correct, `'0'` per repetition it was not. */
  readonly correctByRun: string;
  /**
   * Characters of delivered evidence, when the artifact records them.
   *
   * Present so that a mechanism which must not move the evidence can be held to it. Absent is not
   * "equal": a caller that asks for identical evidence and gets no widths is refused.
   */
  readonly evidenceChars?: number;
};

/** One artifact's question population. */
type ArmReading = {
  readonly questions: readonly ArmQuestionReading[];
};

/** A registered bar: how many conversions it asks for, and what size of loss falsifies it. */
type ArmBar = {
  /** Conversions required among questions the control never answers correctly. */
  readonly conversions: number;
  /** Repetitions a control-perfect question may lose before the run is falsified. */
  readonly falsifierLoss: number;
};

type ArmRefusal =
  | 'empty-population'
  | 'mask-not-binary'
  | 'mask-length-mismatch'
  | 'question-sets-differ'
  | 'repetitions-differ'
  | 'evidence-not-identical';

/** One question that moved, with both masks so a reader can check the direction by eye. */
type ArmQuestionMove = {
  readonly id: string;
  readonly control: string;
  readonly arm: string;
  readonly controlPasses: number;
  readonly armPasses: number;
  /** Repetitions the arm lost against the control; `0` for a conversion, positive for a regression. */
  readonly lost: number;
};

/** The bar, evaluated. Present only when a bar was given and the pair is admissible. */
type ArmBarResult = {
  readonly conversionsMet: boolean;
  readonly noRegressionMet: boolean;
  readonly falsified: boolean;
  readonly accepted: boolean;
};

type ArmVerdict = {
  readonly comparable: boolean;
  readonly refusals: readonly ArmRefusal[];
  readonly questions: number;
  readonly repetitions: number;
  readonly cells: number;
  readonly controlPasses: number;
  readonly armPasses: number;
  readonly controlRate: number;
  readonly armRate: number;
  /** Points of the (question × repetition) grid the arm moved: `(armRate - controlRate) * 100`. */
  readonly deltaPoints: number;
  readonly improvedCells: number;
  readonly worsenedCells: number;
  /** Exact McNemar, two-sided, on the two discordant cell counts. */
  readonly repetitionP: number;
  readonly conversions: readonly ArmQuestionMove[];
  readonly regressions: readonly ArmQuestionMove[];
  /** Exact sign test, two-sided, on questions up against questions down. */
  readonly questionP: number;
  /** Questions the control answered correctly in every repetition. */
  readonly controlPerfect: number;
  /** The falsifier's population: control-perfect questions the arm lost repetitions on. */
  readonly controlPerfectRegressions: readonly ArmQuestionMove[];
  readonly bar: ArmBarResult | null;
};

type ArmVerdictOptions = {
  /** The registered bar to evaluate. Omitted means the verdict reports and decides nothing. */
  readonly bar?: ArmBar;
  /** Refuse unless every paired question records the same `evidenceChars`. */
  readonly requireIdenticalEvidence?: boolean;
};

const REFUSAL_ORDER: readonly ArmRefusal[] = [
  'empty-population',
  'mask-not-binary',
  'mask-length-mismatch',
  'question-sets-differ',
  'repetitions-differ',
  'evidence-not-identical',
];

const passes = (mask: string): number => {
  let count = 0;
  for (const character of mask) if (character === '1') count += 1;
  return count;
};

const refused = (refusals: readonly ArmRefusal[]): ArmVerdict => ({
  comparable: false,
  refusals: [...refusals].sort(
    (left, right) => REFUSAL_ORDER.indexOf(left) - REFUSAL_ORDER.indexOf(right),
  ),
  questions: 0,
  repetitions: 0,
  cells: 0,
  controlPasses: 0,
  armPasses: 0,
  controlRate: 0,
  armRate: 0,
  deltaPoints: 0,
  improvedCells: 0,
  worsenedCells: 0,
  repetitionP: 1,
  conversions: [],
  regressions: [],
  questionP: 1,
  controlPerfect: 0,
  controlPerfectRegressions: [],
  bar: null,
});

/**
 * Pair two artifacts over the questions they share and report the reading, or refuse.
 *
 * The pairing is by `id` and the output order is the **control's** question order, so two readings
 * of the same control are comparable line for line.
 */
export function armVerdict(
  control: ArmReading,
  arm: ArmReading,
  options: ArmVerdictOptions = {},
): ArmVerdict {
  const refusals = new Set<ArmRefusal>();
  const sides = [control, arm];

  if (sides.some((side) => side.questions.length === 0)) refusals.add('empty-population');
  if (
    sides.some((side) => side.questions.some((question) => /[^01]/.test(question.correctByRun)))
  ) {
    refusals.add('mask-not-binary');
  }
  for (const side of sides) {
    const lengths = new Set(side.questions.map((question) => question.correctByRun.length));
    if (lengths.size > 1) refusals.add('mask-length-mismatch');
  }

  const armById = new Map(arm.questions.map((question) => [question.id, question]));
  const shared = control.questions.filter((question) => armById.has(question.id));
  if (shared.length !== control.questions.length || shared.length !== arm.questions.length) {
    refusals.add('question-sets-differ');
  }

  const controlRuns = control.questions[0]?.correctByRun.length ?? 0;
  const armRuns = arm.questions[0]?.correctByRun.length ?? 0;
  if (controlRuns !== armRuns) refusals.add('repetitions-differ');

  if (options.requireIdenticalEvidence === true) {
    const identical =
      refusals.size === 0 &&
      shared.every((question) => {
        const other = armById.get(question.id);
        return (
          question.evidenceChars !== undefined &&
          other?.evidenceChars !== undefined &&
          question.evidenceChars === other.evidenceChars
        );
      });
    if (!identical) refusals.add('evidence-not-identical');
  }

  if (refusals.size > 0) return refused([...refusals]);

  const repetitions = controlRuns;
  const moves: { move: ArmQuestionMove; up: boolean; down: boolean }[] = [];
  let improvedCells = 0;
  let worsenedCells = 0;
  let controlPasses = 0;
  let armPasses = 0;
  let controlPerfect = 0;

  for (const question of control.questions) {
    const other = armById.get(question.id) as ArmQuestionReading;
    const controlCount = passes(question.correctByRun);
    const armCount = passes(other.correctByRun);
    controlPasses += controlCount;
    armPasses += armCount;
    if (controlCount === repetitions) controlPerfect += 1;
    for (let run = 0; run < repetitions; run += 1) {
      const before = question.correctByRun[run] === '1';
      const after = other.correctByRun[run] === '1';
      if (!before && after) improvedCells += 1;
      if (before && !after) worsenedCells += 1;
    }
    moves.push({
      move: {
        id: question.id,
        control: question.correctByRun,
        arm: other.correctByRun,
        controlPasses: controlCount,
        armPasses: armCount,
        lost: controlCount - armCount,
      },
      up: armCount > controlCount,
      down: armCount < controlCount,
    });
  }

  const cells = control.questions.length * repetitions;
  const controlRate = controlPasses / cells;
  const armRate = armPasses / cells;
  const conversions = moves
    .filter((entry) => entry.move.controlPasses === 0 && entry.move.armPasses > 0)
    .map((entry) => entry.move);
  const regressions = moves.filter((entry) => entry.down).map((entry) => entry.move);
  const controlPerfectRegressions = regressions
    .filter((move) => move.controlPasses === repetitions)
    .sort((left, right) => right.lost - left.lost);

  const bar = options.bar;
  const barResult: ArmBarResult | null =
    bar === undefined
      ? null
      : (() => {
          const conversionsMet = conversions.length >= bar.conversions;
          const noRegressionMet = controlPerfectRegressions.length === 0;
          const falsified = controlPerfectRegressions.some(
            (move) => move.lost >= bar.falsifierLoss,
          );
          return {
            conversionsMet,
            noRegressionMet,
            falsified,
            accepted: conversionsMet && noRegressionMet && !falsified,
          };
        })();

  return {
    comparable: true,
    refusals: [],
    questions: control.questions.length,
    repetitions,
    cells,
    controlPasses,
    armPasses,
    controlRate,
    armRate,
    deltaPoints: (armRate - controlRate) * 100,
    improvedCells,
    worsenedCells,
    repetitionP: mcnemarPValue(improvedCells, worsenedCells),
    conversions,
    regressions,
    questionP: mcnemarPValue(
      moves.filter((entry) => entry.up).length,
      moves.filter((entry) => entry.down).length,
    ),
    controlPerfect,
    controlPerfectRegressions,
    bar: barResult,
  };
}
