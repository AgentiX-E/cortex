"""Tests for `tools/reply-shape-census.mjs`, the instrument that sizes §13.334's population.

The pass it counts re-asks a reply that broke the contract it was rendered with. Whether that is a good
idea is a question about the **population**, and the population has two numbers a hand-classification
cannot keep apart:

  - **how many** replies are in each shape, and
  - **how many of them are already wrong**, because a re-ask of a correct answer can only lose.

The second number is what turned the registration from "fourteen questions" into "3 to 5, and one kind
refused": on the three archived artifacts the `shape` mode plans 42 to 47 consultations of which only 7
to 13 are wrong, while `commitment` plans 3 to 5 and every one of them is wrong. A tool that printed
only the first number would recommend both.

The verdict is asserted here as a string rather than a boolean, because the three states are different
findings: `yes` (every target is wrong), `measured, refused` (some targets are correct, so the cost is
a risk rather than a consultation), and `no` (the mode plans nothing on this artifact).
"""

from __future__ import annotations

import json
import pathlib
import re
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'reply-shape-census.mjs'


def record(question_id: str, capability: str, raw: str, correct: bool) -> dict:
    return {'questionId': question_id, 'capability': capability, 'rawOutput': raw, 'correct': correct}


def artifact(records: list[dict]) -> dict:
    return {
        'questions': records,
        'memoryArmConfig': {'ask': 'verbatim-acts', 'evidenceSource': 'corpus', 'relevanceTopK': 256},
    }


def run(tmp_path, payload: dict) -> str:
    path = tmp_path / 'report.json'
    path.write_text(json.dumps(payload), encoding='utf-8')
    result = subprocess.run(
        ['node', str(TOOL), str(path)],
        capture_output=True,
        text=True,
        cwd=REPO,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout


def test_the_four_shapes_are_counted_and_the_decision_follows_the_gold(tmp_path) -> None:
    payload = artifact(
        [
            # An answer, correct.
            record('q1', 'MR', 'Business Administration', True),
            # The bare token on the one capability whose gold is a decline: correct, and the reason the
            # blind retry excludes this route.
            record('q2', 'ABS', 'INSUFFICIENT_EVIDENCE', True),
            # A refusal in prose: every one of these is wrong by construction, because no route outside
            # `abs` has a decline for a gold answer.
            record('q3', 'MR', 'Not specified in the evidence', False),
            # A list of quotations, graded correct: the case that makes `shape` a risk rather than a repair.
            record('q4', 'IE', '1. [2023/05/01] "ran 5 km"\n2. [2023/05/03] "ran 7 km"', True),
            # The same shape, wrong.
            record('q5', 'IE', '- "bought a bike"\n- "sold the bike"', False),
        ]
    )
    text = run(tmp_path, payload)

    assert 'committed' in text and 'bare-decline' in text and 'prose-decline' in text
    assert 'shape-failed' in text
    # `commitment` plans one target and it is wrong.
    assert re.search(r'commitment\s+1\s+1\s+yes', text), text
    # `shape` plans two, one of them correct: a consultation of a correct answer is a risk, not a repair.
    assert 'measured, refused' in text


def test_the_bare_decline_counts_as_correct_because_that_is_what_it_is(tmp_path) -> None:
    """A tool that scored the token as wrong would recommend the one treatment that must never reach `abs`."""
    text = run(tmp_path, artifact([record('q2', 'ABS', 'INSUFFICIENT_EVIDENCE', True)]))
    assert 'bare-decline' in text
    assert '0.0%' in text


def test_a_mode_that_plans_nothing_says_so_rather_than_printing_a_zero_verdict(tmp_path) -> None:
    # `off` is the control and plans nothing on every artifact; the line exists so a reader can see that
    # the control was counted rather than omitted.
    text = run(tmp_path, artifact([record('q1', 'MR', 'Business Administration', True)]))
    assert re.search(r'off\s+0\s+0\s+no', text), text


def test_an_artifact_with_no_records_does_not_crash(tmp_path) -> None:
    # A report from a run that graded nothing is a valid artifact, and an instrument that threw on it
    # would be unusable on exactly the runs whose population is zero.
    text = run(tmp_path, {'questions': [], 'memoryArmConfig': {}})
    assert 'records 0' in text
    assert 'n/a' in text


def test_correctness_is_read_from_the_record_and_never_recomputed(tmp_path) -> None:
    """The record's `correct` is the judge's verdict, which is what the report's accuracy is built from.

    A tool that recomputed it would be a second scorer, and the two could disagree — the defect every
    instrument in this directory states for itself. Here the reply is an obvious answer but the record
    says it was graded wrong, and the tool must agree with the record.
    """
    text = run(tmp_path, artifact([record('q1', 'MR', 'Business Administration', False)]))
    assert 'committed' in text
    # One committed record, one wrong: the wrong column follows `correct`, not the text.
    assert re.search(r'committed\s+1\s+1\s+100\.0%', text), text
