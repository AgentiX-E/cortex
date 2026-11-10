"""Tests for `tools/failure-stability.mjs`, the CLI over the repetition partition.

The library's own tests live in `packages/cortex-eval/src/__tests__/failure-stability.test.ts` and
run under vitest with the package's coverage gate. These tests are about the **caller**: the
arguments it accepts, the two refusals it must not invent, and the one thing it adds that the library
does not — the **population's own null**, which is what a ceiling is compared against and which the
library takes as an argument rather than computing.

  - **a target set naming a question the artifact does not carry is refused, not shrunk.** A ceiling
    over a denominator that quietly dropped a member is a number that cannot be compared with the one
    it replaced, which is the defect the whole module exists to correct one level up.
  - **one repetition is refused rather than read as stability.** `featureCorrect` is present in every
    artifact and is repetition zero of the mask; a fallback to it would answer "every failure is
    stable" for a run that measured nothing of the kind.
  - **the library's refusal is quoted, not replaced.** A wrapper that prints its own sentence for
    every failure has thrown away the only part that says what to change.
"""

from __future__ import annotations

import json
import pathlib
import subprocess

ROOT = pathlib.Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "failure-stability.mjs"

# `42355323615`'s partition, by repetitions correct. `MR` is 95/5/3/5/13 over 121 and `KU` is
# 62/1/2/0/7 over 72, which are the numbers `docs/MEASURE-FAILURE-STABILITY.md` quotes.
MR_BANDS = [(4, 95), (3, 5), (2, 3), (1, 5), (0, 13)]
KU_BANDS = [(4, 62), (3, 1), (2, 2), (0, 7)]


def artifact(repetitions: int = 4, drop_mask: bool = False) -> dict:
    """A report whose masks reproduce the published partition, in dataset order."""
    questions, passed = [], []
    for capability, bands in (("MR", MR_BANDS), ("KU", KU_BANDS)):
        for repetitions_correct, count in bands:
            for _ in range(count):
                questions.append({"questionId": f"{capability}{len(questions):03d}", "capability": capability})
                passed.append(repetitions_correct)
    masks = ["".join("1" if value > rep else "0" for value in passed) for rep in range(repetitions)]
    ablation: dict = {"runs": repetitions, "featureCorrect": [mask[0] == "1" for mask in masks]}
    if not drop_mask:
        ablation["featureCorrectByRun"] = masks
    return {"runs": repetitions, "questions": questions, "ablation": ablation}


def run(tmp_path, report, *args):
    path = tmp_path / "report.json"
    path.write_text(json.dumps(report))
    return subprocess.run(
        ["node", str(TOOL), "--report", str(path), *args],
        capture_output=True,
        text=True,
        check=False,
        cwd=ROOT,
    )


def test_the_file_partition_is_printed_with_its_own_null(tmp_path):
    completed = run(tmp_path, artifact())
    assert completed.returncode == 0, completed.stderr
    assert "population 193 questions x 4 repetitions = 772 question-runs" in completed.stdout
    assert "| 0 of 4 | 20 | 10.4% |" in completed.stdout
    # 20 stable failures and 13 flaky ones, which is what the bands sum to.
    assert "stable failures 20   flaky 16" in completed.stdout
    assert "repetition spread" in completed.stdout
    assert "2 sd" in completed.stdout


def test_capability_selection_narrows_the_population_and_its_null(tmp_path):
    completed = run(tmp_path, artifact(), "--capability", "KU")
    assert completed.returncode == 0, completed.stderr
    assert "population 72 questions x 4 repetitions = 288 question-runs" in completed.stdout
    assert "mean accuracy 88.54%" in completed.stdout
    assert "recoverable 8.25 question-equivalents" in completed.stdout


def test_a_target_set_is_priced_and_compared_to_the_null(tmp_path):
    targets = tmp_path / "targets.json"
    targets.write_text(json.dumps({"stale-value": ["KU186", "KU187", "KU192"]}))
    completed = run(tmp_path, artifact(), "--capability", "KU", "--targets", str(targets))
    assert completed.returncode == 0, completed.stderr
    # Three of the seven never-correct `KU` questions is 4.17 points, and this fixture's own
    # repetition spread is 3.00 questions -- so the reading is a tie, and a tie is not resolvable.
    assert "| stale-value | 3 | 3 | 3.00 | 4.17 | 3.00 | no |" in completed.stdout


def test_a_target_naming_an_absent_question_is_refused_rather_than_dropped(tmp_path):
    targets = tmp_path / "targets.json"
    targets.write_text(json.dumps({"stale-value": ["KU186", "not-a-question"]}))
    completed = run(tmp_path, artifact(), "--capability", "KU", "--targets", str(targets))
    assert completed.returncode == 2
    assert "not-a-question" in completed.stderr
    assert "not in the 72-question population" in completed.stderr


def test_a_target_that_is_not_a_list_is_refused(tmp_path):
    targets = tmp_path / "targets.json"
    targets.write_text(json.dumps({"stale-value": 3}))
    completed = run(tmp_path, artifact(), "--targets", str(targets))
    assert completed.returncode == 2
    assert "must be an array of question ids" in completed.stderr


def test_json_round_trips_the_reading_and_every_ceiling(tmp_path):
    targets = tmp_path / "targets.json"
    targets.write_text(json.dumps({"nothing": ["MR108"]}))
    completed = run(tmp_path, artifact(), "--targets", str(targets), "--json")
    assert completed.returncode == 0, completed.stderr
    reading = json.loads(completed.stdout)
    assert reading["population"] == "all"
    assert reading["questions"] == 193
    assert reading["stableFailures"] == 20
    assert reading["flaky"] == 16
    assert reading["recoverable"] == 27.75
    assert reading["ceilings"][0]["label"] == "nothing"
    assert reading["ceilings"][0]["ceiling"] == 1
    assert reading["ceilings"][0]["resolvable"] in (True, False)


def test_a_single_repetition_is_refused_rather_than_read_as_stability(tmp_path):
    completed = run(tmp_path, artifact(repetitions=1))
    assert completed.returncode == 2
    assert "one repetition has no stability to measure" in completed.stderr


def test_a_missing_mask_is_refused_rather_than_read_from_the_flat_list(tmp_path):
    completed = run(tmp_path, artifact(drop_mask=True))
    assert completed.returncode == 2
    assert "no per-repetition correctness mask" in completed.stderr


def test_unrecognised_argument_is_refused(tmp_path):
    completed = run(tmp_path, artifact(), "--capabilty", "KU")
    assert completed.returncode == 2
    assert "unrecognised argument --capabilty" in completed.stderr


def test_missing_report_is_refused_before_reading(tmp_path):
    completed = subprocess.run(
        ["node", str(TOOL)],
        capture_output=True,
        text=True,
        check=False,
        cwd=ROOT,
    )
    assert completed.returncode == 2
    assert "--report <path> is required" in completed.stderr


def test_unreadable_targets_file_is_refused(tmp_path):
    completed = run(tmp_path, artifact(), "--targets", str(tmp_path / "absent.json"))
    assert completed.returncode == 2
    assert "could not read" in completed.stderr
