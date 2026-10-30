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
        # Synthetic ids fall back to a real MR question text: the shape classifier reads the words, and a
        # test whose fixtures are named `a00`.. is a test of the criterion rather than of the classifier.
        "question": (DERIVATION | DERIVATION_AGGREGATION | ENUMERATION).get(qid, ENUMERATION["0a995998"]),
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


class TestTheChangedPopulation:
    """Criterion 2, as amended by `13.174.3`: the population the mechanism reached carries no systematic loss.

    The superseded row counted class movements among ten off-by-one questions. `41039779987` falsified it:
    all five movers had byte-identical prompts, so the movement was form churn rather than a leak, and a
    count over a form class cannot detect a leak that the classifier does not model. What the row was for is
    the population the treatment actually applied to, and the loss there is a fact about the treatment
    rather than about a classifier: a prompt that grew can distract, so a small band is allowed and a
    systematic one is not.
    """

    def _pair(self, rows: list[tuple[str, bool, bool, int, int]]):
        """`(id, was_correct, now_correct, prompt_before, prompt_after)` per question."""
        before = [dict(question(qid, "7", "7", prompt=was_prompt)) | {"correct": was} for qid, was, _, was_prompt, _ in rows]
        after = [dict(question(qid, "7", "7", prompt=now_prompt)) | {"correct": now} for qid, _, now, _, now_prompt in rows]
        return report(before, []), report(after, [])

    def test_a_clean_changed_population_passes(self, tmp_path: Path) -> None:
        rows = [(f"a{i:02d}", False, True, 1000, 1300) for i in range(20)]
        before, after = self._pair(rows)
        completed, reading = run(before, after, tmp_path)
        assert criterion(reading, 2)["verdict"] == "pass"
        assert completed.returncode == 0

    def test_two_losses_in_twenty_fails(self, tmp_path: Path) -> None:
        # 10% of the reached population, against a 5% band: this is damage on the questions the
        # enrichment touched, which is the claim the row exists to falsify.
        rows = [(f"a{i:02d}", False, True, 1000, 1300) for i in range(18)]
        rows += [(f"b{i:02d}", True, False, 1000, 1300) for i in range(2)]
        before, after = self._pair(rows)
        completed, reading = run(before, after, tmp_path)
        assert criterion(reading, 2)["verdict"] == "fail"
        assert completed.returncode == 1

    def test_one_loss_in_twenty_is_at_the_boundary_and_passes(self, tmp_path: Path) -> None:
        rows = [(f"a{i:02d}", False, True, 1000, 1300) for i in range(19)]
        rows += [("b00", True, False, 1000, 1300)]
        before, after = self._pair(rows)
        _, reading = run(before, after, tmp_path)
        assert criterion(reading, 2)["verdict"] == "pass"

    def test_a_net_loss_fails_even_inside_the_loss_band(self, tmp_path: Path) -> None:
        # 1% of a hundred is inside the band, and it is still a net loss on the only population the
        # treatment can be credited or blamed for.
        rows = [(f"a{i:02d}", False, False, 1000, 1300) for i in range(99)]
        rows += [("b00", True, False, 1000, 1300)]
        before, after = self._pair(rows)
        completed, reading = run(before, after, tmp_path)
        assert criterion(reading, 2)["verdict"] == "fail"
        assert "net" in criterion(reading, 2)["detail"]
        assert completed.returncode == 1

    def test_a_pair_with_no_changed_prompt_skips_rather_than_rescales(self, tmp_path: Path) -> None:
        # The mechanism reached nothing, so its population has no size and the row has no verdict.
        rows = [(f"a{i:02d}", False, True, 1000, 1000) for i in range(20)]
        before, after = self._pair(rows)
        _, reading = run(before, after, tmp_path)
        assert criterion(reading, 2)["verdict"] == "skipped"


class TestCapabilitiesAndAccuracy:
    """Criterion 3 on the band average rather than on one draw, and criterion 4 on the reached population."""

    def _pair(self, rows: list[tuple[str, bool, bool, int, int]]):
        """`(id, was_correct, now_correct, prompt_before, prompt_after)` per question."""
        before = [dict(question(qid, "7", "7", prompt=was_prompt)) | {"correct": was} for qid, was, _, was_prompt, _ in rows]
        after = [dict(question(qid, "7", "7", prompt=now_prompt)) | {"correct": now} for qid, _, now, _, now_prompt in rows]
        return report(before, []), report(after, [])

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

    def test_one_attributable_gain_in_a_hundred_passes_and_a_hair_under_fails(self, tmp_path: Path) -> None:
        # `13.174.4`. The superseded row read total accuracy, and `41039779987` met it by +2.60 points of
        # which +0.80 was attributable: a headline 69% made of churn on records whose prompt never
        # changed. The claim the ask makes is about the questions it reached, so the row reads them.
        rows = [(f"a{i:02d}", False, i == 0, 1000, 1300) for i in range(100)]
        before, after = self._pair(rows)
        _, reading = run(before, after, tmp_path)
        assert criterion(reading, 4)["verdict"] == "pass"

        hair_under = [(f"a{i:02d}", False, i == 0, 1000, 1300) if i != 99 else ("a99", True, False, 1000, 1300) for i in range(100)]
        before, under = self._pair(hair_under)
        _, reading = run(before, under, tmp_path)
        assert criterion(reading, 4)["verdict"] == "fail"

    def test_a_headline_met_by_churn_fails_the_row_it_no_longer_satisfies(self, tmp_path: Path) -> None:
        # The exact shape of the run that produced this amendment: accuracy rises 2.60 points, the
        # reached population contributes 0.40 of them, and the rest is 39 flips on identical prompts.
        # 27 reached with +4/-0, and 473 untouched with +24/-15 -- the second group's losses are part of
        # its 473, not an extra population, which is what makes the denominator 500.
        rows = [(f"c{i:03d}", False, i < 4, 1000, 1300) for i in range(27)]
        rows += [(f"u{i:03d}", 24 <= i < 39, i < 24, 1000, 1000) for i in range(473)]
        before, after = self._pair(rows)
        after["feature"]["metrics"]["abstentionAwareAccuracy"] = 0.856
        before["feature"]["metrics"]["abstentionAwareAccuracy"] = 0.830
        _, reading = run(before, after, tmp_path)
        row = criterion(reading, 4)
        assert row["verdict"] == "fail"
        assert "attributable" in row["detail"]
        assert "+0.80" in row["detail"]


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


class TestTheRepeatPremise:
    """Criterion 6, new in `13.174.5`: the repetitions were repetitions.

    `13.147.3` predicted a 60-80% prefix-cache hit share on the premise that passes 2-4 resend pass 1's
    bytes. Two artifacts read 6.47% and 11.16% and neither could separate "the provider did not cache" from
    "the arm sent four prompts". `13.174` measures the second directly, per question, so the premise is now
    a criterion instead of an assumption -- and a run that fails it makes its own cost numbers unreadable
    rather than wrong.
    """

    def _pair(self, variants: list[int | None]):
        rows = [dict(question(f"a{i:02d}", "7", "7")) | {"promptVariants": value} for i, value in enumerate(variants)]
        return report(rows, []), report(rows, [])

    def test_one_prompt_per_question_passes(self, tmp_path: Path) -> None:
        before, after = self._pair([1] * 20)
        _, reading = run(before, after, tmp_path)
        assert criterion(reading, 6)["verdict"] == "pass"

    def test_two_divergent_questions_in_twenty_fails(self, tmp_path: Path) -> None:
        before, after = self._pair([1] * 18 + [2, 4])
        completed, reading = run(before, after, tmp_path)
        assert criterion(reading, 6)["verdict"] == "fail"
        assert completed.returncode == 1

    def test_the_boundary_is_ninety_five_percent(self, tmp_path: Path) -> None:
        before, after = self._pair([1] * 38 + [2, 3])
        _, reading = run(before, after, tmp_path)
        assert criterion(reading, 6)["verdict"] == "pass"

    def test_an_unverifiable_question_counts_against_the_premise(self, tmp_path: Path) -> None:
        # `null` is a pass that declined to say what it sent. It is not evidence for the premise, so it
        # joins the divergent side; two of twenty is 90% and fails.
        before, after = self._pair([1] * 18 + [None, None])
        _, reading = run(before, after, tmp_path)
        assert criterion(reading, 6)["verdict"] == "fail"
        assert "unverifiable" in criterion(reading, 6)["detail"]

    def test_an_artifact_without_the_field_skips(self, tmp_path: Path) -> None:
        # Every artifact in the archive before `13.174` is this case, and a verdict on it would be a
        # verdict about the tool's default rather than about the run.
        rows = [question(f"a{i:02d}", "7", "7") for i in range(20)]
        _, reading = run(report(rows, []), report(rows, []), tmp_path)
        assert criterion(reading, 6)["verdict"] == "skipped"

    def test_the_reading_names_the_amendment_it_applies(self, tmp_path: Path) -> None:
        before, after = self._pair([1] * 20)
        _, reading = run(before, after, tmp_path)
        assert "13.174" in reading["criteriaSource"]
        assert "13.166.6" in reading["criteriaSource"]


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
            [dict(question(qid, "7", "7", prompt=1200), correct=True) if qid in gone else question(qid, None, "7", prompt=1200)
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
            [dict(question(qid, "7", "7", prompt=1200), correct=True) if qid in gone else question(qid, None, "7", prompt=1200)
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


class TestWhereTheGainCameFrom:
    """The division `§13.172.4` had to perform by hand, as a reading the tool prints.

    The five criteria are registered and their thresholds are not this class's business. What this
    class pins is the *second* number a pair produces: how much of a net gain sits on records whose
    prompt actually changed, and how much sits on records where nothing could have reached it.

    The reason it has to be a reading rather than a remark is the run that produced it. A +2.60-point
    headline was 69% churn on 473 records with byte-identical prompts, and the artifact contained every
    field needed to see that. A tool that printed only the headline would have let the claim stand.
    """

    def record(self, qid: str, *, correct: bool, prompt: int) -> dict:
        """One record, built here rather than through the shared helper so ids can be synthetic.

        The attribution reading does not consult the shape classifier, so these records need no real
        question text -- and a fixture whose ids encode which population a row belongs to is one whose
        failures name the population instead of an index.
        """
        return {
            "questionId": qid,
            "question": "How many items of clothing do I need to pick up or return from a store?",
            "capability": "MR",
            "groundTruth": "7",
            "answer": "7",
            "rawOutput": "1.",
            "correct": correct,
            "promptChars": prompt,
        }

    def flipping(
        self, qid: str, *, was: bool, now: bool, prompt: int, prompt_after: int | None = None
    ) -> tuple[dict, dict]:
        """One question, correct `was` before and `now` after, at the given prompt sizes."""
        return (
            self.record(qid, correct=was, prompt=prompt),
            self.record(qid, correct=now, prompt=prompt if prompt_after is None else prompt_after),
        )

    def pair(self, rows: list[tuple[dict, dict]], reference_only: list[str], **kwargs) -> tuple[dict, dict]:
        return (
            report([b for b, _ in rows], reference_only, **kwargs),
            report([a for _, a in rows], reference_only, **kwargs),
        )

    def test_a_flip_on_a_changed_prompt_is_attributable(self, tmp_path: Path) -> None:
        before, after = self.pair([self.flipping("0a995998", was=False, now=True, prompt=1000, prompt_after=1200)], [])
        _, reading = run(before, after, tmp_path)
        attribution = reading["attribution"]
        assert attribution["changed"]["n"] == 1
        assert attribution["changed"]["gained"] == 1
        assert attribution["unchanged"]["n"] == 0

    def test_a_flip_on_an_identical_prompt_is_churn(self, tmp_path: Path) -> None:
        # The whole point: nothing reached this record, so its flip cannot be evidence for the
        # treatment. Counting it as gain is the error the run made at 473-record scale.
        before, after = self.pair([self.flipping("0a995998", was=False, now=True, prompt=1000)], [])
        _, reading = run(before, after, tmp_path)
        attribution = reading["attribution"]
        assert attribution["changed"]["n"] == 0
        assert attribution["unchanged"] == {"n": 1, "gained": 1, "lost": 0, "net": 1}
        assert attribution["changed"]["net"] == 0
        assert attribution["attributablePoints"] == 0.0
        assert attribution["churnRate"] == 1.0

    def test_an_unmeasured_record_is_neither_population(self, tmp_path: Path) -> None:
        # An artifact from before the field existed has no `promptChars` on either side. Filing those
        # as "unchanged" would report a population whose prompts were never compared as identical.
        before, after = self.pair([self.flipping("0a995998", was=False, now=True, prompt=1000)], [])
        del before["questions"][0]["promptChars"]
        del after["questions"][0]["promptChars"]
        _, reading = run(before, after, tmp_path)
        attribution = reading["attribution"]
        assert attribution["unmeasured"] == 1
        assert attribution["changed"]["n"] == 0
        assert attribution["unchanged"]["n"] == 0
        assert attribution["measurable"] is False
        assert attribution["attributablePoints"] is None

    def test_the_run_this_was_built_from_reads_as_it_read(self, tmp_path: Path) -> None:
        # 27 records whose prompt changed with +4/-0, and 473 identical ones with +24/-15, which is
        # +0.80 attributable of a +2.60 headline. Built at fixture scale rather than at 500 by using
        # 5 and 95 with the same proportions, then read as points over the records both sides hold.
        rows = []
        # Five records whose prompt changed: four flip from wrong to right and one does not move, which
        # is `41039779987`'s +4/-0 on its 27.
        for i in range(5):
            rows.append(self.flipping(f"changed-{i}", was=i == 4, now=True, prompt=1000, prompt_after=1273))
        # Forty-seven whose prompt is identical: three flip up and two flip down, which is the churn
        # the same run measured at 24 up and 15 down over 473.
        for i in range(47):
            rows.append(
                self.flipping(f"same-{i}", was=30 <= i < 32, now=i < 3, prompt=1000)
            )
        before, after = self.pair(rows, [], accuracy=0.83)
        after["feature"]["metrics"]["abstentionAwareAccuracy"] = 0.85
        _, reading = run(before, after, tmp_path)
        attribution = reading["attribution"]
        assert attribution["changed"] == {"n": 5, "gained": 4, "lost": 0, "net": 4}
        assert attribution["unchanged"]["n"] == 47
        assert attribution["unchanged"]["gained"] == 3
        assert attribution["unchanged"]["lost"] == 2
        assert attribution["attributablePoints"] == pytest.approx(4 / 52 * 100)
        # And criterion 4 still reads the headline it was registered on, unchanged.
        assert criterion(reading, 4)["verdict"] == "pass"
        assert "+2.00 pt" in criterion(reading, 4)["detail"]
        assert "attributable" in criterion(reading, 4)["detail"]

    def test_the_reading_does_not_move_the_exit_code(self, tmp_path: Path) -> None:
        # Attribution is a reading, not a criterion. A pair that meets all five registered thresholds
        # exits 0 even when every gain it produced was churn -- the registered claims were met, and the
        # note beside them says what they are worth.
        gone = NAMED[:4]
        rows = []
        for qid in NAMED:
            was, now = (False, True) if qid in gone else (False, False)
            rows.append(
                self.flipping(
                    qid,
                    was=was,
                    now=now,
                    prompt=1000,
                    prompt_after=1200 if qid in gone else 1000,
                )
            )
        before, after = self.pair(rows, [qid for qid in NAMED if qid not in gone], accuracy=0.83)
        after["feature"]["metrics"]["abstentionAwareAccuracy"] = 0.86
        completed, reading = run(before, after, tmp_path)
        assert reading["attribution"]["changed"]["n"] == len(gone)
        assert all(row["verdict"] != "fail" for row in reading["criteria"] if row["applicable"])
        assert completed.returncode == 0


class TestThePromptRepeatWitness:
    """`13.176`: the witness names the bytes, where `13.174`'s count could only name the fact.

    `41090564131` read `4` variants on all 500 questions while two dispatches of the identical
    configuration delivered identical evidence -- same turns, same order, same character count, `0/500`
    equal digests. That combination leaves only the invariant part of the prompt, and a count cannot point
    at it. The witness is one question's prompts in full, plus how far each pass agrees with the first.
    """

    def _pair(self, witness: dict | None):
        rows = [dict(question(f"a{i:02d}", "7", "7")) | {"promptVariants": 4} for i in range(20)]
        before = report(rows, [])
        after = report(rows, [])
        if witness is not None:
            after["ablation"]["featurePromptRepeatWitness"] = witness
        return before, after

    def test_the_divergence_offset_is_the_first_byte_the_passes_do_not_share(self, tmp_path: Path) -> None:
        before, after = self._pair(
            {
                "index": 0,
                "questionId": "a00",
                "texts": ["EVIDENCE:\n1. a\n\nQUESTION: q\n\nANSWER NOW", "EVIDENCE:\n1. a\n\nQUESTION: q\n\nANSWER LATER"],
                "commonPrefix": [None, 36],
            }
        )
        _, reading = run(before, after, tmp_path)
        witness = reading["promptRepeatWitness"]
        assert witness["questionId"] == "a00"
        shared = len("EVIDENCE:\n1. a\n\nQUESTION: q\n\nANSWER ")
        assert witness["divergence"]["offset"] == shared
        # The window is 60 bytes each way, so at this offset it reaches back to byte 0 rather than
        # starting mid-token. Both sides are shown, because an offset alone names no bytes.
        assert "ANSWER NOW" in witness["divergence"]["before"]
        assert "ANSWER LATER" in witness["divergence"]["after"]

    def test_a_prefix_the_bytes_do_not_support_is_reported_rather_than_trusted(self, tmp_path: Path) -> None:
        # The stored figure is the writer's claim. A tool that printed it could not tell a wrong claim from
        # a right one, so the offset is recomputed and the disagreement is named.
        before, after = self._pair(
            {"index": 0, "questionId": "a00", "texts": ["abcdef", "abcxyz"], "commonPrefix": [None, 1]}
        )
        _, reading = run(before, after, tmp_path)
        assert reading["promptRepeatWitness"]["divergence"]["offset"] == 3
        assert reading["promptRepeatWitness"]["misreportedPasses"] == [1]

    def test_identical_passes_report_no_divergence_rather_than_a_zero(self, tmp_path: Path) -> None:
        before, after = self._pair(
            {"index": 0, "questionId": "a00", "texts": ["same", "same"], "commonPrefix": [None, 4]}
        )
        _, reading = run(before, after, tmp_path)
        assert reading["promptRepeatWitness"]["divergence"] is None

    def test_a_pass_with_no_prompt_is_reported_as_such_not_as_a_prefix(self, tmp_path: Path) -> None:
        before, after = self._pair(
            {"index": 0, "questionId": "a00", "texts": ["same", None], "commonPrefix": [None, None]}
        )
        _, reading = run(before, after, tmp_path)
        assert reading["promptRepeatWitness"]["divergence"]["reason"] == "a pass reported no prompt"
        assert reading["promptRepeatWitness"]["divergence"]["offset"] is None

    def test_an_artifact_without_a_witness_says_absent_instead_of_printing_nothing(self, tmp_path: Path) -> None:
        before, after = self._pair(None)
        _, reading = run(before, after, tmp_path)
        assert reading["promptRepeatWitness"] is None

    def test_the_witness_is_read_from_the_run_and_not_from_a_record(self, tmp_path: Path) -> None:
        # A top-level witness is a second address for one field, and a reader that accepted both would
        # report a witness on an artifact that carries none in the place the writer puts it.
        before, after = self._pair(None)
        after["featurePromptRepeatWitness"] = {
            "index": 0,
            "questionId": "a00",
            "texts": ["same", "same"],
            "commonPrefix": [None, 4],
        }
        _, reading = run(before, after, tmp_path)
        assert reading["promptRepeatWitness"] is None
