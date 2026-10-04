#!/usr/bin/env python3
"""The dispatch scripts may only send inputs the workflow declares.

## The defect this file is written against

`tools/dispatch-cortex-memory-ab.py` carried a `cortex_memory_threshold` key that
`.github/workflows/benchmark.yml` never declared as a `workflow_dispatch` input.
The GitHub dispatch API ignores unknown keys silently: the run is accepted, the
workflow starts, the arm executes, and the artifact describes the configuration the
operator believed they dispatched rather than the one the code applied. Nothing in
the run's own output can detect that, because from the workflow's point of view
nothing was wrong -- the input simply was not there.

The mirror image is just as bad and just as silent. A workflow input with no
`INPUTS` entry and no `env:` forward is a knob the operator can set that reaches
nothing; the run completes on the default and the dispatch record says otherwise.

## Why this is a script and not a document

Both directions are decidable from two files, and the failure is invisible in the
artifact, which is the same argument `check-shell-interpolation.py` makes for
itself: a rule that is only written down is a rule that is obeyed until the next
time someone adds a knob in a hurry.

## What it deliberately does not check

Whether the values sent are the right ones. That is the pre-registration's job
(`docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md`), and asserting a specific number here
would make the test fail for a legitimate experiment rather than for a defect.
"""

from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOW = ROOT / ".github" / "workflows" / "benchmark.yml"
TOOLS = ROOT / "tools"


def declared_inputs() -> set[str]:
    """Every `workflow_dispatch` input name, in declaration order.

    Scoped to the `workflow_dispatch` block rather than scanning the whole file,
    because `env:` keys and step names are also YAML mappings and a file-wide regex
    would collect them -- and then the test would pass on a workflow where the input
    was deleted but the `env:` line remained.
    """
    source = WORKFLOW.read_text(encoding="utf-8")
    block = re.search(r"workflow_dispatch:\n(.*?)\npermissions:", source, re.S)
    if block is None:
        raise AssertionError("benchmark.yml has no workflow_dispatch block")
    return set(re.findall(r"^      ([a-z_][a-z0-9_]*):$", block.group(1), re.M))


def dispatch_inputs() -> dict[str, set[str]]:
    """Each dispatch script's input keys, read by parsing, not by importing.

    Parsed with `ast` rather than imported so a syntax error anywhere in the module
    reports as that error instead of as a missing key, and so evaluating a module
    that calls `token()` at import time does not require a `.git/config`.

    Two shapes exist and both are collected. `dispatch-cortex-memory-ab.py` holds one
    flat `INPUTS` mapping; `dispatch-b7-ab.py` splits into `ARMS` (the per-arm
    difference) and `COMMON` (what both arms hold). Reading only `INPUTS` would leave
    the newer script checked and the older one unexamined -- and the older one is
    where a stale key is just as likely, since it was written first and against a
    workflow that has since grown inputs.
    """
    found: dict[str, set[str]] = {}
    for path in sorted(TOOLS.glob("dispatch-*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        keys: set[str] = set()
        for node in tree.body:
            if not isinstance(node, ast.Assign):
                continue
            targets = [t.id for t in node.targets if isinstance(t, ast.Name)]
            if not ({"INPUTS", "COMMON", "ARMS"} & set(targets)):
                continue
            mappings = [node.value]
            if isinstance(node.value, ast.Dict):
                # `ARMS` is a mapping of mappings; its values carry the inputs.
                mappings = [
                    v
                    for v in node.value.values
                    if isinstance(v, ast.Dict)
                ] or [node.value]
            for mapping in mappings:
                for k in mapping.keys:  # type: ignore[attr-defined]
                    if isinstance(k, ast.Constant) and isinstance(k.value, str):
                        keys.add(k.value)
        found[path.name] = keys
    return found


class TestDispatchInputsAreDeclared(unittest.TestCase):
    def test_every_dispatch_script_was_found(self) -> None:
        # The control. A glob that matched nothing would make every assertion below
        # vacuously true, and the file would report success while checking nothing.
        scripts = dispatch_inputs()
        self.assertIn("dispatch-cortex-memory-ab.py", scripts)
        self.assertIn("dispatch-b7-ab.py", scripts)

    def test_every_dispatched_key_is_a_declared_workflow_input(self) -> None:
        declared = declared_inputs()
        for script, keys in dispatch_inputs().items():
            with self.subTest(script=script):
                undeclared = sorted(keys - declared)
                self.assertEqual(
                    undeclared,
                    [],
                    f"{script} sends {undeclared}, which benchmark.yml does not declare. "
                    "GitHub drops unknown dispatch inputs without an error, so the run "
                    "would silently use the default and the artifact would describe the "
                    "intended configuration rather than the applied one.",
                )

    def test_the_arm_inputs_have_an_env_forward(self) -> None:
        # Declaring an input is not the same as reaching the process. Without the
        # `env:` line the value stops at the workflow boundary, so this asserts the
        # forward exists as well -- that is the second half of the same silent gap.
        source = WORKFLOW.read_text(encoding="utf-8")
        for input_name in sorted(n for n in declared_inputs() if n.startswith("cortex")):
            with self.subTest(input_name=input_name):
                self.assertIn(
                    f"github.event.inputs.{input_name}",
                    source,
                    f"{input_name} is declared but never forwarded into a step's env, "
                    "so an operator could set it and reach nothing.",
                )

    def test_source_trust_is_dispatched_and_forwarded(self) -> None:
        # Named explicitly rather than left to the loop above. The ceiling is the
        # variable whose absence produced two runs that differed from each other by
        # nothing and could not say why -- it is the one this file's first version
        # would have caught, so it gets its own assertion and its own failure message.
        self.assertIn("cortex_memory_source_trust", declared_inputs())
        self.assertIn("cortex_memory_source_trust", dispatch_inputs()["dispatch-cortex-memory-ab.py"])
        self.assertIn(
            "CORTEX_MEMORY_SOURCE_TRUST: ${{ github.event.inputs.cortex_memory_source_trust }}",
            WORKFLOW.read_text(encoding="utf-8"),
        )


if __name__ == "__main__":
    unittest.main()
