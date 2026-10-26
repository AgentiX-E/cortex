"""The paired-test tool, checked on hand-built runs.

The statistics function has its own unit tests; this file tests the **tool**: that it reads two harness
payloads, pairs by question id, prints the p-value a reader can check, and refuses to report a comparison it
cannot make. The last case matters most — a tool that silently prints a table for two runs with nothing in
common would let a reader believe a pairing happened.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "paired-test.mjs"


def record(question_id: str, correct: bool, read: bool = True) -> dict:
    return {
        "id": question_id,
        "capability": "TR",
        "found": True,
        "foundAll": True,
        "read": read,
        "correct": correct,
    }


def score(provider: str, records: list[dict]) -> dict:
    return {
        "provider": provider,
        "build": "none",
        "questions": len(records),
        "measured": len(records),
        "unmeasurable": 0,
        "found": len(records),
        "foundAll": len(records),
        "empty": 0,
        "recallAtK": 1,
        "recallAllAtK": 1,
        "mrr": 1,
        "sessions": 0,
        "turns": 0,
        "meanContextChars": 100,
        "correct": sum(1 for r in records if r["correct"]),
        "read": len(records),
        "accuracy": sum(1 for r in records if r["correct"]) / max(1, len(records)),
        "abstained": 0,
        "skipped": [],
        "byCapability": {},
        "ingestSkipped": 0,
        "records": records,
    }


def payload(dataset: str, scores: list[dict]) -> dict:
    return {"config": {"dataset": dataset}, "scores": scores}


def run(tmp_path: Path, baseline: dict, treatment: dict) -> str:
    a = tmp_path / "baseline.json"
    b = tmp_path / "treatment.json"
    a.write_text(json.dumps(baseline), encoding="utf-8")
    b.write_text(json.dumps(treatment), encoding="utf-8")
    completed = subprocess.run(
        ["node", str(TOOL), str(a), str(b)],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    return completed.stdout


def test_reports_the_same_p_value_a_reviewer_can_compute(tmp_path: Path) -> None:
    """Four improved and none regressed is 0.125, and the tool has to say 'not significant' for it."""
    before = [score("arm", [record(f"q{i}", i < 11) for i in range(20)])]
    after = [score("arm", [record(f"q{i}", i < 15) for i in range(20)])]
    out = run(tmp_path, payload("longmemeval/s/100", before), payload("longmemeval/s/100", after))
    assert "0.1250" in out
    assert "not significant" in out
    assert "0.200" in out or "20.0%" in out


def test_says_improved_only_when_the_test_clears_alpha(tmp_path: Path) -> None:
    before = [score("arm", [record(f"q{i}", False) for i in range(20)])]
    after = [score("arm", [record(f"q{i}", True) for i in range(20)])]
    out = run(tmp_path, payload("d", before), payload("d", after))
    assert "improved" in out
    assert "not significant" not in out


def test_reports_no_change_rather_than_certainty(tmp_path: Path) -> None:
    """Identical runs must read 'no change', not p=0 and not significance."""
    before = [score("arm", [record(f"q{i}", i % 2 == 0) for i in range(10)])]
    out = run(tmp_path, payload("d", before), payload("d", before))
    assert "no change" in out
    assert "1.0000" in out


def test_warns_when_the_two_runs_name_different_datasets(tmp_path: Path) -> None:
    """Not fatal, but a paired test over two samples is not a paired test and the reader has to see that."""
    before = [score("arm", [record("q0", False)])]
    after = [score("arm", [record("q0", True)])]
    out = run(tmp_path, payload("longmemeval/s/100", before), payload("longmemeval/s/500", after))
    assert "different datasets" in out


def test_says_so_when_nothing_can_be_paired(tmp_path: Path) -> None:
    unread = [score("arm", [record("q0", False, read=False)])]
    out = run(tmp_path, payload("d", unread), payload("d", unread))
    assert "nothing here can be paired" in out


def test_reports_unmatched_questions(tmp_path: Path) -> None:
    """A subset that shrank between runs is a fact about the runs, not something to average away."""
    before = [score("arm", [record("q0", True), record("q1", True)])]
    after = [score("arm", [record("q0", True)])]
    out = run(tmp_path, payload("d", before), payload("d", after))
    assert "1 unmatched" in out


def test_rejects_a_payload_that_is_not_a_harness_run(tmp_path: Path) -> None:
    broken = tmp_path / "broken.json"
    broken.write_text('{"nope": true}', encoding="utf-8")
    good = tmp_path / "good.json"
    good.write_text(json.dumps(payload("d", [score("arm", [record("q0", True)])])), encoding="utf-8")
    completed = subprocess.run(
        ["node", str(TOOL), str(broken), str(good)],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    assert completed.returncode != 0
    assert "does not look like a harness run" in completed.stderr


def ablation(records: list[dict], dataset: str = "longmemeval/s/500") -> dict:
    """A benchmark ablation report: one entry per question, the feature verdict in `correct`."""
    return {
        "dataset": dataset,
        "questions": [{"id": r["id"], "capability": r["capability"], "correct": r["correct"]} for r in records],
    }


def test_pairs_two_ablation_reports_without_a_second_comparator(tmp_path: Path) -> None:
    """The benchmark report carries `questions[]`, the harness carries `scores[]`; one statistic reads both.

    Two shapes and one comparator, because the alternative -- a second McNemar for the second envelope -- is what
    this repository has caught twice already: a tool that grows its own copy of a decision stops agreeing with the
    original without anybody noticing.
    """
    before = ablation([record(f"q{i}", i < 10) for i in range(20)])
    after = ablation([record(f"q{i}", i < 14) for i in range(20)])
    out = run(tmp_path, before, after)
    assert "feature" in out
    assert "4" in out  # net +4
    # Four improved and none regressed is 0.125, the same arithmetic the harness path produces.
    assert "0.1250" in out


def test_refuses_to_pair_a_report_against_a_competitor_run(tmp_path: Path) -> None:
    """Different provider names is the guard, so two artifacts that describe different arms cannot be paired.

    A report's `correct` is the feature side; a harness run's rows are named providers. Sharing no name means the
    tool says so rather than comparing a feature arm against a competitor provider and reporting it as a delta.
    """
    report = ablation([record("q0", True), record("q1", False)])
    competitor = payload("longmemeval/s/500", [score("cortex-session", [record("q0", False), record("q1", True)])])
    out = run(tmp_path, report, competitor)
    assert "nothing here can be paired" in out


def test_reads_the_dataset_from_either_shape(tmp_path: Path) -> None:
    """The dataset label is what warns a reader that two runs are not the same sample."""
    before = ablation([record("q0", False)], dataset="longmemeval/s/100")
    after = ablation([record("q0", True)], dataset="longmemeval/s/500")
    out = run(tmp_path, before, after)
    assert "different datasets" in out


if __name__ == "__main__":
    sys.exit(subprocess.call(["pytest", "-q", __file__]))
