"""`tools/arm-transition.mjs`, checked on artifacts built to fail one criterion at a time.

The tool applies the five criteria `§13.166.6` registered before the `ask: operands` dispatch. Each
test below moves exactly one thing and asserts exactly one verdict, because the failure this file
exists to prevent is a reading in which a criterion passes for the wrong reason: a population that
shrank, a capability whose average held while its draw fell, or a prompt that changed on a question
the mechanism was never supposed to reach.

Two of the tests are about the tool's *refusals* rather than its verdicts — a criterion attached to a
population it was not registered for is `skipped`, never rescaled and never failed — because that is
the difference between a reading and a number.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "arm-transition.mjs"

# Real question texts, because the shape classifier is a regex over the words and a synthetic
# "how many X" would be a test of the fixture rather than of the tool. These seven are the population
# `§13.166.6` named; `0a995998` and `a4996e51` are the controls -- one enumeration question, and one
# derivation question the classifier misses, which is the population `§13.166.8` registered for later.
DERIVATION = {
    "e6041065": "What percentage of packed shoes did I wear on my last trip?",
    "d905b33f": "What percentage discount did I get on the book from my favorite author?",
    "a1cc6108": "How old was I when Alex was born?",
    "ba358f49": "How many years will I be when my friend Rachel gets married?",
    "157a136e": "How many years older is my grandma than me?",
    "c18a7dc8": "How many years older am I than when I graduated from college?",
}
DERIVATION_AGGREGATION = {
    "92a0aa75": "How long have I been working in my current role?",
}
ENUMERATION = {
    "0a995998": "How many items of clothing do I need to pick up or return from a store?",
    "a4996e51": "How many hours do I work in a typical week during peak campaign seasons?",
}
NAMED = sorted(set(DERIVATION) | set(DERIVATION_AGGREGATION))


def question(qid: str, answer, gold: str, capability: str = "MR", prompt: int = 1000) -> dict:
    return {
        "questionId": qid,
        "question": (DERIVATION | DERIVATION_AGGREGATION | ENUMERATION)[qid],
        "capability": capability,
        "groundTruth": gold,
        "answer": answer,
        "rawOutput": "INSUFFICIENT_EVIDENCE" if answer is None else "1.",
        "correct": False,
        "promptChars": prompt,
    }


def report(
    questions: list[dict],
    reference_only: list[str],
    *,
    capabilities: dict[str, float] | None = None,
    draws: dict[str, int] | None = None,
    accuracy: float = 0.83,
    generation: str = "2026-10-30T00:00:00.000Z",
) -> dict:
    """A minimal artifact: the fields the tool reads, and nothing else."""
    capabilities = capabilities or {"ABS": 29, "IE": 142.5, "KU": 63.25, "MR": 84.75, "TR": 101}
    draws = draws or {"ABS": 29, "IE": 141, "KU": 62, "MR": 83, "TR": 97}
    return {
        "dataset": "longmemeval",
        "questionCount": len(questions),
        "generatedAt": generation,
        "questions": questions,
        "ablation": {
            "discordantQuestions": {"baselineCorrectFeatureIncorrect": reference_only},
            "featureByCapability": {
                name: {"min": value, "avg": value, "max": value} for name, value in capabilities.items()
            },
        },
        "feature": {
            "metrics": {
                "abstentionAwareAccuracy": accuracy,
                "perCapability": {
                    name: {"total": 1, "correct": value, "accuracy": 0, "abstained": 0}
                    for name, value in draws.items()
                },
            }
        },
    }


def declines(prompt: int = 1000) -> list[dict]:
    return [question(qid, None, "7", prompt=prompt) for qid in NAMED]


def run(before: dict, after: dict, tmp_path: Path, capability: str = "MR"):
    before_path = tmp_path / "before.json"
    after_path = tmp_path / "after.json"
    before_path.write_text(json.dumps(before))
    after_path.write_text(json.dumps(after))
    completed = subprocess.run(
        [sys.executable.replace("python", "node") if False else "node", str(TOOL),
         "--before", str(before_path), "--after", str(after_path),
         "--capability", capability, "--json"],
        capture_output=True,
        text=True,
        check=False,
    )
    return completed, json.loads(completed.stdout) if completed.stdout.strip() else None


def criterion(reading: dict, number: int) -> dict:
    return next(row for row in reading["criteria"] if row["registered"] == number)


class TestTheNamedPopulation:
    """Criterion 1: at least four of the seven stop being reference-only."""

    def test_four_leaving_passes(self, tmp_path: Path) -> None:
        before = report(declines(), NAMED)
        gone = NAMED[:4]
        after = report([q for q in declines() if q["questionId"] not in gone], [q for q in NAMED if q not in gone])
        _, reading = run(before, after, tmp_path)
        assert criterion(reading, 1)["verdict"] == "pass"
        assert reading["namedLeft"] == 4

    def test_three_leaving_fails(self, tmp_path: Path) -> None:
        before = report(declines(), NAMED)
        gone = NAMED[:3]
        after = report([q for q in declines() if q["questionId"] not in gone], [q for q in NAMED if q not in gone])
        completed, reading = run(before, after, tmp_path)
        assert criterion(reading, 1)["verdict"] == "fail"
        assert completed.returncode == 1

    def test_the_population_is_read_from_the_before_state(self, tmp_path: Path) -> None:
        # The registration named the seven before the dispatch. If the after-state were allowed to
        # define the set, a treatment that widened its own classifier would be judged on the wider
        # set and could report a higher fraction of a population it invented.
        before = report(declines(), NAMED)
        # The after-state emits an extra derivation-shaped decline the before-state never had. It must
        # not join the denominator.
        after = report(declines() + [question("a4996e51", None, "50")], NAMED[4:])
        _, reading = run(before, after, tmp_path)
        assert reading["named"] == sorted(NAMED)

    def test_six_named_questions_skip_rather_than_rescale(self, tmp_path: Path) -> None:
        # Four of seven is 57%. Rescaling the bar for a six-question population would silently move
        # the threshold, and failing it would report a defect where the truth is that this pair is
        # not the one the registration describes.
        six = NAMED[1:]
        before = report([question(qid, None, "7") for qid in six], six)
        after = report([question(qid, None, "7") for qid in six[:2]], six[2:])
        _, reading = run(before, after, tmp_path)
        assert criterion(reading, 1)["verdict"] == "skipped"
        assert "does not describe this reading" in criterion(reading, 1)["detail"]


class TestTheOffByOneSet:
    """Criterion 2: the ten controls are not permitted to move by more than two."""

    def _pair(self, moved: int):
        ids = [f"c{i:02d}" for i in range(10)]
        before_qs = [dict(question("0a995998", "2", "3")) | {"questionId": qid} for qid in ids]
        after_qs = []
        after_ids = []
        for index, qid in enumerate(ids):
            row = dict(question("0a995998", "2", "3")) | {"questionId": qid}
            if index < moved:
                row["answer"] = "3"
                row["correct"] = True
            else:
                after_ids.append(qid)
            after_qs.append(row)
        return report(before_qs, ids), report(after_qs, after_ids)

    def test_two_moving_passes(self, tmp_path: Path) -> None:
        before, after = self._pair(2)
        _, reading = run(before, after, tmp_path)
        assert criterion(reading, 2)["verdict"] == "pass"

    def test_three_moving_fails(self, tmp_path: Path) -> None:
        before, after = self._pair(3)
        completed, reading = run(before, after, tmp_path)
        assert criterion(reading, 2)["verdict"] == "fail"
        assert completed.returncode == 1

    def test_the_control_set_is_sized_before_the_run(self, tmp_path: Path) -> None:
        # Eight controls is not the registered ten. A `moved <= 2` on a set of eight would be a
        # different test, so the criterion is skipped and the detail says why.
        before, after = self._pair(3)
        before["ablation"]["discordantQuestions"]["baselineCorrectFeatureIncorrect"] = [
            qid for qid in before["ablation"]["discordantQuestions"]["baselineCorrectFeatureIncorrect"]
        ][:8]
        _, reading = run(before, after, tmp_path)
        assert criterion(reading, 2)["verdict"] == "skipped"


class TestCapabilitiesAndAccuracy:
    """Criteria 3 and 4, on the band average rather than on one draw."""

    def test_a_three_question_drop_in_the_average_fails(self, tmp_path: Path) -> None:
        before = report(declines(), NAMED, capabilities={"ABS": 29, "IE": 142.5, "KU": 63.25, "MR": 84.75, "TR": 101})
        after = report(declines(), NAMED, capabilities={"ABS": 29, "IE": 142.5, "KU": 63.25, "MR": 81.75, "TR": 101})
        completed, reading = run(before, after, tmp_path)
        assert criterion(reading, 3)["verdict"] == "fail"
        assert completed.returncode == 1

    def test_a_jittery_draw_under_a_held_average_passes(self, tmp_path: Path) -> None:
        # This is the shape `40989420944` actually has: MR 83..86 over four runs, so a draw can read
        # -3 while the average moves by less than one. A criterion read off the draw would report a
        # loss that is inside the arm's own spread.
        before = report(declines(), NAMED, capabilities={"MR": 84.75}, draws={"MR": 87})
        after = report(declines(), NAMED, capabilities={"MR": 84.0}, draws={"MR": 84})
        _, reading = run(before, after, tmp_path)
        row = next(r for r in reading["perCapability"] if r["capability"] == "MR")
        assert row["runDelta"] == -3
        assert row["delta"] == pytest.approx(-0.75)
        assert criterion(reading, 3)["verdict"] == "pass"

    def test_abs_moving_at_all_fails(self, tmp_path: Path) -> None:
        # The abstention route is outside the ask's reach: a change there is not the mechanism.
        before = report(declines(), NAMED, capabilities={"ABS": 29, "MR": 84.75})
        after = report(declines(), NAMED, capabilities={"ABS": 28, "MR": 86.75})
        _, reading = run(before, after, tmp_path)
        assert criterion(reading, 3)["verdict"] == "fail"
        assert "cannot reach" in criterion(reading, 3)["detail"]

    def test_a_gain_of_one_point_passes_and_a_hair_under_fails(self, tmp_path: Path) -> None:
        before = report(declines(), NAMED, accuracy=0.83)
        after = report(declines(), NAMED, accuracy=0.84)
        _, reading = run(before, after, tmp_path)
        assert criterion(reading, 4)["verdict"] == "pass"

        under = report(declines(), NAMED, accuracy=0.8399)
        _, reading = run(before, under, tmp_path)
        assert criterion(reading, 4)["verdict"] == "fail"


class TestTheAssemblyCheck:
    """Criterion 5: the prompt moves on the seven and nowhere else."""

    def _pair(self, named_prompt: int, outside_prompt: int):
        # The control is part of every fixture: criterion 5's population is "the named seven and
        # whatever else this capability has", and an artifact with no outside record would skip the
        # check rather than pass it.
        before = report(declines() + [question("0a995998", "2", "3")], NAMED + ["0a995998"])
        after = report(
            [question(qid, None, "7", prompt=named_prompt) for qid in NAMED]
            + [question("0a995998", "2", "3", prompt=outside_prompt)],
            NAMED + ["0a995998"],
        )
        return before, after

    def test_a_clean_mechanism_passes(self, tmp_path: Path) -> None:
        before, after = self._pair(1200, 1000)
        _, reading = run(before, after, tmp_path)
        assert criterion(reading, 5)["verdict"] == "pass"
        assert f"{len(NAMED)}/{len(NAMED)} named moved" in criterion(reading, 5)["detail"]

    def test_one_prompt_outside_the_population_fails(self, tmp_path: Path) -> None:
        # The leak case, and the reason this criterion is not an outcome check: a change that helps
        # the seven and also alters a control is not attributable to the mechanism, whatever the
        # accuracy did.
        before, after = self._pair(1200, 1001)
        completed, reading = run(before, after, tmp_path)
        assert criterion(reading, 5)["verdict"] == "fail"
        assert "0a995998 1000->1001" in criterion(reading, 5)["detail"]
        assert completed.returncode == 1

    def test_one_named_prompt_that_did_not_move_fails(self, tmp_path: Path) -> None:
        # The other direction: five changed and one did not means the mechanism has a hole in the
        # population it claims to reach, and criterion 1's count would be read against a machine that
        # was never administered.
        before = report(declines() + [question("0a995998", "2", "3")], NAMED + ["0a995998"])
        after = report(
            [question(qid, None, "7", prompt=1200 if qid != NAMED[0] else 1000) for qid in NAMED]
            + [question("0a995998", "2", "3")],
            NAMED + ["0a995998"],
        )
        _, reading = run(before, after, tmp_path)
        assert criterion(reading, 5)["verdict"] == "fail"
        assert NAMED[0] in criterion(reading, 5)["detail"]

    def test_a_record_outside_the_capability_is_ignored(self, tmp_path: Path) -> None:
        # Only MR records are the assembly population. A TR prompt that moved belongs to another
        # reading and would otherwise fail this one for a reason about a different capability.
        before = report(
            declines()
            + [question("a4996e51", "40", "50")]  # the MR control: an enum question, prompt held
            + [question("0a995998", "2", "3", capability="TR")],
            NAMED + ["a4996e51", "0a995998"],
        )
        after = report(
            [question(qid, None, "7", prompt=1200) for qid in NAMED]
            + [question("a4996e51", "40", "50")]
            + [question("0a995998", "2", "3", capability="TR", prompt=1400)],
            NAMED + ["a4996e51", "0a995998"],
        )
        _, reading = run(before, after, tmp_path)
        assert criterion(reading, 5)["verdict"] == "pass"
        assert [row["id"] for row in reading["promptChars"]["outside"]] == ["a4996e51"]


class TestTheReading:
    """The transitions table, the exit code, and the two refusals of the entry point."""

    def test_a_question_crossing_the_other_way_is_in_the_table(self, tmp_path: Path) -> None:
        before = report(declines(), NAMED)
        after = report(declines() + [question("0a995998", "2", "3")], NAMED + ["0a995998"])
        _, reading = run(before, after, tmp_path)
        row = next(r for r in reading["rows"] if r["id"] == "0a995998")
        assert row["before"] is None
        assert row["after"] == "off-by-one"
        assert row["transition"] == "answered -> off-by-one"

    def test_the_exit_code_ignores_skipped_criteria(self, tmp_path: Path) -> None:
        # Every applicable criterion passing while two are skipped is exit 0, and the count is printed
        # so a reader can see how much of the registration this pair actually posed.
        before = report(
            declines() + [question("0a995998", "2", "3")],
            NAMED + ["0a995998"],
            accuracy=0.83,
        )
        # The four that convert keep their RECORD: a question the feature now answers is still one
        # of the five hundred, it has merely left the discordant list. Dropping the record instead
        # would leave `promptChars` unreadable for them and criterion 5 would fail for a reason about
        # the fixture.
        gone = NAMED[:4]
        after = report(
            [question(qid, "7", "7", prompt=1200) if qid in gone else question(qid, None, "7", prompt=1200)
             for qid in NAMED]
            + [question("0a995998", "2", "3")],
            [qid for qid in NAMED if qid not in gone] + ["0a995998"],
            accuracy=0.85,
            capabilities={"ABS": 29, "IE": 142.5, "KU": 63.25, "MR": 85.0, "TR": 101},
        )
        completed, reading = run(before, after, tmp_path)
        assert reading["skipped"] == 1
        assert reading["failed"] == 0
        assert completed.returncode == 0

    def test_a_missing_argument_is_a_usage_error_not_a_traceback(self) -> None:
        completed = subprocess.run(
            ["node", str(TOOL), "--before", "only-one.json"],
            capture_output=True,
            text=True,
            check=False,
        )
        assert completed.returncode == 2
        assert "usage:" in completed.stderr

    def test_the_human_reading_names_every_criterion_and_every_transition(self, tmp_path: Path) -> None:
        gone = NAMED[:4]
        before = report(declines() + [question("0a995998", "2", "3")], NAMED + ["0a995998"], accuracy=0.83)
        after = report(
            [question(qid, "7", "7", prompt=1200) if qid in gone else question(qid, None, "7", prompt=1200)
             for qid in NAMED]
            + [question("0a995998", "2", "3")],
            [qid for qid in NAMED if qid not in gone] + ["0a995998"],
            accuracy=0.85,
        )
        before_path = tmp_path / "b.json"
        after_path = tmp_path / "a.json"
        before_path.write_text(json.dumps(before))
        after_path.write_text(json.dumps(after))
        completed = subprocess.run(
            ["node", str(TOOL), "--before", str(before_path), "--after", str(after_path)],
            capture_output=True,
            text=True,
            check=False,
        )
        assert completed.returncode == 0
        for number in range(1, 6):
            assert f"  {number}  " in completed.stdout
        assert NAMED[0] in completed.stdout
        assert "applicable" in completed.stdout
