#!/usr/bin/env python3
"""The gate that reads the copy that actually runs.

## Why this file exists

`tools/arm-config-record.py --check` compares the baseline against the dispatch table and against
`docs/PREREGISTRATION-...` §10.3, and it was green while `semantic-carry.yml` sent `temporal: 48000`,
`relevance: retrieval-anchored` and `thinking: disabled` against a registration of `24000`,
`self-index` and `multi-session+temporal`. Its published reading (87.00%) was therefore taken on an
arm with three undeclared departures, and no check in the repository read a workflow.

`tools/arm-config-guard.mjs` reads them. These tests pin the guard, and the ones that matter are the
failure tests: a comparison that silently compares nothing looks exactly like a passing one, which is
the sentence `test_arm_config_baseline.py` was written after, four defects ago.

## Why the fixtures are temp directories

The green state is not what needs proving — it is what has been wrong every time. Each test writes the
smallest workflow that exhibits one defect and asserts on the message, so a guard that stops biting is
a red test rather than a green run nobody re-reads.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
GUARD = ROOT / "tools" / "arm-config-guard.mjs"
BASELINE = ROOT / "tools" / "arm-config-baseline.json"

DISPATCH = {
    "ablation_runs": "4",
    "cortex_memory_ask": "verbatim-acts",
    "cortex_memory_max_prompt_chars": "abstention:24000,multi-session:48460,temporal:24000",
    "cortex_memory_rerank": "none",
    "model": "deepseek-chat",
    "thinking": "multi-session+temporal",
}


def run(workflows: Path, baseline: Path = BASELINE) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["node", str(GUARD), "--workflows", str(workflows), "--baseline", str(baseline)],
        capture_output=True,
        text=True,
        check=False,
    )


class Fixture:
    """One temporary workflows directory and the baseline it is compared against."""

    def __init__(self, dispatch: dict | None = None) -> None:
        self._dir = tempfile.TemporaryDirectory()
        self.root = Path(self._dir.name)
        self.workflows = self.root / "workflows"
        self.workflows.mkdir()
        self.baseline = self.root / "baseline.json"
        self.baseline.write_text(
            json.dumps(
                {
                    "adoptedBy": "999",
                    "run": "1",
                    "dispatch": dict(DISPATCH if dispatch is None else dispatch),
                }
            ),
            encoding="utf-8",
        )

    def write(self, name: str, body: str) -> Path:
        path = self.workflows / name
        path.write_text(body, encoding="utf-8")
        return path

    def run(self) -> subprocess.CompletedProcess:
        return run(self.workflows, self.baseline)

    def __enter__(self) -> "Fixture":
        return self

    def __exit__(self, *exc: object) -> None:
        self._dir.cleanup()


def job(*lines: str) -> str:
    """A workflow whose `env:` block is the lines given."""
    return "on: workflow_dispatch\njobs:\n  run:\n    steps:\n      - name: arm\n        env:\n" + "".join(
        f"          {line}\n" for line in lines
    )


class TheGuardReadsEveryWorkflow(unittest.TestCase):
    def test_a_workflow_that_spells_the_registration_passes(self) -> None:
        with Fixture() as fixture:
            fixture.write("ok.yml", job("CORTEX_MEMORY_ASK: verbatim-acts", "CORTEX_MEMORY_RERANK: none"))
            result = fixture.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("1 workflows agree", result.stdout)

    def test_a_literal_that_disagrees_is_named_with_its_line(self) -> None:
        with Fixture() as fixture:
            fixture.write("drift.yml", job("CORTEX_MEMORY_RERANK: bm25"))
            result = fixture.run()
        self.assertEqual(result.returncode, 1)
        self.assertIn("drift.yml", result.stderr)
        self.assertIn("CORTEX_MEMORY_RERANK", result.stderr)
        self.assertIn('"bm25"', result.stderr)
        self.assertIn('"none"', result.stderr)

    def test_a_room_map_is_compared_as_the_dispatch_spells_it(self) -> None:
        # The value that was actually wrong in the wild: one route at 48000 against a registration of
        # 24000. A whole-string comparison would catch it; a per-route one is what the message must name.
        with Fixture() as fixture:
            fixture.write(
                "rooms.yml",
                job(
                    "CORTEX_MEMORY_MAX_PROMPT_CHARS: "
                    "'abstention:24000,multi-session:48460,temporal:48000'"
                ),
            )
            result = fixture.run()
        self.assertEqual(result.returncode, 1)
        self.assertIn("temporal:48000", result.stderr)

    def test_a_stale_fallback_beside_a_right_default_is_still_a_defect(self) -> None:
        # `${{ inputs.thinking || 'disabled' }}` with `default: 'multi-session+temporal'` reads correctly
        # through the input and wrongly when the input is cleared. Both halves are checked because the
        # cleared dispatch is the one nobody re-reads.
        body = (
            "on:\n"
            "  workflow_dispatch:\n"
            "    inputs:\n"
            "      thinking:\n"
            "        default: 'multi-session+temporal'\n"
            "jobs:\n"
            "  run:\n"
            "    steps:\n"
            "      - env:\n"
            "          CORTEX_MEMORY_ASK: verbatim-acts\n"
            "          DEEPSEEK_THINKING: ${{ inputs.thinking || 'disabled' }}\n"
        )
        with Fixture() as fixture:
            fixture.write("fallback.yml", body)
            result = fixture.run()
        self.assertEqual(result.returncode, 1)
        self.assertIn("disabled", result.stderr)

    def test_a_wrong_default_is_a_defect_even_when_the_expression_is_bare(self) -> None:
        body = (
            "on:\n"
            "  workflow_dispatch:\n"
            "    inputs:\n"
            "      ask:\n"
            "        default: ''\n"
            "jobs:\n"
            "  run:\n"
            "    steps:\n"
            "      - env:\n"
            "          CORTEX_MEMORY_ASK: ${{ inputs.ask }}\n"
        )
        with Fixture() as fixture:
            fixture.write("default.yml", body)
            result = fixture.run()
        self.assertEqual(result.returncode, 1)
        # The empty default is what fifteen inputs in `benchmark-cortex-memory.yml` carried: the value is
        # whatever the arm's own code defaults to, which is a third copy no gate was reading.
        self.assertIn('declared default ""', result.stderr)

    def test_an_unreadable_expression_fails_closed(self) -> None:
        with Fixture() as fixture:
            fixture.write("expr.yml", job("CORTEX_MEMORY_ASK: ${{ env.SOMETHING }}"))
            result = fixture.run()
        self.assertEqual(result.returncode, 1)
        self.assertIn("cannot reduce", result.stderr)


class DeparturesHaveToBeWrittenDown(unittest.TestCase):
    def test_a_declared_departure_is_exempt_and_printed(self) -> None:
        with Fixture() as fixture:
            fixture.write(
                "exempt.yml",
                job(
                    "# arm-config: CORTEX_MEMORY_ASK departs — this is the control arm's ask",
                    "CORTEX_MEMORY_ASK: route",
                ),
            )
            result = fixture.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("exempt.yml", result.stdout)
        self.assertIn("the control arm's ask", result.stdout)

    def test_an_exemption_that_names_another_variable_is_a_defect(self) -> None:
        # Otherwise the comment licenses every value the file will ever hold, which is the shape a
        # silently-widening exemption always takes.
        with Fixture() as fixture:
            fixture.write(
                "wrong-name.yml",
                job(
                    "# arm-config: CORTEX_MEMORY_RERANK departs — copied from another line",
                    "CORTEX_MEMORY_ASK: route",
                ),
            )
            result = fixture.run()
        self.assertEqual(result.returncode, 1)
        self.assertIn("different variable", result.stderr)

    def test_a_file_level_departure_exempts_the_file_and_says_so(self) -> None:
        # `restore-counterfactual.yml`'s shape: it replays an archived configuration, so every value is
        # historical by design. Five line exemptions would restate the purpose five times.
        body = (
            "# arm-config: file departs — replays an archived configuration\n"
            + job("CORTEX_MEMORY_ASK: verbatim", "CORTEX_MEMORY_RERANK: bm25")
        )
        with Fixture() as fixture:
            fixture.write("replay.yml", body)
            result = fixture.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("departs as a file", result.stdout)


class ScopeIsTheMemoryArm(unittest.TestCase):
    def test_a_workflow_without_a_memory_variable_is_not_read(self) -> None:
        # `benchmark.yml` is the natural-language pipeline: it sets `DEEPSEEK_*` and no `CORTEX_MEMORY_*`,
        # and the registry is not a claim about its reader. Reporting it would be a red build nobody can
        # fix without deleting a real check.
        with Fixture() as fixture:
            fixture.write("nl.yml", job("DEEPSEEK_THINKING: disabled"))
            result = fixture.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("0 workflows agree", result.stdout)


class TheRepositoryAgreesWithItsOwnRegistration(unittest.TestCase):
    def test_the_checked_in_workflows_pass_their_own_gate(self) -> None:
        # The assertion the campaign needs: the tree that ships is a tree whose dispatches send the arm
        # the baseline records. A failure here is a workflow edited without an adoption.
        result = subprocess.run(
            ["node", str(GUARD)], capture_output=True, text=True, check=False, cwd=ROOT
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("agree with the registration", result.stdout)


class TheBaselineIsRequired(unittest.TestCase):
    def test_a_baseline_without_a_dispatch_block_is_refused(self) -> None:
        with Fixture() as fixture:
            fixture.baseline.write_text("{}", encoding="utf-8")
            result = fixture.run()
        self.assertEqual(result.returncode, 1)
        self.assertIn("dispatch", result.stderr)

    def test_an_unreadable_baseline_is_refused(self) -> None:
        with Fixture() as fixture:
            fixture.baseline.write_text("not json", encoding="utf-8")
            result = fixture.run()
        self.assertEqual(result.returncode, 1)
        self.assertIn("cannot be read", result.stderr)


if __name__ == "__main__":
    unittest.main()
