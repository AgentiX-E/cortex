#!/usr/bin/env python3
"""A persisted `null` in `cohortCoverage.missing` must render, not raise TypeError.

## The defect this file is written against

`benchmark-summary.py` promises in its own docstring: "Never fails the step ... Every error is rendered
into the output instead of raised" and "`null` is handled explicitly ... must render as a label, never
as a number." Yet `ablation_table` did `missing = coverage.get("missing", [])` then `len(missing)`.
A report that carries `"missing": null` explicitly (the persisted form of an absent count, exactly the
round-trip the docstring describes) made `len(None)` raise TypeError, which escaped `summarise` and
failed the whole job-summary step -- breaking the very contract the file exists to uphold.

## What is asserted

1. a `null` `missing` renders a cohort line with `n/a`, never a fabricated `0`, and never raises;
2. a `null` `missing` alongside a `null` `present` still renders without raising;
3. a well-formed cohort still renders its present/missing counts, so the fix is specific to malformed
   values and does not paper over a real cohort.
"""

from __future__ import annotations

import importlib.util
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "benchmark-summary.py"

_spec = importlib.util.spec_from_file_location("benchmark_summary", TOOL)
assert _spec is not None and _spec.loader is not None
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)


def _report(coverage: object) -> dict:
    return {
        "questionCount": 1,
        "ablation": {
            "baselineAggregate": {"avg": 0.8},
            "featureAggregate": {"avg": 0.9},
        },
        "cohortCoverage": coverage,
    }


def _cohort_line(report: dict) -> str:
    lines = _module.ablation_table(report)
    cohort = [line for line in lines if line.startswith("| cohort |")]
    assert len(cohort) == 1, lines
    return cohort[0]


def test_null_missing_renders_na_without_raising() -> None:
    line = _cohort_line(_report({"present": ["MR"], "missing": None}))
    assert "n/a" in line, line
    assert "0/0" not in line, "must not fabricate a zero denominator"
    assert "1/1" not in line, "must not fabricate a complete cohort"


def test_null_present_and_missing_renders_without_raising() -> None:
    line = _cohort_line(_report({"present": None, "missing": None}))
    assert line.startswith("| cohort |"), line
    assert "n/a" in line, line


def test_well_formed_cohort_still_renders_counts() -> None:
    line = _cohort_line(_report({"present": ["MR", "TR"], "missing": ["ABS"]}))
    assert "2/3" in line, line
    assert "INCOMPLETE" in line and "ABS" in line, line
