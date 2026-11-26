#!/usr/bin/env python3
"""The ceiling is counted by two witnesses, and the second one is the prompt.

## The defect this file is written against

`MEASURE-REACHABLE-HEADROOM.md` §2 states the harness ceiling as `1 - (never - demonstrated) / n`, where
`demonstrated` is how many of the questions this arm never answers the **control** answers at least once.
`96.00` on the 500 comes from that expression, and so does the sentence after it: *"twenty of the
twenty-six questions this arm never answers are questions the reference pipeline never answers either ...
no amount of work on this arm moves them."*

The artifact carries a second witness for the same question -- `goldOverlap.goldDelivered`, one boolean per
gold turn saying whether **this arm's own prompt** carried it -- and no reading in this campaign consulted
it. A question whose gold the prompt delivered is not a question "no pipeline reaches"; it is a question
the reader was shown the answer to and decided wrongly, which is what a decision mechanism is aimed at.

## What is asserted

1. the self-test is green, which is where the arithmetic is pinned (a fixture whose two witnesses disagree
   at the question level, an operand-less gold that must not lift the ceiling, and an id outside the
   question list);
2. the table prints both ceilings and a suite row that is the sum of the parts rather than a third number;
3. the four refusals, each of which would otherwise produce a plausible ceiling: a record with no
   `goldOverlap`, an id the question list does not contain, an artifact with no per-repetition masks, and a
   usage error.
"""

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "ceiling-witnesses.mjs"
FIXTURE = ROOT / "tools" / "__tests__" / "ceiling-witnesses-fixture.json"


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(TOOL), *args],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )


def _question(question_id, capability, correct, answer, truth, gold, delivered, carried=None):
    return {
        "questionId": question_id,
        "capability": capability,
        "route": capability,
        "correct": correct,
        "answer": answer,
        "groundTruth": truth,
        "goldOverlap": {
            "carried": sum(1 for flag in delivered if flag) if carried is None else carried,
            "total": len(gold),
            "goldTurns": gold,
            "goldDelivered": delivered,
        },
    }


def _report(questions, baseline, feature):
    return {
        "questions": questions,
        "ablation": {"baselineCorrectByRun": baseline, "featureCorrectByRun": feature},
    }


TWO_WITNESSES = _report(
    [
        # Never right; the control never answers it; the prompt carried the gold. The question this whole
        # file is about.
        _question(
            "q1",
            "multi-session",
            False,
            "$220",
            "$720",
            ["The deposit was $720 in total."],
            [True],
        ),
        # Never right; the control answers it every repetition, so the first witness already reaches it.
        _question(
            "q2",
            "multi-session",
            False,
            "27",
            "The deposit was 38 dollars.",
            ["The deposit was 38 dollars."],
            [True],
        ),
        # Right, so not in the denominator.
        _question("q3", "temporal", True, "21 days", "21 days", ["That was 21 days ago."], [True]),
        # Never right, and its gold states no searchable operand.
        _question("q4", "temporal", False, "Yes", "Yes", ["Yes."], [True]),
    ],
    ["0110", "0110"],
    ["0010", "0010"],
)


class TestTheSelfTestIsGreen(unittest.TestCase):
    def test_the_arithmetic_is_pinned(self) -> None:
        result = _run("--self-test")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("two witnesses", result.stdout)


class TestTheTableStatesBothWitnesses(unittest.TestCase):
    def _table(self) -> list[str]:
        FIXTURE.write_text(json.dumps(TWO_WITNESSES), encoding="utf-8")
        try:
            result = _run(str(FIXTURE))
        finally:
            FIXTURE.unlink()
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.splitlines()

    def test_the_two_ceilings_differ_on_this_fixture(self) -> None:
        lines = self._table()
        multi = next(line for line in lines if line.startswith("multi-session"))
        # Two multi-session questions, both never right. The control reaches one of them; this arm's own
        # prompt carried the gold of both. One witness says half the gap is out of reach, the other says none
        # of it is -- which is the whole reason a second witness was worth building.
        fields = multi.split()
        self.assertEqual(fields[1:6], ["2", "2", "1", "2", "0"])
        self.assertEqual(fields[6], "50.00")
        self.assertEqual(fields[7], "100.00")

    def test_an_operand_less_gold_does_not_lift_the_ceiling(self) -> None:
        lines = self._table()
        temporal = next(line for line in lines if line.startswith("temporal"))
        fields = temporal.split()
        # One never-right question, reached by neither witness, and its gold is `unknown` rather than
        # delivered -- so the second ceiling stays at 50.00 instead of rising to 100.00.
        self.assertEqual(fields[1:6], ["2", "1", "0", "0", "1"])
        self.assertEqual(fields[7], "50.00")

    def test_the_suite_row_is_the_sum_of_the_parts(self) -> None:
        lines = self._table()
        suite = next(line for line in lines if line.startswith("suite")).split()
        self.assertEqual(suite[1:6], ["4", "3", "1", "2", "1"])
        # n=4, never=3: the control reaches one (1 - 2/4), the prompt reaches two (1 - 1/4). Neither
        # subtracts the `unknown`, which is why the second ceiling is 75.00 rather than 100.00.
        self.assertEqual(suite[6], "50.00")
        self.assertEqual(suite[7], "75.00")

    def test_the_list_names_the_questions_rather_than_only_counting_them(self) -> None:
        FIXTURE.write_text(json.dumps(TWO_WITNESSES), encoding="utf-8")
        try:
            result = _run(str(FIXTURE), "--list")
        finally:
            FIXTURE.unlink()
        self.assertEqual(result.returncode, 0, result.stderr)
        # A count cannot be dispatched at: the row has to name the question and say which witness reached
        # it, which is the round trip that made every mechanism before this aim at the wrong four.
        self.assertIn("q1", result.stdout)
        self.assertIn("control=none", result.stdout)
        self.assertIn("prompt=delivered", result.stdout)


class TestWhatItRefuses(unittest.TestCase):
    def _with(self, report: dict) -> subprocess.CompletedProcess[str]:
        FIXTURE.write_text(json.dumps(report), encoding="utf-8")
        try:
            return _run(str(FIXTURE))
        finally:
            FIXTURE.unlink()

    def test_a_record_without_gold_overlap_is_refused(self) -> None:
        report = _report(
            [{"questionId": "q1", "capability": "temporal", "route": "temporal", "correct": False}],
            ["0"],
            ["0"],
        )
        result = self._with(report)
        self.assertEqual(result.returncode, 4, result.stdout)
        self.assertIn("no `goldOverlap.goldTurns`", result.stderr)

    def test_a_map_that_disagrees_with_the_turns_is_refused(self) -> None:
        # `goldTurns` and `goldDelivered` are written by one function and read as a pair, so a length that
        # disagrees means one of them was rebuilt by hand and the delivery question would be answered about
        # the wrong turns. The refusal comes from `operandReach`, which this tool does not restate.
        record = _question(
            "q1", "temporal", False, "$220", "$720", ["The deposit was $720.", "Moved in April."], [True]
        )
        record["goldOverlap"]["goldDelivered"] = [True, False, True]
        result = self._with(_report([record], ["0"], ["0"]))
        self.assertEqual(result.returncode, 4, result.stdout)
        self.assertIn("read as a pair", result.stderr)

    def test_an_artifact_with_no_masks_is_refused(self) -> None:
        report = {
            "questions": [_question("q1", "temporal", False, "x", "y", ["y."], [True])],
        }
        result = self._with(report)
        self.assertEqual(result.returncode, 4, result.stdout)
        self.assertIn("no `ablation` object", result.stderr)

    def test_a_usage_error_is_exit_two(self) -> None:
        result = _run()
        self.assertEqual(result.returncode, 2)
        self.assertIn("usage:", result.stderr)


if __name__ == "__main__":
    unittest.main()
