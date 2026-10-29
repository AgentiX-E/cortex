"""The ledger tool, checked on hand-built reports.

`ledger.ts` has its own unit tests. This file tests the **tool**: that it reads the memory arm's report
envelope, prints the two numbers a reader can check against each other (the sum of the purchases and the
size of their union), names the questions a sum would count twice, and refuses an artifact that never
recorded which questions moved.

The last case is the one that matters most in practice. Every report written before `discordantQuestions`
existed looks, to a portfolio, exactly like an increment that bought nothing — and a reader who saw a
confident `bought 0` would conclude the increment was worthless rather than unrecorded.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "ledger.mjs"


def report(bought: list[str], sold: list[str]) -> dict:
    """One memory-arm report, in the envelope the workflow actually uploads."""
    return {
        "dataset": "longmemeval/s/100",
        "questionCount": len(bought) + len(sold),
        "ablation": {
            "feature": "cortex-memory",
            "discordantQuestions": {
                "baselineIncorrectFeatureCorrect": bought,
                "baselineCorrectFeatureIncorrect": sold,
            },
        },
    }


def run(tmp_path: Path, arms: dict[str, dict], extra: list[str] | None = None) -> subprocess.CompletedProcess:
    paths = []
    for label, body in arms.items():
        path = tmp_path / f"{label}.json"
        path.write_text(json.dumps(body), encoding="utf-8")
        paths.append(f"{label}={path}")
    return subprocess.run(
        ["node", str(TOOL), *paths, *(extra or [])],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )


def test_prints_the_sum_and_the_union_so_a_reader_can_compare_them(tmp_path: Path) -> None:
    """Three purchases in one arm and two in another: 5 summed, 5 distinct, and the tool must say so."""
    completed = run(
        tmp_path,
        {"silent": report(["m1", "m2", "m3"], []), "answer-line": report(["i1", "i2"], [])},
    )

    assert completed.returncode == 0, completed.stderr
    assert "Distinct questions bought: 5" in completed.stdout
    assert "Sum of the per-increment purchases: 5" in completed.stdout
    assert "Double-counted by the sum: 0" in completed.stdout
    assert "disjoint" in completed.stdout


def test_names_the_questions_a_naive_sum_counts_twice(tmp_path: Path) -> None:
    """+3 and +2 that share one question are worth +4, and the shared id has to be visible."""
    completed = run(
        tmp_path,
        {
            "silent": report(["m1", "m2", "shared"], []),
            "answer-line": report(["shared", "i1"], []),
        },
    )

    assert completed.returncode == 0, completed.stderr
    assert "Distinct questions bought: 4" in completed.stdout
    assert "Sum of the per-increment purchases: 5" in completed.stdout
    assert "Double-counted by the sum: 1 (shared)" in completed.stdout
    assert "overstates the pair by 1" in completed.stdout


def test_reports_a_question_one_arm_bought_and_another_sold(tmp_path: Path) -> None:
    """The loss a sum of nets cancels: +1 and -1 add to zero, and the question moved both ways."""
    completed = run(
        tmp_path,
        {"silent": report(["q7"], []), "answer-line": report([], ["q7"])},
    )

    assert completed.returncode == 0, completed.stderr
    assert "CONFLICT: q7" in completed.stdout
    assert "should not ship together" in completed.stdout


def test_refuses_a_report_that_never_recorded_the_identity(tmp_path: Path) -> None:
    """An old artifact is unrecorded, not empty, and the message has to name which arm it was."""
    legacy = {"dataset": "longmemeval/s/100", "ablation": {"feature": "cortex-memory"}}
    completed = run(tmp_path, {"legacy": legacy, "fresh": report(["q1"], [])})

    assert completed.returncode != 0
    assert "legacy" in completed.stderr
    assert "discordantQuestions" in completed.stderr


def test_json_mode_carries_the_lists_for_a_later_reader(tmp_path: Path) -> None:
    completed = run(
        tmp_path,
        {"silent": report(["m1", "shared"], []), "answer-line": report(["shared"], ["gone"])},
        extra=["--json"],
    )

    assert completed.returncode == 0, completed.stderr
    parsed = json.loads(completed.stdout)
    assert [arm["label"] for arm in parsed["increments"]] == ["silent", "answer-line"]
    assert parsed["portfolio"]["bought"] == ["m1", "shared"]
    assert parsed["portfolio"]["doubleCounted"] == ["shared"]
    assert parsed["portfolio"]["conflicting"] == []
    assert parsed["portfolio"]["summedBought"] == 3
    assert parsed["portfolio"]["summedSold"] == 1


def run_across(
    tmp_path: Path, arms: dict[str, dict], control: dict, extra: list[str] | None = None
) -> subprocess.CompletedProcess:
    """The cross-run form: several arms, one shared control, all measured question for question."""
    control_path = tmp_path / "control.json"
    control_path.write_text(json.dumps(control), encoding="utf-8")
    argv = ["node", str(TOOL), "--control", str(control_path)]
    for label, body in arms.items():
        path = tmp_path / f"across-{label}.json"
        path.write_text(json.dumps(body), encoding="utf-8")
        argv.extend(["--across", f"{label}={path}"])
    # `extra` had been accepted and dropped since this helper was written, so the first caller to pass an
    # argument through it asserted against a run that never received one. Appending it here is the whole
    # repair; the lesson is that a helper taking a parameter it ignores turns a test into a coincidence.
    argv.extend(extra or [])
    return subprocess.run(argv, cwd=REPO, capture_output=True, text=True, timeout=180, check=False)


def roster(verdicts: dict[str, bool]) -> dict:
    """A report that carries the per-question verdicts a cross-run pair is computed from."""
    return {
        "dataset": "longmemeval/s/500",
        "questionCount": len(verdicts),
        "generatedAt": "2026-10-29T00:00:00.000Z",
        "questions": [
            {"questionId": question, "correct": correct, "capability": "IE"}
            for question, correct in verdicts.items()
        ],
    }


def test_across_computes_bought_and_sold_against_one_shared_control(tmp_path: Path) -> None:
    """
    THE CASE THE INSTRUMENT WAS MISSING.

    `discordantQuestions` records one pair inside one run -- feature against the reference arm -- so two
    reports' lists are only commensurable if their control is the same run. A cross-run pair is the
    comparison the roadmap actually registers, and before this mode the tool could not express it at all:
    run against the two archived reports it produced an overlap of 208 of 448 and a reader could only
    conclude that route isolation had failed, when in fact both arms had beaten the same third party.
    """
    control = roster({"q1": True, "q2": False, "q3": True, "q4": False})
    arm = roster({"q1": False, "q2": True, "q3": True, "q4": False})

    completed = run_across(tmp_path, {"answer-line": arm}, control)

    assert completed.returncode == 0, completed.stderr
    # q2 bought (control wrong, arm right), q1 sold (control right, arm wrong).
    assert "answer-line (from across): bought 1, sold 1, net 0" in completed.stdout
    assert "bought: q2" in completed.stdout
    assert "sold:   q1" in completed.stdout


def test_across_refuses_a_pair_whose_rosters_differ(tmp_path: Path) -> None:
    """Two runs of different question sets cannot be paired: an id in one and not the other has no verdict."""
    control = roster({"q1": True, "q2": False})
    arm = roster({"q1": False})

    completed = run_across(tmp_path, {"answer-line": arm}, control)

    assert completed.returncode != 0
    assert "roster" in completed.stderr.lower()
    assert "q2" in completed.stderr


def test_refuses_to_mix_a_within_run_increment_with_a_cross_run_one(tmp_path: Path) -> None:
    """
    The mixing the registration calls out by name.

    A within-run increment's baseline is its own artifact's reference arm; a cross-run increment's is the
    control file. A union of the two is a number over two different third parties, and it would print as
    confidently as a valid one.
    """
    control = roster({"q1": True})
    arm = roster({"q1": False})
    within = report(["q9"], [])

    control_path = tmp_path / "control.json"
    control_path.write_text(json.dumps(control), encoding="utf-8")
    arm_path = tmp_path / "arm.json"
    arm_path.write_text(json.dumps(arm), encoding="utf-8")
    within_path = tmp_path / "within.json"
    within_path.write_text(json.dumps(within), encoding="utf-8")

    completed = subprocess.run(
        [
            "node",
            str(TOOL),
            "--control",
            str(control_path),
            "--across",
            f"answer-line={arm_path}",
            f"silent={within_path}",
        ],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )

    assert completed.returncode != 0
    assert "silent" in completed.stderr
    assert "mix" in completed.stderr.lower() or "across" in completed.stderr.lower()


def test_across_prints_the_control_identity_beside_every_increment(tmp_path: Path) -> None:
    """A union is only as good as the claim that both lists came from one baseline, so say which."""
    control = roster({"q1": True, "q2": False})
    arm = roster({"q1": False, "q2": True})

    completed = run_across(tmp_path, {"answer-line": arm}, control)

    assert completed.returncode == 0, completed.stderr
    assert "control:" in completed.stdout
    assert "2026-10-29T00:00:00.000Z" in completed.stdout
    assert "answer-line (from across)" in completed.stdout


def test_across_json_mode_names_the_mode_and_the_control(tmp_path: Path) -> None:
    """A later reader has to be able to tell a cross-run union from a within-run one without the log."""
    control = roster({"q1": True, "q2": False})
    arm = roster({"q1": False, "q2": True})

    control_path = tmp_path / "control.json"
    control_path.write_text(json.dumps(control), encoding="utf-8")
    arm_path = tmp_path / "arm.json"
    arm_path.write_text(json.dumps(arm), encoding="utf-8")
    completed = subprocess.run(
        [
            "node",
            str(TOOL),
            "--control",
            str(control_path),
            "--across",
            f"answer-line={arm_path}",
            "--json",
        ],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    parsed = json.loads(completed.stdout)
    assert parsed["mode"] == "across"
    assert parsed["control"]["generatedAt"] == "2026-10-29T00:00:00.000Z"
    assert parsed["portfolio"]["bought"] == ["q2"]
    assert parsed["portfolio"]["sold"] == ["q1"]


def test_within_run_json_mode_is_unchanged_by_the_new_mode(tmp_path: Path) -> None:
    """The archived reading keeps its shape: a mode field added, nothing moved."""
    completed = run(tmp_path, {"silent": report(["m1"], [])}, extra=["--json"])

    assert completed.returncode == 0, completed.stderr
    parsed = json.loads(completed.stdout)
    assert parsed["mode"] == "within-run"
    assert "control" not in parsed
    assert parsed["portfolio"]["bought"] == ["m1"]


def roster_with_prompts(rows: dict[str, tuple[bool, int]]) -> dict:
    """
    A report that also carries `promptChars`, which is what makes a cross-run pair attributable.

    `promptChars` is the arm's own statement of how long the prompt it rendered was, so two runs that agree on
    it for a question rendered the same prompt for that question and two that disagree did not. It is the only
    field in the artifact that separates "the treatment did not reach this question" from "the treatment
    reached it and changed nothing", and those two mean opposite things about a net change.
    """
    return {
        "dataset": "longmemeval/s/500",
        "questionCount": len(rows),
        "generatedAt": "2026-10-29T00:00:00.000Z",
        "questions": [
            {"questionId": question, "correct": correct, "capability": "IE", "promptChars": chars}
            for question, (correct, chars) in rows.items()
        ],
    }


def test_across_splits_by_whether_the_treatment_reached_the_question(tmp_path: Path) -> None:
    """
    THE CASE 13.135 EXISTS FOR.

    Run `40824682542` reported a net +9 against its control and 7 of the 9 came from questions whose prompts
    were byte-identical. The instrument printed one net for the whole roster, so the only reading available
    was the wrong one. Here q1 and q2 are treated and one goes each way; q3 and q4 are untouched and one is
    bought. The two buckets have to be printed separately or the net is uninterpretable.
    """
    control = roster_with_prompts({"q1": (True, 100), "q2": (False, 100), "q3": (False, 100), "q4": (True, 100)})
    arm = roster_with_prompts({"q1": (False, 140), "q2": (True, 90), "q3": (True, 100), "q4": (True, 100)})

    completed = run_across(tmp_path, {"recommend": arm}, control)

    assert completed.returncode == 0, completed.stderr
    assert "split by promptChars" in completed.stdout
    assert "treated   : 2 questions, bought 1, sold 1, net +0" in completed.stdout
    assert "untouched : 2 questions, bought 1, sold 0, net +1" in completed.stdout


def test_across_prints_the_noise_rate_the_untouched_bucket_measured(tmp_path: Path) -> None:
    """The untouched bucket's net per question is the number a treatment has to beat, so it is printed."""
    control = roster_with_prompts(
        {
            "q1": (False, 100),
            "q2": (False, 100),
            "q3": (False, 100),
            "q4": (False, 100),
            "q5": (True, 100),
            "q6": (False, 100),
        }
    )
    arm = roster_with_prompts(
        {
            "q1": (True, 100),
            "q2": (True, 100),
            "q3": (False, 100),
            "q4": (False, 300),
            "q5": (True, 100),
            "q6": (False, 100),
        }
    )

    completed = run_across(tmp_path, {"recommend": arm}, control)

    assert completed.returncode == 0, completed.stderr
    # Five untouched questions, two bought and none sold: 40.00% net per question.
    assert "untouched : 5 questions, bought 2, sold 0, net +2" in completed.stdout
    assert "40.00% net per question" in completed.stdout
    assert "the treatment's excess is -0.4 question(s)" in completed.stdout


def test_across_says_so_when_untouched_questions_produced_the_whole_net(tmp_path: Path) -> None:
    """
    A net change that untouched questions produced is not evidence about the treatment, whatever its sign.

    At 466 untouched questions moving +7 and 34 treated ones moving +2, a reader who saw only "+9" would have
    concluded the ask worked. The printed verdict is what makes the sign of a net change irrelevant when the
    bucket that produced it never saw the treatment.
    """
    control = roster_with_prompts({"q1": (False, 100), "q2": (False, 100), "q3": (False, 100)})
    arm = roster_with_prompts({"q1": (True, 100), "q2": (True, 100), "q3": (False, 300)})

    completed = run_across(tmp_path, {"recommend": arm}, control)

    assert completed.returncode == 0, completed.stderr
    assert "NO GAIN" in completed.stdout
    assert "not evidence of a benefit" in completed.stdout
    # Both bought questions are untouched and the one treated question is untouched too, so the treated
    # bucket's net is 0 against an expected +1: the excess is negative and the tool says so rather than
    # calling a regression a null.
    assert "the excess is NEGATIVE" in completed.stdout


def test_across_says_when_the_split_cannot_be_computed(tmp_path: Path) -> None:
    """
    A report that predates `promptChars` cannot be split, and "cannot say" is printed rather than assumed.

    Counting a missing field as untouched would put every question in the noise bucket and report an excess of
    minus the whole treated net -- a confident wrong answer where the honest one is that the field is absent.
    """
    control = roster({"q1": True, "q2": False})
    arm = roster({"q1": False, "q2": True})

    completed = run_across(tmp_path, {"answer-line": arm}, control)

    assert completed.returncode == 0, completed.stderr
    assert "carry no promptChars on at least one side" in completed.stdout
    assert "the split above is over the rest and not over the roster" in completed.stdout


def test_across_json_carries_the_reach_split(tmp_path: Path) -> None:
    """A later reader recomputes the split from the JSON, so the buckets have to be there and be numbers."""
    control = roster_with_prompts({"q1": (True, 100), "q2": (False, 100)})
    arm = roster_with_prompts({"q1": (False, 180), "q2": (True, 100)})

    control_path = tmp_path / "control.json"
    control_path.write_text(json.dumps(control), encoding="utf-8")
    arm_path = tmp_path / "arm.json"
    arm_path.write_text(json.dumps(arm), encoding="utf-8")
    completed = subprocess.run(
        ["node", str(TOOL), "--control", str(control_path), "--across", f"recommend={arm_path}", "--json"],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    parsed = json.loads(completed.stdout)
    reach = parsed["reach"][0]
    assert reach["label"] == "recommend"
    assert reach["treated"] == {"questions": 1, "bought": 0, "sold": 1}
    assert reach["untouched"] == {"questions": 1, "bought": 1, "sold": 0}
    assert reach["unknown"] == {"questions": 0, "bought": 0, "sold": 0}
    assert reach["complete"] is True


def roster_with_capabilities(rows: dict[str, tuple[bool, str]]) -> dict:
    """A report whose records carry a mechanism field, which is what a declared treated set is cut by."""
    return {
        "dataset": "longmemeval/s/500",
        "questionCount": len(rows),
        "generatedAt": "2026-10-30T00:00:00.000Z",
        "questions": [
            {"questionId": question, "correct": correct, "capability": capability}
            for question, (correct, capability) in rows.items()
        ],
    }


def test_treated_can_be_declared_by_the_field_the_mechanism_reaches(tmp_path: Path) -> None:
    """
    THE CASE RUN `40859499624` FORCED.

    `ask=derive` permutes two blocks of the prompt, so every prompt keeps its length -- the run's first
    prediction asserted exactly that and the artifact confirmed it on 500 of 500 records. The `promptChars`
    split therefore saw **0 treated questions** and printed an attribution failure about a treatment that had
    reached 121 of them and moved 18 verdicts. Declaring the population by the field the mechanism acts on is
    the repair, and the reading has to say which definition produced the buckets.
    """
    control = roster_with_capabilities(
        {"a": (True, "MR"), "b": (False, "MR"), "c": (True, "IE"), "d": (False, "IE")}
    )
    arm = roster_with_capabilities(
        {"a": (False, "MR"), "b": (True, "MR"), "c": (False, "IE"), "d": (False, "IE")}
    )

    completed = run_across(tmp_path, {"derive": arm}, control, ["--treated", "capability=MR"])

    assert completed.returncode == 0, completed.stderr
    assert "split by capability in {MR}" in completed.stdout
    assert "treated   : 2 questions, bought 1, sold 1, net +0" in completed.stdout
    assert "untouched : 2 questions, bought 0, sold 1, net -1" in completed.stdout


def test_a_permutation_split_says_the_prompt_lengths_did_not_move(tmp_path: Path) -> None:
    """The zero-treated reading names the shape it cannot see, rather than implying the treatment missed."""
    control = roster_with_prompts({"q1": (True, 100), "q2": (False, 100)})
    arm = roster_with_prompts({"q1": (False, 100), "q2": (True, 100)})

    completed = run_across(tmp_path, {"derive": arm}, control)

    assert completed.returncode == 0, completed.stderr
    assert "which is what a permutation treatment looks like from here" in completed.stdout
    assert "--treated <field>=<value>" in completed.stdout


def test_a_declared_field_the_arm_does_not_carry_is_unknown_not_untouched(tmp_path: Path) -> None:
    """
    Absent is not false. A record without the declared field cannot be classified, and counting it as
    untouched would put it in the noise bucket and move the excess by exactly its own verdicts.
    """
    control = roster({"q1": True, "q2": False})
    arm = {
        "dataset": "longmemeval/s/500",
        "questionCount": 2,
        "generatedAt": "2026-10-30T00:00:00.000Z",
        "questions": [
            {"questionId": "q1", "correct": False, "capability": "MR"},
            {"questionId": "q2", "correct": True},
        ],
    }

    completed = run_across(tmp_path, {"derive": arm}, control, ["--treated", "capability=MR"])

    assert completed.returncode == 0, completed.stderr
    assert "1 question(s) carry no promptChars on at least one side" in completed.stdout
    assert "treated   : 1 questions" in completed.stdout


def test_two_treated_definitions_are_refused(tmp_path: Path) -> None:
    """Two definitions would make the split depend on argument order, which nobody could read off the log."""
    control = roster_with_capabilities({"a": (True, "MR")})
    arm = roster_with_capabilities({"a": (False, "MR")})

    completed = run_across(
        tmp_path, {"derive": arm}, control, ["--treated", "capability=MR", "--treated", "capability=IE"]
    )

    assert completed.returncode == 2
    assert "names one population" in completed.stderr


def test_a_treated_value_without_an_equals_is_refused(tmp_path: Path) -> None:
    """A malformed selector must not fall back to `promptChars`: that is a different population silently."""
    control = roster_with_capabilities({"a": (True, "MR")})
    arm = roster_with_capabilities({"a": (False, "MR")})

    completed = run_across(tmp_path, {"derive": arm}, control, ["--treated", "capability"])

    assert completed.returncode == 2
    assert "takes <field>=<value>" in completed.stderr


def test_treated_without_a_control_is_refused(tmp_path: Path) -> None:
    """A declared population is a cross-run split; without a control there is nothing to price it against."""
    path = tmp_path / "arm.json"
    path.write_text(json.dumps(roster_with_capabilities({"a": (True, "MR")})), encoding="utf-8")

    completed = subprocess.run(
        ["node", str(TOOL), f"derive={path}", "--treated", "capability=MR"],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )

    assert completed.returncode == 2
    assert "needs --control" in completed.stderr


def test_json_carries_the_definition_the_buckets_were_cut_by(tmp_path: Path) -> None:
    """A later reader recomputes from the JSON, so it has to know which population was called treated."""
    control = roster_with_capabilities({"a": (True, "MR"), "b": (False, "IE")})
    arm = roster_with_capabilities({"a": (False, "MR"), "b": (True, "IE")})

    control_path = tmp_path / "control.json"
    control_path.write_text(json.dumps(control), encoding="utf-8")
    arm_path = tmp_path / "arm.json"
    arm_path.write_text(json.dumps(arm), encoding="utf-8")
    completed = subprocess.run(
        [
            "node",
            str(TOOL),
            "--control",
            str(control_path),
            "--across",
            f"derive={arm_path}",
            "--treated",
            "capability=MR",
            "--json",
        ],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    parsed = json.loads(completed.stdout)
    assert parsed["reach"][0]["treatedBy"] == "capability in {MR}"
    assert parsed["reach"][0]["treated"]["questions"] == 1


def roster_with_spread(
    rows: dict[str, tuple[bool, str]], by_capability: dict[str, tuple[float, float, float]], overall: tuple[float, float, float]
) -> dict:
    """A report carrying the four-run distribution, which is the comparison a paired delta is not."""
    return {
        "dataset": "longmemeval/s/500",
        "questionCount": len(rows),
        "generatedAt": "2026-10-30T00:00:00.000Z",
        "ablation": {
            "featureAggregate": {"min": overall[0], "avg": overall[1], "max": overall[2]},
            "featureByCapability": {
                capability: {"min": low, "avg": avg, "max": high}
                for capability, (low, avg, high) in by_capability.items()
            },
        },
        "questions": [
            {"questionId": question, "correct": correct, "capability": capability}
            for question, (correct, capability) in rows.items()
        ],
    }


def test_the_reading_prints_the_per_capability_means_beside_the_paired_delta(tmp_path: Path) -> None:
    """
    THE CASE RUN `40859499624` FORCED, AND THE ONE THAT CHANGED ITS VERDICT.

    The first-repetition pair read MR 87 → 81 and the run looked like a regression. Its own four repetitions
    ranged 83–89 and 81–87, so the two configurations overlap and the mean difference is −3.5. A tool that
    prints only the paired delta reports a difference a reader cannot price.
    """
    control = roster_with_spread(
        {"a": (True, "MR"), "b": (False, "MR"), "c": (True, "IE"), "d": (True, "IE")},
        {"MR": (83, 86.5, 89), "IE": (139, 140.25, 142)},
        (0.834, 0.842, 0.848),
    )
    arm = roster_with_spread(
        {"a": (False, "MR"), "b": (True, "MR"), "c": (True, "IE"), "d": (True, "IE")},
        {"MR": (81, 83, 87), "IE": (141, 142.5, 145)},
        (0.838, 0.8415, 0.85),
    )

    completed = run_across(tmp_path, {"derive": arm}, control, ["--treated", "capability=MR"])

    assert completed.returncode == 0, completed.stderr
    assert "per-capability means over all repetitions" in completed.stdout
    assert "MR: control 86.50 (83-89), derive 83.00 (81-87) -- ranges OVERLAP" in completed.stdout
    assert "overall mean: control 84.20%" in completed.stdout
    assert "delta -0.05 points" in completed.stdout


def test_overlapping_ranges_take_the_regression_wording_back(tmp_path: Path) -> None:
    """
    A negative excess on one pair of draws is a regression only if the runs themselves separate. When their
    repetition ranges overlap, the same arithmetic is a fluctuation, and the sentence has to change with it.
    """
    # Both MR questions are sold and one untouched question is sold too, so the excess is negative (-1) while
    # the two runs' overall ranges overlap -- the exact pair of facts run `40859499624` produced.
    control = roster_with_spread(
        {"a": (True, "MR"), "b": (True, "MR"), "c": (True, "IE"), "d": (True, "IE")},
        {"MR": (2, 2, 2), "IE": (139, 140.25, 142)},
        (0.48, 0.5, 0.52),
    )
    arm = roster_with_spread(
        {"a": (False, "MR"), "b": (False, "MR"), "c": (True, "IE"), "d": (False, "IE")},
        {"MR": (0, 0.5, 1), "IE": (141, 142.5, 145)},
        (0.49, 0.51, 0.53),
    )

    completed = run_across(tmp_path, {"derive": arm}, control, ["--treated", "capability=MR"])

    assert completed.returncode == 0, completed.stderr
    assert "the excess is negative on THIS PAIR OF DRAWS" in completed.stdout
    assert "it is not a separation" in completed.stdout
    assert "which is a regression and not a null" not in completed.stdout


def test_separated_ranges_keep_the_regression_wording(tmp_path: Path) -> None:
    """The other branch: when the ranges do not overlap, the negative excess is a regression and says so."""
    control = roster_with_spread(
        {"a": (True, "MR"), "b": (True, "MR"), "c": (True, "IE"), "d": (True, "IE")},
        {"MR": (2, 2, 2), "IE": (2, 2, 2)},
        (0.99, 1.0, 1.0),
    )
    arm = roster_with_spread(
        {"a": (False, "MR"), "b": (False, "MR"), "c": (True, "IE"), "d": (False, "IE")},
        {"MR": (0, 0, 0), "IE": (1, 1, 1)},
        (0.45, 0.5, 0.55),
    )

    completed = run_across(tmp_path, {"derive": arm}, control, ["--treated", "capability=MR"])

    assert completed.returncode == 0, completed.stderr
    assert "which is a regression and not a null" in completed.stdout
    assert "ranges OVERLAP" not in completed.stdout


def test_a_report_without_a_distribution_says_the_delta_is_one_draw(tmp_path: Path) -> None:
    """
    `questions[]` is the first repetition, so a report that carries no distribution supports only the
    noisiest comparison. Saying which one it is costs a line and prevents the delta being read as a mean.
    """
    control = roster_with_prompts({"q1": (True, 100), "q2": (False, 100)})
    arm = roster_with_prompts({"q1": (False, 200), "q2": (True, 100)})

    completed = run_across(tmp_path, {"sweep": arm}, control)

    assert completed.returncode == 0, completed.stderr
    assert "carries no per-run distribution, so the delta above is one draw against one draw" in completed.stdout


def test_json_carries_both_distributions(tmp_path: Path) -> None:
    """A later reader recomputes the overlap from the JSON, so both sides have to be in it."""
    control = roster_with_spread({"a": (True, "MR")}, {"MR": (1, 1, 1)}, (0.834, 0.842, 0.848))
    arm = roster_with_spread({"a": (False, "MR")}, {"MR": (0, 0, 0)}, (0.6, 0.7, 0.8))

    control_path = tmp_path / "control.json"
    control_path.write_text(json.dumps(control), encoding="utf-8")
    arm_path = tmp_path / "arm.json"
    arm_path.write_text(json.dumps(arm), encoding="utf-8")
    completed = subprocess.run(
        [
            "node",
            str(TOOL),
            "--control",
            str(control_path),
            "--across",
            f"derive={arm_path}",
            "--treated",
            "capability=MR",
            "--json",
        ],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )

    assert completed.returncode == 0, completed.stderr
    parsed = json.loads(completed.stdout)["reach"][0]["spread"]
    assert parsed["control"]["byCapability"]["MR"] == {"min": 1, "avg": 1, "max": 1}
    assert parsed["arm"]["overall"]["avg"] == 0.7
