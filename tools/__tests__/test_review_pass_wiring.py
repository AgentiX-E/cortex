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

    def test_the_product_carries_the_field(self) -> None:
        source = TYPES.read_text(encoding="utf-8")
        self.assertRegex(source, r"reviewPass\?:\s*ReviewPass;")
        self.assertIn("export type ReviewPass = 'none' | 'audit';", source)


if __name__ == "__main__":
    unittest.main()
