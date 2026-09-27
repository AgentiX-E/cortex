#!/usr/bin/env python3
"""Defect injection for tools/read-b7-criterion.mjs.

The reader's tests assert three ORDER properties, and an order property that is
never violated in a test cannot be distinguished from one that is merely written
down. Each injection below breaks exactly one property and must be caught.

Every anchor is a line that exists in this file. An earlier revision of this
script anchored one injection on `const computed = cohort.targets.map(...)`,
which lives in `src/b7-cohort.ts` and not here; the injection reported "anchor
missing" and was counted as a survivor, which is the correct behaviour — a
mis-aimed injection is a finding about the harness, not about the tests.

Run: python3 tools/inject-b7-criterion-reader.py
Exit 0 when every injection is caught or declared equivalent.
"""

from __future__ import annotations

import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "tools" / "read-b7-criterion.mjs"
TEST = "src/__tests__/read-b7-criterion.test.ts"
PNPM = "/root/.pnpm/.tools/pnpm/9.15.0_tmp_85206/node_modules/pnpm/bin/pnpm.cjs"

# (name, find, replace)
INJECTIONS: list[tuple[str, str, str]] = [
    (
        # Order property 2: the guard clause must be evaluated by the module on
        # the full outcome set. Dropping non-target outcomes from the input
        # silently disables the guard.
        "non-target-outcomes-dropped-so-the-guard-cannot-fire",
        "      .filter((o) => o.questionId !== '');",
        "      .filter((o) => o.questionId !== '' && cohort.targets.some((t) => t.questionId === o.questionId));",
    ),
    (
        # The reader must pass ungrounded questions through so the module's own
        # exclusion counter reports them.
        "ungrounded-questions-silently-dropped-again",
        "      grounded: q.grounded === true,",
        "      grounded: true,",
    ),
    (
        # An abstention must stay distinguishable from an empty answer.
        "abstention-normalised-to-the-empty-string",
        "  if (value === undefined || value === null) return null;",
        "  if (value === undefined || value === null) return '';",
    ),
    (
        "empty-answer-treated-as-an-answer",
        "  return text.length === 0 ? null : text;",
        "  return text;",
    ),
    (
        # The cohort must be reconciled against the publication before the arms
        # are read, and the disagreement must be surfaced.
        "cohort-disagreement-not-surfaced",
        "      console.log(\n        `>>> DISAGREEMENT with the published count.",
        "      console.log(\n        `>>> count note (suppressed.",
    ),
    (
        # A missing per-question array must throw, not yield a vacuous verdict.
        "missing-per-question-array-yields-an-empty-cohort",
        "  if (candidates.length === 0) {",
        "  if (candidates.length === 0) { return []; } if (false) {",
    ),
]


def run_tests() -> tuple[bool, str]:
    result = subprocess.run(
        [PNPM, "vitest", "run", TEST, "--reporter=dot"],
        cwd=ROOT / "packages" / "cortex-eval",
        capture_output=True,
        text=True,
    )
    return result.returncode == 0, result.stdout + result.stderr


def main() -> int:
    original = SCRIPT.read_text()
    baseline_ok, baseline_out = run_tests()
    if not baseline_ok:
        print("baseline is not green; refusing to inject")
        print(baseline_out[-2000:])
        return 1
    print("baseline: green\n")

    caught = 0
    survivors: list[str] = []
    for name, find, replace in INJECTIONS:
        if find not in original:
            print(f"ANCHOR-MISSING {name}")
            survivors.append(f"{name} (anchor missing — harness defect)")
            continue
        SCRIPT.write_text(original.replace(find, replace, 1))
        passed, output = run_tests()
        SCRIPT.write_text(original)
        if passed:
            print(f"SURVIVED {name}  <- not caught")
            survivors.append(name)
        else:
            failing = [
                line.strip()
                for line in output.splitlines()
                if "AssertionError" in line or line.strip().startswith("×")
            ]
            print(f"caught   {name}")
            for line in failing[:1]:
                print(f"           {line[:110]}")
            caught += 1

    SCRIPT.write_text(original)
    print(f"\n{caught}/{len(INJECTIONS)} caught")
    if survivors:
        print("survivors:")
        for name in survivors:
            print(f"  {name}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
