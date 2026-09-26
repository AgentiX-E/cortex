#!/usr/bin/env python3
"""Defect-injection harness for candidate-discrimination.ts.

Each mutation states the defect it introduces and the tests it should break. A
mutation that leaves the suite green means the suite does not test that
behaviour, which is the finding -- not a pass.

The file is restored byte-for-byte after every mutation and the restore is
verified by md5, so a run that crashes cannot leave a mutated implementation
behind.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

SRC = Path("/workspace/cortex/packages/cortex-eval/src/candidate-discrimination.ts")
PKG = SRC.parent.parent
TEST = "src/__tests__/candidate-discrimination.test.ts"

MUTATIONS = [
    (
        "compare-full-token-sets",
        "Use the full token sets instead of the unique ones, so shared words read as evidence.",
        "const truthFound = onlyInFirst.some((token) => present(input.retrieved, token));",
        "const truthFound = truth.some((token) => present(input.retrieved, token));",
    ),
    (
        "treat-unique-as-either-side",
        "Let a token unique to the reader satisfy the truth check, merging the two sides.",
        "const truthFound = onlyInFirst.some((token) => present(input.retrieved, token));",
        "const truthFound = [...onlyInFirst, ...onlyInSecond].some((token) => present(input.retrieved, token));",
    ),
    (
        "drop-the-unadjudicable-guard",
        "Proceed when a side has no unique token, assigning the list case to a bucket by guess.",
        "if (onlyInFirst.length === 0 || onlyInSecond.length === 0) {\n    return 'unadjudicable';\n  }",
        "if (false) {\n    return 'unadjudicable';\n  }",
    ),
    (
        "require-every-token-instead-of-some",
        "Require every unique token rather than any, so a partially-present candidate reads as absent.",
        "const truthFound = onlyInFirst.some((token) => present(input.retrieved, token));",
        "const truthFound = onlyInFirst.every((token) => present(input.retrieved, token));",
    ),
    (
        "ignore-the-word-boundary",
        "Match on substring, so `car` is satisfied by `cargo`.",
        "if (!alnum(before) && !alnum(after)) {\n      return true;\n    }",
        "return true;",
    ),
    (
        "stop-the-scan-at-the-first-rejection",
        "Return false on the first rejected position instead of continuing the scan.",
        "    index = lower.indexOf(needle, index + 1);\n  }\n  return false;",
        "    return false;\n  }\n  return false;",
    ),
    (
        "do-not-lowercase-the-haystack",
        "Skip lowercasing, so a case difference hides a candidate.",
        "const lower = haystack.toLowerCase();",
        "const lower = haystack;",
    ),
    (
        "keep-grammatical-tokens",
        "Drop the grammatical filter, so `the` is treated as a competing candidate.",
        ".filter((token) => /[\\p{L}\\p{N}]/u.test(token) && !GRAMMATICAL_TOKENS.has(token));",
        ".filter((token) => /[\\p{L}\\p{N}]/u.test(token));",
    ),
    (
        "skip-the-dedup-in-distinguishing",
        "Stop de-duplicating inside distinguishingTokens, so a repeated word double-counts.",
        "for (const token of new Set(first)) {",
        "for (const token of first) {",
    ),
    (
        "treat-null-reader-answer-as-empty-string",
        "Read a null reader answer as the literal text `null` instead of no tokens.",
        "if (value === null) {\n    return [];\n  }",
        "if (value === false) {\n    return [];\n  }",
    ),
    (
        "swallow-the-single-token-sides",
        "Return unadjudicable when either side has exactly one token, discarding real verdicts.",
        "if (onlyInFirst.length === 0 || onlyInSecond.length === 0) {",
        "if (onlyInFirst.length <= 1 || onlyInSecond.length <= 1) {",
    ),
]


def md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def run_suite() -> tuple[int, str]:
    proc = subprocess.run(
        ["npx", "vitest", "run", TEST, "--reporter=basic"],
        cwd=PKG,
        capture_output=True,
        text=True,
    )
    return proc.returncode, proc.stdout + proc.stderr


def main() -> int:
    original = SRC.read_text()
    original_md5 = md5(SRC)
    failures: list[str] = []

    for name, description, old, new in MUTATIONS:
        if old not in original:
            print(f"SKIP  {name}: fragment not found, the mutation is stale")
            failures.append(name)
            continue

        SRC.write_text(original.replace(old, new, 1))
        try:
            code, output = run_suite()
        finally:
            SRC.write_text(original)

        if md5(SRC) != original_md5:
            print(f"ABORT {name}: restore failed, md5 mismatch")
            return 2

        if code == 0:
            print(f"MISSED {name}: suite stayed green -- {description}")
            failures.append(name)
        else:
            line = next(
                (
                    l.strip()
                    for l in output.splitlines()
                    if "Tests" in l and ("failed" in l or "passed" in l)
                ),
                "?",
            )
            print(f"CAUGHT {name}: {line}")

    print()
    if failures:
        print(f"{len(failures)} mutation(s) not caught: {', '.join(failures)}")
        return 1
    print(f"All {len(MUTATIONS)} mutations caught; implementation restored at {original_md5}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
