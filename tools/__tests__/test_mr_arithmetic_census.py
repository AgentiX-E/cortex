"""The arithmetic census, and the two traps it was written to avoid.

The first trap is subset-sum. A delivered block holds eleven to nineteen distinct numbers, so a
subset summing to almost any target exists by combinatorics; an earlier draft of this analysis
"proved" that a question about how many times the user baked has the answer `1 + 3`. Every assertion
below that touches arithmetic asserts the **strict** test instead: `|answer - gold|` present
verbatim as one number.

The second trap is the split that decides which plan is right. `carried == total` means the gold
evidence reached the block, so a wrong answer under that condition cannot be a retrieval failure.
The tests pin both the count and the sentence, because a tool that reports the count and then
prints the opposite reading is worse than no tool.
"""

import json
import pathlib
import subprocess

TOOL = pathlib.Path(__file__).resolve().parents[1] / "mr-arithmetic-census.py"


def record(qid, gold, answer, correct=False, carried=10, total=10, turns=None, capability="MR"):
    """One question record, in the shape the ablation report writes it."""
    return {
        "questionId": qid,
        "capability": capability,
        "groundTruth": gold,
        "answer": answer,
        "correct": correct,
        "goldOverlap": {
            "carried": carried,
            "total": total,
            "goldTurns": turns if turns is not None else [],
        },
    }


def run(tmp_path, questions, *args):
    path = tmp_path / "report.json"
    path.write_text(json.dumps({"questions": questions}), encoding="utf-8")
    return subprocess.run(
        ["python3", str(TOOL), str(path), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def test_splits_wrong_answers_into_over_under_and_refuse(tmp_path):
    questions = [
        record("hot", 4, "6", turns=["I baked four loaves."]),
        record("cold", 4, "3", turns=["I baked four loaves."]),
        record("quiet", 50, "Not specified in the provided context."),
        record("fine", 7, "7", correct=True),
    ]
    result = run(tmp_path, questions, "--json")
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["numericGold"] == 4
    assert payload["wrong"] == 3
    assert payload["byKind"] == {"over": 1, "refuse": 1, "under": 1}


def test_counts_evidence_completeness_per_kind(tmp_path):
    # The split that decides which repair can be right: a wrong answer with every gold turn carried
    # failed after the evidence arrived.
    questions = [
        record("complete-count", 4, "6", carried=12, total=12),
        record("gap-count", 4, "6", carried=9, total=12),
        record("complete-refuse", 5, None, carried=8, total=8),
        record("complete-under", 9, "7", carried=8, total=8),
    ]
    payload = json.loads(run(tmp_path, questions, "--json").stdout)
    assert payload["completeEvidence"] == {"over": 1, "refuse": 1, "under": 1}


def test_reports_the_delta_only_when_it_appears_verbatim(tmp_path):
    # The strict test. `542` is on one line and the answer is exactly that short; `1000` would have
    # to be summed out of several lines and is therefore not reported.
    questions = [
        record(
            "verbatim",
            1998,
            "1456",
            turns=["The first video got 1456 views.", "The second got 542."],
        ),
        record("summed", 1998, "998", turns=["It got 700 views.", "Then 300 more."]),
    ]
    payload = json.loads(run(tmp_path, questions, "--json").stdout)
    rows = {row["questionId"]: row for row in payload["rows"]}
    assert rows["verbatim"]["deltaInEvidence"] is True
    assert rows["verbatim"]["difference"] == "542"
    assert rows["summed"]["deltaInEvidence"] is False


def test_a_gold_that_does_not_open_with_its_number_is_excluded(tmp_path):
    # `gpt4_7fce9456`'s gold is four sentences about four properties, and one of them says "the
    # 1-bedroom condo". A naive read takes that `1` as the gold and reports a 5-versus-1 over-count
    # that is arithmetic about a hyphenated adjective.
    questions = [
        record(
            "prose",
            "I viewed four properties before making an offer. The noise was a deal-breaker for the "
            "1-bedroom condo.",
            "5",
        ),
        record("bare", "I viewed four properties before making an offer.", "5"),
        record("numeric", "4", "6"),
    ]
    payload = json.loads(run(tmp_path, questions, "--json").stdout)
    assert payload["numericGold"] == 1
    assert payload["wrong"] == 1


def test_a_gold_that_opens_with_its_number_survives_prose_after_it(tmp_path):
    # The same rule has to keep `60bf93ed`, whose gold names a range: "5 days. 6 days (including the
    # last day) is also acceptable." Excluding it would drop a question the count is about.
    questions = [
        record("range", "5 days. 6 days (including the last day) is also acceptable.", None)
    ]
    payload = json.loads(run(tmp_path, questions, "--json").stdout)
    assert payload["numericGold"] == 1
    assert payload["byKind"] == {"refuse": 1}


def test_capability_filter_narrows_the_population(tmp_path):
    questions = [
        record("mr", 4, "6", capability="MR"),
        record("ku", 4, "6", capability="KU"),
    ]
    payload = json.loads(run(tmp_path, questions, "--json").stdout)
    assert payload["wrong"] == 1
    assert [row["questionId"] for row in payload["rows"]] == ["mr"]
    everything = json.loads(run(tmp_path, questions, "--json", "--all-capabilities").stdout)
    assert everything["wrong"] == 2


def test_prints_arithmetic_when_the_gold_is_absent_from_the_block(tmp_path):
    # Four of five wrong golds are not printed anywhere, so the sentence has to be the arithmetic
    # one.
    questions = [
        record(f"q{index}", 495, "375", turns=["I sold a lamp for 375 dollars."])
        for index in range(4)
    ] + [record("printed", 495, "375", turns=["The total came to 495 dollars."])]
    result = run(tmp_path, questions)
    assert result.returncode == 0, result.stderr
    assert "arithmetic failure, not a retrieval failure" in result.stdout
    assert "gold number absent from the delivered block: 4/5" in result.stdout


def test_prints_retrieval_when_most_golds_were_printed(tmp_path):
    questions = [
        record(f"q{index}", 495, "375", turns=["The total came to 495 dollars."])
        for index in range(4)
    ] + [record("absent", 495, "375", turns=["Nothing numeric here."])]
    result = run(tmp_path, questions)
    assert "retrieval-or-selection failure" in result.stdout


def test_a_report_without_questions_is_an_error_not_an_empty_census(tmp_path):
    path = tmp_path / "empty.json"
    path.write_text(json.dumps({"questions": []}), encoding="utf-8")
    result = subprocess.run(
        ["python3", str(TOOL), str(path)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 2
    assert "no `questions` array" in result.stderr
