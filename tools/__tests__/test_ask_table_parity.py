#!/usr/bin/env python3
"""The arm's ask table and the product's must name the same values.

## The defect this file is written against

`cortex-eval` may not depend on `cortex-memory` -- the arm adapts a system it does not own, and
there is a test asserting the dependency is absent -- so the ask **names** are declared twice:

- `packages/cortex-memory/src/prompt.ts` declares `EvidenceAsk` and `ASK_ROUTES`, which decide
  what the instruction block actually says;
- `packages/cortex-eval/src/bench-memory-arm.ts` declares its own `ASK_ROUTES`, which is what
  `readAsk` validates a dispatched value against and what the artifact's `askRoutes` comes from.

A comment beside that second copy claimed *"the product's own table is asserted equal to it."*
**Nothing asserted it.** On 2026-10-16 the value `enumerated` was added to the product's union
and its table, and to neither the arm's table nor any test -- so the type checker was satisfied,
the full gate was green, both pre-registration guards were green, and the dispatch was accepted
and then failed at startup:

    CORTEX_MEMORY_ASK must be one of "route", "extractive", "aggregate", "computed" or unset,
    got "enumerated".
        at readAsk (packages/cortex-eval/src/bench-memory-arm.ts:665:11)

The failure was fast and its record was complete -- `benchmark-error.log` named the value, the
option and the line -- which is what made the cause findable in one step. What was missing was
any check *before* the dispatch. A duplicated declaration whose parity is asserted in prose is
the same defect class as the census and the workflow guard: **the claim and the check have to be
the same thing.**

## Why this is read as source rather than imported

Because the two files are in packages that may not reference each other, and a test that ran in
one of them could only see its own copy. Reading both as text is the one place the comparison can
happen, and it is the same technique `test_dispatch_inputs.py` uses on the workflow files.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PRODUCT = ROOT / "packages" / "cortex-memory" / "src" / "prompt.ts"
ARM = ROOT / "packages" / "cortex-eval" / "src" / "bench-memory-arm.ts"


def product_values() -> set[str]:
    """The members of the product's `EvidenceAsk` union."""
    source = PRODUCT.read_text(encoding="utf-8")
    match = re.search(r"export type EvidenceAsk =([^;]+);", source)
    if match is None:
        raise AssertionError("prompt.ts declares no EvidenceAsk union")
    found = set(re.findall(r"'([^']+)'", match.group(1)))
    if not found:
        raise AssertionError(f"EvidenceAsk parsed to no members: {match.group(1)!r}")
    return found


def arm_values() -> set[str]:
    """The keys of the arm's `ASK_ROUTES` table."""
    source = ARM.read_text(encoding="utf-8")
    match = re.search(r"const ASK_ROUTES: [^=]+= \{(.*?)\n\};", source, re.S)
    if match is None:
        raise AssertionError("bench-memory-arm.ts declares no ASK_ROUTES table")
    # Keys are bare identifiers at the start of a line, optionally quoted.
    found = set(re.findall(r"^\s*'?([A-Za-z][A-Za-z0-9-]*)'?:\s*\[", match.group(1), re.M))
    if not found:
        raise AssertionError(f"ASK_ROUTES parsed to no keys: {match.group(1)[:200]!r}")
    return found


class TestTheTwoAskTablesAgree(unittest.TestCase):
    def test_the_product_and_the_arm_name_the_same_values(self) -> None:
        product = product_values()
        # The control, and it is the one that matters: a parser that matched nothing would
        # make the comparison below pass against an empty set.
        self.assertIn("route", product, f"the union parsed as {sorted(product)}")
        arm = arm_values()
        self.assertIn("route", arm, f"the table parsed as {sorted(arm)}")

        self.assertEqual(
            product,
            arm,
            "an ask value must be added to BOTH tables. The arm's copy is what `readAsk` "
            "validates a dispatched value against, so a value present in the product alone "
            "is rejected at startup with a stack trace instead of by the gate.",
        )

    def test_the_rejection_message_lists_the_union(self) -> None:
        # `readAsk` builds its message from the arm's table, so the two assertions above
        # are also what keeps that message complete -- a dispatch rejected for a value the
        # message does not list is a dispatch whose error understates the accepted set.
        source = ARM.read_text(encoding="utf-8")
        self.assertIn("Object.keys(ASK_ROUTES)", source)
