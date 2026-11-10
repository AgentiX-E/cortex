#!/usr/bin/env python3
"""Tests for `tools/reader-ladder.py`.

The tool writes the one number `M1` reads, so the fixtures are built to answer a single question each:
does a refusal fire where the pair stops being a pair, and does the delta stay the statistic `S1`
gates rather than the single repetition `feature.metrics` reports?
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(TOOLS))


def _load(name: str):  # noqa: ANN202 - a module loaded by path, like the tools do
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), TOOLS / f'{name}.py')
    if spec is None or spec.loader is None:
        raise ImportError(name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


ladder = _load('reader-ladder')


def _question(identifier: str, digest: str | None) -> dict:
    record: dict = {'questionId': identifier, 'correct': True}
    if digest is not None:
        record['promptDigest'] = digest
    return record


def _report(
    *,
    correct_by_run: list[str] | str = ('1111',),
    question_count: int = 4,
    runs: int = 4,
    digests: tuple[str | None, ...] = ('a', 'b', 'c', 'd'),
    capability_counts: dict[str, int] | None = None,
) -> dict:
    identifiers = [f'q{i}' for i in range(question_count)]
    counts = capability_counts or {'MR': question_count}
    by_capability = {name: {'avg': float(size), 'min': size, 'max': size} for name, size in counts.items()}
    return {
        'questionCount': question_count,
        'runs': runs,
        'questions': [_question(i, d) for i, d in zip(identifiers, digests)],
        'ablation': {
            'featureCorrectByRun': correct_by_run,
            'featureByCapability': by_capability,
            'questionsByCapability': counts,
        },
    }


class MeanTest(unittest.TestCase):
    def test_the_mean_is_over_the_repetition_vector_and_not_one_draw(self) -> None:
        report = _report(correct_by_run=['1100'], question_count=4)
        self.assertAlmostEqual(ladder._repetition_mean(report), 2 / 4)

    def test_two_repetitions_average_rather_than_concatenate(self) -> None:
        report = _report(correct_by_run=['1100', '1111'], question_count=4)
        self.assertAlmostEqual(ladder._repetition_mean(report), 6 / 8)

    def test_a_vector_not_aligned_to_the_population_is_refused(self) -> None:
        with self.assertRaises(SystemExit) as caught:
            ladder._repetition_mean(_report(correct_by_run=['110'], question_count=4))
        self.assertIn('not aligned', str(caught.exception))

    def test_a_bare_string_is_refused_because_it_cannot_say_what_it_counts(self) -> None:
        with self.assertRaises(SystemExit) as caught:
            ladder._repetition_mean(_report(correct_by_run='1100'))
        self.assertIn('list', str(caught.exception))

    def test_an_artifact_without_the_vector_is_refused(self) -> None:
        report = _report()
        del report['ablation']['featureCorrectByRun']
        with self.assertRaises(SystemExit):
            ladder._repetition_mean(report)

    def test_a_vector_that_is_not_a_digit_string_is_refused(self) -> None:
        with self.assertRaises(SystemExit):
            ladder._repetition_mean(_report(correct_by_run=['1,1,0,0']))


class PairingTest(unittest.TestCase):
    def test_a_population_of_a_different_size_is_refused(self) -> None:
        with self.assertRaises(SystemExit) as caught:
            ladder.pairing(_report(question_count=4), _report(question_count=8))
        self.assertIn('different populations', str(caught.exception))

    def test_a_different_repetition_count_is_refused(self) -> None:
        with self.assertRaises(SystemExit) as caught:
            ladder.pairing(_report(runs=4), _report(runs=1))
        self.assertIn('different repetition counts', str(caught.exception))

    def test_an_artifact_with_no_questions_is_refused(self) -> None:
        with self.assertRaises(SystemExit):
            ladder.pairing({'questionCount': 4, 'runs': 4, 'questions': []}, _report())


class IdentityTest(unittest.TestCase):
    def test_differing_digests_make_the_pair_inadmissible(self) -> None:
        result = ladder.identity(
            _report(digests=('a', 'b', 'c', 'd')),
            _report(digests=('a', 'b', 'c', 'z')),
        )
        self.assertEqual((result['identical'], result['differ'], result['admissible']), (3, 1, False))

    def test_a_missing_digest_is_not_read_as_an_identical_one(self) -> None:
        result = ladder.identity(
            _report(digests=('a', 'b', 'c', 'd')),
            _report(digests=('a', 'b', 'c', None)),
        )
        self.assertEqual((result['identical'], result['missing'], result['admissible']), (3, 1, False))


class ReadingTest(unittest.TestCase):
    def test_the_delta_is_the_difference_of_the_two_repetition_means(self) -> None:
        control = _report(correct_by_run=['1100'])
        treatment = _report(correct_by_run=['1110'])
        result = ladder.reading(control, treatment, 'A', 'B')
        self.assertAlmostEqual(result['deltaPoints'], 0.75 - 0.5)

    def test_the_capability_rows_divide_by_their_own_population(self) -> None:
        control = _report(correct_by_run=['1100'], capability_counts={'MR': 2, 'IE': 2})
        treatment = _report(correct_by_run=['1110'], capability_counts={'MR': 2, 'IE': 2})
        control['ablation']['featureByCapability'] = {'MR': {'avg': 2.0}, 'IE': {'avg': 0.0}}
        treatment['ablation']['featureByCapability'] = {'MR': {'avg': 2.0}, 'IE': {'avg': 1.0}}
        result = ladder.reading(control, treatment, 'A', 'B')
        rows = {row['capability']: row for row in result['perCapability']}
        self.assertAlmostEqual(rows['MR']['control'], 1.0)
        self.assertAlmostEqual(rows['IE']['control'], 0.0)


class SignTest(unittest.TestCase):
    """`M1` measures the reasoning reader's gain, so the sign is a property of which side reasons."""

    def test_a_reasoning_treatment_contributes_its_gain_directly(self) -> None:
        control = _report(correct_by_run=['1100'])
        treatment = _report(correct_by_run=['1110'])
        result = ladder.reading(control, treatment, 'A', 'B', 'treatment')
        self.assertGreater(result['reasoningGainPoints'], 0)
        self.assertEqual(result['reasoningGainPoints'], result['deltaPoints'])

    def test_a_reasoning_control_contributes_the_negation_of_the_delta(self) -> None:
        control = _report(correct_by_run=['1110'])
        treatment = _report(correct_by_run=['1100'])
        result = ladder.reading(control, treatment, 'A', 'B', 'control')
        self.assertGreater(result['reasoningGainPoints'], 0)
        self.assertEqual(result['reasoningGainPoints'], -result['deltaPoints'])

    def test_an_unknown_side_is_refused_rather_than_defaulted(self) -> None:
        with self.assertRaises(SystemExit):
            ladder.reading(_report(), _report(), 'A', 'B', 'reasoning')


class CliTest(unittest.TestCase):
    def _write(self, directory: Path, name: str, report: dict) -> Path:
        path = directory / name
        path.write_text(json.dumps(report))
        return path

    def test_the_table_reports_the_identity_and_the_admissibility(self) -> None:
        directory = Path(tempfile.mkdtemp(prefix='ladder-'))
        left = self._write(directory, 'control.json', _report(correct_by_run=['1100']))
        right = self._write(directory, 'treatment.json', _report(correct_by_run=['1110']))
        completed = subprocess.run(
            [sys.executable, str(TOOLS / 'reader-ladder.py'), '--control', str(left), '--run-a', 'A',
             '--treatment', str(right), '--run-b', 'B'],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertIn('admissible yes', completed.stdout)
        self.assertIn('delta', completed.stdout)

    def test_write_produces_the_file_the_matrix_reads(self) -> None:
        directory = Path(tempfile.mkdtemp(prefix='ladder-'))
        left = self._write(directory, 'control.json', _report(correct_by_run=['1100']))
        right = self._write(directory, 'treatment.json', _report(correct_by_run=['1110']))
        target = directory / 'ladder.json'
        completed = subprocess.run(
            [sys.executable, str(TOOLS / 'reader-ladder.py'), '--control', str(left), '--run-a', 'A',
             '--treatment', str(right), '--run-b', 'B', '--write', str(target)],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        written = json.loads(target.read_text())
        self.assertEqual(written['control']['run'], 'A')
        self.assertIn('deltaPoints', written)


if __name__ == '__main__':
    unittest.main()
