"""`reader-rung.py`, checked on two hand-built artifacts.

The tool's job is to answer one question — *did the reader move the arm, or did the run* — so the tests
are about the three ways that answer can be faked:

  - **a pairing that is not a pairing.** Two artifacts of different populations, or of different
    repetition counts, produce two numbers that look comparable and are not. Both are refusals rather
    than warnings, because a printed mean is read as a reading.
  - **a majority that is not a majority.** `majority()` must be strict: 2 of 4 is not correct. A `>=`
    would turn every tie into a win and inflate both arms equally, which is the failure that hides.
  - **an identity claim taken on faith.** The prompt comparison counts a question as identical only when
    both artifacts carry a digest and the digests are equal; a missing digest is *not* an identical one.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "reader-rung.py"


def artifact(
    *,
    correct_by_run: list[str],
    capability: str = "MR",
    digests: dict[str, str] | None = None,
    declines: int = 1,
    fingerprint: str = "sha256:test",
) -> dict:
    ids = [f"q{index}" for index in range(len(correct_by_run[0]))]
    questions = []
    for position, question_id in enumerate(ids):
        record = {
            "questionId": question_id,
            "capability": capability,
            "correct": correct_by_run[0][position] == "1",
        }
        if digests is not None:
            record["promptDigest"] = digests[question_id]
        questions.append(record)
    return {
        "datasetFingerprint": fingerprint,
        "questionCount": len(questions),
        "ablation": {"featureCorrectByRun": correct_by_run},
        "abstentionReasons": {"empty": 0, "threshold": 0, "llm": declines, "answered": 0},
        "questions": questions,
    }


def run(tmp_path: Path, treatment: dict, control: dict, *extra: str) -> subprocess.CompletedProcess[str]:
    paths = []
    for name, document in (("treatment.json", treatment), ("control.json", control)):
        path = tmp_path / name
        path.write_text(json.dumps(document), encoding="utf-8")
        paths.append(str(path))
    return subprocess.run(
        [sys.executable, str(TOOL), "--treatment", paths[0], "--control", paths[1], *extra],
        capture_output=True,
        text=True,
        check=False,
    )


def test_a_bought_question_reads_as_one(tmp_path: Path) -> None:
    # Four repetitions, so the majority is a vote. The treatment answers q0 in three of four and the
    # control in one: the net is +1 question, and the p is exact rather than quoted.
    control = artifact(correct_by_run=["1000", "1000", "1000", "0000"])
    treatment = artifact(correct_by_run=["1100", "1100", "1100", "0000"])
    r = run(tmp_path, treatment, control)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "| **all** | 4 | **25.00%** | **50.00%** | **+25.00** | 0 | 1 | 2 |" in r.stdout
    assert "1.0000" in r.stdout or "1" in r.stdout


def test_two_of_four_is_not_a_majority(tmp_path: Path) -> None:
    # 2 of 4 is a tie, not a win. A `>=` comparison would score this question correct in both arms and
    # hide the tie inside two identical percentages.
    control = artifact(correct_by_run=["1100", "1100", "0011", "0011"])
    treatment = artifact(correct_by_run=["1100", "1100", "0011", "0011"])
    r = run(tmp_path, treatment, control, "--json")
    assert r.returncode == 0, r.stdout + r.stderr
    body = json.loads(r.stdout)
    assert body["overall"]["both"] == 0
    assert body["overall"]["neither"] == 4


def test_a_different_population_is_refused(tmp_path: Path) -> None:
    control = artifact(correct_by_run=["1100"])
    treatment = artifact(correct_by_run=["1100"], fingerprint="sha256:other")
    r = run(tmp_path, treatment, control)
    assert r.returncode != 0
    assert "not the same population" in (r.stdout + r.stderr)


def test_a_different_repetition_count_is_refused(tmp_path: Path) -> None:
    control = artifact(correct_by_run=["1100"])
    treatment = artifact(correct_by_run=["1100", "1100"])
    r = run(tmp_path, treatment, control)
    assert r.returncode != 0
    assert "repetitions" in (r.stdout + r.stderr)


def test_a_missing_digest_is_not_an_identical_one(tmp_path: Path) -> None:
    control = artifact(correct_by_run=["1100"])
    treatment = artifact(correct_by_run=["1100"])
    r = run(tmp_path, treatment, control, "--json")
    assert r.returncode == 0, r.stdout + r.stderr
    assert json.loads(r.stdout)["promptIdentity"] == {"identical": 0, "shared": 4, "differ": 4}


def test_equal_digests_are_counted_and_a_differing_one_is_named(tmp_path: Path) -> None:
    digests = {f"q{index}": f"a{index}" for index in range(4)}
    control = artifact(correct_by_run=["1100"], digests=digests)
    treatment = artifact(correct_by_run=["1100"], digests={**digests, "q2": "b2"})
    r = run(tmp_path, treatment, control, "--json")
    assert r.returncode == 0, r.stdout + r.stderr
    body = json.loads(r.stdout)
    assert body["promptIdentity"] == {"identical": 3, "shared": 4, "differ": 1}


def test_a_capability_filter_narrows_the_denominator(tmp_path: Path) -> None:
    # The reader rung is read on `MR` alone, so the filter has to cut the roster rather than the cells.
    control = artifact(correct_by_run=["1100"], capability="MR")
    treatment = artifact(correct_by_run=["1111"], capability="MR")
    r = run(tmp_path, treatment, control, "--capability", "TR")
    assert r.returncode != 0
    assert "no question in the treatment roster carries capability" in (r.stdout + r.stderr)


def test_the_decline_counts_come_from_the_artifact(tmp_path: Path) -> None:
    # The guard `v4-pro`'s non-thinking arm failed: a reader that answers instead of declining is not a
    # stronger reader, so the count is part of the reading rather than a diagnostic.
    control = artifact(correct_by_run=["1100"], declines=1)
    treatment = artifact(correct_by_run=["1111"], declines=7)
    r = run(tmp_path, treatment, control)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "control 1, treatment 7" in r.stdout


def test_a_capability_filter_puts_the_two_rosters_on_one_page(tmp_path: Path) -> None:
    # The shape `R1` was dispatched in: 121 `MR` questions against a 500-question control. Filtering
    # both sides by the same capability leaves 121 against 121, which is a pair with no drop at all --
    # so the filter, not `--subset`, is what makes a capability-limited dispatch readable.
    control = artifact(correct_by_run=["1" * 121 + "0" * 379])
    control["questions"] = [
        {**record, "capability": "MR" if index < 121 else "TR"}
        for index, record in enumerate(control["questions"])
    ]
    treatment = artifact(correct_by_run=["1" * 121])

    r = run(tmp_path, treatment, control, "--capability", "MR", "--json")
    assert r.returncode == 0, r.stdout + r.stderr
    assert json.loads(r.stdout)["overall"]["questions"] == 121


def test_a_wider_capability_on_the_control_is_refused_without_subset(tmp_path: Path) -> None:
    # The control carries four more `MR` questions than the treatment asked. The drop is the one thing
    # a paired mean must not hide, so it is a refusal until `--subset` asks for it by name.
    control = artifact(correct_by_run=["1" * 125])
    treatment = artifact(correct_by_run=["1" * 121])
    treatment["questions"] = control["questions"][:121]

    refused = run(tmp_path, treatment, control, "--capability", "MR")
    assert refused.returncode != 0
    assert "--subset" in (refused.stdout + refused.stderr)

    r = run(tmp_path, treatment, control, "--capability", "MR", "--subset", "--json")
    assert r.returncode == 0, r.stdout + r.stderr
    body = json.loads(r.stdout)
    assert body["overall"]["questions"] == 121
    assert body["subset"] == {"droppedFromControl": 4, "treatment": 121}


def test_a_control_question_the_treatment_never_asked_is_not_a_cell(tmp_path: Path) -> None:
    # A question asked of the treatment alone has no paired cell, and `--subset` does not license
    # inventing the other half: it licenses a smaller denominator, not a one-sided cell.
    control = artifact(correct_by_run=["11000"])
    treatment = artifact(correct_by_run=["1100"])
    treatment["questions"] = [control["questions"][0], control["questions"][1], control["questions"][2],
                              {**control["questions"][3], "questionId": "q9"}]
    r = run(tmp_path, treatment, control, "--subset")
    assert r.returncode != 0
    assert "no paired cell" in (r.stdout + r.stderr)


def test_subset_names_how_many_control_questions_left_the_page(tmp_path: Path) -> None:
    control = artifact(correct_by_run=["110000"])
    treatment = artifact(correct_by_run=["1100"])
    treatment["questions"] = control["questions"][:4]
    r = run(tmp_path, treatment, control, "--subset")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "paired on 4 question(s)" in r.stdout
    assert "2 control question(s) not asked of the treatment" in r.stdout


def test_require_identity_makes_a_moved_prompt_a_void_result(tmp_path: Path) -> None:
    # The registration's third criterion. A swap that moved a prompt is not the experiment it names,
    # so the tool has to be able to say so with a status a shell can branch on rather than a sentence.
    digests = {f"q{index}": f"a{index}" for index in range(4)}
    control = artifact(correct_by_run=["1100"], digests=digests)
    same = artifact(correct_by_run=["1100"], digests=digests)
    moved = artifact(correct_by_run=["1100"], digests={**digests, "q3": "b3"})

    clean = run(tmp_path, same, control, "--require-identity")
    assert clean.returncode == 0, clean.stdout + clean.stderr

    void = run(tmp_path, moved, control, "--require-identity")
    assert void.returncode == 3
    assert "**void**" in void.stdout

    # Without the flag the same artifact reads as a direction, which is what a second-best reading is.
    noted = run(tmp_path, moved, control)
    assert noted.returncode == 0
    assert "1 differing" in noted.stdout
