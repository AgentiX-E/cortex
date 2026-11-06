#!/usr/bin/env python3
"""The population has to be chosen before the answers exist, and the rule has to be reviewable.

## The two ways this can be wrong, and which one the tests cover

A counterfactual population chosen after the outcome is selection on the outcome, and no result it
produces can be believed. A population chosen before the outcome with a rule that discards most of the
failures is not wrong but is useless, and the difference between those two failures is exactly what a
yield number tells you.

Matching on `total` was the first rule. Against `42161343457` it produced three pairs and seven
unmatched failures, because gold counts there run from 10 to 30 while partial successes cluster at the
small end. The rule that replaced it matches on the size of the intervention -- the number of gold
turns the pair would each receive -- and produces eight pairs and two unmatched. Both yields are facts
about counts, read before any restore, and the second is the one this file holds.

## What the fixtures are for

The pair rule is the part that cannot be checked by looking at a result: a badly paired control
produces a number that looks exactly like a well paired one. So each test below fixes one property the
pairing has to have -- same intervention size, mutual exclusivity, a deterministic tie-break, and no
silent pairing across strata -- and one fixes the refusal when the population is empty.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'restore-population.py'


def _record(
    identifier: str,
    *,
    total: int,
    carried: int,
    correct: bool,
    capability: str = 'MR',
    ranks: list[int] | None = None,
    turns: list[str] | None = None,
) -> dict:
    delivered = [index < carried for index in range(total)]
    overlap: dict = {
        'carried': carried,
        'total': total,
        'goldDelivered': delivered,
        'goldRanks': ranks if ranks is not None else list(range(total)),
        'pool': total,
    }
    if turns is not None:
        overlap['goldTurns'] = turns
    return {
        'questionId': identifier,
        'capability': capability,
        # Carried because the harness plan matches a prompt on the question line; a fixture without
        # one would let a plan builder that dropped the text pass every test here.
        'question': f'question asked by {identifier}?',
        'correct': correct,
        'goldOverlap': overlap,
    }


def _run(records: list[dict], *, capability: str = 'MR') -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'artifact.json'
        path.write_text(json.dumps({'questions': records}))
        return subprocess.run(
            [sys.executable, str(TOOL), str(path), '--capability', capability],
            capture_output=True,
            text=True,
            check=False,
        )


class StratumTest(unittest.TestCase):
    """Who is in the population, and who is deliberately not."""

    def test_a_fully_delivered_question_is_not_a_candidate(self) -> None:
        # `carried == total` has nothing to reinstate. Counting it would put the intervention's own
        # control into its treatment group.
        result = _run([_record('full', total=4, carried=4, correct=True)])
        self.assertEqual(result.returncode, 2)
        self.assertIn('no population', result.stderr)

    def test_a_record_without_gold_is_not_a_candidate(self) -> None:
        record = {'questionId': 'x', 'capability': 'MR', 'correct': False}
        result = _run([record])
        self.assertEqual(result.returncode, 2)

    def test_the_capability_filter_is_exact(self) -> None:
        result = _run(
            [
                _record('a', total=4, carried=2, correct=False),
                _record('b', total=4, carried=2, correct=False, capability='TR'),
            ]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('MR: 1 partial failures', result.stdout)
        self.assertNotIn('b ', result.stdout)

    def test_the_size_of_the_intervention_is_read_from_the_counts(self) -> None:
        result = _run(
            [
                _record('f', total=10, carried=7, correct=False, turns=['x' * 100] * 10),
                _record('c', total=12, carried=9, correct=True, turns=['y' * 50] * 12),
            ]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        # Three missing turns on each side: 300 characters against 150, printed per side.
        self.assertIn('300', result.stdout)
        self.assertIn('150', result.stdout)


class PairingTest(unittest.TestCase):
    """The properties a pair has to have for the control to price the intervention."""

    def test_a_failure_is_paired_with_a_success_missing_the_same_number_of_turns(self) -> None:
        result = _run(
            [
                _record('f', total=6, carried=4, correct=False),
                _record('c2', total=6, carried=4, correct=True),
                _record('c3', total=6, carried=3, correct=True),
            ]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('1 pair(s)', result.stdout)
        # `missing` is 2 on the failure, and `c2` is the only success at 2 -- `c3` is at 3.
        self.assertRegex(result.stdout, r'f\s+2\s+True\s+\?\s+c2\s+2')

    def test_a_failure_with_no_success_at_its_intervention_size_is_reported_unmatched(self) -> None:
        result = _run(
            [
                _record('f', total=6, carried=1, correct=False),
                _record('c', total=6, carried=4, correct=True),
            ]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('0 pair(s)', result.stdout)
        self.assertIn('UNMATCHED', result.stdout)
        self.assertIn('no partial success receiving the same number of turns', result.stdout)

    def test_no_success_is_used_twice(self) -> None:
        # One control cannot price two interventions, and a reused one would make the two pairs
        # dependent in a way the classification has no term for.
        result = _run(
            [
                _record('f1', total=6, carried=4, correct=False),
                _record('f2', total=6, carried=4, correct=False),
                _record('c', total=6, carried=4, correct=True),
            ]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('1 pair(s)', result.stdout)
        self.assertIn('1 unmatched failure(s)', result.stdout)

    def test_the_tie_break_is_the_identifier_so_the_list_reproduces(self) -> None:
        # Two successes equally near the failure: the choice must not depend on the order the records
        # happen to appear in, or two runs of this tool would produce two populations.
        forward = _run(
            [
                _record('f', total=6, carried=4, correct=False),
                _record('a', total=6, carried=4, correct=True),
                _record('b', total=6, carried=4, correct=True),
            ]
        )
        backward = _run(
            [
                _record('f', total=6, carried=4, correct=False),
                _record('b', total=6, carried=4, correct=True),
                _record('a', total=6, carried=4, correct=True),
            ]
        )
        self.assertEqual(forward.returncode, 0, forward.stderr)
        self.assertIn('control', forward.stdout)
        self.assertEqual(forward.stdout, backward.stdout)
        self.assertRegex(forward.stdout, r'f\s+2\s+True\s+\?\s+a\s')

    def test_a_json_run_carries_the_rule_s_own_output(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'artifact.json'
            path.write_text(
                json.dumps(
                    {
                        'questions': [
                            _record('f', total=6, carried=4, correct=False),
                            _record('c', total=6, carried=4, correct=True),
                        ]
                    }
                )
            )
            result = subprocess.run(
                [sys.executable, str(TOOL), str(path), '--json'],
                capture_output=True,
                text=True,
                check=False,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        payload = json.loads(result.stdout)
        self.assertEqual(len(payload['pairs']), 1)
        self.assertEqual(payload['pairs'][0]['failure']['questionId'], 'f')
        self.assertEqual(payload['pairs'][0]['control']['questionId'], 'c')
        self.assertEqual(payload['unmatched'], [])


class PlanTest(unittest.TestCase):
    """The plan is the selection, rendered in the form the harness reads -- not a second selection."""

    def _plan(self, records: list[dict], *extra: str) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'artifact.json'
            path.write_text(json.dumps({'questions': records}))
            return subprocess.run(
                [sys.executable, str(TOOL), str(path), '--plan', *extra],
                capture_output=True,
                text=True,
                check=False,
            )

    def test_the_plan_carries_the_failures_then_the_paired_controls(self) -> None:
        result = self._plan(
            [
                _record('f', total=4, carried=3, correct=False, turns=['a', 'b', 'c', 'd']),
                _record('c', total=4, carried=3, correct=True, turns=['w', 'x', 'y', 'z']),
            ]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual([entry['questionId'] for entry in plan['entries']], ['f', 'c'])
        self.assertEqual([entry['recordedOutcome'] for entry in plan['entries']], ['incorrect', 'correct'])
        # The missing turn is the one `goldDelivered` marks false -- the last, at `carried=3` of 4.
        self.assertEqual(plan['entries'][0]['turns'], ['d'])
        self.assertEqual(plan['entries'][1]['turns'], ['z'])
        self.assertIn('question asked by f?', plan['entries'][0]['question'])

    def test_a_partial_success_that_is_not_a_control_is_not_in_the_plan(self) -> None:
        # Twelve partial successes and ten pairs would otherwise put twenty controls in the run, each
        # one a question the analysis has no pair for.
        result = self._plan(
            [
                _record('f', total=4, carried=3, correct=False, turns=['a', 'b', 'c', 'd']),
                _record('c', total=4, carried=3, correct=True, turns=['w', 'x', 'y', 'z']),
                _record('extra', total=4, carried=3, correct=True, turns=['w', 'x', 'y', 'z']),
            ]
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual([entry['questionId'] for entry in plan['entries']], ['f', 'c'])

    def test_an_unmatched_failure_is_still_in_the_plan(self) -> None:
        # It has no control, which costs the pairing a row. Leaving it out would make the instrument
        # quietest about the largest interventions, which are exactly the ones with no partner.
        result = self._plan([_record('lonely', total=9, carried=3, correct=False, turns=['t'] * 9)])
        self.assertEqual(result.returncode, 0, result.stderr)
        plan = json.loads(result.stdout)
        self.assertEqual([entry['questionId'] for entry in plan['entries']], ['lonely'])
        self.assertEqual(len(plan['entries'][0]['turns']), 6)

    def test_the_source_defaults_to_the_artifact_and_can_be_labelled(self) -> None:
        default = self._plan([_record('f', total=4, carried=3, correct=False, turns=['a', 'b', 'c', 'd'])])
        self.assertEqual(json.loads(default.stdout)['source'].endswith('artifact.json'), True)
        labelled = self._plan(
            [_record('f', total=4, carried=3, correct=False, turns=['a', 'b', 'c', 'd'])],
            '--source',
            'run-42190193540',
        )
        self.assertEqual(json.loads(labelled.stdout)['source'], 'run-42190193540')

    def test_a_plan_without_gold_turn_text_is_refused(self) -> None:
        # `turns` absent is the §13.268.7 shape: the sum is zero, every question looks like it needs
        # nothing, and the run reports a clean null.
        result = self._plan([_record('f', total=4, carried=3, correct=False)])
        self.assertEqual(result.returncode, 2)
        self.assertIn('does not carry both `goldTurns` and `goldDelivered`', result.stderr)

    def test_a_plan_whose_two_lists_are_not_aligned_is_refused(self) -> None:
        record = _record('f', total=4, carried=3, correct=False, turns=['a', 'b'])
        result = self._plan([record])
        self.assertEqual(result.returncode, 2)
        self.assertIn('aligned by construction', result.stderr)

    def test_a_question_with_nothing_missing_is_refused_rather_than_restored_empty(self) -> None:
        record = _record('f', total=4, carried=3, correct=False, turns=['a', 'b', 'c', 'd'])
        record['goldOverlap']['goldDelivered'] = [True, True, True, True]
        result = self._plan([record])
        self.assertEqual(result.returncode, 2)
        self.assertIn('nothing is missing', result.stderr)

    def test_a_record_without_a_question_text_is_refused(self) -> None:
        # The decorator matches a prompt on the question line. A plan entry with no text would match
        # nothing, and the run would report a complete intervention that never happened.
        record = _record('f', total=4, carried=3, correct=False, turns=['a', 'b', 'c', 'd'])
        record['question'] = ''
        result = self._plan([record])
        self.assertEqual(result.returncode, 2)
        self.assertIn('no question text', result.stderr)

    def test_an_empty_gold_turn_is_refused(self) -> None:
        record = _record('f', total=4, carried=3, correct=False, turns=['a', 'b', 'c', 'd'])
        record['goldOverlap']['goldTurns'] = ['a', 'b', 'c', '']
        result = self._plan([record])
        self.assertEqual(result.returncode, 2)
        self.assertIn('empty gold turn', result.stderr)


if __name__ == '__main__':
    unittest.main()
