"""Tests for `tools/judge-channel-census.mjs`, the split of verdicts across the scorer's four doors.

The tool answers one question for constraint ⑰ -- *how much of the grading still needs a model* -- and the
numbers it prints are only worth reading if the three ways it can be wrong are closed:

  - **a second implementation of the doors.** The census imports `normalizeAnswer` and
    `numericAnswerVerdict` from the package the scorer uses, so the split cannot disagree with the run it
    describes. A copy would drift the first time either gate changed.
  - **a disagreement nobody prints.** A mechanical verdict that contradicts the artifact's own `correct`
    is a defect in one of the two, and it is invisible in the split alone. `--check` must fail on it.
  - **an empty population passing.** `0 of 0` reads as a perfect split. An artifact with no questions is
    an error, and so is one whose `questions` array is not there at all.

The fixture below is small enough to check by hand: one question per door, plus one deliberate
disagreement.
"""

from __future__ import annotations

import json
import pathlib
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "judge-channel-census.mjs"


def question(**fields) -> dict:
    """One artifact question, defaulted to the shape the tool reads."""
    base = {
        "questionId": "q",
        "question": "How many books did I read?",
        "capability": "MR",
        "groundTruth": "5",
        "answer": "5",
        "correct": True,
    }
    base.update(fields)
    return base


def write(tmp_path: pathlib.Path, questions: list[dict], name: str = "artifact.json") -> pathlib.Path:
    path = tmp_path / name
    path.write_text(json.dumps({"generatedAt": "2026-11-20T00:00:00Z", "questions": questions}))
    return path


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(TOOL), *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=False,
    )


def test_the_four_doors_are_counted_from_the_packages_own_gates(tmp_path):
    path = write(
        tmp_path,
        [
            # exact: the two strings fold to the same text.
            question(questionId="exact", answer="5"),
            # numeric: a counting question whose answer is not the gold's text but is the gold's number.
            question(questionId="numeric", answer="3", correct=False),  # gold 5: a mechanical `false`
            # judge: not a counting question, so no arithmetic is available.
            question(
                questionId="judge",
                question="Which city did I move to?",
                groundTruth="Shanghai",
                answer="Beijing",
                correct=False,
            ),
            # structural: an abstention question carries no gold at all.
            question(questionId="abstain", question="What did I say about Prague?",
                     groundTruth=None, answer=None, correct=True),
            # structural: a gold with no answer is decided by the absence.
            question(questionId="silent", groundTruth="5", answer=None, correct=False),
        ],
    )

    result = run(str(path))
    assert result.returncode == 0, result.stderr
    out = result.stdout
    assert "population: 5 question(s)" in out
    assert "structural 2 (40.0%)" in out
    assert "exact 1 (20.0%)" in out
    assert "numeric 1 (20.0%)" in out
    assert "judge 1 (20.0%)" in out
    # The one judge call whose gold is a single number: the residual a widened gate could have taken.
    assert "model calls that a numeric gold could have decided: 0" in out
    assert "mechanical verdicts disagreeing with the artifact: 0" in out


def test_a_judge_call_with_a_numeric_gold_is_counted_as_the_residual(tmp_path):
    # A non-counting question whose gold is a number reaches the judge even though the gold is numeric:
    # `numericAnswerVerdict` only fires on counting questions. That is the count worth acting on.
    path = write(
        tmp_path,
        [
            question(
                questionId="residual",
                question="How many years older is my brother?",
                groundTruth="4",
                answer="three years",
                correct=False,
            )
        ],
    )

    result = run(str(path))
    assert result.returncode == 0, result.stderr
    assert "judge 1 (100.0%)" in result.stdout
    assert "model calls that a numeric gold could have decided: 1" in result.stdout


def test_a_mechanical_verdict_that_contradicts_the_artifact_fails_check(tmp_path):
    # An exact match the artifact marked wrong. Either the gate or the artifact is broken, and the split
    # alone would print the same numbers in both cases.
    path = write(tmp_path, [question(questionId="disagrees", answer="5", correct=False)])

    unchecked = run(str(path))
    assert unchecked.returncode == 0
    assert "mechanical verdicts disagreeing with the artifact: 1" in unchecked.stdout
    assert "DISAGREE disagrees [exact] mechanical=true artifact=false" in unchecked.stdout

    checked = run(str(path), "--check")
    assert checked.returncode == 1
    assert "disagree with the artifact" in checked.stderr


def test_a_numeric_rejection_is_reported_as_a_disagreement_too(tmp_path):
    # The other direction: the door says no and the artifact said yes. A test that only covered
    # `true -> false` would pass for a census that ignored a whole direction.
    path = write(
        tmp_path,
        [question(questionId="numeric-wrong", answer="3", correct=True)],
    )

    result = run(str(path), "--check")
    assert result.returncode == 1
    assert "mechanical=false artifact=true" in result.stdout


def test_an_empty_population_is_an_error(tmp_path):
    # `0 of 0` would print as a perfect split, which is the same indistinguishability the coverage gate
    # refuses between "0 examples checked" and "every example compiled".
    empty = write(tmp_path, [], name="empty.json")
    result = run(str(empty))
    assert result.returncode == 2
    assert "no questions" in result.stderr

    missing = tmp_path / "missing.json"
    missing.write_text(json.dumps({"generatedAt": "2026-11-20T00:00:00Z"}))
    assert run(str(missing)).returncode == 2


def test_the_json_reading_carries_the_same_numbers_as_the_text(tmp_path):
    path = write(
        tmp_path,
        [
            question(questionId="exact", answer="5"),
            question(questionId="judge", question="Which city?", groundTruth="Shanghai",
                     answer="Beijing", correct=False),
        ],
    )
    out = tmp_path / "reading.json"
    result = run(str(path), "--out", str(out))
    assert result.returncode == 0, result.stderr

    reading = json.loads(out.read_text())
    assert reading["channels"] == {"structural": 0, "exact": 1, "numeric": 0, "judge": 1}
    assert reading["questionCount"] == 2
    assert reading["byCapability"]["MR"]["judge"] == 1
    assert reading["disagreements"] == []
