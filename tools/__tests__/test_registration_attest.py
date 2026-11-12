"""Tests for `tools/registration-attest.py`, the gate that keeps a bill from outliving its configuration.

`C1` published **12,137** prompt tokens per question for a round in which the registered configuration
billed **9,201**. The file it read named its run (`42355323615`) and was a correct record of that run.
What it was not was a record of the configuration §13.336 adopted, and nothing in the file said which
configuration the project registers -- so the row went on printing a number that was 24.2% too high
with every check green.

The tests below pin the four things that have to be true for this gate to be a gate rather than a
formality:

  - **the fingerprint is stable and order-free.** An artifact's `memoryArmConfig` is a JSON object, and
    two spellings of the same configuration must hash the same or the gate fires on formatting.
  - **the fingerprint crosses languages.** `efficiency-frontier.mjs` writes the shipping arm's
    fingerprint from Node and this file computes the baseline's from Python; a disagreement would fire
    the gate on every green run, which is how a gate gets deleted. `test_the_two_languages_agree`
    builds the same fixture in both and compares.
  - **the refusal names the field that moved.** A refusal that says only "the configuration differs"
    sends the reader to diff two JSON files; §13.336's difference is one input with six values in it.
  - **a matched fingerprint wins over a non-empty difference list.** The two answer different
    questions -- "is this the registered configuration" and "which inputs would a dispatch have to
    send to reproduce it" -- and the first is the one that decides. This is pinned rather than left to
    reading the code, because the tempting implementation ANDs them and that turns every artifact
    recorded before a projection gained a field into a false failure.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys

from importlib import import_module

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

attest = import_module("registration-attest")

REPO = pathlib.Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "registration-attest.py"
BASELINE = REPO / "tools" / "arm-config-baseline.json"


CONFIG = {
    "ask": "verbatim-acts",
    "maxTurnChars": 400,
    "maxTurnCharsRoutes": ["multi-session", "temporal"],
    "evidenceRoles": ["user"],
    "evidenceRolesRoutes": ["multi-session", "temporal"],
    "relevanceSignal": "retrieval-anchored",
    "relevanceTopK": 256,
    "relevanceUnits": "turn",
    "promptContract": "evidence-blocks-unsourced",
    "queryExpansion": "none",
    "reviewPass": "bare",
    "selfConsistency": "none",
    "sourceTrust": 0.5,
    "retrievalThreshold": 0,
    "maxPromptCharsByRoute": {
        "abstention": 24000,
        "assistant": 24000,
        "flat": 24000,
        "knowledge-update": 24000,
        "multi-session": 48460,
        "temporal": 48000,
    },
    "rerank": {"provider": "none"},
    "reader": {"model": "deepseek-chat", "temperature": 0, "thinking": "enabled",
               "thinkingRoutes": ["multi-session", "temporal"]},
}


def artifact(config: dict | None = None) -> dict:
    return {"memoryArmConfig": dict(config or CONFIG), "runs": 4, "questionCount": 500}


def baseline_of(config: dict | None = None) -> dict:
    """A registration record that agrees with `artifact(config)`.

    `dispatch` is deliberately rebuilt from `project()` rather than typed, because a hand-written table
    here would be a second statement of the projection and the comparison below is about the projection.
    """
    record = import_module("arm-config-record")
    return {
        "run": "42533236864",
        "adoptedBy": "13.336",
        "memoryArmConfig": dict(config or CONFIG),
        "memoryArmConfigFingerprint": attest.fingerprint(config or CONFIG),
        "dispatch": record.project(artifact(config)),
    }


# ------------------------------------------------------------------------------ the fingerprint

class TestTheFingerprint:
    def test_key_order_does_not_change_it(self):
        forward = attest.fingerprint({"a": 1, "b": 2})
        backward = attest.fingerprint({"b": 2, "a": 1})
        assert forward == backward

    def test_it_names_the_algorithm(self):
        # `datasetFingerprint` in the artifacts uses the same spelling, so a reader who sees one without
        # the other can tell the algorithm is stated rather than implied.
        assert attest.fingerprint(CONFIG).startswith("sha256:")
        assert len(attest.fingerprint(CONFIG)) == len("sha256:") + 64

    def test_one_changed_room_is_a_different_configuration(self):
        wider = json.loads(json.dumps(CONFIG))
        wider["maxPromptCharsByRoute"]["temporal"] = 47000
        assert attest.fingerprint(wider) != attest.fingerprint(CONFIG)

    def test_a_nested_number_and_its_string_are_different_configurations(self):
        # The artifact's `temperature` is `0` and the dispatch table's is `'0'`; the projection renders one
        # into the other, which is why the projection compares strings and the fingerprint does not. A
        # fingerprint over the rendered form would call these equal and the gate would pass an artifact the
        # registration does not describe.
        assert attest.fingerprint({"maxTurnChars": 400}) != attest.fingerprint({"maxTurnChars": "400"})


# --------------------------------------------------------------------------------- the comparison

class TestTheComparison:
    def test_a_matching_artifact_is_matched(self):
        reading = attest.attestation(artifact(), baseline_of())
        assert reading["matched"] is True
        assert reading["differences"] == []
        assert reading["applied"] == reading["registered"]

    def test_the_room_map_is_named_as_the_input_that_moved(self):
        narrow = json.loads(json.dumps(CONFIG))
        narrow["maxPromptCharsByRoute"] = {"multi-session": 48460}
        reading = attest.attestation(artifact(narrow), baseline_of())
        assert reading["matched"] is False
        assert len(reading["differences"]) == 1
        # The dispatch input, not the artifact field: a refusal is read by whoever has to re-dispatch.
        assert reading["differences"][0].startswith("cortex_memory_max_prompt_chars:")
        assert "multi-session:48460" in reading["differences"][0]

    def test_the_fingerprint_decides_and_the_difference_list_only_diagnoses(self):
        # A baseline recorded before the projection gained an input still describes the same configuration.
        # ANDing the two tests would report it as a defect, and the repair a reader would then make is to
        # re-record a baseline that is not wrong.
        stale_projection = baseline_of()
        stale_projection["dispatch"].pop("cortex_memory_max_turn_chars")
        reading = attest.attestation(artifact(), stale_projection)
        assert reading["matched"] is True
        assert any("cortex_memory_max_turn_chars" in line for line in reading["differences"])

    def test_an_artifact_without_the_configuration_is_not_matched(self):
        reading = attest.attestation(artifact(), {"run": "x", "adoptedBy": "y"})
        assert reading["matched"] is False
        assert reading["registered"] is None

    def test_a_fixed_input_is_not_reported(self):
        # `temperature` is projected out of the artifact and no dispatch input carries it; §10.3 states it
        # as a property of the arm. Comparing it would report a difference on every green run.
        assert not any(line.startswith("temperature:") for line in attest.differences(artifact(), baseline_of()))


# -------------------------------------------------------------------------------------- the CLI

class TestTheCommandLine:
    def run(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(TOOL), *args], capture_output=True, text=True
        )

    def write(self, tmp_path: pathlib.Path, body: dict) -> pathlib.Path:
        path = tmp_path / "report.json"
        path.write_text(json.dumps(body))
        return path

    def test_a_registered_artifact_exits_zero_and_names_the_run(self, tmp_path: pathlib.Path):
        report = self.write(tmp_path, artifact())
        baseline = tmp_path / "baseline.json"
        baseline.write_text(json.dumps(baseline_of()))
        completed = self.run(str(report), "--baseline", str(baseline))
        assert completed.returncode == 0
        assert "42533236864" in completed.stdout
        assert "13.336" in completed.stdout

    def test_a_departed_artifact_exits_one_and_says_what_to_do(self, tmp_path: pathlib.Path):
        narrow = json.loads(json.dumps(CONFIG))
        narrow["maxPromptCharsByRoute"] = {"multi-session": 48460}
        report = self.write(tmp_path, artifact(narrow))
        baseline = tmp_path / "baseline.json"
        baseline.write_text(json.dumps(baseline_of()))
        completed = self.run(str(report), "--baseline", str(baseline))
        assert completed.returncode == 1
        assert "Refusing to write" in completed.stdout
        assert "arm-config-record.py --record" in completed.stdout

    def test_the_json_form_carries_both_fingerprints(self, tmp_path: pathlib.Path):
        report = self.write(tmp_path, artifact())
        baseline = tmp_path / "baseline.json"
        baseline.write_text(json.dumps(baseline_of()))
        completed = self.run(str(report), "--baseline", str(baseline), "--json")
        parsed = json.loads(completed.stdout)
        assert parsed["applied"] == parsed["registered"]
        assert parsed["matched"] is True


# ------------------------------------------------------------------- the two languages, one answer

class TestTheTwoLanguagesAgree:
    """`efficiency-frontier.mjs` and this file must hash the same configuration to the same string."""

    def test_the_shipping_fingerprint_matches_the_python_one(self, tmp_path: pathlib.Path):
        # The frontier tool needs a report to read, and its shipping block is the only place a Node process
        # writes a fingerprint. A one-arm invocation is refused, so the fixture carries a reference and a
        # candidate that are the same artifact -- the comparison is meaningless and the fingerprint is not.
        body = {
            "dataset": "longmemeval",
            "datasetFingerprint": "sha256:" + "0" * 64,
            "questionCount": 1,
            "runs": 1,
            "generatedAt": "2026-11-10T00:00:00.000Z",
            "memoryArmConfig": CONFIG,
            "questions": [{"questionId": "q", "capability": "IE"}],
            "feature": {
                "metrics": {
                    "correct": 1,
                    "total": 1,
                    "perCapability": {"IE": {"correct": 1, "total": 1}},
                }
            },
            "usageBySide": {"feature": {"promptTokens": 1, "completionTokens": 1, "calls": 1}},
            "ablation": {
                "featureCorrectByRun": ["1"],
                "featureByCapability": {"IE": {"avg": 1, "min": 1, "max": 1}},
            },
        }
        path = tmp_path / "report.json"
        path.write_text(json.dumps(body))
        completed = subprocess.run(
            [
                "node",
                str(REPO / "tools" / "efficiency-frontier.mjs"),
                str(path),
                str(path),
                "--label",
                "reference",
                "--label",
                "route-room",
                "--ship",
                "route-room",
                "--json",
            ],
            capture_output=True,
            text=True,
        )
        assert completed.returncode == 0, completed.stderr
        written = json.loads(completed.stdout)["shipping"]["configurationFingerprint"]
        assert written == attest.fingerprint(CONFIG)


# ------------------------------------------------------------------- conditions and the empty refusal

class TestAConditionIsComparedAndNeverSilentlyAbsent:
    """The refusal a reader could not act on: `matched` false, `differences()` empty.

    `memoryArmConfig`'s key set grows by design -- `conflicts` and `replyRepair` are spelled on every
    run from the change that introduced them and on none before it -- and the fingerprint covers the
    whole block. So a repeat of the **same** configuration, produced after those fields appeared,
    hashed differently from a record written before them, and `differences()` projected onto
    `PROJECTED` so it had nothing to say. The gate was right that the artifact was not the record and
    wrong about every reason a reader needs.
    """

    def test_a_condition_at_its_registered_value_is_not_a_departure(self) -> None:
        # The record predates the fields; the artifact spells both at the registered values, so the
        # arm did not move and the conditions must not be reported as if it had.
        newer = artifact({**CONFIG, "conflicts": False, "replyRepair": "off"})
        assert attest.condition_differences(newer, baseline_of()) == []

    def test_a_condition_that_moved_is_named_with_both_values(self) -> None:
        newer = artifact({**CONFIG, "conflicts": True, "replyRepair": "repair"})
        lines = attest.condition_differences(newer, baseline_of())
        assert any(line.startswith("conflicts:") and "True" in line for line in lines)
        assert any(line.startswith("replyRepair:") and "'repair'" in line for line in lines)

    def test_a_control_run_of_a_record_that_names_the_condition_agrees(self) -> None:
        # The other direction: once the record carries the field, a control run must still be silent,
        # or every reading after the re-record would be refused for being correct.
        config = {**CONFIG, "conflicts": False, "replyRepair": "off"}
        assert attest.condition_differences(artifact(config), baseline_of(config)) == []

    def test_the_refusal_names_the_vocabulary_gap_rather_than_nothing(self) -> None:
        newer = artifact({**CONFIG, "conflicts": False, "replyRepair": "off"})
        reading = attest.attestation(newer, baseline_of())
        assert reading["matched"] is False
        assert reading["differences"], "a refusal must name what moved"
        assert any(line.startswith("conflicts:") for line in reading["differences"])
        assert any(line.startswith("replyRepair:") for line in reading["differences"])
        assert all("added to the arm after the record was written" in line
                   for line in reading["differences"])

    def test_a_field_the_record_carries_and_the_artifact_dropped_is_named(self) -> None:
        config = {**CONFIG, "conflicts": False}
        reading = attest.attestation(artifact(CONFIG), baseline_of(config))
        assert reading["matched"] is False
        assert any(line.startswith("conflicts:") and "does not" in line
                   for line in reading["differences"])

    def test_a_value_outside_every_class_is_named_rather_than_left_to_the_hash(self) -> None:
        # `embedding` is `identity`: outside the projection, deliberately not compared. When it moves,
        # the fingerprint is the only witness, and this is the sentence that makes the witness readable.
        config = {**CONFIG, "embedding": {"provider": "openai-compatible", "model": "embedding-3"}}
        moved = {**CONFIG, "embedding": {"provider": "openai-compatible", "model": "embedding-2"}}
        reading = attest.attestation(artifact(moved), baseline_of(config))
        assert reading["matched"] is False
        assert any(line.startswith("embedding:") and "only the fingerprint sees it" in line
                   for line in reading["differences"])
