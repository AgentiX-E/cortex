"""The gold-recall census: one cliff, and the population that falls off it.

`S14` priced the vector channel at 5.60 points; a price is not a direction. This file tests the tool
that turns two artifacts into a direction, and every case below is a way the table could be right and
the conclusion wrong.

| case | the failure it prevents |
| --- | --- |
| a question with no gold turns is excluded | an abstention question counted as a zero-recall failure, which doubles the apparent cliff |
| a tie across repetitions is a loss | four passes at 2/4 read as correct by a majority rule that rounds up |
| the 0% bucket is a state, not a range | a question with 1 of 300 gold turns landing in the same bucket as one with none |
| no census is a refusal | an empty table that reads as "every question covered" |
| two rosters are not a pair | a p-value and a group table over a population that is not shared |

The second and third rows are the ones with teeth: both produce a table that looks more alarming than
the data, and an alarming number is the one nobody re-checks.
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import subprocess
import sys

import pytest

TOOL = pathlib.Path(__file__).resolve().parents[1] / "gold-recall-census.py"


def _tool():
    spec = importlib.util.spec_from_file_location("gold_recall_census", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules["gold_recall_census"] = module
    spec.loader.exec_module(module)
    return module


def artifact(rows, bits=None):
    """A report whose questions carry `rows` = (delivered, total) gold-turn counts."""
    bits = bits or ["1" * len(rows) for _ in range(4)]
    return {
        "dataset": "longmemeval",
        "datasetFingerprint": "sha256:" + "a" * 64,
        "questions": [
            {
                "questionId": f"q{index}",
                "capability": capability,
                "route": "flat",
                "goldOverlap": {"goldDelivered": [i < delivered for i in range(total)]},
            }
            for index, ((delivered, total), capability) in enumerate(rows)
        ],
        "ablation": {"featureCorrectByRun": bits},
    }


def run(tmp_path, report, *args, name="artifact.json"):
    source = pathlib.Path(tmp_path) / name
    source.write_text(json.dumps(report), encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(TOOL), str(source), *args], capture_output=True, text=True
    )


def test_zero_is_a_state_and_the_rest_are_ranges():
    module = _tool()
    assert module.bucket(0.0) == "0%"
    assert module.bucket(1 / 300) == "1-33%"
    assert module.bucket(1 / 3) == "1-33%"
    assert module.bucket(0.34) == "34-66%"
    assert module.bucket(2 / 3) == "34-66%"
    assert module.bucket(0.67) == "67-100%"
    assert module.bucket(1.0) == "67-100%"


def test_a_question_with_no_gold_turns_is_not_a_zero_recall_question(tmp_path):
    """Nothing to find is not a failure to find it.

    The abstention questions in `S14` were answered correctly **because** no evidence was delivered;
    counting them as zero-recall failures would both inflate the cliff and mislabel the mechanism.
    """
    report = artifact([[(0, 3), "IE"], [(0, 0), "ABS"]], bits=["10"] * 4)
    done = run(tmp_path, report, "--json")
    assert done.returncode == 0, done.stderr
    reading = json.loads(done.stdout)["census"]
    assert reading["withGoldTurns"] == 1
    assert reading["zeroRecall"]["questions"] == 1
    assert reading["buckets"]["0%"]["questions"] == 1


def test_a_tie_across_repetitions_is_a_loss(tmp_path):
    """Two of four is not a majority, and rounding it up would flatter every arm equally."""
    # Correct in two of four passes: exactly half, which the majority rule must not round up.
    report = artifact([[(3, 3), "IE"]], bits=["10", "10", "00", "00"])
    done = run(tmp_path, report, "--json")
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout)["census"]["buckets"]["67-100%"]["correct"] == 0


def test_the_zero_bucket_reports_what_that_population_is_made_of(tmp_path):
    report = artifact(
        [[(0, 5), "IE"], [(0, 2), "IE"], [(0, 4), "TR"], [(0, 3), "ABS"]], bits=["0011"] * 4
    )
    done = run(tmp_path, report, "--json")
    assert done.returncode == 0, done.stderr
    zero = json.loads(done.stdout)["census"]["zeroRecall"]
    assert zero["questions"] == 4
    assert zero["byCapability"] == {"ABS": 1, "IE": 2, "TR": 1}
    assert zero["correct"] == 2


def test_an_artifact_without_the_census_is_refused(tmp_path):
    report = artifact([[(1, 1), "IE"]])
    for question in report["questions"]:
        del question["goldOverlap"]
    done = run(tmp_path, report)
    assert done.returncode == 1
    assert "cannot say where the evidence went" in done.stderr


def test_an_artifact_without_vectors_is_refused(tmp_path):
    report = artifact([[(1, 1), "IE"]])
    del report["ablation"]
    done = run(tmp_path, report)
    assert done.returncode == 1
    assert "no verdict per question" in done.stderr


def test_two_rosters_are_not_a_pair(tmp_path):
    mine = artifact([[(1, 1), "IE"], [(1, 1), "IE"]])
    other = artifact([[(1, 1), "IE"]])
    done = run(tmp_path, mine, "--against", _write(tmp_path, other, "other.json"))
    assert done.returncode == 1
    assert "not the same population" in done.stderr


def _write(tmp_path, report, name):
    path = pathlib.Path(tmp_path) / name
    path.write_text(json.dumps(report), encoding="utf-8")
    return str(path)


def test_the_pair_counts_four_groups_and_censuses_the_other_arm(tmp_path):
    """The groups are what separates "sees less everywhere" from "collapses on a few"."""
    mine = artifact(
        [[(0, 3), "IE"], [(2, 3), "IE"], [(3, 3), "MR"], [(0, 3), "KU"]], bits=["0110"] * 4
    )
    other = artifact(
        [[(3, 3), "IE"], [(3, 3), "IE"], [(3, 3), "MR"], [(0, 3), "KU"]], bits=["1110"] * 4
    )
    done = run(tmp_path, mine, "--json", "--against", _write(tmp_path, other, "other.json"))
    assert done.returncode == 0, done.stderr
    reading = json.loads(done.stdout)
    # q0: only the other arm has it. q1 and q2: both. q3: neither -- and both zero-count cells are
    # present, because "none" is a fact about the pair and a missing key is not.
    assert reading["against"]["groups"] == {"both": 1 + 1, "onlyThis": 0, "onlyOther": 1, "neither": 1}
    assert reading["against"]["census"]["zeroRecall"]["questions"] == 1


def test_the_printed_block_names_the_bucket_and_the_population(tmp_path):
    report = artifact([[(0, 4), "IE"], [(1, 4), "IE"], [(3, 3), "MR"]], bits=["011"] * 4)
    done = run(tmp_path, report)
    assert done.returncode == 0, done.stderr
    assert "0%" in done.stdout
    assert "zero recall: 1 question(s), 0 of them correct (IE 1)" in done.stdout
    assert "mean gold-turn recall" in done.stdout


def test_the_mean_recall_is_over_the_questions_that_have_gold_turns(tmp_path):
    """A question with nothing to find would otherwise pull the mean down for a reason that is not
    about retrieval."""
    report = artifact([[(2, 2), "IE"], [(0, 0), "ABS"]])
    done = run(tmp_path, report, "--json")
    assert done.returncode == 0, done.stderr
    assert json.loads(done.stdout)["census"]["meanRecall"] == pytest.approx(1.0)
