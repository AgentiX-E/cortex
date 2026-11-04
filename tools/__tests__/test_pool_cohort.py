"""Tests for `tools/pool-cohort.py`, the readout that closes a prediction left "untested".

The prediction is `§13.234`'s second: "the gain concentrates in the 41 questions whose gold sat
outside the pool -- at least 3 of 16 convert". The first regrade (`41741547141`) recorded it as
untestable and gave a reason that was false (`goldRanks` "caps at 255"). These tests pin both halves of
the repair: that `-1` defines the cohort, and that a regrade without rows is refused rather than
silently read as an empty cohort.
"""

from __future__ import annotations

import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from importlib import import_module

cohort = import_module("pool-cohort")


def question(qid: str, correct: bool, ranks: list[int], capability: str = 'MR') -> dict:
    return {
        'questionId': qid,
        'capability': capability,
        'correct': correct,
        'goldOverlap': {'carried': 1, 'total': len(ranks), 'pool': 1, 'goldRanks': ranks},
    }


def regrade(rows: list[tuple[str, bool]], run: int = 0) -> dict:
    return {
        'runs': [
            {
                'run': run,
                'questions': [
                    {'id': qid, 'capability': 'MR', 'correct': correct, 'deliveredTurns': 10}
                    for qid, correct in rows
                ],
            }
        ]
    }


class TestCohortMembership:
    def test_never_surfaced_is_the_membership_test(self):
        # `-1` means the ranking did not offer the turn at all; `254` is a rank inside a 256-wide pool.
        # Conflating them was the defect this tool exists to make impossible.
        artifact = {
            'questions': [
                question('a', True, [0, 5]),
                question('b', False, [0, -1]),
                question('c', False, [254]),
            ]
        }
        rows = cohort.registered_rows(artifact)
        assert [row.outside for row in rows] == [False, True, False]

    def test_a_run_with_no_ranking_is_excluded_rather_than_counted_as_outside(self):
        artifact = {'questions': [{'questionId': 'a', 'capability': 'MR', 'correct': True}]}
        assert cohort.registered_rows(artifact) == []


class TestTheReading:
    def test_it_counts_conversions_inside_the_cohort(self):
        registered = [
            cohort.Row('a', 'MR', False, True),
            cohort.Row('b', 'MR', False, True),
            cohort.Row('c', 'MR', True, False),
        ]
        replayed = [
            cohort.Row('a', 'MR', True, False),
            cohort.Row('b', 'MR', False, False),
            cohort.Row('c', 'MR', True, False),
        ]
        printed = '\n'.join(cohort.read_cohort(registered, replayed, expect=1))
        assert 'cohort (gold outside the pool): 2' in printed
        # One of the two wrong-in-cohort questions converted, which meets a prediction of 1.
        assert 'reading:    1 converted -> MET' in printed

    def test_a_prediction_that_misses_is_reported_as_missing(self):
        registered = [cohort.Row('a', 'MR', False, True), cohort.Row('b', 'MR', False, True)]
        replayed = [cohort.Row('a', 'MR', True, False), cohort.Row('b', 'MR', False, False)]
        printed = '\n'.join(cohort.read_cohort(registered, replayed, expect=2))
        assert 'NOT MET' in printed

    def test_a_question_missing_from_the_replay_is_an_error_not_a_skip(self):
        # A cohort read over a subset is a conversion rate for a population nobody defined.
        registered = [cohort.Row('a', 'MR', True, True), cohort.Row('b', 'MR', True, True)]
        replayed = [cohort.Row('a', 'MR', True, False)]
        with pytest.raises(SystemExit):
            cohort.read_cohort(registered, replayed, expect=1)

    def test_a_regrade_without_rows_is_refused_with_the_reason(self):
        with pytest.raises(SystemExit) as caught:
            cohort.replayed_rows({'runs': [{'run': 0, 'baseline': {}}]}, 0)
        assert 'aggregates' in str(caught.value)

    def test_an_absent_run_is_refused(self):
        with pytest.raises(SystemExit):
            cohort.replayed_rows(regrade([('a', True)], run=0), 1)


class TestTheScope:
    def test_the_prediction_scope_is_one_capability_not_the_whole_set(self):
        # `41546569106` has 161 questions with gold the ranking never surfaced, and 41 of them are
        # multi-session. The registered prediction names 41, so reading it over 161 answers a
        # different question -- with a different verdict.
        registered = [
            cohort.Row('mr1', 'MR', False, True),
            cohort.Row('mr2', 'MR', True, True),
            cohort.Row('ie1', 'IE', False, True),
            cohort.Row('ie2', 'IE', False, True),
            cohort.Row('ie3', 'IE', False, True),
        ]
        replayed = [
            cohort.Row('mr1', 'MR', True, False),
            cohort.Row('mr2', 'MR', True, False),
            cohort.Row('ie1', 'IE', True, False),
            cohort.Row('ie2', 'IE', False, False),
            cohort.Row('ie3', 'IE', False, False),
        ]
        scoped = '\n'.join(cohort.read_cohort(registered, replayed, expect=1, capability='MR'))
        assert 'scope: MR' in scoped
        assert 'cohort (gold outside the pool): 2' in scoped
        assert 'reading:    1 converted -> MET' in scoped

        whole = '\n'.join(cohort.read_cohort(registered, replayed, expect=3))
        assert 'scope: all capabilities' in whole
        assert 'cohort (gold outside the pool): 5' in whole
        # The same data misses a prediction of 3 when read over the whole set and meets it when read
        # over the registered scope -- which is why the scope is a parameter.
        assert 'NOT MET' in whole


class TestThePairedTest:
    def test_no_discordant_pairs_is_p_one(self):
        assert cohort.mcnemar_exact(0, 0) == 1.0

    def test_a_lopsided_split_reaches_significance(self):
        # 12 gained against 1 lost is p = 2 * (C(13,0) + C(13,1)) / 2^13 = 0.0034.
        assert cohort.mcnemar_exact(1, 12) == pytest.approx(0.00342, abs=1e-5)

    def test_it_is_symmetric(self):
        assert cohort.mcnemar_exact(3, 9) == pytest.approx(cohort.mcnemar_exact(9, 3))


class TestTheCommandLine:
    def test_it_reads_a_cohort_from_two_files(self, tmp_path, capsys):
        registered = tmp_path / 'registered.json'
        registered.write_text(
            json.dumps(
                {
                    'questions': [
                        question('a', False, [0, -1]),
                        question('b', True, [0, 5]),
                    ]
                }
            )
        )
        path = tmp_path / 'regrade.json'
        path.write_text(json.dumps(regrade([('a', True), ('b', True)])))
        assert cohort.main(['--registered', str(registered), '--regrade', str(path), '--expect', '1']) == 0
        out = capsys.readouterr().out
        assert 'cohort (gold outside the pool): 1' in out
        assert 'MET' in out
