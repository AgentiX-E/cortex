#!/usr/bin/env python3
"""A percentage printed beside a count has to be that count's percentage.

## The defect these checks guard against

Round 61 read two artifacts and published a table that compared the control's **maximum** to the
other arm's **mean**, and printed an all-runs mean accuracy (`91.05%`) next to a single-repetition
count (`456`). Neither is an arithmetic slip; both are *unit* slips, and both are invisible to every
check that existed, because the artifact is self-consistent and only the sentence quoting it is not.

The artifact cannot stop a reader from writing that sentence, but it can make the two units
mechanically distinguishable, which is what these three checks do:

* `accuracy-unit` -- `feature.metrics.accuracy * total` must equal `feature.metrics.correct`. A
  mean over four repetitions fails this the moment it is placed in the repetition field, which is
  exactly how `91.05% (456)` happened.
* `cap-order` -- every capability's `min <= avg <= max`. A table that quotes a maximum as if it
  were a mean is quoting a cell from a row where the three exist side by side.
* `accuracy-band` -- an `all-runs` mean times the question count must fall inside
  `[sum of minima, sum of maxima]`. A mean outside the band its own repetitions define is not a
  mean of them.

## What these tests are

They build the two-hundred-cell report shape the benchmark actually emits -- the real capability
sizes (150 / 121 / 72 / 127 / 30) and the real per-capability repetition spread from dispatch
`42533236864` -- and then mutate one field at a time. No mock stands in for a dependency: the code
under test is a pure function of a dictionary, and the dictionary is the whole input.
"""

from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "readout-arm-run.py"

#: Capability sizes and the repetition spread dispatch `42533236864` reported for the feature arm.
#: The sums are 500 questions and 453-459 correct, which is what makes the band check meaningful.
SPREAD = {
    "IE": (141, 141.25, 142),
    "MR": (100, 100.5, 101),
    "KU": (62, 62.75, 64),
    "TR": (120, 120.75, 122),
    "ABS": (30, 30, 30),
}
SIZES = {"IE": 150, "MR": 121, "KU": 72, "TR": 127, "ABS": 30}


def load_tool():
    """Import the hyphenated script as a module."""
    spec = importlib.util.spec_from_loader(
        "readout_arm_run", importlib.machinery.SourceFileLoader("readout_arm_run", str(TOOL))
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


TOOL_MODULE = load_tool()


def report(
    metrics_accuracy: float = 0.912,
    all_runs_accuracy: float = 0.9105,
    mr_spread: tuple[int, float, int] = (100, 100.5, 101),
) -> dict:
    """The smallest report that answers all three checks, at the sizes the benchmark uses."""
    by_capability = {name: {"min": s[0], "avg": s[1], "max": s[2]} for name, s in SPREAD.items()}
    by_capability["MR"] = {"min": mr_spread[0], "avg": mr_spread[1], "max": mr_spread[2]}
    return {
        "questionCount": 500,
        "runs": 4,
        "memoryArmConfig": {"reviewPass": "bare"},
        "abstentionReasons": {"answered": 2000},
        "feature": {
            "name": "cortex-memory",
            "metrics": {
                "accuracy": metrics_accuracy,
                "total": 500,
                "correct": 456,
                "perCapability": {},
            },
        },
        "baseline": {
            "name": "reference-pipeline",
            "metrics": {"accuracy": 0.434, "total": 500, "correct": 217, "perCapability": {}},
        },
        "ablation": {
            "featureByCapability": by_capability,
            "questionsByCapability": dict(SIZES),
        },
        "costEfficiency": {"accuracy": all_runs_accuracy, "accuracySource": "all-runs"},
    }


def audit(document: dict) -> tuple[str, int]:
    """Run the audit the workflow runs, and return its rendered block and its failure count.

    The count is an integer rather than a list: `audit_section` is the gate the workflow reads, and
    a gate only needs to know whether anything failed. The tests below read the rendered block,
    because the name of the failing check is the thing a reader needs.
    """
    text, failures = TOOL_MODULE.audit_section(document, [])
    return text, failures


def row(text: str, name: str) -> str:
    """The rendered line for one check."""
    for line in text.splitlines():
        if f'  {name} ' in line or line.rstrip().endswith(name):
            return line
    raise AssertionError(f"no row for {name} in:\n{text}")


class TestAPercentageBesideACount(unittest.TestCase):
    """`accuracy-unit`: the two halves of one repetition have to agree."""

    def test_the_repetition_field_accepts_its_own_share(self) -> None:
        text, _ = audit(report())
        self.assertIn("PASS  accuracy-unit", text)

    def test_an_all_runs_mean_in_the_repetition_field_is_refused(self) -> None:
        # This is the published defect: 91.05% (the four-run mean) printed beside 456 (repetition
        # zero's count). The two differ by 0.75 of a question, which is over the half-question
        # tolerance and is therefore a different unit rather than a rounding.
        text, _ = audit(report(metrics_accuracy=0.9105))
        self.assertIn("FAIL  accuracy-unit", text)

    def test_the_row_names_both_numbers_so_the_reader_can_see_which_is_wrong(self) -> None:
        text, _ = audit(report(metrics_accuracy=0.9105))
        line = row(text, "accuracy-unit")
        self.assertIn("456 correct of 500", line)
        self.assertIn("+91.05pp", line)


class TestTheCapabilitySpread(unittest.TestCase):
    """`cap-order` and `accuracy-band`: a mean has to live inside the repetitions that made it."""

    def test_min_mean_max_in_order_passes(self) -> None:
        text, _ = audit(report())
        self.assertIn("PASS  cap-order", text)

    def test_a_mean_below_its_minimum_is_refused(self) -> None:
        text, _ = audit(report(mr_spread=(100, 99.0, 101)))
        self.assertIn("FAIL  cap-order", text)

    def test_the_all_runs_mean_must_fall_inside_the_band(self) -> None:
        text, _ = audit(report())
        self.assertIn("PASS  accuracy-band", text)

    def test_a_mean_above_every_repetition_is_refused(self) -> None:
        # 0.92 x 500 = 460, and no combination of the reported repetitions reaches 460.
        text, _ = audit(report(all_runs_accuracy=0.92))
        self.assertIn("FAIL  accuracy-band", text)

    def test_the_band_is_the_sum_of_the_capability_extremes(self) -> None:
        text, _ = audit(report())
        line = row(text, "accuracy-band")
        self.assertIn("[453, 459]", line)
        self.assertIn("455.25", line)


if __name__ == "__main__":
    unittest.main()
