"""Tests for `tools/plan-shape-census.py`, the instrument that reads plans rather than answers.

The pass this tabulates wrote plans, and `MEASURE-SPEC-PASS.md` §3 quoted four of them by hand to
diagnose the damage as substitution. A hand-quoted four is a reading, not a population: it cannot say
whether the other 41 damages share the shape, and a gate fitted to it would be fitted to the four.
So the tool has to be exact about three things before its table means anything -- which responses
carry a plan at all, which columns are properties of the *ask* rather than of the selection, and
whether the three verdicts add up to the population.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent


def _load():  # noqa: ANN202 - a module loaded by path, like the tools do
    spec = importlib.util.spec_from_file_location(
        'plan_shape_census', TOOLS / 'plan-shape-census.py'
    )
    if spec is None or spec.loader is None:
        raise ImportError('plan-shape-census')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


census = _load()

PLAN_SUM = '{"scope": [0, 241], "predicates": [{"field": "text", "op": "contains", "value": "items"}], "operation": "sum"}'
PLAN_COUNT = '{"scope": [40, 60], "predicates": [{"field": "date", "op": "on-or-after", "value": "2023/02/01"}, {"field": "text", "op": "contains", "value": "blazer"}], "operation": "count"}'
PLAN_GROUP = '{"scope": [0, 100], "predicates": [{"field": "role", "op": "is", "value": "user"}], "operation": "group-count", "groupBy": "session"}'


def _record(question_id: str, correct: bool, raw: str, capability: str = 'MR') -> dict:
    return {
        'questionId': question_id,
        'capability': capability,
        'correct': correct,
        'rawOutput': raw,
        'answer': '2',
        'groundTruth': '3',
    }


class ReadPlanTest(unittest.TestCase):
    def test_a_bare_plan_parses(self) -> None:
        plan = census.read_plan(PLAN_SUM)
        self.assertIsNotNone(plan)
        self.assertEqual(plan['operation'], 'sum')

    def test_a_fenced_plan_parses(self) -> None:
        raw = f'Here is my plan:\n```json\n{PLAN_COUNT}\n```\n'
        plan = census.read_plan(raw)
        self.assertIsNotNone(plan)
        self.assertEqual(plan['operation'], 'count')

    def test_prose_is_not_a_plan(self) -> None:
        self.assertIsNone(census.read_plan('The answer is 3 because three items matched.'))

    def test_a_missing_field_is_not_a_plan(self) -> None:
        self.assertIsNone(census.read_plan('{"scope": [0, 10], "operation": "count"}'))

    def test_an_empty_response_is_not_a_plan(self) -> None:
        self.assertIsNone(census.read_plan(''))
        self.assertIsNone(census.read_plan(None))

    def test_unbalanced_braces_are_not_a_plan(self) -> None:
        self.assertIsNone(census.read_plan('{"scope": [0, 10], "predicates": [], "operation": "count"'))

    def test_a_json_array_is_not_a_plan(self) -> None:
        self.assertIsNone(census.read_plan('[{"scope": [0, 1]}]'))


class ShapeTest(unittest.TestCase):
    def test_span_counts_inclusively_and_wide_is_a_threshold_on_the_ask(self) -> None:
        plan = census.read_plan(PLAN_SUM)
        assert plan is not None
        row = census.shape(plan)
        self.assertEqual(row['span'], 242)
        self.assertTrue(row['wide'])
        self.assertEqual(row['text_predicates'], 1)
        self.assertEqual(row['keywords'], ['items'])
        self.assertTrue(row['kind_noun'])

    def test_a_narrow_plan_is_not_wide(self) -> None:
        plan = census.read_plan(PLAN_COUNT)
        assert plan is not None
        row = census.shape(plan)
        self.assertEqual(row['span'], 21)
        self.assertFalse(row['wide'])
        self.assertEqual(row['text_predicates'], 1)
        self.assertFalse(row['kind_noun'])

    def test_group_by_is_carried(self) -> None:
        plan = census.read_plan(PLAN_GROUP)
        assert plan is not None
        row = census.shape(plan)
        self.assertEqual(row['group_by'], 'session')
        self.assertFalse(row['wide'])

    def test_a_malformed_scope_leaves_span_unknown(self) -> None:
        row = census.shape({'scope': 'all', 'predicates': [], 'operation': 'count'})
        self.assertIsNone(row['span'])
        self.assertFalse(row['wide'])

    def test_predicates_that_are_not_a_list_are_counted_as_none(self) -> None:
        row = census.shape({'scope': [0, 1], 'predicates': None, 'operation': 'count'})
        self.assertEqual(row['predicates'], 0)
        self.assertEqual(row['keywords'], [])

    def test_kind_nouns_are_matched_case_insensitively(self) -> None:
        plan = {'scope': [0, 5], 'predicates': [{'field': 'text', 'op': 'contains', 'value': 'Items'}]}
        row = census.shape(plan)
        self.assertEqual(row['keywords'], ['items'])
        self.assertTrue(row['kind_noun'])


class VerdictTest(unittest.TestCase):
    def test_the_three_verdicts(self) -> None:
        self.assertEqual(census.verdict({'correct': False}, {'correct': True}), 'repair')
        self.assertEqual(census.verdict({'correct': True}, {'correct': False}), 'damage')
        self.assertEqual(census.verdict({'correct': True}, {'correct': True}), 'neutral')

    def test_a_record_without_the_field_is_not_correct(self) -> None:
        # The artifact writes booleans, but a `None` must not read as a correct answer.
        self.assertEqual(census.verdict({'correct': None}, {'correct': True}), 'repair')


class CensusTest(unittest.TestCase):
    def _pair(self) -> tuple[dict, dict]:
        treatment = {
            'questions': [
                _record('a', False, PLAN_SUM),
                _record('b', True, PLAN_COUNT),
                _record('c', True, 'prose, no plan'),
                _record('d', False, PLAN_SUM, capability='KU'),
            ]
        }
        control = {
            'questions': [
                {'questionId': 'a', 'correct': True, 'answer': '3'},
                {'questionId': 'b', 'correct': False, 'answer': '9'},
                {'questionId': 'c', 'correct': True, 'answer': '3'},
                {'questionId': 'd', 'correct': True, 'answer': 'x'},
            ]
        }
        return treatment, control

    def test_the_population_is_the_capability_and_the_verdicts_add_up(self) -> None:
        result = census.census(*self._pair(), 'MR')
        self.assertEqual(result['population'], 3)
        self.assertEqual(result['counts'], {'repair': 1, 'damage': 1, 'neutral': 1})
        self.assertEqual(result['plans'], 2)

    def test_a_question_missing_from_the_control_is_skipped(self) -> None:
        treatment, control = self._pair()
        control['questions'] = control['questions'][:1]
        result = census.census(treatment, control, 'MR')
        self.assertEqual(result['population'], 1)

    def test_prose_lands_in_its_own_bucket(self) -> None:
        result = census.census(*self._pair(), 'MR')
        self.assertIn('no-plan', result['by_operation'])
        self.assertEqual(result['by_operation']['no-plan']['neutral'], 1)

    def test_the_cross_tabs_split_by_verdict(self) -> None:
        result = census.census(*self._pair(), 'MR')
        self.assertEqual(result['by_operation']['sum'], {'repair': 0, 'damage': 1, 'neutral': 0})
        self.assertEqual(result['by_wide']['True']['damage'], 1)
        self.assertEqual(result['by_kind_noun']['True']['damage'], 1)
        self.assertEqual(result['by_text_predicates']['1']['repair'], 1)

    def test_the_field_set_is_ordered_as_written(self) -> None:
        result = census.census(*self._pair(), 'MR')
        self.assertIn("['date', 'text']", result['by_field_set'])


class ReportTest(unittest.TestCase):
    def test_the_reading_states_what_it_cannot_see(self) -> None:
        text = census.report(census.census(*CensusTest()._pair(), 'MR'))
        self.assertIn('`support` was not persisted', text)
        self.assertIn('population 3 paired questions', text)
        self.assertIn('| value | repair | damage | neutral |', text)


class CommandLineTest(unittest.TestCase):
    def test_json_and_text_modes_both_run(self) -> None:
        treatment, control = CensusTest()._pair()
        with tempfile.TemporaryDirectory() as directory:
            left = Path(directory) / 'treatment.json'
            right = Path(directory) / 'control.json'
            left.write_text(json.dumps(treatment))
            right.write_text(json.dumps(control))
            for extra in (['--json'], []):
                completed = subprocess.run(
                    [
                        'python3',
                        str(TOOLS / 'plan-shape-census.py'),
                        '--treatment',
                        str(left),
                        '--control',
                        str(right),
                        *extra,
                    ],
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(completed.returncode, 0, completed.stderr)
                self.assertTrue(completed.stdout.strip())

    def test_the_json_mode_is_machine_readable(self) -> None:
        treatment, control = CensusTest()._pair()
        with tempfile.TemporaryDirectory() as directory:
            left = Path(directory) / 'treatment.json'
            right = Path(directory) / 'control.json'
            left.write_text(json.dumps(treatment))
            right.write_text(json.dumps(control))
            completed = subprocess.run(
                [
                    'python3',
                    str(TOOLS / 'plan-shape-census.py'),
                    '--treatment',
                    str(left),
                    '--control',
                    str(right),
                    '--json',
                ],
                capture_output=True,
                text=True,
                check=False,
            )
            parsed = json.loads(completed.stdout)
            self.assertEqual(parsed['population'], 3)


class GateTableTest(unittest.TestCase):
    """The gate table's arithmetic, which is the part a reader will quote as a decision.

    A gate is priced against the **control**, not against the treatment: `blocked - lost` only says
    what the gate did to the pass, and the pass was below the control to begin with. The number that
    matters is `repairs kept - damages kept`, and the fixture below is built so that this is not
    zero by construction: one of its three repairs has **no plan at all**, which is the shape the
    real census found on five questions, and which no gate can reach.
    """

    def _rows(self) -> dict:
        treatment = {
            'questions': [
                _record('repair-wide', True, PLAN_SUM),       # span 242, sum, kind noun
                _record('repair-narrow', True, PLAN_COUNT),   # span 21, count
                _record('damage-wide', False, PLAN_SUM),
                _record('damage-narrow', False, PLAN_COUNT),
                _record('noise', True, 'prose'),              # moved with no plan
            ]
        }
        control = {
            'questions': [
                {'questionId': 'repair-wide', 'correct': False},
                {'questionId': 'repair-narrow', 'correct': False},
                {'questionId': 'damage-wide', 'correct': True},
                {'questionId': 'damage-narrow', 'correct': True},
                {'questionId': 'noise', 'correct': False},
            ]
        }
        return census.census(treatment, control, 'MR')

    def test_a_gate_that_blocks_every_plan_leaves_the_floor_it_cannot_reach(self) -> None:
        table = {row['gate']: row for row in census.gate_table(self._rows())}
        # Three repairs against two damages is the treatment's own net, +1. `span-wide` takes one of
        # each, and the repair it cannot take is the planless one -- so the gate still reads +1 and
        # reads it for the reason the real population read +1: the flip had no plan to refuse.
        self.assertEqual(table['span-wide']['blocked_damage'], 1)
        self.assertEqual(table['span-wide']['lost_repair'], 1)
        self.assertEqual(table['span-wide']['net_against_control'], 1)

    def test_a_gate_that_blocks_nothing_reads_the_treatments_own_net(self) -> None:
        table = {row['gate']: row for row in census.gate_table(self._rows())}
        # No plan in the fixture has zero text predicates, so this gate rejects nothing at all.
        self.assertEqual(table['no-text-predicate']['blocked_damage'], 0)
        self.assertEqual(table['no-text-predicate']['lost_repair'], 0)
        self.assertEqual(table['no-text-predicate']['net_against_control'], 1)

    def test_a_blocked_damage_moves_the_net_by_one_question(self) -> None:
        table = {row['gate']: row for row in census.gate_table(self._rows())}
        # `count` rejects both narrow plans: it saves the damage and loses the repair, so the net is
        # unchanged while two questions changed side -- the trade a gate must not be praised for.
        self.assertEqual(table['count']['blocked_damage'], 1)
        self.assertEqual(table['count']['lost_repair'], 1)
        self.assertEqual(table['count']['net_against_control'], 1)

    def test_a_planless_question_is_authorized_and_out_of_reach(self) -> None:
        for row in census.gate_table(self._rows()):
            self.assertLessEqual(row['blocked_damage'] + row['lost_repair'], 4)

    def test_every_named_gate_is_priced_in_the_report(self) -> None:
        text = census.report(self._rows())
        for name in census.GATES:
            self.assertIn(f'`{name}`', text)


if __name__ == '__main__':
    unittest.main()
