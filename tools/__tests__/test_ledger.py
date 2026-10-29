"""The ledger tool, checked on hand-built reports.

`ledger.ts` has its own unit tests. This file tests the **tool**: that it reads the memory arm's report
envelope, prints the two numbers a reader can check against each other (the sum of the purchases and the
size of their union), names the questions a sum would count twice, and refuses an artifact that never
recorded which questions moved.

The last case is the one that matters most in practice. Every report written before `discordantQuestions`
existed looks, to a portfolio, exactly like an increment that bought nothing — and a reader who saw a
confident `bought 0` would conclude the increment was worthless rather than unrecorded.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "ledger.mjs"


def report(bought: list[str], sold: list[str]) -> dict:
    """One memory-arm report, in the envelope the workflow actually uploads."""
    return {
        "dataset": "longmemeval/s/100",
        "questionCount": len(bought) + len(sold),
        "ablation": {
            "feature": "cortex-memory",
            "discordantQuestions": {
                "baselineIncorrectFeatureCorrect": bought,
                "baselineCorrectFeatureIncorrect": sold,
            },
        },
    }


def run(tmp_path: Path, arms: dict[str, dict], extra: list[str] | None = None) -> subprocess.CompletedProcess:
    paths = []
    for label, body in arms.items():
        path = tmp_path / f"{label}.json"
        path.write_text(json.dumps(body), encoding="utf-8")
        paths.append(f"{label}={path}")
    return subprocess.run(
        ["node", str(TOOL), *paths, *(extra or [])],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )


def test_prints_the_sum_and_the_union_so_a_reader_can_compare_them(tmp_path: Path) -> None:
    """Three purchases in one arm and two in another: 5 summed, 5 distinct, and the tool must say so."""
    completed = run(
        tmp_path,
        {"silent": report(["m1", "m2", "m3"], []), "answer-line": report(["i1", "i2"], [])},
    )

    assert completed.returncode == 0, completed.stderr
    assert "Distinct questions bought: 5" in completed.stdout
    assert "Sum of the per-increment purchases: 5" in completed.stdout
    assert "Double-counted by the sum: 0" in completed.stdout
    assert "disjoint" in completed.stdout


def test_names_the_questions_a_naive_sum_counts_twice(tmp_path: Path) -> None:
    """+3 and +2 that share one question are worth +4, and the shared id has to be visible."""
    completed = run(
        tmp_path,
        {
            "silent": report(["m1", "m2", "shared"], []),
            "answer-line": report(["shared", "i1"], []),
        },
    )

    assert completed.returncode == 0, completed.stderr
    assert "Distinct questions bought: 4" in completed.stdout
    assert "Sum of the per-increment purchases: 5" in completed.stdout
    assert "Double-counted by the sum: 1 (shared)" in completed.stdout
    assert "overstates the pair by 1" in completed.stdout


def test_reports_a_question_one_arm_bought_and_another_sold(tmp_path: Path) -> None:
    """The loss a sum of nets cancels: +1 and -1 add to zero, and the question moved both ways."""
    completed = run(
        tmp_path,
        {"silent": report(["q7"], []), "answer-line": report([], ["q7"])},
    )

    assert completed.returncode == 0, completed.stderr
    assert "CONFLICT: q7" in completed.stdout
    assert "should not ship together" in completed.stdout


def test_refuses_a_report_that_never_recorded_the_identity(tmp_path: Path) -> None:
    """An old artifact is unrecorded, not empty, and the message has to name which arm it was."""
    legacy = {"dataset": "longmemeval/s/100", "ablation": {"feature": "cortex-memory"}}
    completed = run(tmp_path, {"legacy": legacy, "fresh": report(["q1"], [])})

    assert completed.returncode != 0
    assert "legacy" in completed.stderr
    assert "discordantQuestions" in completed.stderr


def test_json_mode_carries_the_lists_for_a_later_reader(tmp_path: Path) -> None:
    completed = run(
        tmp_path,
        {"silent": report(["m1", "shared"], []), "answer-line": report(["shared"], ["gone"])},
        extra=["--json"],
    )

    assert completed.returncode == 0, completed.stderr
    parsed = json.loads(completed.stdout)
    assert [arm["label"] for arm in parsed["increments"]] == ["silent", "answer-line"]
    assert parsed["portfolio"]["bought"] == ["m1", "shared"]
    assert parsed["portfolio"]["doubleCounted"] == ["shared"]
    assert parsed["portfolio"]["conflicting"] == []
    assert parsed["portfolio"]["summedBought"] == 3
    assert parsed["portfolio"]["summedSold"] == 1
