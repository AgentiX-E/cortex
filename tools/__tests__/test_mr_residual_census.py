#!/usr/bin/env python3
"""The residual census has to survive the shapes the reader actually writes.

## The defect this file is written against

§13.262.8 named three failures as if they were a taxonomy — a sum, a distinct count, and a case where
every candidate was excluded — and retired a deterministic tally on that basis. A prose taxonomy
built from three records is not a distribution, and the next axis depends on which class dominates.

The measurement only works if the parser reads both shapes of rejection. `6d550036` lists six
candidate projects and marks all six excluded, so a parser that only recognised the block form
(`Excluded candidates:` then bullets) would count six kept items against an answer of `0` and report
an **aggregation** error where the reader had made a **selection** decision. That misclassification is
the reason each shape below has its own case: the tool's own answer would otherwise depend on which
shape a model happened to produce.

## Why the negative cases carry the weight

A census that counts everything as `selection` would look right on the artifact this was built for and
be wrong on the next one. Each fixture here is a response shape taken from the artifacts, with the
class it must produce written beside it.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'mr-residual-census.py'


def _record(
    identifier: str,
    *,
    gold: str,
    answer: str,
    raw: str,
    correct: bool = False,
    capability: str = 'MR',
) -> dict:
    return {
        'questionId': identifier,
        'capability': capability,
        'groundTruth': gold,
        'answer': answer,
        'rawOutput': raw,
        'correct': correct,
    }


def _report(records: list[dict]) -> dict:
    return {'questions': records}


def _census(records: list[dict], *extra: str) -> dict:
    directory = Path(tempfile.mkdtemp(prefix='residual-'))
    path = directory / 'report.json'
    path.write_text(json.dumps(_report(records)))
    completed = subprocess.run(
        [sys.executable, str(TOOL), str(path), '--json', *extra],
        capture_output=True,
        text=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    return json.loads(completed.stdout)


class ClassTest(unittest.TestCase):
    def test_an_answer_equal_to_its_own_list_is_selection_and_the_sign_is_reported(self) -> None:
        summary = _census(
            [
                _record('short', gold='3', answer='2', raw='Step 1:\n- boots | return\n- boots | pickup\n'),
                _record(
                    'long',
                    gold='4',
                    answer='5',
                    raw='Step 1:\n- a\n- b\n- c\n- d\n- e\n',
                ),
            ]
        )
        self.assertEqual(summary['wrongByClass'], {'selection': 2})
        self.assertEqual(summary['wrongBySubclass'], {'under': 1, 'over': 1})

    def test_an_answer_that_is_not_its_list_length_is_aggregation(self) -> None:
        """`10 + 5 + 1 + 1 = 17` against a list of four items is the shape §13.262.8 described."""
        summary = _census(
            [
                _record(
                    'summed',
                    gold='17',
                    answer='4',
                    raw='Step 1:\n- 10 neon tetras\n- 5 gouramis\n- 1 pleco\n- 1 betta\n',
                )
            ]
        )
        # The gold is outside the count window, so this record is out of the census entirely: a
        # balance and a set of items are not comparable, which is the window's whole purpose.
        self.assertEqual(summary['inWindow'], 0)

    def test_an_operation_over_a_count_shaped_gold_is_aggregation(self) -> None:
        summary = _census([_record('summed', gold='4', answer='7', raw='Step 1:\n- a\n- b\n- c\n')])
        self.assertEqual(summary['wrongByClass'], {'aggregation': 1})

    def test_a_reply_without_a_number_is_contract_and_is_not_a_zero(self) -> None:
        summary = _census(
            [_record('vague', gold='3', answer='I cannot tell from the sessions', raw='Step 1:\n- a\n- b\n')]
        )
        self.assertEqual(summary['wrongByClass'], {'contract': 1})
        self.assertEqual(summary['rows'][0]['answer'], None)

    def test_prose_around_the_number_still_reads_as_the_number(self) -> None:
        summary = _census(
            [_record('prose', gold='3', answer='There are 2 items', raw='Step 1:\n- a\n- b\n')]
        )
        self.assertEqual(summary['rows'][0]['answer'], 2)
        self.assertEqual(summary['wrongBySubclass'], {'under': 1})


class RejectionShapeTest(unittest.TestCase):
    """A rejected candidate is a selection decision, in either shape the reader writes it."""

    def test_a_block_of_excluded_candidates_does_not_count_as_kept(self) -> None:
        raw = (
            'Step 1 — Candidate items considered:\n'
            '- Project A | planning | excluded: action is planning, not led\n'
            '- Project B | working on | excluded: working on is not leading\n'
            'Excluded candidates:\n'
            '- Project C\n'
            '- Project D\n'
        )
        summary = _census([_record('six', gold='2', answer='0', raw=raw)])
        # Inline markers were read on the first two lines and the block on the rest, so nothing is
        # kept and an answer of zero is faithful to the list it kept: selection, not aggregation.
        self.assertEqual(summary['wrongByClass'], {'selection': 1})
        self.assertEqual(summary['rows'][0]['kept'], 0)
        self.assertEqual(summary['rows'][0]['excluded'], 4)

    def test_an_inline_rejection_is_read_without_a_heading(self) -> None:
        """The 6d550036 shape: the reader marks each candidate on its own line, with no block."""
        raw = (
            'Step 1 \u2014 Candidate items considered:\n'
            '- Nigeria water project | planning | \u2014 excluded: planning is not leading\n'
            '- Coffee table | buy | 2023/05/29\n'
        )
        summary = _census([_record('inline', gold='3', answer='1', raw=raw)])
        self.assertEqual(summary['rows'][0]['kept'], 1)
        self.assertEqual(summary['wrongByClass'], {'selection': 1})

    def test_the_census_counts_how_many_wrong_answers_rejected_something(self) -> None:
        summary = _census(
            [
                _record('a', gold='3', answer='2', raw='- x | excluded: not an action\n- y\n'),
                _record('b', gold='2', answer='1', raw='- z\n'),
            ]
        )
        self.assertEqual(summary['wrongWithExclusions'], 1)
        self.assertEqual(summary['wrongExcludedTotal'], 1)


class WindowTest(unittest.TestCase):
    def test_a_gold_outside_the_count_window_is_not_classified(self) -> None:
        summary = _census(
            [
                _record('big', gold='856', answer='12', raw='- a\n'),
                _record('one', gold='1', answer='0', raw='- a\n'),
                _record('ten', gold='10', answer='9', raw='- a\n'),
            ]
        )
        self.assertEqual(summary['inWindow'], 1)
        self.assertEqual(summary['rows'][0]['questionId'], 'ten')

    def test_a_correct_answer_is_counted_but_not_listed_as_a_residual(self) -> None:
        summary = _census(
            [
                _record('right', gold='2', answer='2', raw='- a\n- b\n', correct=True),
                _record('wrong', gold='2', answer='1', raw='- a\n'),
            ]
        )
        self.assertEqual((summary['correct'], summary['wrong']), (1, 1))
        self.assertEqual([row['questionId'] for row in summary['rows']], ['wrong'])
        # The correct answer is `faithful-equal`: its arithmetic was the count, and it agreed.
        self.assertEqual(summary['correctBySubclass'], {'equal': 1})

    def test_another_capability_is_excluded_by_default(self) -> None:
        summary = _census(
            [
                _record('ie', gold='3', answer='2', raw='- a\n', capability='IE'),
                _record('mr', gold='3', answer='2', raw='- a\n'),
            ]
        )
        self.assertEqual(summary['inWindow'], 1)

    def test_the_capability_is_selectable(self) -> None:
        summary = _census(
            [_record('ie', gold='3', answer='2', raw='- a\n', capability='IE')],
            '--capability',
            'IE',
        )
        self.assertEqual(summary['inWindow'], 1)


class ReviewArtifactTest(unittest.TestCase):
    """A run whose review rewrote `rawOutput` cannot be censused, and the tool has to say so."""

    def test_a_record_with_no_step_one_list_is_flagged_rather_than_classified_silently(self) -> None:
        summary = _census([_record('audited', gold='3', answer='2', raw='Step 2 \u2014 2')])
        self.assertEqual(summary['wrongWithoutItems'], 1)

    def test_the_warning_is_printed_when_no_enumeration_reached_the_record(self) -> None:
        directory = Path(tempfile.mkdtemp(prefix='residual-'))
        path = directory / 'report.json'
        path.write_text(
            json.dumps(_report([_record('audited', gold='3', answer='2', raw='Step 2 \u2014 2')]))
        )
        completed = subprocess.run(
            [sys.executable, str(TOOL), str(path)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0)
        self.assertIn('WARNING', completed.stdout)
        self.assertIn('review rewrites `rawOutput`', completed.stdout)


class RenderTest(unittest.TestCase):
    def test_the_table_prints_every_wrong_question_with_its_arithmetic(self) -> None:
        directory = Path(tempfile.mkdtemp(prefix='residual-'))
        path = directory / 'report.json'
        path.write_text(
            json.dumps(
                _report(
                    [
                        _record('0a995998', gold='3', answer='2', raw='- a\n- b\n'),
                    ]
                )
            )
        )
        completed = subprocess.run(
            [sys.executable, str(TOOL), str(path)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0)
        self.assertIn('0a995998', completed.stdout)
        self.assertIn('selection/under', completed.stdout)
        self.assertIn('MR: 1 count-shaped golds', completed.stdout)


if __name__ == '__main__':
    unittest.main()
