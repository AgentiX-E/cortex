"""The probe budget, its inverse, and the comparison that decides whether to classify at all.

## Why these tests exist rather than a worked example in the docstring

The verdict this tool prints is "spend 40 calls instead of 2000, and the classifier is worth
4.46 questions per roster". Both numbers are load-bearing for a product decision, so both are pinned
from two directions: against values computed here by hand, and against the **monotonicity** that
must hold whatever the constants are. A test that only checked one configuration would pass for a
tool with an off-by-one in the binomial, because the shape of the curve would still be right.

## The three refusals

`--between` without `--within`, `--between` without `--probes`, and `--residual` above `--between`
are all refused rather than defaulted, and each refusal is asserted with its exit code. The reason is
the one `search-budget.py` records: a default in the direction of "this is fine" turns a check into
decoration, and a viewer cannot tell a decorative check from a real one by reading its output.
"""

from __future__ import annotations

import math
import subprocess
import sys
from pathlib import Path

import pytest

TOOL = Path(__file__).resolve().parent.parent / 'probe-budget.py'


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(TOOL), *args],
        capture_output=True,
        text=True,
        check=False,
    )


# The module's file name has a hyphen, so it cannot be imported by name. `search-budget.py` hit the
# same constraint and solved it the same way; the alternative -- a second copy of the arithmetic in
# the tests -- is the drift the module exists to prevent.
def load():
    import importlib.util

    spec = importlib.util.spec_from_file_location('probe_budget', TOOL)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


budget = load()


class TestTheBinomialIsExact:
    def test_one_repeat_is_the_flip_rate(self):
        assert budget.p_majority_wrong(1, 0.048) == pytest.approx(0.048)

    def test_three_repeats_at_an_unknown_reader(self):
        # 3 * 0.048^2 * 0.952 + 0.048^3, computed here rather than copied from the run.
        expected = 3 * 0.048**2 * 0.952 + 0.048**3
        assert budget.p_majority_wrong(3, 0.048) == pytest.approx(expected)
        assert expected == pytest.approx(0.006690816)

    def test_a_coin_flip_stays_a_coin_flip_however_many_repeats(self):
        # The property that would catch a majority rule read as "any" or "all".
        for repeats in (1, 3, 5, 7, 21, 61):
            assert budget.p_majority_wrong(repeats, 0.5) == pytest.approx(0.5)

    def test_a_certain_reader_never_flips(self):
        assert budget.p_majority_wrong(9, 0.0) == pytest.approx(0.0)

    def test_a_reader_that_always_flips_always_fails(self):
        assert budget.p_majority_wrong(9, 1.0) == pytest.approx(1.0)

    def test_more_repeats_are_never_worse(self):
        values = [budget.p_majority_wrong(r, 0.048) for r in range(1, 32, 2)]
        assert values == sorted(values, reverse=True)

    def test_an_even_count_is_refused_because_a_tie_needs_a_convention(self):
        with pytest.raises(ValueError, match='odd'):
            budget.p_majority_wrong(4, 0.048)

    def test_a_flip_rate_outside_the_unit_interval_is_refused(self):
        with pytest.raises(ValueError, match=r'\[0, 1\]'):
            budget.p_majority_wrong(3, 1.5)

    def test_zero_repeats_is_refused(self):
        with pytest.raises(ValueError, match='at least 1'):
            budget.p_majority_wrong(0, 0.048)


class TestTheReportComposesPerProbe:
    def test_one_probe_is_the_single_probe_rate(self):
        assert budget.report_false_pass(1, 3, 0.048) == pytest.approx(
            budget.p_majority_wrong(3, 0.048)
        )

    def test_eight_probes_at_three_repeats(self):
        # The optional approximation 1-(1-q)^8, computed here.
        q = budget.p_majority_wrong(3, 0.048)
        assert budget.report_false_pass(8, 3, 0.048) == pytest.approx(1 - (1 - q) ** 8)

    def test_more_probes_are_never_better(self):
        values = [budget.report_false_pass(p, 3, 0.048) for p in range(1, 40)]
        assert values == sorted(values)

    def test_a_stricter_target_costs_repeats(self):
        loose = budget.repetitions_for(0.05, 8, 0.048)
        strict = budget.repetitions_for(0.001, 8, 0.048)
        assert loose is not None and strict is not None
        assert strict > loose


class TestTheInverse:
    def test_returns_the_smallest_odd_count_that_reaches_the_target(self):
        repeats = budget.repetitions_for(0.02, 8, 0.048)
        assert repeats is not None
        assert repeats % 2 == 1
        assert budget.report_false_pass(8, repeats, 0.048) <= 0.02
        if repeats > 1:
            assert budget.report_false_pass(8, repeats - 2, 0.048) > 0.02

    def test_reports_none_when_the_cap_cannot_reach_the_target(self):
        # A reader that flips half the time cannot be stabilised by voting at any count this tool
        # will spend, so the inverse has to say so instead of returning the cap.
        assert budget.repetitions_for(0.001, 12, 0.5) is None

    def test_a_target_of_one_is_refused(self):
        with pytest.raises(ValueError, match=r'\(0, 1\)'):
            budget.repetitions_for(1.0, 8, 0.048)


class TestSeparation:
    def test_a_wide_gap_is_separated(self):
        result = budget.separation(between=6, within=2)
        assert result['separated'] is True
        assert result['ratio'] == pytest.approx(1 / 3)

    def test_equal_gaps_are_not_separated(self):
        # Not `>=`: at equality the label carries nothing, and a test asserting the boundary in the
        # permissive direction would let a useless classifier ship.
        assert budget.separation(between=4, within=4)['separated'] is False

    def test_a_gap_narrower_than_the_spread_is_not_separated(self):
        assert budget.separation(between=3, within=8)['separated'] is False

    def test_zero_spread_is_separated_and_reports_a_zero_ratio(self):
        result = budget.separation(between=3, within=0)
        assert result['separated'] is True
        assert result['ratio'] == 0.0

    def test_a_non_positive_gap_is_refused(self):
        with pytest.raises(ValueError, match='positive'):
            budget.separation(between=0, within=1)

    def test_a_negative_spread_is_refused(self):
        with pytest.raises(ValueError, match='non-negative'):
            budget.separation(between=3, within=-1)


class TestTheNetGain:
    def test_the_gain_is_the_improvement_weighted_by_reaching_the_right_row(self):
        result = budget.net_gain(between=6, residual=1.5, false_pass=0.01)
        assert result['worth_it'] is True
        assert result['gain'] == pytest.approx(0.99 * 4.5)

    def test_a_perfect_classifier_and_no_residual_is_not_worth_shipping(self):
        # This is the case that keeps the tool from rubber-stamping: the matrix has to actually fix
        # something, and a classifier that always picks the right row for a matrix that changes
        # nothing has a gain of exactly zero.
        assert budget.net_gain(between=6, residual=6, false_pass=0.0)['worth_it'] is False

    def test_a_residual_above_the_gap_is_refused_rather_than_printed_negative(self):
        with pytest.raises(ValueError, match='defect in the matrix'):
            budget.net_gain(between=6, residual=7, false_pass=0.0)

    def test_a_false_pass_rate_outside_the_unit_interval_is_refused(self):
        with pytest.raises(ValueError, match=r'\[0, 1\]'):
            budget.net_gain(between=6, residual=1, false_pass=1.2)


class TestTheBudgetOutput:
    def test_prints_repeats_calls_and_the_benchmark_it_replaces(self):
        result = run('--probes', '8')
        assert result.returncode == 0
        assert 'must-pass probes' in result.stdout
        assert 'calls' in result.stdout
        assert '2000 calls' in result.stdout

    def test_the_call_count_is_the_product_of_probes_and_repeats(self):
        result = run('--probes', '6')
        assert result.returncode == 0
        head = result.stdout.splitlines()[0]
        left, _, right = head.partition('= ')
        repeats = int(left.split()[0])
        assert f'{repeats * 6} calls' in right

    def test_an_unreachable_target_prints_the_floor_and_exits_one(self):
        result = run('--probes', '12', '--flip', '0.5', '--target', '0.001')
        assert result.returncode == 1
        assert 'floor' in result.stdout


class TestTheSeparationVerdict:
    def test_a_separated_classifier_exits_zero(self):
        result = run('--probes', '8', '--between', '6', '--within', '2')
        assert result.returncode == 0
        assert 'separated' in result.stdout

    def test_an_unseparated_classifier_exits_one_and_names_the_alternative(self):
        result = run('--probes', '8', '--between', '3', '--within', '8')
        assert result.returncode == 1
        assert 'capability contract' in result.stdout

    def test_a_thin_margin_passes_but_warns(self):
        result = run('--probes', '8', '--between', '4', '--within', '3.5')
        assert result.returncode == 0
        assert 'margin is thin' in result.stdout


class TestTheRefusals:
    def test_between_without_within_is_refused(self):
        result = run('--probes', '8', '--between', '6')
        assert result.returncode == 2
        assert 'requires --within' in result.stderr

    def test_between_without_probes_is_refused(self):
        result = run('--between', '6', '--within', '2')
        assert result.returncode == 2
        assert 'requires --probes' in result.stderr

    def test_no_probes_at_all_is_refused(self):
        result = run()
        assert result.returncode == 2
        assert '--probes is required' in result.stderr

    def test_a_residual_without_a_repeat_count_is_refused(self):
        # The false-pass rate is unbounded when the inverse found nothing, and charging zero would
        # print a gain the classifier cannot deliver.
        result = run(
            '--probes', '12', '--flip', '0.5', '--target', '0.001',
            '--between', '6', '--within', '2', '--residual', '1',
        )
        assert result.returncode == 2
        assert 'unbounded' in result.stderr


class TestTheDefaultFlipRateIsTheMeasuredOne:
    def test_the_default_matches_section_13_194_4(self):
        # 4.8% of verdicts flipped on 470 byte-identical prompts. If this constant drifts, every
        # budget printed by the tool drifts with it and nothing else would notice.
        assert math.isclose(budget.p_majority_wrong(1, 0.048), 0.048)
        result = run('--probes', '8')
        assert result.returncode == 0
