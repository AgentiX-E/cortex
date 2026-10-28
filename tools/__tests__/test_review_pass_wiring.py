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
        options = source[source.index("const feature = new CortexMemory({") :]
        options = options[: options.index("\n  });")]
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
        # The union gained `recover` in step 23. Pinned as the full member list rather than as a
        # count, because the assertion's subject is "the product carries the values the arm can
        # dispatch", and a dispatch of a value the product does not implement is rejected at the
        # arm's boundary -- so the two lists have to agree member by member.
        self.assertIn("export type ReviewPass = 'none' | 'audit' | 'recover';", source)


if __name__ == "__main__":
    unittest.main()
