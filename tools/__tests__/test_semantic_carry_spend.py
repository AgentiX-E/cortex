"""The spend gate on the two-window dispatch, which had none.

## The gap this closes

`semantic-carry.yml` was written as a separate workflow for a good reason -- it answers a different
question from `benchmark-cortex-memory.yml` -- and it inherited none of that workflow's guards. The
one that costs money is the spend gate: `dispatch-cortex-memory-ab.py` prices every dispatch it sends
and refuses one over `DEFAULT_BUDGET_CNY`, while this dispatch could ask for the registered
population (500 corpora x 2 windows x 4 repetitions x 2 sides) and start without a figure ever being
printed.

The registered population is the case that matters. On the screening shape the two-window run is
1.83 CNY, which no ceiling would ever catch; on the registered shape it is 25-96 CNY depending on
the cache mix, which is a purchase rather than an experiment. A gate that only sees the cheap one is
a gate that reports `ok` and means nothing.

## Why the projection is called rather than re-implemented

`spend-projection.mjs` already owns the arithmetic, the dated prices and the three refusals
(a sample that moved the capability shares, a changed thinking reach, a zero the division cannot
take). A second implementation here would be the `cost-ledger.py` defect one layer up: two readers
of one number who can disagree while both are right. So these tests pin that the dispatcher *calls*
it, with the arguments the workflow will actually run -- `windows` included.

## Why `windows` is a separate axis and not `limit = 2N`

`limit` is a sample of the file. `--limit 1000` on a 500-question baseline reads as a sample larger
than its population, and a reader who noticed would be right to distrust the rest of the block. The
axis is "each corpus asked twice", so it is named that way, in the tool and here.
"""

from __future__ import annotations

import importlib.util
import json
import pathlib

import pytest

REPO = pathlib.Path(__file__).resolve().parents[2]
DISPATCH = REPO / "tools" / "dispatch-semantic-carry.py"


def _module():
    spec = importlib.util.spec_from_file_location("dispatch_semantic_carry", DISPATCH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


@pytest.fixture(scope="module")
def dispatch():
    return _module()


class TestInputs:
    def test_the_defaults_are_the_screening_pair(self, dispatch):
        # `KU` x 2 windows x 2 repetitions is 144 questions per side, which is what the first
        # reading of `S13` was taken on. A default that had drifted to `all` would be a 34x purchase
        # nobody typed.
        assert dispatch.INPUTS["windows"] == "2"
        assert dispatch.INPUTS["capability"] == "KU"
        assert dispatch.INPUTS["ablation_runs"] == "2"

    def test_the_budget_input_is_declared(self, dispatch):
        # The workflow's own gate reads it, so it has to be sent. `test_dispatch_inputs.py` checks
        # the other direction -- that every key sent is declared -- and this is the half that would
        # otherwise be a knob the workflow has and the dispatcher never sets.
        assert "budget_cny" in dispatch.INPUTS


class TestProjection:
    def test_the_screening_pair_is_priced_and_passes_a_generous_budget(self, dispatch, capsys):
        inputs = dict(dispatch.INPUTS)
        assert dispatch.projected_spend(inputs, 120.0) is None
        printed = capsys.readouterr().out
        assert "Projected spend" in printed
        # The multiplication is visible in the log, not only in the total: 72 corpora asked twice is
        # 144 questions, and a reader who saw only "TOTAL 1.8 CNY" would not know that.
        assert "72 corpora x 2 windows = 144 questions" in printed

    def test_the_registered_population_names_all_five_hundred_corpora(self, dispatch, capsys):
        inputs = dict(dispatch.INPUTS)
        inputs["capability"] = "all"
        inputs["limit"] = "0"
        inputs["ablation_runs"] = "4"
        assert dispatch.projected_spend(inputs, 1000.0) is None
        printed = capsys.readouterr().out
        assert "500 corpora x 2 windows = 1000 questions" in printed

    def test_limit_zero_is_the_whole_file_and_not_zero_questions(self, dispatch, capsys):
        # The workflow's spelling for "everything". Read literally it prices the most expensive
        # dispatch at nothing -- and then the gate would pass it, which is worse than refusing it.
        inputs = dict(dispatch.INPUTS)
        inputs["capability"] = "all"
        inputs["limit"] = "0"
        dispatch.projected_spend(inputs, 1000.0)
        printed = capsys.readouterr().out
        assert "500 corpora x 2 windows = 1000 questions" in printed

    def test_a_budget_breach_refuses_before_the_dispatch_is_sent(self, dispatch):
        inputs = dict(dispatch.INPUTS)
        inputs["capability"] = "all"
        inputs["limit"] = "0"
        inputs["ablation_runs"] = "4"
        with pytest.raises(SystemExit) as raised:
            dispatch.projected_spend(inputs, 1.0)
        assert "BUDGET EXCEEDED" in str(raised.value)

    def test_a_capability_and_a_limit_together_are_refused_rather_than_guessed(self, dispatch):
        # The sampler round-robins over buckets, so `limit=40` then `capability=KU` selects however
        # many KU questions the first forty happened to include. The projection refuses it and so
        # does this dispatcher; a guess here would price a different run than the one that happens.
        inputs = dict(dispatch.INPUTS)
        inputs["limit"] = "40"
        with pytest.raises(SystemExit) as raised:
            dispatch.projected_spend(inputs, 120.0)
        assert "not projectable" in str(raised.value)

    def test_an_unreadable_baseline_does_not_block_the_dispatch(self, dispatch, tmp_path, monkeypatch):
        # An instrument that cannot run is not a reason to stop working. The log has to say the run
        # went unpriced rather than leave a reader to assume it was measured.
        monkeypatch.setattr(dispatch, "SPEND_BASELINE", tmp_path / "no-such-baseline.json")
        assert dispatch.projected_spend(dict(dispatch.INPUTS), 3.0) is None


class TestShippedBaseline:
    """One reading of the archived run, so the gate is not only ever tested on a fixture."""

    def test_the_registered_population_costs_more_than_the_screening_pair(self, dispatch, capsys):
        screening = dict(dispatch.INPUTS)
        dispatch.projected_spend(screening, 1000.0)
        cheap = capsys.readouterr().out
        registered = dict(dispatch.INPUTS)
        registered["capability"] = "all"
        registered["limit"] = "0"
        registered["ablation_runs"] = "4"
        dispatch.projected_spend(registered, 1000.0)
        dear = capsys.readouterr().out

        def total(block: str) -> float:
            for line in block.splitlines():
                if line.strip().startswith("TOTAL"):
                    return float(line.split()[1])
            raise AssertionError(f"no TOTAL line in {block!r}")

        # 144 questions x 2 runs against 1,000 x 4 is 13.9x the questions, and the ratio has to show
        # up in the money or one of the two projections is not reading the inputs it was handed.
        assert total(dear) == pytest.approx(total(cheap) * 13.9, rel=0.35)


def test_the_budget_default_is_the_approved_ceiling_not_the_screening_price(dispatch):
    # 3.00 CNY is `dispatch-cortex-memory-ab.py`'s default and is right there: it separates "a run
    # that answers a question about a change" from "a run that publishes a point estimate". Here the
    # point estimate IS the run this workflow exists for, so the default has to clear it -- and it
    # was approved at 25-96 CNY, so the ceiling carries headroom above the top of that band.
    assert dispatch.DEFAULT_BUDGET_CNY >= 96.0


def test_the_baseline_is_the_same_file_the_other_gate_prices_from(dispatch):
    # Two gates reading two histories would let one dispatch pass both while the other's baseline
    # said it could not be afforded.
    assert dispatch.SPEND_BASELINE == REPO / "tools" / "spend-baseline.json"
    assert json.loads(dispatch.SPEND_BASELINE.read_text())["questionCount"] == 500
