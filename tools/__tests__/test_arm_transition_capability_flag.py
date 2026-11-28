#!/usr/bin/env python3
"""A `--capability` flag whose value is missing or another flag must be refused.

## The defect this file is written against

`arm-transition.mjs` parsed `--capability` with `flag(argv, '--capability')`, which returns
`argv[index + 1]` with no check. A trailing flag passed `undefined`, silently reproducing the
documented `MR` default — the caller cannot tell its explicit request was discarded. A flag followed
by another flag (e.g. `--capability --json`) swallowed `--json` as the capability, and
`transitionOf(before, after, { capability: '--json' })` produced a reading with zero applicable rows.
Both exited 0 with no warning.

## What is asserted

1. a trailing `--capability` is refused with a non-zero exit that names the missing argument;
2. a `--capability` followed by another flag is refused for the same reason;
3. omitting the flag entirely still runs (the documented `MR` default is intact).
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "arm-transition.mjs"


def _report() -> dict:
    return {"questions": [], "ablation": {"featureCorrectByRun": []}}


def _run(*tail: str) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as tmp:
        before = pathlib.Path(tmp) / "before.json"
        after = pathlib.Path(tmp) / "after.json"
        before.write_text(json.dumps(_report()))
        after.write_text(json.dumps(_report()))
        return subprocess.run(
            ["node", str(TOOL), "--before", str(before), "--after", str(after), *tail],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
        )


def test_trailing_capability_flag_is_refused() -> None:
    result = _run("--capability")
    assert result.returncode != 0, "a missing capability NAME must not exit green"
    assert "capability" in result.stderr.lower(), result.stderr


def test_capability_flag_before_another_flag_is_refused() -> None:
    result = _run("--capability", "--json")
    assert result.returncode != 0, "another flag must not be swallowed as the capability NAME"
    assert "capability" in result.stderr.lower(), result.stderr


def test_omitting_capability_keeps_the_documented_default() -> None:
    result = _run()
    assert result.returncode in (0, 1), "the defaulted reading must still run"
    assert "capability MR" in result.stdout, result.stdout
