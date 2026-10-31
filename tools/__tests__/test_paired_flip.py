"""The paired reading's own tests, run on fixtures and on the committed reading.

## Why this file exists

`tools/paired-flip.mjs` replaces a number the campaign quoted for several iterations — `87.25`
against `103.75`, "16 questions behind" — with the per-question pairing the artifact has always
carried. Two things can go wrong with an instrument that replaces a number everyone has read: it can
report a *different* number and be believed because it is newer, and it can silently drop a question
while the table still adds up. So every assertion here is either an identity a reader can check by
hand (`gapPerRun == baselineOnlyPerRun - featureOnlyPerRun`) or a refusal (no masks, wrong mask
length, a partition that does not sum).
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "paired-flip.mjs"


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(TOOL), *args],
        capture_output=True,
        text=True,
        cwd=REPO,
        check=False,
    )


def artifact(tmp_path: Path, masks: tuple[list[str], list[str]], capabilities: list[str]) -> Path:
    """A minimal artifact: one question per capability character, two arms, the given masks."""
    questions = [
        {
            "questionId": f"q{index}",
            "capability": capability,
            "question": "how many?",
            "groundTruth": "2",
            "answer": "2",
            "correct": masks[1][0][index] == "1",
        }
        for index, capability in enumerate(capabilities)
    ]
    payload = {
        "dataset": "fixture",
        "questionCount": len(questions),
        "baseline": {"name": "reference-pipeline", "metrics": {"correct": masks[0][0].count("1")}},
        "feature": {"name": "cortex-memory", "metrics": {"correct": masks[1][0].count("1")}},
        "ablation": {
            "baselineCorrectByRun": masks[0],
            "featureCorrectByRun": masks[1],
        },
        "questions": questions,
    }
    path = tmp_path / "report.json"
    path.write_text(json.dumps(payload))
    return path


def test_the_gap_is_reported_per_repetition_rather_than_as_a_mean(tmp_path: Path) -> None:
    """The whole point: four repetitions of one column can produce four different gaps.

    The fixture is the shape MR actually had in `41159983913` — baseline drifting down, feature
    drifting up — because a table that printed only `16.5` would hide that the gap moved 11 questions
    between repetitions while the prompt never changed.
    """
    path = artifact(
        tmp_path,
        (
            ["1110", "1100", "1100", "1000"],
            ["0000", "1000", "1100", "1110"],
        ),
        ["MR", "MR", "MR", "MR"],
    )
    result = run("--artifact", str(path))
    assert result.returncode == 0, result.stderr
    # Baseline 3/2/2/1, feature 0/1/2/3, so the gap is 3/1/0/-2 -- a sign change inside one column.
    assert "3   2   2   1" in result.stdout
    assert "0   1   2   3" in result.stdout
    assert "3   1   0  -2" in result.stdout
    assert "MR: mean gap 0.50 questions" in result.stdout


def test_the_partition_sums_to_the_population(tmp_path: Path) -> None:
    """A verdict table that does not add up is an instrument failure, so it is an exit code.

    Five questions, one per verdict plus an agreed-right: the sum of the printed classes must equal
    the population, and `agreed-right` is the remainder rather than a printed count so it cannot be
    inflated by omission.
    """
    # One question per verdict, four repetitions: q0 durable-miss, q1 durable-win, q2 agreed-wrong,
    # q3 contested, q4 agreed-right.
    path = artifact(
        tmp_path,
        (
            ["10011", "10011", "10011", "10001"],
            ["01001", "01011", "01011", "01011"],
        ),
        ["MR", "MR", "MR", "MR", "MR"],
    )
    result = run("--artifact", str(path))
    assert result.returncode == 0, result.stderr
    assert "durable-miss  durable-win  agreed-wrong  contested" in result.stdout
    assert re.search(r"^MR\s+5\s+1\s+1\s+1\s+1\s+", result.stdout, flags=re.MULTILINE), result.stdout
    # 1 + 1 + 1 + 1 = 4 of 5, so exactly one question is agreed-right and nothing was lost.


def test_an_artifact_without_masks_is_refused_with_a_reason(tmp_path: Path) -> None:
    """A single-repetition artifact omits the masks by design, and must not be read as a 1-run pairing.

    The alternative — falling back to `featureCorrect` and pairing it with nothing — would report a
    gap of zero for every capability, which reads as agreement.
    """
    path = tmp_path / "single.json"
    path.write_text(
        json.dumps(
            {
                "questions": [{"questionId": "q1", "capability": "MR", "correct": True}],
                "ablation": {"featureCorrect": [True]},
            }
        )
    )
    result = run("--artifact", str(path))
    assert result.returncode == 3, result.stdout + result.stderr
    assert "no per-repetition masks" in result.stderr
    assert "discordantQuestions" in result.stderr


def test_a_mask_of_the_wrong_length_is_refused_rather_than_truncated(tmp_path: Path) -> None:
    """The silent-denominator defect, in the index space where it would be invisible.

    A mask shorter than the question list is a mask built from a different artifact. Read into this
    one it attributes one question's accuracy to another, and every count still adds up.
    """
    path = tmp_path / "short.json"
    path.write_text(
        json.dumps(
            {
                "questions": [
                    {"questionId": "q1", "capability": "MR"},
                    {"questionId": "q2", "capability": "MR"},
                    {"questionId": "q3", "capability": "MR"},
                ],
                "ablation": {
                    "baselineCorrectByRun": ["111"],
                    "featureCorrectByRun": ["11"],
                },
            }
        )
    )
    result = run("--artifact", str(path))
    assert result.returncode != 0
    assert "index space" in result.stderr


def test_the_census_is_read_from_the_gold_and_the_answer(tmp_path: Path) -> None:
    """The two readings compose: `durable-miss` says stable, the census says what kind of error."""
    path = tmp_path / "census.json"
    path.write_text(
        json.dumps(
            {
                "questions": [
                    {"questionId": "off", "capability": "MR", "groundTruth": "3", "answer": "2"},
                    {"questionId": "dec", "capability": "MR", "groundTruth": "5", "answer": None},
                    {"questionId": "agg", "capability": "MR", "groundTruth": "495", "answer": "375"},
                ],
                "ablation": {
                    "baselineCorrectByRun": ["111"],
                    "featureCorrectByRun": ["000"],
                },
            }
        )
    )
    result = run("--artifact", str(path), "--census")
    assert result.returncode == 0, result.stderr
    assert "3 in total: off-by-one 1, decline 1, aggregation 1" in result.stdout


def test_the_committed_reading_recomputes() -> None:
    """The arithmetic has to survive a reader who cannot run the benchmark.

    `41159983913`: MR baseline 105/104/104/102, feature 84/86/87/92, gap 21/18/17/10. The mean gap of
    16.50 is the number the campaign quoted as 16 and treated as a constant; the durable part is 13.
    """
    reading = json.loads((REPO / "tools" / "paired-flip-reading.json").read_text())
    mr = reading["reading"]["MR"]
    assert mr["baselinePerRun"] == [105, 104, 104, 102]
    assert mr["featurePerRun"] == [84, 86, 87, 92]
    assert mr["gapPerRun"] == [21, 18, 17, 10]

    # Identity 1: the gap is the discordant difference, in every repetition.
    for run in range(4):
        assert mr["gapPerRun"][run] == mr["baselineOnlyPerRun"][run] - mr["featureOnlyPerRun"][run]

    # Identity 2: the mean gap is the durable difference plus the noise, and the durable part is
    # countable. 17 - 4 = 13 of the 16.50.
    assert mr["gapPerRun"] and sum(mr["gapPerRun"]) / 4 == 16.5
    assert len(mr["durableMiss"]) - len(mr["durableWin"]) == 13

    # Identity 3: the verdicts partition the column, with `agreed-right` as the remainder.
    assert (
        len(mr["durableMiss"]) + len(mr["durableWin"]) + len(mr["agreedWrong"]) + mr["contested"]
        <= mr["total"]
        == 121
    )

    # The headline numbers in `feature.metrics` are repetition 0, which the reading states.
    assert reading["headline"]["isFirstRepetition"] is True
    assert reading["headline"]["perRepetition"] == [419, 417, 425, 427]


def test_the_reading_records_the_ceiling_it_makes_computable() -> None:
    """The claim this reading replaces one that could not be checked.

    Matching the reference arm on MR is worth `durableMiss - durableWin = 13` questions, which from
    84/121 is 97/121 = 80.2% — the ceiling of a transplant, and *below* the 96 the campaign's own
    registration targeted. That is a statement about what "be more like the reference pipeline" can
    buy, and it is only available from the pairing.
    """
    reading = json.loads((REPO / "tools" / "paired-flip-reading.json").read_text())
    mr = reading["reading"]["MR"]
    reachable = len(mr["durableMiss"]) - len(mr["durableWin"])
    first = mr["featurePerRun"][0]
    assert f"{first + reachable}/121" in reading["ceiling"]["closedOnFirstRepetition"]
    assert reading["ceiling"]["reachable"] == reachable
    # And the classes of the durable misses, which decide whether the 13 are addressable at all.
    assert reading["ceiling"]["durableClasses"] == {
        "off-by-one": 6,
        "decline": 5,
        "aggregation": 4,
        "other": 2,
    }


def test_the_reading_is_reproducible(tmp_path: Path) -> None:
    """Two runs of one artifact print the same bytes, so a reading can cite its own output.

    Also the ordering guarantee behind the durable lists: they come out in dataset order, so a
    question that joins the list later does not renumber the ones already cited.
    """
    path = artifact(
        tmp_path,
        (["1111", "1000", "0000", "1111"], ["0000", "0000", "1111", "1111"]),
        ["MR", "TR", "MR", "TR"],
    )
    first = run("--artifact", str(path))
    second = run("--artifact", str(path))
    assert first.returncode == 0, first.stderr
    assert first.stdout == second.stdout
    # Capabilities are printed in name order, not row order, so the table does not depend on the
    # dataset's ordering.
    assert first.stdout.index("MR ") < first.stdout.index("TR ")

    # And the committed reading lists each durable miss once, in dataset order.
    reading = json.loads((REPO / "tools" / "paired-flip-reading.json").read_text())
    ids = [row["questionId"] for row in reading["reading"]["MR"]["durableMiss"]]
    assert ids == list(dict.fromkeys(ids)), "a durable miss is listed once"
    assert len(ids) == 17
