#!/usr/bin/env python3
"""Defect-injection harness for the BENCH-ARM option construction layer.

Why this harness exists, and why the other five cannot cover it.

The other harnesses assert on modules the test suite can import. This one covers
`bench-arm-options.ts`, which exists precisely because `bench/**` is outside
coverage: the B7 switch was carried into the arm by an inline spread in the CLI,
and defect injection showed that deleting it, defaulting it on, or reading the
wrong variable each left every test green, because no test could import the file
the line lived in.

Wiring `retrievalSides` through that seam is what closed this round, and it closed
it only because the census gate forced a production caller first. So there is a
real chance the new spread is decorative: an option built, spread, and then
dropped by the runner's `=== true` forward. The unit tests assert the option
object's keys; nothing in them proves the option survives the whole chain from
the environment variable to the arm.

This harness injects into that chain. Two links are mutated:

  1. `bench-arm-options.ts` -- the object construction (testable, covered).
  2. `bench/run.ts` -- the environment read and the call-site spread (NOT
     covered, which is the point).

Link 2 cannot be asserted by importing anything, so the mutations there are
checked structurally: the harness asserts the source contains the read, passes it,
and records it. That is weaker than a red test and it is labelled as such rather
than dressed up as one. What it does catch is the specific regression this round
was about -- an option that is built and then never forwarded -- plus the
`readToggle` default flipping to on, which would make every existing dispatch a
feature arm.

A mutation that leaves the suite green is the finding, not a pass. The file is
restored byte-for-byte and the restore is verified by md5.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

ARM = Path("/workspace/cortex/packages/cortex-eval/src/bench-arm-options.ts")
RUN = Path("/workspace/cortex/packages/cortex-eval/bench/run.ts")
PKG = ARM.parent.parent

# Mutations against `bench-arm-options.ts`. Each is (name, defect, old, new,
# expect_test_failure). The last element is False for the ones shown to be
# equivalent to the baseline on every reachable input.
ARM_MUTATIONS = [
    (
        "drop-the-channel-C-option",
        "Nothing carries the switch into the arm, so the feature is built and "
        "never used -- the §14 defect, repeated at a new layer.",
        "    ...(input.retrievalSides ? { retrievalSides: true } : {}),\n",
        "",
        True,
    ),
    (
        "default-channel-C-on",
        "The option is present even when the toggle is off, so the control arm "
        "silently becomes a second feature arm and the A/B is two feature arms.",
        "    ...(input.retrievalSides ? { retrievalSides: true } : {}),",
        "    retrievalSides: true,",
        True,
    ),
    (
        "carry-the-toggle-value-instead-of-true",
        "Emits the raw boolean, so a future change to the runner's check can turn "
        "an explicit `false` into an enabled feature.",
        "    ...(input.retrievalSides ? { retrievalSides: true } : {}),",
        "    ...(input.retrievalSides ? { retrievalSides: input.retrievalSides } : {}),",
        False,
    ),
    (
        "read-the-wrong-field-for-channel-C",
        "Channel C is driven by the discrimination toggle, so the two switches "
        "cannot disagree and an inert configuration becomes unexpressible.",
        "    ...(input.retrievalSides ? { retrievalSides: true } : {}),",
        "    ...(input.candidateDiscrimination ? { retrievalSides: true } : {}),",
        True,
    ),
]

# Structural assertions against `bench/run.ts`. These are not red tests -- the
# file is excluded from coverage -- so they are checked by inspection and
# reported as structural rather than as caught mutations.
RUN_ASSERTIONS = [
    (
        "reads-RETRIEVAL_SIDES-from-the-environment",
        "RETRIEVAL_SIDES",
        "The switch is never parsed, so no dispatch can reach the arm.",
    ),
    (
        "passes-retrievalSides-to-the-arm",
        "retrievalSides,",
        "The switch is parsed and then dropped before the arm is constructed.",
    ),
    (
        "records-retrievalSides-in-the-artifact",
        "featureConfig: { candidateDiscrimination, retrievalSides }",
        "The run's own artifact does not say which channel-C arm produced it, "
        "so the delta's sign cannot be interpreted after the fact.",
    ),
]


def md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def run_tests() -> tuple[bool, str]:
    """Runs the arm-options suite. True when it is green."""
    result = subprocess.run(
        ["npx", "vitest", "run", "src/__tests__/bench-arm-options.test.ts"],
        cwd=PKG,
        capture_output=True,
        text=True,
    )
    output = result.stdout + result.stderr
    return result.returncode == 0, output


def main() -> int:
    if not ARM.exists() or not RUN.exists():
        print(f"missing source: {ARM} / {RUN}")
        return 2

    original_arm = ARM.read_text()
    baseline_arm = md5(ARM)
    run_source = RUN.read_text()

    print(f"{len(ARM_MUTATIONS)} arm mutations, {len(RUN_ASSERTIONS)} structural checks\n")

    # Build first: vitest reads `dist`, so a stale build would test the previous
    # revision. This cost a Green-that-was-not-real twice before it was added.
    build = subprocess.run(
        ["pnpm", "--filter", "@agentix-e/cortex-eval", "build"],
        cwd=PKG.parent.parent,
        capture_output=True,
        text=True,
    )
    if build.returncode != 0:
        print("build failed; cannot inject\n" + build.stdout + build.stderr)
        return 2

    caught = 0
    missed: list[str] = []
    live = [m for m in ARM_MUTATIONS if m[4]]
    equivalent = [m for m in ARM_MUTATIONS if not m[4]]

    for name, defect, old, new, is_live in ARM_MUTATIONS:
        if ARM.read_text().count(old) != 1:
            print(f"SKIP {name}: anchor not found exactly once")
            missed.append(f"{name} (anchor)")
            continue
        ARM.write_text(ARM.read_text().replace(old, new, 1))
        try:
            # The mutation must build before it can be tested. A mutation that
            # fails typecheck is malformed, not caught -- treating a build error
            # as a catch would overstate the suite, and that happened once.
            rebuild = subprocess.run(
                ["pnpm", "--filter", "@agentix-e/cortex-eval", "build"],
                cwd=PKG.parent.parent,
                capture_output=True,
                text=True,
            )
            if rebuild.returncode != 0:
                print(f"MALFORMED {name}: does not typecheck, so the suite never ran")
                missed.append(f"{name} (build error, not a catch)")
                continue
            still_green, out = run_tests()
        finally:
            ARM.write_text(original_arm)
        if md5(ARM) != baseline_arm:
            print("RESTORE FAILED -- aborting.")
            return 3
        if still_green:
            if is_live:
                print(f"MISSED {name}: {defect}")
                missed.append(name)
            else:
                print(f"CONFIRMED-EQUIVALENT {name}: the suite correctly does not see it")
        else:
            summary = [ln.strip() for ln in out.splitlines() if "Tests " in ln]
            label = "CAUGHT" if is_live else "CONTRADICTED"
            print(f"{label} {name}: {summary[-1] if summary else 'tests failed'}")
            if is_live:
                caught += 1
            else:
                missed.append(f"{name} (claimed equivalent but the suite sees it)")

    RESTORE = ARM.read_text()
    ARM.write_text(original_arm)
    if md5(ARM) != baseline_arm:
        print("RESTORE FAILED -- aborting.")
        return 3
    del RESTORE

    print()
    structural_failures: list[str] = []
    for name, needle, defect in RUN_ASSERTIONS:
        if needle in run_source:
            print(f"STRUCTURAL-OK {name}")
        else:
            print(f"STRUCTURAL-FAIL {name}: {defect}")
            structural_failures.append(name)

    print()
    if missed or structural_failures:
        problems = ", ".join(missed + structural_failures)
        print(
            f"{caught} of {len(live)} live mutations caught; "
            f"{len(equivalent)} equivalent; PROBLEMS: {problems}"
        )
        return 1
    print(
        f"All {len(live)} live mutations caught; {len(equivalent)} equivalent ones "
        f"confirmed invisible; {len(RUN_ASSERTIONS)} structural checks pass. "
        f"Arm restored at {md5(ARM)}."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
