#!/usr/bin/env python3
"""Defect-injection harness for retrieval.ts request shaping.

Each mutation states the defect it introduces and the tests it should break. A
mutation that leaves the suite green means the suite does not test that
behaviour, which is the finding -- not a pass.

Why this module needed a harness: the batch loop checked ONE of the provider's two
per-request caps (64 entries) and ignored the other (3072 tokens), and it issued
requests back to back against a provider that throttles on request rate. Neither
defect is visible from reading the loop -- it looks correct -- and neither
produces a failing test unless something asserts on the request SHAPE rather than
on the returned vectors. Every assertion here is therefore about how many
requests were made, how big they were, and when they were issued.

The file is restored byte-for-byte after every mutation and the restore is
verified by md5, so a run that crashes cannot leave a mutated implementation
behind.
"""

from __future__ import annotations

import hashlib
import subprocess
import sys
from pathlib import Path

SRC = Path("/workspace/cortex/packages/cortex-eval/src/retrieval.ts")
PKG = SRC.parent.parent
TEST = "src/__tests__/retrieval.test.ts"

MUTATIONS = [
    (
        "ignore-the-token-cap",
        "Shape batches on the entry count alone, so 64 long turns can exceed the "
        "provider's 3072-token cap and draw a non-retryable 400.",
        "    const wouldOverflowTokens = currentTokens + tokens > EMBED_MAX_TOKENS;",
        "    const wouldOverflowTokens = false;",
    ),
    (
        "drop-the-oversized-text",
        "Skip a text whose own estimate exceeds the cap instead of sending it "
        "alone, so it silently retrieves against an empty vector.",
        "    if (current.length > 0 && (wouldOverflowEntries || wouldOverflowTokens)) {",
        "    if (tokens > EMBED_MAX_TOKENS) continue;\n"
        "    if (current.length > 0 && (wouldOverflowEntries || wouldOverflowTokens)) {",
    ),
    (
        "split-every-text-alone",
        "Over-split so each text gets its own request, multiplying the request "
        "count against a rate-limited provider.",
        "    const wouldOverflowTokens = currentTokens + tokens > EMBED_MAX_TOKENS;",
        "    const wouldOverflowTokens = current.length > 0;",
    ),
    (
        "forget-the-entry-cap",
        "Shape on tokens alone, so a batch of 200 short texts exceeds the "
        "provider's 64-entry cap.",
        "    const wouldOverflowEntries = current.length >= EMBED_BATCH;",
        "    const wouldOverflowEntries = false;",
    ),
    (
        "pace-before-the-first-batch",
        "Charge the interval before the first request, adding latency to every "
        "call including single-batch ones that have nothing to be spaced from.",
        "    if (b > 0 && intervalMs > 0) {",
        "    if (intervalMs > 0) {",
    ),
    (
        "ignore-the-interval",
        "Never pace, so consecutive batches go back to back and the provider's "
        "rate limit is discovered by rejection.",
        "    if (b > 0 && intervalMs > 0) {\n"
        "      await new Promise((resolve) => setTimeout(resolve, intervalMs));\n"
        "    }",
        "    if (false) {\n"
        "      await new Promise((resolve) => setTimeout(resolve, intervalMs));\n"
        "    }",
    ),
    (
        "estimate-tokens-as-characters",
        "Estimate one token per character, a 4x over-estimate that splits almost "
        "every batch into single requests.",
        "  return Math.ceil(text.length / 4);",
        "  return text.length;",
    ),
    (
        "estimate-tokens-as-zero",
        "Estimate no tokens at all, so the token cap never binds and every batch "
        "is entry-capped only -- the original defect in a different place.",
        "  return Math.ceil(text.length / 4);",
        "  return 0;",
    ),
    (
        "flush-a-batch-per-index",
        "Push a batch for every index rather than accumulating, so the entry cap "
        "is satisfied by degenerate one-entry batches.",
        "    if (current.length > 0 && (wouldOverflowEntries || wouldOverflowTokens)) {",
        "    if (true) {",
    ),
]


def md5(path: Path) -> str:
    return hashlib.md5(path.read_bytes()).hexdigest()


def run_tests() -> tuple[bool, str]:
    proc = subprocess.run(
        ["pnpm", "exec", "vitest", "run", TEST],
        cwd=PKG,
        capture_output=True,
        text=True,
    )
    out = proc.stdout + proc.stderr
    return proc.returncode == 0, out


def main() -> int:
    original = SRC.read_text()
    baseline = md5(SRC)
    print(f"baseline md5 {baseline}")

    green, out = run_tests()
    if not green:
        print("BASELINE SUITE IS RED -- fix that before injecting.")
        print(out[-3000:])
        return 2

    caught = 0
    missed: list[str] = []
    for name, defect, old, new in MUTATIONS:
        if SRC.read_text().count(old) != 1:
            print(f"SKIP {name}: anchor not found exactly once")
            missed.append(f"{name} (anchor)")
            continue
        SRC.write_text(SRC.read_text().replace(old, new, 1))
        try:
            still_green, out = run_tests()
        finally:
            SRC.write_text(original)
        if md5(SRC) != baseline:
            print("RESTORE FAILED -- aborting.")
            return 3
        if still_green:
            print(f"MISSED {name}: {defect}")
            missed.append(name)
        else:
            summary = [ln.strip() for ln in out.splitlines() if "Tests " in ln]
            print(f"CAUGHT {name}: {summary[-1] if summary else 'tests failed'}")
            caught += 1

    print()
    if missed:
        print(f"{caught} of {len(MUTATIONS)} caught. MISSED: {', '.join(missed)}")
        return 1
    print(f"All {len(MUTATIONS)} mutations caught; implementation restored at {md5(SRC)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
