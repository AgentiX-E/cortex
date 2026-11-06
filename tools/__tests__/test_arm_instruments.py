#!/usr/bin/env python3
"""Tests for `tools/arm-flip-census.py` and `tools/evidence-completeness.py`.

Both tools exist to stop a number from being read as more than it is, so the fixtures are built the
same way the real artifacts are: a hand-checkable population where the answer is arithmetic, and one
case per way the reading could be inflated.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOLS))

import importlib.util


def _load(name: str):  # noqa: ANN202 - a module loaded by path, like the tools do
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), TOOLS / f'{name}.py')
    if spec is None or spec.loader is None:
        raise ImportError(name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


flip = _load('arm-flip-census')
completeness = _load('evidence-completeness')


def _record(
    identifier: str,
    *,
    correct: bool | None,
    capability: str = 'MR',
    carried: int | None = None,
    total: int | None = None,
    pool: int | None = None,
    **extra: object,
) -> dict:
    record: dict = {'questionId': identifier, 'capability': capability, 'correct': correct}
    if carried is not None and total is not None:
        record['goldOverlap'] = {
            'carried': carried,
            'total': total,
            **({} if pool is None else {'pool': pool}),
        }
    record.update(extra)
    return record


def _report(records: list[dict]) -> dict:
    return {'questions': records}


class ResolutionTest(unittest.TestCase):
    """The smallest net the exact test could call significant, scanned rather than approximated."""

    def test_three_discordant_pairs_cannot_resolve_any_net_at_all(self) -> None:
        # The sweep is 1 then 3: 2-1 is p = 1.0 and 3-0 is p = 0.25, so three pairs has no
        # resolvable net. This is the arithmetic behind gate 3 of §13.262.7 reading FAIL on `KU`
        # at 0 won / 3 lost -- that column could not have called a loss significant at all.
        self.assertIsNone(flip.min_detectable_net(3))

    def test_more_discordance_resolves_a_smaller_net(self) -> None:
        # The reason the column is printed: thirteen flips can resolve a net of eight, and a
        # capability with three cannot resolve one of any size.
        self.assertLess(flip.min_detectable_net(13) or 0, 13)
        self.assertIsNotNone(flip.min_detectable_net(13))

    def test_a_population_with_no_discordance_has_no_resolution(self) -> None:
        self.assertIsNone(flip.min_detectable_net(0))

    def test_the_resolution_shares_the_parity_of_the_discordant_count(self) -> None:
        for discordant in range(1, 30):
            resolution = flip.min_detectable_net(discordant)
            if resolution is None:
                continue
            self.assertEqual(resolution % 2, discordant % 2)

    def test_power_net_is_wider_than_the_exact_resolution(self) -> None:
        # 80 per cent power costs more than the bare threshold, and a tool that reported one number
        # for both would invite the smaller one to be quoted as the detectable effect.
        self.assertGreater(flip.power_net(13) or 0, flip.min_detectable_net(13) or 0)


class WilsonTest(unittest.TestCase):
    def test_an_empty_population_has_no_interval(self) -> None:
        self.assertIsNone(flip.wilson(0, 0))

    def test_the_interval_stays_inside_the_unit_interval_at_a_small_count(self) -> None:
        low, high = flip.wilson(0, 3)  # type: ignore[misc]
        self.assertGreaterEqual(low, 0.0)
        self.assertLessEqual(high, 1.0)
        self.assertGreater(high, 0.5)

    def test_the_interval_narrows_as_the_population_grows(self) -> None:
        narrow = flip.wilson(120, 381)
        wide = flip.wilson(12, 38)
        self.assertLess(narrow[1] - narrow[0], wide[1] - wide[0])  # type: ignore[operator]


class PartitionTest(unittest.TestCase):
    def test_three_operators_and_a_numeric_value(self) -> None:
        self.assertEqual(flip.parse_partition('a>0'), ('a', '>', 0))
        self.assertEqual(flip.parse_partition('a>=1'), ('a', '>=', 1))
        self.assertEqual(flip.parse_partition('a=0'), ('a', '=', 0))
        self.assertEqual(flip.parse_partition('a==0'), ('a', '=', 0))

    def test_a_value_that_is_not_a_number_stays_a_string(self) -> None:
        self.assertEqual(flip.parse_partition('a=bare'), ('a', '=', 'bare'))

    def test_an_expression_without_an_operator_is_refused(self) -> None:
        with self.assertRaises(ValueError):
            flip.parse_partition('auditConsultations')

    def test_an_absent_field_is_on_neither_side(self) -> None:
        # The reason this matters: `auditConsultations` is absent from every artifact produced before
        # the counted columns, and answering "did not act" for those would put the whole pre-mechanism
        # population on the untreated side of a comparison about the mechanism.
        treatment = {'a': _record('a', correct=True), 'b': _record('b', correct=False, auditConsultations=2)}
        control = {'a': _record('a', correct=True), 'b': _record('b', correct=True)}
        read = flip.partition(treatment, control, ['a', 'b'], 'auditConsultations>0')
        self.assertEqual(read['missing_field'], 1)
        self.assertEqual(read['acted']['n'], 1)
        self.assertEqual(read['untouched']['n'], 0)

    def test_the_risk_ratio_is_absent_when_the_untouched_side_has_no_flips(self) -> None:
        treatment = {'a': _record('a', correct=False, auditConsultations=1)}
        control = {'a': _record('a', correct=True)}
        read = flip.partition(treatment, control, ['a'], 'auditConsultations>0')
        self.assertIsNone(read['risk_ratio'])


class FlipCompareTest(unittest.TestCase):
    def test_an_ungraded_side_is_not_a_flip_in_either_direction(self) -> None:
        treatment = {'a': _record('a', correct=None)}
        control = {'a': _record('a', correct=True)}
        result = flip.compare(treatment, control, ['a'])
        self.assertEqual((result['repaired'], result['broken'], result['ungraded']), (0, 0, 1))
        self.assertEqual(result['n'], 0)

    def test_the_net_is_the_difference_of_the_two_directions(self) -> None:
        treatment = {i: _record(i, correct=i in ('a', 'b')) for i in ('a', 'b', 'c')}
        control = {i: _record(i, correct=i in ('b', 'c')) for i in ('a', 'b', 'c')}
        result = flip.compare(treatment, control, ['a', 'b', 'c'])
        self.assertEqual((result['repaired'], result['broken'], result['net']), (1, 1, 0))
        self.assertEqual(result['discordant'], 2)

    def test_a_clean_sweep_is_significant_and_a_split_is_not(self) -> None:
        treatment = {i: _record(i, correct=True) for i in 'abcdefgh'}
        control = {i: _record(i, correct=False) for i in 'abcdefgh'}
        self.assertLess(flip.compare(treatment, control, list('abcdefgh'))['p_value'], 0.05)
        mixed = flip.compare(
            {i: _record(i, correct=True) for i in 'abcd'},
            {i: _record(i, correct=False) for i in 'abcd'},
            list('abcd'),
        )
        self.assertGreater(mixed['p_value'], 0.05)


class FlipCliTest(unittest.TestCase):
    def _run(self, treatment: list[dict], control: list[dict], *extra: str) -> subprocess.CompletedProcess:
        directory = Path(tempfile.mkdtemp(prefix='flip-'))
        left = directory / 'treatment.json'
        right = directory / 'control.json'
        left.write_text(json.dumps(_report(treatment)))
        right.write_text(json.dumps(_report(control)))
        return subprocess.run(
            [sys.executable, str(TOOLS / 'arm-flip-census.py'), '--treatment', str(left),
             '--control', str(right), *extra],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_the_table_reports_the_resolution_beside_the_net(self) -> None:
        treatment = [_record(f'q{i}', correct=i in (0, 1)) for i in range(10)]
        control = [_record(f'q{i}', correct=i in (2, 3)) for i in range(10)]
        completed = self._run(treatment, control)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn('resolution', completed.stdout)
        self.assertIn('power net', completed.stdout)

    def test_artifacts_with_no_shared_question_exit_non_zero(self) -> None:
        completed = self._run([_record('a', correct=True)], [_record('b', correct=True)])
        self.assertEqual(completed.returncode, 1)
        self.assertIn('share no question', completed.stderr)

    def test_the_partition_block_says_it_was_post_hoc(self) -> None:
        treatment = [_record('a', correct=True, auditConsultations=1), _record('b', correct=False)]
        control = [_record('a', correct=False), _record('b', correct=False)]
        completed = self._run(treatment, control, '--partition', 'auditConsultations>0')
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn('post hoc', completed.stdout)

    def test_json_mode_carries_the_ids_each_direction(self) -> None:
        treatment = [_record('a', correct=True), _record('b', correct=False)]
        control = [_record('a', correct=False), _record('b', correct=True)]
        completed = self._run(treatment, control, '--json')
        summary = json.loads(completed.stdout)
        self.assertEqual(summary['overall']['repaired_ids'], ['a'])
        self.assertEqual(summary['overall']['broken_ids'], ['b'])


class CompletenessClassifyTest(unittest.TestCase):
    def test_a_record_without_the_block_is_unknown_and_not_partial(self) -> None:
        # Counting it as partial would inflate the population a window repair is supposed to reach.
        self.assertEqual(completeness.classify(_record('a', correct=False)), 'unknown')

    def test_a_gold_with_no_turns_is_unknown_rather_than_full(self) -> None:
        self.assertEqual(completeness.classify(_record('a', correct=True, carried=0, total=0)), 'unknown')

    def test_missing_one_gold_turn_is_partial(self) -> None:
        self.assertEqual(completeness.classify(_record('a', correct=False, carried=16, total=17)), 'partial')

    def test_every_gold_turn_delivered_is_full(self) -> None:
        self.assertEqual(completeness.classify(_record('a', correct=False, carried=17, total=17)), 'full')


class CompletenessCensusTest(unittest.TestCase):
    def test_accuracy_is_computed_inside_each_population(self) -> None:
        summary = completeness.census([
            _record('a', correct=True, carried=2, total=2),
            _record('b', correct=False, carried=2, total=2),
            _record('c', correct=True, carried=1, total=2),
            _record('d', correct=False, carried=1, total=2),
        ])
        bucket = summary['capabilities']['MR']
        self.assertEqual(bucket['full']['accuracy'], 0.5)
        self.assertEqual(bucket['partial']['accuracy'], 0.5)

    def test_headroom_is_negative_when_partial_outscores_full(self) -> None:
        # The IE column of the real artifact: a window repair wins nothing there, and a tool that
        # floored the number at zero would hide that a repair is not indicated.
        summary = completeness.census([
            _record('a', correct=False, carried=2, total=2),
            _record('b', correct=False, carried=2, total=2),
            _record('c', correct=True, carried=1, total=2),
            _record('d', correct=True, carried=1, total=2),
        ])
        self.assertEqual(summary['capabilities']['MR']['headroom'], -2.0)

    def test_headroom_is_absent_when_one_population_is_empty(self) -> None:
        summary = completeness.census([_record('a', correct=True, carried=2, total=2)])
        self.assertIsNone(summary['capabilities']['MR']['headroom'])

    def test_a_pool_short_of_the_gold_is_counted_apart(self) -> None:
        # `pool < total` is the sub-case no ordering can repair, so it is the one number that
        # decides between a re-rank and a wider retrieval.
        summary = completeness.census([
            _record('a', correct=False, carried=1, total=3, pool=1),
            _record('b', correct=False, carried=2, total=3, pool=3),
        ])
        self.assertEqual(summary['partialUnreachable'], 1)

    def test_records_without_the_block_are_reported_not_folded(self) -> None:
        summary = completeness.census([_record('a', correct=True)])
        self.assertEqual(summary['capabilities']['MR']['unknown']['n'], 1)


class CompletenessCliTest(unittest.TestCase):
    def _run(self, records: list[dict], *extra: str) -> subprocess.CompletedProcess:
        directory = Path(tempfile.mkdtemp(prefix='complete-'))
        path = directory / 'report.json'
        path.write_text(json.dumps(_report(records)))
        return subprocess.run(
            [sys.executable, str(TOOLS / 'evidence-completeness.py'), str(path), *extra],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_the_table_carries_both_populations_and_the_headroom(self) -> None:
        completed = self._run([
            _record('a', correct=True, carried=2, total=2),
            _record('b', correct=False, carried=1, total=2),
        ])
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn('headroom', completed.stdout)
        self.assertIn('MR', completed.stdout)

    def test_an_artifact_without_records_exits_non_zero(self) -> None:
        completed = self._run([])
        self.assertEqual(completed.returncode, 1)
        self.assertIn('no per-question records', completed.stderr)

    def test_an_unknown_capability_is_refused_rather_than_printed_empty(self) -> None:
        completed = self._run([_record('a', correct=True, carried=2, total=2)], '--capability', 'ZZ')
        self.assertEqual(completed.returncode, 1)
        self.assertIn('ZZ', completed.stderr)


if __name__ == '__main__':
    unittest.main()
