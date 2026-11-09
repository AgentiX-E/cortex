"""The spend gate on the dispatch path: a run that cannot be afforded must not start.

## The defect this file is written against

`tools/dispatch-cortex-memory-ab.py` sent a dispatch in one step. Every guard on that path was about
*whether the configuration is the one the operator meant* -- the staleness check, the declared
departures, the `--set` parser's refusal of anything it does not recognise -- and none of them was
about *whether the run is affordable*. Those are independent questions, and the second one has no
repair: a dispatch is billed when it starts, and a run whose configuration was wrong at least
produces an artifact that says so.

The archive makes the size of that gap a number rather than an argument. One full pass of the
cortex-memory A/B -- the configuration `INPUTS` carries -- costs 14.26 CNY, and the screening
configuration that answers the same question about a change costs 2.85 CNY. Both are one line of
input, both print the same "dispatching" banner, and nothing in the log distinguished them.

## Why the gate is on the projection and not on the inputs

A rule like "refuse `limit: 0`" would catch the expensive dispatch and would also refuse a full pass
that somebody deliberately bought, which is the run the pre-registration is written for. The
quantity that decides is money, so the gate reads money, and `--budget N` is how a deliberate
purchase is stated.

## Why the flags are split before the dispatch parser sees them

`parse_argv` refuses any argument that is not `--set`, and it is right to: on this path an
unrecognised argument is a dispatch that was not asked for. Widening it would make `--set` one
spelling among four and lose the refusal that keeps a typo from running the control arm, so the
spend flags are separated first and the dispatch flags are handed over unchanged.
"""

import importlib.util
import json
import pathlib

import pytest

REPO = pathlib.Path(__file__).resolve().parents[2]
DISPATCH = REPO / "tools" / "dispatch-cortex-memory-ab.py"


def _module():
    spec = importlib.util.spec_from_file_location("dispatch_cortex_memory_ab", DISPATCH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def dispatch():
    return _module()


class TestSplitFinance:
    def test_no_flags_leaves_the_default_budget_and_no_overrides(self, dispatch):
        rest, finance = dispatch.split_finance([])
        assert rest == []
        assert finance["budget"] == dispatch.DEFAULT_BUDGET_CNY

    def test_screening_sets_the_two_inputs_and_nothing_else(self, dispatch):
        rest, finance = dispatch.split_finance(["--screening"])
        assert rest == ["--set", "limit=200", "--set", "ablation_runs=2"]
        assert finance["budget"] == dispatch.DEFAULT_BUDGET_CNY

    def test_a_named_budget_replaces_the_default(self, dispatch):
        rest, finance = dispatch.split_finance(["--budget", "20"])
        assert rest == []
        assert finance["budget"] == 20.0

    def test_the_equals_spelling_is_the_same_flag(self, dispatch):
        _, finance = dispatch.split_finance(["--budget=20"])
        assert finance["budget"] == 20.0

    def test_no_budget_disables_the_gate_rather_than_pricing_it_at_zero(self, dispatch):
        # `0` and `None` are different: a zero budget refuses every dispatch, and the flag that
        # means "do not gate this one" is not the flag that means "gate it at nothing".
        _, finance = dispatch.split_finance(["--no-budget"])
        assert finance["budget"] is None

    def test_a_budget_without_a_value_is_refused(self, dispatch):
        with pytest.raises(SystemExit):
            dispatch.split_finance(["--budget"])

    def test_dispatch_flags_pass_through_untouched(self, dispatch):
        rest, _ = dispatch.split_finance(["--set", "cortex_memory_ask=sweep"])
        assert rest == ["--set", "cortex_memory_ask=sweep"]


class TestProjectedSpend:
    def test_the_full_pass_is_refused_at_the_default_budget(self, dispatch):
        inputs = dict(dispatch.INPUTS)
        inputs["limit"] = "0"
        inputs["ablation_runs"] = "4"
        with pytest.raises(SystemExit) as raised:
            dispatch.projected_spend(inputs, dispatch.DEFAULT_BUDGET_CNY)
        message = str(raised.value)
        assert "14.26" in message or "budget" in message.lower()

    def test_the_screening_configuration_passes_at_the_default_budget(self, dispatch):
        inputs = dict(dispatch.INPUTS)
        inputs["limit"] = "200"
        inputs["ablation_runs"] = "2"
        # Returns rather than raises: 2.85 CNY is under the 3.00 ceiling.
        assert dispatch.projected_spend(inputs, dispatch.DEFAULT_BUDGET_CNY) is None

    def test_the_full_pass_passes_when_the_budget_says_so(self, dispatch):
        inputs = dict(dispatch.INPUTS)
        inputs["limit"] = "0"
        inputs["ablation_runs"] = "4"
        assert dispatch.projected_spend(inputs, 20.0) is None

    def test_an_unreadable_baseline_does_not_block_the_dispatch(self, dispatch, tmp_path, monkeypatch):
        # An instrument that cannot run is not a reason to stop working -- but the log has to say
        # the run went unpriced rather than leave a reader to assume it was measured.
        missing = tmp_path / "no-such-baseline.json"
        monkeypatch.setattr(dispatch, "SPEND_BASELINE", missing)
        inputs = dict(dispatch.INPUTS)
        inputs["limit"] = "0"
        assert dispatch.projected_spend(inputs, 3.0) is None

    def test_limit_zero_is_priced_as_the_whole_dataset(self, dispatch, capsys):
        # `limit: '0'` is the workflow's spelling for "every question". Read literally it is zero
        # questions, which would price the most expensive dispatch at nothing and then refuse it
        # for dividing by zero -- the one reading nobody has ever meant.
        inputs = dict(dispatch.INPUTS)
        inputs["limit"] = "0"
        inputs["ablation_runs"] = "4"
        dispatch.projected_spend(inputs, 1000.0)
        printed = capsys.readouterr().out
        assert "500 questions" in printed


class TestCapabilityScopedPricing:
    """The gate and the projection have to price the same dispatch.

    A capability scoped run is priced off the observed census (`MR` is 121 of 500 questions), so a
    projection that scaled the whole file would report 200 questions for a 121 question run. The
    mis-pricing is not hypothetical: the selector exists so a 4.8 question effect can be read for
    under two yuan, and at 200 questions x 2 runs the projection reads 2.85 CNY while the dispatch
    actually buys 121 questions. Cheap and expensive would again look alike at the moment of
    choosing -- the defect the gate was built against, one layer up.
    """

    def test_a_capability_run_is_priced_on_the_census(self, dispatch, capsys):
        inputs = dict(dispatch.INPUTS)
        inputs["limit"] = "0"
        inputs["ablation_runs"] = "2"
        inputs["capability"] = "MR"
        assert dispatch.projected_spend(inputs, dispatch.DEFAULT_BUDGET_CNY) is None
        printed = capsys.readouterr().out
        assert "capability MR" in printed
        assert "500 questions" not in printed

    def test_the_whole_file_and_the_capability_are_different_numbers(self, dispatch, capsys):
        # 121/500 x 2/4 = scale 0.121, so 14.26 CNY reads 1.73. The assertion is on the total line
        # rather than on a substring of any line, because the per-line figures happen to contain
        # "0.83" for the output row and a looser check would pass on the wrong number.
        inputs = dict(dispatch.INPUTS)
        inputs["limit"] = "0"
        inputs["ablation_runs"] = "2"
        inputs["capability"] = "MR"
        dispatch.projected_spend(inputs, 1000.0)
        total = [line for line in capsys.readouterr().out.splitlines() if "TOTAL" in line]
        assert len(total) == 1
        assert "1.73" in total[0]

    def test_a_partial_limit_with_a_capability_is_refused_rather_than_overridden(self, dispatch):
        # Silently dropping `limit` here would dispatch a run bigger than the one that was asked
        # for, so the gate passes the pair through and lets the projection refuse it by name.
        inputs = dict(dispatch.INPUTS)
        inputs["limit"] = "200"
        inputs["ablation_runs"] = "2"
        inputs["capability"] = "MR"
        with pytest.raises(SystemExit) as raised:
            dispatch.projected_spend(inputs, 1000.0)
        assert "not projectable" in str(raised.value)

    def test_a_refusal_that_is_not_about_money_does_not_advise_a_budget(self, dispatch):
        # `--screening` does not fix an unpriceable input pair. The ladder is advice about money and
        # is offered only when money is what refused.
        inputs = dict(dispatch.INPUTS)
        inputs["limit"] = "200"
        inputs["ablation_runs"] = "2"
        inputs["capability"] = "MR"
        with pytest.raises(SystemExit) as raised:
            dispatch.projected_spend(inputs, 1000.0)
        assert "--screening" not in str(raised.value)

    def test_the_projection_refusal_is_quoted_back_verbatim(self, dispatch):
        # The reason lives on stdout as `REFUSED: <why>`. Dropping it leaves the operator with the
        # generic "the projection was refused" and no way to know which input to change.
        inputs = dict(dispatch.INPUTS)
        inputs["limit"] = "0"
        inputs["ablation_runs"] = "2"
        inputs["capability"] = "XX"
        with pytest.raises(SystemExit) as raised:
            dispatch.projected_spend(inputs, dispatch.DEFAULT_BUDGET_CNY)
        assert "carries no XX" in str(raised.value)

    def test_all_is_the_identity_and_is_not_passed(self, dispatch, capsys):
        inputs = dict(dispatch.INPUTS)
        inputs["limit"] = "0"
        inputs["ablation_runs"] = "4"
        inputs["capability"] = "all"
        dispatch.projected_spend(inputs, 1000.0)
        printed = capsys.readouterr().out
        assert "500 questions" in printed
        assert "capability" not in printed


class TestBaselineIsTheArchivedRun:
    def test_the_baseline_names_the_run_it_is_read_from(self):
        baseline = json.loads((REPO / "tools" / "spend-baseline.json").read_text())
        assert baseline["runId"] == "42467"
        assert baseline["questionCount"] == 500
        assert baseline["llmUsage"]["promptTokens"] == 27_233_394
        assert baseline["memoryArmConfig"]["reader"]["thinkingRoutes"] == ["multi-session", "temporal"]
