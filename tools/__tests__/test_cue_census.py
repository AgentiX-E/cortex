"""The cue census, which exists to state a ceiling before a treatment is dispatched.

A decomposition treatment — the family `analyzeQuery` belongs to, §13.137 — reads the question for the things it
names and searches once per thing. Whether it can help is therefore a property of the **question text**, which
means the population can be counted before any model call, on artifacts that already exist.

Three things about this tool are load-bearing and each has a test:

1. **The union, not the sum.** Two cue classes on one question is one question. Adding the columns would inflate a
   ceiling, and a ceiling that is too high is the only error direction that cannot be caught later.
2. **Wrong questions only.** A treatment's population is the questions it could convert, so a correct question
   contributes to the per-cue counts and never to the union.
3. **Refusal over a zero.** A report with no roster, or a question with no text, cannot be censused. Printing a
   ceiling of zero there would be the confident-wrong-answer shape this repository refuses everywhere else.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'cue-census.mjs'


def report(rows: list[tuple[str, str, bool]]) -> dict:
    """A report carrying only what the census reads: capability, question text, verdict."""
    return {
        "dataset": "longmemeval/s/500",
        "generatedAt": "2026-10-29T00:00:00.000Z",
        "questions": [
            {"questionId": f"q{index}", "capability": capability, "question": text, "correct": correct}
            for index, (capability, text, correct) in enumerate(rows)
        ],
    }


def run(tmp_path: Path, body: dict, extra: list[str] | None = None) -> subprocess.CompletedProcess:
    path = tmp_path / "report.json"
    path.write_text(json.dumps(body), encoding="utf-8")
    return subprocess.run(
        ["node", str(TOOL), str(path), *(extra or [])],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def test_counts_the_union_of_cue_classes_on_wrong_questions(tmp_path: Path) -> None:
    """
    Two questions name a cue and are wrong, one names a cue and is right, one names nothing.

    The union has to be 2: the wrong-and-cued pair. The right one contributes to `count` and not to the union,
    because a treatment's population is the questions it could convert.
    """
    completed = run(
        tmp_path,
        report(
            [
                ("MR", "How many concerts did I attend in total?", False),
                ("MR", "How many books did I read last month?", False),
                ("MR", "How many trips did I take?", True),
                ("MR", "What is my sister's name?", False),
            ]
        ),
    )

    assert completed.returncode == 0, completed.stderr
    # `How many ... in total?`, `How many ...?` and `How many ...?` — three counts, one of them correct.
    # The period column is deliberately 0: `in total` is not a period and `last month` carries no number, and the
    # period rule requires one because a rule loose enough to catch "last month" also catches "last year I…".
    # A ceiling that is too high is the error direction that cannot be caught later, so the rule under-reports.
    assert "| MR | 4 | 3 | 0 | 3 | 0 | 0 | **2** |" in completed.stdout


def test_the_four_shapes_of_a_named_period_all_count_as_a_period(tmp_path: Path) -> None:
    """
    A period is named four ways, and a rule that caught only the first would report a quarter of the ceiling.

    `in April`, `the past two weeks`, `last Thursday`, `from July to October` — each is one question here, each
    wrong, and the period column has to be 4 with the union also 4.
    """
    completed = run(
        tmp_path,
        report(
            [
                ("TR", "What did I buy in April?", False),
                ("TR", "How many times did I run in the past two weeks?", False),
                ("TR", "Where did I go last Thursday?", False),
                ("TR", "Which cities did I visit from July to October?", False),
            ]
        ),
    )

    assert completed.returncode == 0, completed.stderr
    assert "| TR | 4 | 4 | 4 | 1 | 0 | 0 | **4** |" in completed.stdout


def test_a_question_naming_two_classes_is_counted_once_in_the_union(tmp_path: Path) -> None:
    """
    THE REASON THE UNION IS PRINTED SEPARATELY.

    "How many concerts did I attend in April?" names a count and a period. Summing the columns would report two
    questions reachable where only one exists, and an inflated ceiling is the error a reader cannot detect later:
    it makes every subsequent yield look like a partial success.
    """
    completed = run(
        tmp_path,
        report([("MR", "How many concerts did I attend in April?", False)]),
    )

    assert completed.returncode == 0, completed.stderr
    # One question: period 1, count 1, union 1 — not 2.
    assert "| MR | 1 | 1 | 1 | 1 | 0 | 0 | **1** |" in completed.stdout


def test_the_total_is_the_union_over_the_roster_not_a_per_capability_sum(tmp_path: Path) -> None:
    """The headline number is the thing a registration quotes, so it is asserted on its own sentence."""
    completed = run(
        tmp_path,
        report(
            [
                ("MR", "How many concerts in total?", False),
                ("TR", "What did I do last Thursday?", False),
                ("IE", "What is my cat called?", False),
            ]
        ),
    )

    assert completed.returncode == 0, completed.stderr
    assert "**2 of 3 wrong questions**" in completed.stdout


def test_a_report_with_no_roster_is_refused(tmp_path: Path) -> None:
    """A ceiling of zero and an artifact that cannot say must not print the same line."""
    completed = run(tmp_path, {"dataset": "longmemeval/s/500", "ablation": {}})

    assert completed.returncode != 0
    assert "carries no per-question roster" in completed.stderr


def test_a_question_with_no_text_is_refused(tmp_path: Path) -> None:
    """A question whose text is absent cannot be classified, and defaulting it to "no cues" would lower a ceiling."""
    body = report([("MR", "How many concerts?", False)])
    del body["questions"][0]["question"]

    completed = run(tmp_path, body)

    assert completed.returncode != 0
    assert "with no text" in completed.stderr


def test_json_mode_carries_the_columns_and_the_union(tmp_path: Path) -> None:
    """A later reader recomputes the ceiling from the JSON, so both have to be there."""
    completed = run(
        tmp_path,
        report(
            [
                ("MR", "How many concerts did I attend in April?", False),
                ("MR", "What is my cat called?", True),
            ]
        ),
        extra=["--json"],
    )

    assert completed.returncode == 0, completed.stderr
    parsed = json.loads(completed.stdout)
    assert parsed["mode"] == "cue-census"
    assert parsed["capabilities"]["MR"]["questions"] == 2
    assert parsed["capabilities"]["MR"]["wrong"] == 1
    assert parsed["capabilities"]["MR"]["period"] == 1
    assert parsed["capabilities"]["MR"]["count"] == 1
    assert parsed["capabilities"]["MR"]["wrongUnion"] == 1
    assert parsed["total"] == {"questions": 2, "wrong": 1, "wrongUnion": 1}
