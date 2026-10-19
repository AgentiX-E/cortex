#!/usr/bin/env python3
"""The dispatch must send the configuration the pre-registration registered.

## The defect this file is written against

`test_dispatch_inputs.py` guards two directions: every key a dispatch script sends is
a declared `workflow_dispatch` input, and every declared input has an `env:` forward.
Both passed on the day `dispatch-cortex-memory-ab.py` was sent carrying
`cortex_memory_retrieval_threshold: '0'` while
`PREREGISTRATION-CORTEX-MEMORY-ARM.md` §10.3 registered `retrievalThreshold: 0.25`.

That is the fourth form of the §7.3 side-channel defect, and it is the one the
existing file cannot see:

| Form | Wrong where | Caught by |
| --- | --- | --- |
| 1 | input not declared in the workflow | `test_dispatch_inputs.py` |
| 2 | declared but not forwarded into `env` | `test_dispatch_inputs.py` |
| 3 | forwarded but never read by the arm | `bench-memory-arm.test.ts` |
| 4 | **read correctly, but the dispatch never sends the registered value** | **this file** |

In form 4 every layer works. The run succeeds, the log line prints, the artifact
records a configuration -- just not the registered one. §10.6's precondition names
`sourceTrust=0.5` alone, so a run whose `retrievalThreshold` disagreed would satisfy
the precondition and still be unreproducible against its own registration.

## Why the values are read from the document

The document is the authority. A test that restated `0.25` in Python would be a third
copy of the number, and the copy would be updated in whichever file the person
changing it happened to open first -- so the test would keep passing while the
registration and the dispatch drifted apart, which is the defect again. Reading §10.3
means an edit to the registration that is not mirrored in the dispatch fails here,
and an edit to the dispatch that is not mirrored in the registration fails here too.

## What it deliberately does not check

Whether the registered values are *correct*. That is §10.3's argument to make, and
asserting an opinion about `0.25` here would make the test fail for a legitimate
re-registration rather than for a defect.
"""

from __future__ import annotations

import ast
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PREREGISTRATION = ROOT / "docs" / "PREREGISTRATION-CORTEX-MEMORY-ARM.md"
DISPATCH = ROOT / "tools" / "dispatch-cortex-memory-ab.py"

# The one mapping that cannot be derived from the document: the names §10.3 uses for
# configuration concepts, against the `workflow_dispatch` input names that carry them.
# Written out rather than pattern-matched (`retrievalThreshold` -> snake_case) because
# a pattern that guessed wrong would silently check nothing, and this mapping is
# exactly where a defect of form 4 would hide.
CONCEPT_TO_INPUT = {
    "sourceTrust": "cortex_memory_source_trust",
    "threshold": "cortex_memory_threshold",
    "retrievalThreshold": "cortex_memory_retrieval_threshold",
    "promptContract": "cortex_memory_prompt_contract",
    "ask": "cortex_memory_ask",
    "evidenceTurnsPerRecord": "cortex_memory_evidence_turns",
    "relevanceSignal": "cortex_memory_relevance",
    "relevanceTopK": "cortex_memory_relevance_top_k",
    "relevanceUnits": "cortex_memory_relevance_units",
    # §13.67's variable. Its registered value is the literal `none` rather than a number,
    # which is why `registered()` compares strings instead of parsing ints: the adopted
    # configuration is "no cap", and spelling that as a number would need a sentinel no
    # reader could tell from a real cap.
    "maxTurnChars": "cortex_memory_max_turn_chars",
    "budgetMinutes": "cortex_memory_budget_minutes",
    "limit": "limit",
    "ablation_runs": "ablation_runs",
    "temperature": "temperature",
}


def registered() -> dict[str, str]:
    """The §10.3 bullet list, as `{concept: value}` with values normalised to `str`.

    §10.3 writes some entries as their own bullet (`* `sourceTrust: 0.5` — ...`) and
    groups the scale ones into one (`* `limit: 0`, `ablation_runs: 4`, ...`). Both
    shapes are read, because the grouping is a prose choice and a future edit may
    split or join it -- and a parser that only understood today's layout would start
    returning a short dict, which the coverage assertion below turns into a failure
    rather than a silent pass.
    """
    source = PREREGISTRATION.read_text(encoding="utf-8")
    block = re.search(
        r"### 10\.3 The configuration this registration names\n(.*?)\n\n",
        source,
        re.S,
    )
    if block is None:
        raise AssertionError("PREREGISTRATION-CORTEX-MEMORY-ARM.md has no §10.3 block")

    return parse_block(block.group(1))


def parse_block(text: str) -> dict[str, str]:
    """`concept: value` pairs from a §10.3 block, refusing to state one concept twice.

    ## The defect that made duplication an error rather than a precedence rule

    The first version of this parser was `found[concept] = value` in a loop, so a second
    statement of a concept silently **overwrote** the first. That is not a theoretical
    hazard: §13.64's adoption bullet sits near the top of the list and §13.17's original
    bullet sits near the bottom, and after §13.64 the document named `relevanceSignal`
    twice -- `retrieval-hybrid` at the top, `retrieval` at the bottom. Last-wins therefore
    read the **stale** value, the dispatch table agreed with it, and every assertion in this
    file passed for six sections while the registration's own first line said something
    else. A run was dispatched on the stale baseline and had to be cancelled (§13.69).

    A precedence rule is the wrong repair: whichever order it chose, the document would
    still contain two answers to one question and a reader would have to know the rule to
    know which. So a duplicate raises, and the message names the concept -- the fix is to
    retire the older statement, which is what §13.64's adoption should have done to §13.17's.

    ## Why it is a function over `text` rather than over the document

    Because the guard has to be testable on a document that has the defect. Asserting it
    against the real §10.3 would pass forever once the duplicate is fixed, and a guard that
    only ever sees the fixed input proves nothing about the state it exists to catch.
    """
    found: dict[str, str] = {}
    # `concept: value` inside backticks, anywhere in the bullet list. The value is
    # captured up to the closing backtick so a trailing ` — explanation` is excluded.
    for match in re.finditer(r"`([A-Za-z_][A-Za-z0-9_]*):\s*([^`]+)`", text):
        concept, value = match.group(1), match.group(2).strip()
        if concept in found:
            raise AssertionError(
                f"§10.3 names `{concept}` twice -- {found[concept]!r} then {value!r}. A "
                "second statement of one concept makes the registration ambiguous: whichever "
                "the parser prefers, the document contains two answers and a reader has to "
                "know the rule to know which is the registration. Retire the older bullet "
                "instead of appending a new one beside it."
            )
        found[concept] = value
    return found


class TestTheRegistrationStatesEachConceptOnce(unittest.TestCase):
    """The guard that the six-section drift of §13.64 needed and did not have.

    The defect was not a wrong number anywhere: §10.3 said `retrieval-hybrid` at the top and
    `retrieval` at the bottom, the parser read the bottom, the dispatch table agreed with the
    bottom, and the test suite was green. Nothing in that chain was a lie except the
    document holding two answers.
    """

    def test_a_duplicate_is_refused_and_the_message_names_the_concept(self) -> None:
        with self.assertRaises(AssertionError) as caught:
            parse_block(
                "* `ask: enumerated` -- adopted.\n"
                "* `ask: computed` -- the value it replaced.\n"
            )
        self.assertIn("ask", str(caught.exception))
        # Both values, because the reader's next step is deciding which of the two to retire
        # and the message is all they have.
        self.assertIn("enumerated", str(caught.exception))
        self.assertIn("computed", str(caught.exception))

    def test_one_statement_per_concept_parses_normally(self) -> None:
        # The control. A parser that raised on everything would make the guard vacuous in the
        # direction that hides a real duplicate.
        found = parse_block("* `ask: enumerated` -- adopted.\n* `limit: 0`, `runs: 4`.\n")
        self.assertEqual(found, {"ask": "enumerated", "limit": "0", "runs": "4"})

    def test_the_real_registration_states_each_concept_once(self) -> None:
        # The assertion the drift would have failed: `registered()` raises on a duplicate, so
        # simply calling it is the check -- and calling it here means the failure names the
        # concept rather than surfacing as a confusing mismatch further down.
        self.assertEqual(len(registered()), len(CONCEPT_TO_INPUT))


def dispatched() -> dict[str, str]:
    """The dispatch script's `INPUTS`, parsed rather than imported.

    Parsed with `ast` for the reason `test_dispatch_inputs.py` gives: importing the
    module runs `token()` at import time and would require a `.git/config`.
    """
    tree = ast.parse(DISPATCH.read_text(encoding="utf-8"), filename=str(DISPATCH))
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if [t.id for t in node.targets if isinstance(t, ast.Name)] != ["INPUTS"]:
            continue
        mapping = node.value
        if not isinstance(mapping, ast.Dict):
            raise AssertionError("INPUTS is not a dict literal")
        return {
            k.value: v.value
            for k, v in zip(mapping.keys, mapping.values)
            if isinstance(k, ast.Constant) and isinstance(v, ast.Constant)
        }
    raise AssertionError("dispatch-cortex-memory-ab.py has no INPUTS assignment")


class TestDispatchedConfigurationMatchesTheRegistration(unittest.TestCase):
    def test_the_registration_was_parsed(self) -> None:
        # The control. A regex that matched nothing would make every assertion below
        # vacuous, and this file would report success while checking nothing -- the
        # same failure mode `test_every_dispatch_script_was_found` guards against.
        found = registered()
        self.assertEqual(
            sorted(found),
            sorted(CONCEPT_TO_INPUT),
            f"§10.3 must name exactly {sorted(CONCEPT_TO_INPUT)}; parsed {sorted(found)}. "
            "A concept missing here means the parser stopped understanding the section, "
            "not that the section stopped naming it.",
        )

    def test_every_registered_concept_reaches_the_dispatch(self) -> None:
        found = registered()
        sent = dispatched()
        for concept, value in sorted(found.items()):
            with self.subTest(concept=concept):
                input_name = CONCEPT_TO_INPUT[concept]
                self.assertIn(
                    input_name,
                    sent,
                    f"§10.3 registers {concept} but the dispatch sends no "
                    f"{input_name} key, so the run applies the workflow default.",
                )
                self.assertEqual(
                    sent[input_name],
                    value,
                    f"§10.3 registers {concept}: {value} but the dispatch sends "
                    f"{input_name}: {sent[input_name]!r}. Every layer of the plumbing "
                    "works in this case -- the run succeeds and the artifact records a "
                    "configuration -- so nothing in the run's own output can detect it. "
                    "Amend §10.3 as part of the same change, or fix the value.",
                )

    def test_the_dispatch_sends_nothing_the_registration_omits(self) -> None:
        # The mirror direction, which is how the toggle would be missed: `cortex_memory`
        # is the arm's switch and is deliberately NOT a §10.3 bullet -- it is not a
        # configuration value, it is whether the arm runs at all. So the assertion is
        # that the only keys sent outside the registration are that switch.
        sent = dispatched()
        registered_inputs = set(CONCEPT_TO_INPUT.values())
        extra = sorted(set(sent) - registered_inputs)
        self.assertEqual(
            extra,
            ["cortex_memory"],
            f"the dispatch sends {extra} beyond §10.3. `cortex_memory` is the arm's "
            "switch and is expected; any other key is a configuration value that no "
            "registration names, which is how an unregistered knob reaches a run.",
        )


    def test_the_refuted_arming_is_not_silently_restored(self) -> None:
        """§10.9 refuted `retrievalThreshold: 0.25`; reinstating it is a re-registration.

        The guard above keeps the dispatch and §10.3 in agreement, and after §10.9 both
        say `0`. That is necessary but not sufficient: an edit that changed *both* back
        to `0.25` would satisfy every assertion in this file while re-arming a
        configuration that lost 186 questions and won none. The two documents agree with
        each other either way -- what is missing is a check that the refutation is still
        acknowledged, which is the one thing a symmetric-pair guard cannot see.

        So this asserts the *reason* survives, not the number: §10.9 must exist and must
        name the run that produced the refutation. A future re-registration is free to
        choose `0.25` again, but it has to say so in a section of its own rather than
        delete §10.9, and that is exactly the cost §4's no-redraw rule is meant to impose.
        """
        source = PREREGISTRATION.read_text(encoding="utf-8")
        self.assertIn(
            "### 10.9",
            source,
            "§10.9 records the refutation of `retrievalThreshold: 0.25`. If it is gone, "
            "either the refutation was erased or the section was renumbered; a "
            "re-registration must add a section, not remove the evidence.",
        )
        self.assertIn(
            "37313582403",
            source,
            "§10.9 must name the run that produced the draw being read, so the refutation "
            "is traceable to an artifact rather than to a claim about one.",
        )


if __name__ == "__main__":
    unittest.main()
