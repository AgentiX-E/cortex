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


class TestTheNumbersTheAuditQuotes:
    def test_the_uniform_prediction_for_the_published_decline_rate_is_about_fourteen_percent(self):
        # 32 of 500 is run 41254359622's measured decline rate. If calls were exchangeable, a
        # 20-call window would fire 1 - P(0) - P(1) - P(2) of the time at p = 0.064.
        assert guard.binomial_tail(3, 20, 32 / 500) == pytest.approx(0.1327, abs=5e-4)

    def test_the_same_number_of_events_fires_or_not_depending_only_on_their_arrangement(self):
        # 41254359622's declines arrive in runs of six -- indices 64..69, 126..131, 227..232,
        # 360..365 -- because LongMemEval groups questions by capability and the absent-capability
        # ones sit together. Measured, that sequence fires on 21.83% of windows against the 13.27%
        # an exchangeable model predicts: 1.65x. The guard's rule is "three of twenty", which is a
        # statement about a *rate*, and nothing in it can see arrangement -- so the same reader
        # trips it twice as often when the dataset happens to group the hard questions.
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
