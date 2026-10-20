#!/usr/bin/env python3
"""§13.97's chain from the workflow to the ranking, held as one test.

## The defect class this is written against

The expansion has the same failure mode `test_review_pass_wiring.py` was written for, plus one
of its own. The shared half is §10.10's: a value that is **recorded** and never reaches the
decision it names -- here, an artifact line reading `queryExpansion=llm` beside a ranking built
from the bare question. The half that is specific to this treatment is **order**: the phrases
must exist before the relevance index is built, because `CortexMemory`'s `relevanceFor` is a
synchronous lookup. A run that expanded *after* the index existed would score every turn at the
index's floor and still report the treatment, which no accuracy number could distinguish from
"expansion does not help".

Six links exist and none of them is checked by a type:

1. the workflow declares `cortex_memory_query_expansion` and forwards it into the environment;
2. `bench-memory-arm.ts` reads `CORTEX_MEMORY_QUERY_EXPANSION` into `queryExpansion`;
3. `toMemoryArmConfig` projects the value -- and the measured reach -- into the artifact;
4. `report.ts` renders both on the configuration line;
5. `run-ablation.ts` calls `expandMultiSessionQueries` **before** building `relevanceCases`;
6. `relevance-index.ts` retrieves with `[question, ...queries]` rather than the question alone.

## Why source rather than behaviour

`bench/**` is an entry point excluded from coverage and the workflow is YAML: neither can be
exercised by a unit test. Reading the files as text is the technique `test_ask_table_parity.py`
uses across packages, and it is the only place all six can be seen at once.
"""

from __future__ import annotations

import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
ARM = ROOT / "packages" / "cortex-eval" / "src" / "bench-memory-arm.ts"
REPORT = ROOT / "packages" / "cortex-eval" / "src" / "report.ts"
INDEX = ROOT / "packages" / "cortex-eval" / "src" / "relevance-index.ts"
EXPANSION = ROOT / "packages" / "cortex-eval" / "src" / "query-expansion.ts"
BENCH = ROOT / "packages" / "cortex-memory" / "bench" / "run-ablation.ts"
WORKFLOW = ROOT / ".github" / "workflows" / "benchmark-cortex-memory.yml"

VARIABLE = "CORTEX_MEMORY_QUERY_EXPANSION"


class TestTheExpansionReachesTheRanking(unittest.TestCase):
    def test_the_workflow_declares_and_forwards_it(self) -> None:
        source = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn(
            "      cortex_memory_query_expansion:",
            source,
            "the input is not declared, so no dispatch can ask for the treatment",
        )
        self.assertIn(
            f"{VARIABLE}: ${{{{ github.event.inputs.cortex_memory_query_expansion }}}}",
            source,
            "the input is declared but not forwarded into the environment, so the arm reads "
            "nothing and the run is a control whose artifact says otherwise",
        )

    def test_the_arm_reads_the_variable_into_the_option(self) -> None:
        source = ARM.read_text(encoding="utf-8")
        self.assertIn(f"const QUERY_EXPANSION_VARIABLE = '{VARIABLE}';", source)
        self.assertRegex(
            source,
            r"queryExpansion:\s*readQueryExpansion\(env\[QUERY_EXPANSION_VARIABLE\]\)",
            "the arm declares the variable but does not read it into `queryExpansion`",
        )

    def test_the_option_is_rejected_rather_than_defaulted(self) -> None:
        """A value the arm does not implement must throw, not fall back to the control.

        §7.3's side-channel defect in one line: a dispatch that silently ran the control would
        publish an unchanged result reading as evidence the treatment does not matter.
        """
        source = ARM.read_text(encoding="utf-8")
        self.assertRegex(
            source,
            r"if \(!QUERY_EXPANSIONS\.includes\(trimmed\)\) \{\s*throw new Error",
            "`readQueryExpansion` accepts an unknown value, so a typo would run the control "
            "under the treatment's name",
        )

    def test_the_artifact_records_the_mode_and_the_measured_reach(self) -> None:
        arm = ARM.read_text(encoding="utf-8")
        self.assertIn("queryExpansion: options.queryExpansion ?? 'none',", arm)
        self.assertRegex(
            arm,
            r"\.\.\.\(expansion === undefined \? \{\} : \{ queryExpansionCounts: expansion \}\)",
            "the reach is not projected, so a run cannot say whether the model refused or the "
            "wiring never reached the route",
        )
        report = REPORT.read_text(encoding="utf-8")
        self.assertIn("queryExpansion=${memoryArm.queryExpansion ?? 'none'}", report)
        self.assertIn("renderExpansionCounts(memoryArm.queryExpansionCounts)", report)

    def test_the_bench_expands_before_the_index_exists(self) -> None:
        source = BENCH.read_text(encoding="utf-8")
        self.assertIn(
            "expandMultiSessionQueries(",
            source,
            "run-ablation.ts never calls the expansion, so the phrases are never written",
        )
        self.assertLess(
            source.index("expandMultiSessionQueries("),
            source.index("const relevanceCases"),
            "the expansion runs after the index is built, so every turn would score at the "
            "index's floor while the artifact reported the treatment",
        )
        self.assertIn(
            "queries: phrases",
            source,
            "the phrases are produced but not handed to `RelevanceCase.queries`, so the index "
            "retrieves with the question alone",
        )

    def test_the_index_retrieves_with_the_case_queries(self) -> None:
        source = INDEX.read_text(encoding="utf-8")
        self.assertIn(
            "const queries = [entry.question, ...(entry.queries ?? [])];",
            source,
            "the index discards `queries`, so a case's phrases never reach the retriever",
        )
        self.assertIn("const hits = await retrieve(queries, entry.context, topK);", source)
        self.assertIn("readonly queries?: readonly string[];", source)

    def test_the_reach_is_one_capability(self) -> None:
        """The route is a constant, not a parameter.

        The four untouched capabilities are this dispatch's internal control: their windows must
        reproduce the prior run to the character. A capability the caller could name would make
        that control a parameter, and a parameter is a thing a later run changes.
        """
        source = EXPANSION.read_text(encoding="utf-8")
        self.assertIn("const EXPANDED_CAPABILITY = 'MR';", source)
        self.assertIn("if (target.capability !== EXPANDED_CAPABILITY) continue;", source)


if __name__ == "__main__":
    unittest.main()
