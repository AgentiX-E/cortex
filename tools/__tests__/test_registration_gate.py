#!/usr/bin/env python3
"""The registration check has to run where the artifact is produced, or it is a tool with no caller.

## The defect this guards against

`readout-arm-run.py --registration` was built by §13.203 for one question: *is what ran the thing
this arm says it runs?* It answers it correctly, exits non-zero when the answer is no, and until
this iteration no pipeline stage ever asked. Dispatch `41431790794` is what that costs: the
dispatch carried no inputs at all, nine configuration fields fell to their defaults
(`relevanceTopK` 256 -> 64, `relevanceSignal` `retrieval-hybrid` -> `none`, `promptContract`
`abstention-evidence-blocks` -> `abstention`, `ask` `operands+operand-gap` -> `route`,
`maxTurnChars` 400 -> absent, `evidenceRolesRoutes` two routes -> six, `thinking` disabled ->
enabled on two routes, and the two `reader.thinking*` fields that follow from it), the run spent
an hour, and it read **10.8%** against the registered arm's **83.4%**. The number was momentarily
read as a catastrophic regression in the code. It was a default configuration wearing the arm's
name, and the only thing that said so had to be run by hand, afterwards, from a shell.

That is §13.216.6's shape one level up: a field with a writer and no reader. `--audit` cannot
substitute for it, because `--audit` asks whether the artifact contradicts **itself**, and a
default configuration is perfectly self-consistent.

## The four properties, none implied by the others

1. **It runs at all.** A step that exists but is commented out, or one whose path drifted from the
   tool's own default, produces nothing.
2. **It runs after the upload.** A gate that fires before the artifact is published leaves a
   red job whose measurement cannot be downloaded -- and the measurement is the reason the
   comparison is worth making.
3. **It gates.** `continue-on-error` here would reproduce the defect in its original form: the
   departure is printed into a log nobody reads while the job stays green and quotable.
4. **The declaration is a value, not a substitution.** The departure list reaches the shell
   through `env`; a `${{ }}` inside `run:` is expanded into the script text before bash parses
   it, so a list carrying a quote or a semicolon would change the program rather than the
   variable. `check-shell-interpolation.py` is the general form of that rule; this is its
   instance for the one new free-text value.

## Why source rather than behaviour

`benchmark-cortex-memory.yml` is GitHub's to execute; no unit test can run it. Reading it as YAML
is the technique `test_artifact_audit_gate.py` uses for the audit step, applied here to the
registration step.
"""

from __future__ import annotations

import unittest
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "benchmark-cortex-memory.yml"

#: The report the readout tool defaults to and the workflow produces.
REPORT = "packages/cortex-memory/benchmark-cortex-memory-ablation-report.json"

#: The repository variable an experiment sets to declare what it moved (PREREGISTRATION 13.220).
DECLARATION_VARIABLE = "CORTEX_DECLARED_DEPARTURES"


def steps() -> list[dict]:
    document = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    for job in document["jobs"].values():
        return list(job["steps"])
    raise AssertionError(f"{WORKFLOW}: it declares no jobs")


def registration_steps() -> list[dict]:
    """Every step that asks the registration question.

    Selected by the flag rather than by the step's name, because a name is a label and the flag
    is what runs: a step renamed twice is still this check, and a step named like it but reading
    `--audit` is not.
    """
    return [
        step
        for step in steps()
        if "--registration" in str(step.get("run", ""))
    ]


class TestTheCheckIsWired(unittest.TestCase):
    def test_exactly_one_step_asks_the_registration_question(self) -> None:
        found = registration_steps()
        self.assertEqual(
            len(found),
            1,
            "one step must compare the artifact against the dispatch table; zero is a tool with no "
            "caller and two is two places for the answer to disagree",
        )

    def test_it_reads_the_report_the_reader_downloads(self) -> None:
        run = str(registration_steps()[0]["run"])
        self.assertIn(REPORT, run)
        # The report is named through the same variable the audit step uses, so the path exists
        # once in the file rather than once per reader.
        self.assertIn("--registration", run)

    def test_it_runs_even_when_the_benchmark_failed(self) -> None:
        self.assertEqual(registration_steps()[0].get("if"), "always()")

    def test_it_runs_after_the_upload(self) -> None:
        order = [step.get("name", "") for step in steps()]
        upload = next(
            index for index, name in enumerate(order) if name == "Upload benchmark report"
        )
        registration = next(
            index for index, step in enumerate(steps()) if step in registration_steps()
        )
        self.assertGreater(
            registration,
            upload,
            "the gate must fire after the artifact is published: a red job whose measurement "
            "cannot be downloaded has thrown away the only thing it measured",
        )


class TestItGatesRatherThanAdvises(unittest.TestCase):
    def test_it_is_not_advisory(self) -> None:
        step = registration_steps()[0]
        self.assertFalse(
            step.get("continue-on-error", False),
            "an advisory registration check is the defect in its original form: the departure is "
            "printed while the job stays green and quotable",
        )

    def test_the_tool_exit_code_is_what_the_step_exits(self) -> None:
        run = str(registration_steps()[0]["run"])
        self.assertIn("code=$?", run)
        self.assertTrue(
            run.rstrip().endswith("exit $code"),
            "the step must exit with the tool's code, not with the code of `cat` or of the "
            "summary redirection",
        )

    def test_a_run_that_left_no_report_is_not_a_second_failure(self) -> None:
        # The audit step is the one that reports a missing report. Failing here as well would make
        # one condition red twice and leave a reader unable to tell which check spoke.
        run = str(registration_steps()[0]["run"])
        self.assertIn("exit 0", run)


class TestTheDeclarationIsAValueNotASubstitution(unittest.TestCase):
    def test_the_departure_list_arrives_through_env(self) -> None:
        step = registration_steps()[0]
        env = step.get("env") or {}
        self.assertEqual(env.get("DECLARED_DEPARTURES"), f"${{{{ vars.{DECLARATION_VARIABLE} }}}}")

    def test_the_run_body_interpolates_nothing(self) -> None:
        run = str(registration_steps()[0]["run"])
        self.assertNotIn(
            "${{",
            run,
            "a `${{ }}` inside `run:` is expanded into the script text before bash parses it, so a "
            "value carrying a quote or a semicolon changes the program instead of the variable",
        )

    def test_the_list_is_passed_through_rather_than_defaulted_here(self) -> None:
        # An empty value is the strict default -- "this run claims to be the registration" -- and
        # a second copy of that default in the shell is how the two would drift.
        run = str(registration_steps()[0]["run"])
        self.assertIn('--departs "$DECLARED_DEPARTURES"', run)


class TestTheVerdictReachesTheReader(unittest.TestCase):
    def test_the_step_writes_a_summary(self) -> None:
        run = str(registration_steps()[0]["run"])
        self.assertIn("$GITHUB_STEP_SUMMARY", run)

    def test_both_verdicts_are_named(self) -> None:
        run = str(registration_steps()[0]["run"])
        self.assertIn("match", run)
        self.assertIn("DEPARTED", run)


if __name__ == "__main__":
    unittest.main()
