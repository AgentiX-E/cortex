#!/usr/bin/env python3
"""A persisted `null` in `cohortCoverage.present` must not crash the identity audit.

## The defect this file is written against

`audit-discordant-identity.py` did `coverage = data.get("cohortCoverage", {})` then
`if "6456829e_abs" in coverage.get("present", [])`. A report carrying `"present": null` — the
persisted form of a missing count — raised `TypeError: argument of type 'NoneType' is not iterable`.
The try/except in `collect` covers only JSON loading, so the exception escaped the main loop and
failed the whole audit. This is the same null-coalescing shape already fixed in
`benchmark-summary.py`: a `null` where a list belongs must degrade to "unreadable", not crash.

## What is asserted

1. `present: null` does not raise and the audit still prints its block-verification summary;
2. a well-formed `present` list still registers the target run exactly as before.
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "audit-discordant-identity.py"

_spec = importlib.util.spec_from_file_location("audit_discordant", TOOL)
assert _spec is not None and _spec.loader is not None
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)


def _report(coverage: object) -> dict:
    return {
        "label": "fixture",
        "ablation": {
            "delta": 0.1,
            "discordant": {
                "baselineCorrectFeatureIncorrect": 1,
                "baselineIncorrectFeatureCorrect": 1,
            },
        },
        "cohortCoverage": coverage,
    }


def _run_on(report: dict) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as tmp:
        path = pathlib.Path(tmp) / "report.json"
        path.write_text(json.dumps(report))
        return subprocess.run(
            ["python3", str(TOOL), str(path)],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=False,
        )


def test_null_present_coverage_does_not_crash_the_audit() -> None:
    result = _run_on(_report({"present": None, "missing": []}))
    assert result.returncode == 0, result.stderr
    assert "Traceback" not in result.stderr, result.stderr
    assert "verified" in result.stdout.lower(), result.stdout


def test_well_formed_present_coverage_still_registers() -> None:
    result = _run_on(_report({"present": ["6456829e_abs"], "missing": []}))
    assert result.returncode == 0, result.stderr
    assert "1/7" in result.stdout, result.stdout
