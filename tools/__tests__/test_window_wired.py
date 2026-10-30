"""`window-wired.mjs`, checked against hand-built artifacts.

The tool prices §13.153's time-window reorder by **running the product** rather than by reimplementing
it, and the two numbers that make it worth its own file are distinctions `window-reach.mjs` cannot make:

  - **fired is not moved.** A window that admits turns already at the front of the delivery reorders
    nothing, and the prompt comes back byte-identical. `window-reach` counts questions whose list a
    window *could* split; 19 of the control run's questions resolve a window and 9 are actually moved
    (§13.153.4), and the gap is exactly this distinction.
  - **delivered set is not an input.** Whether the reorder changes which turns survive the budget is a
    property of `buildPrompt` -- it promotes `carried`, never `turns` -- so only the code can answer it.
    Every test below that reaches the budget asserts the multiset is unchanged, and a non-zero would be
    a defect rather than a result.

The refusals are the other half, for the reason the other two tools' suites give: each of them replaces
a plausible number with one that is wrong in a direction nobody would notice. A skipped turn shrinks a
delivery every count is derived from, and a duplicated id makes the two arms unjoinable.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "window-wired.mjs"


def turn(date: str, content: str = "something was said", *, weekday: str | None = None) -> dict:
    """One delivered turn. No weekday label by default, because the reader validates it against the date."""
    stamp = f"[{date} ({weekday}) 09:00]" if weekday else f"[{date}]"
    return {"index": 0, "text": f"{stamp} user: {content}"}


def record(
    question_id: str,
    question: str = "What did I do yesterday?",
    *,
    capability: str = "TR",
    correct: bool = False,
    turns: list[dict] | None = None,
    question_date: str | None = "2023/02/15",
) -> dict:
    return {
        "questionId": question_id,
        "question": question,
        "capability": capability,
        **({"questionDate": question_date} if question_date is not None else {}),
        "groundTruth": "blue",
        "answer": "blue" if correct else None,
        "rawOutput": "blue",
        "correct": correct,
        "turns": turns if turns is not None else [turn("2023/02/01"), turn("2023/02/14")],
    }


def artifact(questions: list[dict]) -> dict:
    return {"dataset": "longmemeval/s/test", "questionCount": len(questions), "questions": questions}


def filler(count: int) -> list[dict]:
    """Questions with no period reference, so they are outside every window."""
    return [
        record(
            f"filler-{index}",
            f"What colour was object number {index}?",
            capability="IE",
            turns=[turn("2023/02/01")],
        )
        for index in range(count)
    ]


def run(*args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["node", str(TOOL), *args], capture_output=True, text=True, cwd=REPO, check=False)


def write(tmp_path, body: dict, name: str = "control.json") -> str:
    path = tmp_path / name
    path.write_text(json.dumps(body), encoding="utf-8")
    return str(path)


def reading(tmp_path, body: dict) -> dict:
    result = run("--control", write(tmp_path, body), "--json")
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


# --------------------------------------------------------------------------------------------------
# Usage and refusals
# --------------------------------------------------------------------------------------------------


def test_requires_a_control():
    result = run("--json")
    assert result.returncode == 2
    assert "--control is required" in result.stderr


def test_refuses_an_unknown_argument():
    result = run("--control", "x.json", "--wire")
    assert result.returncode == 2
    assert "unrecognised argument" in result.stderr


def test_refuses_a_control_given_twice(tmp_path):
    control = write(tmp_path, artifact(filler(1)))
    result = run("--control", control, "--control", control)
    assert result.returncode == 2
    assert "given twice" in result.stderr


def test_refuses_unreadable_json(tmp_path):
    path = tmp_path / "broken.json"
    path.write_text("{not json", encoding="utf-8")
    result = run("--control", str(path))
    assert result.returncode == 2
    assert "is not JSON" in result.stderr


def test_refuses_a_missing_file(tmp_path):
    result = run("--control", str(tmp_path / "absent.json"))
    assert result.returncode == 2
    assert "cannot read" in result.stderr


def test_refuses_an_artifact_with_no_questions_array(tmp_path):
    result = run("--control", write(tmp_path, {"dataset": "x"}))
    assert result.returncode == 2
    assert "no questions array" in result.stderr


def test_reports_an_empty_artifact_as_unsupported(tmp_path):
    result = run("--control", write(tmp_path, artifact([])))
    assert result.returncode == 1
    assert "holds no questions" in result.stderr


def test_refuses_a_record_with_no_id(tmp_path):
    body = artifact(filler(1))
    del body["questions"][0]["questionId"]
    result = run("--control", write(tmp_path, body))
    assert result.returncode == 2
    assert "no questionId" in result.stderr


def test_refuses_a_duplicate_id(tmp_path):
    body = artifact([record("a", "What did I do yesterday?")] + [record("a", "What did I do yesterday?")])
    result = run("--control", write(tmp_path, body))
    assert result.returncode == 2
    assert "duplicate questionId" in result.stderr


def test_refuses_a_record_with_no_question_text(tmp_path):
    body = artifact(filler(1))
    body["questions"][0]["question"] = ""
    result = run("--control", write(tmp_path, body))
    assert result.returncode == 2
    assert "no question text" in result.stderr


def test_refuses_a_record_with_no_turns(tmp_path):
    body = artifact(filler(1))
    del body["questions"][0]["turns"]
    result = run("--control", write(tmp_path, body))
    assert result.returncode == 2
    assert "no turns array" in result.stderr


def test_refuses_a_turn_that_is_neither_text_nor_an_object(tmp_path):
    body = artifact(filler(1))
    body["questions"][0]["turns"] = [{"index": 0, "content": "no text key"}]
    result = run("--control", write(tmp_path, body))
    assert result.returncode == 2
    assert "neither text nor {text}" in result.stderr


def test_reports_an_artifact_with_no_resolvable_window_as_unsupported(tmp_path):
    # A well-formed artifact that answers nothing here is a different fix from a different command.
    result = run("--control", write(tmp_path, artifact(filler(5))))
    assert result.returncode == 1
    assert "resolves a window" in result.stderr


# --------------------------------------------------------------------------------------------------
# The counts
# --------------------------------------------------------------------------------------------------


def test_counts_a_reorder_the_control_got_wrong_as_a_conversion(tmp_path):
    data = reading(tmp_path, artifact([record("tr-1", correct=False)] + filler(3)))
    assert data["total"]["fired"] == 1
    assert data["total"]["moved"] == 1
    assert data["total"]["converted"] == 1
    assert data["total"]["sold"] == 0


def test_counts_a_reorder_of_a_correct_answer_as_a_sell(tmp_path):
    # The other half of the same event. A run that buys four and sells four has had two effects and a
    # delta of zero, and only this split can say so (§13.152.4 criterion 6).
    data = reading(tmp_path, artifact([record("tr-1", correct=True)] + filler(3)))
    assert data["total"]["moved"] == 1
    assert data["total"]["converted"] == 0
    assert data["total"]["sold"] == 1


def test_does_not_count_a_window_that_admits_the_first_turn_as_a_move(tmp_path):
    # Fired but inert: the admitted turn is already at the front, so the promotion is a no-op and the
    # prompt is byte-identical. This is the distinction `window-reach` cannot make.
    body = [record("tr-1", turns=[turn("2023/02/14"), turn("2023/02/01")])] + filler(3)
    data = reading(tmp_path, artifact(body))
    assert data["total"]["fired"] == 1
    assert data["total"]["moved"] == 0
    assert data["total"]["converted"] == 0


def test_never_changes_the_delivered_multiset(tmp_path):
    # Criterion 2, on the product. The list is long enough that the budget binds, which is the case where a
    # promotion applied before the cut would change **which** turns survive it.
    long_list = [turn(f"2023/02/{day:02d}", "x" * 400) for day in range(1, 29)]
    body = [record("tr-1", turns=long_list)] + filler(2)
    data = reading(tmp_path, artifact(body))
    assert data["broken"] == []
    assert data["total"]["broken"] == 0


def test_never_promotes_a_turn_whose_weekday_label_disagrees_with_its_date(tmp_path):
    # §13.152.1's validation, reached from this side. 2023/02/14 was a Tuesday, so a stamp calling it
    # `(Wed)` is a renderer that moved one of the two encodings -- and promoting on the moved date would
    # front-load the wrong turns. The turn is refused, not skipped, and the delivery does not move.
    body = [record("tr-1", turns=[turn("2023/02/01"), turn("2023/02/14", weekday="Wed")])] + filler(2)
    data = reading(tmp_path, artifact(body))
    assert data["total"]["fired"] == 1
    assert data["total"]["moved"] == 0


def test_administers_the_temporal_capability_and_nothing_else(tmp_path):
    # The mechanism is reached through the route that is handed a reference date. An MR question with the
    # same period reference cannot resolve a window, and a tool that reported one would be pricing a
    # population the run does not administer.
    body = [
        record("mr-1", capability="MR"),
        record("ie-1", capability="IE"),
        record("tr-1", capability="TR"),
    ]
    data = reading(tmp_path, artifact(body))
    assert data["byCapability"]["MR"]["fired"] == 0
    assert data["byCapability"]["IE"]["fired"] == 0
    assert data["byCapability"]["TR"]["fired"] == 1


def test_reports_the_substitution_rate_rather_than_hiding_it(tmp_path):
    # An artifact written before §13.152.2 has no question date, so every window is displaced by however
    # long after the haystack the question was asked. The count is printed because a reader who does not
    # know that cannot tell an approximate window from an exact one.
    body = [
        record("tr-1", question_date=None),
        record("tr-2", question_date="2023/02/15"),
    ]
    data = reading(tmp_path, artifact(body))
    assert data["referenceSubstituted"] == 1
    assert data["total"]["fired"] == 2


def test_reports_how_many_turns_a_reorder_promotes(tmp_path):
    long_list = [turn("2023/02/01"), turn("2023/02/20"), turn("2023/02/14"), turn("2023/02/21")]
    data = reading(tmp_path, artifact([record("tr-1", turns=long_list)]))
    assert data["moved"][0]["promoted"] == 1
    assert data["promotedTurns"]["mean"] == 1
    assert data["moved"][0]["delivered"] == 4


def test_human_output_names_the_three_counts_and_the_criterion(tmp_path):
    result = run("--control", write(tmp_path, artifact([record("tr-1")])))
    assert result.returncode == 0
    assert "fired" in result.stdout
    assert "converted" in result.stdout
    assert "sold" in result.stdout
    assert "criterion 2" in result.stdout
