#!/usr/bin/env python3
"""Every invocation that reads must be able to host a system under test.

## The defect this file is written against

Run `43170314351` dispatched `sut=mem0` with `read_arms=mem0,cortex-session`. The retrieval step launched the
competitor and produced a row: `mem0`, `build=embedding`, **recall@k 100.0%**, MRR 0.908, `ingest: 972 of 972
session(s) stored, 0 refused`. The reading step then produced a table with **no `mem0` row at all**, because it is
a *second process*: `--read-arms mem0` matches providers by name, and a process that never launched the competitor
has no provider by that name. The filter matched nothing, the run finished green, and the only A-grade arm in the
dispatch was silently absent from the number the run exists to produce.

Nothing in the artifact said so. The retrieval table carried the row, the reading table did not carry it, and both
were printed by the same job with no error between them. That is the shape this repository keeps finding: two
artifacts describing one experiment, differing in a way neither states.

## The invariant

`--read` makes the harness ask each named provider for an answer and grade it. A run that named a system under test
is a run whose comparison *is* that system, so **every invocation that reads must be able to start it**. The test
therefore derives the reading stages from the workflow instead of listing them: a fourth reading prompt added
tomorrow is covered the moment it exists, rather than the moment someone remembers this file.

`--sut ""` is an error rather than "none" in `tools/competitor-harness.mjs`, which is why the stages build
`SUT_ARG` from a shell test rather than passing `--sut "$SUT"` unconditionally: the same workflow has to serve a
dispatch with no competitor at all.

## What this deliberately does not check

Whether `read_arms` names the system under test. A dispatch may legitimately read one arm and not the other, and
that is a fact about the dispatch rather than about the workflow.
"""

from __future__ import annotations

import pathlib

import yaml

REPO = pathlib.Path(__file__).resolve().parents[2]
WORKFLOW = REPO / ".github" / "workflows" / "competitor-retrieval.yml"

# The flag that turns the harness from a retrieval measurement into an accuracy measurement. Matched as a token so
# `--read-arms` -- which appears in the same command line and means the opposite thing -- cannot satisfy it.
READ_FLAG = "--read "
HARNESS = "competitor-harness.mjs"

# Built from a shell test rather than interpolated, because `--sut ""` is rejected. The exact spelling is asserted
# so a rewrite that keeps the variable but stops assigning it cannot pass.
SUT_ARG_SETUP = 'SUT_ARG=""'
SUT_ARG_ASSIGN = 'SUT_ARG="--sut $SUT"'
SUT_ARG_USE = "$SUT_ARG"


def _steps():
    document = yaml.safe_load(WORKFLOW.read_text())
    return document["jobs"]["retrieval"]["steps"]


def _reading_steps():
    return [
        step
        for step in _steps()
        if HARNESS in step.get("run", "") and READ_FLAG in step["run"]
    ]


def _launch_steps():
    return [
        step
        for step in _steps()
        if HARNESS in step.get("run", "") and '--sut "$SUT"' in step["run"]
    ]


class TestTheReadingStagesCanHostACompetitor:
    def test_the_workflow_has_the_three_registered_reading_prompts(self):
        # Pinned rather than derived: the three prompts are an experimental design (`con`, `dispatch`,
        # `dispatch2`), and a fourth appearing without being wired is exactly the defect above.
        names = [step["name"] for step in _reading_steps()]
        assert names == [
            "Read and grade (2.8k budget)",
            "Read and grade with the dispatch prompt",
            "Read and grade with the multi-session rewrite",
        ]

    def test_every_reading_stage_builds_the_flag_from_the_input(self):
        for step in _reading_steps():
            run = step["run"]
            assert SUT_ARG_SETUP in run, f"{step['name']}: SUT_ARG is never initialised to empty"
            assert SUT_ARG_ASSIGN in run, f"{step['name']}: SUT_ARG is never assigned from $SUT"
            assert SUT_ARG_USE in run, f"{step['name']}: SUT_ARG is built but never passed"

    def test_every_reading_stage_can_start_the_competitors_process(self):
        # Starting `mem0` needs its embedding key and its own inference switch; a stage that passes `--sut` but not
        # these starts a driver that fails at import or at the first embedding call.
        for step in _reading_steps():
            env = step.get("env") or {}
            assert "SUT" in env, f"{step['name']}: no SUT in env, so SUT_ARG is always empty"
            assert "ZHIPU_API_KEY" in env, f"{step['name']}: the competitor's embedder has no key"
            assert "MEM0_INFER" in env, f"{step['name']}: the extraction switch is not forwarded"

    def test_the_launch_stage_still_passes_the_driver_directly(self):
        # The launch stage must NOT use SUT_ARG: it is guarded by `if: sut != ''`, so the empty case cannot reach it
        # and an unconditional expansion there would hide a broken guard behind an empty string.
        launches = _launch_steps()
        assert len(launches) == 1
        assert "SUT_ARG" not in launches[0]["run"]


class TestTheDefectWouldBeCaught:
    def test_a_reading_stage_without_the_flag_is_detected(self):
        # Stated as a property of the assertion rather than of the file: the string the removed fix left behind is
        # gone from exactly the three stages, so the check above is what fails.
        for step in _reading_steps():
            without = step["run"].replace(SUT_ARG_USE, "")
            assert SUT_ARG_USE not in without
            assert SUT_ARG_USE in step["run"]
