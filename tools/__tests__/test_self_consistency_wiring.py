#!/usr/bin/env python3
"""§13.101's chain from the workflow to the vote, held as one test.

## The defect class this is written against

The one `test_review_pass_wiring.py` names, plus a second that is specific to voting: a run can
administer the treatment and still be unreadable. The artifact's `selfConsistency=3` line is produced
by the **arm's options**, while the consultations happen in the **product**, and the census that makes
the mechanism checkable (`vote=u/m/s`) is produced by a third layer that reads the product after the
ablation. A missing link anywhere in that chain publishes a run claiming a treatment with no way to
tell a vote that never disagreed from one that never ran.

Seven links exist and none of them is checked by a type:

1. the workflow declares `cortex_memory_self_consistency` and forwards it into the environment;
2. `bench-memory-arm.ts` reads `CORTEX_MEMORY_SELF_CONSISTENCY` into `selfConsistency`;
3. `toMemoryArmConfig` projects the value into the artifact;
4. `report.ts` renders it, and renders the census beside it;
5. `run-ablation.ts` converts the name to the product's number and passes it;
6. the product carries the field and refuses a count it cannot honour;
7. `#promptSessionAware` samples on the multi-session route only.

## Why source rather than behaviour

`bench/**` is an entry point excluded from coverage and the workflow is YAML: neither can be
exercised by a unit test. Reading the files as text is the technique `test_ask_table_parity.py` uses
across packages, and it is the only place all seven can be seen at once.
"""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARM = ROOT / "packages" / "cortex-eval" / "src" / "bench-memory-arm.ts"
REPORT = ROOT / "packages" / "cortex-eval" / "src" / "report.ts"
BENCH = ROOT / "packages" / "cortex-memory" / "bench" / "run-ablation.ts"
MEMORY = ROOT / "packages" / "cortex-memory" / "src" / "memory.ts"
TYPES = ROOT / "packages" / "cortex-memory" / "src" / "types.ts"
WORKFLOW = ROOT / ".github" / "workflows" / "benchmark-cortex-memory.yml"

VARIABLE = "CORTEX_MEMORY_SELF_CONSISTENCY"


class TestTheSampleCountReachesTheVote(unittest.TestCase):
    def test_the_workflow_declares_and_forwards_it(self) -> None:
        source = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn(
            "      cortex_memory_self_consistency:",
            source,
            "the input is not declared, so no dispatch can ask for the treatment",
        )
        self.assertIn(
            f"{VARIABLE}: ${{{{ github.event.inputs.cortex_memory_self_consistency }}}}",
            source,
            "the input is declared but not forwarded into the environment, so the arm reads nothing "
            "and the run is a control whose artifact says otherwise",
        )

    def test_the_arm_reads_the_variable_into_the_option(self) -> None:
        source = ARM.read_text(encoding="utf-8")
        self.assertIn(f"const SELF_CONSISTENCY_VARIABLE = '{VARIABLE}';", source)
        self.assertRegex(
            source,
            r"selfConsistency:\s*readSelfConsistency\(env\[SELF_CONSISTENCY_VARIABLE\]\)",
            "the arm declares the variable but does not read it into `selfConsistency`",
        )

    def test_the_option_is_rejected_rather_than_clamped(self) -> None:
        source = ARM.read_text(encoding="utf-8")
        self.assertRegex(
            source,
            r"if \(!SELF_CONSISTENCY_COUNTS\.includes\(trimmed\)\) \{\s*throw new Error",
            "`readSelfConsistency` accepts an unknown count, so a run could consult a number it did "
            "not report -- or report one it did not consult",
        )

    def test_the_artifact_records_the_mode_and_the_census(self) -> None:
        arm = ARM.read_text(encoding="utf-8")
        self.assertIn("selfConsistency: options.selfConsistency ?? 'none',", arm)
        self.assertRegex(
            arm,
            r"vote\.voteCounts === undefined \|\| report\.memoryArmConfig === undefined",
            "the census is never read from the feature system, so a run could not say whether its "
            "votes ever disagreed",
        )
        self.assertIn("function voteCountsOf(", arm)
        report = REPORT.read_text(encoding="utf-8")
        self.assertIn("selfConsistency=${memoryArm.selfConsistency ?? 'none'}", report)
        self.assertIn("renderVoteCounts(memoryArm.voteCounts)", report)

    def test_the_bench_passes_a_number_to_the_product(self) -> None:
        source = BENCH.read_text(encoding="utf-8")
        self.assertIn(
            "selfConsistency: Number(armOptions.selfConsistency)",
            source,
            "the arm's name never becomes the product's count, so a dispatch of `3` would consult "
            "once while the artifact reported three -- the §10.10 shape",
        )
        self.assertIn("armOptions.selfConsistency === 'none'", source)

    def test_the_product_carries_the_field_and_refuses_a_bad_count(self) -> None:
        types = TYPES.read_text(encoding="utf-8")
        self.assertRegex(types, r"selfConsistency\?:\s*number;")
        memory = MEMORY.read_text(encoding="utf-8")
        self.assertIn("if (!Number.isInteger(options.selfConsistency)", memory)
        self.assertIn("cannot both be on", memory)

    def test_the_sampling_lives_on_the_multi_session_route(self) -> None:
        memory = MEMORY.read_text(encoding="utf-8")
        self.assertIn("const samples = this.#options.selfConsistency ?? 1;", memory)
        # The loop and the vote must be inside `#promptSessionAware`, which is the method only
        # `answerSessions` reaches. A vote added to `#consult` would reach all six routes and turn
        # the four-capability control into a treated set.
        start = memory.index("async #promptSessionAware(")
        end = memory.index("async #consult(")
        body = memory[start:end]
        self.assertIn("voteAnswers(answers)", body)
        # The constructor reads the option and refuses a bad count; what must NOT read it is
        # anything below the sampling method, because `#consult` and the single-call routes are
        # reached by every route. The assertion is on the **read** (`this.#options.`) rather than
        # on the word, so a doc comment above `#recordOutcome` cannot fail a guard about reach.
        self.assertNotIn("this.#options.selfConsistency", memory[end:])


if __name__ == "__main__":
    unittest.main()
