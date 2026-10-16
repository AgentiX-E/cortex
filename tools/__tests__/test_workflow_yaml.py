#!/usr/bin/env python3
"""Every workflow a dispatch script posts to must be a workflow GitHub can read.

## The defect this file is written against

On 2026-10-16 a one-character defect in a workflow's `description` string -- an apostrophe
inside a single-quoted YAML scalar -- made `benchmark-cortex-memory.yml` unparseable. The
push went through, `pnpm check` stayed green, the pre-registration guard stayed green, and
**the dispatch was refused**:

    POST /actions/workflows/benchmark-cortex-memory.yml/dispatches -> 422
    {"message": "Workflow does not have 'workflow_dispatch' trigger"}

That message is the misleading part, and it is why this is a guard rather than a note. The
trigger was there; the file could not be read, so as far as GitHub was concerned there was
no workflow at all. Every existing check passed:

| Check | Why it passed |
| --- | --- |
| `pnpm check` | reads TypeScript and Markdown, never the workflow |
| `test_preregistration_config.py` | greps the YAML as text, and a text grep cannot see a quoting error |
| `test_dispatch_inputs.py` | greps for input names and `env:` forwards, which were all present |

So the only thing that noticed was the dispatch itself, **after** the commit was pushed --
and the artifact of that failure was a run with **zero jobs**, which is also what a
cancelled run looks like.

## What is checked

1. Every `.github/workflows/*.yml` parses as YAML.
2. Every workflow a `tools/dispatch-*.py` posts to declares `workflow_dispatch`.

The second is not implied by the first: a valid workflow without the trigger parses
perfectly and produces the same 422 with the same wording.
"""

from __future__ import annotations

import ast
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"

try:
    import yaml
except ImportError as error:  # pragma: no cover - a missing dependency is the failure
    raise AssertionError(
        "PyYAML is required by this guard. A skip here would let the defect it exists for "
        "through, which is the failure mode every control in this directory guards against."
    ) from error


def dispatch_targets() -> dict[str, Path]:
    """`{workflow file name: dispatch script}` for every script that names one.

    Parsed with `ast` rather than imported, for the reason `test_preregistration_config.py`
    gives: importing a dispatch script runs `token()` at import time and would require a
    `.git/config`.
    """
    targets: dict[str, Path] = {}
    for script in sorted((ROOT / "tools").glob("dispatch-*.py")):
        tree = ast.parse(script.read_text(encoding="utf-8"), filename=str(script))
        for node in tree.body:
            if not isinstance(node, ast.Assign):
                continue
            if [t.id for t in node.targets if isinstance(t, ast.Name)] != ["WORKFLOW"]:
                continue
            if isinstance(node.value, ast.Constant) and isinstance(node.value.value, str):
                targets[node.value.value] = script
    return targets


class TestEveryWorkflowCanBeDispatched(unittest.TestCase):
    def test_every_workflow_parses(self) -> None:
        files = sorted(WORKFLOWS.glob("*.yml"))
        # The control. A glob that matched nothing would make the loop below vacuous,
        # and this file would report success while reading no workflow at all.
        self.assertGreaterEqual(len(files), 3, f"expected the workflows to be found; saw {files}")
        for path in files:
            with self.subTest(workflow=path.name):
                try:
                    yaml.safe_load(path.read_text(encoding="utf-8"))
                except yaml.YAMLError as error:
                    self.fail(
                        f"{path.name} is not valid YAML, so GitHub registers no workflow for it "
                        f"and every dispatch to it is refused with 'does not have "
                        f"workflow_dispatch trigger'. {error}"
                    )

    def test_every_dispatch_target_declares_the_trigger(self) -> None:
        targets = dispatch_targets()
        self.assertGreaterEqual(
            len(targets), 2, f"expected the dispatch scripts to name workflows; saw {targets}"
        )
        for name, script in targets.items():
            with self.subTest(workflow=name):
                path = WORKFLOWS / name
                self.assertTrue(path.exists(), f"{script.name} posts to {name}, which does not exist")
                document = yaml.safe_load(path.read_text(encoding="utf-8"))
                # `on` is a YAML boolean key, so the mapping arrives as `{True: ...}`.
                triggers = document.get("on", document.get(True))
                self.assertIsInstance(triggers, dict, f"{name} has no `on:` mapping")
                self.assertIn("workflow_dispatch", triggers, f"{name} cannot be dispatched")
