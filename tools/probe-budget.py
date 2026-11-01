#!/usr/bin/env python3
"""A deployment may be classified instead of measured, and this prices that substitution.

## The question

`AUDIT-MODEL-PORTABILITY.md` claims a product running on a reader its authors never measured can be
made safe **without** the operator running a benchmark first. The claim is worth what its arithmetic
is worth, because "we classify instead of measure" is either a budget or a wish:

- a **benchmark** answers "how good is this reader on questions whose answers we hold", costs
  `questions x runs` calls, and needs ground truth;
- a **probe set** answers "does this reader emit what the parser can read", costs `probes x repeats`
  calls, and needs **no** ground truth.

The two are not on the same axis, and the only thing that makes the second acceptable is that it is
two orders of magnitude cheaper. This tool prints that number instead of asserting it.

## The arithmetic

One must-pass probe, repeated `r` times at an odd count, is read as failed when the majority of
repeats fails. With per-call flip probability `e`:

    q(r, e) = P(Binom(r, e) > r/2)

A report of `m` must-pass probes is read as *passing* when every one of them passed, so its
false-pass probability is

    Q(m, r, e) = 1 - (1 - q(r, e))^m

Only **odd** `r` is accepted. An even count has a tie, and a tie needs a third convention (round up?
round down?) that would silently become part of the classifier's definition. §13.194.4 measured
`e` at 4.8% on 470 byte-identical prompts; that is the only figure in this repository that is
directly the quantity above, which is why it is the default.

## The part that is not arithmetic, and must not be faked

Classifying is only worth its cost if the buckets are **further apart than the readers inside
them**. Two readers in one bucket differ by `within`; two readers in adjacent buckets differ by
`between`. If `within >= between`, a bucket label says nothing a coin flip would not, and the whole
design collapses to "publish the capability contract and refuse the reader".

That comparison is a **measurement this repository does not have** -- every reading it holds is on
one provider. So it is an input, the tool refuses to invent it, and `--between` without `--within`
is an error rather than a default. A tool that supplied 0 would report every classifier as
separated, which is the decorative-check failure `search-budget.py` was rewritten to avoid.

## The net gain, which is the quantity a product decision turns on

    no classifier      expected loss = between
    classifier         expected loss = Q*between + (1-Q)*residual

where `residual` is what a reader still loses after the guard's configuration is applied, and `Q` is
the false-pass probability above. The classifier is worth shipping exactly when

    (1 - Q) * (between - residual) > 0

which is why `--residual` is what turns this from a note into a verdict. A classifier with a perfect
`Q` and no residual improvement is pure cost.
"""

from __future__ import annotations

import argparse
import math
import sys


def p_majority_wrong(repeats: int, flip: float) -> float:
    """Probability that an odd number of repeats votes the probe wrong, given a per-call flip rate.

    Exact binomial, not a normal approximation. At `r = 3, e = 0.048` the exact answer is
    0.0066908, against 0.048 for a single call -- a factor of 7.2. A normal approximation in this
    tail is off by an order of magnitude, and it errs optimistic, which is the direction that ships
    an under-probed reader.
    """
    if repeats < 1:
        raise ValueError('repeats must be at least 1')
    if repeats % 2 == 0:
        raise ValueError(
            f'repeats must be odd, got {repeats}: an even count has a tie, and a tie needs a '
            'rounding convention that would become part of the classifier without being stated'
        )
    if not 0.0 <= flip <= 1.0:
        raise ValueError(f'flip must be in [0, 1], got {flip}')
    need = repeats // 2 + 1
    return sum(
        math.comb(repeats, k) * flip**k * (1.0 - flip) ** (repeats - k)
        for k in range(need, repeats + 1)
    )


def report_false_pass(probes: int, repeats: int, flip: float) -> float:
    """Probability that a report of `probes` must-pass probes passes while at least one failed."""
    if probes < 1:
        raise ValueError('probes must be at least 1')
    q = p_majority_wrong(repeats, flip)
    return 1.0 - (1.0 - q) ** probes


def repetitions_for(target: float, probes: int, flip: float, cap: int = 61) -> int | None:
    """The smallest odd repeat count whose report false-pass rate is at most `target`."""
    if not 0.0 < target < 1.0:
        raise ValueError(f'target must be in (0, 1), got {target}')
    for repeats in range(1, cap + 1, 2):
        if report_false_pass(probes, repeats, flip) <= target:
            return repeats
    return None


def separation(between: float, within: float) -> dict:
    """Whether adjacent buckets are further apart than the readers inside one bucket.

    `between` and `within` are both in **questions of a 500-question roster**, because that is the
    unit every published reading in this repository is on. Reporting the ratio as well as the verdict
    is deliberate: a ratio of 1.05 is a pass that no one should ship on, and a bare boolean would
    present it as the same result as 4.0.
    """
    if between <= 0:
        raise ValueError(f'between must be positive, got {between}')
    if within < 0:
        raise ValueError(f'within must be non-negative, got {within}')
    ratio = within / between
    return {
        'separated': between > within,
        'ratio': ratio,
        'between': between,
        'within': within,
    }


def net_gain(between: float, residual: float, false_pass: float) -> dict:
    """Expected improvement from classifying, in questions, against not classifying at all."""
    if false_pass < 0.0 or false_pass > 1.0:
        raise ValueError(f'false_pass must be in [0, 1], got {false_pass}')
    if residual < 0:
        raise ValueError(f'residual must be non-negative, got {residual}')
    if residual > between:
        # Not an error in the arithmetic, but it means the guarded row is *worse* than doing nothing,
        # which would make the matrix a net harm. Refused rather than printed as a negative gain,
        # because a negative gain here is a defect in the matrix and not a finding about a reader.
        raise ValueError(
            f'residual ({residual}) exceeds between ({between}): the guarded row would have to be '
            'worse than the unguarded one, which is a defect in the matrix rather than a property '
            'of a reader'
        )
    gain = (1.0 - false_pass) * (between - residual)
    return {
        'worth_it': gain > 0.0,
        'gain': gain,
        'false_pass': false_pass,
        'between': between,
        'residual': residual,
    }


def render_budget(probes: int, repeats: int | None, flip: float, target: float) -> str:
    """The probe budget, or the inverse when no repeat count reaches the target."""
    if repeats is None:
        # The inverse is what a refusal owes the reader: the smallest target this probe set can
        # reach at all, which at r = cap is the floor.
        floor = report_false_pass(probes, 61, flip)
        return (
            f'no odd repeat count up to 61 reaches {target:.4f} over {probes} must-pass probes at a '
            f'per-call flip rate of {flip:.4f}.\n'
            f'  the floor at 61 repeats is {floor:.6f}, so the target would have to be at least that\n'
            f'  or the reader would have to be more stable, or the must-pass set smaller'
        )
    q = p_majority_wrong(repeats, flip)
    calls = probes * repeats
    return (
        f'{repeats} repeats x {probes} must-pass probes = {calls} calls\n'
        f'  per-probe error   {q:.6f}\n'
        f'  report false-pass {report_false_pass(probes, repeats, flip):.6f}  (target {target:.4f})\n'
        f'  a benchmark of the same roster would be 500 x 4 = 2000 calls and would need ground truth'
    )


def render_separation(result: dict) -> str:
    verdict = 'separated' if result['separated'] else 'NOT separated'
    lines = [
        f'{verdict}: between {result["between"]:g} questions, within {result["within"]:g}, '
        f'ratio {result["ratio"]:.2f}'
    ]
    if not result['separated']:
        lines.append(
            '  the buckets are closer together than the readers inside them, so a bucket label '
            'carries no information a coin flip would not: publish the capability contract and '
            'refuse the reader instead of configuring it'
        )
    elif result['ratio'] > 0.75:
        lines.append(
            '  passes, but the margin is thin: at this ratio a misclassified reader lands in a '
            'bucket it is not worse than, and the matrix stops being an improvement'
        )
    return '\n'.join(lines)


def render_gain(result: dict) -> str:
    head = 'worth shipping' if result['worth_it'] else 'not worth shipping'
    return (
        f'{head}: {result["gain"]:.3f} questions per 500-question roster\n'
        f'  false-pass {result["false_pass"]:.6f}, between {result["between"]:g}, '
        f'residual {result["residual"]:g}'
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description='Price a probe-based classification against measuring the reader.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument('--probes', type=int, help='must-pass probes in the set')
    parser.add_argument(
        '--flip',
        type=float,
        default=0.048,
        help='per-call decision flip rate; default 0.048 from §13.194.4 (470 identical prompts)',
    )
    parser.add_argument('--target', type=float, default=0.02, help='acceptable report false-pass rate')
    parser.add_argument('--between', type=float, help='gap between adjacent buckets, in questions')
    parser.add_argument('--within', type=float, help='spread inside one bucket, in questions')
    parser.add_argument('--residual', type=float, help='loss remaining after the guarded row is applied')
    args = parser.parse_args(argv)

    try:
        if args.between is not None and args.within is None:
            raise ValueError(
                '--between requires --within: without a spread inside a bucket there is nothing to '
                'separate, and a default of 0 would report every classifier as separated'
            )
        if args.between is not None and args.probes is None:
            raise ValueError(
                '--between requires --probes: a separation with no probe budget is a claim about a '
                'classifier that has not been priced'
            )
        if args.probes is None:
            raise ValueError('--probes is required')

        repeats = repetitions_for(args.target, args.probes, args.flip)
        print(render_budget(args.probes, repeats, args.flip, args.target))

        if args.between is not None:
            split = separation(args.between, args.within)
            print(render_separation(split))
            if args.residual is not None:
                if repeats is None:
                    # Without a repeat count there is no false-pass rate to charge, and charging 0
                    # would print a gain the classifier cannot deliver.
                    raise ValueError(
                        'cannot price the classifier: no repeat count reaches the target, so its '
                        'false-pass rate is unbounded and any gain printed here would be fiction'
                    )
                gain = net_gain(
                    args.between, args.residual, report_false_pass(args.probes, repeats, args.flip)
                )
                print(render_gain(gain))
                if not (split['separated'] and gain['worth_it']):
                    return 1
            elif not split['separated']:
                return 1

        return 0 if repeats is not None else 1
    except ValueError as error:
        print(f'refused: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
