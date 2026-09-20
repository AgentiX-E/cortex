#!/usr/bin/env python3
"""Summarise the benchmark report set into a Markdown table, for a job summary.

## Why this exists

Run `35510619912` completed **success** with all 14 steps green and its artifact
and logs were both unfetchable: the download 302-redirects to
`productionresultssa16.blob.core.windows.net`, a blob host that answers
`404 AccountNotFound` because no such storage account is publicly addressable.
Artifact routing is assigned per run and is stable within a run, so the report
set existed on GitHub's side and was simply not reachable from ours.

The result was a green run whose measurement was gone -- and the run looked
healthy in every place a reader would check. `docs/OPS-UNFETCHABLE-ARTIFACT.md`
records the diagnosis.

The artifact remains the primary record. This script feeds a **second, independent
sink** (the job summary), which travels by a different channel, so a routing
failure on the artifact path cannot remove the numbers too. The goal is to turn
"the run succeeded and we have nothing" into "the run succeeded and we have less
detail".

## Design notes

- **Only the aggregate numbers are summarised.** The artifact holds the full set;
  a summary nobody can scan is not a summary.
- **Never fails the step.** A summary is a convenience, and a run that already
  did its work should not go red because a report could not be parsed. Every
  error is rendered into the output instead of raised.
- **No `jq` dependency.** The workflow runs on a GitHub runner where `jq` happens
  to exist, but relying on it would make the second sink fail in the one scenario
  it exists for -- when something about the environment differs from expectation.
- **`null` is handled explicitly.** `NaN` and `±Infinity` are persisted as `null`
  by `JSON.stringify`, so a value of `None` here is a real, expected state (a
  single-run ablation produces it for `pValue` on every arm) and must render as a
  label, never as a number. Rendering it as `0` would invert the finding -- see
  `docs/FIX-REPORT-JSON-ROUNDTRIP.md`.
- **The cohort and fire counters are surfaced.** They are the fields that make a
  result interpretable rather than merely readable, and a summary that drops them
  would reproduce the side-channel defect in the one place a human actually
  looks. See `docs/FIX-COHORT-COVERAGE-SIDE-CHANNEL.md`.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def pct(value: object) -> str:
    """Render a fraction as a percentage, or a label when it is not a number.

    `null` is the persisted form of `NaN`/`±Infinity`, which are real results:
    an unrun t-test and an unbounded effect. A number is never fabricated here.
    """
    if value is None:
        return "n/a"
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return "n/a"
    return f"{value * 100:.2f}%"


def num(value: object) -> str:
    if value is None:
        return "n/a"
    return str(value)


def ablation_table(data: dict) -> list[str]:
    ab = data.get("ablation", {})
    baseline = ab.get("baselineAggregate", {})
    feature = ab.get("featureAggregate", {})
    lines = [
        "| field | value |",
        "|---|---|",
        f"| questions | {num(data.get('questionCount'))} |",
        f"| baseline avg | {pct(baseline.get('avg'))} |",
        f"| feature avg | {pct(feature.get('avg'))} |",
        f"| delta | {pct(ab.get('delta'))} |",
        f"| McNemar p | {num(ab.get('mcnemarPValue'))} |",
        f"| Welch p | {num(ab.get('pValue'))} |",
        f"| Cohen's d | {num(ab.get('effectSize'))} |",
    ]
    # Distinct result-relevant counts. Each degrades to a warning that says what
    # the absence means, rather than silently printing nothing.
    coverage = data.get("cohortCoverage")
    if coverage:
        present = len(coverage.get("present", []))
        missing = coverage.get("missing", [])
        total = present + len(missing)
        state = "complete" if not missing else f"INCOMPLETE, missing {', '.join(missing)}"
        lines.append(f"| cohort | {present}/{total} ({state}) |")

    fires = data.get("retryFires")
    if fires:
        control = fires.get("controlFires")
        treatment = fires.get("treatmentFires")
        questions = fires.get("questions") or 0
        rate = 0 if not questions else treatment / questions
        note = ""
        if control:
            note = " -- INVALID EXPERIMENT: control fired"
        elif treatment == 0:
            note = " -- INERT: never fired"
        elif treatment <= 2:
            note = " -- INERT: under-powered"
        lines.append(
            f"| retry fires | control {control}, treatment {treatment} "
            f"of {questions} ({pct(rate)}){note} |"
        )
    return lines


def curve_table(data: object) -> list[str]:
    """The recall curve, from either the list form or a `points`/`k` field.

    The persisted artifact is a **top-level list** of points, not an object with a
    `points` key. Both shapes are accepted because the writer is free to change
    and a summary that silently prints nothing when the shape moves is worse than
    one that renders a slightly different table.
    """
    points: object
    if isinstance(data, list):
        points = data
    elif isinstance(data, dict):
        points = data.get("points") or data.get("k")
    else:
        points = None

    if isinstance(points, list) and points:
        lines = ["| k | recall | ceiling | gain |", "|---|---|---|---|"]
        for point in points:
            if isinstance(point, dict):
                lines.append(
                    f"| {num(point.get('k'))} | {pct(point.get('recall'))} | "
                    f"{pct(point.get('ceiling'))} | {pct(point.get('gain'))} |"
                )
            else:
                lines.append(f"| {num(point)} | -- | -- | -- |")
        return lines
    if isinstance(points, dict):
        # A map of k -> point.
        lines = ["| k | recall | ceiling | gain |", "|---|---|---|---|"]
        for k, point in sorted(points.items(), key=lambda kv: float(kv[0])):
            if isinstance(point, dict):
                lines.append(
                    f"| {k} | {pct(point.get('recall'))} | "
                    f"{pct(point.get('ceiling'))} | {pct(point.get('gain'))} |"
                )
        return lines
    return ["_No recall-curve points in this file._"]


def summarise(path: Path) -> str:
    out = [f"### `{path.stem}`", ""]
    try:
        data = json.loads(path.read_text())
    except Exception as exc:  # noqa: BLE001 -- a summary must not raise
        out.append(f"_Could not parse `{path.name}`: {exc}_")
        return "\n".join(out)

    name = path.name
    # The recall curve is a top-level list, so it is matched by filename before
    # the dict-shaped reports rather than by inspecting the payload.
    if "recall-curve" in name:
        out.extend(curve_table(data))
        return "\n".join(out)

    if not isinstance(data, dict):
        out.append(f"_Unexpected top-level type: {type(data).__name__}_")
        return "\n".join(out)

    if data.get("ablation"):
        out.extend(ablation_table(data))
    else:
        out.append(f"_No recognised report shape. Keys: {', '.join(sorted(data)) or '(none)'}_")
    return "\n".join(out)


def main(argv: list[str]) -> int:
    root = Path(argv[1]) if len(argv) > 1 else Path("packages/cortex-eval")
    patterns = ["benchmark-*-ablation-report.json", "benchmark-report.json",
                "benchmark-recall-curve.json"]
    found: list[Path] = []
    for pattern in patterns:
        found.extend(sorted(root.glob(pattern)))
    # A pattern may match the same file twice via different globs; keep order.
    seen: set[Path] = set()
    unique = [p for p in found if not (p in seen or seen.add(p))]

    print("## LongMemEval-S results")
    print()
    if not unique:
        print("_No report JSON found. The benchmark step may not have run, or it")
        print("failed before writing any report. See the step log._")
        return 0

    for path in unique:
        print(summarise(path))
        print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
