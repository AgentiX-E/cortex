#!/usr/bin/env python3
"""A dispatch that has already departed from the registration must not spend 87 minutes.

## The defect this file is written against

`41751619617` was dispatched with a budget map filled in and the rest of the input surface
left blank. The workflow forwards those blanks on purpose -- the product's default lives in
exactly one place -- so the run became the **product's** configuration, not the registered
one, and it cost 87 minutes and a 500-question artifact to say so. The registration gate
caught it at 02:32 and said the clearest thing it has: *"the run is an experiment that has
not said so"*. It was right and it was 87 minutes late.

Six fields reached the artifact (`ask`, `relevance`, `promptContract`, `maxTurnChars`,
`maxTurnCharsRoutes`, `evidenceRolesRoutes`); fifteen left the dispatcher, because the
artifact comparison derives three of its fields from other fields and treats three more as
harness properties. The input-layer count is the one that matters here: this gate is asking
what was *asked for*, and every blank is a question nobody asked.

## What is asserted, and why each case is separate

| case | asked | registered | expected |
| --- | --- | --- | --- |
| the arm | every key | same | pass |
| one blank | `ask` absent | `verbatim` | fail, `ABSENT` |
| one empty | `ask` = `""` | `verbatim` | fail, `ABSENT` |
| one moved | `limit` = `60` | `0` | fail, `DEPARTED` |
| declared | the same departures | same | pass |
| declared idle | a key that did not move | same | pass, with a note |
| no payload | nothing to read | same | fail |

The `limit` case is the one an environment read cannot see: the workflow writes
`${{ inputs.limit || '60' }}`, so a dispatch that never asked for `limit` runs 60 questions
and the environment says `60` -- a value, and a plausible one. Only the payload knows that
nobody asked.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]
PREFLIGHT = TOOLS / "registration-preflight.py"
DISPATCH = TOOLS / "dispatch-cortex-memory-ab.py"


def load(path: Path, name: str):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class PreflightTest(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load(PREFLIGHT, "dispatch_registration_preflight")
        self.registered = self.module.registration(DISPATCH)

    def run_preflight(self, inputs: dict[str, str], declared: str | None = None):
        """Dispatch a payload at the gate and return its exit code and stdout.

        The payload is written rather than passed so that the test exercises the same read
        the runner does. A test that called `departures()` directly would pass while the
        file-reading path stayed broken.
        """
        payload = json.dumps({"inputs": inputs})
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "event.json"
            path.write_text(payload)
            argv = [sys.executable, str(PREFLIGHT), "--event", str(path)]
            if declared is not None:
                argv += ["--declared", declared]
            done = subprocess.run(argv, capture_output=True, text=True, check=False)
        return done.returncode, done.stdout

    def test_the_registered_arm_passes(self) -> None:
        code, out = self.run_preflight(dict(self.registered))
        self.assertEqual(code, 0, out)
        self.assertIn("this dispatch is the registered configuration", out)

    def test_a_blank_input_is_a_departure(self) -> None:
        inputs = dict(self.registered)
        del inputs["cortex_memory_ask"]
        code, out = self.run_preflight(inputs)
        self.assertEqual(code, 1)
        self.assertIn('ABSENT    cortex_memory_ask: registered "verbatim"', out)

    def test_an_empty_input_is_a_departure(self) -> None:
        """The shape a client produces when it forwards an unfilled input.

        It is the same state as absent, and the gate must not treat the difference between
        the two as a difference between a legitimate and an illegitimate dispatch.
        """
        inputs = dict(self.registered)
        inputs["cortex_memory_ask"] = ""
        code, out = self.run_preflight(inputs)
        self.assertEqual(code, 1)
        self.assertIn("ABSENT    cortex_memory_ask", out)

    def test_a_moved_input_is_reported_with_both_values(self) -> None:
        inputs = dict(self.registered)
        inputs["limit"] = "60"
        code, out = self.run_preflight(inputs)
        self.assertEqual(code, 1)
        self.assertIn('DEPARTED  limit: "0" (registered) -> "60" (asked)', out)

    def test_declaring_every_departure_lets_it_through(self) -> None:
        inputs = dict(self.registered)
        inputs["cortex_memory_max_prompt_chars"] = "multi-session:55000,flat:36200"
        code, out = self.run_preflight(inputs, declared="cortex_memory_max_prompt_chars")
        self.assertEqual(code, 0, out)
        self.assertIn("1 declared departure(s), nothing undeclared", out)

    def test_declaring_a_key_that_did_not_move_is_reported_and_passes(self) -> None:
        """`41751619617` declared `relevance_top_k` and sent the registered value.

        The gate must say so rather than staying silent, because a declaration that describes
        an intention is a record nobody can audit -- but it must also not fail, because the
        dispatch itself is legal and the note is the repair.
        """
        code, out = self.run_preflight(
            dict(self.registered), declared="cortex_memory_relevance_top_k"
        )
        self.assertEqual(code, 0, out)
        self.assertIn("declared but unchanged: cortex_memory_relevance_top_k", out)

    def test_the_declared_list_accepts_both_shapes_it_has_carried(self) -> None:
        """The variable has been a JSON array and a comma separated list.

        Refusing one would make the gate's own input the reason a run failed, which is a
        different defect from the one it exists to catch.
        """
        self.assertEqual(self.module.parse_declared('["a", "b"]'), ["a", "b"])
        self.assertEqual(self.module.parse_declared("a,b"), ["a", "b"])
        self.assertEqual(self.module.parse_declared(""), [])
        self.assertEqual(self.module.parse_declared(None), [])

    def test_no_payload_fails_rather_than_passing(self) -> None:
        """A gate that cannot see the dispatch must not certify it.

        The failure mode this rules out is the one every gate in this repository is written
        against: a missing input read as agreement, so the check passes by knowing nothing.
        """
        done = subprocess.run(
            [sys.executable, str(PREFLIGHT)],
            capture_output=True,
            text=True,
            check=False,
            env={"PATH": "/usr/bin:/bin"},
        )
        self.assertEqual(done.returncode, 1)
        self.assertIn("no event payload", done.stderr)

    def test_the_shipped_shape_of_the_incident_is_refused(self) -> None:
        """The exact input set `41751619617` was dispatched with.

        This is the regression test proper: the eight keys below are what the dispatch sent,
        and the gate must refuse it on the six fields the artifact later reported, plus the
        nine it could not report because they are derived or harness-owned.
        """
        incident = {
            "ablation_runs": "4",
            "cortex_memory": "1",
            "cortex_memory_max_prompt_chars": "multi-session:55000,flat:36200",
            "cortex_memory_relevance_top_k": "256",
            "limit": "0",
            "model": "deepseek-chat",
            "temperature": "0",
            "thinking": "multi-session+temporal",
        }
        code, out = self.run_preflight(incident, declared="cortex_memory_relevance_top_k")
        self.assertEqual(code, 1)
        self.assertIn("15 departed", out)
        for name in (
            "cortex_memory_ask",
            "cortex_memory_relevance",
            "cortex_memory_prompt_contract",
            "cortex_memory_max_turn_chars",
            "cortex_memory_max_turn_chars_routes",
            "cortex_memory_evidence_roles_routes",
        ):
            self.assertIn(name, out)


if __name__ == "__main__":
    unittest.main()
