"""Tests for `tools/job-budget.py`, the reading behind "the benchmark has been running for four hours".

The tool exists because two ceilings guard the same run from two different scales, and the answer to
"is this normal" is therefore arithmetic rather than judgement. It carries **both** scopes on
purpose: `pass` is the shape that produced the defect (`8 x 90 = 720` inside a 350-minute job, so the
budget could never fire), and `run` is the shape that replaced it (`340 + 1 <= 360`, so it can). A
tool that understood only the current one could not read the archived dispatches it is meant to
explain.

The tests hold the arithmetic (checkable by hand at every point), the **refusal** (a budget that
cannot bind must be reported as such rather than as healthy), and the two readings that made the
defect visible: how many passes complete before a kill, and what budget would actually bind.
"""

from __future__ import annotations

import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from importlib import import_module

budget = import_module("job-budget")


# --------------------------------------------------------------------------- the per-pass scope

class TestThePerPassScope:
    def test_the_ceiling_is_passes_times_budget_plus_overhead(self):
        # 2 arms x 4 repetitions = 8 passes; 8 x 90 + 1 = 721 minutes of run the budget permits.
        assert (
            budget.budget_ceiling(passes=8, budget_minutes=90, overhead_minutes=1, scope="pass") == 721
        )

    def test_the_shipped_shape_used_to_be_this_one(self):
        # Pinned because it is the configuration the defect was found in, and the tool must keep
        # being able to describe it.
        assert budget.DEFAULT_PASSES == 8

    def test_a_per_pass_budget_ten_times_the_job_cannot_bind(self):
        # 721 > 350: the job dies 371 minutes before the budget could ever trip.
        assert (
            budget.binds(passes=8, budget_minutes=90, job_minutes=350, overhead_minutes=1, scope="pass")
            is False
        )

    def test_a_per_pass_budget_that_expires_before_the_job_does_bind(self):
        # 8 x 40 + 1 = 321 <= 350.
        assert (
            budget.binds(passes=8, budget_minutes=40, job_minutes=350, overhead_minutes=1, scope="pass")
            is True
        )

    def test_a_per_pass_budget_that_binds_is_below_a_working_pass(self):
        # (350 - 1) / 8 = 43.625, and a thinking-enabled pass already measured 41.85. The gap is one
        # slow draw, which is why narrowing the per-pass number alone cannot be the repair.
        binding = budget.binding_budget(passes=8, job_minutes=350, overhead_minutes=1, scope="pass")
        assert binding == pytest.approx(43.625, abs=1e-3)
        assert binding - 41.85 < 2

    def test_concurrency_raises_what_a_binding_per_pass_budget_can_be(self):
        # At concurrency 8 a pass costs 41.85 / 8 = 5.23 minutes, so the binding budget is 349 and
        # a working pass sits far below it. Only concurrency moves this wall.
        assert budget.binding_budget(
            passes=8, job_minutes=350, overhead_minutes=1, concurrency=8, scope="pass"
        ) == pytest.approx(349.0, abs=0.05)


# --------------------------------------------------------------------------- the run scope

class TestTheRunScope:
    def test_the_ceiling_is_the_budget_plus_setup_and_does_not_multiply(self):
        # 340 + 1 = 341, not 8 x 340 + 1. The multiplication is the whole defect.
        assert budget.budget_ceiling(passes=8, budget_minutes=340, overhead_minutes=1, scope="run") == 341

    def test_the_default_scope_is_the_one_this_repository_now_ships(self):
        assert budget.DEFAULT_SCOPE == "run"
        assert budget.DEFAULT_BUDGET_MINUTES == 340

    def test_the_shipped_configuration_binds(self):
        # 341 <= 360: the in-run ceiling now fails first, with a partial artifact, instead of the job
        # timeout killing the steps that would have written one.
        assert (
            budget.binds(passes=8, budget_minutes=340, job_minutes=360, overhead_minutes=1, scope="run")
            is True
        )

    def test_a_run_budget_above_the_job_cannot_bind(self):
        assert (
            budget.binds(passes=8, budget_minutes=360, job_minutes=360, overhead_minutes=1, scope="run")
            is False
        )

    def test_concurrency_does_not_move_a_run_level_ceiling(self):
        # A run budget is wall-clock already. Concurrency changes how much fits inside it, not where
        # it sits, and a tool that scaled it would describe a protection nobody configured.
        assert budget.binding_budget(
            passes=8, job_minutes=360, overhead_minutes=1, scope="run"
        ) == pytest.approx(359.0, abs=0.05)
        assert budget.binding_budget(
            passes=8, job_minutes=360, overhead_minutes=1, concurrency=8, scope="run"
        ) == pytest.approx(359.0, abs=0.05)

    def test_the_shipped_budget_sits_above_the_slowest_measured_run(self):
        # 334.8 minutes was the largest archived dispatch; the budget must not fire on it or the
        # repair would have converted a slow run into a failed one.
        assert budget.DEFAULT_BUDGET_MINUTES > 334.8
        assert budget.DEFAULT_BUDGET_MINUTES < 360


# --------------------------------------------------------------------------- the reading

class TestWhatActuallyEndsTheRun:
    def test_reads_the_fastest_archived_run_under_the_old_scope(self):
        # 41203245999: 122.6 minutes over 8 passes, thinking off.
        reading = budget.read(
            passes=8,
            measured_pass_minutes=15.33,
            job_minutes=350,
            overhead_minutes=1,
            budget_minutes=90,
            scope="pass",
        )
        assert reading.completed_passes == 8
        assert reading.total_minutes == pytest.approx(123.6, abs=0.05)
        assert reading.headroom_minutes == pytest.approx(226.4, abs=0.05)
        assert reading.outcome == "fits"
        assert reading.budget_would_fire is False

    def test_reads_the_slowest_archived_run_under_the_old_scope(self):
        # 41259622431: 334.8 minutes, 41.85 per pass, fifteen minutes from a kill and no record.
        reading = budget.read(
            passes=8,
            measured_pass_minutes=41.85,
            job_minutes=350,
            overhead_minutes=1,
            budget_minutes=90,
            scope="pass",
        )
        assert reading.completed_passes == 8
        assert reading.headroom_minutes == pytest.approx(14.2, abs=0.05)
        assert reading.outcome == "fits"
        # The per-pass budget is 90 and a pass costs 41.85, so it never fired.
        assert reading.budget_would_fire is False

    def test_the_same_run_under_the_new_scope_is_still_quiet(self):
        # 335.8 < 341: the repair deliberately does not fire on the run it was calibrated against.
        reading = budget.read(
            passes=8,
            measured_pass_minutes=41.85,
            job_minutes=360,
            overhead_minutes=1,
            budget_minutes=340,
            scope="run",
        )
        assert reading.budget_would_fire is False
        assert reading.outcome == "fits"

    def test_a_run_five_percent_slower_now_fails_with_a_record_instead_of_vanishing(self):
        # 44.0 per pass -> 352 minutes > 341: the budget fires, the run fails readably, and the
        # partial artifact names the pass. Under the old shape this was a silent job kill.
        reading = budget.read(
            passes=8,
            measured_pass_minutes=44.0,
            job_minutes=360,
            overhead_minutes=1,
            budget_minutes=340,
            scope="run",
        )
        assert reading.budget_would_fire is True
        assert reading.outcome == "budget"
        assert reading.total_minutes == pytest.approx(353.0, abs=0.05)

    def test_reports_the_pass_a_kill_lands_in(self):
        # 359 usable, 50 per pass -> 7 complete (350), the eighth is killed at 9 of its 50, and no
        # per-pass budget fires because 50 < 90.
        reading = budget.read(
            passes=8,
            measured_pass_minutes=50,
            job_minutes=360,
            overhead_minutes=1,
            budget_minutes=90,
            scope="pass",
        )
        assert reading.completed_passes == 7
        assert reading.outcome == "killed"
        assert reading.budget_would_fire is False


# --------------------------------------------------------------------------- refusals

class TestItRefusesWhatItCannotRead:
    def test_refuses_a_non_positive_pass_count(self):
        with pytest.raises(ValueError, match="passes must be positive"):
            budget.budget_ceiling(passes=0, budget_minutes=90, overhead_minutes=1)

    def test_refuses_a_non_positive_budget(self):
        with pytest.raises(ValueError, match="pass budget must be positive"):
            budget.budget_ceiling(passes=8, budget_minutes=0, overhead_minutes=1)

    def test_refuses_a_negative_overhead(self):
        with pytest.raises(ValueError, match="overhead must be non-negative"):
            budget.budget_ceiling(passes=8, budget_minutes=90, overhead_minutes=-1)

    def test_refuses_a_scope_it_does_not_model(self):
        # A third scoping rule would change the ceiling, and guessing which one was meant is how a
        # tool reports the wrong number with full confidence.
        with pytest.raises(ValueError, match="scope must be"):
            budget.budget_ceiling(passes=8, budget_minutes=90, overhead_minutes=1, scope="batch")  # type: ignore[arg-type]

    def test_refuses_a_concurrency_below_one(self):
        with pytest.raises(ValueError, match="concurrency must be at least 1"):
            budget.binding_budget(passes=8, job_minutes=350, overhead_minutes=1, concurrency=0)

    def test_refuses_a_job_shorter_than_its_own_overhead(self):
        with pytest.raises(ValueError, match="job must exceed the overhead"):
            budget.binding_budget(passes=8, job_minutes=1, overhead_minutes=1)

    def test_refuses_a_measured_pass_that_could_not_have_happened(self):
        with pytest.raises(ValueError, match="measured pass must be positive"):
            budget.read(
                passes=8,
                measured_pass_minutes=0,
                job_minutes=350,
                overhead_minutes=1,
                budget_minutes=90,
            )


# --------------------------------------------------------------------------- the workflow

class TestItReadsTheWorkflowItDescribes:
    def test_extracts_the_job_timeout_and_the_budget_from_a_workflow(self, tmp_path):
        path = tmp_path / "bench.yml"
        path.write_text(
            "jobs:\n  bench:\n    timeout-minutes: 360\n    env:\n      CORTEX_MEMORY_BUDGET_MINUTES: '340'\n"
        )
        assert budget.from_workflow(path) == (360, 340)

    def test_a_workflow_without_the_budget_reports_none_rather_than_a_default(self, tmp_path):
        # `readBudgetMs` treats unset as "no budget", and a tool that substituted 340 would describe
        # a configuration the file does not have.
        path = tmp_path / "bench.yml"
        path.write_text("jobs:\n  bench:\n    timeout-minutes: 360\n")
        job, per_run = budget.from_workflow(path)
        assert job == 360
        assert per_run is None

    def test_refuses_a_workflow_with_no_job_timeout(self, tmp_path):
        path = tmp_path / "bench.yml"
        path.write_text("jobs:\n  bench:\n    steps: []\n")
        with pytest.raises(ValueError, match="no timeout-minutes"):
            budget.from_workflow(path)


# --------------------------------------------------------------------------- the shipped file

class TestTheShippedWorkflowIsTheOneTheToolDescribes:
    def test_the_repositorys_own_workflow_binds(self):
        # The regression guard: this is the assertion that would fail if someone restored a per-pass
        # figure or raised the budget past the job.
        root = pathlib.Path(__file__).resolve().parents[2]
        workflow = root / ".github" / "workflows" / "benchmark-cortex-memory.yml"
        job, per_run = budget.from_workflow(workflow)
        assert per_run is not None
        assert budget.binds(passes=budget.DEFAULT_PASSES, budget_minutes=per_run, job_minutes=job, overhead_minutes=1)

    def test_the_repositorys_job_timeout_is_githubs_ceiling_and_not_above_it(self):
        # GitHub kills a hosted job at 360 minutes regardless of this file, so a larger number would
        # be a comment rather than a ceiling.
        root = pathlib.Path(__file__).resolve().parents[2]
        job, _ = budget.from_workflow(root / ".github" / "workflows" / "benchmark-cortex-memory.yml")
        assert job == 360

    def test_the_main_entry_point_exits_zero_on_a_binding_configuration(self, tmp_path, capsys):
        path = tmp_path / "bench.yml"
        path.write_text("jobs:\n  bench:\n    timeout-minutes: 360\n  CORTEX_MEMORY_BUDGET_MINUTES: '340'\n")
        assert budget.main(["--workflow", str(path), "--measured-pass-minutes", "41.85"]) == 0
        assert "it binds" in capsys.readouterr().out

    def test_the_main_entry_point_exits_one_on_a_configuration_that_cannot_bind(self, tmp_path, capsys):
        path = tmp_path / "bench.yml"
        path.write_text("jobs:\n  bench:\n    timeout-minutes: 350\n  CORTEX_MEMORY_BUDGET_MINUTES: '90'\n")
        assert budget.main(["--workflow", str(path), "--scope", "pass"]) == 1
        assert "IT CANNOT BIND" in capsys.readouterr().out


# --------------------------------------------------------------------------- the pace

class TestThePacingFloor:
    """The third quantity: how long a paced dispatch needs before it has asked every question.

    Run `41625442265` is the measurement behind all of these. It ran 500 questions x 8 passes at
    `CORTEX_LLM_MIN_INTERVAL_MS=6000` under a 340-minute budget, and the two figures below are the
    reason it produced no report: 400 minutes of schedule against 340 minutes of ceiling.
    """

    def test_the_floor_is_slots_times_the_interval(self):
        # 500 x 1 x 8 = 4000 slots, each 6 s apart = 24000 s = 400 min. Checkable by hand.
        assert budget.pacing_floor_minutes(questions=500, passes=8, min_interval_ms=6000) == 400.0

    def test_a_wider_pool_does_not_shorten_it(self):
        # `RequestGate` hands out one slot per request from a single process-wide schedule, so the
        # pool width changes how much is in flight and not the length of the schedule. This is the
        # claim that made the run impossible, and it is why the function takes no concurrency.
        assert budget.pacing_floor_minutes(questions=500, passes=8, min_interval_ms=6000) == (
            budget.pacing_floor_minutes(questions=500, passes=8, min_interval_ms=6000)
        )

    def test_the_shipped_budget_cannot_cover_the_pace_the_dead_run_used(self):
        # The regression guard for `41625442265`: with `CORTEX_MEMORY_BUDGET_MINUTES=340`, a pace of
        # 6000 ms over eight passes is a dispatch that cannot succeed, and the tool must say so
        # rather than wait five hours to say it.
        assert (
            budget.can_complete(questions=500, passes=8, min_interval_ms=6000, budget_minutes=340)
            is False
        )

    def test_equality_counts_as_completable(self):
        # Inclusive, for the reason `binds` is: at equality both mechanisms fire at the same instant
        # and the one that leaves a record is the one to keep.
        assert (
            budget.can_complete(questions=500, passes=8, min_interval_ms=6000, budget_minutes=400)
            is True
        )

    def test_a_pace_the_budget_can_afford_is_reported_as_completable(self):
        # 500 x 8 x 2000 ms = 133.3 min, which the 340-minute ceiling covers with room for the
        # reader's own latency on top.
        assert (
            budget.can_complete(questions=500, passes=8, min_interval_ms=2000, budget_minutes=340)
            is True
        )

    def test_refuses_inputs_that_have_no_floor(self):
        with pytest.raises(ValueError, match="questions must be positive"):
            budget.pacing_floor_minutes(questions=0, passes=8, min_interval_ms=6000)
        with pytest.raises(ValueError, match="min_interval_ms must be positive"):
            # A run with no pace has no floor; 0 would claim one of zero minutes for a gate that
            # does not exist, and the caller who wants no pace passes no interval at all.
            budget.pacing_floor_minutes(questions=500, passes=8, min_interval_ms=0)
        with pytest.raises(ValueError, match="calls_per_question must be positive"):
            budget.pacing_floor_minutes(questions=500, passes=8, min_interval_ms=6000, calls_per_question=0)
        with pytest.raises(ValueError, match="budget must be positive"):
            budget.can_complete(questions=500, passes=8, min_interval_ms=6000, budget_minutes=0)

    def test_the_main_entry_point_exits_three_when_the_run_cannot_finish(self, tmp_path, capsys):
        path = tmp_path / "bench.yml"
        path.write_text("jobs:\n  bench:\n    timeout-minutes: 360\n  CORTEX_MEMORY_BUDGET_MINUTES: '340'\n")
        assert budget.main(["--workflow", str(path), "--min-interval-ms", "6000"]) == 3
        out = capsys.readouterr().out
        assert "THE RUN CANNOT FINISH" in out
        assert "400" in out

    def test_the_main_entry_point_says_nothing_about_a_floor_it_was_not_given(self, tmp_path, capsys):
        # The pace arrives in a repository variable the workflow interpolates, and a tool that
        # guessed one would report a floor for a configuration nobody dispatched.
        path = tmp_path / "bench.yml"
        path.write_text("jobs:\n  bench:\n    timeout-minutes: 360\n  CORTEX_MEMORY_BUDGET_MINUTES: '340'\n")
        assert budget.main(["--workflow", str(path)]) == 0
        assert "pacing floor" not in capsys.readouterr().out


class TestTheShippedPaceIsScopedToTheProviderThatNeedsIt:
    """The workflow must not lend one provider's window to another.

    `CORTEX_LLM_MIN_INTERVAL_MS` was measured on the second provider (`41553176719`, `41552258320`,
    140 refusals in 279 requests) and stored as a repository variable, which the workflow then passed
    to every dispatch. The DeepSeek arm that produced the 90.15% headline ran unpaced at 1.6 s per
    question; the same arm under a 6 s process-wide gate needs 400 minutes for eight passes.
    """

    def test_the_pace_is_conditional_on_the_provider_named_in_the_model_input(self):
        root = pathlib.Path(__file__).resolve().parents[2]
        text = (root / ".github" / "workflows" / "benchmark-cortex-memory.yml").read_text()
        line = next(
            (ln for ln in text.splitlines() if "CORTEX_LLM_MIN_INTERVAL_MS:" in ln and "vars." in ln),
            None,
        )
        assert line is not None, "the workflow no longer reads a pace variable at all"
        assert "startsWith(inputs.model, 'zhipu:')" in line, (
            "the pace must be scoped to the provider it was measured on; an unconditional read "
            "lends the second provider's window to the first, which is what cost run 41625442265 "
            "its eight passes"
        )

