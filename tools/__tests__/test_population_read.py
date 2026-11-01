#!/usr/bin/env python3
"""`readout-arm-run.py --population`, the instrument that reads a named set of questions.

## The defect this file is written against

The arm's unit of reading has been the capability, and `§13.203.4` measured that the capability's
total cannot see the thing most treatments do: 4.8% of 1,880 paired reads flip on **byte-identical**
prompts, so the 2σ band on a 121-question route is **9.3 questions**. A treatment written for eight
questions and expected to convert four is invisible at that resolution -- and, worse, a capability
delta of +1 on 30 questions reads as "no effect" while one of those 30 questions flipped in all four
repetitions against a null whose expected count is `4.6e-06`.

So the readable claim at that size is a set named **before** the run, counted one by one. This module
tests the counter, not the claim: what a conversion is, what it refuses to count, and what it does
when the registration and the artifact disagree.

## Why the bars live in a file rather than in an argument

`--population tools/populations/mr-screen.json` reads the questions, the bars and the directions from
the registration. Passing them on the command line would let a read-time edit turn a failed prediction
into a passed one, which is the same defect as a threshold chosen after seeing the numbers. The
registration itself is held to the pre-registration document by
`test_the_registered_population_is_the_documents_population` below, so the file cannot drift from
`§13.205.6` without a failure.
"""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "readout-arm-run.py"
SPEC = REPO / "tools" / "populations" / "mr-screen.json"
PREREGISTRATION = REPO / "docs" / "PREREGISTRATION-CORTEX-MEMORY-ARM.md"


def _module():  # noqa: ANN202 - imported by path, like every other tool test in this directory
    spec = importlib.util.spec_from_file_location("readout_arm_run", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def side(reads: dict[str, str], capability: str = "MR") -> dict:
    """One artifact, from `{questionId: "one char per repetition"}`.

    Written this way rather than as one bit string per repetition because a test about a **per
    question** read should state each question's four reads on one line: a fixture built the other
    way round makes the reader transpose four strings to check one claim, and a transposed fixture
    is a test that passes on its own bug.
    """
    identifiers = list(reads)
    repetitions = len(next(iter(reads.values())))
    bits = ["".join(reads[identifier][index] for identifier in identifiers) for index in range(repetitions)]
    return {
        "questions": [{"questionId": identifier, "capability": capability} for identifier in identifiers],
        "ablation": {"featureCorrectByRun": bits},
    }


def spec_of(converts: list[str], bar: int, guard: list[str], guard_bar: int) -> dict:
    return {
        "name": "test",
        "converts": {"ids": converts, "bar": bar},
        "guard": {"ids": guard, "bar": guard_bar},
    }


class TestWhatCountsAsAConversion:
    """The four-way split, and why `mixed` exists rather than a majority."""

    def test_a_decisive_gain_counts(self) -> None:
        module = _module()
        spec = spec_of(["q1"], 1, ["q2"], 1)
        control = side({"q1": "0000", "q2": "1111"})
        run = side({"q1": "1111", "q2": "1111"})
        section, failures = module.population_section(run, control, spec)
        assert failures == 0
        assert "q1  control 0000  run 1111  converted" in section
        assert "converted 1   worsened 0   held 0   mixed 0" in section

    def test_a_read_that_moved_without_crossing_is_mixed_rather_than_counted(self) -> None:
        # `1 of 4` to `2 of 4` never reaches the decisive boundary of three, and 4.8% of 1,880
        # paired reads flip on byte-identical prompts, so this is the reader rather than the ask.
        module = _module()
        spec = spec_of(["q1"], 1, ["q2"], 1)
        control = side({"q1": "1000", "q2": "1111"})
        run = side({"q1": "1100", "q2": "1111"})
        section, failures = module.population_section(run, control, spec)
        assert "q1  control 1000  run 1100  mixed" in section
        assert "converted 0   worsened 0   held 0   mixed 1" in section
        assert failures == 1

    def test_the_same_read_count_on_both_sides_is_held_whatever_the_shape(self) -> None:
        # `0011` against `1100` is two reads either way. The order of the four does not carry a
        # reading, and a rule that compared strings would call this a change.
        module = _module()
        spec = spec_of(["q1"], 1, ["q2"], 1)
        control = side({"q1": "0011", "q2": "1111"})
        run = side({"q1": "1100", "q2": "1111"})
        section, _failures = module.population_section(run, control, spec)
        assert "q1  control 0011  run 1100  held" in section

    def test_two_of_four_on_the_gaining_side_is_not_decisive(self) -> None:
        # The boundary, stated explicitly because it is the one a "majority" rule would move: with
        # four repetitions three is a majority and two is a coin.
        module = _module()
        spec = spec_of(["q1"], 1, ["q2"], 1)
        control = side({"q1": "0000", "q2": "1111"})
        run = side({"q1": "1100", "q2": "1111"})
        section, _failures = module.population_section(run, control, spec)
        assert "q1  control 0000  run 1100  mixed" in section

    def test_one_correct_read_on_the_control_side_still_counts_as_open(self) -> None:
        # `1000` is the wrong side decisively -- one read in four is inside the measured flip rate --
        # so a question the control read at 1 of 4 and the run reads at 4 of 4 is a conversion rather
        # than a "held" that had nothing to hold.
        module = _module()
        spec = spec_of(["q1"], 1, ["q2"], 1)
        control = side({"q1": "1000", "q2": "1111"})
        run = side({"q1": "1111", "q2": "1111"})
        section, failures = module.population_section(run, control, spec)
        assert "q1  control 1000  run 1111  converted" in section
        assert failures == 0

    def test_a_question_that_stays_wrong_is_held_rather_than_mixed(self) -> None:
        module = _module()
        spec = spec_of(["q1"], 1, ["q2"], 1)
        control = side({"q1": "0000", "q2": "1111"})
        run = side({"q1": "0000", "q2": "1111"})
        section, failures = module.population_section(run, control, spec)
        assert "q1  control 0000  run 0000  held" in section
        assert failures == 1

    def test_a_regression_counts_on_the_guard_and_after_does_not(self) -> None:
        module = _module()
        spec = spec_of(["q1"], 1, ["q2", "q3"], 1)
        control = side({"q1": "0000", "q2": "1111", "q3": "1111"})
        run = side({"q1": "1111", "q2": "0000", "q3": "1111"})
        section, failures = module.population_section(run, control, spec)
        assert "q2  control 1111  run 0000  worsened" in section
        assert "converted 1   worsened 0   held 0   mixed 0" in section
        assert "converted 0   worsened 1   held 1   mixed 0" in section
        # One regression against a ceiling of one is the fail line, not a pass: the ceiling is
        # inclusive, so this run passes and a second regression would not.
        assert failures == 0


class TestTheBars:
    """A floor on the population and a ceiling on the guard, and both are failures when missed."""

    def test_a_population_below_its_floor_is_a_failed_prediction(self) -> None:
        module = _module()
        spec = spec_of(["q1", "q2"], 2, ["q3"], 1)
        control = side({"q1": "0000", "q2": "0000", "q3": "1111"})
        run = side({"q1": "1111", "q2": "0000", "q3": "1111"})
        section, failures = module.population_section(run, control, spec)
        assert failures == 1
        assert "BELOW the registered floor of 2" in section
        assert "failed prediction" in section

    def test_a_guard_above_its_ceiling_is_a_failed_prediction(self) -> None:
        module = _module()
        spec = spec_of(["q1"], 1, ["q2", "q3"], 0)
        control = side({"q1": "0000", "q2": "1111", "q3": "1111"})
        run = side({"q1": "1111", "q2": "0000", "q3": "0000"})
        section, failures = module.population_section(run, control, spec)
        assert failures == 1
        assert "ABOVE the registered ceiling of 0" in section
        assert "attention, not its thoroughness" in section

    def test_both_bars_holding_is_the_pass(self) -> None:
        module = _module()
        spec = spec_of(["q1"], 1, ["q2", "q3"], 1)
        control = side({"q1": "0000", "q2": "1111", "q3": "1111"})
        run = side({"q1": "1111", "q2": "1111", "q3": "0000"})
        section, failures = module.population_section(run, control, spec)
        assert failures == 0
        assert "the screen is the variable on this population" in section
        assert "did not buy its conversions from this set" in section


class TestTheRefusals:
    """Every way a population read can be quietly wrong, refused rather than skipped."""

    def test_an_id_absent_from_the_run_is_refused(self) -> None:
        # A skipped id reports a smaller denominator with the same numerator, which is a larger
        # conversion rate -- the failure mode every refusal in this tool exists to prevent.
        module = _module()
        spec = spec_of(["q1", "q9"], 1, ["q2"], 1)
        control = side({"q1": "0000", "q2": "1111", "q9": "0000"})
        run = side({"q1": "1111", "q2": "1111"})
        with pytest.raises(ValueError, match="absent from the run"):
            module.population_section(run, control, spec)

    def test_an_id_absent_from_the_control_is_refused(self) -> None:
        module = _module()
        spec = spec_of(["q1", "q9"], 1, ["q2"], 1)
        control = side({"q1": "0000", "q2": "1111"})
        run = side({"q1": "1111", "q2": "1111", "q9": "0000"})
        with pytest.raises(ValueError, match="absent from the control"):
            module.population_section(run, control, spec)

    def test_a_repeated_id_in_a_roster_is_refused(self) -> None:
        # A repeat makes the index ambiguous, so the read would silently use one of the two.
        module = _module()
        spec = spec_of(["q1"], 1, ["q2"], 1)
        control = side({"q1": "0000", "q2": "1111"})
        run = {
            "questions": [{"questionId": "q1"}, {"questionId": "q1"}],
            "ablation": {"featureCorrectByRun": ["11"] * 4},
        }
        with pytest.raises(ValueError, match="repeats"):
            module.population_section(run, control, spec)

    def test_a_group_without_a_bar_is_refused(self) -> None:
        module = _module()
        control = side({"q1": "0000", "q2": "1111"})
        run = side({"q1": "1111", "q2": "1111"})
        with pytest.raises(ValueError, match="no integer bar"):
            module.population_section(
                run, control, {"converts": {"ids": ["q1"]}, "guard": {"ids": ["q2"], "bar": 1}}
            )

    def test_a_group_without_questions_is_refused(self) -> None:
        module = _module()
        control = side({"q1": "0000"})
        run = side({"q1": "1111"})
        with pytest.raises(ValueError, match="names no questions"):
            module.population_section(
                run, control, {"converts": {"ids": [], "bar": 1}, "guard": {"ids": ["q1"], "bar": 1}}
            )

    def test_a_missing_group_is_refused(self) -> None:
        module = _module()
        control = side({"q1": "0000"})
        run = side({"q1": "1111"})
        with pytest.raises(ValueError, match="names no 'guard' group"):
            module.population_section(run, control, {"converts": {"ids": ["q1"], "bar": 1}})

    def test_a_different_repetition_count_is_refused(self) -> None:
        # Two reads against four would compare a decisive verdict with a coin, and the threshold
        # assumes the same number of repetitions on both sides.
        module = _module()
        spec = spec_of(["q1"], 1, ["q2"], 1)
        control = side({"q1": "00", "q2": "11"})
        run = side({"q1": "1111", "q2": "1111"})
        with pytest.raises(ValueError, match="repetitions"):
            module.population_section(run, control, spec)

    def test_a_roster_whose_bits_do_not_match_its_length_is_refused(self) -> None:
        module = _module()
        spec = spec_of(["q1"], 1, ["q2"], 1)
        control = side({"q1": "0000", "q2": "1111"})
        run = {
            "questions": [{"questionId": "q1"}, {"questionId": "q2"}],
            "ablation": {"featureCorrectByRun": ["1", "1", "1", "1"]},
        }
        with pytest.raises(ValueError, match="one per question"):
            module.population_section(run, control, spec)


class TestTheRegisteredPopulation:
    """The file the tool reads and the document that registers it must be the same population."""

    def test_the_registration_parses_and_names_both_groups(self) -> None:
        registration = json.loads(SPEC.read_text(encoding="utf-8"))
        assert registration["ask"] == "candidates"
        assert registration["control"] == "enumerated"
        assert registration["converts"]["direction"] == "floor"
        assert registration["guard"]["direction"] == "ceiling"
        assert len(registration["converts"]["ids"]) == 8
        assert registration["converts"]["bar"] == 4
        assert registration["guard"]["bar"] == 4

    def test_the_guard_cannot_contain_a_question_the_floor_counts(self) -> None:
        # A question cannot be both the treatment and the guard: if the eight converted and were
        # also in the guard, a conversion would be counted as nothing while a regression would be
        # counted twice, and the two bars would stop being independent.
        registration = json.loads(SPEC.read_text(encoding="utf-8"))
        converts = set(registration["converts"]["ids"])
        guard = set(registration["guard"]["ids"])
        descriptive = set(registration["descriptive"]["ids"])
        assert converts.isdisjoint(guard)
        assert descriptive.isdisjoint(guard)
        assert descriptive.isdisjoint(converts)

    def test_the_guard_is_the_route_less_what_is_named_above_it(self) -> None:
        # The rule, stated as arithmetic rather than repeated as a list: MR has 121 questions, 94 of
        # them enumeration-shaped on the control artifact, and the guard is that 94 minus the 11 ids
        # this section names. If a later edit adds an id to `converts` without removing it from the
        # guard, this fails -- which is the failure a copied list cannot report about itself.
        registration = json.loads(SPEC.read_text(encoding="utf-8"))
        assert len(registration["guard"]["ids"]) == 94 - 8 - 3
        assert registration["guard"]["count"] == len(registration["guard"]["ids"])
        assert len(set(registration["guard"]["ids"])) == len(registration["guard"]["ids"])

    def test_the_old_three_question_guard_is_kept_as_descriptive(self) -> None:
        # §13.204.4's guard could not fail -- all three are already wrong in every repetition, so
        # `worsened` had no state to move into. It is kept in the file rather than deleted, because a
        # criterion that was replaced for being unfalsifiable is worth being able to find.
        registration = json.loads(SPEC.read_text(encoding="utf-8"))
        assert registration["descriptive"]["ids"] == ["2e6d26dc", "88432d0a", "00ca467f"]

    def test_the_registered_population_is_the_documents_population(self) -> None:
        # §13.205.6 is the registration and the JSON is what the tool reads; two copies of one
        # population is exactly the drift §13.203 found between §10.3 and the dispatch table, where
        # both copies were stale in the same direction and no check could see it. This is the check.
        source = PREREGISTRATION.read_text(encoding="utf-8")
        section = re.search(r"#### 13\.205\.6 .*?(?=\n#### |\n### )", source, re.S)
        assert section is not None, "§13.205.6 is gone, so the population has no registration"
        table = section.group(0)

        converts_row = re.search(r"\| converts \| (.+?) \|", table)
        assert converts_row is not None
        registration = json.loads(SPEC.read_text(encoding="utf-8"))
        assert re.findall(r"`([0-9a-z_]+)`", converts_row.group(1)) == registration["converts"]["ids"]

    def test_the_document_states_the_same_bars(self) -> None:
        source = PREREGISTRATION.read_text(encoding="utf-8")
        section = re.search(r"#### 13\.205\.6 .*?(?=\n#### |\n### )", source, re.S)
        assert section is not None
        registration = json.loads(SPEC.read_text(encoding="utf-8"))
        guard_size = len(registration["guard"]["ids"])
        # The prose states them as "≥ 4 of 8" and "≤ 4 of 83", which carries the direction as well as
        # the number: a floor read as a ceiling would pass a run that converted nothing.
        assert f"**≥ {registration['converts']['bar']} of 8**" in section.group(0)
        assert f"**≤ {registration['guard']['bar']} of {guard_size}**" in section.group(0)
