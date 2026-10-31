"""`window-pair.mjs`, checked on two hand-built artifacts and a wired summary.

The tool reads §13.153.5's six criteria off **the pair** rather than off one run, because five of the six
are statements about what changed between the control and the treatment. Two of them are what make it worth
a file rather than five lines of throwaway code:

  - **a delivery can be reordered without changing what it contains.** Criterion 2 is that the multiset is
    unchanged per question, criterion 3 is that only the temporal route moved, and criterion 6 is that
    nothing else flows. All three are the same comparison applied to different partitions of the roster, so
    a tool that reports the diff once can answer all three and cannot answer them inconsistently.
  - **a multiset difference is not a result, it is a comparability failure.** The treated and control
    artifacts are different commits; if a pool moved between them, a sequence difference no longer means
    the mechanism ran. The tool says that in the verdict line rather than leaving a reader to notice it,
    because the alternative reading -- "the reorder changed 40 questions" -- is the one that looks like a
    finding.

The refusals are the other half: a question present in one artifact and not the other must be named rather
than dropped, since a silent inner join shrinks every denominator on the page.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "window-pair.mjs"


def turn(text: str) -> dict:
    return {"index": 0, "text": text}


def record(
    question_id: str,
    *,
    capability: str = "TR",
    correct: bool = True,
    prompt_chars: int = 1000,
    prompt_digest: str | None = None,
    turns: list[str] | None = None,
) -> dict:
    body = {
        "questionId": question_id,
        "question": f"question {question_id}",
        "capability": capability,
        "correct": correct,
        "promptChars": prompt_chars,
        "turns": [turn(text) for text in (turns if turns is not None else ["a", "b", "c"])],
    }
    # Absent rather than empty when the caller names none: "this artifact has no digest" and "this artifact's
    # digest is the hash of nothing" are different states, and only one of them is a measurement.
    if prompt_digest is not None:
        body["promptDigest"] = prompt_digest
    return body


def report(records: list[dict]) -> dict:
    return {"dataset": "longmemeval/s/test", "questionCount": len(records), "questions": records}


def wired(moved: list[dict]) -> dict:
    return {"control": "control.json", "total": {"moved": len(moved)}, "moved": moved}


def run(
    tmp_path: Path,
    control: dict,
    treated: dict,
    *,
    wired_body: dict | None = None,
) -> subprocess.CompletedProcess:
    paths = {}
    for name, body in (("control", control), ("treated", treated), ("wired", wired_body)):
        if body is None:
            continue
        path = tmp_path / f"{name}.json"
        path.write_text(json.dumps(body), encoding="utf-8")
        paths[name] = path
    args = ["node", str(TOOL), "--control", str(paths["control"]), "--treated", str(paths["treated"])]
    if "wired" in paths:
        args += ["--wired", str(paths["wired"])]
    return subprocess.run(args, cwd=REPO, capture_output=True, text=True, timeout=180, check=False)


def test_identical_deliveries_read_as_no_change(tmp_path: Path) -> None:
    """Same order everywhere: criteria 2, 3 and 6 are met by construction and the tool says so."""
    body = report([record("q1"), record("q2", capability="MR")])
    completed = run(tmp_path, body, report([record("q1"), record("q2", capability="MR")]))
    assert completed.returncode == 0, completed.stderr
    assert "criterion 2: met" in completed.stdout
    assert "criterion 3: met" in completed.stdout
    assert "order changes: 0" in completed.stdout


def test_a_reorder_on_a_temporal_question_is_reported_as_moved_not_changed(tmp_path: Path) -> None:
    """The mechanism's whole observable: same three turns, different first one."""
    control = report([record("q1", turns=["a", "b", "c"])])
    treated = report([record("q1", turns=["c", "a", "b"])])
    completed = run(tmp_path, control, treated)
    assert completed.returncode == 0, completed.stderr
    assert "multiset changes: 0" in completed.stdout
    assert "order changes: 1" in completed.stdout
    assert "criterion 3: met" in completed.stdout


def test_a_delivery_change_on_a_non_temporal_route_fails_criterion_three(tmp_path: Path) -> None:
    """A window on a route that has no date is a mechanism reaching somewhere it cannot have a window."""
    control = report([record("q1", capability="MR", turns=["a", "b", "c"])])
    treated = report([record("q1", capability="MR", turns=["b", "a", "c"])])
    completed = run(tmp_path, control, treated)
    assert "criterion 3: FAILED" in completed.stdout
    assert "q1" in completed.stdout


def test_a_changed_multiset_is_a_comparability_failure_and_not_a_result(tmp_path: Path) -> None:
    """Two artifacts from different code: the pools moved, so no order difference can be attributed."""
    control = report([record("q1", turns=["a", "b", "c"])])
    treated = report([record("q1", turns=["a", "b", "d"])])
    completed = run(tmp_path, control, treated)
    assert "criterion 2: FAILED" in completed.stdout
    assert "not comparable" in completed.stdout


def test_conversions_are_counted_against_the_reachable_and_wrong_population(tmp_path: Path) -> None:
    """Criterion 4: the bar is 4 of the 7 questions the control gets wrong among the ones the tool moved."""
    control = report(
        [record(f"q{index}", correct=False) for index in range(1, 8)]
        + [record("ok1", correct=True), record("ok2", correct=True)]
    )
    treated = report(
        [record(f"q{index}", correct=index <= 4) for index in range(1, 8)]
        + [record("ok1", correct=True), record("ok2", correct=True)]
    )
    moved = [{"id": f"q{index}", "correct": False} for index in range(1, 8)] + [
        {"id": "ok1", "correct": True},
        {"id": "ok2", "correct": True},
    ]
    completed = run(tmp_path, control, treated, wired_body=wired(moved))
    assert "converted 4 of 7" in completed.stdout
    assert "criterion 4: met" in completed.stdout


def test_three_conversions_do_not_meet_the_bar(tmp_path: Path) -> None:
    """The bar is over half the reach, and 3 of 7 is not."""
    control = report([record(f"q{index}", correct=False) for index in range(1, 8)])
    treated = report([record(f"q{index}", correct=index <= 3) for index in range(1, 8)])
    moved = [{"id": f"q{index}", "correct": False} for index in range(1, 8)]
    completed = run(tmp_path, control, treated, wired_body=wired(moved))
    assert "converted 3 of 7" in completed.stdout
    assert "criterion 4: FAILED" in completed.stdout


def test_selling_the_questions_the_control_gets_right_fails_criterion_five(tmp_path: Path) -> None:
    """Two sold of two: a front-loading that buys and sells the same count reads as zero."""
    control = report([record("a", correct=True), record("b", correct=True)])
    treated = report([record("a", correct=False), record("b", correct=False)])
    completed = run(tmp_path, control, treated, wired_body=wired([{"id": "a", "correct": True}, {"id": "b", "correct": True}]))
    assert "sold 2 of 2" in completed.stdout
    assert "criterion 5: FAILED" in completed.stdout


def test_one_sale_of_two_meets_the_bar(tmp_path: Path) -> None:
    """At most one of the two."""
    control = report([record("a", correct=True), record("b", correct=True)])
    treated = report([record("a", correct=False), record("b", correct=True)])
    completed = run(tmp_path, control, treated, wired_body=wired([{"id": "a", "correct": True}, {"id": "b", "correct": True}]))
    assert "sold 1 of 2" in completed.stdout
    assert "criterion 5: met" in completed.stdout


def test_flips_on_an_untouched_prompt_are_the_floor_and_are_priced_against_it(tmp_path: Path) -> None:
    """Criterion 6: on questions whose delivery did not move, a flip is reader churn, not the mechanism.

    One flip in forty is 2.5%, below the measured 5.0% floor, so the criterion is met -- and the same one
    flip in ten is 10.0% and is not. The pair of tests is the point: the bar has to bite somewhere.
    """
    control = report([record(f"u{index}", capability="IE") for index in range(1, 41)])
    treated = report([record(f"u{index}", capability="IE", correct=index > 1) for index in range(1, 41)])
    completed = run(tmp_path, control, treated)
    assert "untouched flips: 1 of 40" in completed.stdout
    assert "criterion 6: met" in completed.stdout


def test_one_flip_in_ten_is_above_the_floor_and_fails(tmp_path: Path) -> None:
    """The same one flip on a roster ten times smaller is 10.0%, and the floor is 5.0%."""
    control = report([record(f"u{index}", capability="IE") for index in range(1, 11)])
    treated = report([record(f"u{index}", capability="IE", correct=index > 1) for index in range(1, 11)])
    completed = run(tmp_path, control, treated)
    assert "untouched flips: 1 of 10" in completed.stdout
    assert "criterion 6: FAILED" in completed.stdout


def test_a_question_present_in_only_one_artifact_is_named(tmp_path: Path) -> None:
    """An inner join would shrink every denominator on the page without saying so."""
    control = report([record("q1"), record("only-control")])
    treated = report([record("q1"), record("only-treated")])
    completed = run(tmp_path, control, treated)
    assert completed.returncode == 2, completed.stdout
    assert "only-control" in completed.stderr
    assert "only-treated" in completed.stderr


def test_the_wired_summary_is_cross_checked_against_the_artifacts(tmp_path: Path) -> None:
    """The replay's moved set and the pair's order-diff set are two instruments on one fact.

    A disagreement means one of them is measuring something else, and the tool says which ids disagree
    rather than reporting the intersection.
    """
    control = report([record("q1", turns=["a", "b", "c"]), record("q2", turns=["a", "b", "c"])])
    treated = report([record("q1", turns=["c", "a", "b"]), record("q2", turns=["a", "b", "c"])])
    completed = run(
        tmp_path,
        control,
        treated,
        wired_body=wired([{"id": "q1", "correct": True}, {"id": "q2", "correct": True}]),
    )
    assert "wired only: q2" in completed.stdout
    assert "pair only: -" in completed.stdout


def test_a_population_that_is_not_the_registered_seven_is_named(tmp_path: Path) -> None:
    """The bar is written over a reach of 7, and a different denominator means it is being misapplied."""
    control = report([record(f"q{index}", correct=False) for index in range(1, 6)])
    treated = report([record(f"q{index}", correct=True) for index in range(1, 6)])
    moved = [{"id": f"q{index}", "correct": False} for index in range(1, 6)]
    completed = run(tmp_path, control, treated, wired_body=wired(moved))
    assert "converted 5 of 5 reachable-and-wrong (bar 4)" in completed.stdout
    assert "note: the registered population is 7" in completed.stdout


def test_two_prompts_of_the_same_length_are_not_the_same_prompt(tmp_path: Path) -> None:
    """The reason `promptDigest` exists at all, read as a criterion-free line.

    Every reading this campaign has taken of "did the prompt move" compared `promptChars`, and a treatment
    that changes bytes without changing length -- a swapped instruction line, a reordered block -- reads as
    unchanged under that comparison. §13.171 added the digest for exactly this, and until now no tool read it:
    `promptCharsEqual` was computed in this file and printed nowhere.
    """
    control = report([record("q1", prompt_chars=1000, prompt_digest="aaaaaaaaaaaaaaaa")])
    treated = report([record("q1", prompt_chars=1000, prompt_digest="bbbbbbbbbbbbbbbb")])
    completed = run(tmp_path, control, treated)
    assert completed.returncode == 0, completed.stderr
    assert "prompt identity: 0 digest-equal, 1 digest-differs, 0 unmeasured" in completed.stdout
    assert "length is not identity: 1 question(s) changed bytes at the same length" in completed.stdout
    assert "q1" in completed.stdout


def test_equal_digests_read_as_equal_and_the_capability_breakdown_agrees(tmp_path: Path) -> None:
    """A digest is only worth reading if the equal case is reported as loudly as the different one."""
    body = report(
        [
            record("ab1", capability="ABS", prompt_digest="1111111111111111"),
            record("ie1", capability="IE", prompt_digest="2222222222222222"),
        ]
    )
    completed = run(tmp_path, body, body)
    assert completed.returncode == 0, completed.stderr
    assert "prompt identity: 2 digest-equal, 0 digest-differs, 0 unmeasured" in completed.stdout
    assert "ABS" in completed.stdout and "IE" in completed.stdout


def test_an_absent_digest_is_unmeasured_and_never_counts_as_equal(tmp_path: Path) -> None:
    """Two artifacts that both predate the field do not thereby hold the same prompts.

    The three-state reading is the point: a tool that folded "no digest" into "equal" would report an
    identity it never checked, and archived artifacts without the field are exactly where that would happen.
    """
    body = report([record("q1", prompt_chars=1000)])
    completed = run(tmp_path, body, body)
    assert completed.returncode == 0, completed.stderr
    assert "prompt identity: 0 digest-equal, 0 digest-differs, 1 unmeasured" in completed.stdout
    assert "length is not identity" not in completed.stdout
