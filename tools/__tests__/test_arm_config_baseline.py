#!/usr/bin/env python3
"""The baseline is a third column, so a stale pair cannot agree its way past the gate.

## What was missing, stated as the shape that produced three defects

`test_preregistration_config.py` compares §10.3 of
`docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` with `tools/dispatch-cortex-memory-ab.py`'s `INPUTS`.
Both are hand-edited. When both go stale in the same direction the comparison is green forever, and
the only remaining witness is an artifact — 87 MB, downloaded by hand, compared by
`readout-arm-run.py --registration` when somebody remembers.

That has now happened three times on one concept. §13.69 cancelled a run dispatched on `retrieval`
because §10.3 held two statements of `relevanceSignal`. §13.203 found `enumerated` in both copies
while every run sent `operands`. §13.327 finds `verbatim` in both copies while every 500-question
run from `42337560027` sends `verbatim-acts`. Each time the pair agreed; each time the runs did not.

`tools/arm-config-record.py` turns one artifact into `tools/arm-config-baseline.json` — the
projection of its `memoryArmConfig` onto the dispatch's input names — and this file pins the tool.
The gate itself is `python3 tools/arm-config-record.py --check`, wired into `pnpm check`; these
tests exist because a comparison that silently compares nothing looks exactly like a passing one.

## Why the injections are on a copied dict

Every failure test mutates a structure and asserts on the message. Asserting against the real files
would only ever exercise the green state, and the green state is the one that has been wrong three
times — a guard that cannot be shown to bite on the defect it was written for is a comment with a
stack trace.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "arm-config-record.py"
BASELINE = ROOT / "tools" / "arm-config-baseline.json"


def load_tool():
    """The module, by path: the filename has hyphens and `import` will not take it."""
    spec = importlib.util.spec_from_file_location("arm_config_record", TOOL)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


tool = load_tool()


def baseline() -> dict:
    return json.loads(BASELINE.read_text(encoding="utf-8"))


class TestThePartitionIsComplete(unittest.TestCase):
    """Every field of a real `memoryArmConfig` is either projected or explained.

    Without the reverse direction a new arm option lands in the artifact, is absent from both
    classes, and the projection keeps passing over a value nobody decided about — which is exactly
    how `ask` drifted. `--record` refuses such an artifact; this asserts the refusal is reachable
    and that today's recorded artifact is not in that state.
    """

    def test_every_recorded_field_is_classified(self) -> None:
        config = baseline()["memoryArmConfig"]
        self.assertEqual(tool.unclassified(config), [])

    def test_the_fingerprint_is_a_function_of_the_configuration_beside_it(self) -> None:
        # The baseline carries `memoryArmConfig` verbatim and the fingerprint of it, and the fingerprint is
        # the value two acceptance rows and the frontier's shipping block compare against. If the two ever
        # disagree, every row goes stale at once and the repair looks like a re-record rather than the
        # one-line correction it would be -- so the invariant is asserted here, where the file is read.
        recorded = baseline()
        self.assertEqual(
            tool.fingerprint(recorded["memoryArmConfig"]),
            recorded["memoryArmConfigFingerprint"],
        )

    def test_the_two_classes_do_not_overlap(self) -> None:
        overlap = set(tool.PROJECTED) & set(tool.UNPROJECTED)
        self.assertEqual(
            overlap,
            set(),
            "a field in both classes makes the partition ambiguous: one entry would be compared "
            "and the other would excuse it, and which one wins is reading order.",
        )

    def test_an_unknown_field_is_refused_and_the_message_names_it(self) -> None:
        report = {
            "memoryArmConfig": {"ask": "verbatim-acts", "sessionVote": "off"},
            "generatedAt": "1970-01-01T00:00:00.000Z",
            "dataset": "longmemeval",
            "datasetFingerprint": "sha256:0",
            "questionCount": 500,
            "runs": 4,
        }
        with self.assertRaises(SystemExit) as caught:
            tool.record(report, run="1", commit="0" * 8, adopted_by="1.1", why="a probe")
        self.assertIn("sessionVote", str(caught.exception))

    def test_every_projected_renderer_exists(self) -> None:
        # A typo in a renderer name would not fail at import: it would fail the first time somebody
        # recorded a baseline, i.e. at the one moment the tool is being trusted to write the record.
        for field, (_input, renderer) in tool.PROJECTED.items():
            with self.subTest(field=field):
                self.assertIn(renderer, tool.RENDERERS)


class TestTheBaselineAgreesWithTheTable(unittest.TestCase):
    def test_today_they_agree(self) -> None:
        found = tool.differences(baseline(), tool.dispatched())
        self.assertEqual(found, [], "\n".join(found))

    def test_a_stale_table_is_reported_with_both_values(self) -> None:
        table = tool.dispatched()
        table["cortex_memory_ask"] = "verbatim"
        found = tool.differences(baseline(), table)
        self.assertEqual(len(found), 1, found)
        # Both values, because the reader's next decision is which side to move and the message is
        # all they have. `verbatim` is the value this line held for four concepts.
        self.assertIn("verbatim", found[0])
        self.assertIn("verbatim-acts", found[0])
        self.assertIn("cortex_memory_ask", found[0])

    def test_a_value_the_projection_lost_is_reported(self) -> None:
        recorded = copy.deepcopy(baseline())
        del recorded["dispatch"]["cortex_memory_relevance_top_k"]
        found = tool.differences(recorded, tool.dispatched())
        self.assertEqual(len(found), 1, found)
        self.assertIn("cortex_memory_relevance_top_k", found[0])

    def test_a_key_the_table_stopped_sending_is_reported(self) -> None:
        table = tool.dispatched()
        del table["cortex_memory_evidence_roles_routes"]
        found = tool.differences(baseline(), table)
        self.assertEqual(len(found), 1, found)
        self.assertIn("cortex_memory_evidence_roles_routes", found[0])

    def test_the_exemption_list_is_exactly_the_decisions_on_record(self) -> None:
        # An exemption is a decision somebody has to make in a diff, which is the point: the list is
        # short enough to read and any addition shows up here as a failing test rather than as a
        # silently narrowing comparison. `capability` joined it in round 57, when a comparison between
        # two artifacts made a run-level selector look like a configuration field.
        self.assertEqual(sorted(tool.TABLE_ONLY), ["capability", "cortex_memory", "limit"])
        table = tool.dispatched()
        for name in tool.TABLE_ONLY:
            with self.subTest(input=name):
                self.assertIn(
                    name,
                    table,
                    f"{name} is exempted from the projection and the table no longer sends it, so "
                    "the exemption has outlived its subject.",
                )

    def test_a_fixed_input_is_exempt_from_the_projection_and_still_recorded(self) -> None:
        # The mirror image of `TABLE_ONLY`: `temperature` is in the artifact and not in the table. It is
        # exempt because the arm builds the reader at 0 rather than because a dispatch sends it, and the
        # exemption is asserted in the other direction -- an exemption whose subject the table has since
        # started sending is one that has outlived its reason.
        self.assertEqual(sorted(tool.FIXED), ["temperature"])
        recorded = tool.project(baseline())
        self.assertIn("temperature", recorded)
        self.assertNotIn("temperature", tool.dispatched())

    def test_an_exemption_whose_key_is_gone_is_reported(self) -> None:
        table = tool.dispatched()
        del table["limit"]
        found = tool.differences(baseline(), table)
        self.assertEqual(len(found), 1, found)
        self.assertIn("outlived its subject", found[0])


class TestProvenanceIsTraceable(unittest.TestCase):
    def test_the_baseline_names_a_run_and_a_section(self) -> None:
        gaps = tool.provenance_gaps(baseline())
        self.assertEqual(gaps, [], "\n".join(gaps))

    def test_a_missing_run_id_is_a_gap(self) -> None:
        recorded = baseline()
        recorded["run"] = ""
        self.assertIn("run", " ".join(tool.provenance_gaps(recorded)))

    def test_a_section_that_does_not_exist_is_a_gap(self) -> None:
        recorded = baseline()
        recorded["adoptedBy"] = "13.999.9"
        gaps = tool.provenance_gaps(recorded)
        self.assertEqual(len(gaps), 1, gaps)
        self.assertIn("13.999.9", gaps[0])


class TestTheRenderersSpeakTheArtifactsShapes(unittest.TestCase):
    def test_an_integral_float_is_rendered_as_an_integer(self) -> None:
        # The table writes `'0'` and the artifact records `0`; a JSON round-trip can turn the
        # former into `0.0`, and `"0"` against `"0.0"` would be a defect report about formatting.
        self.assertEqual(tool.RENDERERS["number"](0.0), "0")
        self.assertEqual(tool.RENDERERS["number"](48460.0), "48460")
        self.assertEqual(tool.RENDERERS["number"](0.5), "0.5")

    def test_route_rooms_render_in_a_fixed_order(self) -> None:
        forward = tool.RENDERERS["route_rooms"]({"multi-session": 48460, "temporal": 48000})
        backward = tool.RENDERERS["route_rooms"]({"temporal": 48000, "multi-session": 48460})
        self.assertEqual(forward, "multi-session:48460,temporal:48000")
        self.assertEqual(forward, backward, "object order is not a configuration difference")

    def test_thinking_renders_the_inputs_grammar_not_a_comma(self) -> None:
        # `readThinkingReach` separates routes with `+` and refuses a comma by name, because a
        # comma-separated reach would be one route called "multi-session,temporal".
        render = tool.RENDERERS["reader_thinking"]
        self.assertEqual(
            render({"thinking": "enabled", "thinkingRoutes": ["multi-session", "temporal"]}),
            "multi-session+temporal",
        )
        self.assertEqual(render({"thinking": "disabled"}), "disabled")

    def test_the_reader_object_projects_four_inputs(self) -> None:
        projected = tool.project(
            {
                "memoryArmConfig": {
                    "reader": {
                        "model": "deepseek-chat",
                        "temperature": 0,
                        "thinking": "enabled",
                        "thinkingRoutes": ["multi-session", "temporal"],
                    }
                },
                "runs": 4,
            }
        )
        self.assertEqual(projected["model"], "deepseek-chat")
        self.assertEqual(projected["temperature"], "0")
        self.assertEqual(projected["thinking"], "multi-session+temporal")
        self.assertEqual(projected["ablation_runs"], "4")


class TestTheGateItself(unittest.TestCase):
    def test_the_check_mode_exits_zero_on_the_repository(self) -> None:
        # The end-to-end path, through `main` rather than through the functions it calls: a wiring
        # error between the two would leave every unit above green and `pnpm check` blind.
        self.assertEqual(tool.main(["--check"]), 0)

    def test_the_check_mode_exits_non_zero_on_a_drifted_table(self) -> None:
        # The drift has to be fed through a file, because `--check` reads the table from a path.
        # Written to a temporary location so a test never mutates the repository's own table.
        import tempfile

        table = tool.dispatched()
        table["cortex_memory_ask"] = "verbatim"
        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as handle:
            handle.write("INPUTS = {\n")
            for name, value in sorted(table.items()):
                handle.write(f'    "{name}": "{value}",\n')
            handle.write("}\n")
            drifted = Path(handle.name)
        try:
            self.assertEqual(tool.main(["--check", "--dispatch", str(drifted)]), 1)
        finally:
            drifted.unlink()


if __name__ == "__main__":
    unittest.main()
