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


def run_across(
    tmp_path: Path, arms: dict[str, dict], control: dict, extra: list[str] | None = None
) -> subprocess.CompletedProcess:
    """The cross-run form: several arms, one shared control, all measured question for question."""
    control_path = tmp_path / "control.json"
    control_path.write_text(json.dumps(control), encoding="utf-8")
    argv = ["node", str(TOOL), "--control", str(control_path)]
    for label, body in arms.items():
        path = tmp_path / f"across-{label}.json"
        path.write_text(json.dumps(body), encoding="utf-8")
        argv.extend(["--across", f"{label}={path}"])
    return subprocess.run(argv, cwd=REPO, capture_output=True, text=True, timeout=180, check=False)


def roster(verdicts: dict[str, bool]) -> dict:
    """A report that carries the per-question verdicts a cross-run pair is computed from."""
    return {
        "dataset": "longmemeval/s/500",
        "questionCount": len(verdicts),
        "generatedAt": "2026-10-29T00:00:00.000Z",
        "questions": [
            {"questionId": question, "correct": correct, "capability": "IE"}
            for question, correct in verdicts.items()
        ],
    }


def test_across_computes_bought_and_sold_against_one_shared_control(tmp_path: Path) -> None:
    """
    THE CASE THE INSTRUMENT WAS MISSING.

    `discordantQuestions` records one pair inside one run -- feature against the reference arm -- so two
    reports' lists are only commensurable if their control is the same run. A cross-run pair is the
    comparison the roadmap actually registers, and before this mode the tool could not express it at all:
    run against the two archived reports it produced an overlap of 208 of 448 and a reader could only
    conclude that route isolation had failed, when in fact both arms had beaten the same third party.
    """
    control = roster({"q1": True, "q2": False, "q3": True, "q4": False})
    arm = roster({"q1": False, "q2": True, "q3": True, "q4": False})

    completed = run_across(tmp_path, {"answer-line": arm}, control)

    assert completed.returncode == 0, completed.stderr
    # q2 bought (control wrong, arm right), q1 sold (control right, arm wrong).
    assert "answer-line (from across): bought 1, sold 1, net 0" in completed.stdout
    assert "bought: q2" in completed.stdout
    assert "sold:   q1" in completed.stdout


def test_across_refuses_a_pair_whose_rosters_differ(tmp_path: Path) -> None:
    """Two runs of different question sets cannot be paired: an id in one and not the other has no verdict."""
    control = roster({"q1": True, "q2": False})
    arm = roster({"q1": False})

    completed = run_across(tmp_path, {"answer-line": arm}, control)

    assert completed.returncode != 0
    assert "roster" in completed.stderr.lower()
    assert "q2" in completed.stderr


def test_refuses_to_mix_a_within_run_increment_with_a_cross_run_one(tmp_path: Path) -> None:
    """
    The mixing the registration calls out by name.

    A within-run increment's baseline is its own artifact's reference arm; a cross-run increment's is the
    control file. A union of the two is a number over two different third parties, and it would print as
    confidently as a valid one.
    """
    control = roster({"q1": True})
    arm = roster({"q1": False})
    within = report(["q9"], [])

    control_path = tmp_path / "control.json"
    control_path.write_text(json.dumps(control), encoding="utf-8")
    arm_path = tmp_path / "arm.json"
    arm_path.write_text(json.dumps(arm), encoding="utf-8")
    within_path = tmp_path / "within.json"
    within_path.write_text(json.dumps(within), encoding="utf-8")

    completed = subprocess.run(
        [
            "node",
            str(TOOL),
            "--control",
            str(control_path),
            "--across",
            f"answer-line={arm_path}",
            f"silent={within_path}",
        ],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )

    assert completed.returncode != 0
    assert "silent" in completed.stderr
    assert "mix" in completed.stderr.lower() or "across" in completed.stderr.lower()


def test_across_prints_the_control_identity_beside_every_increment(tmp_path: Path) -> None:
    """A union is only as good as the claim that both lists came from one baseline, so say which."""
    control = roster({"q1": True, "q2": False})
    arm = roster({"q1": False, "q2": True})

    completed = run_across(tmp_path, {"answer-line": arm}, control)

    assert completed.returncode == 0, completed.stderr
    assert "control:" in completed.stdout
    assert "2026-10-29T00:00:00.000Z" in completed.stdout
    assert "answer-line (from across)" in completed.stdout


def test_across_json_mode_names_the_mode_and_the_control(tmp_path: Path) -> None:
    """A later reader has to be able to tell a cross-run union from a within-run one without the log."""
    control = roster({"q1": True, "q2": False})
    arm = roster({"q1": False, "q2": True})

    control_path = tmp_path / "control.json"
    control_path.write_text(json.dumps(control), encoding="utf-8")
    arm_path = tmp_path / "arm.json"
    arm_path.write_text(json.dumps(arm), encoding="utf-8")
    completed = subprocess.run(
        [
            "node",
            str(TOOL),
            "--control",
            str(control_path),
            "--across",
            f"answer-line={arm_path}",
            "--json",
        ],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    parsed = json.loads(completed.stdout)
    assert parsed["mode"] == "across"
    assert parsed["control"]["generatedAt"] == "2026-10-29T00:00:00.000Z"
    assert parsed["portfolio"]["bought"] == ["q2"]
    assert parsed["portfolio"]["sold"] == ["q1"]


def test_within_run_json_mode_is_unchanged_by_the_new_mode(tmp_path: Path) -> None:
    """The archived reading keeps its shape: a mode field added, nothing moved."""
    completed = run(tmp_path, {"silent": report(["m1"], [])}, extra=["--json"])

    assert completed.returncode == 0, completed.stderr
    parsed = json.loads(completed.stdout)
    assert parsed["mode"] == "within-run"
    assert "control" not in parsed
    assert parsed["portfolio"]["bought"] == ["m1"]
