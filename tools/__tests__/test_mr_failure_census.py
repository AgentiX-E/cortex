"""`mr-failure-census.mjs`, checked on the partition it claims and on the arithmetic it needs.

The registration (§13.164.4) asks for three things before any repair: an exhaustive partition of the
reference-only set, a rule that reads the partition **from the gold and the answer** rather than from
the question text, and four counts that sum to the population. Every test here is a case where a
plausible reading gets one of those wrong:

  - **the first number in a sentence, not the last.** The gold for `gpt4_7fce9456` is *"I viewed four
    properties before making an offer ... The ..."*, whose tail mentions other numbers; reading the
    last one scores a count of four as two and files a one-member error as a three-unit one. This
    was a real defect in the first version of the tool, found by reading its own table.
  - **an expression's value is after the `=`.** `17 + 5 = 22` against a gold of 23 is off by one;
    read as 17 it is off by six, and the class changes.
  - **a duration is one number.** `1 year and 5 months` is 17, and comparing 5 with 45 calls the
    operand selection error a 40-month one.
  - **a decline has no number to compare.** It cannot be off by one, so the classes are tested in an
    order rather than independently.
  - **the four counts are the table.** A sum computed from a different walk than the rows is a
    second population, which is the defect the gate in `export-census` spent a round repairing.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "mr-failure-census.mjs"


def run(*args: str) -> "subprocess.CompletedProcess[str]":
    return subprocess.run(["node", str(TOOL), *args], capture_output=True, text=True, check=False)


def node(code: str) -> "subprocess.CompletedProcess[str]":
    """Evaluate one ES module expression against the tool's own exports.

    The classifier and the partition are pure functions, and asserting them through the CLI would
    mean one artifact per case. The module is imported by path so the tests read the same code the
    command reads, which is the arrangement `test_competitor_ledger.py` uses for its ledger checks.
    """
    script = f"import * as t from '{TOOL.as_posix()}';{code}"
    return subprocess.run(
        ["node", "--input-type=module", "-e", script], capture_output=True, text=True, check=False
    )


def question(
    qid: str,
    *,
    capability: str = "MR",
    text: str = "How many items of clothing do I need to pick up?",
    gold: str = "3",
    answer: object = "2",
    raw: str = "",
) -> dict:
    return {
        "questionId": qid,
        "question": text,
        "capability": capability,
        "groundTruth": gold,
        "answer": answer,
        "rawOutput": raw,
    }


def report(questions: list[dict], ref_only: list[str] | None = None) -> dict:
    return {
        "questions": questions,
        "ablation": {
            "discordantQuestions": {
                "baselineCorrectFeatureIncorrect": ref_only
                if ref_only is not None
                else [q["questionId"] for q in questions]
            }
        },
    }


def write(tmp_path: Path, payload: dict) -> Path:
    path = tmp_path / "report.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


def census(tmp_path: Path, payload: dict, *extra: str) -> dict:
    path = write(tmp_path, payload)
    result = run("--report", str(path), "--json", *extra)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


# --- the arithmetic the partition needs ------------------------------------------------


def test_a_currency_amount_and_a_percentage_are_both_numbers(tmp_path: Path) -> None:
    payload = report(
        [
            question("a", gold="$185", answer="65"),
            question("b", gold="40%", answer="30"),
        ]
    )
    rows = census(tmp_path, payload)["rows"]
    assert rows[0]["detail"] == "185 -> 65 (-120)"
    assert rows[1]["detail"] == "40 -> 30 (-10)"


def test_an_expression_is_read_after_the_equals_sign(tmp_path: Path) -> None:
    """`17 + 5 = 22` against a gold of 23 is off by one, and the class depends on it."""
    payload = report([question("a", gold="23", answer="17 + 5 = 22")])
    row = census(tmp_path, payload)["rows"][0]
    assert (row["klass"], row["detail"]) == ("off-by-one", "23 -> 22 (-1)")


def test_a_sentence_states_its_quantity_first(tmp_path: Path) -> None:
    """The gold's own prose is the case: four properties, and a tail that names other numbers."""
    payload = report(
        [
            question(
                "a",
                gold="I viewed four properties before making an offer on the townhouse in the Brookside neighborhood. The last one was listed at $285,000.",
                answer="5",
            )
        ]
    )
    row = census(tmp_path, payload)["rows"][0]
    assert (row["klass"], row["detail"]) == ("off-by-one", "4 -> 5 (+1)")


def test_a_duration_is_reduced_to_one_unit(tmp_path: Path) -> None:
    payload = report([question("a", gold="1 year and 5 months", answer="3 years and 9 months")])
    row = census(tmp_path, payload)["rows"][0]
    assert (row["klass"], row["detail"]) == ("aggregation", "17 -> 45 (+28)")


def test_a_half_hour_is_not_read_as_thirty(tmp_path: Path) -> None:
    """`0.5 hours` against `30` is the unit error the table has to call one."""
    payload = report([question("a", gold="0.5 hours", answer="30")])
    assert census(tmp_path, payload)["rows"][0]["klass"] == "aggregation"


def test_a_comma_separated_count_is_one_number(tmp_path: Path) -> None:
    payload = report([question("a", gold="1,998", answer="1,900")])
    assert census(tmp_path, payload)["rows"][0]["detail"] == "1998 -> 1900 (-98)"


def test_a_non_numeric_pair_is_the_other_class(tmp_path: Path) -> None:
    payload = report([question("a", gold="photography and cooking", answer="2")])
    assert census(tmp_path, payload)["rows"][0]["klass"] == "other"


# --- the partition is ordered, and it is total ----------------------------------------


def test_a_decline_is_read_before_its_absence_is_compared(tmp_path: Path) -> None:
    """A declined question has nothing to compare, so it cannot be off by one by accident."""
    payload = report([question("a", answer=None), question("b", answer="")])
    classes = [row["klass"] for row in census(tmp_path, payload)["rows"]]
    assert classes == ["decline", "decline"]


def test_the_four_counts_are_the_table_that_produced_them(tmp_path: Path) -> None:
    payload = report(
        [
            question("d", answer=None),
            question("o", gold="3", answer="2"),
            question("o2", gold="5", answer="6"),
            question("a", gold="$185", answer="65"),
            question("x", gold="four festivals", answer="a list of things"),
        ]
    )
    result = census(tmp_path, payload)
    assert result["classes"] == {"decline": 1, "off-by-one": 2, "aggregation": 1, "other": 1}
    assert sum(result["classes"].values()) == result["population"] == len(result["rows"])


def test_a_partition_that_does_not_add_up_is_an_exit_code(tmp_path: Path) -> None:
    """The sum check is what makes the census a measurement rather than a description."""
    whole = report([question("o", gold="3", answer="2")])
    path = write(tmp_path, whole)
    assert run("--report", str(path)).returncode == 0
    # The same report, told to look at a capability it does not contain: the population is empty and
    # the table must say so rather than printing a total from somewhere else.
    empty = run("--report", str(path), "--capability", "KU")
    assert empty.returncode == 0
    assert "0 question(s)" in empty.stdout
    assert "sum           0" in empty.stdout


# --- the decline axis, read through the product's own predicates ----------------------


def test_a_decline_with_a_list_is_the_shape_the_recovery_pass_exists_for(tmp_path: Path) -> None:
    listed = "Step 1 — list:\n- a thing [2023/05/20]\n- another thing [2023/05/21]\n\nStep 2 —\n\nINSUFFICIENT_EVIDENCE"
    bare = "INSUFFICIENT_EVIDENCE"
    absent = "Step 1 — list:\n- No item in the evidence states the answer.\n\nStep 2 —\n\nINSUFFICIENT_EVIDENCE"
    payload = report(
        [question("a", answer=None, raw=listed), question("b", answer=None, raw=bare), question("c", answer=None, raw=absent)]
    )
    result = census(tmp_path, payload)
    assert result["declineShapes"] == {"bare": 1, "absence-only": 1, "list": 1, "prose": 0}
    # And only the listed one has anything to quote back. A pass that fired on the absence-only case
    # would be quoting the model's own apology back to it as evidence.
    assert result["retryable"] == 1


# --- the shape axis, which is the reach of `ask: operands` ---------------------------


def test_the_shape_axis_counts_the_population_the_operand_block_would_reach(tmp_path: Path) -> None:
    payload = report(
        [
            question("d", text="How many years older is my grandma than me?", answer=None),
            question("o", text="How many fitness classes do I attend in a typical week?", gold="5", answer="4"),
        ]
    )
    result = census(tmp_path, payload)
    assert result["operands"] == 1
    assert result["reach"] == {"decline": {"derivation": 1, "enumeration": 0}, "off-by-one": {"derivation": 0, "enumeration": 1}}


def test_the_two_classifiers_agree_on_every_question_of_a_report(tmp_path: Path) -> None:
    """The copy is checked where it is used: a drift would make the printed reach describe the tool."""
    payload = report(
        [
            question("d", text="What percentage of shoes did I wear?", answer=None),
            question("o", text="How many kits do I own?", gold="3", answer="2"),
            question("x", text="How long have I been working in my current role?", gold="17", answer="45"),
        ]
    )
    result = node(
        "import {readFileSync} from 'node:fs';"
        f"const r = JSON.parse(readFileSync({json.dumps(str(write(tmp_path, payload)))}));"
        "process.stdout.write(JSON.stringify(t.classifierDisagreements(r)));"
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == []


# --- the CLI's own contract ----------------------------------------------------------


def test_a_missing_report_is_a_usage_error_rather_than_a_table(tmp_path: Path) -> None:
    result = run()
    assert result.returncode == 2
    assert "usage" in result.stderr
    assert result.stdout == ""


def test_the_table_names_the_class_and_the_comparison(tmp_path: Path) -> None:
    path = write(tmp_path, report([question("a", gold="3", answer="2")]))
    result = run("--report", str(path), "--capability", "MR")
    assert result.returncode == 0
    assert "a            off-by-one" in result.stdout
    assert "3 -> 2 (-1)" in result.stdout
    assert "population of `ask: operands`: 0 of 1" in result.stdout
