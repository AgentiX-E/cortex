#!/usr/bin/env python3
"""A parameter search is readable only when its selection bias is smaller than the effect.

## The question this answers, and why prose could not

A proposal to let prompt wording, few-shot sets or sampling parameters be searched rather than
written comes with a number attached: "the optimizer found +2.8 points". The number is real in the
sense that some configuration scored 2.8 points above the current one. It is not evidence, because
the maximum of `k` noisy readings is above the mean of them by construction, and this arm has
measured how noisy a reading is.

`PREREGISTRATION` §13.118.5 put four repetitions of **one** configuration in one job on one dataset
and got `407, 414.5, 414.5, 423` on a 500-question roster -- a 16-question spread with no treatment
at all. §13.194.4 measured the other end: on 470 questions whose prompt was **byte-identical** to
the control's, 4.8% of verdicts still flipped. So the quantity that decides whether a search is
readable is not the optimizer's reported gain; it is `sigma`, and this repository has two
independent measurements of it.

## The arithmetic, and the one place it is easy to get wrong

For `k` candidate configurations whose true effect is zero, the expected **best** observed score is

    E[max_k] = sigma * integral over x of  x * k * phi(x) * Phi(x)^(k-1) dx

The asymptotic shortcut `sigma * sqrt(2 ln k)` is what a first draft reaches for, and it is wrong
by a factor of two at the sizes anyone actually uses: `sqrt(2 ln 2) = 1.177` against an exact
`0.564` at `k = 2`, and `sqrt(2 ln 5) = 1.794` against `1.163` at `k = 5`. A tool built on the
shortcut refuses searches that are in fact readable, which is the failure mode that makes a check
decorative -- it would be a criterion that always says no. So the integral is evaluated.

The verdict is one comparison:

    readable  <=>  E[max_k] < effect

with `effect` the smallest movement this arm would treat as a result. When `E[max_k] >= effect`, the
search's expected best-of-k gain is fully explained by having taken a maximum, and confirming any
single candidate requires an independent run -- which is the other half of this tool's output.

## What it deliberately does not decide

Whether a search is worth running. A readable search is still expensive, and this tool prices it
(`--budget`) rather than approving it. And it takes `sigma` as an input rather than inventing one:
the two measurements above are passed in, so a run that quotes this verdict can be reproduced from
its arguments alone.
"""

from __future__ import annotations

import argparse
import math
import statistics
import sys


def phi(x: float) -> float:
    """Standard normal density."""
    return math.exp(-0.5 * x * x) / math.sqrt(2.0 * math.pi)


def capital_phi(x: float) -> float:
    """Standard normal distribution function, via the error function."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def expected_maximum(sigma: float, candidates: int) -> float:
    """`E[max]` of `candidates` draws from `N(0, sigma^2)`, by numerical integration.

    The integral runs to `+/- 10` sigma, where `Phi(x)^(k-1)` is numerically zero for every `k` this
    tool accepts, so truncation is not an approximation here. Step `0.0005` was checked against the
    closed form for `k = 2` (`sigma / sqrt(pi)`, from the half-normal) before being chosen.
    """
    if candidates < 1:
        raise ValueError('candidates must be at least 1')
    if sigma < 0:
        raise ValueError('sigma must not be negative')
    if sigma == 0:
        return 0.0
    if candidates == 1:
        # One candidate cannot be selected among, so there is no maximum to take.
        return 0.0

    total = 0.0
    step = 0.0005
    lo, hi = -10.0, 10.0
    steps = int(round((hi - lo) / step))
    for index in range(steps + 1):
        x = lo + index * step
        weight = 0.5 if index in (0, steps) else 1.0
        survival = capital_phi(x)
        if survival <= 0.0:
            continue
        total += weight * x * candidates * phi(x) * survival ** (candidates - 1)
    return sigma * total * step


def sigma_from_repetitions(values: list[float]) -> float:
    """The sample standard deviation of repeated readings of one configuration.

    At least three values, because two give a standard deviation with one degree of freedom -- a
    number that exists and means nothing, which is worse than refusing. §13.118.5's four values are
    the intended input.
    """
    if len(values) < 3:
        raise ValueError(
            f'{len(values)} repetition(s) cannot give a standard deviation: three is the minimum '
            'for two degrees of freedom, and §13.118.5 spent four. A default of zero here would '
            'pass every search, which is the one direction this tool must not fail in'
        )
    return statistics.stdev(values)


def sigma_from_paired_controls(identical: int, flips: int) -> float:
    """`sigma` of a net difference, from the flip rate measured on identical prompts.

    This is §13.194.4's measurement turned into the quantity the comparison needs: `F` questions
    that may flip each way with probability `p`, so a net difference has standard deviation
    `sqrt(F * p * (1 - p))`. It is a different quantity from the spread across repetitions and the
    two agree to within a factor of 1.5 on this arm's own numbers (`6.54` from four repetitions of a
    whole roster against `4.27` from 470 identical-prompt questions), which is why both are accepted
    and why neither is defaulted: they bound the same noise from two directions, and picking one as
    "the" sigma would be a choice made in the tool rather than in the reading.
    """
    if identical < 1:
        raise ValueError('identical must be at least 1')
    if not 0 <= flips <= identical:
        raise ValueError(f'{flips} flips on {identical} questions is not a rate')
    p = flips / identical
    return math.sqrt(identical * p * (1.0 - p))


def z_for(alpha: float) -> float:
    """Two-sided normal quantile, by bisection on `Phi`. No scipy, and no table to mistype."""
    if not 0.0 < alpha < 1.0:
        raise ValueError('alpha must be in (0, 1)')
    target = 1.0 - alpha / 2.0
    lo, hi = 0.0, 10.0
    for _ in range(200):
        mid = (lo + hi) / 2.0
        if capital_phi(mid) < target:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2.0


def repetitions_needed(sigma: float, effect: float, alpha: float, power: float) -> int:
    """Repetitions per configuration for a two-sample comparison to resolve `effect`.

    `n = 2 (z_{1-alpha/2} + z_{power})^2 sigma^2 / effect^2`, which is the standard normal
    approximation and is stated as such: it is a budgeting figure, not a test. Rounded up, because a
    fractional repetition does not exist.
    """
    if effect <= 0:
        raise ValueError(
            'effect must be positive: a search cannot detect a movement nobody would call a result, '
            'and zero would divide by zero rather than say so'
        )
    if sigma < 0:
        raise ValueError('sigma must not be negative')
    if sigma == 0:
        return 1
    if not 0.0 < power < 1.0:
        raise ValueError('power must be in (0, 1)')
    z_alpha = z_for(alpha)
    z_power = z_for(2.0 * (1.0 - power))
    return math.ceil(2.0 * (z_alpha + z_power) ** 2 * sigma * sigma / (effect * effect))


def bonferroni(alpha: float, candidates: int) -> float:
    """`alpha / k`: what a family of `k` comparisons against one control costs.

    Without it, ten candidates each tested at 0.05 give a 40% chance of at least one false positive,
    and a search's whole product is its best candidate -- so the uncorrected version reports the
    false positive as the finding.
    """
    if candidates < 1:
        raise ValueError('candidates must be at least 1')
    return alpha / candidates


def verdict(
    sigma: float,
    candidates: int,
    effect: float,
    questions: int,
    alpha: float,
    power: float,
) -> dict:
    """Everything the two decisions need, as numbers rather than as a paragraph."""
    spread = expected_maximum(sigma, candidates)
    corrected = bonferroni(alpha, candidates)
    naive = repetitions_needed(sigma, effect, alpha, power)
    corrected_runs = repetitions_needed(sigma, effect, corrected, power)
    return {
        'sigma': sigma,
        'candidates': candidates,
        'effect': effect,
        'questions': questions,
        'alpha': alpha,
        'power': power,
        'expected_best_of_k': spread,
        'expected_best_of_k_pp': spread * 100.0 / questions,
        'readable': spread < effect,
        'bonferroni_alpha': corrected,
        'repetitions': naive,
        'repetitions_corrected': corrected_runs,
        'budget_runs': candidates * corrected_runs,
        # The screen-then-confirm budget: one reading per candidate to choose, then enough
        # repetitions of the chosen one to resolve the effect. Cheaper, and it is only valid when
        # the confirmation runs on questions the screen did not use -- which is the holdout this
        # repository does not have, so the number is printed with that condition attached.
        'screen_runs': candidates,
        'confirm_runs': corrected_runs,
        'screen_then_confirm': candidates + corrected_runs,
    }


def sigma_for_readability(effect: float, candidates: int) -> float:
    """The `sigma` at or below which this candidate count becomes readable.

    A check that can only refuse is decoration, so every refusal prints the condition that would
    have passed it. This is that condition, inverted.
    """
    per_sigma = expected_maximum(1.0, candidates)
    if per_sigma == 0:
        return float('inf')
    return effect / per_sigma


def candidates_for_readability(effect: float, sigma: float) -> int:
    """The largest candidate count that stays readable at this `sigma`.

    Never returns 0, because one candidate is not a search: there is no maximum to take, so the
    selection bias is zero and any positive effect is readable at any `sigma`. That asymmetry is the
    point of the whole tool -- the failure is not noise, it is noise plus a maximum.
    """
    if sigma == 0:
        return 1
    best = 1
    for k in range(2, 200):
        if expected_maximum(sigma, k) < effect:
            best = k
        else:
            break
    return best


def render(result: dict) -> str:
    lines: list[str] = []
    lines.append(
        f'sigma                 {result["sigma"]:.2f} question(s) '
        f'({result["sigma"] * 100.0 / result["questions"]:.2f}pp on {result["questions"]})'
    )
    lines.append(
        f'effect to resolve      {result["effect"]:.2f} question(s) '
        f'({result["effect"] * 100.0 / result["questions"]:.2f}pp)'
    )
    lines.append(f'candidates             {result["candidates"]}')
    lines.append('')
    lines.append(
        f'best of {result["candidates"]:>3} of pure noise  '
        f'{result["expected_best_of_k"]:.2f} question(s) '
        f'({result["expected_best_of_k_pp"]:.2f}pp) above the mean'
    )
    lines.append('')
    if result['readable']:
        lines.append(
            f'READABLE: {result["expected_best_of_k"]:.2f} < {result["effect"]:.2f}, so the '
            'selection bias cannot manufacture the effect being claimed.'
        )
    else:
        needed_sigma = sigma_for_readability(result['effect'], result['candidates'])
        needed_k = candidates_for_readability(result['effect'], result['sigma'])
        lines.append(
            f'NOT READABLE: {result["expected_best_of_k"]:.2f} >= {result["effect"]:.2f}, so a '
            'gain of this size is what taking a maximum produces with no treatment at all.'
        )
        lines.append(
            f'  would read at sigma <= {needed_sigma:.2f} question(s) with the same '
            f'{result["candidates"]} candidates,'
        )
        lines.append(
            f'  or at {needed_k} candidate(s) with sigma unchanged -- the search has to get '
            'smaller, not the effect bigger.'
        )
        lines.append(
            '  a single candidate on questions the screen did not use is not a search and has no '
            'maximum to take; that is the one shape this bar does not apply to.'
        )
    lines.append('')
    lines.append(
        f'repetitions per candidate {result["repetitions_corrected"]} '
        f'(alpha {result["bonferroni_alpha"]:.4f} = {result["alpha"]} / {result["candidates"]}, '
        f'power {result["power"]})'
    )
    lines.append(
        f'  uncorrected would be {result["repetitions"]}: a family of {result["candidates"]} '
        'comparisons against one control needs the correction, because the search reports its '
        'best member and the best member is where a false positive lands'
    )
    lines.append(
        f'budget                {result["budget_runs"]} run(s) for every candidate at full power, '
        f'or {result["screen_then_confirm"]} for screen-and-confirm '
        f'({result["screen_runs"]} + {result["confirm_runs"]})'
    )
    lines.append(
        '  screen-and-confirm is valid only when the confirmation runs on questions the screen '
        'never saw; without a holdout the screen and the confirm are the same sample and the '
        'selection bias returns in full'
    )
    return '\n'.join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            'Decide whether a parameter search over prompt wording, few-shot sets or sampling '
            'parameters can be read out at this arm\'s measured noise.'
        )
    )
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--sigma', type=float, help='standard deviation of one reading, in questions')
    source.add_argument(
        '--repeats',
        metavar='VALUES',
        help=(
            'comma-separated readings of ONE configuration, from which sigma is computed; '
            'at least three (e.g. 407,414.5,414.5,423 from §13.118.5)'
        ),
    )
    source.add_argument(
        '--identical',
        metavar='N:FLIPS',
        help=(
            'questions whose prompt was byte-identical and how many verdicts flipped among them, '
            'e.g. 470:19 from §13.194.4'
        ),
    )
    parser.add_argument('--candidates', type=int, required=True, help='how many configurations')
    parser.add_argument('--effect', type=float, required=True, help='smallest movement counted as a result, in questions')
    parser.add_argument('--questions', type=int, default=500, help='roster size the numbers are on')
    parser.add_argument('--alpha', type=float, default=0.05)
    parser.add_argument('--power', type=float, default=0.8)
    args = parser.parse_args(argv)

    try:
        if args.sigma is not None:
            sigma = args.sigma
        elif args.repeats is not None:
            values = [float(part) for part in args.repeats.split(',') if part.strip()]
            sigma = sigma_from_repetitions(values)
        else:
            left, _, right = (args.identical or '').partition(':')
            if not left.strip() or not right.strip():
                raise ValueError('--identical takes N:FLIPS, e.g. 470:19')
            sigma = sigma_from_paired_controls(int(left), int(right))

        if args.questions < 1:
            raise ValueError('questions must be at least 1')
        result = verdict(
            sigma=sigma,
            candidates=args.candidates,
            effect=args.effect,
            questions=args.questions,
            alpha=args.alpha,
            power=args.power,
        )
    except ValueError as error:
        print(f'refused: {error}', file=sys.stderr)
        return 2

    print(render(result))
    return 0 if result['readable'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
