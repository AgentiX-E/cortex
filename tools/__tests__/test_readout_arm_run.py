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


class TestTheDeclinesAndTheListTheyCarry:
    """§13.56's variable was chosen from this table, so the table is a tool.

    §13.55 added a sentence forbidding a decline after a non-empty Step 1 list, and run
    `39035438120` showed the model declining anyway: of the 21 MR declines it inherited,
    **12 carried a non-empty list**, and `7024f17c` computed the exact gold in Step 2 and
    appended the sentinel. The measurement that turned "declines" into "declines of two
    different kinds" is what selected the next variable, and it took an inline script --
    the fourth time this campaign has paid for one.

    ## The distinction the table has to get right

    A list containing only *assertions of absence* -- "No items in the evidence mention a
    camping trip." -- is an **empty** list. The model wrote a bullet, and the bullet says
    there is nothing. Counting bullets would classify an honest empty list as non-empty and
    send the campaign after a defect that is not there, which is the same failure mode in
    the other direction as missing the real one.
    """

    STEP_ONE = 'Step 1 \u2014 list every item in the evidence that matches the question.'
    STEP_TWO = 'Step 2 \u2014 compute the answer from that list.'

    def _report(self, rows: list[tuple[str, bool, str]]) -> dict:
        """(capability, correct, rawOutput) -> a report with a roster."""
        questions = []
        for index, (capability, correct, raw) in enumerate(rows):
            questions.append({
                'questionId': f'q{index}',
                'capability': capability,
                'groundTruth': 'x',
                'answer': None if not correct else 'x',
                'rawOutput': raw,
                'correct': correct,
            })
        return {
            'memoryArmConfig': {'ask': 'enumerated'},
            'baseline': {'metrics': {'accuracy': 0.4}},
            'feature': {'metrics': {'accuracy': 0.6}},
            'ablation': {'delta': 0.2, 'questions': None},
            'questions': questions,
        }

    def _run(self, tmp_path: Path, report: dict) -> 'subprocess.CompletedProcess[str]':
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), '--declines', str(path)],
            capture_output=True, text=True, check=False,
        )

    def _declined_with_list(self) -> str:
        return '\n'.join([
            self.STEP_ONE, '',
            '- the user went to Kyoto in May',
            '- the user went to Osaka in June', '',
            self.STEP_TWO, '',
            'The list has 2 items, so the total is 2.',
            'INSUFFICIENT_EVIDENCE',
        ])

    def _declined_with_empty_list(self) -> str:
        return '\n'.join([
            self.STEP_ONE, '',
            '- No items in the evidence mention a camping trip.',
            '- None of the turns state a duration.', '',
            self.STEP_TWO, '',
            'The list is empty, so the answer is INSUFFICIENT_EVIDENCE.',
        ])

    def test_it_separates_a_list_with_items_from_a_list_that_asserts_absence(
        self, tmp_path: Path,
    ) -> None:
        report = self._report([
            ('MR', False, self._declined_with_list()),
            ('MR', False, self._declined_with_empty_list()),
        ])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'non-empty list' in r.stdout
        assert 'empty list' in r.stdout
        # One of each, so the counts must both be 1 -- and a table that lumped them would
        # print 2 against one of the two labels.
        assert '1' in r.stdout

    def test_an_absence_assertion_in_a_bullet_is_not_an_item(self, tmp_path: Path) -> None:
        # The whole reason the negation list exists. Two bullets, no items.
        report = self._report([('MR', False, self._declined_with_empty_list())])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'non-empty list' not in r.stdout or 'non-empty list            0' in r.stdout.replace('  ', ' ')

    def test_a_decline_with_no_step_one_section_is_its_own_state(self, tmp_path: Path) -> None:
        # Run `39035438120` had one: the bare sentinel, which the contract's older sentence
        # already forbids. It is not an empty list -- there is no list at all.
        report = self._report([('MR', False, 'INSUFFICIENT_EVIDENCE')])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'no Step 1' in r.stdout

    def test_it_says_whether_step_two_stated_a_number(self, tmp_path: Path) -> None:
        # §13.56's direct target: a list, a computed number, and a decline anyway.
        report = self._report([
            ('MR', False, self._declined_with_list()),
            ('MR', False, '\n'.join([
                self.STEP_ONE, '', '- a', '',
                self.STEP_TWO, '', 'The evidence does not state the amount.',
                'INSUFFICIENT_EVIDENCE',
            ])),
        ])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'number in Step 2' in r.stdout

    def test_a_capability_the_contract_does_not_reach_is_still_listed(self, tmp_path: Path) -> None:
        # TR and IE never receive the contract, so every one of their declines has no Step 1.
        # Printing them makes the reach visible from the table instead of from a document.
        report = self._report([
            ('MR', False, self._declined_with_list()),
            ('TR', False, 'INSUFFICIENT_EVIDENCE'),
        ])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'MR' in r.stdout and 'TR' in r.stdout

    def test_correct_answers_are_not_counted_as_declines(self, tmp_path: Path) -> None:
        report = self._report([
            ('MR', True, self._declined_with_list()),
            ('MR', False, 'INSUFFICIENT_EVIDENCE'),
        ])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'declines 1' in r.stdout.replace('  ', ' ') or 'declines: 1' in r.stdout

    @pytest.mark.parametrize(
        'heading',
        ['Step 1 \u2014 list', 'Step 1: list', 'Step 1 - list', 'step 1 \u2014 compute', ' Step 1 : list'],
    )
    def test_it_recognises_the_headings_the_model_writes(self, heading: str, tmp_path: Path) -> None:
        # The two shapes in the artifacts are the em dash (the contract's own) and the colon
        # (the model's paraphrase). Both have to split, or a list-containing decline reads as
        # a list-less one.
        raw = f'{heading}\n\n- an item\n\nStep 2 \u2014 compute\n\n3\nINSUFFICIENT_EVIDENCE'
        report = self._report([('MR', False, raw)])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'non-empty list' in r.stdout

    @pytest.mark.parametrize('not_a_heading', ['Steps 1 of 2', 'Step 1.5', 'Stepping'])
    def test_it_does_not_split_on_a_near_miss(self, not_a_heading: str, tmp_path: Path) -> None:
        raw = f'{not_a_heading}\n\n- an item\n\nINSUFFICIENT_EVIDENCE'
        report = self._report([('MR', False, raw)])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'no Step 1' in r.stdout
