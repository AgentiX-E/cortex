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
    # `threshold` is deliberately ABSENT as of §13.101.3, for the reason `evidenceTurnsPerRecord` is:
    # it is fixed at 0 by the workflow because admission-wide-open is the premise of every experiment
    # on this arm, not a variable within it. The value is unchanged and the control this mapping
    # protects is replaced by the workflow's own constant, which is where a reader of a run looks.
    "retrievalThreshold": "cortex_memory_retrieval_threshold",
    "promptContract": "cortex_memory_prompt_contract",
    "ask": "cortex_memory_ask",
    # `evidenceTurnsPerRecord` is deliberately ABSENT as of §13.94. It is registered in §10.3 and
    # still decides what the artifact carries, but it is no longer a dispatch input: the workflow sets
    # it as a constant because the dispatch surface sits one below GitHub's 25-input ceiling and this
    # bound is a writability guard rather than an experiment. The value is unchanged at 256, and the
    # control that this mapping protects -- a registered value that does not reach the run -- is
    # replaced here by the workflow's own constant, which is where a reader of the run looks.
    "relevanceSignal": "cortex_memory_relevance",
    "relevanceTopK": "cortex_memory_relevance_top_k",
    "relevanceUnits": "cortex_memory_relevance_units",
    # §13.67's variable. Its registered value is the literal `none` rather than a number,
    # which is why `registered()` compares strings instead of parsing ints: the adopted
    # configuration is "no cap", and spelling that as a number would need a sentinel no
    # reader could tell from a real cap.
    "maxTurnChars": "cortex_memory_max_turn_chars",
    # §13.73's reach: a route list rather than a number, and `all` is the registered state.
    "maxTurnCharsRoutes": "cortex_memory_max_turn_chars_routes",
    # §13.81's budget: the one input that changes the room without changing a turn.
    "maxPromptChars": "cortex_memory_max_prompt_chars",
    # §13.83's filter and its reach: the two inputs that decide which turns may enter the room at
    # all. Registered at the identity (`all`/`all`), because the experiment that narrows them is
    # the section's own dispatch and the adopted state has to be on the record meanwhile.
    "reviewPass": "cortex_memory_review_pass",
    # §13.97's ranking-queries variable. Registered at `none`; the expansion run departs from the
    # table with `--set`, which this guard deliberately does not read -- its subject is the
    # registered configuration, not every dispatch.
    # §13.115's switch. Registered at the identity (`none`); the reranking dispatch departs from the
    # table with `--set cortex_memory_rerank=on`, and its control is the same run at
    # `relevance_top_k=128` without the stage -- a pairing §13.115 records rather than a second variable.
    "rerank": "cortex_memory_rerank",
    "queryExpansion": "cortex_memory_query_expansion",
    # §13.101's sample count. Registered at `none`; the voting run departs from the table with
    # `--set`, which this guard deliberately does not read.
    "selfConsistency": "cortex_memory_self_consistency",
    "evidenceRoles": "cortex_memory_evidence_roles",
    "evidenceRolesRoutes": "cortex_memory_evidence_roles_routes",
    # `budgetMinutes` is deliberately ABSENT as of §13.115. It is registered in §10.3 and still
    # bounds every pass, but it is no longer a dispatch input: the surface sat one below GitHub's
    # 25-input ceiling when the reranking switch needed a slot, and this value is a hang detector
    # rather than a treatment. The workflow sets it as a constant (90), which is where a reader of a
    # run looks for it -- the same repair, for the same reason, as `evidenceTurnsPerRecord` in §13.94.

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


WORKFLOW = ROOT / ".github" / "workflows" / "benchmark-cortex-memory.yml"

# Inputs whose `workflow_dispatch` default is deliberately NOT the registered value.
#
# Written out rather than inferred, because the difference has to be a decision somebody made
# and can be asked about. `limit` defaults to a cheap smoke run so that a person opening the
# "Run workflow" page and pressing the button gets an answer in minutes instead of hours; §10.3
# registers the full 500 questions. Both are correct, and they are correct *about different
# things*, which is exactly why the rule below cannot be "the default must equal the registration".
#
# `ablation_runs` was on this list and has been **removed from it** — §13.118.5. The exemption's
# justification was that extra repetitions replay a shared answer cache and produce a
# byte-identical report, so a one-repetition button run was the same measurement for a quarter of
# the wall clock. Run `40722772896` falsifies it: four repetitions of one configuration scored
# 407 / 414.5 / 414.5 / 423 and spanned 81–88 on MR, at 2.87× the wall clock. The consequence was
# not theoretical — §13.118's control came from a button run, so the treatment could not be read
# against it. A default that produces an unreadable artifact is a shipped configuration that
# contradicts its own registration, which is what this class exists to catch.
#
# Anything else that disagrees is the defect this class was written for.
DEFAULT_MAY_DIFFER = {
    "limit": "the button-run budget is a smoke run; §10.3 registers the full N",
}


def declared_defaults() -> dict[str, str]:
    """`{input name: default}` for every `workflow_dispatch` input that declares one.

    Parsed with a hand-written reader rather than a YAML library for the reason
    `test_workflow_yaml.py` gives: the repository has no YAML dependency in the tools layer and
    the block's shape is fixed by GitHub rather than by this file. The reader is deliberately
    literal about indentation — six spaces before the input, eight before its keys — because a
    regex that tolerated any indentation would also read keys out of `on.push.paths`.
    """
    source = WORKFLOW.read_text(encoding="utf-8")
    start = source.index("workflow_dispatch")
    end = source.index("\njobs:", start)
    block = source[start:end]

    defaults: dict[str, str] = {}
    current: str | None = None
    for line in block.splitlines():
        header = re.match(r"^      ([A-Za-z_][A-Za-z0-9_]*):\s*$", line)
        if header:
            current = header.group(1)
            continue
        value = re.match(r"^        default: (.*)$", line)
        if value and current is not None:
            # A default is always quoted in this workflow; strip one layer so the comparison is
            # against the value GitHub would pass, not against the source spelling.
            literal = value.group(1).strip()
            if len(literal) >= 2 and literal[0] == literal[-1] and literal[0] in "'\"":
                literal = literal[1:-1]
            defaults[current] = literal
    if not defaults:
        raise AssertionError(
            "no `workflow_dispatch` defaults were read. A parser that silently finds nothing "
            "makes every assertion in TestTheShippedDefaultAgreesWithTheRegistration vacuous."
        )
    return defaults


class TestTheShippedDefaultAgreesWithTheRegistration(unittest.TestCase):
    """The direction every previous guard in this file could not see.

    ## The defect this class exists for

    `TestDispatchedConfigurationMatchesTheRegistration` compares §10.3 with the dispatch
    script. Both are files a maintainer edits by hand, and both were correct on the day the
    workflow's own default for `cortex_memory_review_pass` moved from `''` to `'bare'`: the
    workflow said the treatment ships, §10.3 said `none`, the script said `none`, and every
    test was green.

    The consequence is not cosmetic. A dispatch through `tools/dispatch-cortex-memory-ab.py`
    sends `review_pass=none` explicitly, so the script reproduces the **control** while its
    docstring calls it the registered configuration — 81.0% instead of the 83.45% the product
    reads. And a dispatch through the GitHub UI, sending no `review_pass` at all, reproduces
    the product. Two ways to "run the registered configuration" that differ by 2.45 points,
    with nothing in either artifact able to say which one it was.

    Run `40698867439` is the measurement that separated them: it sent no `review_pass`, landed
    on the workflow default, and read 83.40% (417/500) — 0.05 points from the four-run mean
    §10.3's neighbours report.

    ## Why the rule is "the shipped default is the registration", with an allowlist

    Because a `workflow_dispatch` default is the only place in the repository that expresses
    "what a run gets when nobody chooses". If that value disagrees with §10.3, then the
    registration is not the shipped configuration and the product has no stated configuration
    at all. The two exceptions are the button-run budgets, whose whole purpose is to be
    cheaper than the experiment; they are named in `DEFAULT_MAY_DIFFER` with their reason.
    """

    def test_the_defaults_were_read(self) -> None:
        # The control. A reader that returned an empty dict, or one that missed the input this
        # class was written for, would make the assertion below pass while checking nothing.
        defaults = declared_defaults()
        self.assertIn("cortex_memory_review_pass", defaults)

    def test_every_overlapping_input_agrees_or_declares_why_not(self) -> None:
        found = registered()
        defaults = declared_defaults()
        checked = 0
        for concept, value in sorted(found.items()):
            input_name = CONCEPT_TO_INPUT[concept]
            if input_name not in defaults:
                continue
            shipped = defaults[input_name]
            if shipped == "":
                # An empty default means "leave the reader's own default alone", which is a
                # different statement from naming a value and cannot contradict one.
                continue
            checked += 1
            if input_name in DEFAULT_MAY_DIFFER:
                continue
            with self.subTest(concept=concept):
                self.assertEqual(
                    shipped,
                    value,
                    f"the workflow ships `{input_name}: {shipped}` but §10.3 registers "
                    f"`{concept}: {value}`. A dispatch that names no value therefore runs "
                    "something the registration does not describe, and the artifact cannot "
                    "tell the two apart. Move both, or add the input to DEFAULT_MAY_DIFFER "
                    "with the reason it is allowed to differ.",
                )
        self.assertGreater(
            checked,
            0,
            "no input overlapped the registration, so this guard checked nothing. That is "
            "the state a renamed input leaves behind.",
        )


if __name__ == "__main__":
    unittest.main()
