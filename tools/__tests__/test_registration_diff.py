"""`readout-arm-run.py --registration`, the instrument that reads ONE artifact against the table.

## Why one artifact is the unit

`--config` compares two runs and cannot answer the question a reader of a single run has: *is what
ran the thing this arm says it runs?* By 2026-10-31 three values had drifted out of §10.3 without
anything failing — `maxPromptChars` 96,000 against a registered 48,000 (§13.202.6), `turnCutMarker`
`ellipsis` against a bare 400 (§13.188), and `ask` `operands` against a registered `enumerated`
(§13.203.2). Each was found by a person re-reading 22,000 lines. The prose record could not fail;
this can.

## What the tool must refuse to do

Three shapes would each make the output narrower than it looks, and each is asserted here:

1. **Compare a derived field.** `askRoutes` is computed from `ask` by the product. Treating it as a
   dispatched value made a real run report `askRoutes: ["enumerated"]` — a registered value that
   never existed and that would have counted as a second departure.
2. **Silently skip a field it cannot read.** A dispatch value that cannot be read as the type the
   artifact holds is a mismatch between two records, not a field to pass over (§13.191).
3. **Accept a departure that names nothing.** A typo in `--departs` would license the run while
   declaring no field — the `--set` defect (§13.192.7.3) on the declaration side.

## What is deliberately not compared

A *harness* input (`limit`, `ablation_runs`) is not the arm's configuration; the *presence* input
(`cortex_memory`) is the block itself. Both are counted in the header rather than dropped, because
a comparison that covers less than it appears to is the defect this file exists to prevent.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "readout-arm-run.py"


def _module():  # noqa: ANN202 - imported by path, like every other tool test in this directory
    spec = importlib.util.spec_from_file_location("readout_arm_run", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


# The mapped subset of `41222844945`'s block, verbatim. The unmapped fields (`embedding`,
# `renderingRoutes`, `confidenceSignal`, ...) are omitted because the comparison reads only the
# paths `DISPATCH_FIELD_ALIASES` names -- and one test below asserts that omission is not a
# difference rather than an exclusion the tool forgot to report.
REAL_41222844945 = {
    "ask": "operands+operand-gap",
    "askRoutes": ["multi-session", "flat", "temporal", "abstention"],
    "evidenceRoles": ["user"],
    "evidenceRolesRoutes": ["multi-session", "temporal"],
    "maxPromptChars": 96000,
    "maxTurnChars": 400,
    "maxTurnCharsRoutes": ["multi-session", "temporal"],
    "promptContract": "abstention-evidence-blocks",
    "queryExpansion": "none",
    "reader": {
        "provider": "deepseek",
        "model": "deepseek-chat",
        "baseUrl": "https://api.deepseek.com/v1",
        "thinking": "disabled",
        "temperature": 0,
    },
    "relevanceSignal": "retrieval-hybrid",
    "relevanceTopK": 256,
    "relevanceUnits": "turn",
    "rerank": {"provider": "none"},
    "retrievalThreshold": 0,
    "reviewBareDecline": True,
    "reviewPass": "bare",
    "selfConsistency": "none",
    "sessionBudget": None,
    "sourceTrust": 0.5,
    "threshold": 0,
    "turnCutMarker": "ellipsis",
}

# The departures `41222844945` carried that the registration still does not name. It is one list
# rather than two strings because every test that clears them must clear both: a run that declares
# one is a run that still has an undeclared field.
#
# `cortex_memory_ask` left this list when §13.203 adopted `operands+operand-gap` -- "the artifact
# stopped departing from the table without the artifact changing at all" -- and it returns here when
# §13.248 adopted `verbatim`, for the same reason in the other direction. **Neither move touched the
# artifact.** That is the instrument working: it compares a run to a registration, and either side
# moving is visible.
DEPARTS_41222844945 = [
    "cortex_memory_ask",
    "cortex_memory_max_prompt_chars",
    "cortex_memory_max_turn_chars",
    # §13.232 moved the registered `thinking` off `disabled`, so this artifact now departs on it too.
    # Declared rather than excused: it is the same field the campaign's own reading moved, and a
    # fixture that silently gained a fifth difference would be a test that stopped describing the
    # artifact it is named after.
    "thinking",
    # §13.260.7 moved the registered `relevanceSignal` to `retrieval-anchored`, so an artifact
    # dispatched before that adoption departs on it too. Declared for the same reason `thinking`
    # above is: a fixture that silently gained a difference would stop describing its own run.
    "cortex_memory_relevance",
]


def registered_reader(module) -> dict:  # noqa: ANN001 - the tool module, imported by path
    """The reader block the dispatch table registers, derived from it rather than restated.

    §13.232 moved the registered `thinking` from `disabled` to `multi-session+temporal`, and every
    fixture below that means "the registered configuration" would otherwise need the same edit in
    five places -- which is the two-copies defect that moving a registration exists to avoid. The
    table is the source; this reads it.
    """
    expectation = module.two_field_expectation("thinking", module.dispatch_inputs()["thinking"])
    reader = {**REAL_41222844945["reader"], "thinking": expectation["reader.thinking"]}
    routes = expectation["reader.thinkingRoutes"]
    if routes == module.ABSENT:
        reader.pop("thinkingRoutes", None)
    else:
        reader["thinkingRoutes"] = routes
    return reader


def report(config: dict, **overrides: object) -> dict:
    block = dict(config)
    block.update(overrides)
    return {"memoryArmConfig": block}


# ---------------------------------------------------------------------------------------------
# The value grammar the tool has to mirror
# ---------------------------------------------------------------------------------------------


class TestTwoFieldInputs:
    def test_a_width_and_a_marker_are_one_input(self) -> None:
        module = _module()
        assert module.two_field_expectation("cortex_memory_max_turn_chars", "400:ellipsis") == {
            "maxTurnChars": 400,
            "turnCutMarker": "ellipsis",
        }

    def test_a_width_without_a_marker_states_the_identity(self) -> None:
        """`none` is the shipped state (§13.188), so a bare width means the marker is `none` and not
        absent. Reading it as absent would call every pre-marker run an undeclared departure."""
        module = _module()
        assert module.two_field_expectation("cortex_memory_max_turn_chars", "400") == {
            "maxTurnChars": 400,
            "turnCutMarker": "none",
        }

    @pytest.mark.parametrize("raw", ["disabled", "enabled"])
    def test_a_plain_mode_leaves_the_reach_absent(self, raw: str) -> None:
        module = _module()
        expectation = module.two_field_expectation("thinking", raw)
        assert expectation["reader.thinking"] == raw
        assert expectation["reader.thinkingRoutes"] is module.ABSENT

    def test_a_route_list_is_enabled_on_those_routes_and_absent_elsewhere(self) -> None:
        module = _module()
        assert module.two_field_expectation("thinking", "multi-session+temporal") == {
            "reader.thinking": "enabled",
            "reader.thinkingRoutes": ["multi-session", "temporal"],
        }

    def test_an_empty_value_is_the_shipped_mode(self) -> None:
        """GitHub substitutes `''` for an unfilled input, and the `''`-to-default path is where
        §38 and §13.112 both found defects. Here it is read as `disabled` explicitly."""
        module = _module()
        expectation = module.two_field_expectation("thinking", "")
        assert expectation == {"reader.thinking": "disabled", "reader.thinkingRoutes": module.ABSENT}

    def test_the_ask_writes_one_field_and_derives_the_other(self) -> None:
        module = _module()
        assert module.two_field_expectation("cortex_memory_ask", "operands") == {"ask": "operands"}

    def test_an_unrecognised_name_is_compared_one_to_one(self) -> None:
        module = _module()
        assert module.two_field_expectation("cortex_memory_review_pass", "bare") is None


class TestCoercion:
    def test_an_integer_field_is_read_as_an_integer(self) -> None:
        """`--set` sends strings and the artifact records numbers, so `'96000'` must equal `96000`
        or every run would report every numeric field as a departure."""
        module = _module()
        assert module.coerce_to_artifact("96000", 96000) == 96000
        assert module.coerce_to_artifact("256", 256) == 256

    def test_a_float_field_keeps_its_fraction(self) -> None:
        module = _module()
        assert module.coerce_to_artifact("0.5", 0.5) == 0.5
        assert module.coerce_to_artifact("0.5", 0.5) != 0

    def test_a_list_field_is_split_on_commas(self) -> None:
        module = _module()
        assert module.coerce_to_artifact("multi-session, temporal", ["multi-session", "temporal"]) == [
            "multi-session",
            "temporal",
        ]
        assert module.coerce_to_artifact("user", ["user"]) == ["user"]

    def test_a_boolean_field_follows_the_dispatch_spelling(self) -> None:
        module = _module()
        assert module.coerce_to_artifact("1", True) is True
        assert module.coerce_to_artifact("0", True) is False
        assert module.coerce_to_artifact("", False) is False

    def test_a_text_field_is_compared_as_text(self) -> None:
        module = _module()
        assert module.coerce_to_artifact("bare", "bare") == "bare"

    def test_a_value_that_cannot_be_read_is_refused_rather_than_skipped(self) -> None:
        module = _module()
        with pytest.raises(ValueError):
            module.coerce_to_artifact("operands+operand-gap", 96000)


# ---------------------------------------------------------------------------------------------
# The reading itself
# ---------------------------------------------------------------------------------------------


class TestTheRealArtifact:
    def test_the_three_departures_this_run_was_dispatched_with_are_found(self) -> None:
        """The state the artifact was produced in: before §13.203 the table still said `enumerated`,
        and before §13.232 it still said `thinking: disabled`. Both are put back rather than the
        fixture being edited, because the fixture is the artifact and the table is the changing
        half."""
        module = _module()
        inputs = dict(module.dispatch_inputs())
        module.dispatch_inputs = lambda: {
            **inputs,
            "cortex_memory_ask": "enumerated",
            "thinking": "disabled",
            # §13.260.7 moved the registered ranking to `retrieval-anchored`, so the table is put back
            # to what it said when this artifact was produced. The alternative -- letting the fourth
            # difference in -- would make this test describe a run with four departures while its name
            # and its three assertions say three.
            "cortex_memory_relevance": "retrieval-hybrid",
        }
        text, failures = module.registration_section(report(REAL_41222844945), [])
        assert failures == 3, text
        assert 'UNDECLARED  ask: "enumerated" (registered) -> "operands+operand-gap" (ran)' in text
        assert "UNDECLARED  maxPromptChars: 48000 (registered) -> 96000 (ran)" in text
        assert 'UNDECLARED  turnCutMarker: "none" (registered) -> "ellipsis" (ran)' in text

    def test_declaring_them_makes_the_run_an_experiment_with_a_registration(self) -> None:
        module = _module()
        text, failures = module.registration_section(report(REAL_41222844945), DEPARTS_41222844945)
        assert failures == 0, text
        assert "every one of them is declared" in text
        assert "UNDECLARED" not in text

    def test_the_derived_reach_is_reported_rather_than_compared(self) -> None:
        """The defect this pins: `askRoutes` treated as dispatched reported
        `["enumerated"] (registered)` -- a value that never ran and a second false departure."""
        module = _module()
        text, _ = module.registration_section(report(REAL_41222844945), DEPARTS_41222844945)
        assert "askRoutes" in text
        assert "is computed from cortex_memory_ask and is not compared here" in text
        assert "askRoutes: " not in text

    def test_an_unmapped_artifact_field_is_not_a_difference(self) -> None:
        """`renderingRoutes` is assembled by the arm from the reach table and has no dispatch input.
        Counting it would make every run a departure from a registration that never named it."""
        module = _module()
        config = {**REAL_41222844945, "renderingRoutes": ["flat", "multi-session"]}
        text, failures = module.registration_section(report(config), DEPARTS_41222844945)
        assert failures == 0, text
        assert "renderingRoutes" not in text


class TestTheCleanRun:
    def test_the_registered_configuration_reads_as_one(self) -> None:
        module = _module()
        inputs = module.dispatch_inputs()
        config = {
            **REAL_41222844945,
            "ask": inputs["cortex_memory_ask"],
            "maxPromptChars": int(inputs["cortex_memory_max_prompt_chars"]),
            "turnCutMarker": "none",
            "askRoutes": ["multi-session"],
            "reader": registered_reader(module),
            # Read from the table rather than written here: §13.260.7 moved the registered ranking, and
            # a second copy of the value is the copy that will be stale next time it moves.
            "relevanceSignal": inputs["cortex_memory_relevance"],
        }
        text, failures = module.registration_section(report(config), [])
        assert failures == 0, text
        assert "is the registered configuration, field for field" in text
        assert "need no line in §10.3" in text


class TestTheRefusals:
    def test_a_departure_that_names_nothing_is_refused(self) -> None:
        module = _module()
        text, failures = module.registration_section(
            report(REAL_41222844945), ["cortex_memory_prompt_contrat"]
        )
        assert failures == 1, text
        assert "--departs names ['cortex_memory_prompt_contrat']" in text

    def test_a_declared_field_that_did_not_move_is_printed(self) -> None:
        """A registration that names a field the run did not move describes an intention. Printed
        for the same reason `--config` prints its idle names: the record has to be able to be
        wrong out loud."""
        module = _module()
        text, _ = module.registration_section(
            report(REAL_41222844945), [*DEPARTS_41222844945, "cortex_memory_review_pass"]
        )
        assert "declared but unchanged: ['cortex_memory_review_pass']" in text

    def test_a_block_that_is_missing_is_an_error_not_an_agreement(self) -> None:
        module = _module()
        with pytest.raises(SystemExit):
            module.registration_section({"questions": []}, [])

    def test_a_value_the_artifact_cannot_carry_is_refused(self) -> None:
        module = _module()
        inputs = dict(module.dispatch_inputs())
        module.dispatch_inputs = lambda: {**inputs, "cortex_memory_max_prompt_chars": "big"}
        with pytest.raises(SystemExit):
            module.registration_section(report(REAL_41222844945), [])


class TestWhatIsCounted:
    def test_the_header_states_every_population_it_did_not_compare(self) -> None:
        module = _module()
        text, _ = module.registration_section(report(REAL_41222844945), [])
        assert "registration: 20 field(s) compared" in text
        assert "1 derived" in text
        assert "3 harness" in text
        assert "1 presence" in text

    def test_an_alias_with_no_field_in_the_artifact_is_derived_rather_than_dropped(self) -> None:
        """§13.101 removed `threshold` from the dispatch and the workflow fixes it at 0, so the
        field exists in old artifacts and not in the table. An input whose field the artifact does
        not carry is reported as derived rather than vanishing from a count that says "20 compared"."""
        module = _module()
        module.dispatch_inputs = lambda: {"cortex_memory_threshold": "0"}
        config = {key: value for key, value in REAL_41222844945.items() if key != "threshold"}
        text, failures = module.registration_section(report(config), [])
        assert failures == 0, text
        assert "derived     threshold is computed from cortex_memory_threshold" in text


class TestAbsentIsNotNull:
    def test_an_absent_field_against_a_present_one_is_a_departure(self) -> None:
        module = _module()
        config = {**REAL_41222844945, "reader": registered_reader(module)}
        config["reader"] = {**config["reader"]}
        config["reader"].pop("thinking", None)
        text, failures = module.registration_section(report(config), [])
        assert failures >= 1, text
        assert 'reader.thinking: "enabled" (registered) -> <-absent-> (ran)' in text

    def test_an_absent_field_registered_as_absent_is_agreement(self) -> None:
        """A run with `thinking: disabled` records no reach and the table asks for none, so the two
        absences are one agreement rather than a difference with nothing on one side. Replayed
        against the table's pre-§13.232 value for exactly that reason: the identity form is still
        expressible, and the comparison has to treat its two absences as one state."""
        module = _module()
        inputs = dict(module.dispatch_inputs())
        module.dispatch_inputs = lambda: {**inputs, "thinking": "disabled"}
        config = {
            **REAL_41222844945,
            "ask": module.dispatch_inputs()["cortex_memory_ask"],
            "maxPromptChars": 48000,
            "turnCutMarker": "none",
            "relevanceSignal": module.dispatch_inputs()["cortex_memory_relevance"],
        }
        text, failures = module.registration_section(report(config), [])
        assert failures == 0, text
        assert "reader.thinkingRoutes" not in text


# ---------------------------------------------------------------------------------------------
# The condition has to reach the consumer, not just the instrument
# ---------------------------------------------------------------------------------------------


class TestTheDefaultReportCarriesTheVerdict:
    """`registration_section` is a check; `congruence_note` is the mechanism.

    §13.202.6 shipped the check and the campaign kept quoting a number whose pair ran at a budget
    that section had declined. The lesson `AUDIT-SCORING-RULE-AS-CONDITION.md` records is that a
    condition living only in a document is lost at the second consumer, and the second consumer here
    is the plain `readout-arm-run.py <artifact>` invocation somebody types when they want a number.
    """

    def test_says_nothing_when_the_artifact_is_the_registered_configuration(self) -> None:
        module = _module()
        inputs = module.dispatch_inputs()
        config = {
            **REAL_41222844945,
            "ask": inputs["cortex_memory_ask"],
            "maxPromptChars": int(inputs["cortex_memory_max_prompt_chars"]),
            "turnCutMarker": "none",
            "askRoutes": ["multi-session"],
            "reader": registered_reader(module),
            # Read from the table rather than written here: §13.260.7 moved the registered ranking, and
            # a second copy of the value is the copy that will be stale next time it moves.
            "relevanceSignal": inputs["cortex_memory_relevance"],
        }
        assert module.congruence_note(report(config)) == ""

    def test_names_the_condition_when_a_field_moved_without_being_declared(self) -> None:
        module = _module()
        config = {
            **REAL_41222844945,
            "maxPromptChars": 96000,
            "turnCutMarker": "ellipsis",
        }
        note = module.congruence_note(report(config))
        assert "departs from the registered dispatch" in note
        assert "§13.202.6" in note
        assert "--registration" in note

    def test_stays_silent_on_an_artifact_it_cannot_compare(self) -> None:
        """A competitor's artifact has no registration at all. A warning that fired there would be
        a warning about this tool, and it would make the default report unusable for the one case
        that has nothing to declare."""
        module = _module()
        assert module.congruence_note({}) == ""
