#!/usr/bin/env python3
"""Does this artifact describe the configuration the project registers?

## The defect this file exists for

Section 13.336 adopted a six-route character-room allocation. It moved `docs/PREREGISTRATION` §10.3,
`tools/dispatch-cortex-memory-ab.py`'s `INPUTS`, and `tools/arm-config-baseline.json`, which
`--record` had just rewritten from the run that carried the allocation (`42533236864`). Three files
agreeing is what the project calls a registration.

Nothing else moved. `cortex-docs/evidence/longmemeval/cost.json`, `evidence-budget.json`,
`categories.json` and `frontier.json#shipping` still named `42355323615` -- the *pre-adoption* room
map -- and four acceptance rows read them. Two consequences, of different sizes:

| row | what it printed | what the registered configuration reads | size |
| --- | ---: | ---: | ---: |
| `C1` prompt tokens per question | 12,137 | **9,201** | **24.2% of the bill** |
| `S1` overall, four-repetition mean | 91.95% | 91.05% | 0.90 points |

The accuracy difference is smaller than the span three draws of the *predecessor* configuration
produced (§13.336.1: 91.95 / 91.65 / 91.05), so it is not an effect and no capability changed. The
bill difference is not noise in any frame: it is the axis the adoption was for, and the matrix was
overstating it by a quarter.

This is §2.2's defect class one axis further. There the rows read a configuration that no longer
ships; there the attestation named how the number was computed (`accuracySource`, `runs`) and which
arm *label* it came from. A label is not a configuration. `S1`'s own note says the label "cannot
silently resolve to an older file", and it resolved to one anyway, because the label `route-room`
was still present and still pointed at the room map §13.336 had replaced.

## What an attestation has to compare

The value both sides can compute without a fourth copy of the numbers: `memoryArmConfig`, which every
artifact carries and which the baseline records verbatim. `fingerprint()` hashes it canonically, so
the comparison is one string, and `differences()` projects it through `arm-config-record.py`'s
`PROJECTED` table, so a failure names the dispatch inputs rather than a hash.

Two consumers:

- `cost-ledger.py`, `evidence-budget.py` and `capability-ledger.py` refuse `--write` from an artifact
  whose fingerprint is not the baseline's. An evidence file that describes a configuration nobody
  registers is the file the acceptance matrix reads, so that is the boundary that has to be closed.
- `acceptance.ts` compares a row's `configurationFingerprint` against the baseline's with an
  `equalsFrom` clause, so a row goes `stale` the moment the two disagree -- which is a state the
  build reports, rather than a number it publishes.

## What this does not claim

It does not say the registered configuration is the best one, or that a matching artifact is a *good*
measurement. It says the artifact is a measurement of the configuration the project registers, which
is the only thing an acceptance row is entitled to assume.

Usage:

    python3 tools/registration-attest.py path/to/report.json
    python3 tools/registration-attest.py path/to/report.json --json
    python3 tools/registration-attest.py path/to/report.json --baseline other.json
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASELINE = ROOT / "tools" / "arm-config-baseline.json"
RECORD = ROOT / "tools" / "arm-config-record.py"


def _record_module():
    """`arm-config-record.py`, loaded by path.

    The projection is defined in exactly one place and this file does not restate it: a second
    `PROJECTED` table would be a second answer to "which fields are configuration", and the class of
    defect this tool exists for is two documents that agree with each other and disagree with the run.
    """
    spec = importlib.util.spec_from_file_location("arm_config_record", RECORD)
    if spec is None or spec.loader is None:  # pragma: no cover - a missing file is a broken checkout
        raise SystemExit(f"cannot load {RECORD}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def canonical(config: object) -> str:
    """The artifact's configuration as one string, with no formatting left to disagree about.

    Defined in `arm-config-record.py` and delegated here, because that file already owns the
    artifact-to-configuration knowledge and a second definition would be the class of defect this tool
    exists for. `efficiency-frontier.mjs` reimplements it in nine lines, and
    `tools/__tests__/test_registration_attest.py` pins the two to the same output on a shared fixture:
    a fingerprint two languages compute differently is worse than no fingerprint.
    """
    return _record_module().canonical(config)


def fingerprint(config: object) -> str:
    """`sha256:<hex>` over `canonical(config)`.

    The prefix is not decoration. The baseline carries `datasetFingerprint` in the same spelling, so a
    reader who sees one without the other can tell that the algorithm is stated rather than implied.
    """
    return _record_module().fingerprint(config)


def differences(report: dict, baseline: dict) -> list[str]:
    """Every dispatch input whose recorded value and applied value disagree, in either direction.

    Both sides come from `project()`, so the key sets agree unless the artifact is missing a field the
    baseline has -- and that case is reported rather than skipped, because a projection that quietly
    lost a value is the failure mode the reverse direction of `arm-config-record.py --check` exists
    for. `TABLE_ONLY` is not consulted: those keys are dispatch-only by construction and neither side
    of this comparison can carry them.
    """
    if not isinstance(report.get("memoryArmConfig"), dict):
        return [
            "memoryArmConfig: the artifact carries no arm configuration, so no input can be compared"
        ]
    record = _record_module()
    recorded = baseline.get("dispatch")
    if not isinstance(recorded, dict):
        # A record with no projection cannot diagnose anything, and it is not a match either -- `matched`
        # is decided by the fingerprint, so this returns the one thing it can say truthfully rather than
        # an empty list a caller would read as agreement.
        return ["dispatch: the registration record carries no projected dispatch block, so no input can be compared"]
    ran = record.project(report)
    found: list[str] = []
    for name in sorted(set(recorded) | set(ran)):
        if name in record.FIXED:
            # Projected out of the artifact and fixed outside the dispatch, so neither side of *this*
            # comparison can carry it. `arm-config-record.py --check` owns the direction that has to
            # still hold -- the table must not have started sending it -- and asserts it there.
            continue
        if name not in ran:
            found.append(
                f"{name}: the baseline records {recorded[name]!r} and the artifact's projection has "
                "no entry for it, so this artifact cannot be compared on that input"
            )
        elif name not in recorded:
            found.append(
                f"{name}: the artifact applied {ran[name]!r} and the baseline records no value for "
                "it, which means the baseline predates the input"
            )
        elif recorded[name] != ran[name]:
            found.append(
                f"{name}: the baseline records {recorded[name]!r} and this artifact applied "
                f"{ran[name]!r}"
            )
    return found


def attestation(report: dict, baseline: dict) -> dict:
    """The one object every caller needs: matched or not, why not, and the fingerprint either way.

    `matched` is decided by the fingerprint and **not** by `differences()`. The two can disagree in one
    direction only -- a field outside the projection -- and when they do, the fingerprint is the
    authority because it covers the whole configuration. Reporting the difference list beside it keeps
    the failure diagnosable without making the diagnosis the decision.
    """
    # `.get`, not `[...]`: this tool is also called on partial reports (a synthetic fixture, a smoke
    # artifact), and a `KeyError` there would be a crash where the honest answer is "this is not the
    # registered configuration". A missing block hashes as `null`, which no recorded baseline carries.
    applied = fingerprint(report.get("memoryArmConfig"))
    registered = baseline.get("memoryArmConfigFingerprint")
    found = differences(report, baseline)
    return {
        "matched": applied == registered,
        "applied": applied,
        "registered": registered,
        "run": baseline.get("run"),
        "adoptedBy": baseline.get("adoptedBy"),
        "differences": found,
    }


def refusal(reading: dict, baseline_path: Path) -> str:
    """The sentence a writer prints instead of writing, naming every field that moved.

    A refusal that says only "the configuration differs" sends the reader to diff two JSON files; one
    that names the inputs sends them to the section that moved them.
    """
    lines = [
        f"this artifact is not a measurement of the registered configuration ({baseline_path}).",
        f"  applied    {reading['applied']}",
        f"  registered {reading['registered']}  (run {reading['run']}, adopted by §{reading['adoptedBy']})",
    ]
    lines.extend(f"  {line}" for line in reading["differences"])
    lines.append(
        "Refusing to write an evidence file from it. Regenerate from an artifact of the registered "
        "configuration, or record a new baseline with `arm-config-record.py --record` in the change "
        "that adopts the new one -- in that order, because the second is what makes the first true."
    )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("artifact", type=Path, help="a benchmark-cortex-memory-ablation-report.json")
    parser.add_argument("--baseline", type=Path, default=BASELINE, help="the registration record")
    parser.add_argument("--json", action="store_true", help="print the reading as JSON")
    args = parser.parse_args(argv)

    report = json.loads(args.artifact.read_text(encoding="utf-8"))
    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    reading = attestation(report, baseline)
    if args.json:
        print(json.dumps(reading, indent=2))
    elif reading["matched"]:
        print(f"registered: {reading['applied']} (run {reading['run']}, §{reading['adoptedBy']})")
    else:
        print(refusal(reading, args.baseline))
    return 0 if reading["matched"] else 1


if __name__ == "__main__":
    sys.exit(main())
