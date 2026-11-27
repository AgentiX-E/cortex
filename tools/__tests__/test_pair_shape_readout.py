"""The shape of a within-job pair, read from the artifact rather than downloaded twice.

`PREREG-TURN-FILL.md` §9.1 records `P1` as partly verified: the configuration reached the run and
twelve questions flipped at `temperature 0`, so at least twelve prompts differed, but the shape the
section predicts -- 215 questions up, 285 unchanged -- needs per-question vectors that live in a 63 MB
artifact. Reading that by transfer took forty minutes; this tool reads it in one pass wherever the
artifact already is.

These tests pin the four things a shape reader can get wrong by accident:

  - **a missing control side is not a flat one.** An all-null `baselinePromptChars` is a `reference`
    pairing whose baseline exposes no prompt, and summarising it with `?? 0` would print 500 identical
    prompts and a shape that says the treatment changed nothing. It is refused by name.
  - **a level length is not an identical prompt.** Only lengths are on the artifact for the control
    side, so the tool reports how many of the temperature-0 flips happened on a level length -- the
    reading that turns `P1`'s 285 into an upper bound on identity rather than a count of it.
  - **a gate with no field is unreadable, not passed.** A missing `usageBySide` or capability census
    prints `UNREADABLE` with the field named. A gate that passes when its evidence is absent is the
    shape `§208.10` records.
  - **the internal control is two-sided.** Above 108 characters the treatment reached room the cap had
    taken; below zero it delivered less than the prefix on the one route where the prefix loses
    nothing, which is the superset property failing. A one-sided bound prints PASS over a defect.
"""

import json
import pathlib
import subprocess
import tempfile

import pytest

TOOL = pathlib.Path(__file__).resolve().parents[1] / "pair-shape-readout.mjs"


def _cli(report: dict) -> subprocess.CompletedProcess:
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(report, handle)
        path = handle.name
    return subprocess.run(
        ["node", str(TOOL), path, "--json"],
        capture_output=True,
        text=True,
        timeout=120,
    )


def _readout(report: dict) -> dict:
    result = _cli(report)
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def _gate(result: dict, name: str) -> dict:
    return next(gate for gate in result["gates"] if gate["gate"] == name)


def _report(
    *,
    control=(100, 100, 200, 200),
    feature=(110, 100, 300, 205),
    routes=("multi-session", "multi-session", "flat", "temporal"),
    discordant=None,
    bill=(1000, 10, 1010, 10),
    correct=({"MR": 2, "IE": 2}, {"MR": 2, "IE": 2}),
):
    return {
        "dataset": "fixture",
        "questions": [
            {
                "questionId": f"q{index}",
                "capability": "MR" if index < 2 else "IE",
                "route": routes[index],
                # The control vector is the **whole** prompt (`baselinePromptChars` is
                # `promptTexts.map(text => text.length)`), so the treatment side that pairs with it is
                # `deliveredPromptChars`. `promptChars` is the same side's evidence characters and is
                # carried here because the tool prints the overhead between them.
                "deliveredPromptChars": feature[index],
                "promptChars": feature[index] - 100,
            }
            for index in range(len(feature))
        ],
        "ablation": {
            "baselinePromptChars": list(control),
            "discordantQuestions": discordant
            if discordant is not None
            else {"baselineCorrectFeatureIncorrect": [], "baselineIncorrectFeatureCorrect": []},
        },
        "baseline": {"metrics": {"perCapability": {k: {"correct": v} for k, v in correct[0].items()}}},
        "feature": {"metrics": {"perCapability": {k: {"correct": v} for k, v in correct[1].items()}}},
        "usageBySide": {
            "baseline": {"promptTokens": bill[0], "completionTokens": bill[1], "cacheHitPromptTokens": 900},
            "feature": {"promptTokens": bill[2], "completionTokens": bill[3], "cacheHitPromptTokens": 900},
        },
    }


def test_self_test_passes():
    result = subprocess.run(
        ["node", str(TOOL), "--self-test"], capture_output=True, text=True, timeout=120
    )
    assert result.returncode == 0, result.stderr
    assert "all passed" in result.stdout


def test_the_shape_separates_rose_level_and_fell():
    result = _readout(_report())
    shape = result["shape"]
    assert shape["compared"] == 4
    assert (shape["rose"], shape["level"], shape["fell"]) == (3, 1, 0)
    assert shape["charactersAdded"] == 10 + 0 + 100 + 5


def test_an_unpaired_question_is_named_and_excluded_rather_than_counted_as_zero():
    report = _report()
    report["ablation"]["baselinePromptChars"][3] = None
    result = _readout(report)
    assert result["shape"]["compared"] == 3
    assert result["unpairedQuestionIds"] == ["q3"]


def test_a_reference_pairing_is_refused_rather_than_summarised_as_flat():
    report = _report()
    report["ablation"]["baselinePromptChars"] = [None, None, None, None]
    result = _cli(report)
    assert result.returncode == 1
    assert "refused" in result.stderr
    assert "baselinePromptChars" in result.stderr


def test_an_absent_control_vector_is_refused():
    report = _report()
    del report["ablation"]["baselinePromptChars"]
    result = _cli(report)
    assert result.returncode == 1
    assert "no control side in the job" in result.stderr


def test_a_length_mismatch_is_refused_because_the_vectors_would_pair_across_questions():
    report = _report()
    report["ablation"]["baselinePromptChars"] = [1, 2]
    result = _cli(report)
    assert result.returncode == 1
    assert "another question" in result.stderr


def test_a_flip_on_a_level_length_is_counted_as_evidence_that_length_is_not_identity():
    report = _report(
        discordant={"baselineCorrectFeatureIncorrect": ["q1"], "baselineIncorrectFeatureCorrect": []}
    )
    result = _readout(report)
    assert result["levelFlips"]["readable"] is True
    assert result["levelFlips"]["moved"] == 1
    assert result["levelFlips"]["level"] == 1
    assert result["levelFlips"]["levelQuestionIds"] == ["q1"]


def test_a_discordant_id_absent_from_the_records_leaves_the_flip_count_unreadable():
    report = _report(
        discordant={"baselineCorrectFeatureIncorrect": ["nope"], "baselineIncorrectFeatureCorrect": []}
    )
    result = _readout(report)
    assert result["levelFlips"]["readable"] is False
    assert "absent from questions[]" in result["levelFlips"]["reason"]


@pytest.mark.parametrize(
    ("rise", "verdict"),
    [(0, "pass"), (108, "pass"), (109, "breach"), (-1, "breach")],
)
def test_the_internal_control_is_two_sided(rise, verdict):
    report = _report(control=(100, 100, 200, 200), feature=(100 + rise, 100, 200, 200))
    assert _gate(_readout(report), "internal control")["verdict"] == verdict


def test_a_bill_within_the_registered_ratio_passes_and_beyond_it_breaches():
    within = _readout(_report(bill=(1000, 0, 1015, 0)))
    assert _gate(within, "cost: bill")["verdict"] == "pass"
    beyond = _readout(_report(bill=(1000, 0, 1030, 0)))
    assert _gate(beyond, "cost: bill")["verdict"] == "breach"


def test_a_missing_bill_is_unreadable_rather_than_within_budget():
    report = _report()
    del report["usageBySide"]
    gate = _gate(_readout(report), "cost: bill")
    assert gate["verdict"] == "unreadable"
    assert "usageBySide" in gate["detail"]


def test_a_capability_dropping_three_breaches_the_guard_and_two_does_not():
    two = _readout(_report(correct=({"MR": 5, "IE": 2}, {"MR": 5, "IE": 0})))
    # IE drops 2, which §4 tolerates.
    assert _gate(two, "guard")["verdict"] == "pass"
    three = _readout(_report(correct=({"MR": 5, "IE": 3}, {"MR": 5, "IE": 0})))
    assert _gate(three, "guard")["verdict"] == "breach"


def test_the_superset_gate_says_it_cannot_be_read_here():
    gate = _gate(_readout(_report()), "superset")
    assert gate["verdict"] == "unreadable"
    assert "evidence-turn-fill.test.ts" in gate["detail"]


def test_the_population_gate_calls_itself_necessary_and_not_sufficient():
    gate = _gate(_readout(_report()), "population")
    assert gate["verdict"] == "breach"
    assert "NECESSARY AND NOT SUFFICIENT" in gate["detail"]


def test_fail_on_defect_is_red_for_a_defect_and_green_for_a_negative_reading():
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(_report(correct=({"MR": 5, "IE": 3}, {"MR": 5, "IE": 0})), handle)
        path = handle.name
    result = subprocess.run(
        ["node", str(TOOL), path, "--fail-on-defect"],
        capture_output=True,
        text=True,
        timeout=120,
    )
    # A capability dropping three is a defect, so the job goes red and says which gate.
    assert result.returncode == 1
    assert "guard" in result.stderr

    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(_report(), handle)
        path = handle.name
    result = subprocess.run(
        ["node", str(TOOL), path, "--fail-on-defect"],
        capture_output=True,
        text=True,
        timeout=120,
    )
    # The population gate breaches on this fixture and the job stays green: a fill that spends
    # nothing is a reading, and a red job for it teaches its reader to ignore red.
    assert result.returncode == 0
    assert "BREACH" in result.stdout


def _with_digests(**overrides):
    report = _report(**overrides)
    report["questions"][0]["promptDigest"] = "aaaaaaaaaaaaaaaa"
    report["questions"][1]["promptDigest"] = "bbbbbbbbbbbbbbbb"
    report["questions"][2]["promptDigest"] = "cccccccccccccccc"
    report["questions"][3]["promptDigest"] = "dddddddddddddddd"
    report["ablation"]["baselinePromptDigests"] = [
        "aaaaaaaaaaaaaaaa",
        "eeeeeeeeeeeeeeee",
        "ffffffffffffffff",
        None,
    ]
    return report


def test_identity_separates_a_changed_prompt_from_a_level_length():
    # q1 has delta 0 and a different digest: level length, changed prompt. That cell is the whole
    # reason the digest vector exists, and folding it into "level" would report P1's 285 as a count.
    identity = _readout(_with_digests())["identity"]
    assert identity["readable"] is True
    assert identity["identical"] == 1
    assert identity["changed"] == 2
    assert identity["changedAtLevelLength"] == 1
    assert identity["changedIds"] == ["q1", "q2"]


def test_an_artifact_without_the_digest_vector_says_identity_is_unreadable():
    identity = _readout(_report())["identity"]
    assert identity["readable"] is False
    assert "baselinePromptDigests" in identity["reason"]


def test_a_digest_vector_of_the_wrong_length_is_unreadable_rather_than_truncated():
    report = _with_digests()
    report["ablation"]["baselinePromptDigests"] = ["aaaaaaaaaaaaaaaa"]
    identity = _readout(report)["identity"]
    assert identity["readable"] is False
    assert "1 entries" in identity["reason"]


def test_an_artifact_with_only_evidence_characters_is_refused():
    # The trap this file was written through: `promptChars` is the treatment's *evidence* characters and
    # `baselinePromptChars` is the control's *whole* prompt. Comparing them read 333 questions falling by
    # a mean of 306 characters, which is a constant bias wearing a delta's clothes -- the mean difference
    # between the two field pairs on run `45923435343` is exactly the mean prompt overhead, 1,007.9.
    report = _report()
    for question in report["questions"]:
        del question["deliveredPromptChars"]
    result = _cli(report)
    assert result.returncode == 1
    assert "deliveredPromptChars" in result.stderr
    assert "two different quantities" in result.stderr
