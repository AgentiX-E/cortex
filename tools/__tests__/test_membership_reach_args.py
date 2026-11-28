#!/usr/bin/env python3
"""A `--capability` flag with no NAME is a usage error, not a request for all capabilities.

## The defect this file is written against

`membership-reach.mjs` parsed the flag as `capability = argv[i + 1]; i += 1`. When the flag was the
last token, the value was `undefined`; when followed by another flag, that flag's name became the
value. Both fell into `censusOf(report, capability, ...)`, where an undefined capability means "every
question". The tool then printed a plausible full-population reach with exit code 0. A scoped read
whose scope silently disappeared is not the read the caller asked for.

## What is asserted

1. a trailing `--capability` is refused with a non-zero exit and names the missing argument;
2. a `--capability` immediately followed by another flag is refused for the same reason;
3. a valid scoped read still runs, so the refusal is specific to a missing value.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "membership-reach.mjs"


def _report() -> dict:
    return {
        "population": [],
        "failures": [],
        "rows": [],
        "questions": [
            {"questionId": "q1", "capability": "MR", "correct": True, "rawOutput": "4"}
        ],
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


def test_trailing_capability_flag_is_refused() -> None:
    result = _run("--capability")
    assert result.returncode != 0, "a missing capability NAME must not exit green"
    assert "capability" in result.stderr.lower(), result.stderr
    assert "refus" in result.stderr.lower(), result.stderr


def test_capability_flag_before_another_flag_is_refused() -> None:
    result = _run("--capability", "--json")
    assert result.returncode != 0, "another flag must not be swallowed as the capability NAME"
    assert "capability" in result.stderr.lower(), result.stderr
    assert "refus" in result.stderr.lower(), result.stderr


def test_valid_capability_still_runs() -> None:
    result = _run("--capability", "MR", "--json")
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert "summary" in payload
