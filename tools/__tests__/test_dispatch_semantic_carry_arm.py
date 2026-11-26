#!/usr/bin/env python3
"""The semantic-carry dispatcher sends the registered arm, and the pairing decides the pass.

## The defect this file is written against

`tools/arm-config-guard.mjs` reads the **workflows** and the gate that compares them is the reason
`semantic-carry.yml` no longer sends `temporal: 48000`. What it does not read is the **dispatchers**,
and a dispatcher is a fourth copy of the same numbers: it spells every input out, on purpose, so that
"a workflow default that moved would show up as a diff in this file rather than as a run nobody can
explain."

That diff did not show up. The workflow's `thinking` default moved from `disabled` to the registered
`multi-session+temporal` -- and the movement is documented inside the workflow, in the paragraph that
records the 87.00% reading taken with thinking off -- while this script kept sending `disabled`. So
every dispatch from it would have measured a reader the product does not ship, and the only place the
contradiction could be seen was a reader comparing two files by hand.

`review_pass` is the same shape and a worse consequence. The workflow defaulted it to `supersede`
because `pairing=carry` needs the absorbing pass, and every other pairing inherited it. `pairing=ask`
exists to price the shipped instruction block on the shipped rendering; under the absorbing pass it
would have priced the block on an arm no reading has ever shipped.

## What is asserted, and what is deliberately not

Three things, and the third is the general one:

1. the pass is a **function of the pairing** -- `supersede` for `carry` and the registered `bare` for
   every other pairing -- so the exception lives where it is made;
2. the reader the script sends is the reader the registration records;
3. every input the script writes whose name the registry owns equals the registry's value, so the
   next drift is a red build rather than a paragraph.

Not asserted: that the population (`capability`, `windows`, `limit`) or the shape (`shards`,
`workers`, `budget_cny`) is right. Those are the judgement each dispatch makes, and refusing one
would make the test fail for a legitimate experiment rather than for a defect -- the same line
`test_dispatch_inputs.py` draws for values it does not read.
"""

from __future__ import annotations

import importlib.util
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "tools" / "dispatch-semantic-carry.py"
BASELINE = ROOT / "tools" / "arm-config-baseline.json"
WORKFLOW = ROOT / ".github" / "workflows" / "semantic-carry.yml"

# The script's input names against the names `tools/arm-config-baseline.json` records. Only the four
# that exist on both sides: the rest of the table is population and shape, which the registry does not
# describe. `turn_rendering` is absent on purpose -- it is a selector whose `head` value means
# `max_turn_chars: '400'`, so comparing the two strings would compare a menu entry with a number.
REGISTRY_OWNED = {
    "ask": "cortex_memory_ask",
    "review_pass": "cortex_memory_review_pass",
    "thinking": "thinking",
    "model": "model",
}


def _module():  # noqa: ANN202 - the dispatch script, imported by path
    spec = importlib.util.spec_from_file_location("dispatch_semantic_carry", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _registered() -> dict[str, str]:
    return json.loads(BASELINE.read_text(encoding="utf-8"))["dispatch"]


def _input_default(name: str) -> str:
    """The `default:` the workflow declares for one input.

    Read from the `workflow_dispatch` block and matched to the input's own stanza, because a
    file-wide search for `default:` returns the first input's value for every question.
    """
    source = WORKFLOW.read_text(encoding="utf-8")
    block = re.search(r"workflow_dispatch:\n(.*?)\npermissions:", source, re.S)
    if block is None:
        raise AssertionError("semantic-carry.yml has no workflow_dispatch block")
    stanza = re.search(
        rf"^      {re.escape(name)}:\n(.*?)(?=^      [a-z_][a-z0-9_]*:\n|\Z)",
        block.group(1),
        re.S | re.M,
    )
    if stanza is None:
        raise AssertionError(f"semantic-carry.yml declares no {name} input")
    default = re.search(r"^        default: (.+)$", stanza.group(1), re.M)
    if default is None:
        raise AssertionError(f"semantic-carry.yml's {name} input declares no default")
    return default.group(1).strip().strip("'\"")


class TestTheDispatchersReader(unittest.TestCase):
    def test_the_script_sends_the_registered_reader(self) -> None:
        # The drift this test exists for: the workflow moved, the script did not.
        module = _module()
        self.assertEqual(module.INPUTS["thinking"], _registered()["thinking"])

    def test_the_workflow_and_the_script_agree_on_the_reader(self) -> None:
        # Two copies, one question. A reader that differs between them is a dispatch whose log
        # describes a run the workflow does not perform.
        module = _module()
        self.assertEqual(_input_default("thinking"), module.INPUTS["thinking"])


class TestThePassIsAFunctionOfThePairing(unittest.TestCase):
    def test_the_table_holds_the_registered_pass(self) -> None:
        module = _module()
        self.assertEqual(module.INPUTS["review_pass"], _registered()["cortex_memory_review_pass"])

    def test_a_carry_is_administered_on_the_absorbing_pass(self) -> None:
        module = _module()
        self.assertEqual(module.arm_inputs(["pairing=carry"])["review_pass"], "supersede")

    def test_every_other_pairing_is_administered_on_the_shipped_pass(self) -> None:
        # The five pairings are a closed set the arm itself refuses an unknown value for, so this
        # enumerates the union rather than naming the two that came up.
        module = _module()
        for pairing in module.PAIRINGS:
            if pairing == "carry":
                continue
            with self.subTest(pairing=pairing):
                self.assertEqual(
                    module.arm_inputs([f"pairing={pairing}"])["review_pass"],
                    _registered()["cortex_memory_review_pass"],
                )

    def test_an_operator_who_states_the_pass_keeps_it(self) -> None:
        # Pricing the absorbing pass on a route without supersession is a legitimate experiment, and
        # the script's stated rule is to refuse silent values rather than unwise ones.
        module = _module()
        inputs = module.arm_inputs(["pairing=ask", "review_pass=supersede"])
        self.assertEqual(inputs["review_pass"], "supersede")

    def test_the_derivation_reads_the_pairing_after_the_overrides(self) -> None:
        # `--set pairing=carry` on the table's own `reference` has to reach the derivation: an order
        # that ran it before the overrides would send `bare` to a carry and let the arm refuse a run
        # the operator asked for correctly.
        module = _module()
        inputs = module.arm_inputs(["pairing=carry"])
        self.assertEqual(inputs["pairing"], "carry")
        self.assertEqual(inputs["review_pass"], "supersede")


class TestTheRegistryOwnsWhatTheScriptWrites(unittest.TestCase):
    def test_every_registry_owned_input_is_the_registered_value(self) -> None:
        # The general assertion, and the one that covers the next field added to both files. The
        # exemption list is empty rather than short: a departure that a *pair* has to make is a
        # function of the pairing (asserted above), and everything else this script sends is
        # population or shape, which the registry does not describe.
        module = _module()
        inputs = module.arm_inputs([f"pairing={pairing}" for pairing in module.PAIRINGS])
        registered = _registered()
        for word, field in REGISTRY_OWNED.items():
            with self.subTest(input=word):
                self.assertEqual(inputs[word], registered[field])

    def test_the_ask_preset_prices_the_shipped_arm(self) -> None:
        # The preset this round dispatches: `pairing=ask` on `MR`, two windows, two repetitions. Its
        # only departures are the repetition count (a pair is two by construction) and the
        # population -- so every field the registry owns has to be the shipped value, or the reading
        # is a price for an arm nobody ships.
        module = _module()
        inputs = module.arm_inputs(
            [
                "pairing=ask",
                "ask=verbatim-acts",
                "capability=MR",
                "windows=2",
                "ablation_runs=2",
                "limit=0",
            ]
        )
        registered = _registered()
        for word, field in REGISTRY_OWNED.items():
            with self.subTest(input=word):
                self.assertEqual(inputs[word], registered[field])
        self.assertEqual(inputs["capability"], "MR")
        self.assertEqual(inputs["windows"], "2")


class TestTheWorkflowDefault(unittest.TestCase):
    def test_the_workflows_pass_default_is_the_registered_one(self) -> None:
        # The guard resolves `${{ inputs.review_pass }}` through this default, so a default that
        # departed would have to carry an exemption -- and an exemption printed on every green run is
        # a departure that is not being made.
        self.assertEqual(_input_default("review_pass"), "bare")
        self.assertEqual(_input_default("review_pass"), _registered()["cortex_memory_review_pass"])

    def test_the_workflow_carries_no_exemption_for_the_pass(self) -> None:
        source = WORKFLOW.read_text(encoding="utf-8")
        self.assertNotIn("arm-config: CORTEX_MEMORY_REVIEW_PASS departs", source)

    def test_the_carry_preflight_refuses_another_pass(self) -> None:
        # What makes the derivation safe rather than merely stated: a carry on `bare` is refused in
        # ten seconds, before the corpus download and before the first model call.
        source = WORKFLOW.read_text(encoding="utf-8")
        self.assertIn('if [ "${PAIRING}" = "carry" ] && [ "${PASS}" != "supersede" ]', source)


if __name__ == "__main__":
    unittest.main()
