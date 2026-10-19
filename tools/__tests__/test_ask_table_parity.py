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

## This file was itself lost, and the claim it guards went stale with it

On 2026-10-19 the source of this module was absent from the tree while its bytecode remained in
`__pycache__`, so the guard did not run -- and `bench-memory-arm.ts` went on saying that it did.
That is the same defect this module was written for, one level up: **a sentence asserting an
assertion that no longer exists.** It is restored here from its own compiled form, with the same
two tests and the same regexes, because a guard is only a guard while it is collected.

The restoration also adds the route tables (§13.73's reach), which are the second declaration of
a shared vocabulary and therefore the same hazard: the arm and the product must name the same
six routes, or a dispatched reach will be rejected at startup -- or, worse, accepted while
meaning something else.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PRODUCT = ROOT / "packages" / "cortex-memory" / "src" / "prompt.ts"
PRODUCT_TYPES = ROOT / "packages" / "cortex-memory" / "src" / "types.ts"
ARM = ROOT / "packages" / "cortex-eval" / "src" / "bench-memory-arm.ts"


def product_values() -> set[str]:
    """The members of the product's `EvidenceAsk` union."""
    source = PRODUCT.read_text(encoding="utf-8")
    union = re.search(r"export type EvidenceAsk =([^;]+);", source)
    if union is None:
        raise AssertionError("prompt.ts declares no EvidenceAsk union")
    members = set(re.findall(r"'([^']+)'", union.group(1)))
    if not members:
        raise AssertionError(f"EvidenceAsk parsed to no members: {union.group(1)[:200]}")
    return members


def arm_values() -> set[str]:
    """The keys of the arm's `ASK_ROUTES` table."""
    source = ARM.read_text(encoding="utf-8")
    table = re.search(r"const ASK_ROUTES: [^=]+= \{(.*?)\n\};", source, re.S)
    if table is None:
        raise AssertionError("bench-memory-arm.ts declares no ASK_ROUTES table")
    keys = set(re.findall(r"^\s*'?([A-Za-z][A-Za-z0-9-]*)'?:\s*\[", table.group(1), re.M))
    if not keys:
        raise AssertionError(f"ASK_ROUTES parsed to no keys: {table.group(1)[:200]}")
    return keys


def product_routes() -> set[str]:
    """The members of the product's `TURN_CAP_ROUTES` list.

    A `const` array rather than a union, because the value has to exist at runtime to be compared
    against a dispatched reach. Read from `types.ts`, where the union and the list sit together so
    that a member cannot be added to one and not the other without this test noticing.
    """
    source = PRODUCT_TYPES.read_text(encoding="utf-8")
    block = re.search(r"export const TURN_CAP_ROUTES = \[(.*?)\] as const;", source, re.S)
    if block is None:
        raise AssertionError("types.ts declares no TURN_CAP_ROUTES list")
    members = set(re.findall(r"'([A-Za-z-]+)'", block.group(1)))
    if not members:
        raise AssertionError(f"TURN_CAP_ROUTES parsed to no members: {block.group(1)[:200]}")
    return members


def arm_routes() -> set[str]:
    """The keys of the arm's `TURN_CAP_ROUTES` table."""
    source = ARM.read_text(encoding="utf-8")
    table = re.search(r"const TURN_CAP_ROUTES: [^=]+= \{(.*?)\n\};", source, re.S)
    if table is None:
        raise AssertionError("bench-memory-arm.ts declares no TURN_CAP_ROUTES table")
    keys = set(re.findall(r"^\s*'?([A-Za-z][A-Za-z0-9-]*)'?:\s*", table.group(1), re.M))
    if not keys:
        raise AssertionError(f"TURN_CAP_ROUTES parsed to no keys: {table.group(1)[:200]}")
    return keys


class TestTheTwoAskTablesAgree(unittest.TestCase):
    def test_the_product_and_the_arm_name_the_same_values(self) -> None:
        self.assertEqual(
            sorted(product_values()),
            sorted(arm_values()),
            f"the union parsed as {sorted(product_values())} and the table as "
            f"{sorted(arm_values())} -- an ask value must be added to BOTH tables. The arm's "
            "copy is what `readAsk` validates a dispatched value against, so a value present "
            "in the product alone is rejected at startup with a stack trace instead of by the "
            "gate.",
        )

    def test_the_rejection_message_lists_the_union(self) -> None:
        # `route` is the shipped default and must be accepted, so it is the one member whose
        # absence would be invisible: a table that dropped it would still pass the equality
        # test if the union dropped it too.
        self.assertIn("route", product_values())
        source = ARM.read_text(encoding="utf-8")
        self.assertIn("Object.keys(ASK_ROUTES)", source)


class TestTheTwoRouteTablesAgree(unittest.TestCase):
    """§13.73's reach vocabulary, which is the second duplicated declaration.

    The reach is dispatched as a comma-separated list and validated against the arm's table, so a
    route the product knows and the arm does not is rejected at startup -- and a route the arm
    knows and the product does not would be accepted, recorded in the artifact, and silently
    ignore the cap. The second direction is the one no run can detect.
    """

    def test_the_product_and_the_arm_name_the_same_routes(self) -> None:
        self.assertEqual(
            sorted(product_routes()),
            sorted(arm_routes()),
            f"the product lists {sorted(product_routes())} and the arm {sorted(arm_routes())}. "
            "A route belongs to both or to neither: the arm's list is what a dispatched reach "
            "is validated against, and the product's is what the cap actually reaches.",
        )

    def test_the_config_lines_all_shorthand_matches_the_vocabulary(self) -> None:
        # `report.ts` renders the whole vocabulary as `all` and decides that by COUNT, because it
        # needs only "is this everything" and a third copy of the six names would be a third place
        # to forget. The count is therefore a claim about the vocabulary, and this is what keeps it
        # true: a seventh route makes the equality below fail instead of silently printing `all`
        # for a five-route reach.
        source = (ROOT / "packages" / "cortex-eval" / "src" / "report.ts").read_text(
            encoding="utf-8"
        )
        declared = re.search(r"const TURN_CAP_ROUTE_COUNT = (\d+);", source)
        self.assertIsNotNone(declared, "report.ts declares no TURN_CAP_ROUTE_COUNT")
        self.assertEqual(int(declared.group(1)), len(product_routes()))

    def test_the_reach_covers_every_route_a_prompt_is_built_for(self) -> None:
        # The six routes are the six prompt-building paths in `memory.ts`. A seventh added
        # without a route name would be a path the cap cannot be aimed at, which is a silent
        # hole rather than a compile error -- the builders take the route as an argument, but
        # nothing forces a new one to exist in this vocabulary.
        self.assertEqual(
            sorted(product_routes()),
            sorted(
                ['multi-session', 'temporal', 'flat', 'knowledge-update', 'abstention', 'assistant']
            ),
        )


if __name__ == "__main__":
    unittest.main()
