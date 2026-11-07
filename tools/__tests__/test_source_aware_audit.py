"""The reachability screen, which exists to say what the artifact can and cannot answer.

`docs/SOTA-LANDSCAPE.md` carried a row reading "accuracy, source-aware grading — unmeasured — we do not
report this protocol, so the comparison does not exist" for four rounds. The honest reading of that
sentence is that a grading-side implementation was missing, so this round added one
(`auditReference` in `packages/cortex-eval/src/source-aware.ts`) and this screen, which is the half
that costs nothing and therefore has to be right.

Three properties are load-bearing and each has a test:

1. **A gold is matched as a token when it is a number.** `groundTruth` of `3` is inside `13` and
   inside `2023`, so a substring test would call a count question reachable from any date in the
   packet. `§13.18.2` paid for exactly this: `groundTruth` of `3` matched `3. **Humidity:**`, because a
   list marker and a cardinality are the same token.
2. **Absence is not a defect signal, and the tool says so on every run.** The first run on
   `42355323615` printed `retrieval 27 of 43` and invited the reading "63% of errors are retrieval
   failures" -- while **196 of 427 correct answers also had a lexically absent gold**, because an
   aggregation gold ("I attended four movie festivals.") cannot be found in four separate turns. A
   screen that printed only the absolute counts would have produced a confident and misleading
   conclusion, which is the failure this repository is built to avoid.
3. **Refusal over a fabricated audit.** A report with no per-question records, or a request for the
   source scope this tool cannot run without the dataset, exits non-zero with the reason instead of
   printing a number.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'source-aware-audit.mjs'


def report(rows: list[dict]) -> dict:
    """A report carrying only what the screen reads."""
    return {
        "dataset": "longmemeval",
        "questions": [
            {
                "questionId": row["id"],
                "capability": row.get("capability", "IE"),
                "question": "q?",
                "groundTruth": row.get("gold"),
                "answer": row.get("answer", "x"),
                "correct": row["correct"],
                "turns": [{"index": i, "text": text} for i, text in enumerate(row.get("turns", []))],
            }
            for row in rows
        ],
    }


def cells(stdout: str, label: str) -> tuple[int, int]:
    """The `gold delivered` and `gold absent` counts on the row starting with `label`.

    Read by splitting the line rather than by matching a padded substring: column widths are a
    presentation choice, and a test pinned to them fails on a formatting change and passes on a
    mis-computed number that happens to keep the spacing.
    """
    line = next(
        candidate for candidate in stdout.splitlines() if candidate.strip().startswith(label)
    )
    parts = line.split()
    return int(parts[1]), int(parts[2])


def run(tmp_path: Path, body: dict, extra: list[str] | None = None) -> subprocess.CompletedProcess:
    path = tmp_path / "report.json"
    path.write_text(json.dumps(body), encoding="utf-8")
    return subprocess.run(
        ["node", str(TOOL), str(path), *(extra or [])],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=False,
    )


def test_a_gold_present_in_the_packet_is_counted_as_reachable(tmp_path: Path) -> None:
    body = report(
        [
            {"id": "q0", "gold": "Business Administration", "correct": True,
             "turns": ["I graduated with a degree in business administration."]},
            {"id": "q1", "gold": "Lisbon", "correct": False,
             "turns": ["I moved to Porto last year."]},
        ]
    )
    result = run(tmp_path, body)
    assert result.returncode == 0, result.stderr
    # q0's gold is delivered (and it is correct); q1's is not (and it is wrong).
    assert cells(result.stdout, "correct") == (1, 0)
    assert cells(result.stdout, "incorrect") == (0, 1)


def test_a_numeric_gold_is_matched_as_a_token_and_not_as_a_substring(tmp_path: Path) -> None:
    # The assertion §13.18.2 bought. `gold=3` against a packet whose only numbers are `13` and `2023`
    # is NOT reachable, and a substring test would call it so.
    body = report(
        [
            {"id": "q0", "gold": "3", "correct": False,
             "turns": ["[2023/05/20] user: I visited 13 countries."]},
            {"id": "q1", "gold": "3", "correct": True,
             "turns": ["user: I adopted 3 cats."]},
        ]
    )
    result = run(tmp_path, body)
    assert result.returncode == 0, result.stderr
    # One correct (the token is present), one incorrect (only `13` and `2023` are).
    assert cells(result.stdout, "correct") == (1, 0)
    assert cells(result.stdout, "incorrect") == (0, 1)


def test_the_run_names_the_rate_difference_rather_than_the_absolute_counts(tmp_path: Path) -> None:
    # Three correct answers with an absent gold and one wrong one with an absent gold: the tool must
    # print the two rates and say in words that absence is not a defect signal on its own.
    body = report(
        [
            {"id": "q0", "gold": "four festivals", "correct": True, "turns": ["a film festival"]},
            {"id": "q1", "gold": "four cars", "correct": True, "turns": ["a car"]},
            {"id": "q2", "gold": "four dogs", "correct": True, "turns": ["a dog"]},
            {"id": "q3", "gold": "Paris", "correct": True, "turns": ["I live in Paris."]},
            {"id": "q4", "gold": "four cats", "correct": False, "turns": ["a cat"]},
        ]
    )
    result = run(tmp_path, body)
    assert result.returncode == 0, result.stderr
    assert "Absence is not a defect signal on its own" in result.stdout
    assert "75.0%" in result.stdout


def test_an_abstention_question_is_skipped_because_it_has_no_gold_to_audit(tmp_path: Path) -> None:
    body = report(
        [
            {"id": "q0", "gold": None, "correct": True, "turns": ["anything"]},
            {"id": "q1", "gold": "Paris", "correct": True, "turns": ["I live in Paris."]},
        ]
    )
    result = run(tmp_path, body)
    assert result.returncode == 0, result.stderr
    assert "audited    1 questions" in result.stdout
    assert "skipped    1 abstention" in result.stdout


def test_a_question_with_no_delivered_turns_is_skipped_rather_than_called_unreachable(
    tmp_path: Path,
) -> None:
    # Counting a question with no captured turns as unreachable would blame the dataset for a capture
    # the arm did not make.
    body = report(
        [
            {"id": "q0", "gold": "Paris", "correct": False, "turns": []},
            {"id": "q1", "gold": "Paris", "correct": True, "turns": ["I live in Paris."]},
        ]
    )
    result = run(tmp_path, body)
    assert result.returncode == 0, result.stderr
    assert "audited    1 questions" in result.stdout


def test_a_report_without_per_question_records_is_refused(tmp_path: Path) -> None:
    result = run(tmp_path, {"dataset": "longmemeval"})
    assert result.returncode != 0
    assert "carries no per-question records" in result.stderr


def test_the_source_scope_is_refused_with_the_reason_instead_of_a_number(tmp_path: Path) -> None:
    # The honest half: this tool cannot audit against a full conversation the artifact does not
    # carry, and printing a number for it would be the fabricated-measurement failure the whole
    # campaign is about.
    body = report([{"id": "q0", "gold": "Paris", "correct": True, "turns": ["Paris"]}])
    result = run(tmp_path, body, ["--scope", "source"])
    assert result.returncode != 0
    assert "needs the dataset file" in result.stderr
    assert "auditReference" in result.stderr


def test_the_json_mode_carries_the_same_arithmetic_as_the_table(tmp_path: Path) -> None:
    body = report(
        [
            {"id": "q0", "gold": "Paris", "correct": True, "turns": ["I live in Paris."]},
            {"id": "q1", "gold": "Rome", "correct": False, "turns": ["I live in Paris."]},
        ]
    )
    result = run(tmp_path, body, ["--json"])
    assert result.returncode == 0, result.stderr
    parsed = json.loads(result.stdout)
    assert parsed["scope"] == "delivered"
    assert parsed["audited"] == 2
    assert parsed["overall"]["correct"] == {"reachable": 1, "unreachable": 0}
    assert parsed["overall"]["incorrect"] == {"reachable": 0, "unreachable": 1}


def test_the_capability_table_separates_the_reader_from_the_retrieval_column(
    tmp_path: Path,
) -> None:
    # The read that made this screen worth building: on `42355323615`, 7 of KU's 8 errors had their
    # gold in the packet and 10 of IE's 10 did not. Those are two different subsystems.
    body = report(
        [
            {"id": "k0", "capability": "KU", "gold": "Paris", "correct": False,
             "turns": ["I live in Paris."]},
            {"id": "i0", "capability": "IE", "gold": "Rome", "correct": False,
             "turns": ["I live in Paris."]},
        ]
    )
    result = run(tmp_path, body)
    assert result.returncode == 0, result.stderr
    lines = [line for line in result.stdout.splitlines() if line.startswith(("IE", "KU"))]
    ie = next(line for line in lines if line.startswith("IE"))
    ku = next(line for line in lines if line.startswith("KU"))
    assert ie.split()[2:] == ["0", "1", "0.0%", "1"]
    assert ku.split()[2:] == ["1", "0", "100.0%", "1"]
