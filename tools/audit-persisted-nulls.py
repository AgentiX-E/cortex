#!/usr/bin/env python3
"""Audit archived benchmark JSON artifacts for JSON-substituted nulls.

## Why this exists

Three defects in this repository shared one shape: a value that was a real number
in memory became `null` on disk, because `JSON.stringify` has no representation
for `NaN` or `±Infinity` and silently writes `null` instead. `Number.isNaN(null)`
is `false`, so any guard written as `Number.isNaN(x) ? fallback : x.method()`
routes the persisted value into the numeric branch and throws -- or, worse,
renders a wrong number that reads as a real finding.

Those defects were found by accident, one at a time, each only after it had
already shipped. This script makes the whole class checkable in one pass, so the
next occurrence is caught by running a command rather than by a reader noticing
that a table is missing.

## The hard part: a null is not evidence of a bug

`null` is a legitimate value in these schemas. `Answer` is `string | null`, so
`decision.answer: null` is how an abstention is recorded -- it is the datum, not
a corrupted version of one. Flagging every null would produce a report nobody
reads, which is the same failure mode as flagging none.

So the tool discriminates on evidence rather than on the presence of null:

  1. **Schema-aware expectations.** A null is only suspicious in a field whose
     type is numeric. `answer` is excluded by name because its type is nullable
     by design.
  2. **Co-occurrence.** For the specific pattern at issue -- a null in a field
     whose sibling carries the same information -- the tool checks whether the
     null is *explained* by an observable state. `answer: null` is explained
     when `abstained` is true and the reason is an abstention reason; it is
     **unexplained** when the arm claims to have answered. That is the
     discriminating test, and it is what separates "this run abstained 10 times"
     from "this run's answers were destroyed on the way to disk."
  3. **Round-trip counterfactual.** For each file, the null set is reported
     alongside the numeric field set, so a reader can see the denominator. A
     file with 0 numeric fields cannot be affected; saying so is information.

## Usage

    python3 tools/audit-persisted-nulls.py <artifact-dir> [<artifact-dir> ...]

Exit code is 0 when every null is explained, 1 when any is not. The exit code is
the point: this is meant to be runnable in CI, so that "the artifacts are still
readable" is a checked property rather than a remembered one.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

# Fields whose type is nullable BY DESIGN. A null here is a value, not a
# serialisation accident. Each entry needs a reason, because an unexplained
# exception list is how a real defect gets excluded from an audit.
NULLABLE_BY_DESIGN = {
    "answer": "`Answer = string | null`; null is how an abstention is recorded",
    "decision": "a question with no trace attached is `null` when tracing is off",
}

# Abstention reasons. An `answer: null` is explained when the reason is one of
# these -- it is the recorded shape of a decline.
ABSTENTION_REASONS = {"empty", "threshold", "llm"}


def walk(obj: Any, path: str = "") -> list[tuple[str, Any]]:
    """Yield (dotted-path, value) for every leaf, dicts and lists included."""
    out: list[tuple[str, Any]] = []
    if isinstance(obj, dict):
        for key, value in obj.items():
            out.extend(walk(value, f"{path}.{key}" if path else key))
    elif isinstance(obj, list):
        for index, value in enumerate(obj):
            out.extend(walk(value, f"{path}[{index}]"))
    else:
        out.append((path, obj))
    return out


def is_numeric(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def audit_file(path: Path) -> tuple[list[str], list[str], int, int]:
    """Return (unexplained, explained, null_count, numeric_count)."""
    data = json.loads(path.read_text())
    leaves = walk(data)
    nulls = [(p, v) for p, v in leaves if v is None]
    numerics = [(p, v) for p, v in leaves if is_numeric(v)]

    unexplained: list[str] = []
    explained: list[str] = []

    for leaf_path, _ in nulls:
        field = leaf_path.split(".")[-1].split("[")[0]

        if field in NULLABLE_BY_DESIGN:
            # A nullable field still has to be CONSISTENT: if the record claims
            # to have answered, a null answer is not a decline, it is a loss.
            container = leaf_path.rsplit(".", 1)[0] if "." in leaf_path else ""
            record = resolve(data, container)
            if field == "answer" and isinstance(record, dict):
                abstained = record.get("abstained")
                reason = record.get("reason")
                if abstained is False or reason == "answered":
                    unexplained.append(
                        f"{leaf_path} -- record claims an answer "
                        f"(abstained={abstained!r}, reason={reason!r}) but the field is null"
                    )
                    continue
                if abstained is True and reason in ABSTENTION_REASONS:
                    explained.append(f"{leaf_path} -- decline via reason={reason!r}")
                    continue
            explained.append(f"{leaf_path} -- {NULLABLE_BY_DESIGN[field]}")
            continue

        # A numeric field that is null is the JSON substitution. It is reported
        # as a substitution, which is a DIFFERENT finding from a defect: the
        # substitution is a faithful record of the live value, and the only
        # question is whether the consumer of this file can read it.
        #
        # The renderer for `AblationReport` now reads it (see `formatPValue` and
        # `formatEffectSize` in `report.ts`), so a report null is handled. The
        # tool cannot infer that from the file, so it labels the path family and
        # lets the exit code stay clean for the known-handled case.
        if leaf_path.startswith("ablation."):
            explained.append(
                f"{leaf_path} -- JSON substitution, handled by the report renderer"
            )
            continue

        unexplained.append(
            f"{leaf_path} -- null in a field whose siblings are numeric; "
            "JSON.stringify writes null for NaN and +/-Infinity, and no renderer "
            "is known to handle this path"
        )

    return unexplained, explained, len(nulls), len(numerics)


def resolve(data: Any, dotted: str) -> Any:
    """Resolve a dotted path back to its container object, lists included."""
    if not dotted:
        return data
    node = data
    for part in dotted.split("."):
        if part == "":
            continue
        name, _, index = part.partition("[")
        if name:
            if not isinstance(node, dict):
                return None
            node = node.get(name)
        if index:
            try:
                node = node[int(index.rstrip("]"))]
            except (ValueError, IndexError, TypeError):
                return None
    return node


def main(argv: list[str]) -> int:
    dirs = [Path(a) for a in argv[1:]]
    if not dirs:
        print(__doc__)
        return 2

    files: list[Path] = []
    for d in dirs:
        if d.is_dir():
            files.extend(sorted(d.glob("benchmark-*.json")))
        elif d.is_file():
            files.append(d)

    if not files:
        print("no benchmark-*.json found", file=sys.stderr)
        return 2

    total_unexplained = 0
    print(f"Auditing {len(files)} artifact(s) for JSON-substituted nulls\n")
    for path in files:
        unexplained, explained, n_nulls, n_numerics = audit_file(path)
        status = "FAIL" if unexplained else "ok"
        print(f"[{status}] {path.name}")
        print(f"       nulls={n_nulls}  numeric-fields={n_numerics}  explained={len(explained)}")
        for item in unexplained:
            print(f"       UNEXPLAINED: {item}")
        total_unexplained += len(unexplained)

    print()
    if total_unexplained:
        print(f"{total_unexplained} unexplained null(s) -- the artifact set is not self-consistent")
        return 1
    print("All nulls explained. No JSON-substituted numeric values detected.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
