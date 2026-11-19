#!/usr/bin/env python3
"""The judge has to be pinnable from the workflow that dispatches the arms.

## The defect this closes

`resolveJudgeIdentity` has read `CORTEX_JUDGE_MODEL` since §13.312 and `judge-audit.yml` exposes it as
an input, but `benchmark-cortex-memory.yml` -- the only workflow that dispatches a *pair* of arms -- had
no way to set it. Every arm dispatched from here was therefore graded by whatever the reader was, and
the artifact recorded it (`judge.source: "reader"`).

`R1` is the reading that made the gap expensive. Its question was whether swapping the reader moves
`MR`, and the swap carried the judge: 80.99% is `v4-pro` grading `v4-pro` against `deepseek-chat`
grading `deepseek-chat`. Two changes, one comparison, and no regrade can recover the majority-of-four
basis the reading uses.

## Why the assertion is about the *variable* and not about a new input

This workflow sits at 24 of GitHub's 25 inputs, and its own header records the consequence: an input
added past the ceiling is a workflow that will not start. So the pin travels as a repository variable,
the same route the pace and the reader timeout take -- and the test below refuses a 25th input as well
as a missing forward, because the way this defect will come back is someone adding the input.

## And why it asserts the empty case separately

An unset repository variable interpolates to `''`. `resolveJudgeIdentity` trims before it decides, so
`''` means "nobody pinned one" rather than a model named the empty string. That rule already exists and
is tested beside the factory; what this file adds is that the workflow cannot be the thing that breaks
it -- by, say, defaulting the expression to a model name on the workflow side, which would pin every
dispatch in the repository without anyone choosing it.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

import yaml

WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/benchmark-cortex-memory.yml"
INPUT_CEILING = 25


def document() -> dict:
    return yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))


def job_environment() -> dict:
    return document()["env"]


class TheJudgeIsPinnable(unittest.TestCase):
    def test_the_job_environment_forwards_the_judge_pin(self) -> None:
        # Job scope, not a step's: the arm runs in one step and the report is written in another, and a
        # pin visible to only one of them would let the artifact describe a judge the grading did not use.
        self.assertIn("CORTEX_JUDGE_MODEL", job_environment())

    def test_the_pin_comes_from_a_repository_variable(self) -> None:
        value = job_environment()["CORTEX_JUDGE_MODEL"]
        self.assertEqual("${{ vars.CORTEX_JUDGE_MODEL }}", str(value).strip())
        # Not a secret (it is a model id, not a credential) and not an input (the ceiling is the point).
        self.assertNotIn("secrets.", str(value))
        self.assertNotIn("inputs.", str(value))

    def test_the_input_surface_stays_below_the_ceiling(self) -> None:
        # The reason the pin is not an input. `test_dispatch_inputs.py` pins each dispatch script to the
        # workflow that declares its inputs; this pins the ceiling that made the variable necessary.
        inputs = document()[True]["workflow_dispatch"]["inputs"]
        self.assertLess(len(inputs), INPUT_CEILING)

    def test_an_unset_variable_is_not_defaulted_to_a_model(self) -> None:
        # `|| 'deepseek-chat'` here would pin every dispatch in the repository without anyone choosing
        # it, and the artifact would say `source: "pinned"` while the operator believed it followed.
        raw = WORKFLOW.read_text(encoding="utf-8")
        line = next(
            entry for entry in raw.splitlines() if entry.strip().startswith("CORTEX_JUDGE_MODEL:")
        )
        self.assertIsNone(re.search(r"\|\|", line), line)
        self.assertIsNone(re.search(r"'[a-z0-9.-]+:[a-z0-9.-]+'", line), line)


if __name__ == "__main__":
    unittest.main()
