/**
 * How close a turn's date is to the question's, as a number a ranking can use.
 *
 * ## Why a decay and not the buckets the plan named
 *
 * `docs/PLAN-RETRIEVAL-SIGNALS.md` §3 registered S-1 as "bucket the distance". Buckets are one constant and
 * an if-chain, which is why they were the first sketch, but they are discontinuous: 1 day and 2 days score
 * the same while 29 and 31 do not, so two turns that are three days apart can swap order across a boundary
 * while two that are two days apart cannot. A ranking that is stable inside a bucket and arbitrary at its
 * edges is describing its own thresholds rather than the corpus.
 *
 * `0.5 ** (days / half-life)` is the same idea with one constant instead of a table, monotone everywhere, and
 * it has a name a reader already knows. `TEMPORAL_HALF_LIFE_DAYS` is exported so a run can state what it
 * used, and the day-to-score relation is a property rather than a literal.
 *
 * ## Why distance and not direction
 *
 * A turn before the question and a turn after it are equally far. Asymmetric decay would encode "older is
 * worse" as well as "further is worse" — two claims in one signal, and LongMemEval's temporal questions ask
 * in both directions ("how many days between X and Y" has no preferred order).
 *
 * ## Why an undated turn scores zero rather than low
 *
 * Zero is "this contributes nothing", which leaves the turn exactly where the semantic signal put it. A low
 * score would be a penalty for a property of the *corpus* rather than of the evidence, and on any corpus
 * where some sessions carry no date it would systematically demote all of them. That is a selection bias
 * that reads as a finding.
 *
 * ## What this module does not do
 *
 * ## Why one export
 *
 * `temporalBoosts` is the whole surface, and `export-census.mjs` is why: the first draft exported the decay
 * function, the half-life and the input type, and all three came back as orphans — a name with no caller is
 * a name no test can keep honest at the level it claims, and the census treats a test reference as none. So
 * the decay is checked through `affinityFor`, which is the answer the ranking actually consumes, and a
 * constant nobody outside can change does not need to be public to be observable.
 *
 * It does not decide the weight, and it does not touch the ranking. `relevance-index.ts` adds
 * `weight * affinity` to the cosine it already holds, with a weight that defaults to zero — so the shipped
 * configuration is byte-identical to the one every archived artifact was produced with, and S-1 is a
 * single-variable dispatch or it is nothing.
 */

/** The distance at which a turn's contribution halves. The signal's only constant. */
const TEMPORAL_HALF_LIFE_DAYS = 30;

const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * `0.5 ** (|turn − question| / half-life)`, or zero when either instant is unusable.
 *
 * Total rather than throwing: the index asks this about every admitted turn, and a missing date is the
 * state every archived run is in. A non-finite instant is refused rather than propagated because `NaN`
 * compares false against everything and would make a turn's position depend on the sort implementation.
 */
function temporalAffinity(turnAt: unknown, askedAt: unknown): number {
  if (!isInstant(turnAt) || !isInstant(askedAt)) return 0;
  const days = Math.abs(turnAt - askedAt) / MILLISECONDS_PER_DAY;
  // Clamped because `0.5 ** huge` underflows to 0 and `0.5 ** 0` is exactly 1; the bounds are stated so a
  // future change to the formula cannot quietly return something a cosine comparison would misread.
  return Math.min(1, Math.max(0, 0.5 ** (days / TEMPORAL_HALF_LIFE_DAYS)));
}

function isInstant(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** One question's context, the instant each turn happened, and when the question was asked. */
type TemporalBoostInput = {
  readonly context: readonly string[];
  /**
   * Parallel to `context`, or absent.
   *
   * Absent is the state every archived run is in and means the signal is inert. A **longer** array is an
   * error rather than something to truncate: it means the caller handed over dates flattened from a
   * different corpus, and silently taking the prefix would score one turn with another's instant.
   */
  readonly turnDates?: readonly (number | null | undefined)[] | undefined;
  readonly askedAt?: number | null | undefined;
};

/**
 * The affinity of each turn text, plus the census that says whether the signal reached anything.
 *
 * `scored` and `total` are both in the **text** domain, because `affinityFor` is keyed by text: two
 * positions holding one text is one answer, and counting positions would overstate the reach on exactly the
 * corpora where turns repeat. `scored: 0` is the value that distinguishes "the pass fired on nothing" from
 * "the pass was never wired", which is the distinction this repository has paid for twice.
 */
type TemporalBoosts = {
  affinityFor(turn: string): number;
  /** Distinct turn texts the signal could place in time. */
  readonly scored: number;
  /** Distinct turn texts looked at. */
  readonly total: number;
};

export function temporalBoosts(input: TemporalBoostInput): TemporalBoosts {
  const { context, turnDates, askedAt } = input;
  if (turnDates !== undefined && turnDates.length > context.length) {
    throw new RangeError(
      `turnDates length ${String(turnDates.length)} exceeds context length ${String(context.length)}; ` +
        'a longer array means two corpora were flattened together and a prefix would score the wrong turn',
    );
  }

  // Best affinity per distinct text. A repeated text keeps the instant that makes it most relevant, because
  // the signal is a property of the text as the reader will see it and the lookup cannot tell the two
  // occurrences apart -- `session-relevance.ts` resolved the same collision by taking the best-ranked
  // session.
  const best = new Map<string, number>();
  for (const [position, turn] of context.entries()) {
    const affinity = temporalAffinity(turnDates?.[position], askedAt);
    const previous = best.get(turn);
    if (previous === undefined || affinity > previous) best.set(turn, affinity);
  }

  let scored = 0;
  for (const affinity of best.values()) if (affinity > 0) scored += 1;

  return {
    affinityFor(turn: string): number {
      return best.get(turn) ?? 0;
    },
    scored,
    total: best.size,
  };
}
