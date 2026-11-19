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

import contextlib
import importlib.util
import io
import re
import unittest
from pathlib import Path
from unittest import mock

import yaml

DISPATCH = Path(__file__).resolve().parents[2] / "tools/dispatch-cortex-memory-ab.py"

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


def dispatch_module():  # noqa: ANN201 - the dispatch script, imported by path
    """The dispatcher, imported the way every other dispatch test imports it."""
    spec = importlib.util.spec_from_file_location("dispatch_cortex_memory_ab", DISPATCH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class TheDispatcherOwnsThePin(unittest.TestCase):
    """The other end of the wire the workflow test above holds: who *writes* `CORTEX_JUDGE_MODEL`.

    ## The defect this closes, stated as a sequence

    `benchmark-cortex-memory.yml` forwards `${{ vars.CORTEX_JUDGE_MODEL }}`. A repository variable is
    global and outlives the run, so the forwarding alone is a dispatch surface with two failure modes
    and no owner:

    * **inherited treatment.** A pin set for `R2` stays set. The next control dispatch is graded by a
      judge nobody chose, and the artifact says `source: "pinned"` -- true, and answering a question
      the operator did not ask.
    * **undeclared departure.** The registration gate compares `memoryArmConfig.judge.source` against
      the arm that follows its reader. A pinned run that declares nothing is refused *after* the run
      has spent, which is the `S14` shape exactly: a complete measurement refused for bookkeeping.

    The ten switches beside this one are written on every dispatch for the first reason and declared
    on the second; the judge had neither, because until this round the workflow could not set it.

    ## What is asserted, and what is deliberately not

    Not the *choice*. Whether a dispatch should pin a judge is an experimental design question and a
    direction asserted here would fail for a result. What is asserted is that the choice is written
    down before the run that inherits it, that absence is written down too (`''`, which deletes), and
    that a pin is declared to the gate in the name the gate can resolve (`judge`, not `judge.source`).
    """

    def _dispatch(self, pin: str) -> tuple[list[tuple[str, str, str]], list[str]]:
        """Run `main` with the pin decided, recording every variable write and the dispatch.

        `judge_pin` is replaced rather than the environment because the environment is not what this
        class is about: `TestThePinGrammar` reads the grammar off an explicit dict, and a `clear=True`
        environment here would assert `PATH` instead of the pin.
        """
        module = dispatch_module()
        events: list[tuple[str, str, str]] = []
        declared: list[str] = []

        def fake_write(name: str, value: str) -> str:
            events.append(("variable", name, value))
            if name == module.DECLARED_DEPARTURES_VARIABLE:
                declared.append(value)
            return value

        def fake_req(method: str, path: str, payload=None, allow_empty: bool = False):  # noqa: ANN001, ANN202
            if path.endswith("/dispatches"):
                events.append(("dispatch", "", ""))
                return None
            return {"tree": {"sha": "b" * 40}}

        with contextlib.ExitStack() as stack:
            stack.enter_context(mock.patch.object(module, "judge_pin", lambda *_: pin))
            stack.enter_context(mock.patch.object(module, "req", fake_req))
            stack.enter_context(mock.patch.object(module, "write_variable", fake_write))
            stack.enter_context(mock.patch.object(module, "remote_head", lambda: "a" * 40))
            stack.enter_context(mock.patch.object(module, "local_tree", lambda: "b" * 40))
            stack.enter_context(mock.patch.object(module, "staleness_refusal", lambda *_: None))
            stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
            self.assertEqual(module.main(["--no-budget"]), 0)
        return events, declared

    def test_an_unpinned_dispatch_clears_a_pin_it_inherited(self) -> None:
        # The inherited-treatment failure, in one assertion: `''` is what `write_variable` turns into a
        # DELETE, and absence is the state `resolveJudgeIdentity` reads as `source: "reader"`.
        events, _ = self._dispatch("")
        writes = [value for kind, name, value in events if kind == "variable" and name == "CORTEX_JUDGE_MODEL"]
        self.assertEqual([""], writes)

    def test_a_pinned_dispatch_writes_the_pin_after_the_switches_and_before_the_run(self) -> None:
        # Last of the variables, first of nothing else: a write after the dispatch would describe the
        # next run, and the workflow reads `vars` when the job starts.
        events, _ = self._dispatch("deepseek-chat")
        names = [name for kind, name, _ in events if kind == "variable"]
        self.assertEqual("CORTEX_JUDGE_MODEL", names[-1], names)
        kinds = [kind for kind, _, _ in events]
        self.assertEqual("dispatch", kinds[-1])
        self.assertGreater(len(kinds), 1)
        self.assertEqual(
            "deepseek-chat",
            next(value for kind, name, value in events if kind == "variable" and name == "CORTEX_JUDGE_MODEL"),
        )

    def test_a_pin_is_declared_in_the_name_the_gate_resolves(self) -> None:
        # `judge`, because `REGISTERED_CONDITIONS` is keyed on the declaration rather than the artifact
        # path. `judge.source` would be refused as a name that resolves to no field -- the `oracleEvidence`
        # mistake of run `42500412709`, after the money.
        _, declared = self._dispatch("deepseek-chat")
        self.assertEqual(["judge"], declared)

    def test_an_unpinned_run_declares_nothing_about_the_judge(self) -> None:
        # `judge.source: "reader"` is the registered value, so declaring it would be the "names a field
        # this run did not move" case the gate reports as an intention.
        _, declared = self._dispatch("")
        self.assertEqual([""], declared)


class TestThePinGrammar(unittest.TestCase):
    """A model id, not a closed vocabulary: the check is the shape, because the catalogue moves."""

    def test_absent_and_blank_both_mean_the_reader_grades(self) -> None:
        module = dispatch_module()
        self.assertEqual("", module.judge_pin({}))
        self.assertEqual("", module.judge_pin({"CORTEX_JUDGE_MODEL": "   "}))

    def test_the_two_spellings_the_reader_accepts_are_the_two_spellings_a_judge_accepts(self) -> None:
        # `reader-provider.ts` parses `model` and `provider:model`; a judge on another vendor needs the
        # second, which is the whole reason a family swap is dispatchable at all.
        module = dispatch_module()
        self.assertEqual("deepseek-chat", module.judge_pin({"CORTEX_JUDGE_MODEL": "deepseek-chat"}))
        self.assertEqual("zhipu:glm-4.6", module.judge_pin({"CORTEX_JUDGE_MODEL": "zhipu:glm-4.6"}))

    def test_a_shell_substitution_is_trimmed_rather_than_refused(self) -> None:
        # How the value actually arrives: `CORTEX_JUDGE_MODEL=$(...)`. A trailing newline is not a model
        # id, and refusing it would make the documented way to pass a computed value a failure.
        module = dispatch_module()
        self.assertEqual("deepseek-chat", module.judge_pin({"CORTEX_JUDGE_MODEL": " deepseek-chat\n"}))

    def test_interior_whitespace_is_refused(self) -> None:
        # Not trimmed: the value is written to a repository variable the *next* dispatch inherits, and a
        # judge no provider recognises fails one call at a time, hours in, instead of at the dispatch.
        module = dispatch_module()
        with self.assertRaises(SystemExit):
            module.judge_pin({"CORTEX_JUDGE_MODEL": "deepseek chat"})
        with self.assertRaises(SystemExit):
            module.judge_pin({"CORTEX_JUDGE_MODEL": "deepseek-chat extra"})


if __name__ == "__main__":
    unittest.main()
