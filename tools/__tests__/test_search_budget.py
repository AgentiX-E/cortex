#!/usr/bin/env python3
"""`search-budget.py`, checked against published constants and against this repository's own noise.

The tool answers one question -- may a search over `k` configurations be read out at this arm's
measured noise? -- and every test here is a case where a plausible implementation gets the answer
wrong in a direction that matters:

  - **the asymptotic shortcut.** `sigma * sqrt(2 ln k)` is what any first draft writes, and it is
    wrong by a factor of two at the sizes real searches use: `1.177` against an exact `0.564` at
    `k = 2`. A tool built on it refuses searches that are readable, and a check that cannot pass is
    decoration. So the integral is asserted against the published expected values of the maximum of
    `k` standard normals, to six decimal places.
  - **one candidate is not a search.** With `k = 1` there is no maximum to take, so the selection
    bias is zero and a single registered change is readable at any noise. That is the one shape the
    bar does not apply to, and a tool that refuses it refuses the only thing this arm actually does.
  - **a dangerous default.** Two repetitions give a standard deviation with one degree of freedom,
    and an empty input giving `sigma = 0` would pass every search. Both are refused rather than
    defaulted, because the failure mode of this tool is silent permission.
  - **the budget is the finding.** At `sigma` 6.54 and ten candidates, each candidate needs 46
    repetitions after the family-wise correction. Printing the verdict without that number would
    make "not readable" sound like a judgement rather than arithmetic.
  - **refusal must name its own inverse.** Every NOT READABLE prints the `sigma` or the candidate
    count that would have passed. Without it the tool is a paragraph that says no.
"""

from __future__ import annotations

import math
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'search-budget.py'

# `sys.path` rather than importlib.reload: the module is a CLI, and importing it twice would give
# two copies of the same constants with no way to tell which one an assertion used.
sys.path.insert(0, str(REPO / 'tools'))
import importlib.util

_spec = importlib.util.spec_from_file_location('search_budget', TOOL)
sb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sb)


def run(*args: str) -> 'subprocess.CompletedProcess[str]':
    return subprocess.run(
        [sys.executable, str(TOOL), *args], capture_output=True, text=True, check=False
    )


# Published expected values of the maximum of k standard normal draws, k = 1..10, 20, 50, 100.
# These are the ground truth the integral is checked against; nothing about the implementation is
# used to produce them.
EXPECTED_MAXIMUM = {
    1: 0.0,
    2: 0.5641896,
    3: 0.8462844,
    4: 1.0293754,
    5: 1.1629645,
    6: 1.2672064,
    7: 1.3521784,
    8: 1.4236003,
    9: 1.4850132,
    10: 1.5387527,
    20: 1.8674750,
    50: 2.2490753,
    100: 2.5075942,
}

# §13.118.5: four repetitions of one configuration, one job, one dataset, no treatment.
ROSTER_REPETITIONS = [407.0, 414.5, 414.5, 423.0]
# §13.194.4: verdicts that flipped on the 470 questions whose prompt was byte-identical.
IDENTICAL_QUESTIONS = 470
IDENTICAL_FLIPS = 19


class TestTheMaximumIsTheRealOne:
    @pytest.mark.parametrize('k,expected', sorted(EXPECTED_MAXIMUM.items()))
    def test_the_integral_matches_the_published_constant(self, k: int, expected: float) -> None:
        # `abs=1e-5` is the accuracy of a trapezoid rule at step 0.0005, not a tolerance chosen to
        # make the assertion pass: the error grows with `k` because `Phi(x)^(k-1)` steepens, and
        # `k = 50` sits at 1.7e-6. It does not weaken the test. The defect this table exists to
        # catch is the asymptotic shortcut, which is wrong by a factor of two -- six orders of
        # magnitude larger -- and no decision this tool makes turns on the sixth decimal.
        assert sb.expected_maximum(1.0, k) == pytest.approx(expected, abs=1e-5)

    def test_the_asymptotic_shortcut_would_have_been_wrong_by_a_factor_of_two(self) -> None:
        # The assertion that makes the shortcut impossible to reintroduce. `sqrt(2 ln 2)` is 1.177
        # and the exact answer is 0.564; at the candidate counts a real search uses the shortcut is
        # not a rounding error but a different decision, in the over-refusing direction.
        asymptotic = math.sqrt(2.0 * math.log(2.0))
        exact = sb.expected_maximum(1.0, 2)
        assert exact == pytest.approx(1.0 / math.sqrt(math.pi), abs=1e-6)
        assert asymptotic / exact > 2.0
        # ... and it stays wrong in the same direction at k = 5, which is the size a first
        # experiment usually is.
        assert math.sqrt(2.0 * math.log(5.0)) / sb.expected_maximum(1.0, 5) > 1.5

    def test_one_candidate_has_no_selection_bias(self) -> None:
        # No maximum to take. A tool that charged a bias here would refuse every single-variable
        # run this campaign has ever dispatched.
        assert sb.expected_maximum(9.9, 1) == 0.0

    def test_zero_noise_charges_nothing(self) -> None:
        assert sb.expected_maximum(0.0, 50) == 0.0

    def test_the_bias_is_sublinear_in_the_candidate_count(self) -> None:
        # Ten times the candidates must not cost ten times the bias, otherwise the number is a
        # restatement of k rather than a property of a maximum.
        a = sb.expected_maximum(1.0, 10)
        b = sb.expected_maximum(1.0, 100)
        assert b / a < 2.0
        assert b > a

    def test_it_refuses_a_negative_spread_and_a_negative_candidate_count(self) -> None:
        with pytest.raises(ValueError):
            sb.expected_maximum(-1.0, 10)
        with pytest.raises(ValueError):
            sb.expected_maximum(1.0, 0)


class TestSigmaComesFromAMeasurementNotADefault:
    def test_four_repetitions_give_the_measured_spread(self) -> None:
        # §13.118.5's own numbers, reproduced.
        assert sb.sigma_from_repetitions(ROSTER_REPETITIONS) == pytest.approx(6.5383, abs=1e-3)

    def test_two_repetitions_are_refused_rather_than_given_one_degree_of_freedom(self) -> None:
        with pytest.raises(ValueError, match='three is the minimum'):
            sb.sigma_from_repetitions([407.0, 423.0])

    def test_an_empty_input_is_refused_rather_than_defaulted_to_zero(self) -> None:
        # `sigma = 0` passes every search. A default in that direction is silent permission, which
        # is the one failure mode this tool must not have.
        with pytest.raises(ValueError):
            sb.sigma_from_repetitions([])

    def test_the_identical_prompt_flip_rate_gives_a_spread(self) -> None:
        # §13.194.4: 19 of 470 identical-prompt verdicts flipped, so a net difference on a stratum
        # of that size has sd sqrt(470 * p * (1 - p)).
        p = IDENTICAL_FLIPS / IDENTICAL_QUESTIONS
        assert sb.sigma_from_paired_controls(IDENTICAL_QUESTIONS, IDENTICAL_FLIPS) == pytest.approx(
            math.sqrt(IDENTICAL_QUESTIONS * p * (1.0 - p)), abs=1e-9
        )

    def test_the_two_measurements_bound_the_same_noise(self) -> None:
        # They are different quantities and they disagree by a factor under two. A tool that
        # invented a third number, or silently averaged them, would hide that the arm's noise is
        # known only to within a factor -- which is itself part of the finding.
        across = sb.sigma_from_repetitions(ROSTER_REPETITIONS)
        paired = sb.sigma_from_paired_controls(IDENTICAL_QUESTIONS, IDENTICAL_FLIPS)
        assert 1.0 < across / paired < 2.0

    def test_a_flip_count_above_the_question_count_is_refused(self) -> None:
        with pytest.raises(ValueError, match='not a rate'):
            sb.sigma_from_paired_controls(470, 471)


class TestTheDecision:

    def test_the_repositorys_own_noise_cannot_read_a_ten_candidate_search(self) -> None:
        # The headline. Ten candidates, a five-question effect, and the arm's measured noise: the
        # expected best of pure noise is twice the effect, so the search's finding is the maximum.
        result = sb.verdict(
            sigma=sb.sigma_from_repetitions(ROSTER_REPETITIONS),
            candidates=10,
            effect=5.0,
            questions=500,
            alpha=0.05,
            power=0.8,
        )
        assert result['readable'] is False
        assert result['expected_best_of_k'] > result['effect']
        assert result['expected_best_of_k'] == pytest.approx(10.06, abs=0.02)

    def test_a_single_candidate_is_always_readable(self) -> None:
        # The counterweight that stops the tool being a refusal machine: the registered
        # single-variable runs this campaign dispatches are exactly k = 1, and they must pass.
        result = sb.verdict(
            sigma=6.54, candidates=1, effect=5.0, questions=500, alpha=0.05, power=0.8
        )
        assert result['readable'] is True
        assert result['expected_best_of_k'] == 0.0

    def test_two_candidates_fit_under_the_bar_at_this_noise(self) -> None:
        # The boundary, stated as a number rather than as an adjective: an A/B is readable here
        # and a five-way grid is not. If a future change to the arm halved the noise, this
        # assertion should fail, and that is the point of pinning it.
        result = sb.verdict(
            sigma=6.54, candidates=2, effect=5.0, questions=500, alpha=0.05, power=0.8
        )
        assert result['readable'] is True
        assert sb.candidates_for_readability(5.0, 6.54) == 2

    def test_five_candidates_do_not(self) -> None:
        result = sb.verdict(
            sigma=6.54, candidates=5, effect=5.0, questions=500, alpha=0.05, power=0.8
        )
        assert result['readable'] is False

    def test_the_table_in_the_audit_document_is_what_the_tool_prints(self) -> None:
        # AUDIT-PARAMETER-SELF-EVOLUTION.md §3 prints a row per candidate count, and a table in a
        # document that the tool disagrees with is a table nobody re-derived. Pinned here so a
        # change to the integral or to the claim fails in one place rather than in the reader.
        printed = {
            1: 0.00,
            2: 3.69,
            3: 5.53,
            5: 7.61,
            10: 10.06,
            20: 12.21,
            50: 14.71,
        }
        for k, want in printed.items():
            assert sb.expected_maximum(6.54, k) == pytest.approx(want, abs=0.01), k

    def test_a_quiet_arm_can_read_a_large_search(self) -> None:
        # The other counterweight, and the one that keeps the criterion about noise rather than
        # about searching: at a fifth of this arm's spread, a hundred candidates are readable.
        result = sb.verdict(
            sigma=0.5, candidates=100, effect=5.0, questions=500, alpha=0.05, power=0.8
        )
        assert result['readable'] is True

    def test_the_effect_has_to_be_positive(self) -> None:
        with pytest.raises(ValueError, match='cannot detect a movement'):
            sb.verdict(sigma=6.54, candidates=2, effect=0.0, questions=500, alpha=0.05, power=0.8)


class TestTheBudget:

    def test_the_family_correction_costs_repetitions(self) -> None:
        # Ten comparisons against one control, each at 0.05, is a 40% chance of a false positive
        # somewhere -- and a search reports the somewhere. Corrected, each candidate needs more
        # repetitions than an uncorrected pair would.
        corrected = sb.repetitions_needed(6.54, 5.0, sb.bonferroni(0.05, 10), 0.8)
        uncorrected = sb.repetitions_needed(6.54, 5.0, 0.05, 0.8)
        assert corrected > uncorrected
        assert corrected == 46
        assert uncorrected == 27

    def test_the_alpha_is_divided_by_the_candidate_count(self) -> None:
        assert sb.bonferroni(0.05, 10) == pytest.approx(0.005)

    def test_the_total_budget_multiplies(self) -> None:
        result = sb.verdict(
            sigma=6.54, candidates=10, effect=5.0, questions=500, alpha=0.05, power=0.8
        )
        assert result['budget_runs'] == 10 * 46
        assert result['screen_then_confirm'] == 10 + 46

    def test_screen_and_confirm_is_cheaper_and_the_tool_says_what_it_costs(self) -> None:
        # It is only valid with a holdout, which this repository does not have. The number is
        # printed beside the condition because the number alone would be read as permission.
        result = sb.verdict(
            sigma=6.54, candidates=10, effect=5.0, questions=500, alpha=0.05, power=0.8
        )
        assert result['screen_then_confirm'] < result['budget_runs']

    def test_a_larger_effect_needs_fewer_repetitions(self) -> None:
        assert sb.repetitions_needed(6.54, 10.0, 0.05, 0.8) < sb.repetitions_needed(
            6.54, 5.0, 0.05, 0.8
        )

    def test_the_repetition_count_is_whole(self) -> None:
        # A fractional repetition does not exist, and a caller that rounded down would under-budget.
        for effect in (3.0, 4.0, 5.0, 6.0, 7.0):
            assert isinstance(sb.repetitions_needed(6.54, effect, 0.05, 0.8), int)
        assert sb.repetitions_needed(6.54, 5.0, 0.05, 0.8) == math.ceil(
            2.0 * (sb.z_for(0.05) + sb.z_for(0.4)) ** 2 * 6.54**2 / 25.0
        )


class TestTheRefusalNamesItsOwnInverse:

    def test_a_refusal_prints_the_sigma_that_would_have_passed(self) -> None:
        r = run('--sigma', '6.54', '--candidates', '10', '--effect', '5')
        assert r.returncode == 1
        assert 'NOT READABLE' in r.stdout
        assert 'would read at sigma <= 3.25' in r.stdout

    def test_a_refusal_prints_the_candidate_count_that_would_have_passed(self) -> None:
        r = run('--sigma', '6.54', '--candidates', '10', '--effect', '5')
        assert 'at 2 candidate(s) with sigma unchanged' in r.stdout

    def test_the_inverse_is_consistent_with_the_decision(self) -> None:
        # The printed inverse and the predicate must be the same function read two ways, or a
        # reader who follows the advice would arrive at a different verdict than the tool's.
        assert sb.candidates_for_readability(5.0, 6.54) == 2
        at_boundary = sb.verdict(
            sigma=6.54, candidates=2, effect=5.0, questions=500, alpha=0.05, power=0.8
        )
        assert at_boundary['readable'] is True
        past_boundary = sb.verdict(
            sigma=6.54, candidates=3, effect=5.0, questions=500, alpha=0.05, power=0.8
        )
        assert past_boundary['readable'] is False

    def test_a_readable_verdict_does_not_print_the_refusal_block(self) -> None:
        r = run('--sigma', '0.5', '--candidates', '10', '--effect', '5')
        assert r.returncode == 0
        assert 'READABLE' in r.stdout
        assert 'NOT READABLE' not in r.stdout
        assert 'would read at sigma' not in r.stdout


class TestTheCommandLine:

    def test_repeats_are_accepted_instead_of_a_sigma(self) -> None:
        r = run('--repeats', '407,414.5,414.5,423', '--candidates', '10', '--effect', '5')
        assert r.returncode == 1
        assert 'sigma                 6.54 question(s)' in r.stdout

    def test_the_identical_prompt_form_is_accepted_too(self) -> None:
        r = run('--identical', '470:19', '--candidates', '10', '--effect', '5')
        assert r.returncode == 1
        assert 'sigma                 4.27 question(s)' in r.stdout

    def test_the_exit_code_is_the_verdict(self) -> None:
        # 0 read, 1 refused by the bar, 2 refused as malformed. A single non-zero code for both
        # would make "this search is unreadable" indistinguishable from "you typed it wrong".
        assert run('--sigma', '0.5', '--candidates', '2', '--effect', '5').returncode == 0
        assert run('--sigma', '6.54', '--candidates', '10', '--effect', '5').returncode == 1
        assert run('--sigma', '6.54', '--candidates', '10', '--effect', '0').returncode == 2

    def test_a_malformed_input_says_what_it_wanted(self) -> None:
        r = run('--identical', '470', '--candidates', '10', '--effect', '5')
        assert r.returncode == 2
        assert 'N:FLIPS' in r.stderr

    def test_the_three_sigma_sources_are_mutually_exclusive(self) -> None:
        r = run('--sigma', '6.54', '--repeats', '407,414.5,414.5,423', '--candidates', '10', '--effect', '5')
        assert r.returncode != 0
        assert 'not allowed with' in r.stderr or 'mutually exclusive' in r.stderr

    def test_the_threshold_is_written_in_the_units_the_reading_uses(self) -> None:
        # Questions and percentage points, because every registration in this campaign is in
        # questions and every published score is in points, and a reader converting one to the
        # other by hand is how a 1.31pp sigma becomes a 6.5 "point" noise floor.
        r = run('--sigma', '6.54', '--candidates', '10', '--effect', '5')
        assert '(1.31pp on 500)' in r.stdout
        assert '(1.00pp)' in r.stdout
        assert '(2.01pp)' in r.stdout
