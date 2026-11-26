"""What a queue row costs, reproduced from a bill -- and the four ways a price can lie about itself.

`§205.6` ordered the queue with three prices beside it: 40-80 for a wider population, 12 for a MemCog
run, 8 for LoCoMo. Each of those numbers turned out to be a *correct* price for a *different design*,
and the difference between the designs is two repetitions of a bill and one unstated corpus size. So
these tests pin three things and refuse a fourth:

  - **a rate is a bill divided by work.** `5.87 / (121 x 2)` and nothing else. A rate rebuilt from
    `llmUsage` and a list price would be 2.4x to 5.1x the money spent, because `42467` hit the prefix
    cache on 96.0% of its prompt tokens; a test that let the rebuild in would be blessing a
    projection that contradicts the bill it came from.
  - **a label is a claim about provenance, not a decoration.** `billed` covers a population at or
    below the billed repetition count. `extrapolated` covers a larger population or more steps, and
    must say which. `proxy` covers a capability with no bill, named on the command line.
  - **a total sums a plan, not a menu.** The wider population at two repetitions is an alternative to
    it at one. Adding both is how `§204.7` reported 70-100 CNY for a plan nobody would ever run.

The refusal is the fourth thing: a capability with no bill and no named proxy is not floored here,
because a floor answers "what would this cost" and the queue is asking "should this be bought".
"""

import json
import pathlib
import subprocess

import pytest

TOOL = pathlib.Path(__file__).resolve().parents[1] / "queue-price.mjs"


def _run(body: str) -> str:
    script = f"import * as mod from {json.dumps(TOOL.as_uri())};\n{body}"
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout


_PREAMBLE = (
    "import { readFileSync } from 'node:fs';\n"
    "const rates = mod.ratesOf(JSON.parse(readFileSync(mod.BASELINE_PATH, 'utf8')));\n"
)


def _price(design: dict) -> dict:
    """`priceOf`, or the refusal's own message. A refusal is a result here, not a crash."""
    body = (
        _PREAMBLE
        + f"try {{ console.log(JSON.stringify({{ ok: mod.priceOf({json.dumps(design)}, rates) }})); }}\n"
        + "catch (e) { console.log(JSON.stringify({ name: e.name, message: e.message })); }"
    )
    return json.loads(_run(body))


def _row(design: dict) -> dict:
    return json.loads(_run(_PREAMBLE + f"console.log(JSON.stringify(mod.rowOf({json.dumps(design)}, rates)));"))


def _table() -> dict:
    return json.loads(_run(_PREAMBLE + "console.log(JSON.stringify(mod.tableOf(mod.QUEUE, rates)));"))


def _billed_rates() -> dict:
    body = _PREAMBLE + "console.log(JSON.stringify([...rates.byCapability].map(([k, v]) => [k, v.rate])));"
    return dict((name, rate) for name, rate in json.loads(_run(body)))


def _cli(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["node", str(TOOL), *args], capture_output=True, text=True, timeout=120)


class TestTheRateIsTheBill:
    def test_the_multi_session_rate_is_the_bill_divided_by_questions_and_runs(self):
        # 5.87 / (121 x 2) = 0.024256. The baseline states the bill and never the rounded rate,
        # because a stored 0.0243 would be a second number that disagrees with the first.
        priced = _price({"capability": "MR", "questions": 121, "reps": 2})["ok"]
        assert priced["cny"] == pytest.approx(5.87, abs=0.005)

    def test_the_file_average_is_not_used_for_a_route(self):
        # The file's per-question rate is 0.00713 and MR's is 0.024256 -- 3.40x. Accepting the file
        # average for an MR row would bless the exact 3.4x error §13.348 measured.
        rates = _billed_rates()
        assert rates["MR"] == pytest.approx(5.87 / 242, abs=1e-9)
        assert rates["MR"] > 3 * 0.00713

    def test_a_capability_with_no_bill_is_unknown_rather_than_zero(self):
        body = _PREAMBLE + "console.log(JSON.stringify(rates.byCapability.has('TR')));"
        assert json.loads(_run(body)) is False


class TestTheLabelsSayWhereTheNumberCameFrom:
    def test_billed_covers_this_population_at_the_billed_repetition_count(self):
        assert _price({"capability": "MR", "questions": 121, "reps": 2})["ok"]["basis"] == "billed"

    def test_a_larger_population_is_extrapolated_and_says_so(self):
        priced = _price({"capability": "MR", "questions": 431, "reps": 1, "population": "external"})["ok"]
        assert priced["basis"] == "extrapolated"
        assert "population" in priced["reason"]

    def test_more_agentic_steps_are_extrapolated_and_named(self):
        priced = _price({"capability": "MR", "questions": 121, "reps": 1, "steps": 2})["ok"]
        assert priced["basis"] == "extrapolated"
        assert "steps" in priced["reason"]

    def test_a_proxy_is_labelled_proxy_not_billed(self):
        priced = _price(
            {"capability": "TR", "proxy": "MR", "questions": 300, "reps": 1, "population": "external"}
        )["ok"]
        assert priced["basis"] == "proxy"
        assert "proxy" in priced["reason"]

    def test_the_proxy_rate_is_the_named_capability(self):
        own = _price({"capability": "MR", "questions": 300, "reps": 1, "population": "external"})["ok"]
        borrowed = _price(
            {"capability": "TR", "proxy": "MR", "questions": 300, "reps": 1, "population": "external"}
        )["ok"]
        assert borrowed["cny"] == pytest.approx(own["cny"], abs=1e-9)


class TestTheRetrievalSideCostsNothing:
    def test_a_retrieval_side_row_is_free_and_billed(self):
        priced = _price(
            {"capability": "MR", "questions": 431, "reps": 1, "population": "external", "reader": False}
        )["ok"]
        assert priced["cny"] == 0
        # `billed` and not `extrapolated`: zero calls is a measured zero, not a scaled estimate.
        assert priced["basis"] == "billed"

    def test_a_retrieval_side_row_cannot_take_agentic_steps(self):
        refusal = _price(
            {
                "capability": "MR",
                "questions": 431,
                "reps": 1,
                "population": "external",
                "reader": False,
                "steps": 2,
            }
        )
        assert refusal["name"] == "Refusal"
        assert "steps" in refusal["message"]

    def test_a_retrieval_side_row_still_has_to_name_its_population(self):
        # No reader call does not mean no population: 431 questions is not the 121-chapter corpus.
        refusal = _price({"capability": "MR", "questions": 431, "reps": 1, "reader": False})
        assert refusal["name"] == "Refusal"
        assert "external" in refusal["message"]


class TestTheFourRefusals:
    def test_refuses_a_capability_with_no_bill_and_no_proxy(self):
        refusal = _price({"capability": "TR", "questions": 10, "reps": 1})
        assert refusal["name"] == "Refusal"
        assert "no bill covers TR" in refusal["message"]

    def test_refuses_a_population_larger_than_the_corpus_unless_it_says_external(self):
        refusal = _price({"capability": "MR", "questions": 431, "reps": 1})
        assert refusal["name"] == "Refusal"
        assert "121 questions" in refusal["message"]

    def test_refuses_zero_repetitions(self):
        assert _price({"capability": "MR", "questions": 10, "reps": 0})["name"] == "Refusal"

    def test_refuses_zero_questions(self):
        assert _price({"capability": "MR", "questions": 0, "reps": 1})["name"] == "Refusal"

    def test_the_refusal_names_the_two_ways_forward(self):
        result = _cli("--questions", "10", "--capability", "TR", "--reps", "1")
        assert result.returncode == 1
        payload = json.loads(result.stdout)
        assert "dispatch a screening configuration" in payload["refusal"]
        assert "--proxy" in payload["refusal"]


class TestTheProbeRule:
    def test_a_row_at_the_threshold_without_a_probe_is_refused(self):
        row = _row({"capability": "MR", "questions": 431, "reps": 4, "population": "external"})
        assert row["refusal"] is not None
        assert "probe" in row["refusal"]

    def test_a_row_at_the_threshold_with_a_free_probe_is_buyable(self):
        row = _row({"capability": "MR", "questions": 431, "reps": 4, "population": "external", "probeCny": 0})
        assert row["refusal"] is None

    def test_a_row_below_the_threshold_needs_no_probe(self):
        row = _row({"capability": "MR", "questions": 121, "reps": 1, "steps": 2})
        assert row["refusal"] is None
        assert row["cny"] < 10

    def test_a_probe_must_be_cheap_enough_to_be_a_probe(self):
        # 1.00 CNY is not a probe at a 10 CNY threshold question; the rule's own number is 0.5.
        row = _row(
            {"capability": "MR", "questions": 431, "reps": 4, "population": "external", "probeCny": 1.0}
        )
        assert row["refusal"] is not None


class TestTheTotalIsAPlanNotAMenu:
    def test_the_queue_has_six_rows(self):
        assert len(_table()["rows"]) == 6

    def test_the_first_row_is_free_and_the_probe_it_buys_can_falsify_the_fourth(self):
        rows = _table()["rows"]
        assert rows[0]["cny"] == 0
        # The probe is free and the row it can falsify is the next one, which is the whole ordering.
        assert rows[1]["cny"] == pytest.approx(10.45, abs=0.01)

    def test_the_two_pass_row_is_not_summed_into_the_plan(self):
        table = _table()
        assert [entry["id"] for entry in table["alternativeCny"]] == ["expand-population-2rep"]
        assert table["totalCny"] == pytest.approx(23.60, abs=0.01)

    def test_the_plan_total_is_not_the_sum_of_every_row_it_can_price(self):
        table = _table()
        every = sum(row["cny"] for row in table["rows"] if row["cny"] is not None)
        assert every > table["totalCny"] + 20

    def test_the_delivery_class_is_refused_on_arithmetic_not_on_budget(self):
        row = next(row for row in _table()["rows"] if row["id"] == "delivery-class")
        assert row["refusal"] is not None
        assert "rejection region" in row["refusal"]
        assert row["cny"] == pytest.approx(0.15, abs=0.01)


class TestTheCommandLine:
    def test_list_prints_every_row_and_the_plan_total(self):
        result = _cli("--list")
        assert result.returncode == 0
        assert "expand-population-retrieval" in result.stdout
        assert "plan total: 23.60 CNY" in result.stdout
        assert "alternatives, not added" in result.stdout

    def test_a_refused_row_exits_non_zero_when_named(self):
        result = _cli("--id", "delivery-class")
        assert result.returncode == 1
        assert json.loads(result.stdout)["refusal"] is not None

    def test_a_buyable_row_exits_zero_when_named(self):
        result = _cli("--id", "memcog-mr")
        assert result.returncode == 0
        assert json.loads(result.stdout)["cny"] == pytest.approx(5.87, abs=0.01)

    def test_an_unknown_row_id_is_a_usage_error(self):
        result = _cli("--id", "not-a-row")
        assert result.returncode == 2
        assert "no queue row named" in result.stderr

    def test_missing_arguments_is_a_usage_error(self):
        result = _cli("--questions", "10")
        assert result.returncode == 2
        assert "usage:" in result.stderr

    def test_self_test_passes(self):
        result = _cli("--self-test")
        assert result.returncode == 0
        assert "0 failed" in result.stdout
