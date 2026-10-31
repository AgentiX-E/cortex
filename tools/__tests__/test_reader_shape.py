"""`reader-shape.mjs`, checked on hand-built artifacts that reproduce the two ways a reading can go wrong.

The tool exists because a published figure was recomputed on a different denominator, declared
unreproducible, and committed as an erratum while it in fact reproduced to the character. Two of the tests
below are that mistake, frozen:

  - **the same field has two defensible medians.** All questions with a decline counted as zero, and
    answered-only. Both are printed, and neither can be read without its label, because the difference between
    them is fifty-one declines removed from the denominator the reader is judged by.
  - **an exact ratio can have a numerator and a denominator from different populations.**
    `bareRetry.attempted / declines` is that ratio. The tool prints the population that is actually a
    partition, and says in a line of its own that the ratio is not a share.

The third thing under test is the only reading here whose failure is a bug rather than a result: if the retry
is on and the abstention gate holds, a non-`ABS` bare decline cannot survive the pass. When one does, the tool
names the question and exits non-zero instead of printing a number a reader would quote.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "reader-shape.mjs"

TOKEN = "INSUFFICIENT_EVIDENCE"


def record(
    question_id: str,
    *,
    capability: str = "MR",
    answer: str | None = None,
    raw_output: str | None = None,
    correct: bool = False,
) -> dict:
    return {
        "questionId": question_id,
        "question": f"question {question_id}",
        "capability": capability,
        "correct": correct,
        "answer": answer,
        "rawOutput": raw_output if raw_output is not None else (answer or TOKEN),
    }


def report(
    records: list[dict],
    *,
    correct: int = 0,
    bare_retry: dict | None = None,
    reader: str | None = None,
) -> dict:
    body = {
        "dataset": "longmemeval/s/test",
        "questionCount": len(records),
        "feature": {"metrics": {"correct": correct, "total": len(records), "accuracy": correct / max(len(records), 1)}},
        "questions": records,
    }
    if bare_retry is not None:
        body["bareRetry"] = bare_retry
    if reader is not None:
        body["memoryArmConfig"] = {"reader": reader}
    return body


def run(tmp_path: Path, bodies: list[tuple[str, dict]], *extra: str) -> subprocess.CompletedProcess:
    args = ["node", str(TOOL)]
    for label, body in bodies:
        path = tmp_path / f"{label}.json"
        path.write_text(json.dumps(body), encoding="utf-8")
        args += ["--report", str(path), "--label", label]
    return subprocess.run(args + list(extra), cwd=REPO, capture_output=True, text=True, timeout=180, check=False)


def test_both_denominators_are_printed_and_they_disagree(tmp_path: Path) -> None:
    """Two answers of ten characters and two declines: 5 over the questions, 10 over the answers."""
    body = report(
        [
            record("q1", answer="0123456789", correct=True),
            record("q2", answer="0123456789", correct=True),
            record("q3", capability="ABS"),
            record("q4", capability="ABS"),
        ]
    )
    completed = run(tmp_path, [("one", body)])
    assert completed.returncode == 0, completed.stderr
    assert "answer length, all questions (a decline counts as 0 chars)" in completed.stdout
    assert "answer length, answered only (this denominator removes the declines)" in completed.stdout
    # 0, 0, 10, 10 -> median 5 ; 10, 10 -> median 10
    assert "median 5 · p90 10 · n 4" in completed.stdout


def test_p90_uses_the_higher_order_statistic(tmp_path: Path) -> None:
    """Eight short answers, one of two characters, one of three: `higher` reads 3 where `nearest` reads 2."""
    answers = ["x"] * 8 + ["xx", "xxx"]
    body = report([record(f"q{index}", answer=answer) for index, answer in enumerate(answers)])
    completed = run(tmp_path, [("one", body)])
    assert completed.returncode == 0, completed.stderr
    assert "median 1 · p90 3 · n 10" in completed.stdout


def test_the_ratio_line_names_the_two_populations_it_is_not_a_share_of(tmp_path: Path) -> None:
    """Six retried first-pass declines plus three prose finals: nine, and 33.3% of them are prose."""
    body = report(
        [
            record("q1", answer="a"),
            record("q2", capability="ABS"),
            record("q3", capability="ABS"),
            record("q4", capability="ABS"),
            record("q5", capability="ABS"),
            record("q6", raw_output="Step 1:\n- [x] one item\n- [y] another"),
            record("q7", raw_output="The evidence does not state a count."),
            record("q8", raw_output="No item in the evidence states this."),
        ],
        bare_retry={"attempted": 6, "answered": 6},
    )
    completed = run(tmp_path, [("one", body)])
    assert completed.returncode == 0, completed.stderr
    assert "bareRetry: attempted 6, answered 6" in completed.stdout
    assert "first-pass non-ABS declines = attempted + prose finals = 9" in completed.stdout
    assert "prose share of that population: 33.3% (3 of 9)" in completed.stdout
    assert "attempted / declines is NOT a share" in completed.stdout
    assert "the denominator is final on all five" in completed.stdout


def test_a_non_abstention_bare_decline_the_retry_cannot_explain_is_a_failure(tmp_path: Path) -> None:
    """The gate leaked, or the census is not counting the pass it claims to. Either way, not a number."""
    body = report(
        [record("q1", answer="a"), record("q2", raw_output=TOKEN)],
        bare_retry={"attempted": 2, "answered": 2},
    )
    completed = run(tmp_path, [("one", body)])
    assert completed.returncode == 1, completed.stdout
    assert "invariant non-ABS bare finals <= (attempted - answered) / runs: VIOLATED (1 vs 0)" in completed.stdout
    assert "q2" in completed.stdout
    assert "the retry invariant is VIOLATED on one" in completed.stdout


def test_abstention_bare_declines_are_by_design_and_do_not_fail_it(tmp_path: Path) -> None:
    """`ABS`'s gold answer is a decline, so its bare replies are the correct answer and never a leak."""
    body = report(
        [record("q1", answer="a"), record("q2", capability="ABS"), record("q3", capability="ABS")],
        bare_retry={"attempted": 0, "answered": 0},
    )
    completed = run(tmp_path, [("one", body)])
    assert completed.returncode == 0, completed.stderr
    assert "by capability: ABS 2" in completed.stdout
    assert "outside ABS: 0" in completed.stdout
    assert "invariant non-ABS bare finals <= (attempted - answered) / runs: held (0 vs 0)" in completed.stdout


def test_a_missing_census_reads_as_unmeasured_and_not_as_zero(tmp_path: Path) -> None:
    """An artifact from before the census existed has no population to divide. It is not a zero."""
    body = report([record("q1", answer="a"), record("q2", raw_output=TOKEN)])
    completed = run(tmp_path, [("one", body)])
    assert completed.returncode == 0, completed.stderr
    assert "bareRetry: not reported by this artifact" in completed.stdout
    assert "invariant non-ABS bare finals <= (attempted - answered) / runs: not read (no census)" in completed.stdout
    assert "first-pass non-ABS declines" not in completed.stdout


def test_the_json_carries_the_same_readings_and_the_invariant(tmp_path: Path) -> None:
    body = report(
        [record("q1", answer="0123456789", correct=True), record("q2", capability="ABS")],
        correct=1,
        bare_retry={"attempted": 1, "answered": 1},
    )
    completed = run(tmp_path, [("one", body)], "--json")
    assert completed.returncode == 0, completed.stderr
    parsed = json.loads(completed.stdout)
    only = parsed["reports"][0]
    assert only["label"] == "one"
    assert only["length"]["allQuestions"] == {"n": 2, "median": 5.0, "p90": 10}
    assert only["length"]["answeredOnly"] == {"n": 1, "median": 10, "p90": 10}
    assert only["questionsByCapability"] == {"ABS": 1, "MR": 1}
    assert only["bareFinals"]["byCapability"] == {"ABS": 1}
    assert only["retry"]["firstPassOutsideAbstention"] == 1
    assert only["retry"]["proseShare"] == 0.0
    assert only["invariant"]["held"] is True
    assert parsed["invariantHeld"] is True


def test_two_reports_get_a_pair_block_with_the_readings_and_their_deltas(tmp_path: Path) -> None:
    """The pair block exists so a cross-reader reading is one command, not one paragraph per denominator."""
    left = report([record("q1", answer="0123456789", correct=True)], correct=1)
    right = report([record("q1", answer="x" * 30)], correct=0)
    completed = run(tmp_path, [("chat", left), ("pro", right)])
    assert completed.returncode == 0, completed.stderr
    assert "pair: chat → pro" in completed.stdout
    assert "median, all questions" in completed.stdout
    assert "+20.0" in completed.stdout
    assert "note: these are shape readings, not a ranking." in completed.stdout


def test_the_sample_states_its_own_capability_coverage(tmp_path: Path) -> None:
    """A small probe has to say which capabilities its twenty questions covered, not just how many it got."""
    body = report(
        [
            record("q1", answer="a", capability="MR"),
            record("q2", answer="b", capability="TR"),
            record("q3", capability="ABS"),
        ]
    )
    completed = run(tmp_path, [("one", body)])
    assert completed.returncode == 0, completed.stderr
    assert "questions by capability: ABS 1, MR 1, TR 1" in completed.stdout


def test_the_label_defaults_to_the_parent_directory_name(tmp_path: Path) -> None:
    """`--label` is optional, and the fallback has to be something a reader can trace to a run id."""
    directory = tmp_path / "40698867439"
    directory.mkdir()
    path = directory / "benchmark-cortex-memory-ablation-report.json"
    path.write_text(json.dumps(report([record("q1", answer="a")])), encoding="utf-8")
    completed = subprocess.run(
        ["node", str(TOOL), "--report", str(path)], cwd=REPO, capture_output=True, text=True, timeout=180, check=False
    )
    assert completed.returncode == 0, completed.stderr
    assert completed.stdout.startswith("40698867439\n")


def test_an_unreadable_report_is_refused_by_name(tmp_path: Path) -> None:
    missing = tmp_path / "absent.json"
    completed = subprocess.run(
        ["node", str(TOOL), "--report", str(missing)],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    assert completed.returncode == 2
    assert "cannot read" in completed.stderr
    assert str(missing) in completed.stderr


def test_a_label_without_a_report_is_refused(tmp_path: Path) -> None:
    completed = subprocess.run(
        ["node", str(TOOL), "--label", "orphan"], cwd=REPO, capture_output=True, text=True, timeout=180, check=False
    )
    assert completed.returncode == 2
    assert "--label must follow a --report" in completed.stderr


def test_the_shape_rule_is_the_one_the_package_uses_and_not_a_copy(tmp_path: Path) -> None:
    """Four shapes the live predicate calls bare — including the labelled one a hand-rolled copy missed.

    The first draft of the tool restated the rule as "drop the token, require wrappers only", which read
    `Answer: INSUFFICIENT_EVIDENCE` as content. Six IE questions in run `40807829150` end that way, and
    `bare-decline-label.test.ts` exists because a prompt that names a reply shape can disable a recovery pass
    without moving a single field of the artifact. Importing the predicate makes that class of divergence
    unreachable, and this test is what would notice if the import became a copy again.
    """
    shapes = [
        ("q1", "INSUFFICIENT_EVIDENCE"),
        ("q2", "**INSUFFICIENT_EVIDENCE**"),
        ("q3", "Answer: INSUFFICIENT_EVIDENCE"),
        ("q4", "Answer - insufficient_evidence"),
    ]
    body = report([record(question_id, raw_output=raw) for question_id, raw in shapes])
    completed = run(tmp_path, [("one", body)])
    assert completed.returncode == 0, completed.stderr
    assert "bare declines in the final record: 4 of 4" in completed.stdout


def test_a_decline_that_carried_its_list_is_prose_and_keeps_its_bare_count_at_zero(tmp_path: Path) -> None:
    """`token after a list` is the shape the enumeration recovery pass exists for, and it is not a bare decline."""
    body = report(
        [
            record("q1", raw_output="Step 1:\n- [x] one item\n- [y] another\nINSUFFICIENT_EVIDENCE"),
            record("q2", raw_output="   "),
        ]
    )
    completed = run(tmp_path, [("one", body)])
    assert completed.returncode == 0, completed.stderr
    assert "bare declines in the final record: 0 of 2" in completed.stdout
    assert "empty replies among the declines: 1" in completed.stdout


def test_a_multi_repetition_census_is_not_divided_by_one_run_of_declines(tmp_path: Path) -> None:
    """The defect the first real four-run artifact exposed: a summed counter over a per-question denominator.

    `bareRetry` counts the whole process, so `runs: 4` reports four repetitions of attempts while `questions[]`
    holds one record per question. The first version of the tool printed "first-pass non-ABS declines = 132,
    prose share 15.9%" for `41185512391` -- two populations again, one level up from the one §13.192.4 repaired.
    The share is now refused rather than approximated, and the per-run rate is printed instead.
    """
    body = report(
        [
            record("q1", answer="a"),
            record("q2", capability="ABS"),
            record("q3", raw_output="The evidence does not state a count."),
        ],
        bare_retry={"attempted": 20, "answered": 20},
    )
    body["runs"] = 4
    completed = run(tmp_path, [("one", body)])
    assert completed.returncode == 0, completed.stderr
    assert "4 repetition(s)" in completed.stdout
    assert "attempted 20, answered 20 over 4 repetition(s) = 5 per run" in completed.stdout
    assert "not computable across 4 repetition(s)" in completed.stdout
    assert "prose share of that population" not in completed.stdout
    assert "first-pass non-ABS declines = attempted" not in completed.stdout


def test_the_roster_of_a_multi_repetition_artifact_is_printed_as_an_interval(tmp_path: Path) -> None:
    """`feature.metrics.correct` is one draw; `ablation.featureAggregate` is the distribution. Both are printed."""
    body = report([record("q1", answer="a", correct=True), record("q2", capability="ABS")], correct=1)
    body["runs"] = 4
    body["ablation"] = {"featureAggregate": {"min": 0.5, "max": 1.0, "avg": 0.75, "median": 0.75}}
    completed = run(tmp_path, [("one", body)])
    assert completed.returncode == 0, completed.stderr
    assert "roster 1/2 (one repetition, the one whose records are here)" in completed.stdout
    assert "roster across 4 repetition(s): min 1 / max 2 / mean 2 (0.7500) / median 2" in completed.stdout


def test_a_single_repetition_artifact_does_not_print_an_interval_of_one(tmp_path: Path) -> None:
    """An interval with one draw in it is not an interval, and printing it invites reading it as a stability claim."""
    body = report([record("q1", answer="a", correct=True)], correct=1)
    body["ablation"] = {"featureAggregate": {"min": 1.0, "max": 1.0, "avg": 1.0, "median": 1.0}}
    completed = run(tmp_path, [("one", body)])
    assert completed.returncode == 0, completed.stderr
    assert "roster across" not in completed.stdout


def test_the_reader_record_is_rendered_and_not_printed_as_an_object(tmp_path: Path) -> None:
    """The field §13.110.1 added is the one this tool exists to make legible, so it cannot read `[object Object]`."""
    body = report([record("q1", answer="a")])
    body["memoryArmConfig"] = {
        "reader": {
            "provider": "deepseek",
            "model": "deepseek-chat",
            "baseUrl": "https://api.deepseek.com/v1",
            "thinking": "disabled",
            "temperature": 0,
        }
    }
    completed = run(tmp_path, [("one", body)])
    assert completed.returncode == 0, completed.stderr
    assert "reader deepseek/deepseek-chat (thinking disabled, temperature 0)" in completed.stdout
    assert "[object Object]" not in completed.stdout


def test_a_reader_that_sent_no_temperature_says_so_rather_than_printing_null(tmp_path: Path) -> None:
    """`null` is a fact -- the request carried none -- and it is not the same fact as `0`."""
    body = report([record("q1", answer="a")])
    body["memoryArmConfig"] = {"reader": {"provider": "deepseek", "model": "deepseek-chat", "temperature": None}}
    completed = run(tmp_path, [("one", body)])
    assert completed.returncode == 0, completed.stderr
    assert "reader deepseek/deepseek-chat (thinking not reported, no temperature sent)" in completed.stdout
