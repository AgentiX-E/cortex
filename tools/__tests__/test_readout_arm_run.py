"""The readout of an ablation run, and the two numbers that must not be confused.

§13.41.5 ran into this twice in one iteration. A report carries:

- `feature.metrics.accuracy` and `baseline.metrics.accuracy`, which are **one
  repetition's** accuracy -- the worst one, which is why `feature.metrics.accuracy`
  equals `featureAggregate.min`;
- `ablation.delta`, which is the difference between the **means over four
  repetitions**.

On run `38985220145` the first pair reads `0.6540 - 0.4440 = +21.00pp` while the
registered statistic reads `+23.25pp`, and an analysis that used one of them while
naming the other would have been wrong by 2.25 points with no way to see it. The
readout therefore prints both, labelled, and says which one the register uses.

The same rule as `--failures` in `classify-raw-outputs.py`: a number is printed
beside the definition it was computed under, or it is not printed at all.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'readout-arm-run.py'
FIXTURES = REPO / 'tools' / '__tests__' / 'fixtures'


def _synthetic_report() -> dict:
    """A minimal report with the shape the readout reads.

    Built here rather than committed, because the numbers it has to make visible are
    the *relationships* between fields -- a single repetition's accuracy, the mean of
    four, and the delta between the means -- and those are easier to state than to
    find in a real artifact.
    """
    def question(capability: str, correct: bool, groundtruth: str, answer: object) -> dict:
        return {
            'questionId': f'{capability}-{groundtruth}-{correct}',
            'capability': capability,
            'groundTruth': groundtruth,
            'answer': answer,
            'rawOutput': answer if isinstance(answer, str) else None,
            'correct': correct,
        }

    return {
        'memoryArmConfig': {
            'ask': 'enumerated',
            'relevanceUnits': 'turn',
            'relevanceSignal': 'retrieval',
            'relevanceTopK': 64,
            'promptContract': 'abstention-evidence-blocks',
        },
        'baseline': {'name': 'reference-pipeline', 'metrics': {'accuracy': 0.4}},
        'feature': {'name': 'cortex-memory', 'metrics': {'accuracy': 0.6}},
        'ablation': {
            'delta': 0.24,
            'mcnemarPValue': 1e-9,
            'mcnemarSignificant': True,
            'discordant': {
                'baselineCorrectFeatureIncorrect': 20,
                'baselineIncorrectFeatureCorrect': 120,
            },
            'baselineAggregate': {'min': 0.39, 'max': 0.41, 'avg': 0.4, 'median': 0.4},
            'featureAggregate': {'min': 0.6, 'max': 0.68, 'avg': 0.64, 'median': 0.63},
        },
        'questions': [
            question('MR', True, '3', '3'),
            question('MR', False, '5', '4'),
            question('MR', False, '7', None),
            question('IE', True, 'Paris', 'paris'),
            question('IE', False, 'Rome', 'Milan'),
            question('TR', True, 'for work', 'a new job'),
            question('ABS', True, None, None),
        ],
    }


class TestTheTwoAccuracies:
    """A single repetition's accuracy and the mean of four are different numbers."""

    @staticmethod
    def _run(tmp_path: Path, report: dict) -> 'subprocess.CompletedProcess[str]':
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), str(path)], capture_output=True, text=True, check=False,
        )

    def test_both_are_printed_and_labelled(self, tmp_path: Path) -> None:
        r = self._run(tmp_path, _synthetic_report())
        assert r.returncode == 0, r.stderr
        # The derivation from the two accuracy fields, and the registered statistic.
        assert 'this repetition' in r.stdout
        assert 'mean of the' in r.stdout
        # 0.6 - 0.4 = 20.00pp, and the register's delta is 0.24 = 24.00pp. Both appear.
        assert '+20.00pp' in r.stdout
        assert '+24.00pp' in r.stdout

    def test_it_names_which_one_the_register_uses(self, tmp_path: Path) -> None:
        r = self._run(tmp_path, _synthetic_report())
        assert 'registered statistic' in r.stdout

    def test_it_prints_the_repetition_span(self, tmp_path: Path) -> None:
        # The reason the two differ is that one is a single repetition of four, so the
        # span is the evidence for the distinction rather than decoration.
        r = self._run(tmp_path, _synthetic_report())
        assert 'min 0.600' in r.stdout
        assert 'max 0.680' in r.stdout


class TestThePerCapabilityTable:
    def test_every_capability_is_counted_from_the_questions(self, tmp_path: Path) -> None:
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(_synthetic_report()), encoding='utf-8')
        r = subprocess.run(
            [sys.executable, str(TOOL), str(path)], capture_output=True, text=True, check=False,
        )
        assert r.returncode == 0, r.stderr
        for line in ('MR: 1/3', 'IE: 1/2', 'TR: 1/1', 'ABS: 1/1'):
            assert line in r.stdout, r.stdout

    def test_the_baseline_column_is_optional_and_labelled(self, tmp_path: Path) -> None:
        """§13.26's per-capability counts are the register's reference, not the artifact's.

        They are constants this tool carries, so a run against a different dataset must
        be able to see that the comparison does not apply rather than reading a delta
        against numbers from another dataset.
        """
        path = tmp_path / 'report.json'
        report = _synthetic_report()
        report['memoryArmConfig']['dataset'] = 'some-other-dataset'
        path.write_text(json.dumps(report), encoding='utf-8')
        r = subprocess.run(
            [sys.executable, str(TOOL), str(path)], capture_output=True, text=True, check=False,
        )
        assert r.returncode == 0, r.stderr
        assert 'no §13.26 reference' in r.stdout


class TestTheFailureTaxonomyIsDelegated:
    """The readout must not re-implement the taxonomy it prints."""

    def test_the_census_comes_from_the_classifier(self, tmp_path: Path) -> None:
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(_synthetic_report()), encoding='utf-8')
        r = subprocess.run(
            [sys.executable, str(TOOL), str(path)], capture_output=True, text=True, check=False,
        )
        assert r.returncode == 0, r.stderr
        assert 'field: answer' in r.stdout
        # One decline, one numeric mismatch and one non-numeric wrong answer.
        assert 'abstention' in r.stdout
        assert 'numeric_mismatch' in r.stdout

    def test_a_report_without_a_roster_is_an_error(self, tmp_path: Path) -> None:
        path = tmp_path / 'report.json'
        path.write_text(json.dumps({'memoryArmConfig': {}}), encoding='utf-8')
        r = subprocess.run(
            [sys.executable, str(TOOL), str(path)], capture_output=True, text=True, check=False,
        )
        assert r.returncode == 2
        assert 'no per-question roster' in r.stderr


class TestAgainstAnArchivedRoster:
    """The one real artifact this repository commits, and its published census."""

    def test_run_38985220145_reports_the_published_taxonomy(self) -> None:
        # The fixture is the MR half of a real report, so the readout's roster path and
        # the classifier's census are exercised against data rather than a stub.
        roster = json.loads((FIXTURES / 'mr-roster-38985220145.json').read_text(encoding='utf-8'))
        report = {
            'memoryArmConfig': {'ask': 'enumerated', 'relevanceUnits': 'turn'},
            'baseline': {'name': 'reference-pipeline', 'metrics': {'accuracy': 0.444}},
            'feature': {'name': 'cortex-memory', 'metrics': {'accuracy': 0.654}},
            'ablation': {
                'delta': 0.2325,
                'mcnemarPValue': 1.8e-9, 'mcnemarSignificant': True,
                'discordant': {
                    'baselineCorrectFeatureIncorrect': 100,
                    'baselineIncorrectFeatureCorrect': 205,
                },
                'baselineAggregate': {'min': 0.438, 'max': 0.444, 'avg': 0.442, 'median': 0.443},
                'featureAggregate': {'min': 0.654, 'max': 0.706, 'avg': 0.6745, 'median': 0.669},
            },
            'questions': roster['questions'],
        }
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'report.json'
            path.write_text(json.dumps(report), encoding='utf-8')
            r = subprocess.run(
                [sys.executable, str(TOOL), str(path)], capture_output=True, text=True, check=False,
            )
        assert r.returncode == 0, r.stderr
        assert 'MR: 29/121' in r.stdout
        assert 'abstention: 35' in r.stdout
        assert 'numeric_mismatch: 52' in r.stdout


class TestTheCoverageTable:
    """§13.51 chose the next variable from this table, and built it inline.

    The measurement is `goldOverlap: {carried, total}` — the share of a question's gold
    turns that reached the window — and the table is what separated TR's declines (a
    coverage problem, 39.7% against 58.3%) from MR's (not one, 52.8% against 54.2%). It
    took twenty minutes to write and it would have saved a dispatch, which is exactly the
    argument for it living here rather than in a shell history.
    """

    @staticmethod
    def _report(rows: list[tuple[str, bool, int, int]]) -> dict:
        """(capability, correct, carried, total) -> a report with a roster."""
        questions = []
        for index, (capability, correct, carried, total) in enumerate(rows):
            questions.append({
                'questionId': f'q{index}',
                'capability': capability,
                'groundTruth': 'x',
                'answer': 'x' if correct else None,
                'rawOutput': 'x',
                'correct': correct,
                'goldOverlap': {'carried': carried, 'total': total},
            })
        return {
            'memoryArmConfig': {'ask': 'enumerated'},
            'baseline': {'metrics': {'accuracy': 0.4}},
            'feature': {'metrics': {'accuracy': 0.6}},
            'ablation': {'delta': 0.2, 'questions': None},
            'questions': questions,
        }

    @staticmethod
    def _run(tmp_path: Path, report: dict, *args: str) -> 'subprocess.CompletedProcess[str]':
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), *args, str(path)], capture_output=True, text=True, check=False,
        )

    def test_it_bands_by_coverage_and_reports_both_rates(self, tmp_path: Path) -> None:
        report = self._report([
            ('MR', True, 10, 10),    # 100%, correct
            ('MR', True, 10, 10),    # 100%, correct
            ('MR', False, 0, 10),    # 0%, declined
            ('MR', False, 5, 10),    # 50%, declined
        ])
        r = self._run(tmp_path, report, '--coverage')
        assert r.returncode == 0, r.stderr
        assert '100%' in r.stdout
        assert '0%' in r.stdout
        # Two correct of two at full coverage; one declined of one at zero.
        assert '100.0%' in r.stdout

    def test_it_reports_the_median_coverage_per_capability_and_outcome(self, tmp_path: Path) -> None:
        # §13.51.2's finding, in the shape that made it visible: the comparison is between
        # outcomes WITHIN a capability, because the two capabilities' declines have
        # different causes.
        report = self._report([
            ('TR', True, 6, 10),     # correct at 60%
            ('TR', True, 6, 10),
            ('TR', False, 4, 10),    # declined at 40%
            ('TR', False, 4, 10),
        ])
        r = self._run(tmp_path, report, '--coverage')
        assert r.returncode == 0, r.stderr
        assert 'correct' in r.stdout and 'declined' in r.stdout
        assert '60.0%' in r.stdout
        assert '40.0%' in r.stdout

    def test_a_report_without_gold_overlap_says_so(self, tmp_path: Path) -> None:
        report = self._report([('MR', True, 10, 10)])
        del report['questions'][0]['goldOverlap']
        r = self._run(tmp_path, report, '--coverage')
        assert r.returncode == 2
        assert 'no goldOverlap' in r.stderr

    def test_zero_total_does_not_divide_by_zero(self, tmp_path: Path) -> None:
        # A question whose dataset names no gold turns has `total: 0`, and it must be
        # excluded rather than counted as 0% coverage.
        report = self._report([('MR', True, 0, 0), ('MR', True, 5, 10)])
        r = self._run(tmp_path, report, '--coverage')
        assert r.returncode == 0, r.stderr
        assert 'excluded' in r.stdout or 'n=  1' in r.stdout or 'n=1' in r.stdout
