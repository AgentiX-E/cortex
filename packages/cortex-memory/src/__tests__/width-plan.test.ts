/**
 * The evidence budget is per question, because a width is not a depth either.
 *
 * ## What these tests are about
 *
 * `maxPromptCharsByRoute` (§13.302) gives a route one room, so every question on that route is answered
 * with the same width -- and `cost.json` shows what that costs: 9,168 billed tokens per question, 67.3% of
 * it the two load-bearing routes at their full 48,460 characters. `planEvidenceRoom` replaces the route's
 * room with a per-question cut: rank the candidates by relevance, fund the shortest prefix that explains a
 * target share of the relevance mass.
 *
 * No effect can be pinned here -- that needs a dispatch, and `C6`'s negative form is registered in `03`
 * §14.126.2 clause 5. What these tests pin is everything that is a property of the pure function:
 *
 * 1. **The four reasons are four reasons.** `empty`, `unsignalled`, `identity` and `capped` are reachable
 *    and distinguishable, because a reading that cannot tell "the plan did not act" from "the plan acted
 *    and was overruled" cannot attribute anything.
 * 2. **A signal that found nothing cuts nothing.** `unsignalled` is not a zero budget: 29 of the five
 *    hundred abstention questions share no content term with their candidates, and their gold is a
 *    decline. Cutting there would spend the mechanism on the population it knows least about.
 * 3. **The prefix is the short one, and it is measured.** `coveredShare` is what the funded prefix
 *    actually explains, not what was asked for, and `turnsKept` says how many turns that is.
 * 4. **Monotone in coverage.** A higher coverage target cannot fund less, or the option would not be a
 *    knob.
 * 5. **Ties fall back to arrival order.** The relevance signal has no opinion on a tie, and the pipeline's
 *    only other rule is arrival.
 * 6. **The floor and the margin are both real.** A cut below `floorChars` is raised to it, and the
 *    estimate is inflated by `renderMargin` so the selector is never handed less room than the plan meant
 *    to grant -- under-estimating is the one error that costs accuracy rather than money.
 */
import { describe, expect, it } from 'vitest';
import { planEvidenceRoom, type WidthPlanOptions } from '../width.js';

const OPTIONS: WidthPlanOptions = { coverage: 0.9, floorChars: 0, renderMargin: 1 };

/** A turn long enough to be worth measuring, carrying `terms`. */
function turn(terms: string, padding = 200): string {
  return `${terms}${' '.repeat(padding)}`;
}

describe('planEvidenceRoom', () => {
  it('declines on no candidates, because the empty-evidence prompt is already the answer', () => {
    expect(planEvidenceRoom('how many shoes', [], OPTIONS)).toEqual({ reason: 'empty' });
  });

  it('declines at coverage 1, which is the identity by definition', () => {
    const turns = [turn('shoes'), turn('parcel')];
    expect(planEvidenceRoom('how many shoes', turns, { ...OPTIONS, coverage: 1 })).toEqual({
      reason: 'identity',
    });
  });

  it('declines when the question shares no content term with any candidate', () => {
    // Both candidates are long and neither mentions the question's subject, so every score is 0 and the
    // total is 0. A plan that cut here would delete the only evidence the question has -- and on the
    // abstention route that is the whole population whose gold is a decline.
    const turns = [turn('parcel arrived'), turn('refund issued')];
    expect(planEvidenceRoom('grandma age', turns, OPTIONS)).toEqual({ reason: 'unsignalled' });
  });

  it('cuts to the prefix that explains the target share, and measures what it explains', () => {
    // `shoes` appears in one candidate, `packed` in another, `shoes packed` in the third. The question
    // asks both, so the third scores highest; ranking by score and funding 90% of the mass lands on that
    // one turn near the top and reports it.
    const turns = [
      turn('unrelated text'),
      turn('shoes were bought'),
      turn('shoes packed and ready'),
    ];
    const decided = planEvidenceRoom('how many shoes were packed', turns, OPTIONS);
    expect(decided.reason).toBe('capped');
    expect(decided.plan?.turnsConsidered).toBe(3);
    expect(decided.plan?.turnsKept).toBeGreaterThanOrEqual(1);
    expect(decided.plan?.turnsKept).toBeLessThanOrEqual(3);
    expect(decided.plan?.coveredShare).toBeGreaterThanOrEqual(0.9);
    expect(decided.plan?.evidenceChars).toBeGreaterThan(0);
  });

  it('funds exactly the turns whose characters it reports', () => {
    const turns = [turn('shoes packed', 1_000), turn('parcel', 1_000), turn('refund', 1_000)];
    const decided = planEvidenceRoom('shoes packed', turns, { ...OPTIONS, coverage: 0.5 });
    expect(decided.reason).toBe('capped');
    // 90% of the mass sits in the first turn, so 50% is also satisfied by it: one turn, 1,014 characters.
    expect(decided.plan?.turnsKept).toBe(1);
    expect(decided.plan?.evidenceChars).toBe(turns[0]!.length);
  });

  it('is monotone in coverage, because the option would not be a knob otherwise', () => {
    const turns = [
      turn('shoes packed', 500),
      turn('shoes bought', 500),
      turn('parcel arrived', 500),
      turn('refund issued', 500),
    ];
    const budget = (coverage: number): number => {
      const decided = planEvidenceRoom('how many shoes packed', turns, { ...OPTIONS, coverage });
      return decided.plan?.evidenceChars ?? Number.MAX_SAFE_INTEGER;
    };
    const reads = [0.1, 0.3, 0.5, 0.7, 0.9].map(budget);
    for (let index = 1; index < reads.length; index += 1) {
      expect(reads[index]!).toBeGreaterThanOrEqual(reads[index - 1]!);
    }
  });

  it('breaks a tie by arrival order, because the signal has no opinion there', () => {
    // Both candidates contain `parcel` and nothing else the question names, so they score the same. The
    // funded prefix is then the earlier one, which is the only rule the rest of the pipeline has.
    const early = `${'parcel '.repeat(20)}first`;
    const late = `${'parcel '.repeat(20)}second`;
    const decided = planEvidenceRoom('parcel', [early, late], { ...OPTIONS, coverage: 0.5 });
    expect(decided.plan?.turnsKept).toBe(1);
    expect(decided.plan?.evidenceChars).toBe(early.length);
  });

  it('raises a cut to the floor, so the reading measures evidence rather than a broken prompt', () => {
    const turns = [turn('shoes', 100), turn('parcel', 4_000)];
    const decided = planEvidenceRoom('shoes', turns, {
      ...OPTIONS,
      coverage: 0.5,
      floorChars: 3_000,
    });
    expect(decided.reason).toBe('capped');
    expect(decided.plan?.evidenceChars).toBe(3_000);
  });

  it('inflates the estimate by the margin, so the selector is never under-funded', () => {
    const turns = [turn('shoes', 1_000), turn('parcel', 1_000)];
    const plain = planEvidenceRoom('shoes', turns, { ...OPTIONS, coverage: 0.5, renderMargin: 1 });
    const padded = planEvidenceRoom('shoes', turns, {
      ...OPTIONS,
      coverage: 0.5,
      renderMargin: 1.5,
    });
    expect(padded.plan?.evidenceChars).toBe(Math.ceil(turns[0]!.length * 1.5));
    expect(padded.plan?.evidenceChars).toBeGreaterThan(plain.plan!.evidenceChars);
  });

  it('declines when the prefix already covers every candidate', () => {
    // One candidate, and the question names it: the prefix is the whole set, so a cap would remove nothing
    // and reporting one would claim a change the prompt does not have.
    const turns = [turn('shoes packed', 300)];
    expect(planEvidenceRoom('shoes packed', turns, OPTIONS)).toEqual({ reason: 'identity' });
  });

  it('declines when the margin makes the whole set smaller than the floor', () => {
    // A floor above the entire candidate set is a floor that never binds, and the plan must say so rather
    // than report a cap of `floorChars` on a prompt that carries everything.
    const turns = [turn('shoes', 10), turn('parcel', 10)];
    const decided = planEvidenceRoom('shoes', turns, {
      ...OPTIONS,
      coverage: 0.5,
      floorChars: 9_000,
    });
    expect(decided).toEqual({ reason: 'identity' });
  });

  it('treats coverage 0 as the shortest non-empty prefix rather than as no evidence', () => {
    // 0 is a value a sweep will produce, and the degenerate reading -- a budget of zero, an empty evidence
    // block -- is a different experiment from "the single best turn". `fitToBudget` would assemble the
    // former without complaint, so the distinction has to be made here.
    const turns = [turn('shoes packed', 400), turn('parcel', 400)];
    const decided = planEvidenceRoom('shoes packed', turns, {
      ...OPTIONS,
      coverage: 0,
      floorChars: 0,
    });
    expect(decided.reason).toBe('capped');
    expect(decided.plan?.turnsKept).toBe(1);
    expect(decided.plan?.coveredShare).toBeGreaterThan(0);
  });
});
