#!/usr/bin/env python3
"""A `--capability` flag with no NAME is a usage error, not a request for all capabilities.

## The defect this file is written against

`paired-delta-census.mjs` parsed the flag as `capability = argv[(index += 1)]`. When the flag was the
last token, `argv[index + 1]` was `undefined`; when it was followed by another flag, that flag's name
became the value. Both cases fell through to `index(report, ..., undefined, ...)`, which treats an
undefined scope as "every capability". A caller who asked for a scoped read silently received a
whole-population read, with exit code 0 and no warning in stderr -- indistinguishable from a correct
run. A census whose scope vanished without being reported is a different claim from the one requested.

## What is asserted

1. a trailing `--capability` is refused with a non-zero exit and names the missing argument;
2. a `--capability` immediately followed by another flag is refused for the same reason (the flag
   must not be swallowed as the capability name);
3. a valid scoped read still runs, so the refusal is specific to a missing value and not to the flag.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "paired-delta-census.mjs"


def _report(correct: bool) -> dict:
    return {
        "dataset": "fixture",
        "questionCount": 1,
        "questions": [
            {
                "questionId": "q1",
                "capability": "MR",
                "correct": correct,
                "rawOutput": "4",
                "question": "how many items did I buy",
            }
        ],
    }


def _run(*tail: str) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as tmp:
        control = pathlib.Path(tmp) / "control.json"
        treatment = pathlib.Path(tmp) / "treatment.json"
        control.write_text(json.dumps(_report(True)))
        treatment.write_text(json.dumps(_report(False)))
        return subprocess.run(
            ["node", str(TOOL), str(control), str(treatment), *tail],
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
    assert "byCapability" in payload
    assert "MR" in payload["byCapability"]
