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

## Why each script is pinned to one workflow

The check is per-workflow, because GitHub's rule is per-workflow: a key sent by
script A but declared only by workflow B is dropped silently, exactly as an
undeclared key is. Scanning the union of every workflow would answer "this name
exists somewhere", which is not the property the API enforces.

The mapping became necessary when the cortex-memory arm's inputs moved to
`benchmark-cortex-memory.yml`. `workflow_dispatch` accepts at most **25 inputs per
workflow**, and `benchmark.yml` reached 26 once §13.17 registered the relevance
signal and the width it is built at. The dispatch was rejected with

    422 Invalid Argument - failed to parse workflow: you may only define up to 25
    `inputs` for a `workflow_dispatch` event

while every layer beneath the registration tested green -- the arm option, the
artifact field, the `env:` forward and the dispatch script's value. That is the
defect this file guards, one level up: the artifact would have described a
configuration no run ever applied, because there was no run.
"""

from __future__ import annotations

import ast
import re
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
TOOLS = ROOT / "tools"

# Which workflow declares the inputs each dispatch script sends. Written out rather
# than derived, because a convention that guessed wrong would silently check a script
# against a file that has nothing to do with it.
SCRIPT_WORKFLOW = {
    "dispatch-b7-ab.py": "benchmark.yml",
    "dispatch-cortex-memory-ab.py": "benchmark-cortex-memory.yml",
}


def declared_inputs(workflow: str) -> set[str]:
    """Every `workflow_dispatch` input name in `workflow`, in declaration order.

    Scoped to the `workflow_dispatch` block rather than scanning the whole file,
    because `env:` keys and step names are also YAML mappings and a file-wide regex
    would collect them -- and then the test would pass on a workflow where the input
    was deleted but the `env:` line remained.
    """
    source = (WORKFLOWS / workflow).read_text(encoding="utf-8")
    block = re.search(r"workflow_dispatch:\n(.*?)\npermissions:", source, re.S)
    if block is None:
        raise AssertionError(f"{workflow} has no workflow_dispatch block")
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
                    v for v in node.value.values if isinstance(v, ast.Dict)
                ] or [node.value]
            for mapping in mappings:
                for k in mapping.keys:  # type: ignore[attr-defined]
                    if isinstance(k, ast.Constant) and isinstance(k.value, str):
                        keys.add(k.value)
        found[path.name] = keys
    return found


class TestDispatchInputsAreDeclared(unittest.TestCase):
    def test_every_dispatch_script_was_found_and_mapped(self) -> None:
        # The control, in both directions. A glob that matched nothing would make
        # every assertion below vacuously true, and a script the glob found but the
        # mapping does not name would otherwise be skipped silently -- which is how a
        # new dispatch script would ship unchecked.
        self.assertEqual(
            sorted(dispatch_inputs()),
            sorted(SCRIPT_WORKFLOW),
            "every dispatch script must be pinned to the workflow that declares its "
            "inputs; an unmapped script is a script nothing below checks",
        )

    def test_every_mapped_workflow_exists(self) -> None:
        # A mapping to a path that does not exist raises inside `declared_inputs`,
        # which would read as a workflow problem rather than as a typo here.
        for workflow in sorted(set(SCRIPT_WORKFLOW.values())):
            with self.subTest(workflow=workflow):
                self.assertTrue((WORKFLOWS / workflow).is_file(), f"{workflow} is missing")

    def test_every_dispatched_key_is_a_declared_workflow_input(self) -> None:
        for script, keys in sorted(dispatch_inputs().items()):
            workflow = SCRIPT_WORKFLOW[script]
            declared = declared_inputs(workflow)
            with self.subTest(script=script):
                undeclared = sorted(keys - declared)
                self.assertEqual(
                    undeclared,
                    [],
                    f"{script} sends {undeclared}, which {workflow} does not declare. "
                    "GitHub drops unknown dispatch inputs without an error, so the run "
                    "would silently use the default and the artifact would describe the "
                    "intended configuration rather than the applied one.",
                )

    def test_the_arm_inputs_have_an_env_forward(self) -> None:
        # Declaring an input is not the same as reaching the process. Without the
        # `env:` line the value stops at the workflow boundary, so this asserts the
        # forward exists as well -- that is the second half of the same silent gap.
        #
        # Checked in every mapped workflow rather than in one, so an input declared by
        # `benchmark-cortex-memory.yml` is held to the same rule as one declared by
        # `benchmark.yml`.
        for workflow in sorted(set(SCRIPT_WORKFLOW.values())):
            source = (WORKFLOWS / workflow).read_text(encoding="utf-8")
            declared = sorted(n for n in declared_inputs(workflow) if n.startswith("cortex"))
            for input_name in declared:
                with self.subTest(workflow=workflow, input_name=input_name):
                    self.assertIn(
                        f"github.event.inputs.{input_name}",
                        source,
                        f"{input_name} is declared in {workflow} but never forwarded "
                        "into a step's env, so an operator could set it and reach "
                        "nothing.",
                    )

    def test_source_trust_is_dispatched_and_forwarded(self) -> None:
        # Named explicitly rather than left to the loop above. The ceiling is the
        # variable whose absence produced two runs that differed from each other by
        # nothing and could not say why -- it is the one this file's first version
        # would have caught, so it gets its own assertion and its own failure message.
        workflow = SCRIPT_WORKFLOW["dispatch-cortex-memory-ab.py"]
        self.assertIn("cortex_memory_source_trust", declared_inputs(workflow))
        self.assertIn(
            "cortex_memory_source_trust", dispatch_inputs()["dispatch-cortex-memory-ab.py"]
        )
        self.assertIn(
            "CORTEX_MEMORY_SOURCE_TRUST: ${{ github.event.inputs.cortex_memory_source_trust }}",
            (WORKFLOWS / workflow).read_text(encoding="utf-8"),
        )

    def test_every_mapped_workflow_is_tracked_by_git(self) -> None:
        """A workflow that exists on disk but is not in the repository is not run.

        `benchmark-cortex-memory.yml` was written, checked by every test in this file, and
        pointed at by the dispatch script -- and `git add -A` staged nothing, because
        `.gitignore`'s `benchmark-*` glob (written to ignore **artifacts**) matched a
        workflow whose name begins the same way. The file existed for every assertion above
        and for no dispatch, which is this file's own failure mode one remove out: the
        configuration was right and the thing that carries it was absent.

        So the check is not "the path is a file" -- that was already true -- but "git knows
        about it", which is the property a dispatch actually depends on.
        """
        for workflow in sorted(set(SCRIPT_WORKFLOW.values())):
            with self.subTest(workflow=workflow):
                tracked = subprocess.run(
                    ["git", "ls-files", "--error-unmatch", f".github/workflows/{workflow}"],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                )
                self.assertEqual(
                    tracked.returncode,
                    0,
                    f".github/workflows/{workflow} is not tracked by git, so no dispatch can "
                    "reach it. Check .gitignore for a rule that matches its name.",
                )

    def test_no_workflow_sits_at_the_input_ceiling(self) -> None:
        """No `workflow_dispatch` may hold the full 25 inputs GitHub accepts.

        The ceiling is why this file gained a per-workflow mapping at all, and the
        failure it produces is a `422` at dispatch time rather than a red test -- so it
        is exactly the kind of limit that belongs in a test. A workflow sitting at the
        maximum is one input away from being un-dispatchable and the next registration
        will add one; a margin is the difference between an experiment that can be
        registered and one that has to be planned around a plumbing constraint.
        """
        for workflow in sorted(p.name for p in WORKFLOWS.glob("*.yml")):
            with self.subTest(workflow=workflow):
                count = len(declared_inputs(workflow))
                self.assertLess(
                    count,
                    25,
                    f"{workflow} declares {count} inputs, at or over GitHub's limit of 25 "
                    "per workflow_dispatch. The next registration could not be "
                    "dispatched; split the workflow rather than removing a knob.",
                )


if __name__ == "__main__":
    unittest.main()
