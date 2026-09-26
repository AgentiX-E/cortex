#!/usr/bin/env python3
"""Defect-injection harness for tr-failure-class.ts.

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

SRC = Path("/workspace/cortex/packages/cortex-eval/src/tr-failure-class.ts")
PKG = SRC.parent.parent

# (name, what the defect is, old fragment, new fragment, expected failing tests)
MUTATIONS = [
    (
        "ignore-the-word-boundary",
        "Drop both boundary checks, so '4' matches inside '40' and inside a date.",
        "if (!isAlphanumericChar(before) && !isAlphanumericChar(after)) {\n      count++;\n    }",
        "count++;",
    ),
    (
        "drop-the-null-guard",
        "Treat a null answer as an empty token set, making it vacuously grounded.",
        "if (groundTruth === null) {\n    return [];\n  }",
        "if (groundTruth === false) {\n    return [];\n  }",
    ),
    (
        "empty-tokens-count-as-grounded",
        "Return true for an empty token set, so 'no evidence needed' becomes grounded.",
        "if (tokens.length === 0) {\n    return false;\n  }",
        "if (tokens.length === 0) {\n    return true;\n  }",
    ),
    (
        "any-token-instead-of-every",
        "Require any token rather than every token, so partial evidence reads as grounded.",
        "return tokens.every((token) => occurrences(haystack, token) > 0);",
        "return tokens.some((token) => occurrences(haystack, token) > 0);",
    ),
    (
        "do-not-lowercase-the-haystack",
        "Skip lowercasing the haystack, so case differences hide the evidence.",
        "const lower = haystack.toLowerCase();\n  const needle = token.toLowerCase();",
        "const lower = haystack;\n  const needle = token.toLowerCase();",
    ),
    (
        "reinstate-the-length-filter",
        "Restore the two-character filter that discarded 10 of 22 real records.",
        ".filter((token) => ALPHANUMERIC.test(token));",
        ".filter((token) => token.length >= 2);",
    ),
    (
        "reject-numeric-answers",
        "Stringify nothing: refuse a JSON number instead of its digits.",
        "return String(groundTruth)\n    .toLowerCase()",
        "return (typeof groundTruth === 'number' ? '' : String(groundTruth))\n    .toLowerCase()",
    ),
    (
        "count-only-the-first-occurrence",
        "Stop the occurrence scan after the first hit, flattening strong and weak evidence.",
        "index = lower.indexOf(needle, index + 1);",
        "index = -1;",
    ),
    (
        "skip-ahead-by-token-length",
        "Advance by one within the token, double-counting overlapping occurrences.",
        "index = lower.indexOf(needle, index + 1);",
        "index = lower.indexOf(needle, index + 1) === -1 ? -1 : index + 1;",
    ),
]


def md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def run_suite() -> tuple[int, str]:
    proc = subprocess.run(
        ["npx", "vitest", "run", "src/__tests__/tr-failure-class.test.ts", "--reporter=basic"],
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

        restored = md5(SRC) == original_md5
        if not restored:
            print(f"ABORT {name}: restore failed, md5 mismatch")
            return 2

        if code == 0:
            print(f"MISSED {name}: suite stayed green -- {description}")
            failures.append(name)
        else:
            line = next(
                (l.strip() for l in output.splitlines() if "Tests" in l and ("failed" in l or "passed" in l)),
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
