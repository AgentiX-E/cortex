"""What a room-filling selection could recover, bounded from an artifact and never promised.

The tool's whole job is to keep two numbers apart that a hand calculation merges: **what the fill
could reach** and **what it would earn**. `MEASURE-UNSPENT-ROOM.md` sizes a change that costs no
tokens -- the room is already bought and the prefix rule returns part of it unspent -- and the only
honest way to size it before dispatching is arithmetic over gold ranks and gold lengths.

These tests pin the arithmetic and refuse three ways of getting it right by accident:

  - **an upper bound has to say so.** The walk spends the whole unspent room on gold as if nothing
    else competed for it. On a real fill the turns between two gold segments are bought first. A
    table that printed the bound without the word would be publishing a forecast.
  - **a missing field is not zero.** No `goldRanks` means the reach is unknown, not rank zero; no
    `deliveredPromptChars` means the subtraction has one term; no room means the question was never
    given a budget. Each is refused by name, because defaulting any of them produces exactly the
    number this file exists to stop being produced by hand.
  - **an unranked gold is not rank minus one.** `goldRanks` encodes "not surfaced" as `-1`, and a
    gap computed from it would read as "one turn past the window", which is the opposite of the
    truth. `gap` is `null` there.

And one positive claim, because the difference between it and the bound is the campaign's most
expensive confounder: **`wrongFullyRecovered` is asserted apart from `fullyRecovered`.** On the
published artifact 31 questions could gain all their gold and only **one** of them is wrong -- a
question with an absent gold reads *higher* than one whose gold arrived whole, so "more gold
delivered" cannot be read as "more answers right" and the two columns have to stay separate.
"""

import json
import pathlib
import subprocess

import pytest

TOOL = pathlib.Path(__file__).resolve().parents[1] / "turn-fill-ceiling.mjs"


def _run(body: str) -> str:
    script = f"import * as mod from {json.dumps(TOOL.as_uri())};\n{body}"
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout


def _seg(tag: str, length: int) -> str:
    """A gold segment of a length, because the arithmetic is about characters and not about tags."""
    assert length >= len(tag)
    return tag + "x" * (length - len(tag))


def _question(question_id, route, *, correct, gold, delivered, ranks, delivered_chars, held=10):
    return {
        "questionId": question_id,
        "route": route,
        "capability": "MR",
        "correct": correct,
        "deliveredPromptChars": delivered_chars,
        "turns": [{"text": "t"} for _ in range(held)],
        "goldOverlap": {"goldTurns": gold, "goldDelivered": delivered, "goldRanks": ranks},
    }


def _report(questions, rooms=None):
    return {
        "memoryArmConfig": {"maxPromptCharsByRoute": rooms or {"flat": 10_000, "temporal": 10_000}},
        "questions": questions,
    }


def _census(report) -> dict:
    body = (
        f"const report = {json.dumps(report)};\n"
        "process.stdout.write(JSON.stringify(mod.census(report)));"
    )
    return json.loads(_run(body))


class TestTheArithmetic:
    def test_a_segment_fits_when_it_fits_and_not_when_it_does_not(self):
        # Slack 5,000: a 1,000-character segment and a 4,000-character one both fit, together.
        report = _report(
            [
                _question(
                    "a",
                    "flat",
                    correct=False,
                    gold=[_seg("g0", 120), _seg("g1", 1_000), _seg("g2", 4_000)],
                    delivered=[True, False, False],
                    ranks=[0, 11, 12],
                    delivered_chars=5_000,
                ),
                # Slack 500 and a 900-character segment: nothing fits, which is the population that no
                # amount of careful filling moves.
                _question(
                    "b",
                    "flat",
                    correct=False,
                    gold=[_seg("h0", 900)],
                    delivered=[False],
                    ranks=[40],
                    delivered_chars=9_500,
                ),
            ]
        )
        result = _census(report)

        by_id = {row["questionId"]: row for row in result["rows"]}
        assert by_id["a"]["recoverable"] == 2
        assert by_id["a"]["recoverableChars"] == 5_000
        assert by_id["b"]["recoverable"] == 0

    def test_the_rank_order_decides_which_segments_are_affordable(self):
        # Same two segments, same slack, opposite ranks: the cheap one is bought first either way, but
        # the expensive one only fits if it comes first. A walk over `goldTurns` order rather than rank
        # order would answer the same for both and be wrong for one.
        cheap_first = _report(
            [
                _question(
                    "x",
                    "flat",
                    correct=True,
                    gold=[_seg("c", 600), _seg("d", 4_800)],
                    delivered=[False, False],
                    ranks=[5, 9],
                    delivered_chars=5_000,
                )
            ]
        )
        expensive_first = _report(
            [
                _question(
                    "y",
                    "flat",
                    correct=True,
                    gold=[_seg("c", 600), _seg("d", 4_800)],
                    delivered=[False, False],
                    ranks=[9, 5],
                    delivered_chars=5_000,
                )
            ]
        )

        # 600 first leaves 4,400 and the 4,800 segment does not fit; 4,800 first leaves 200 and the
        # 600 segment does not fit either. The walk is not "buy everything that fits eventually", it is
        # one pass in rank order, and the difference between the two answers is 600 against 4,800.
        assert _census(cheap_first)["rows"][0]["recoverableChars"] == 600
        assert _census(expensive_first)["rows"][0]["recoverableChars"] == 4_800

    def test_the_gap_is_measured_against_the_turns_the_window_held(self):
        report = _report(
            [
                _question(
                    "a",
                    "flat",
                    correct=False,
                    gold=[_seg("g", 100)],
                    delivered=[False],
                    ranks=[17],
                    delivered_chars=9_000,
                    held=14,
                )
            ]
        )
        row = _census(report)["rows"][0]

        # Rank 17 with 14 turns held: three ranks past the end of the window, so one more turn of room
        # would not have reached it. The number is what buying room has to close.
        assert row["gap"] == 3
        assert row["held"] == 14

    def test_an_unranked_gold_has_no_gap_rather_than_rank_minus_one(self):
        report = _report(
            [
                _question(
                    "a",
                    "flat",
                    correct=False,
                    gold=[_seg("g", 100)],
                    delivered=[False],
                    ranks=[-1],
                    delivered_chars=9_000,
                )
            ]
        )
        row = _census(report)["rows"][0]

        # `-1` is "the ranking never surfaced it", which is unbounded by the room and would read as
        # "one turn early" if it were used as a rank.
        assert row["gap"] is None

    def test_a_question_that_is_already_whole_is_not_in_the_population(self):
        report = _report(
            [
                _question(
                    "whole",
                    "flat",
                    correct=True,
                    gold=[_seg("g", 100)],
                    delivered=[True],
                    ranks=[0],
                    delivered_chars=9_000,
                )
            ]
        )
        result = _census(report)

        # A row for it would inflate every denominator with a question the mechanism cannot move.
        assert result["rows"] == []
        assert result["all"]["questions"] == 0

class TestTheTwoColumnsThatMustNotBeMerged:
    def test_gaining_gold_and_being_wrong_are_counted_apart(self):
        report = _report(
            [
                _question(
                    "wrong",
                    "flat",
                    correct=False,
                    gold=[_seg("a", 400)],
                    delivered=[False],
                    ranks=[3],
                    delivered_chars=9_500,
                ),
                _question(
                    "right",
                    "flat",
                    correct=True,
                    gold=[_seg("b", 400)],
                    delivered=[False],
                    ranks=[3],
                    delivered_chars=9_500,
                ),
            ]
        )
        result = _census(report)

        # Both gain all their gold; only one of them can move an accuracy number.
        assert result["all"]["fullyRecovered"] == 2
        assert result["all"]["wrongFullyRecovered"] == 1
        assert result["all"]["questionsGainingGold"] == 2
        assert result["all"]["wrongGainingGold"] == 1


class TestTheFourRefusals:
    def _refused(self, report) -> str:
        body = (
            f"const report = {json.dumps(report)};\n"
            "try { mod.census(report); process.exit(3); }"
            " catch (error) { process.stdout.write(String(error.message)); }"
        )
        return _run(body)

    def test_no_room_map(self):
        report = _report(
            [
                _question(
                    "a",
                    "flat",
                    correct=False,
                    gold=[_seg("g", 10)],
                    delivered=[False],
                    ranks=[1],
                    delivered_chars=1,
                )
            ]
        )
        del report["memoryArmConfig"]["maxPromptCharsByRoute"]
        assert "effectivePromptChars" in self._refused(report)

    def test_a_route_with_no_room(self):
        report = _report(
            [
                _question(
                    "a",
                    "nowhere",
                    correct=False,
                    gold=[_seg("g", 10)],
                    delivered=[False],
                    ranks=[1],
                    delivered_chars=1,
                )
            ]
        )
        message = self._refused(report)
        assert "nowhere" in message and "flat" in message

    def test_no_delivered_prompt_characters(self):
        report = _report(
            [
                _question(
                    "a",
                    "flat",
                    correct=False,
                    gold=[_seg("g", 10)],
                    delivered=[False],
                    ranks=[1],
                    delivered_chars=1,
                )
            ]
        )
        del report["questions"][0]["deliveredPromptChars"]
        assert "deliveredPromptChars" in self._refused(report)

    def test_no_ranks(self):
        report = _report(
            [
                _question(
                    "a",
                    "flat",
                    correct=False,
                    gold=[_seg("g", 10)],
                    delivered=[False],
                    ranks=[1],
                    delivered_chars=1,
                )
            ]
        )
        del report["questions"][0]["goldOverlap"]["goldRanks"]
        message = self._refused(report)
        assert "goldRanks" in message and "not rank zero" in message


class TestTheOutputSaysWhatKindOfNumberItIs:
    def _table(self) -> str:
        report = _report(
            [
                _question(
                    "a",
                    "flat",
                    correct=False,
                    gold=[_seg("g", 400)],
                    delivered=[False],
                    ranks=[3],
                    delivered_chars=9_500,
                )
            ]
        )
        body = (
            f"const report = {json.dumps(report)};\n"
            "process.stdout.write(mod.table(mod.census(report)));"
        )
        return _run(body)

    def test_the_bound_is_named_as_a_bound(self):
        text = self._table()
        assert "upper bound" in text.lower()

    def test_the_gap_definition_is_printed(self):
        # The one column a reader will misread: zero means the gold was the very next turn, and a
        # positive number is what buying room has to close.
        text = self._table()
        assert "the best missing gold's rank minus the turns the window held" in text

    def test_the_population_is_not_a_denominator(self):
        text = self._table()
        assert "neither is a rate" in text


class TestTheSelfTest:
    def test_passes(self):
        result = subprocess.run(
            ["node", str(TOOL), "--self-test"], capture_output=True, text=True, timeout=120
        )
        assert result.returncode == 0, result.stderr
        assert "all passed" in result.stdout


class TestTheToolCannotQuietlyDefaultAnything:
    def test_no_field_is_substituted_with_zero(self):
        # A source gate rather than a behavioural one: the defect this file exists to prevent is a
        # missing field being read as zero, and a default is how that happens. `?? 0` and `|| 0` are
        # refused, so the only way to handle an absence is to throw.
        source = TOOL.read_text(encoding="utf-8")
        body = source.split("function selfTest()")[0]
        assert "?? 0" not in body
        assert "|| 0" not in body

    def test_every_refusal_names_a_field(self):
        source = TOOL.read_text(encoding="utf-8")
        refusals = source.split("throw new Refusal(")[1:]
        assert len(refusals) >= 4
        for block in refusals:
            message = block[:400]
            assert any(
                field in message
                for field in (
                    "effectivePromptChars",
                    "maxPromptCharsByRoute",
                    "deliveredPromptChars",
                    "goldRanks",
                    "goldDelivered",
                    "${field}",
                    "room",
                )
            ), message
