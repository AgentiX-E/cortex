#!/usr/bin/env python3
"""The queue is priced from a frozen census, and an empty class is a refusal.

## The defect this file is written against

`AUDIT-FAILURE-CLASSES.md` section 5 concluded that *"the delivery institution is empty on this arm
under both renderings"* -- and the roadmap kept the delivery row at "~10 CNY, not designed" for two
more rounds anyway. Nothing was wrong with the arithmetic and nothing was wrong with the reading: the
sentence lived in a note and the row lived in a table, and no mechanism compared them.

That is the same class this repository has recorded for workflows (`arm-config-guard.mjs`: three
copies of the numbers and the gate was green because the workflows were not one of them) one layer
out. The fix is not a fourth copy. It is a file the table is *generated from* plus a check that the
file adds up.

## What is asserted

1. the census is internally consistent -- routes sum to the population, classes sum to the failures,
   and an uncounted failure is refused rather than ignored;
2. the three rows the last two rounds argued about price the way the argument says -- delivery on
   `TR`/`IE`/`KU` is **empty**, delivery anywhere is **refused** by the floor, and the numeric
   institution bundled is the only row with room above it;
3. a class name outside the eight the classifier can emit is refused rather than read as zero, so a
   typo cannot turn a measured class into an empty one.
"""

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
TOOL = ROOT / "tools" / "queue-floor.mjs"
CENSUS = ROOT / "tools" / "failure-census.json"


def _run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(TOOL), *args],
        cwd=str(ROOT),
        capture_output=True,
        text=True,
        check=False,
    )


def _census() -> dict:
    return json.loads(CENSUS.read_text(encoding="utf-8"))


class TestTheCensusAddsUp(unittest.TestCase):
    def test_the_routes_sum_to_the_population(self) -> None:
        table = _census()
        self.assertEqual(sum(row["n"] for row in table["routes"].values()), table["questionCount"])
        self.assertEqual(
            sum(row["correct"] for row in table["routes"].values()),
            table["questionCount"] - sum(row["count"] for row in table["classes"].values()),
        )

    def test_every_route_is_one_the_product_prints(self) -> None:
        # The six route names are the artifact's own vocabulary; a census over a seventh name would be
        # a census over a route no question carries.
        self.assertEqual(
            set(_census()["routes"]),
            {
                "multi-session",
                "temporal",
                "flat",
                "knowledge-update",
                "abstention",
                "assistant",
            },
        )

    def test_a_census_that_does_not_add_up_is_refused(self) -> None:
        table = dict(_census())
        table["questionCount"] = 501
        path = ROOT / "tools" / "__tests__" / "census-mutation.json"
        path.write_text(json.dumps(table), encoding="utf-8")
        try:
            result = _run("--census", str(path))
        finally:
            path.unlink()
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not add up", result.stderr)


class TestTheRowsPriceTheWayTheArgumentSays(unittest.TestCase):
    def _rows(self) -> dict[str, dict]:
        table = _census()
        path = CENSUS
        result = _run("--census", str(path))
        self.assertIn("failures", result.stdout)
        self.assertEqual(result.returncode, 1, "a queue with a refused row exits non-zero")
        # Read the verdicts from the tool's own output rather than recomputing them here: a second
        # implementation of the floor is the defect this whole file is about.
        rows = {}
        for line in result.stdout.splitlines():
            for target in table["targets"]:
                if line.startswith(target["name"][:44].ljust(44)):
                    rows[target["name"]] = line.split()[-1]
        self.assertEqual(len(rows), len(table["targets"]), "every target printed one row")
        return rows

    def test_the_delivery_row_is_not_empty_on_the_three_short_routes(self) -> None:
        """A class the campaign called empty and left undesigned, which held three questions.

        This assertion was the other way round -- `assertEqual(..., "empty")` -- and it was green for as long
        as `failure-classes.mjs` decided the absent/misselected split on `goldOverlap.goldTurns`, which
        `question-record.ts` writes as *"the text of every gold turn, delivered or not"*. Three questions
        whose gold the window dropped were therefore filed as `text-misselected`, a **decision** fault, and
        the **delivery** institution they belong to read as empty -- on a row the roadmap kept at "~10 CNY,
        not designed" for two more rounds precisely because it was empty.

        A test can only be as right as the instrument under it. This one was green, passing and wrong, which
        is the same shape as the `declined` fixture that fed a token into a field the parser maps to `null`.
        """
        rows = self._rows()
        # Three members on 349 questions is 0.86 points against a floor of 1.72: still refused, but for the
        # **floor** and not for having nothing to reach.
        self.assertEqual(rows["delivery on TR/IE/KU"], "refused")
        self.assertEqual(_census()["classes"]["number-absent"]["routes"], {"multi-session": 3})
        self.assertEqual(_census()["classes"]["text-absent"]["routes"], {"temporal": 2, "assistant": 1})

    def test_the_delivery_institution_reaches_the_floor_rather_than_sitting_under_it(self) -> None:
        """Six members on the suite, which is exactly the rejection region and not one question more.

        `certifiable` here means `ceiling >= floor`, i.e. six conversions are available -- and six is the
        smallest number that can reach `p = 0.03125`. It is certified only at a conversion rate of 96.3%
        (`P(Bin(6, q) >= 6) >= 0.8`), which is the number `docs/MEASURE-TWO-WITNESSES.md` §3 puts beside this
        row, and it is why the row is *visible* rather than *promising*.
        """
        rows = self._rows()
        self.assertEqual(rows["delivery, suite"], "certifiable")
        self.assertEqual(rows["delivery, multi-session"], "refused")
        line = next(
            row
            for row in _run("--census", str(CENSUS)).stdout.splitlines()
            if row.startswith("delivery, suite".ljust(44))
        )
        parts = line.split()
        # ceiling and floor are the same number: the row is at the line and not above it.
        self.assertEqual(float(parts[-4]), float(parts[-2]))

    def test_the_numeric_institution_is_the_one_row_with_room(self) -> None:
        rows = self._rows()
        self.assertEqual(rows["numeric institution, bundled (suite)"], "certifiable")
        self.assertEqual(rows["numeric institution, bundled (MR)"], "certifiable")

    def test_the_preference_route_is_at_the_line_rather_than_above_it(self) -> None:
        # Asserted as the inequality rather than as the verdict, because the verdict is not stable and the
        # inequality is. On `45543010618` the class held six questions, the ceiling was 6.38 against a floor
        # of 6.38, and the row printed `certifiable` -- true, and true only at a hundred per cent conversion.
        # On `45760081761`, the census this file now reads, the same arm holds five and the row prints
        # `refused`. A target whose verdict changes between two runs of one arm is not a target, so what is
        # pinned here is the property both runs share: the ceiling does not exceed the floor.
        result = _run("--census", str(CENSUS))
        line = next(
            row for row in result.stdout.splitlines() if row.startswith("preference (flat)".ljust(44))
        )
        parts = line.split()
        ceiling, floor = float(parts[-4]), float(parts[-2])
        self.assertLessEqual(
            ceiling,
            floor,
            "the preference row must not have room above its floor on either archived run",
        )
        self.assertIn(parts[-1], {"certifiable", "refused"})


class TestTheDeclineClassIsReadFromTheReply(unittest.TestCase):
    """The class that could not fire.

    `declined` was `answer.includes('INSUFFICIENT_EVIDENCE')`, and `parseAnswer` maps a reply that decides
    to abstain onto `null` -- an abstention is the absence of an answer -- so the field it searched was
    `null` on every decline the product has ever produced and `empty` absorbed the whole population. Two
    questions of the published artifact were filed as "the reader produced nothing" while their replies
    are 533 and 607 characters ending in the token.

    Asserted at the tool boundary rather than on `classify`, because the bug was a disagreement between the
    parser and the census and neither unit test alone can see it.
    """

    def _classes(self, records):
        report = {"questions": records}
        path = ROOT / "tools" / "__tests__" / "census-decline.json"
        path.write_text(json.dumps(report), encoding="utf-8")
        try:
            result = subprocess.run(
                ["node", str(ROOT / "tools" / "failure-classes.mjs"), "--json", str(path)],
                capture_output=True,
                text=True,
                check=False,
            )
        finally:
            path.unlink()
        self.assertEqual(result.returncode, 0, result.stderr)
        return {name: row["count"] for name, row in json.loads(result.stdout)["classes"].items()}

    @staticmethod
    def _record(**overrides):
        base = {
            "questionId": "q",
            "route": "flat",
            "correct": False,
            "answer": None,
            "rawOutput": "",
            "groundTruth": "Yes",
            "goldOverlap": {"carried": 1, "total": 2, "goldTurns": ["Yes."]},
        }
        base.update(overrides)
        return base

    def test_a_prose_reply_ending_in_the_token_is_a_decline_not_an_empty(self) -> None:
        classes = self._classes(
            [
                self._record(
                    questionId="prose",
                    rawOutput="I cannot determine this from the evidence.\n\nINSUFFICIENT_EVIDENCE",
                )
            ]
        )
        self.assertEqual(classes, {"declined": 1})

    def test_a_labelled_token_is_a_decline_too(self) -> None:
        # The `37f165cf` shape: a Step 1 list, a sentence, then `Answer: INSUFFICIENT_EVIDENCE`.
        classes = self._classes(
            [
                self._record(
                    questionId="labelled",
                    rawOutput="Step 1 -- Candidate items:\n- one novel\n\nAnswer: INSUFFICIENT_EVIDENCE",
                )
            ]
        )
        self.assertEqual(classes, {"declined": 1})

    def test_a_blank_reply_is_the_only_empty(self) -> None:
        classes = self._classes([self._record(questionId="blank", answer="")])
        self.assertEqual(classes, {"empty": 1})

    def test_the_two_populations_are_counted_separately(self) -> None:
        classes = self._classes(
            [
                self._record(questionId="decline", rawOutput="INSUFFICIENT_EVIDENCE"),
                self._record(questionId="blank", answer=""),
                self._record(questionId="pref", answer="x", groundTruth="The user would prefer y."),
            ]
        )
        self.assertEqual(classes, {"declined": 1, "empty": 1, "preference": 1})

    def test_a_token_inside_prose_is_a_mention_and_stays_a_content_failure(self) -> None:
        classes = self._classes(
            [
                self._record(
                    questionId="mention",
                    answer="27",
                    rawOutput="INSUFFICIENT_EVIDENCE was the wrong call: the deposit was 38 dollars.",
                    groundTruth="The deposit was 38 dollars.",
                )
            ]
        )
        self.assertNotIn("declined", classes)

    def test_the_frozen_census_records_the_two_declines_and_no_empty_reply(self) -> None:
        table = _census()
        classes = table["classes"]
        self.assertEqual(classes["declined"]["count"], 2)
        self.assertNotIn(
            "empty",
            classes,
            "the arm produced no blank reply: both rows the previous census called `empty` end in the token",
        )
        for name in classes:
            self.assertIn(name, table["taxonomy"], f"class {name} is outside the taxonomy")


class TestTheOperandQuestionIsAskedOfTheGoldThatWasShown(unittest.TestCase):
    """The split this tool exists to draw, drawn on the wrong text.

    `number-misselected` is documented as *"the gold's number **is** in the delivered turns and the reply
    used another"* -- the one class that separates *"the reader never saw it"* from *"the reader saw it and
    answered something else"*. The code searched `goldOverlap.goldTurns`, and `question-record.ts:1160`
    writes that field as *"the text of every gold turn, delivered or not"*, because the restore
    counterfactual needs the turns the budget cut. So a question whose gold the window dropped was filed as
    a **decision** fault, and the class was priced against a decision mechanism that cannot reach it.

    `goldDelivered` -- one boolean per gold turn, `retrieved.includes(gold)` -- has been in the artifact
    since the field was added. This tool never read it.

    Asserted at the tool boundary, because the defect is a disagreement between what the record means and
    what the classifier assumed it meant, and neither side alone shows it.
    """

    DROPPED = {
        "carried": 18,
        "total": 24,
        "goldTurns": ["The deposit was $720 in total.", "I moved in on 2023/04/02."],
        "goldDelivered": [False, True],
    }

    @staticmethod
    def _run(records):
        report = {"questions": records}
        path = ROOT / "tools" / "__tests__" / "census-delivery.json"
        path.write_text(json.dumps(report), encoding="utf-8")
        try:
            return subprocess.run(
                ["node", str(ROOT / "tools" / "failure-classes.mjs"), "--json", str(path)],
                capture_output=True,
                text=True,
                check=False,
            )
        finally:
            path.unlink()

    @staticmethod
    def _record(**overrides):
        base = {
            "questionId": "q",
            "route": "knowledge-update",
            "correct": False,
            "answer": "$220",
            "rawOutput": "The deposit was $220.",
            "groundTruth": "$720",
            "goldOverlap": dict(TestTheOperandQuestionIsAskedOfTheGoldThatWasShown.DROPPED),
        }
        base.update(overrides)
        return base

    def _classes(self, records):
        result = self._run(records)
        self.assertEqual(result.returncode, 0, result.stderr)
        return {name: row["count"] for name, row in json.loads(result.stdout)["classes"].items()}

    def test_an_operand_in_a_dropped_gold_turn_is_a_delivery_fault(self) -> None:
        # The sentence with `$720` is in the record and the window did not carry it, so the reader was never
        # shown the number it failed to use. Same bytes, opposite institution.
        self.assertEqual(self._classes([self._record()]), {"number-absent": 1})

    def test_the_same_record_with_the_turn_carried_is_a_decision_fault(self) -> None:
        overlap = dict(self.DROPPED, goldDelivered=[True, True])
        classes = self._classes([self._record(goldOverlap=overlap)])
        self.assertEqual(classes, {"number-misselected": 1})

    def test_the_text_half_reads_the_same_map(self) -> None:
        # `text-misselected` is the other class a decision mechanism is priced against, and it was drawn on
        # the same unfiltered text.
        classes = self._classes(
            [
                self._record(
                    questionId="text",
                    route="temporal",
                    answer="a violinist",
                    groundTruth="a sound engineer",
                    goldOverlap={
                        "carried": 3,
                        "total": 9,
                        "goldTurns": ["I work as a sound engineer.", "The studio is in Leeds."],
                        "goldDelivered": [False, True],
                    },
                )
            ]
        )
        self.assertEqual(classes, {"text-absent": 1})

    def test_a_record_that_cannot_say_which_gold_was_shown_is_refused(self) -> None:
        # The operand is in the gold, the budget dropped part of it, and nothing says which part.
        # `misselected` would be a claim about a prompt the record never described.
        overlap = {key: value for key, value in self.DROPPED.items() if key != "goldDelivered"}
        result = self._run([self._record(goldOverlap=overlap)])
        self.assertEqual(result.returncode, 1)
        self.assertIn("cannot say whether the reader was shown it", result.stderr)

    def test_a_full_delivery_needs_no_map(self) -> None:
        # `carried == total` is the one state where the per-gold map is redundant, so an artifact predating
        # the field is still readable there rather than refused wholesale.
        classes = self._classes(
            [
                self._record(
                    goldOverlap={"carried": 2, "total": 2, "goldTurns": ["The deposit was $720."]}
                )
            ]
        )
        self.assertEqual(classes, {"number-misselected": 1})

    def test_a_miss_needs_no_map_either(self) -> None:
        # An operand that appears in no gold turn cannot have been shown, whatever the budget did, so the
        # refusal is narrower than "this record has no `goldDelivered`".
        classes = self._classes(
            [
                self._record(
                    answer="27",
                    groundTruth="The deposit was 38 dollars.",
                    goldOverlap={"carried": 9, "total": 24, "goldTurns": ["I set the thermostat."]},
                )
            ]
        )
        self.assertEqual(classes, {"number-absent": 1})

    def test_a_map_that_disagrees_with_the_turns_is_refused(self) -> None:
        # Both fields are written by one function and read as a pair; a length that disagrees means one of
        # them was rebuilt by hand, and the delivery question would then be answered about the wrong turns.
        result = self._run(
            [self._record(goldOverlap=dict(self.DROPPED, goldDelivered=[True, False, True]))]
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("read as a pair", result.stderr)


class TestAnUnknownClassNameIsRefused(unittest.TestCase):
    def test_a_name_outside_the_taxonomy_is_not_read_as_zero(self) -> None:
        # The failure mode this guards: `text-absent` has no members on this arm, so a tool that read
        # an absent class as zero and an unknown class as zero would price a typo as a measurement.
        table = _census()
        table["targets"] = [
            {"id": "typo", "name": "a class that does not exist", "classes": ["text-abscent"], "population": "suite"}
        ]
        path = ROOT / "tools" / "__tests__" / "census-typo.json"
        path.write_text(json.dumps(table), encoding="utf-8")
        try:
            result = _run("--census", str(path))
        finally:
            path.unlink()
        self.assertEqual(result.returncode, 1)
        self.assertIn("names unknown class text-abscent", result.stderr)


if __name__ == "__main__":
    unittest.main()


class TestTheUnpairedFloorIsTwoProportion(unittest.TestCase):
    """The floor the queue was ordered by, recomputed from its own definition.

    ## The defect

    `unpairedFloor` was named "the unpaired two-proportion minimum detectable effect" and computed
    `2.8016 * sqrt(p(1-p)/n)` -- the one-sample form, the standard error of *one* proportion. Two
    independent arms at the same denominator have two variances, so the figure was low by `sqrt(2)`:
    7.87 points at `MR` where the answer is 11.13. `MEASURE-TWO-WITNESSES.md` §5 found it and left it
    standing because no *verdict* read it, and `AUDIT-QUEUE-FLOOR.md` quotes the number in the table
    that orders the queue.

    ## Why these tests and not the self-test's pin

    The self-test pinned `7.87` for four months, so the test agreed with the bug -- the strongest
    form of a validation that cannot fail. The assertion here is about the *derivation*: the printed
    floor must equal `sqrt(2)` times an independently written one-sample expression, which is false
    for the buggy version and true for the corrected one, and it names the defect in its message.
    """

    def _floor(self, accuracy: float, n: int) -> float:
        script = (
            "import('./tools/queue-floor.mjs').then((m) => "
            f"console.log(m.unpairedFloor({accuracy}, {n})))"
        )
        result = subprocess.run(
            ["node", "-e", script], cwd=str(ROOT), capture_output=True, text=True, check=False
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return float(result.stdout.strip())

    def test_the_floor_at_mr_reads_eleven_point_one_three_points(self) -> None:
        self.assertAlmostEqual(self._floor(0.893, 121), 11.13, places=2)

    def test_the_floor_at_mr_covers_thirteen_and_a_half_questions(self) -> None:
        # Points to questions is the conversion every queue table does, and it is where the
        # correction changes a decision: 9.5 questions said a five-question mechanism could be seen,
        # 13.5 says it cannot.
        self.assertAlmostEqual(self._floor(0.893, 121) / 100 * 121, 13.47, places=2)

    def test_the_floor_is_sqrt_two_times_the_one_sample_form(self) -> None:
        one_sample = 100 * 2.8016 * ((0.893 * 0.107 / 121) ** 0.5)
        self.assertAlmostEqual(self._floor(0.893, 121), (2**0.5) * one_sample, places=9)

    def test_a_one_sample_implementation_would_not_pass_that_identity(self) -> None:
        # The negative control. Without it the identity above could be satisfied by a function that
        # returned the one-sample figure twice; this asserts the two differ by enough to be caught.
        one_sample = 100 * 2.8016 * ((0.893 * 0.107 / 121) ** 0.5)
        self.assertGreater(abs(self._floor(0.893, 121) - one_sample), 1.0)
