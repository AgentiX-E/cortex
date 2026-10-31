"""`readout-arm-run.py --config`, the instrument that refuses a pair it cannot attribute.

## The run this exists for

`41203245999` completed `success` in 2h04m and spent a full 500-question, four-repetition budget on
the composite `ask`. Its artifact says `maxPromptChars=48000`, `turnCutMarker=none`. The control its
six registered readings were pinned to, `41185512391`, says `96000` and `ellipsis`. Two fields
differed, nothing errored, and the pair was unreadable the moment it finished — a run whose cost was
paid and whose reading does not exist (§13.200).

The comparison that finds this takes four lines to write by hand and was, in fact, done by hand. The
point of the tool is not that the hand version is hard; it is that the hand version is **optional**.
The registration said "six readings", the artifact said "success", and the only thing standing
between those two statements was a person remembering to look.

## What a refusal has to be

A refusal that does not name the fields a reader cannot see is a refusal they cannot act on, so every
failure here carries `path: left -> right`. And a refusal that fires on a legitimate pair is worse
than none: `maxTurnChars` and `turnCutMarker` are **two artifact fields written by one dispatch
value** (`400:ellipsis`, §13.188.3), so a treatment that names the dispatch name must cover both.
That is the one piece of mapping the tool owns, and it is tested in both directions — naming the
dispatch value clears both fields, naming one artifact field leaves the other undeclared.

## The three shapes that look like configuration and are not

`voteCounts` is the run's own census of how many times each verdict came back (§13.104) — it is
written into the same block, differs between any two runs that voted, and says nothing about what was
dispatched. Comparing it would fail every legitimately paired self-consistency run, so it is excluded
by name and reported under its own heading rather than dropped.

An **absent** field is not equal to a null one. A run that omits `sessionBudget` and a run that sends
`null` are the same configuration today and this tool says so, but a field that is absent on one side
and present on the other is a difference with `<-absent->` printed, never a silent match.

The block itself being missing is an error rather than a pair of empty configurations. Two artifacts
with no `memoryArmConfig` agree about every field they have, which is exactly the answer that must
not be given.
"""

from __future__ import annotations

import importlib.util
import json
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


# The two `memoryArmConfig` blocks from the run that made this necessary, verbatim. They are copied
# rather than fetched because the artifacts are not committed (100+ MB each) and this comparison has
# to work offline -- the same reason `readout-arm-run.py` carries §13.26's counts as constants.
CONTROL_41185512391 = {
    "ask": "operands",
    "askRoutes": ["multi-session", "temporal", "abstention", "knowledge-update"],
    "confidenceSignal": "none",
    "embedding": {
        "provider": "openai-compatible",
        "model": "embedding-3",
        "dimensions": 1024,
        "preflight": "ok",
    },
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
    "renderingRoutes": [
        "abstention",
        "multi-session",
        "temporal",
        "knowledge-update",
        "flat",
        "multi-session,temporal",
    ],
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

# `41203245999`: the composite ask, and the two fields that moved with it because the dispatch sent
# the registered values instead of the ones the control carried.
COMPOSITE_41203245999 = {
    **CONTROL_41185512391,
    "ask": "operands+operand-gap",
    "askRoutes": ["multi-session", "flat", "temporal", "abstention"],
    "maxPromptChars": 48000,
    "turnCutMarker": "none",
}


def report(config: dict | None, **extra: object) -> dict:
    out: dict = {"questionCount": 500, "runs": 4}
    if config is not None:
        out["memoryArmConfig"] = config
    out.update(extra)
    return out


def write(tmp_path: Path, name: str, payload: dict) -> Path:
    path = tmp_path / name
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


class TestThePairThatCannotBeRead:
    def test_the_lost_run_is_refused_and_both_extra_fields_are_named(self) -> None:
        """The exact pair §13.200 could not read, and the reason it could not."""
        module = _module()
        text, failures = module.diff_section(
            report(CONTROL_41185512391),
            report(COMPOSITE_41203245999),
            treatment=["cortex_memory_ask"],
        )
        assert failures == 2, text
        assert "maxPromptChars: 96000 -> 48000" in text
        assert 'turnCutMarker: "ellipsis" -> "none"' in text
        assert "not attributable" in text

    def test_the_declared_field_is_not_among_the_failures(self) -> None:
        """`ask` moved too, and it moved on purpose — a refusal that lists it is noise."""
        module = _module()
        text, failures = module.diff_section(
            report(CONTROL_41185512391),
            report(COMPOSITE_41203245999),
            treatment=["cortex_memory_ask"],
        )
        assert "ask:" in text
        assert "undeclared" in text
        undeclared = text.split("undeclared", 1)[1]
        assert "maxPromptChars" in undeclared
        assert "ask:" not in undeclared

    def test_naming_all_three_fields_licenses_the_pair(self) -> None:
        """With every moved field declared, the pair is a reading again — the tool's job is not to
        forbid the comparison, it is to make the comparison state what it moved.

        Four fields, not three: `askRoutes` is what the arm computed `ask` to reach, so declaring the
        ask declares it too (§13.200.2). The count is asserted because a tool that quietly covered a
        fifth field would be licensing more than the caller named.
        """
        module = _module()
        text, failures = module.diff_section(
            report(CONTROL_41185512391),
            report(COMPOSITE_41203245999),
            treatment=["ask", "maxPromptChars", "turnCutMarker"],
        )
        assert failures == 0, text
        assert "4 field(s) differ" in text


class TestOneDispatchValueTwoArtifactFields:
    def test_the_compound_spelling_covers_the_width_and_the_marker(self) -> None:
        """`400` -> `400:ellipsis` is one dispatch input and two artifact fields (§13.188.3). A
        treatment named the way the dispatch named it must clear both, or every marker run reads as
        an undeclared pair."""
        module = _module()
        run = {**CONTROL_41185512391, "turnCutMarker": "none", "maxTurnChars": 200}
        text, failures = module.diff_section(
            report(CONTROL_41185512391),
            report(run),
            treatment=["cortex_memory_max_turn_chars"],
        )
        assert failures == 0, text
        assert "maxTurnChars: 400 -> 200" in text
        assert 'turnCutMarker: "ellipsis" -> "none"' in text

    def test_naming_one_artifact_field_leaves_the_other_undeclared(self) -> None:
        """The half-mapping is the failure mode: a writer who declares the width and forgets the
        marker has declared the dispatch value only in appearance."""
        module = _module()
        run = {**CONTROL_41185512391, "turnCutMarker": "none", "maxTurnChars": 200}
        text, failures = module.diff_section(
            report(CONTROL_41185512391), report(run), treatment=["maxTurnChars"]
        )
        assert failures == 1, text
        assert "turnCutMarker" in text.split("undeclared", 1)[1]


class TestTheRouteScopedReader:
    def test_the_thinking_spelling_covers_the_reach_too(self) -> None:
        """`thinking=multi-session+temporal` writes `reader.thinking` and `reader.thinkingRoutes`
        (§13.198). One dispatch value, two artifact fields — left one-to-one, every route-scoped
        reader run reads as an undeclared pair. Found by pointing the tool at the shape the next
        registered dispatch produces, which is the only way a mapping table gets verified."""
        module = _module()
        run = {
            **CONTROL_41185512391,
            "reader": {
                **CONTROL_41185512391["reader"],
                "thinking": "enabled",
                "thinkingRoutes": ["multi-session", "temporal"],
            },
        }
        text, failures = module.diff_section(
            report(CONTROL_41185512391), report(run), treatment=["thinking"]
        )
        assert failures == 0, text
        assert 'reader.thinking: "disabled" -> "enabled"' in text
        assert "reader.thinkingRoutes" in text

    def test_a_reach_against_a_control_that_never_had_the_field(self) -> None:
        """The real shape: `41218182053` carries `thinkingRoutes` and its control `41196801892` does
        not, because the field did not exist when the control ran. An absent-vs-present difference
        must print the absence rather than matching, or the pair looks like it moved one field."""
        module = _module()
        run = {
            **CONTROL_41185512391,
            "reader": {
                **CONTROL_41185512391["reader"],
                "thinking": "enabled",
                "thinkingRoutes": ["multi-session", "temporal"],
            },
        }
        text, failures = module.diff_section(
            report(CONTROL_41185512391), report(run), treatment=["thinking"]
        )
        assert failures == 0, text
        assert 'reader.thinkingRoutes: <-absent-> -> ["multi-session", "temporal"]' in text


class TestWhatIsNotConfiguration:
    def test_the_vote_census_does_not_fail_the_pair(self) -> None:
        """`voteCounts` is a census of the run's own answers, written into the configuration block.
        Comparing it would fail every legitimately paired voting run."""
        module = _module()
        left = {**CONTROL_41185512391, "selfConsistency": "3", "voteCounts": {"a": 2, "b": 1}}
        right = {**CONTROL_41185512391, "selfConsistency": "3", "voteCounts": {"a": 3}}
        text, failures = module.diff_section(report(left), report(right), treatment=[])
        assert failures == 0, text
        assert "voteCounts" in text
        assert "not configuration" in text

    def test_an_absent_field_is_a_difference_and_prints_the_absence(self) -> None:
        module = _module()
        left = {k: v for k, v in CONTROL_41185512391.items() if k != "sessionBudget"}
        text, failures = module.diff_section(
            report(left), report(CONTROL_41185512391), treatment=[]
        )
        assert failures == 1, text
        assert "sessionBudget: <-absent-> -> null" in text

    def test_a_missing_block_is_refused_rather_than_compared(self) -> None:
        """Two artifacts with no `memoryArmConfig` agree about every field they have."""
        module = _module()
        with pytest.raises(SystemExit) as raised:
            module.diff_section(report(None), report(None), treatment=[])
        assert "memoryArmConfig" in str(raised.value)


class TestNestedFields:
    def test_a_reader_field_is_named_by_its_path(self) -> None:
        module = _module()
        run = {**CONTROL_41185512391, "reader": {**CONTROL_41185512391["reader"], "model": "deepseek-reasoner"}}
        text, failures = module.diff_section(report(CONTROL_41185512391), report(run), treatment=[])
        assert failures == 1, text
        assert 'reader.model: "deepseek-chat" -> "deepseek-reasoner"' in text

    def test_the_dispatch_name_for_the_reader_clears_it(self) -> None:
        """`model` is the dispatch input and `reader.model` is where it lands (§13.192.6)."""
        module = _module()
        run = {**CONTROL_41185512391, "reader": {**CONTROL_41185512391["reader"], "model": "x"}}
        _, failures = module.diff_section(
            report(CONTROL_41185512391), report(run), treatment=["model"]
        )
        assert failures == 0

    def test_a_parent_path_covers_its_children(self) -> None:
        """`--treatment reader` is how a dispatch that re-registers the whole reader is declared."""
        module = _module()
        run = {
            **CONTROL_41185512391,
            "reader": {"provider": "zhipu", "model": "glm-4", "baseUrl": "u", "thinking": "enabled", "temperature": 0},
        }
        _, failures = module.diff_section(
            report(CONTROL_41185512391), report(run), treatment=["reader"]
        )
        assert failures == 0


class TestTheTreatmentListItself:
    def test_a_treatment_that_names_nothing_is_refused(self) -> None:
        """A mistyped treatment name would license nothing and read as a clean pair — the `--set`
        defect's shape, applied to the declaration instead of the dispatch."""
        module = _module()
        with pytest.raises(SystemExit) as raised:
            module.diff_section(
                report(CONTROL_41185512391),
                report(CONTROL_41185512391),
                treatment=["cortex_memory_ask_typo"],
            )
        assert "cortex_memory_ask_typo" in str(raised.value)

    def test_a_declared_field_that_did_not_move_is_not_a_failure(self) -> None:
        """Declaring `ask` on a pair that did not move it describes an intention, not a difference.
        It is printed so the reader can see the registration was not what ran."""
        module = _module()
        text, failures = module.diff_section(
            report(CONTROL_41185512391),
            report(CONTROL_41185512391),
            treatment=["cortex_memory_ask"],
        )
        assert failures == 0
        assert "same configuration" in text


class TestAnIdenticalPair:
    def test_no_field_differs_and_the_pair_is_named_as_the_noise_floor(self) -> None:
        """Two dispatches of one payload are §13.175.5's ±2.2 points, which is a reading this tool
        must label rather than refuse."""
        module = _module()
        text, failures = module.diff_section(
            report(CONTROL_41185512391), report(CONTROL_41185512391), treatment=[]
        )
        assert failures == 0
        assert "0 field(s) differ" in text
        assert "noise floor" in text

    def test_a_field_order_difference_is_not_a_configuration_difference(self) -> None:
        module = _module()
        reordered = dict(reversed(list(CONTROL_41185512391.items())))
        _, failures = module.diff_section(
            report(CONTROL_41185512391), report(reordered), treatment=[]
        )
        assert failures == 0
