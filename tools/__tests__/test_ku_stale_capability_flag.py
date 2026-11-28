#!/usr/bin/env python3
"""A `--capability` flag whose value is another flag must be refused, not swallowed.

## The defect this file is written against

`ku-stale-census.mjs` parsed `--capability` with `capability = argv[index + 1]; index += 1`. A trailing
flag passed `undefined`, which the `census(report, capability = DEFAULT_CAPABILITY)` default parameter
turned back into `KU` — silent, but at least the documented default. A flag followed by another flag
(e.g. `--capability --json`) swallowed `--json` as the capability name: `census` filtered to zero rows
and the tool printed `capability --json: 0 right, 0 wrong of 0` with exit 0. A reader who asked for a
capability-scoped census got an empty one that looked like a legitimate result.

## What is asserted

1. a `--capability` immediately followed by another flag is refused with a non-zero exit that names
   the missing argument;
2. a valid capability still runs, so the refusal is specific to a missing/flag value.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "ku-stale-census.mjs"


def _report() -> dict:
    return {
        "questions": [
            {"questionId": "q1", "capability": "KU", "groundTruth": "4", "answer": "4"},
        ]
    }


def _run(*tail: str) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "report.json"
        path.write_text(json.dumps(_report()))
        return subprocess.run(
            ["node", str(TOOL), str(path), *tail],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
        )


def test_capability_flag_before_another_flag_is_refused() -> None:
    result = _run("--capability", "--json")
    assert result.returncode != 0, "another flag must not be swallowed as the capability NAME"
    assert "capability" in result.stderr.lower(), result.stderr
    assert "refus" in result.stderr.lower() or "usage" in result.stderr.lower(), result.stderr


def test_trailing_capability_flag_is_refused() -> None:
    result = _run("--capability")
    assert result.returncode != 0, "a missing capability NAME must not exit green"
    assert "capability" in result.stderr.lower(), result.stderr


def test_valid_capability_still_runs() -> None:
    result = _run("--capability", "KU")
    assert result.returncode == 0, result.stderr
    assert "capability KU" in result.stdout, result.stdout
