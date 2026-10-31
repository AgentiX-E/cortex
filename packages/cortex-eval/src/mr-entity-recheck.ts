/**
 * Turn the judge audit's *rate* into a per-question *screen*, without spending a call.
 *
 * ## The gap this closes
 *
 * `§13.184` measured the judge accepting **19.38%** of answers that were wrong by construction, and
 * split it three ways: `entity-swap` **44.90%**, `number-swap` **14.75%**, `cross-gold` **0/50**. The
 * reading is a rate over 160 sampled accepted answers. What the campaign needs is a different
 * quantity: of the 84 MR questions the judge called correct in round one, **how many answers name
 * something the gold does not name at all?**
 *
 * That question does not need a model. If the judge ignores which names an answer states — which is
 * what 44.90% on `entity-swap` versus 14.75% on `number-swap` says — then an answer whose names are
 * **disjoint** from the gold's names is an answer the audit says the judge would have accepted anyway,
 * and the artifact already contains the text needed to find it. So this screen runs on the artifact,
 * deterministically, and every row it flags can be read by a person.
 *
 * ## The four relations, and why two of them are not verdicts
 *
 * | relation | test | what it licenses |
 * | --- | --- | --- |
 * | `shared-name` | the answer names at least one name the gold names | nothing; the screen is silent |
 * | `names-disjoint` | both sides name something, and nothing in common | a **candidate** false accept |
 * | `unnamed-gold` | the gold names nothing (`18 days`, `3`) | nothing; the screen cannot reach it |
 * | `unnamed-answer` | the gold names something, the answer names nothing (`2`) | nothing, and that is a limit |
 *
 * `unnamed-answer` is the one that would be tempting to fold in and must not be. A gold like
 * `"Alice and Bob"` with the answer `"2 people"` is a *correct* answer with no names in it — and a gold
 * like `"Alice and Bob"` with the answer `"3 people"` is a wrong one that this screen cannot see. The
 * two are the same row here. Folding them in would buy a bigger number and measure nothing, so the
 * count is published separately and the candidate count is stated as a **lower bound**.
 *
 * ## Why names and not numbers
 *
 * The audit's own split is the reason. A judge that checked numbers would have caught `number-swap`
 * more often than `entity-swap`; it caught it three times less often. So the channel this screen
 * exercises — which name appears — is the channel measured to be open, and a screen on it is the one
 * that can move the reading. Screening numbers would be measuring the judge's strongest axis.
 *
 * ## The control that keeps the number from being self-congratulation
 *
 * The same screen runs over the answers the judge **rejected**. Those are wrong by the judge's own
 * verdict, so if the screen fires at the same rate on both populations it is detecting something other
 * than wrongness, and the candidate count means nothing. The comparison is published with the count
 * rather than after it. It is not a proof either way — a rejected answer can be wrong by omission and
 * land in `unnamed-answer` — so it is read as a discrimination check, not as a calibration.
 *
 * ## One definition of "a name"
 *
 * `entitiesIn` is imported from the audit rather than re-implemented, so the pool `entity-swap` draws
 * from and the set this screen compares are the same set. Two definitions of "a name" is how the rate
 * and the screen would come to describe different things while sharing a paragraph.
 */

import { entitiesIn } from './judge-audit.js';

/** What the screen found between an answer's names and its gold's names. */
type NameRelation = 'shared-name' | 'names-disjoint' | 'unnamed-gold' | 'unnamed-answer';

/** One graded answer, as the artifact records it. */
type ScreenSource = {
  readonly questionId: string;
  readonly gold: string;
  readonly answer: string;
  /** `MR`, `TR`, `IE`, … when the artifact records one. Carried through so the tool can group. */
  readonly capability?: string;
  /** What the judge said when the artifact was produced, not what this screen thinks. */
  readonly accepted: boolean;
};

/** One screened answer, with both name sets printed so a reader can audit the predicate itself. */
type ScreenRow = {
  readonly questionId: string;
  readonly capability: string;
  readonly accepted: boolean;
  readonly relation: NameRelation;
  readonly goldNames: readonly string[];
  readonly answerNames: readonly string[];
  readonly sharedNames: readonly string[];
};

/** How the rows of one population fell across the four relations. */
type ScreenTally = Readonly<Record<NameRelation, number>> & { readonly total: number };

/** The reading: both populations tallied, the candidates listed, and the screen's own reach. */
type ScreenReading = {
  readonly rows: readonly ScreenRow[];
  /** Answers the judge accepted — the population a false accept can live in. */
  readonly accepted: ScreenTally;
  /** Answers the judge rejected — the discrimination control. */
  readonly rejected: ScreenTally;
  /** Accepted rows with `names-disjoint`. This is a lower bound on false accepts, never an estimate. */
  readonly candidates: readonly ScreenRow[];
  /**
   * Accepted rows whose gold names anything. The prediction can only be about these: a row the screen
   * cannot reach is not a row the screen cleared, and reporting the candidate rate over all accepted
   * rows would silently price blindness as accuracy.
   */
  readonly reachable: number;
};

/** Case-folding, so `alice` in an answer matches `Alice` in the gold. */
function key(name: string): string {
  return name.toLowerCase();
}

/**
 * Does the answer state this gold name, whatever case it was typed in?
 *
 * `entitiesIn` only sees a capitalised word, and an answer is free to write the name in lower case
 * (`rachel.`) or in full capitals (`RACHEL`, which is not `[A-Z][a-z]{2,}` at all). Both were measured
 * on real artifacts, and both would have been counted as "the answer names nothing" — a direction that
 * cannot produce a false candidate but would have shrunk the `shared-name` side of the control and made
 * the screen look more discriminating than it is.
 */
function states(answer: string, name: string): boolean {
  return new RegExp(
    `(^|[^A-Za-z0-9])${key(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`,
    'i',
  ).test(answer);
}

function relationOf(
  goldNames: readonly string[],
  answerNames: readonly string[],
  sharedNames: readonly string[],
): NameRelation {
  if (goldNames.length === 0) return 'unnamed-gold';
  if (sharedNames.length > 0) return 'shared-name';
  if (answerNames.length === 0) return 'unnamed-answer';
  return 'names-disjoint';
}

function emptyTally(): Record<NameRelation, number> & { total: number } {
  return {
    total: 0,
    'shared-name': 0,
    'names-disjoint': 0,
    'unnamed-gold': 0,
    'unnamed-answer': 0,
  };
}

/**
 * Screen every answer in `sources` for the failure the audit measured.
 *
 * Pure and order-preserving: the rows come back in input order so two artifacts can be diffed, and no
 * step depends on `Math.random` or on set iteration order.
 */
export function nameScreen(sources: readonly ScreenSource[]): ScreenReading {
  const rows: ScreenRow[] = [];
  const accepted = emptyTally();
  const rejected = emptyTally();

  for (const source of sources) {
    const goldNames = entitiesIn(source.gold);
    const answerNames = entitiesIn(source.answer);
    // The answer's own extracted names miss the two forms it can legitimately write a name in —
    // lower case, and all capitals — so the shared set is computed by searching the answer's text for
    // each gold name rather than by intersecting two independently extracted sets.
    const sharedNames = goldNames.filter((name) => states(source.answer, name));
    const relation = relationOf(goldNames, answerNames, sharedNames);
    rows.push({
      questionId: source.questionId,
      capability: source.capability ?? '',
      accepted: source.accepted,
      relation,
      goldNames,
      answerNames,
      sharedNames,
    });
    const tally = source.accepted ? accepted : rejected;
    tally[relation] += 1;
    tally.total += 1;
  }

  return {
    rows,
    accepted,
    rejected,
    candidates: rows.filter((row) => row.accepted && row.relation === 'names-disjoint'),
    reachable: rows.filter((row) => row.accepted && row.goldNames.length > 0).length,
  };
}
