"""Tests for `tools/guard-window.py`, the third falsifier of the portability audit.

The tool answers "would the guard fire on a reader that is working" from artifacts that already
exist, so the tests have to hold two things at once: the arithmetic (a window count and a binomial
tail are both checkable against a hand computation) and the **refusals** (a signal the artifact
cannot express must not be reported as zero, and a decline must not be counted as a failure without
being labelled a counterfactual).
"""

from __future__ import annotations

import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from importlib import import_module

guard = import_module("guard-window")


# --------------------------------------------------------------------------- binomial

class TestTheBinomialTail:
    def test_matches_a_hand_computation_at_the_rule_the_guard_uses(self):
        # P(X >= 3) for n=20, p=0.05 = 1 - P(0) - P(1) - P(2)
        p = 0.05
        n = 20
        expected = 1.0 - sum(
            __import__("math").comb(n, i) * p**i * (1 - p) ** (n - i) for i in range(3)
        )
        assert guard.binomial_tail(3, 20, p) == pytest.approx(expected, rel=1e-12)
        assert expected == pytest.approx(0.0755, abs=1e-4)

    def test_is_one_when_every_trial_must_succeed(self):
        assert guard.binomial_tail(0, 20, 0.01) == 1.0
        assert guard.binomial_tail(1, 1, 1.0) == 1.0

    def test_is_zero_when_more_failures_are_asked_for_than_calls(self):
        assert guard.binomial_tail(21, 20, 0.9) == 0.0

    def test_is_zero_at_p_zero_and_one_at_p_one(self):
        assert guard.binomial_tail(3, 20, 0.0) == 0.0
        assert guard.binomial_tail(3, 20, 1.0) == 1.0


class TestTheCalibration:
    def test_inverts_the_tail_it_is_built_on(self):
        rate = guard.rate_for_firing(3, 20, 0.05)
        assert guard.binomial_tail(3, 20, rate) == pytest.approx(0.05, abs=1e-9)

    def test_is_near_four_percent_at_the_guards_own_rule(self):
        # Printed in the audit and in the tool's output; the exact value is 4.22%.
        assert guard.rate_for_firing(3, 20, 0.05) == pytest.approx(0.0422, abs=5e-4)

    def test_rises_when_more_failures_may_occur(self):
        # Allowing 10 of 20 to trip the guard means a reader can be much noisier before it fires,
        # so the rate at which the rule fires on 5% of windows is higher, not lower.
        loose = guard.rate_for_firing(10, 20, 0.05)
        strict = guard.rate_for_firing(3, 20, 0.05)
        assert loose > strict

    def test_refuses_a_target_it_cannot_invert(self):
        for bad in (0.0, 1.0, -0.1, 1.5):
            with pytest.raises(ValueError, match="target must be in"):
                guard.rate_for_firing(3, 20, bad)


# --------------------------------------------------------------------------- windows

class TestTheWindowCount:
    def test_counts_overlapping_firing_windows_once_per_start(self):
        # Starts 0 fires (TTT). Start 1 sees TTF, start 2 TFF, start 3 FFF -- so exactly one window.
        flags = [True, True, True, False, False, False]
        assert guard.window_fires(flags, 3, 3) == 1

    def test_does_not_count_a_window_that_never_filled(self):
        assert guard.window_fires([True, True], 3, 3) == 0
        assert guard.window_count(2, 3) == 0

    def test_the_denominator_is_the_number_of_start_positions(self):
        assert guard.window_count(500, 20) == 481
        assert guard.window_count(20, 20) == 1
        assert guard.window_count(19, 20) == 0

    def test_a_single_spike_does_not_fire_when_the_trigger_is_three(self):
        flags = [False] * 10 + [True] + [False] * 10
        assert guard.window_fires(flags, 20, 3) == 0

    def test_three_spikes_densely_packed_do_fire(self):
        flags = [False] * 5 + [True, True, True] + [False] * 12
        # 20 flags, one window, and it contains all three.
        assert len(flags) == 20
        assert guard.window_fires(flags, 20, 3) == 1

    def test_refuses_a_window_or_trigger_it_cannot_apply(self):
        with pytest.raises(ValueError, match="window must be positive"):
            guard.window_fires([True], 0, 3)
        with pytest.raises(ValueError, match="trigger must be positive"):
            guard.window_fires([True], 3, 0)


# --------------------------------------------------------------------------- artifact

def artifact(tmp_path, questions, reasons=None, name="report.json"):
    payload = {
        "questions": questions,
        "abstentionReasons": reasons or {"empty": 0, "threshold": 0, "llm": 0, "answered": len(questions)},
        "generatedAt": "2026-11-01T00:00:00Z",
    }
    path = tmp_path / name
    path.write_text(json.dumps(payload))
    return path


def question(raw, answer="x", correct=True):
    return {"rawOutput": raw, "answer": answer, "correct": correct}


class TestWhatTheArtifactCanExpress:
    def test_an_empty_completion_includes_a_whitespace_one(self, tmp_path):
        path = artifact(tmp_path, [question(""), question("  \n "), question("x")])
        parsed = guard.Artifact(path, json.loads(path.read_text()))
        assert parsed.empty_completion() == [True, True, False]

    def test_a_decline_is_read_from_a_null_answer_not_from_the_text(self, tmp_path):
        path = artifact(
            tmp_path,
            [question("INSUFFICIENT_EVIDENCE", answer=None), question("x")],
        )
        parsed = guard.Artifact(path, json.loads(path.read_text()))
        assert parsed.declines() == [True, False]

    def test_a_decline_that_was_scored_correct_is_counted_as_correct(self, tmp_path):
        path = artifact(
            tmp_path,
            [question("INSUFFICIENT_EVIDENCE", answer=None, correct=True), question("x")],
        )
        parsed = guard.Artifact(path, json.loads(path.read_text()))
        assert parsed.decline_correctness() == (1, 1)

    def test_refuses_a_report_without_a_call_stream(self, tmp_path):
        path = tmp_path / "report.json"
        path.write_text(json.dumps({"questions": [], "abstentionReasons": {}}))
        with pytest.raises(SystemExit, match="questions"):
            guard.Artifact(path, json.loads(path.read_text()))

    def test_names_the_missing_field_rather_than_returning_an_empty_stream(self, tmp_path):
        path = tmp_path / "report.json"
        path.write_text(json.dumps({"questions": [question("x")]}))
        with pytest.raises(SystemExit, match="abstentionReasons"):
            guard.Artifact(path, json.loads(path.read_text()))


# --------------------------------------------------------------------------- report

class TestTheReport:
    def quiet(self, tmp_path):
        return artifact(tmp_path, [question("x")] * 40)

    def test_says_quiet_and_exits_zero_when_nothing_fires(self, tmp_path, capsys):
        code = guard.main([str(self.quiet(tmp_path))])
        out = capsys.readouterr().out
        assert code == 0
        assert "quiet on the one signal" in out

    def test_lists_the_three_signals_it_cannot_read_rather_than_calling_them_zero(
        self, tmp_path, capsys
    ):
        guard.main([str(self.quiet(tmp_path))])
        out = capsys.readouterr().out
        assert "4 guard signals" in out
        assert "1 of 4" in out or "derivable  1 of 4" in out
        for name in ("parse-failed", "abstention-unrecognised", "deadline-exceeded"):
            assert name in out

    def test_labels_the_decline_rate_a_counterfactual(self, tmp_path, capsys):
        path = artifact(
            tmp_path,
            [question("INSUFFICIENT_EVIDENCE", answer=None)] * 5 + [question("x")] * 35,
        )
        guard.main([str(path)])
        out = capsys.readouterr().out
        assert "counterfactual" in out
        assert "scored **correct**" in out

    def test_exits_one_when_a_signal_exceeds_the_target(self, tmp_path):
        path = artifact(tmp_path, [question("")] * 40)
        assert guard.main([str(path)]) == 1

    def test_exits_two_when_no_window_fits(self, tmp_path, capsys):
        path = artifact(tmp_path, [question("x")] * 4)
        assert guard.main([str(path)]) == 2
        assert "no window fits" in capsys.readouterr().out

    def test_exits_two_on_an_unreadable_file(self, tmp_path):
        path = tmp_path / "bad.json"
        path.write_text("{not json")
        assert guard.main([str(path)]) == 2

    def test_refuses_arguments_it_cannot_apply(self, tmp_path):
        path = self.quiet(tmp_path)
        assert guard.main([str(path), "--window", "0"]) == 2
        assert guard.main([str(path), "--trigger", "0"]) == 2
        assert guard.main([str(path), "--target", "1.0"]) == 2

    def test_reports_each_artifact_and_takes_the_worst_exit_code(self, tmp_path):
        quiet = self.quiet(tmp_path)
        loud = artifact(tmp_path, [question("")] * 40, name="loud.json")
        assert guard.main([str(quiet), str(loud)]) == 1
        assert guard.main([str(loud), str(quiet)]) == 1

    def test_reports_the_dispersion_and_the_arrangement_ratio(self, tmp_path, capsys):
        # The rate the tool reports is only interpretable next to the two numbers that move it.
        flags = [question("INSUFFICIENT_EVIDENCE", answer=None)] * 6 + [question("x")] * 34
        path = artifact(tmp_path, flags)
        guard.main([str(path)])
        out = capsys.readouterr().out
        assert "intraclass correlation" in out
        assert "exchangeable predicts" in out
        assert "arrangement" in out

    def test_says_so_when_no_dispersion_can_be_measured(self, tmp_path, capsys):
        # An all-answered stream has no variance, so ICC is undefined -- and undefined is not zero.
        guard.main([str(self.quiet(tmp_path))])
        out = capsys.readouterr().out
        assert "no dispersion to measure" in out

    def test_reports_the_cumulative_risk_a_latching_alarm_carries(self, tmp_path, capsys):
        path = artifact(tmp_path, [question("x")] * 500)
        guard.main([str(path)])
        out = capsys.readouterr().out
        assert "cumulative" in out
        assert "over 25 windows (500 calls)" in out

    def test_reports_the_figure_the_shipped_guard_actually_meets(self, tmp_path, capsys):
        path = artifact(tmp_path, [question("x")] * 500)
        guard.main([str(path), "--persistence", "2"])
        out = capsys.readouterr().out
        assert "2 consecutive firing window" in out
        assert "one window enough would be 72.26%" in out

    def test_uses_the_guards_tumbling_stride_when_asked(self, tmp_path, capsys):
        path = artifact(tmp_path, [question("")] * 40)
        guard.main([str(path), "--stride", "20"])
        out = capsys.readouterr().out
        assert "tumbling" in out


class TestTheNumbersTheAuditQuotes:
    def test_the_uniform_prediction_for_the_published_decline_rate_is_about_thirteen_percent(self):
        # 32 of 500 is a real decline rate on this dataset. If calls were exchangeable, a 20-call
        # window would fire 1 - P(0) - P(1) - P(2) of the time at p = 0.064.
        assert guard.binomial_tail(3, 20, 32 / 500) == pytest.approx(0.1327, abs=5e-4)

    def test_the_same_number_of_events_fires_or_not_depending_only_on_their_arrangement(self):
        # 32 events, two arrangements, nothing else changed. This is the falsifier's own falsifier:
        # whatever `3 of 20` is, it is not a property of the events.
        #
        # The packed array below is a **construction**, not a measurement -- an earlier version of
        # this test called its 21.83% "measured" and the audit repeated that. It is not: the real
        # archives are under-dispersed relative to this array, and twelve of them are summarised in
        # `AUDIT-MODEL-PORTABILITY.md` 9.2. What survives is only the weaker claim proved here,
        # that arrangement alone moves the number by more than 20 points.
        blocked = [False] * 500
        for start in (64, 126, 227, 360, 440):
            for offset in range(6):
                blocked[start + offset] = True
        for start in (100, 200):
            blocked[start] = True
        assert sum(blocked) == 32

        # The same 32 events, evenly spaced: no 20-call window can hold three of them.
        spaced = [False] * 500
        for index in range(0, 500, 15):
            if index // 15 < 32:
                spaced[index] = True
        assert sum(spaced) == 32

        denominator = guard.window_count(500, 20)
        fired_blocked = guard.window_fires(blocked, 20, 3) / denominator
        fired_spaced = guard.window_fires(spaced, 20, 3) / denominator
        assert fired_spaced == 0.0
        assert fired_blocked > 1.4 * guard.binomial_tail(3, 20, 32 / 500)

    def test_zero_events_can_never_fire_whatever_the_window(self):
        assert guard.window_fires([False] * 500, 20, 1) == 0
        assert guard.window_fires([False] * 500, 2, 1) == 0


# --------------------------------------------------------------------------- dispersion

class TestTheBetaBinomialTail:
    """The one-parameter over-dispersion model, and the two places it surprises.

    Surprise one: the tail is **not monotone** in `rho`. Surprise two: at the guard's own
    operating point it moves the answer by 1.94x, and at a rate twice that it moves it the other
    way. Both are asserted rather than described, because a reader who has not computed them will
    assume the opposite.
    """

    def test_reduces_to_the_binomial_at_zero_dispersion(self):
        for k in (1, 3, 20):
            assert guard.beta_binomial_tail(k, 20, 0.048, 0.0) == pytest.approx(
                guard.binomial_tail(k, 20, 0.048), rel=1e-12
            )

    def test_at_the_guards_operating_point_clustering_almost_doubles_the_firing_rate(self):
        # p = 0.048 is §13.194.4's measured same-prompt flip rate, i.e. the rate at which a working
        # reader can be expected to produce a signal. Exchangeable: 6.85%. At rho = 0.10, which is
        # the mean ICC of the twelve archives: 13.27%. 1.94x.
        assert guard.beta_binomial_tail(3, 20, 0.048, 0.1) == pytest.approx(0.1327, abs=5e-4)
        assert guard.binomial_tail(3, 20, 0.048) == pytest.approx(0.0685, abs=5e-4)
        assert guard.beta_binomial_tail(3, 20, 0.048, 0.1) > 1.9 * guard.binomial_tail(3, 20, 0.048)

    def test_near_the_trigger_clustering_moves_the_rate_the_other_way(self):
        # p = 0.10 puts the expected count at 2.0, one event short of the trigger. Here packing
        # events into runs *reduces* the share of windows that reach three: a run of six produces
        # one dense window region, while six spread-out events produce many windows that just reach
        # the trigger. So the sign of the arrangement effect is a property of where the trigger sits
        # relative to the mean, and no single correction factor exists.
        assert guard.beta_binomial_tail(3, 20, 0.1, 0.0) == pytest.approx(0.3231, abs=5e-4)
        assert guard.beta_binomial_tail(3, 20, 0.1, 0.1) == pytest.approx(0.3095, abs=5e-4)
        assert guard.beta_binomial_tail(3, 20, 0.1, 0.1) < guard.beta_binomial_tail(3, 20, 0.1, 0.0)

    def test_the_tail_falls_back_toward_the_mean_as_dispersion_goes_to_one(self):
        # At rho = 1 a window is either empty or full, so P(Y >= 3) is exactly the per-call rate.
        assert guard.beta_binomial_tail(3, 20, 0.048, 1.0) == pytest.approx(0.048, abs=1e-12)
        assert guard.beta_binomial_tail(3, 20, 0.048, 0.5) == pytest.approx(0.0986, abs=5e-4)

    def test_is_not_monotone_in_dispersion(self):
        low = guard.beta_binomial_tail(3, 20, 0.048, 0.1)
        high = guard.beta_binomial_tail(3, 20, 0.048, 0.9)
        assert low > high, "an operator who assumes more clustering means more firing is wrong here"

    def test_refuses_a_dispersion_it_cannot_apply(self):
        with pytest.raises(ValueError, match="rho must be in"):
            guard.beta_binomial_tail(3, 20, 0.048, -0.1)
        with pytest.raises(ValueError, match="mean must be in"):
            guard.beta_binomial_tail(3, 20, 1.2, 0.1)


class TestTheIntraclassCorrelation:
    def test_a_perfectly_packed_sequence_is_maximally_correlated(self):
        assert guard.intraclass_correlation([1, 1, 0, 0, 1, 1, 0, 0], 2) == pytest.approx(1.0)

    def test_a_perfectly_alternating_sequence_is_maximally_anti_correlated(self):
        # Negative values are real and the beta-binomial cannot represent them, which is why the
        # estimator reports what it computes instead of clamping.
        assert guard.intraclass_correlation([1, 0] * 10, 2) == pytest.approx(-1.0)

    def test_a_constant_sequence_carries_no_dispersion_information(self):
        # MSB and MSW are both zero, so the ratio is 0/0. Returning 0.0 would claim "exchangeable",
        # which is a measurement this sequence cannot support.
        assert guard.intraclass_correlation([0] * 40, 20) is None
        assert guard.intraclass_correlation([1] * 40, 20) is None

    def test_needs_at_least_two_windows(self):
        assert guard.intraclass_correlation([1, 0, 1], 20) is None

    def test_the_remainder_is_dropped_rather_than_padded(self):
        # 45 calls is two windows of 20 plus five calls that belong to no window; the last partial
        # window would otherwise contribute a mean computed from a different denominator.
        flags = [1] * 20 + [0] * 20 + [1] * 5
        assert guard.intraclass_correlation(flags, 20) == pytest.approx(1.0)


# --------------------------------------------------------------------------- stride and strata

class TestTheStride:
    def test_a_tumbling_stride_counts_the_windows_the_guard_actually_measures(self):
        # `DegradationGuard` resets a counter every GUARD_WINDOW calls; it does not slide. The tool
        # slid by default, which was a real mismatch between the thing measured and the thing
        # modelled -- so both are now reportable and the denominator follows the stride.
        flags = [True] * 20 + [False] * 20 + [True] * 20
        # 41 sliding starts: 0..17 see 20-s trues from the first run, 23..40 see s-20 from the
        # second, and the 22 starts in between see at most two.
        assert guard.window_fires(flags, 20, 3) == 36
        assert guard.window_fires(flags, 20, 3, stride=20) == 2  # tumbling
        assert guard.window_count(60, 20) == 41
        assert guard.window_count(60, 20, stride=20) == 3

    def test_a_trailing_partial_window_is_not_counted(self):
        assert guard.window_count(45, 20, stride=20) == 2

    def test_refuses_a_stride_it_cannot_apply(self):
        with pytest.raises(ValueError, match="stride must be positive"):
            guard.window_fires([True] * 40, 20, 3, stride=0)


class TestTheCumulativeRisk:
    """A latching alarm is not described by its per-window rate.

    SPC quotes an average run length, `1 / p` windows, and that formula assumes the process keeps
    running after an alarm. `DegradationGuard` does not: one downgrade is permanent, so the quantity
    an operator experiences is the probability of *ever* firing, which is `1 - (1 - p)^n` and grows
    with the length of the deployment.
    """

    def test_matches_the_hand_computation(self):
        # 1 - 0.95^25 = 0.7226. Twenty-five windows is one 500-question run.
        assert guard.ever_fires(0.05, 25) == pytest.approx(0.72261, abs=5e-5)

    def test_is_the_average_run_length_inverted_only_at_one_window(self):
        assert guard.ever_fires(0.05, 1) == pytest.approx(0.05)
        assert 1 / 0.05 == pytest.approx(20.0)  # the ARL0 SPC would quote, and what it hides

    def test_is_certain_at_a_certain_rate_and_zero_at_zero(self):
        assert guard.ever_fires(0.0, 1000) == 0.0
        assert guard.ever_fires(1.0, 1) == 1.0

    def test_grows_with_exposure(self):
        assert guard.ever_fires(0.05, 50) > guard.ever_fires(0.05, 25) > guard.ever_fires(0.05, 1)

    def test_requiring_two_consecutive_windows_takes_it_from_seventy_two_to_six_percent(self):
        # The shipped guard requires persistence, so the number an operator meets is this one. The
        # 13x is what made the rule change worth making: a permanently downgraded deployment is not
        # something 72% of working readers should experience in a single run.
        assert guard.ever_fires(0.05, 25, 2) == pytest.approx(0.05583, abs=5e-5)
        assert guard.ever_fires(0.05, 25) / guard.ever_fires(0.05, 25, 2) > 12.9

    def test_a_reader_that_fails_every_call_is_still_caught_by_the_persistence_rule(self):
        assert guard.ever_fires(0.95, 25, 2) > 0.999

    def test_a_longer_persistence_can_never_raise_the_risk(self):
        risks = [guard.ever_fires(0.3, 25, needed) for needed in (1, 2, 3, 4)]
        assert risks == sorted(risks, reverse=True)

    def test_cannot_persist_longer_than_the_exposure(self):
        assert guard.ever_fires(0.5, 1, 2) == 0.0

    def test_refuses_a_rate_or_length_it_cannot_apply(self):
        with pytest.raises(ValueError, match="rate must be in"):
            guard.ever_fires(1.5, 10)
        with pytest.raises(ValueError, match="windows must be"):
            guard.ever_fires(0.05, 0)
        with pytest.raises(ValueError, match="needed must be"):
            guard.ever_fires(0.05, 10, 0)


class TestTheStrata:
    def test_a_window_never_spans_two_strata(self):
        # The benchmark groups questions by capability, so a window that straddles a boundary mixes
        # two populations and the exchangeability the rate model needs is exactly what it loses.
        flags = [True] * 6 + [False] * 10 + [True] * 6 + [False] * 10
        strata = ["IE"] * 16 + ["MR"] * 16
        fired, windows = guard.stratum_fires(flags, strata, 20, 3)
        assert windows == 0
        # The same flags without the boundary restriction: one window starts inside each run.
        assert guard.window_fires(flags, 20, 3) >= 1

    def test_the_denominator_is_summed_per_stratum(self):
        flags = [True] * 25 + [False] * 25
        strata = ["A"] * 25 + ["B"] * 25
        fired, windows = guard.stratum_fires(flags, strata, 20, 1)
        assert windows == 6 + 6
        assert fired == 6 + 0

    def test_refuses_a_stream_that_does_not_line_up_with_its_labels(self):
        with pytest.raises(ValueError, match="strata must align"):
            guard.stratum_fires([True, False], ["A"], 1, 1)
