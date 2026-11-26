"""Why a gold turn was not delivered, and the column that never needed the cap.

`gold-band-census.mjs` refused the whole table under `resolution: 'layered'`, and the reading it
refused is the one every published artifact is written in. The argument for the refusal is sound and
too wide: `cut` needs `maxTurnChars`, because under `layered` a turn's bound is a form ceiling
computed from the question rather than the cap -- but `bandOf` decides **`absent` before it looks at
the cap**, so the delivery column is computable in a configuration where the width column is not.
Refusing the table refused a column that was never in question.

The second thing these tests pin is the reason `absent` is not a single finding. A gold turn can be
missing because the ranking never surfaced it (a retrieval repair) or because it surfaced and the
window's ranked prefix ran out (a selection repair), and on the published 500 those are **0 and
2,256** -- so the class the queue called a *delivery institution* is a **ranking distance**, and no
window sizing fixes it. A tool that printed `absent: 3` without that split left both repairs on the
table and neither of them supported.
"""

import json
import pathlib
import subprocess

import pytest

TOOL = pathlib.Path(__file__).resolve().parents[1] / "gold-band-census.mjs"


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


def _census(report: dict) -> dict:
    return json.loads(_run(f"console.log(JSON.stringify(mod.census({json.dumps(report)})));"))


def _question(route: str, golds, delivered, ranks=None, correct=False, capability="MR") -> dict:
    overlap = {"goldTurns": list(golds)}
    if ranks is not None:
        overlap["goldRanks"] = list(ranks)
        overlap["goldDelivered"] = [g in set(delivered) for g in golds]
    return {
        "capability": capability,
        "route": route,
        "correct": correct,
        "goldOverlap": overlap,
        "turns": [{"text": text} for text in delivered],
    }


LAYERED = {"memoryArmConfig": {"resolution": "layered", "maxPromptCharsByRoute": {"temporal": 24000}}}


class TestTheAbsentColumnDoesNotNeedTheCap:
    def test_a_layered_configuration_prints_the_delivery_column(self):
        # The defect: this threw, so the only configuration the published artifacts use had no
        # gold-turn census at all.
        result = _census({**LAYERED, "questions": [_question("temporal", ["a"], ["a"])]})
        assert result["bandsResolvable"] is False
        assert result["all"]["absent"] == 0

    def test_a_layered_configuration_still_counts_absent_gold(self):
        result = _census({**LAYERED, "questions": [_question("temporal", ["a", "b"], ["a"])]})
        assert result["all"]["absent"] == 1

    def test_the_width_columns_are_absent_rather_than_zero_under_layered(self):
        # `null` and not `0`: zero is a measurement, and this configuration cannot take it.
        result = _census({**LAYERED, "questions": [_question("temporal", ["a"], ["a"])]})
        assert result["all"]["whole"] is None
        assert result["all"]["cut"] is None

    def test_a_resolvable_configuration_still_bands_width(self):
        result = _census(
            {
                "memoryArmConfig": {"maxTurnChars": 10, "maxTurnCharsRoutes": ["temporal"]},
                "questions": [_question("temporal", ["z" * 50], ["z" * 50])],
            }
        )
        assert result["bandsResolvable"] is True
        assert result["all"]["cut"] == 1


class TestAnAbsentGoldHasTwoCauses:
    def test_a_gold_the_ranking_never_surfaced_is_never_ranked(self):
        result = _census(
            {
                "memoryArmConfig": {"maxTurnChars": 400},
                "questions": [_question("temporal", ["a", "b"], ["a"], ranks=[0, -1])],
            }
        )
        assert result["all"]["absentNeverRanked"] == 1
        assert result["all"]["absentBeyondCut"] == 0

    def test_a_gold_the_ranking_surfaced_past_the_cut_is_beyond_cut(self):
        result = _census(
            {
                "memoryArmConfig": {"maxTurnChars": 400},
                "questions": [_question("temporal", ["a", "b"], ["a"], ranks=[0, 141])],
            }
        )
        assert result["all"]["absentBeyondCut"] == 1
        assert result["all"]["absentNeverRanked"] == 0

    def test_a_report_without_ranks_is_unattributable_rather_than_assumed(self):
        # The field arrived with the ranking; an older artifact has no opinion, and defaulting it to
        # either branch would invent the one number the split exists to produce.
        result = _census(
            {
                "memoryArmConfig": {"maxTurnChars": 400},
                "questions": [_question("temporal", ["a", "b"], ["a"])],
            }
        )
        assert result["all"]["absentUnattributable"] == 1
        assert result["all"]["absentBeyondCut"] == 0
        assert result["all"]["absentNeverRanked"] == 0

    def test_a_delivered_gold_is_in_no_absent_bucket(self):
        result = _census(
            {
                "memoryArmConfig": {"maxTurnChars": 400},
                "questions": [_question("temporal", ["a", "b"], ["a", "b"], ranks=[3, 141])],
            }
        )
        assert result["all"]["absent"] == 0
        assert (
            result["all"]["absentBeyondCut"]
            + result["all"]["absentNeverRanked"]
            + result["all"]["absentUnattributable"]
            == 0
        )

    def test_the_three_buckets_sum_to_absent(self):
        result = _census(
            {
                "memoryArmConfig": {"maxTurnChars": 400},
                "questions": [
                    _question("temporal", ["a", "b", "c", "d"], ["a"], ranks=[0, 141, -1, 200]),
                    _question("flat", ["e", "f"], ["e"]),
                ],
            }
        )
        row = result["all"]
        # Three from the first question (b beyond-cut, c never-ranked, d beyond-cut) and one from the
        # second (f, which the report gives no ranking at all).
        assert row["absent"] == 4
        assert row["absentBeyondCut"] + row["absentNeverRanked"] + row["absentUnattributable"] == row["absent"]


class TestTheRouteIsWhereTheBudgetLives:
    def test_the_census_reports_each_route_separately(self):
        # The room is a per-route table, so a per-capability census hides the only unit the budget
        # is set in: `multi-session` at 48,460 delivers 98.5% of its gold and `flat` at 24,000
        # delivers 50.4%, and the two are one capability or two depending on the question.
        result = _census(
            {
                "memoryArmConfig": {"maxTurnChars": 400},
                "questions": [
                    _question("multi-session", ["a"], ["a"]),
                    _question("flat", ["b", "c"], ["b"], ranks=[0, 300]),
                ],
            }
        )
        routes = dict(result["byRoute"])
        assert routes["multi-session"]["absent"] == 0
        assert routes["flat"]["absent"] == 1
        assert routes["flat"]["absentBeyondCut"] == 1

    def test_the_delivery_rate_is_gold_segments_not_questions(self):
        # 4 segments, 3 delivered: the rate is 75%, and a question-shaped rate would read 100%.
        result = _census(
            {
                "memoryArmConfig": {"maxTurnChars": 400},
                "questions": [_question("temporal", ["a", "b", "c"], ["a", "b"], ranks=[0, 1, 200])],
            }
        )
        routes = dict(result["byRoute"])
        assert routes["temporal"]["total"] == 3
        assert routes["temporal"]["deliveredSegments"] == 2


class TestTheCommandLineStillWorks:
    def test_self_test_passes(self):
        result = subprocess.run(
            ["node", str(TOOL), "--self-test"], capture_output=True, text=True, timeout=120
        )
        assert result.returncode == 0, result.stdout + result.stderr

    def test_missing_argument_is_a_usage_error(self):
        result = subprocess.run(["node", str(TOOL)], capture_output=True, text=True, timeout=120)
        assert result.returncode == 2
        assert "usage:" in result.stderr
