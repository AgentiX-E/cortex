#!/usr/bin/env python3
"""The review pass's chain from the workflow to the product, held as one test.

## The defect class this is written against

§10.10 recorded it first: a configuration value that is **recorded** and does not reach the decision it
names. §13.69 met it again as a stale dispatch value, and §13.92's run met it a third time from the
other side -- an ask whose reach moved three routes while the registration assumed one.

The review pass has the worst version of the shape available to it, because the artifact's
`reviewPass=audit` line is produced by the **arm's options**, not by the product. A missing link
anywhere in this chain would publish a run that says `audit` and behaves like `none`: the accuracy
column would be the control's, every prediction would fail, and the artifact would be telling the
reader the treatment was administered.

Four links exist and none of them is checked by a type:

1. `bench-memory-arm.ts` reads `CORTEX_MEMORY_REVIEW_PASS` into `reviewPass`;
2. `run-ablation.ts` passes that value to `CortexMemory`;
3. the workflow declares the input and forwards it into the environment;
4. `CortexMemoryOptions` carries the field the product reads.

## Why source rather than behaviour

`bench/**` is an entry point and is excluded from coverage, and the workflow is YAML -- neither can be
exercised by a unit test. Reading the four files as text is the technique
`test_ask_table_parity.py` uses across packages, and it is the only place all four can be seen at
once.
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARM = ROOT / "packages" / "cortex-eval" / "src" / "bench-memory-arm.ts"
BENCH = ROOT / "packages" / "cortex-memory" / "bench" / "run-ablation.ts"
TYPES = ROOT / "packages" / "cortex-memory" / "src" / "types.ts"


def review_pass_union(source: str) -> str:
    """The right-hand side of `export type ReviewPass = ...;`, whitespace included.

    Parsed rather than string-matched because the assertion's subject is the **set of members**, and a
    declaration wrapped over several lines for readability is the same declaration. Pinning the literal
    spelling makes the test fail on a formatter's decision, which teaches a reader nothing about the wiring.
    """
    match = re.search(r"export type ReviewPass =(.+?);", source, re.S)
    if match is None:
        raise AssertionError("types.ts has no `export type ReviewPass = ...;` declaration")
    return match.group(1)


def review_passes_table(arm: str) -> str:
    """The body of the arm's `REVIEW_PASSES` table, however it is wrapped."""
    match = re.search(r"const REVIEW_PASSES: readonly string\[\] = \[(.+?)\];", arm, re.S)
    if match is None:
        raise AssertionError("bench-memory-arm.ts has no `REVIEW_PASSES` table")
    return match.group(1)
WORKFLOW = ROOT / ".github" / "workflows" / "benchmark-cortex-memory.yml"

VARIABLE = "CORTEX_MEMORY_REVIEW_PASS"


class TestTheReviewPassReachesTheProduct(unittest.TestCase):
    def test_the_arm_reads_the_variable_into_the_option(self) -> None:
        source = ARM.read_text(encoding="utf-8")
        self.assertIn(f"const REVIEW_PASS_VARIABLE = '{VARIABLE}';", source)
        self.assertRegex(
            source,
            r"reviewPass:\s*readReviewPass\(env\[REVIEW_PASS_VARIABLE\]\)",
            "the arm declares the variable but does not read it into `reviewPass`, so a dispatch "
            "would be accepted and the product would never see it",
        )

    def test_the_bench_passes_the_option_to_the_product(self) -> None:
        source = BENCH.read_text(encoding="utf-8")
        self.assertRegex(
            source,
            r"reviewPass:\s*armOptions\.reviewPass as ReviewPass",
            "run-ablation.ts does not forward `reviewPass` to `CortexMemory`, so the artifact would "
            "record a treatment the product never received -- the shape §10.10 was written for",
        )
        # A forward that is overwritten by a later key is not a forward. The spread has to be inside
        # the constructor's object literal, before the closing brace of the options.
        #
        # The anchor is `new CortexMemory({` rather than `const feature = ...` because section 14.22
        # turned the construction into a per-worker factory (`const buildFeature = (): CortexMemory
        # => new CortexMemory({`): a pool needs one instance per worker, and a shared instance under
        # concurrency attributes one question's prompt to another. The region between the literal's
        # opening and the first statement after it is what this assertion is about, so the anchor
        # follows the literal rather than the binding it used to be assigned to.
        options = source[source.index("new CortexMemory({") :]
        options = options[: options.index("// Stated before the numbers")]
        self.assertIn("reviewPass:", options)

    def test_the_workflow_declares_and_forwards_it(self) -> None:
        source = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn("      cortex_memory_review_pass:", source)
        self.assertIn(
            f"{VARIABLE}: ${{{{ github.event.inputs.cortex_memory_review_pass }}}}",
            source,
            "the input is declared but not forwarded into the environment, so the arm reads nothing "
            "and the run is a control whose artifact says otherwise",
        )

    def test_the_shipped_default_is_the_treatment_and_the_control_is_named(self) -> None:
        """The default decides what every future run measures, so it is asserted rather than assumed.

        `bare` measured +3.15 points over four runs against two controls (417/415/416/421 against
        404/399, no category lower, ABS 29/30 in all six), so it is the shipped configuration. The
        control has to be *named*: a default that equals the treatment turns every later "control" run
        into a second treatment unless the run says `none`, and that failure is silent -- the artifact
        would carry a config line nobody re-read.

        The default lives here rather than in the library on purpose. `readReviewPass` returns `none`
        for an unset variable, which is the smallest assumption a library can make; the dispatch layer
        is where a project decides what it ships.
        """
        source = WORKFLOW.read_text(encoding="utf-8")
        start = source.index("      cortex_memory_review_pass:")
        end = source.index("      cortex_memory_query_expansion:")
        block = source[start:end]
        self.assertIn("default: 'bare'", block)
        # And the description says which value is the control, because a reader of the dispatch form
        # has to know that `none` is the comparison rather than an absence.
        self.assertIn("`none` is the control", block)

    def test_the_product_carries_the_field(self) -> None:
        source = TYPES.read_text(encoding="utf-8")
        self.assertRegex(source, r"reviewPass\?:\s*ReviewPass;")
        # The union gained `tally` in round 61 and `spec` in round 63 and `supersede` in round 65, each a
        # value of this field rather than an input of its own because the workflow sits at 24 of its 25
        # dispatch inputs. Read by parsing rather than by matching the whole declaration string: a test that
        # pins the formatting fails when the list is wrapped across lines for a reason that is not about the
        # members, which is exactly what happened when `supersede` made the line too long to read.
        members = set(re.findall(r"'([a-z-]+)'", review_pass_union(source)))
        self.assertIn('none', members)
        self.assertGreaterEqual(len(members), 2)

    def test_the_arm_can_dispatch_every_value_the_product_implements(self) -> None:
        # Two lists that have to agree member by member: a value the product implements but the arm
        # rejects is a mechanism nobody can dispatch, and a value the arm accepts but the product does
        # not implement is a run that fails at the boundary.
        arm = ARM.read_text(encoding="utf-8")
        types = TYPES.read_text(encoding="utf-8")
        product = set(re.findall(r"'([a-z-]+)'", review_pass_union(types)))
        dispatchable = set(re.findall(r"'([a-z-]+)'", review_passes_table(arm)))
        # `bare` is the one asymmetry with a reason: it is a value of the arm's own switch that the product
        # spells as `reviewBareDecline`, so the arm's table is the product's union plus that name.
        self.assertEqual(dispatchable, product | {'bare'})


if __name__ == "__main__":
    unittest.main()
