"""Tests for `tools/evidence-depth.py`, the arithmetic behind the per-route evidence room.

The tool exists because a character budget is not a depth. It reads two fields an artifact already
carries -- `goldOverlap.goldRanks` (where each gold turn sits in the run's own relevance order) and
`windowComposition` (how many turns were delivered and what they cost) -- and reports the coverage a
depth buys, the room a coverage target needs, and the accuracy split that decides **which** route is
worth deepening.

Every number in the fixtures below is checkable by hand, and the tests are written that way on
purpose: the tool's job is to make a decision arithmetic, so a test that could not be recomputed with
a pencil would not be testing the thing that matters.
"""

from __future__ import annotations

import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from importlib import import_module

depth_tool = import_module("evidence-depth")


def record(
    *,
    capability: str = 'IE',
    gold_ranks: list[int] | None = None,
    turns: int = 10,
    offered_chars: int = 5_000,
    correct: bool = True,
) -> dict:
    return {
        'capability': capability,
        'correct': correct,
        'goldOverlap': {'goldRanks': gold_ranks if gold_ranks is not None else [0, 1]},
        'windowComposition': {'turns': turns, 'offeredChars': offered_chars},
    }


class TestWhatItReads:
    def test_the_route_comes_from_the_capability_rather_than_from_the_operator(self):
        # The mapping is the arm's own dispatch, so an operator cannot supply the answer the tool is
        # meant to derive. An unknown capability is passed through rather than guessed at.
        assert depth_tool.route_of({'capability': 'MR'}) == 'multi-session'
        assert depth_tool.route_of({'capability': 'IE'}) == 'flat'
        assert depth_tool.route_of({'capability': 'KU'}) == 'knowledge-update'
        assert depth_tool.route_of({'capability': 'XX'}) == 'XX'

    def test_a_gold_turn_outside_the_pool_is_not_in_the_denominator(self):
        # `-1` means "not retrieved at all", which is a different fact from "retrieved late": counting
        # it as a miss at every depth would make the curve a function of the pool rather than of the
        # depth, and no room would ever reach 100%.
        assert depth_tool.in_pool_ranks({'goldOverlap': {'goldRanks': [3, -1, 7]}}) == [3, 7]
        assert depth_tool.in_pool_ranks({'goldOverlap': {}}) == []

    def test_coverage_counts_gold_inside_the_depth(self):
        # Three in-pool gold at ranks 0, 5 and 9; a depth of 10 carries all three and a depth of 5
        # carries one. The mean is over questions, so two questions are 75% and 25% respectively.
        assert depth_tool.coverage_at([record(gold_ranks=[0, 5, 9])], 10) == pytest.approx(100.0)
        assert depth_tool.coverage_at([record(gold_ranks=[0, 5, 9])], 5) == pytest.approx(100 / 3)

    def test_coverage_ignores_a_question_with_no_in_pool_gold(self):
        # Excluded from the denominator rather than counted as a zero-score question: the run cannot
        # deliver what it never retrieved, and averaging that in would make a deeper room look better
        # on the questions the pool already failed.
        assert depth_tool.coverage_at([record(gold_ranks=[0])], 10) == pytest.approx(100.0)
        assert depth_tool.coverage_at([record(gold_ranks=[0]), record(gold_ranks=[-1])], 10) == (
            pytest.approx(100.0)
        )

    def test_the_density_is_delivered_characters_not_the_whole_prompt(self):
        # `promptChars` also carries the question and the instruction block, so a density computed
        # from it would overstate every route by the same constant and make two routes' rooms
        # incomparable in exactly the direction the tool exists to measure.
        assert depth_tool.chars_per_turn(record(turns=10, offered_chars=5_000)) == pytest.approx(500)
        assert depth_tool.chars_per_turn(record(turns=0, offered_chars=5_000)) is None

    def test_a_question_is_fully_covered_only_when_every_in_pool_gold_is_inside_the_depth(self):
        assert depth_tool._covered(record(gold_ranks=[0, 9], turns=10))
        assert not depth_tool._covered(record(gold_ranks=[0, 10], turns=10))
        assert not depth_tool._covered(record(gold_ranks=[-1], turns=10))


class TestTheAccuracySplit:
    def test_it_separates_full_from_partial_coverage(self):
        records = [
            record(gold_ranks=[0], turns=10, correct=True),
            record(gold_ranks=[0], turns=10, correct=False),
            record(gold_ranks=[50], turns=10, correct=True),
            record(gold_ranks=[50], turns=10, correct=True),
        ]
        n_full, n_part, acc_full, acc_part = depth_tool.accuracy_split(records)
        assert (n_full, n_part) == (2, 2)
        assert acc_full == pytest.approx(50.0)
        assert acc_part == pytest.approx(100.0)

    def test_an_empty_group_reports_nan_rather_than_zero(self):
        # `0.0%` would read as "answered none correctly"; `nan` reads as "nothing to answer". The
        # difference decides whether a route looks like a failure or like an unmeasured one.
        _, _, acc_full, acc_part = depth_tool.accuracy_split([record(gold_ranks=[50], turns=10)])
        assert acc_full != acc_full  # nan
        assert acc_part == pytest.approx(100.0)


class TestTheDerivedRoom:
    def test_the_room_is_the_depth_that_reaches_the_target_times_the_density(self):
        # Gold at rank 30 of a 1,000-character-per-turn route: 100% coverage needs depth 31, which is
        # 31,000 characters, rounded up to the next hundred so the room cannot land one turn short.
        records = [record(gold_ranks=[30], turns=10, offered_chars=10_000)]
        assert depth_tool.room_for(records, 100.0) == 31_000

    def test_a_lower_target_needs_a_shallower_depth(self):
        # Two questions, gold at rank 9 and rank 29. Depth 10 covers one of the two -- 50% of the
        # mean -- and depth 30 covers both. So a 50% target derives 10 turns and a 100% target 30.
        records = [
            record(gold_ranks=[9], turns=10, offered_chars=10_000),
            record(gold_ranks=[29], turns=10, offered_chars=10_000),
        ]
        assert depth_tool.room_for(records, 50.0) == 10_000
        assert depth_tool.room_for(records, 100.0) == 30_000

    def test_a_route_with_no_delivered_characters_has_no_room(self):
        assert depth_tool.room_for([record(turns=0, offered_chars=0)], 100.0) is None
        assert depth_tool.room_for([record(gold_ranks=[-1])], 100.0) is None

    def test_the_measured_artifact_reproduces_its_own_registered_depth(self):
        # The claim the tool makes about `41546569106`: `multi-session` delivered 94.8% of in-pool
        # gold at a depth of 174, and its 100% room is 260 turns x 215 characters = 55,900. Pinned as
        # arithmetic because the dispatch that follows from it is sized by this number.
        records = [
            record(capability='MR', gold_ranks=[0, 100, 259], turns=174, offered_chars=37_410)
        ]
        assert depth_tool.coverage_at(records, 174) == pytest.approx(200 / 3)
        assert depth_tool.room_for(records, 100.0) == 55_900


class TestTheReport:
    def test_it_prints_a_row_per_route_and_the_curve(self):
        artifact = {
            'questions': [
                record(capability='MR', gold_ranks=[0, 5], turns=10, correct=True),
                record(capability='MR', gold_ranks=[0, 50], turns=10, correct=False),
                record(capability='IE', gold_ranks=[0], turns=4, correct=True),
            ]
        }
        printed = '\n'.join(depth_tool.report(artifact, (10, 100), (100.0,)))
        assert 'multi-session' in printed
        assert 'flat' in printed
        assert 'coverage at depth' in printed
        assert 'room needed for' in printed

    def test_an_artifact_with_no_questions_is_refused_rather_than_reported(self):
        with pytest.raises(SystemExit):
            depth_tool.report({'questions': []}, (10,), (100.0,))


class TestTheCommandLine:
    def test_it_prints_a_dispatchable_map(self, tmp_path, capsys):
        artifact = {
            'questions': [
                record(capability='MR', gold_ranks=[9], turns=10, offered_chars=2_000),
                record(capability='IE', gold_ranks=[9], turns=10, offered_chars=3_000),
            ]
        }
        path = tmp_path / 'artifact.json'
        path.write_text(__import__('json').dumps(artifact))
        assert depth_tool.main([str(path), '--map', 'multi-session']) == 0
        out = capsys.readouterr().out
        # Gold at rank 9 needs depth 10; 10 turns x 200 characters = 2,000.
        assert 'map at 100% coverage: multi-session:2000' in out

    def test_a_route_the_artifact_does_not_carry_is_refused(self, tmp_path, capsys):
        path = tmp_path / 'artifact.json'
        path.write_text(__import__('json').dumps({'questions': [record(gold_ranks=[0])]}))
        with pytest.raises(SystemExit):
            depth_tool.main([str(path), '--map', 'temporal'])
        capsys.readouterr()
