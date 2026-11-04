#!/usr/bin/env python3
"""The gate that reads the dispatch must be *in* the job, and it must be before the build.

## Why a gate needs its own gate

`tools/registration-preflight.py` is nine tests and one hundred and seventy lines of argument, and
all of it is worth nothing if the workflow stops calling it. That is not hypothetical here: this
repository has already shipped a `--registration` comparison that ran *after* the artifact, which
is how `41751619617` spent 87 minutes to learn what a five-second check could have said, and it has
shipped checks whose step was renamed out of the job and noticed only because a run looked short.

Three properties are asserted, and each one has its own failure:

| property | what breaks without it |
| --- | --- |
| the step exists | the gate is dead code with a green suite |
| it calls the preflight script | a step named after the check that runs something else |
| it sits before `Install dependencies` | a gate that costs a build before it can refuse |
| it forwards `CORTEX_DECLARED_DEPARTURES` | every declared departure reads as undeclared, so a legal experiment fails |

The last one is the subtle one: the step would still print a verdict and the verdict would still be
honest, because a run with no declaration variable genuinely has no declared departures. It is the
*repository variable* that goes unread, and the symptom is a gate that rejects every dispatch which
departs on purpose -- which is every experiment this campaign runs.
"""

from __future__ import annotations

import unittest
from pathlib import Path

import yaml

WORKFLOW = Path(__file__).resolve().parents[2] / ".github/workflows/benchmark-cortex-memory.yml"
STEP_NAME = "Check the dispatch against the registration"
PREFLIGHT = "tools/registration-preflight.py"


def steps() -> list[dict]:
    document = yaml.safe_load(WORKFLOW.read_text())
    job = document["jobs"][next(iter(document["jobs"]))]
    return job["steps"]


def index_of(name: str) -> int:
    for position, step in enumerate(steps()):
        if step.get("name") == name:
            return position
    raise AssertionError(f"no step named {name!r} in {WORKFLOW.name}")


class RegistrationStepTest(unittest.TestCase):
    def test_the_step_is_in_the_job(self) -> None:
        index_of(STEP_NAME)

    def test_the_step_runs_the_preflight(self) -> None:
        step = steps()[index_of(STEP_NAME)]
        self.assertIn(PREFLIGHT, step.get("run", ""))

    def test_the_step_runs_before_the_build(self) -> None:
        """Before `Install dependencies`, and therefore before `Build packages`.

        The whole point is that a dispatch that is not the arm must not cost a build. Asserting
        only "before the run" would pass with the step next to the benchmark call, which is where
        the artifact comparison already sits -- and that is the arrangement this replaces.
        """
        self.assertLess(index_of(STEP_NAME), index_of("Install dependencies"))

    def test_the_step_forwards_the_declaration(self) -> None:
        step = steps()[index_of(STEP_NAME)]
        self.assertEqual(
            (step.get("env") or {}).get("CORTEX_DECLARED_DEPARTURES"),
            "${{ vars.CORTEX_DECLARED_DEPARTURES }}",
        )


if __name__ == "__main__":
    unittest.main()
