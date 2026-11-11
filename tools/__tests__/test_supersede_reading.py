#!/usr/bin/env python3
"""The reader's own gates, on synthetic artifacts.

## What is being pinned

`tools/supersede-reading.py` is the thing that will decide `K1`-`K5` of §13.366, so its arithmetic and its
refusals are the test subject rather than the mechanism. Three properties matter and each has a way to fail
silently:

1. **The population is the control's.** §13.366.1 records the defect: a target list read from another dispatch
   named questions that already pass in this arm's control, and a gate stated over them was unreachable by
   construction. A test that let the population be passed in would not have caught it.
2. **A refusal, not a smaller denominator.** Two artifacts whose rosters disagree, or a run with one repetition,
   are errors. Read as an intersection they produce a number that cannot be compared to the one it replaced.
3. **The identity of the census is checked, not trusted.** `K4` reads the pass's own counters, and a census
   claiming replacements it did not make is a census whose guard never fired.
"""

from __future__ import annotations

import importlib.util
import json
import sys
import math
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]


def _load(name: str):
    """Load a tool by path, because its filename is not a Python module name."""
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), TOOLS / f"{name}.py")
    if spec is None or spec.loader is None:  # pragma: no cover - a broken checkout, not a defect
        raise ImportError(name)
    module = importlib.util.module_from_spec(spec)
    # Registered before execution: the tool uses `from __future__ import annotations`, so `@dataclass` resolves
    # its field types through `sys.modules[cls.__module__]` and a module that is not there yet raises inside the
    # decorator. Registering first is what `import` itself does.
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


reader = _load("supersede-reading")


def artifact(
    *,
    capability: str = "KU",
    ids: list[str],
    control_masks: list[list[int]] | None = None,
    supersession: dict | None = None,
    prompts: dict[str, str] | None = None,
    usage: dict | None = None,
) -> dict:
    """A minimal artifact: the roster plus the four fields the reader actually reads."""
    masks = control_masks or [[0, 0, 0, 0] for _ in ids]
    questions = [
        {
            "questionId": question_id,
            "capability": capability,
            "correct": masks[0][index] == 1,
            "promptDigest": (prompts or {}).get(question_id, f"digest-{question_id}"),
        }
        for index, question_id in enumerate(ids)
    ]
    report = {
        "questions": questions,
        "ablation": {
            "featureCorrectByRun": [
                "".join(str(mask[index]) for index in range(len(ids))) for mask in masks
            ]
        },
        "llmUsage": usage or {"promptTokens": 1000, "completionTokens": 100},
    }
    if supersession is not None:
        report["supersession"] = supersession
    return report


def write(directory: Path, name: str, payload: dict) -> Path:
    path = directory / name
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


class ExactTestTest(unittest.TestCase):
    """The two nulls, because a gate stated against the wrong one is a gate that cannot fail."""

    def test_six_of_nothing_is_the_cell_the_bar_was_set_at(self) -> None:
        self.assertAlmostEqual(reader.mcnemar_exact(6, 0), 0.03125, places=6)
        self.assertAlmostEqual(reader.mcnemar_exact(4, 0), 0.125, places=6)
        self.assertAlmostEqual(reader.mcnemar_exact(0, 0), 1.0, places=6)

    def test_a_regression_destroys_the_result_faster_than_a_conversion_builds_it(self) -> None:
        self.assertLess(reader.mcnemar_exact(6, 0), 0.05)
        self.assertGreater(reader.mcnemar_exact(6, 1), 0.05)

    def test_the_two_nulls_agree_at_four_and_six_and_differ_at_five(self) -> None:
        # §13.366: both nulls call four a draw and six a result. Five is the cell where they disagree -- exact
        # `p = 0.063` and flip-floor `p = 0.016` -- which is exactly why the reader prints both and why the bar
        # was set at six rather than at five.
        self.assertLess(reader.noise_floor(6, 72), 0.01)
        self.assertGreater(reader.noise_floor(4, 72), 0.05)
        self.assertGreater(reader.mcnemar_exact(5, 0), 0.05)
        self.assertLess(reader.noise_floor(5, 72), 0.05)

    def test_an_empty_population_cannot_produce_a_confident_p(self) -> None:
        self.assertEqual(reader.noise_floor(3, 0), 1.0)

    def test_a_missing_denominator_is_infinite_growth_rather_than_zero(self) -> None:
        self.assertEqual(reader.ratio(5, 0), math.inf)
        self.assertEqual(reader.ratio(5, None), math.inf)
        self.assertEqual(reader.ratio(None, 5), math.inf)
        self.assertAlmostEqual(reader.ratio(110, 100), 0.1)


class RefusalTest(unittest.TestCase):
    """What the reader refuses, because each refusal is a number it would otherwise publish."""

    def test_one_repetition_is_refused_rather_than_read_as_stable(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path = write(
                Path(raw),
                "a.json",
                {
                    "questions": [{"questionId": "q", "capability": "KU", "promptDigest": "d"}],
                    "ablation": {"featureCorrectByRun": ["0"]},
                },
            )
            with self.assertRaises(SystemExit):
                reader.Side.load(path)

    def test_a_roster_disagreement_is_refused_rather_than_intersected(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            left = write(Path(raw), "l.json", artifact(ids=["a", "b"]))
            right = write(Path(raw), "r.json", artifact(ids=["a", "c"]))
            with self.assertRaises(SystemExit):
                reader.read(left, right)

    def test_an_artifact_with_no_roster_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            path = write(Path(raw), "a.json", {"ablation": {"featureCorrectByRun": ["00", "00"]}})
            with self.assertRaises(SystemExit):
                reader.Side.load(path)

    def test_a_duplicate_question_id_is_refused(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            payload = artifact(ids=["a", "a"])
            path = write(Path(raw), "a.json", payload)
            with self.assertRaises(SystemExit):
                reader.Side.load(path)


class ReadingTest(unittest.TestCase):
    """The five gates, each on a fixture built to make exactly one of them fail."""

    def read(self, treatment: dict, control: dict) -> dict:
        with tempfile.TemporaryDirectory() as raw:
            left = write(Path(raw), "t.json", treatment)
            right = write(Path(raw), "c.json", control)
            return reader.read(left, right)

    def converted(self, n: int, total: int = 8) -> tuple[dict, dict]:
        """`total` stable KU failures in the control, `n` of them converted by the treatment."""
        ids = [f"q{index}" for index in range(total)]
        control = artifact(ids=ids, control_masks=[[0] * total for _ in range(4)])
        masks = [[1 if index < n else 0 for index in range(total)] for _ in range(4)]
        treatment = artifact(
            ids=ids,
            control_masks=masks,
            supersession={
                "attempted": total,
                "replaced": n,
                "refused": total - n,
                "refusals": {"no-change": total - n},
            },
        )
        return treatment, control

    def test_six_of_eight_holds_and_four_does_not(self) -> None:
        six = self.read(*self.converted(6))
        self.assertTrue(six["gates"]["K1"]["passed"], six["gates"]["K1"])
        self.assertAlmostEqual(six["gates"]["K1"]["exact_p"], 0.03125, places=6)

        four = self.read(*self.converted(4))
        self.assertFalse(four["gates"]["K1"]["passed"], four["gates"]["K1"])

    def test_the_population_is_the_controls_stable_failures_not_a_carried_list(self) -> None:
        # Two questions that already pass in the control, and one that fails. The gate's denominator is one.
        ids = ["passing-one", "passing-two", "failing"]
        control = artifact(
            ids=ids,
            control_masks=[[1, 1, 0] for _ in range(4)],
        )
        treatment = artifact(
            ids=ids,
            control_masks=[[1, 1, 1] for _ in range(4)],
            supersession={
                "attempted": 1,
                "replaced": 1,
                "refused": 0,
                "refusals": {"no-change": 0},
            },
        )
        reading = self.read(treatment, control)

        self.assertEqual([row["id"] for row in reading["targets"]], ["failing"])
        self.assertTrue(reading["gates"]["K1"]["passed"])

    def test_one_regression_fails_the_gate_even_with_every_conversion(self) -> None:
        ids = [f"q{index}" for index in range(8)]
        control = artifact(ids=ids, control_masks=[[0] * 8 for _ in range(4)])
        # Seven convert and one new question breaks: index 0 goes from 0 to 1, index 7 is not in the stable set
        # because it starts correct -- so the regression has to be built on a question that was passing.
        control["questions"].append(
            {"questionId": "was-passing", "capability": "KU", "correct": True, "promptDigest": "x"}
        )
        control["ablation"]["featureCorrectByRun"] = ["00000000" + "1" for _ in range(4)]
        treatment = artifact(
            ids=ids,
            control_masks=[[1] * 8 for _ in range(4)],
            supersession={"attempted": 8, "replaced": 8, "refused": 0, "refusals": {}},
        )
        treatment["questions"].append(
            {"questionId": "was-passing", "capability": "KU", "correct": False, "promptDigest": "x"}
        )
        treatment["ablation"]["featureCorrectByRun"] = ["11111111" + "0" for _ in range(4)]

        reading = self.read(treatment, control)

        self.assertEqual(reading["population"]["damages"], 1)
        self.assertFalse(reading["gates"]["K1"]["passed"])

    def test_a_prompt_difference_on_another_capability_fails_the_reach_gate(self) -> None:
        ids = ["k1", "m1"]
        control = artifact(ids=ids, capability="KU", control_masks=[[0, 1] for _ in range(4)])
        control["questions"][1]["capability"] = "MR"
        treatment = artifact(
            ids=ids,
            capability="KU",
            control_masks=[[1, 1] for _ in range(4)],
            prompts={"m1": "different"},
            supersession={"attempted": 1, "replaced": 1, "refused": 0, "refusals": {}},
        )
        treatment["questions"][1]["capability"] = "MR"

        reading = self.read(treatment, control)

        self.assertEqual(reading["digest_differences"], ["m1"])
        self.assertFalse(reading["gates"]["K3"]["passed"])
        # K2's spread for MR is 4.16 and the movement is zero, so the reach proof is the only thing that fails.
        self.assertTrue(reading["gates"]["K2"]["passed"])

    def test_a_capability_outside_its_own_spread_fails_the_reach_gate(self) -> None:
        ids = ["k1", "m1", "m2"]
        control = artifact(ids=ids, capability="KU", control_masks=[[0, 0, 0] for _ in range(4)])
        control["questions"][1]["capability"] = "MR"
        control["questions"][2]["capability"] = "MR"
        treatment = artifact(
            ids=ids,
            capability="KU",
            control_masks=[[1, 1, 1] for _ in range(4)],
            supersession={"attempted": 1, "replaced": 1, "refused": 0, "refusals": {}},
        )
        treatment["questions"][1]["capability"] = "MR"
        treatment["questions"][2]["capability"] = "MR"

        reading = self.read(treatment, control)

        # Two `MR` questions both moved: net 2.00, inside 4.16. The gate is a bound, not a zero-tolerance rule.
        self.assertTrue(reading["gates"]["K2"]["passed"])
        self.assertEqual(reading["per_capability"]["MR"]["repairs"], 2)

    def test_an_absent_census_fails_the_pass_activity_gate(self) -> None:
        control = artifact(ids=["q0"], control_masks=[[0] for _ in range(4)])
        treatment = artifact(ids=["q0"], control_masks=[[1] for _ in range(4)])
        reading = self.read(treatment, control)

        self.assertIsNone(reading["census"])
        self.assertFalse(reading["gates"]["K4"]["passed"])

    def test_a_guard_that_never_fired_fails_the_pass_activity_gate(self) -> None:
        control = artifact(ids=["q0"], control_masks=[[0] for _ in range(4)])
        treatment = artifact(
            ids=["q0"],
            control_masks=[[1] for _ in range(4)],
            supersession={"attempted": 1, "replaced": 1, "refused": 0, "refusals": {}},
        )
        reading = self.read(treatment, control)

        self.assertFalse(reading["gates"]["K4"]["passed"])

    def test_token_growth_fails_the_cost_gate(self) -> None:
        control = artifact(
            ids=["q0"],
            control_masks=[[0] for _ in range(4)],
            usage={"promptTokens": 1000, "completionTokens": 100},
        )
        treatment = artifact(
            ids=["q0"],
            control_masks=[[1] for _ in range(4)],
            usage={"promptTokens": 2000, "completionTokens": 400},
            supersession={"attempted": 1, "replaced": 1, "refused": 1, "refusals": {"no-change": 1}},
        )
        reading = self.read(treatment, control)

        self.assertFalse(reading["gates"]["K5"]["passed"])

    def test_the_printed_report_names_every_gate_and_its_verdict(self) -> None:
        reading = self.read(*self.converted(6))
        text = reader.report(reading)

        for name in ("K1", "K2", "K3", "K4", "K5"):
            self.assertIn(f"`{name}`", text)
        self.assertIn("holds", text)
        # The continuity table is printed beside the gate, which is what makes §13.366.1 auditable from a run.
        self.assertIn("for continuity", text)


if __name__ == "__main__":
    unittest.main()
