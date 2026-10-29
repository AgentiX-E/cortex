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
import re
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


class TestTheUnionOfTheTwoSides:
    """The roadmap's target line is a derived number, so it is a tool.

    §110's reading of run `39035438120` produced the number that now sets the project's
    goal: **431/500 = 86.20%** of questions are answered correctly by *one of the two
    systems*, and 75 of the 77 the feature misses are in MR and TR. A target line computed
    by an inline script is a target no reader can check, which is §13.38 exactly.

    ## Why the derivation needs a self-check rather than a comment

    The roster carries the **feature** side's correctness only. The baseline side has to be
    reconstructed from the two discordant lists -- `baselineCorrectFeatureIncorrect` and
    `baselineIncorrectFeatureCorrect` -- and a reconstruction with the wrong sign on either
    list produces a plausible table with a wrong number in it (this happened: the first
    attempt read the baseline as 431/500 instead of 222/500). So the tool recomputes the
    baseline's total and **refuses to print** if it disagrees with `baselineMetrics.correct`.
    """

    @staticmethod
    def _report(feature_true: int, baseline_true: int, both_true: int) -> dict:
        """Three questions: only-feature, only-baseline, both -- all others neither.

        `feature_true` is how many questions the feature got right, `baseline_true` the same
        for the baseline, and `both_true` the overlap. The discordant lists are built from
        those, so the reconstruction has something to reconstruct.
        """
        total = 6
        feature_ids = [f'q{i}' for i in range(feature_true)]
        baseline_ids = [f'q{i}' for i in range(both_true)] + [
            f'q{i}' for i in range(feature_true, feature_true + baseline_true - both_true)
        ]
        feature_set = set(feature_ids)
        baseline_set = set(baseline_ids)
        questions = [
            {
                'questionId': f'q{i}',
                'capability': 'MR',
                'groundTruth': 'x',
                'answer': 'x' if f'q{i}' in feature_set else None,
                'rawOutput': 'x',
                'correct': f'q{i}' in feature_set,
            }
            for i in range(total)
        ]
        return {
            'memoryArmConfig': {'ask': 'enumerated'},
            'baseline': {'metrics': {'accuracy': baseline_true / total, 'correct': baseline_true}},
            'feature': {'metrics': {'accuracy': feature_true / total}},
            'ablation': {
                'delta': 0.1,
                'questions': None,
                'baselineMetrics': {'correct': baseline_true},
                'discordantQuestions': {
                    'baselineCorrectFeatureIncorrect': sorted(baseline_set - feature_set),
                    'baselineIncorrectFeatureCorrect': sorted(feature_set - baseline_set),
                },
            },
            'questions': questions,
        }

    @staticmethod
    def _run(tmp_path: Path, report: dict) -> 'subprocess.CompletedProcess[str]':
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), '--union', str(path)],
            capture_output=True, text=True, check=False,
        )

    def test_it_prints_the_union_and_the_gap(self, tmp_path: Path) -> None:
        # feature 4, baseline 3, overlap 2 -> union 5 of 6.
        r = self._run(tmp_path, self._report(feature_true=4, baseline_true=3, both_true=2))
        assert r.returncode == 0, r.stderr
        assert 'union' in r.stdout
        assert '5/6' in r.stdout.replace(' ', '')

    def test_it_reports_the_gap_from_the_feature_to_the_union(self, tmp_path: Path) -> None:
        # The number the roadmap ranks on: feature 4, union 5 -> a gap of 1, not 2.
        r = self._run(tmp_path, self._report(feature_true=4, baseline_true=3, both_true=2))
        assert r.returncode == 0, r.stderr
        assert 'gap' in r.stdout.lower()

    def test_a_reconstruction_that_disagrees_with_the_report_refuses_to_print(
        self, tmp_path: Path,
    ) -> None:
        # The defect this guard exists for. Flip one id between the two discordant lists and
        # the reconstruction still produces a table -- with the wrong number in it.
        report = self._report(feature_true=4, baseline_true=3, both_true=2)
        report['ablation']['baselineMetrics']['correct'] = 5
        r = self._run(tmp_path, report)
        assert r.returncode == 2
        assert 'baseline' in r.stderr


class TestWhetherTheModelCountedWhatItListed:
    """The measurement that decides between "cannot count" and "was shown too little".

    Run `39035438120`'s MR has 27 `numeric_mismatch`, and 10 of them are off by exactly one.
    In 9 of the 27 the answer **is the length of the model's own Step 1 list** -- it counted
    its list faithfully and the list was short. That is a different defect from arithmetic,
    and the two need opposite repairs: one is a prompt, the other is retrieval.

    So the predicate is a tool. It reads `rawOutput` for the list and `answer` for the number,
    which is the one place the two fields are both needed: `failure_shape` grades the answer,
    `decline_state` reads the reasoning, and this asks whether the second produced the first.
    """

    STEP_ONE = 'Step 1 \u2014 list every item in the evidence that matches the question.'
    STEP_TWO = 'Step 2 \u2014 compute the answer from that list.'

    def _report(self, rows: list[tuple[str, bool, str, object, str]]) -> dict:
        """(capability, correct, rawOutput, answer, groundTruth) -> a report."""
        questions = []
        for index, (capability, correct, raw, answer, gold) in enumerate(rows):
            questions.append({
                'questionId': f'q{index}',
                'capability': capability,
                'groundTruth': gold,
                'answer': answer,
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

    def _raw(self, items: int, answer_line: str) -> str:
        lines = [self.STEP_ONE, '']
        lines += [f'- item {index}' for index in range(items)]
        lines += ['', self.STEP_TWO, '', answer_line]
        return '\n'.join(lines)

    def _run(self, tmp_path: Path, report: dict) -> 'subprocess.CompletedProcess[str]':
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), '--counted', str(path)],
            capture_output=True, text=True, check=False,
        )

    def test_it_marks_the_records_that_counted_their_own_list(self, tmp_path: Path) -> None:
        # Two items, answer 2, gold 3: it counted exactly what it listed, and the list is short.
        report = self._report([('MR', False, self._raw(2, '2'), '2', '3')])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'counted its list' in r.stdout
        # The summary has to say how many of how many, because the ratio is the finding.
        assert '1 of 1' in r.stdout

    def test_it_does_not_mark_an_answer_that_differs_from_the_list(self, tmp_path: Path) -> None:
        # Five items, answer 3: this one mis-counted, which is the other defect.
        report = self._report([('MR', False, self._raw(5, '3'), '3', '3')])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert '0 of 1' in r.stdout

    def test_it_says_by_how_much_the_answer_missed(self, tmp_path: Path) -> None:
        # The distribution matters: ten records off by exactly one is a coverage signature,
        # while a spread of differences is an arithmetic one.
        report = self._report([
            ('MR', False, self._raw(2, '2'), '2', '3'),
            ('MR', False, self._raw(4, '70 hours'), '70 hours', '140 hours'),
        ])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        # `gold - answered`, so a short count reads positive: 3-2 = +1, 140-70 = +70. The
        # sign is worth pinning because the reading rule is "the list was short", and a
        # column that read -1 would say the model over-counted.
        assert '+1' in r.stdout
        assert '+70' in r.stdout
        assert 'off by exactly one' in r.stdout

    def test_only_the_capability_asked_for_is_read(self, tmp_path: Path) -> None:
        report = self._report([
            ('MR', False, self._raw(2, '2'), '2', '3'),
            ('TR', False, self._raw(2, '2'), '2', '3'),
        ])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert '1 of 1' in r.stdout


class TestThePairedTransitionBetweenTwoRuns:
    """Two rosters, one question at a time, because a count cannot show a mechanism.

    §13.56.3 needed this and wrote it inline; §13.59.5 then needed it again. That is the
    fourth time this campaign has paid for the same script, and §13.38's rule is the reason
    it belongs here: a comparison that decides a reading has to be re-derivable.

    ## The instrument it measures

    The same comparison on questions whose **prompt did not move** is the cross-draw noise
    floor -- 6.1% of them change state between two runs (§13.56.4). Without that number the
    movement on the capability under treatment has nothing to be compared against, and a
    registered tolerance of "two questions" is unverifiable in both directions.
    """

    @staticmethod
    def _report(rows: list[tuple[str, bool, object]]) -> dict:
        questions = [
            {
                'questionId': f'q{index}',
                'capability': capability,
                'groundTruth': '3',
                'answer': answer,
                'rawOutput': answer if isinstance(answer, str) else None,
                'correct': correct,
            }
            for index, (capability, correct, answer) in enumerate(rows)
        ]
        return {
            'memoryArmConfig': {'ask': 'enumerated'},
            'baseline': {'metrics': {'accuracy': 0.4}},
            'feature': {'metrics': {'accuracy': 0.6}},
            'ablation': {'delta': 0.2, 'questions': None},
            'questions': questions,
        }

    def _run(self, tmp_path: Path, before: dict, after: dict) -> 'subprocess.CompletedProcess[str]':
        first = tmp_path / 'before.json'
        second = tmp_path / 'after.json'
        first.write_text(json.dumps(before), encoding='utf-8')
        second.write_text(json.dumps(after), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), '--paired', str(second), str(first)],
            capture_output=True, text=True, check=False,
        )

    def test_it_reports_a_decline_that_became_correct(self, tmp_path: Path) -> None:
        before = self._report([('MR', False, None)])
        after = self._report([('MR', True, '3')])
        r = self._run(tmp_path, before, after)
        assert r.returncode == 0, r.stderr
        assert 'abstention' in r.stdout
        assert 'correct' in r.stdout
        assert '1' in r.stdout

    def test_it_separates_a_decline_that_became_a_wrong_answer(self, tmp_path: Path) -> None:
        # §13.56.3's finding, in one row: the contract moved two declines into wrong answers
        # and three into correct ones, and only the transition table can say that.
        before = self._report([('MR', False, None), ('MR', False, None)])
        after = self._report([('MR', False, '2'), ('MR', True, '3')])
        r = self._run(tmp_path, before, after)
        assert r.returncode == 0, r.stderr
        assert 'numeric_mismatch' in r.stdout

    def test_it_counts_the_state_changes_so_the_noise_floor_is_computable(
        self, tmp_path: Path,
    ) -> None:
        # The number §13.56.4 uses as the instrument: how many questions changed state at all,
        # per capability, over the questions that had a state to change.
        before = self._report([('TR', True, '3'), ('TR', True, '3')])
        after = self._report([('TR', True, '3'), ('TR', False, None)])
        r = self._run(tmp_path, before, after)
        assert r.returncode == 0, r.stderr
        assert 'changed state' in r.stdout
        assert '1 of 2' in r.stdout

    def test_a_question_that_is_missing_from_one_side_is_not_a_transition(
        self, tmp_path: Path,
    ) -> None:
        # Two rosters of the same dataset must name the same questions. A missing id is a
        # defect in one of the reports, and counting it as a change would inflate the noise
        # floor in the direction that hides a real effect.
        before = self._report([('MR', True, '3'), ('MR', True, '3')])
        after = self._report([('MR', True, '3')])
        r = self._run(tmp_path, before, after)
        assert r.returncode == 2
        assert 'missing' in r.stderr.lower()


class TestThePoolPartition:
    """Where the gold went, in three numbers, per capability.

    §13.62 registered that the loss is in the order rather than the ranking's reach. That
    claim is readable only as the difference between two sums, and it decides the next
    variable -- so it is a mode of this tool rather than an inline subtraction, for the
    reason §13.38 gives and which this campaign has now paid for five times.
    """

    @staticmethod
    def _report(rows: list[tuple[str, int, int, int | None]]) -> dict:
        """(capability, total, carried, pool) -> a report whose records carry coverage."""
        questions = []
        for index, (capability, total, carried, pool) in enumerate(rows):
            overlap: dict[str, int] = {'carried': carried, 'total': total}
            if pool is not None:
                overlap['pool'] = pool
            questions.append({
                'questionId': f'q{index}',
                'capability': capability,
                'groundTruth': 'x',
                'answer': None,
                'rawOutput': None,
                'correct': False,
                'goldOverlap': overlap,
            })
        return {
            'memoryArmConfig': {'ask': 'enumerated'},
            'baseline': {'metrics': {'accuracy': 0.4}},
            'feature': {'metrics': {'accuracy': 0.6}},
            'ablation': {'delta': 0.2, 'questions': None},
            'questions': questions,
        }

    @staticmethod
    def _run(tmp_path: Path, report: dict) -> 'subprocess.CompletedProcess[str]':
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), '--pool', str(path)],
            capture_output=True, text=True, check=False,
        )

    def test_it_splits_the_gold_set_into_three_sums(self, tmp_path: Path) -> None:
        # total 10, pool 7, carried 4 -> never surfaced 3, cut by the budget 3, delivered 4.
        report = self._report([('MR', 10, 4, 7)])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'never surfaced' in r.stdout
        assert 'cut by the budget' in r.stdout
        assert 'delivered' in r.stdout

    def test_it_reports_the_two_lost_sums_separately_per_capability(self, tmp_path: Path) -> None:
        # The comparison prediction 3 makes, stated as the tool states it: two sums, one row.
        report = self._report([
            ('MR', 24, 13, 22),   # never surfaced 2, cut 9
            ('TR', 10, 4, 6),     # never surfaced 4, cut 2
        ])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'MR' in r.stdout and 'TR' in r.stdout

    def test_a_record_without_a_pool_is_counted_as_unmeasured(self, tmp_path: Path) -> None:
        # An artifact produced before the pool existed, or by a run with no ranking, has no
        # `pool` and must not be summed as zero -- that would report a ranking that surfaced
        # nothing where no ranking ran.
        report = self._report([('MR', 10, 4, None), ('MR', 10, 5, 6)])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'without a pool' in r.stdout

    def test_an_artifact_with_no_pool_at_all_refuses(self, tmp_path: Path) -> None:
        report = self._report([('MR', 10, 4, None)])
        r = self._run(tmp_path, report)
        assert r.returncode == 2
        assert 'pool' in r.stderr

    def test_an_impossible_partition_is_reported_not_hidden(self, tmp_path: Path) -> None:
        # `pool > total` cannot happen -- the ranking cannot surface more gold than the dataset
        # names -- so a record showing it is a caller defect, and the table says so rather than
        # clamping. This fixture used to be `carried > pool`, which §13.72 showed is a legitimate
        # state once the window is wider than the pool; that case now has its own class and its
        # own column, and keeping it here would have preserved a belief the run falsified.
        report = self._report([('MR', 10, 8, 12)])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'pool > total' in r.stdout


class TestTheTurnLengthDistribution:
    """What the character budget is spent on, which §13.67 found was a long tail.

    The roster holds a median of 26 turns in a 24,000-character room while the delivered
    turns have a **median of 272 characters**. Twenty-six median turns are 7,072 characters,
    so the room is not being spent on turns of typical size -- it is being spent on a tail,
    and capping a turn's contribution would fit two to four times as many.

    A claim about a distribution is worth a table, and this one decides the next variable.
    """

    @staticmethod
    def _report(lengths: list[int]) -> dict:
        questions = [{
            'questionId': 'q1',
            'capability': 'MR',
            'groundTruth': 'x',
            'answer': None,
            'rawOutput': None,
            'correct': False,
            'turns': [{'index': i, 'text': 'x' * length} for i, length in enumerate(lengths)],
        }]
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
            [sys.executable, str(TOOL), '--turns', str(path)],
            capture_output=True, text=True, check=False,
        )

    def test_it_reports_the_median_and_the_tail(self, tmp_path: Path) -> None:
        report = self._report([100, 100, 100, 10000])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'median' in r.stdout
        assert '4' in r.stdout  # turn count

    def test_it_says_how_many_more_turns_a_cap_would_fit(self, tmp_path: Path) -> None:
        # The number the decision needs: one row per candidate cap.
        report = self._report([100, 400, 4000])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'cap' in r.stdout
        assert '400' in r.stdout

    def test_a_roster_without_turns_refuses(self, tmp_path: Path) -> None:
        report = self._report([])
        r = self._run(tmp_path, report)
        assert r.returncode == 2
        assert 'turn' in r.stderr


class TestHowMuchTheWindowActuallyHeld:
    """The instrument §13.68's variable is read with, beside coverage.

    A cap can raise coverage for a reason the coverage number cannot name: the room holds more
    turns, so the gold turn that used to be cut now arrives. Or it can raise nothing, because
    the roster already fitted and the cap only shortened turns that were not the constraint.

    Those two are distinguished by one table -- turns carried, prompt characters, and the share
    of the budget spent -- and this run is the first where the arm's own artifact can produce
    it. `promptChars` was recorded from §13.11 onward for a different question (how much of the
    budget a prompt used); the count beside it is what turns it into a window measurement.
    """

    @staticmethod
    def _report(rows: list[tuple[str, int, int]]) -> dict:
        """(capability, carriedTurns, promptChars) -> a report with one question per row."""
        questions = [
            {
                'questionId': f'q{index}',
                'capability': capability,
                'groundTruth': 'x',
                'answer': None,
                'rawOutput': None,
                'correct': False,
                'turns': [{'index': i, 'text': 'x' * 100} for i in range(carried)],
                'promptChars': chars,
            }
            for index, (capability, carried, chars) in enumerate(rows)
        ]
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
            [sys.executable, str(TOOL), '--window', str(path)],
            capture_output=True, text=True, check=False,
        )

    def test_it_reports_turns_carried_beside_the_characters_they_spent(self, tmp_path: Path) -> None:
        report = self._report([('MR', 26, 21_000), ('MR', 30, 23_000)])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'turns' in r.stdout
        # The median of 26 and 30, and the median of the two character counts -- a table that
        # reported means would be answering a different question about a skewed distribution.
        assert '28' in r.stdout

    def test_it_reports_the_share_of_the_budget_the_prompt_used(self, tmp_path: Path) -> None:
        # The number that says whether the room was the constraint: 21,000 of 24,000 is 87.5%.
        report = self._report([('MR', 26, 21_000)])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert '87.5%' in r.stdout

    def test_a_record_without_prompt_chars_is_counted_as_unmeasured(self, tmp_path: Path) -> None:
        # An artifact produced before the field existed, or by a route that does not assemble a
        # prompt, must not be summed as zero: a 0% fill would read as an empty prompt.
        report = self._report([('MR', 26, 21_000)])
        del report['questions'][0]['promptChars']
        r = self._run(tmp_path, report)
        assert r.returncode == 2
        assert 'promptChars' in r.stderr

    def test_the_budget_is_read_from_the_artifact_not_from_a_constant(
        self, tmp_path: Path
    ) -> None:
        """§13.81 raised the budget to 48,000 and this table kept dividing by 24,000.

        The fill share is the mechanism reading of the whole experiment -- `--coverage` says
        whether more gold arrived, this says whether the room grew -- and a hardcoded divisor
        would have printed **200% of budget** on the first run that spent it, which reads as an
        allocator overflowing rather than as a reader that did not read the configuration. The
        table must take the divisor from the run it is describing.
        """
        report = self._report([('MR', 120, 48_000)])
        report['memoryArmConfig']['maxPromptChars'] = 48_000
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert '100.0%' in r.stdout
        assert '200.0%' not in r.stdout
        assert '48,000' in r.stdout

    def test_an_artifact_that_never_named_the_budget_reads_the_default(
        self, tmp_path: Path
    ) -> None:
        """Absent means 24,000, which is what every archived artifact was produced under.

        Absent is not "unknown": `DEFAULT_MAX_PROMPT_CHARS` is a value, the arm omits the field
        only when it was not set, and every pre-§13.81 run therefore assembled at 24,000. The
        table says which divisor it used so a historical artifact stays readable.
        """
        report = self._report([('MR', 30, 24_000)])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert '100.0%' in r.stdout
        assert '24,000' in r.stdout
        assert 'default' in r.stdout

    def test_a_prompt_that_spent_more_than_the_budget_names_the_disagreement(
        self, tmp_path: Path
    ) -> None:
        """The detector for this tool's own defect class, stated as a measurement.

        `promptChars` is the evidence the prompt **carried**, after the budget cut, so it
        cannot exceed the budget the run assembled under. A fill above 100% therefore means the
        divisor is not the run's budget -- the reader's assumption disagreed with the artifact
        -- or the producer reported the offer instead of the delivery. Both are defects, and
        the second is the §13.11 collapse; the table names the state rather than printing a
        percentage over 100 as if it were a measurement.
        """
        report = self._report([('MR', 30, 36_000)])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert '150.0%' in r.stdout
        assert 'over budget' in r.stdout.lower()

    def test_a_zero_budget_is_refused_rather_than_dividing_by_zero(
        self, tmp_path: Path
    ) -> None:
        """The arm rejects 0 at dispatch (§13.80 lost a run to a stale value), so a 0 here is a
        corrupt artifact. Reporting an infinite fill would describe a prompt that carried
        evidence in a zero-character room, which is not a state any run can reach."""
        report = self._report([('MR', 30, 24_000)])
        report['memoryArmConfig']['maxPromptChars'] = 0
        r = self._run(tmp_path, report)
        assert r.returncode == 2
        assert 'maxPromptChars' in r.stderr


class TestTheRoleComposition:
    """Which role the evidence room is made of, measured in characters.

    §13.82 is why this table exists: on the 48,000-character run the multi-session route spent
    **51.9% of its rendered characters on assistant turns**, and the reference pipeline reaches
    85.95% on that capability at half the budget by restricting retrieval to user turns. §13.83
    registers that filter, and its first prediction is a mechanism claim -- the user share rises
    above 95% -- which nothing in the artifact states directly. This reads it.

    Two properties are the reason it is a tool rather than a one-off script:

    - **the cap comes from the artifact.** `promptChars` is post-cap and the turn texts are not,
      so a share computed from raw text would describe a prompt nobody sent. The divisor and the
      cap are both read from `memoryArmConfig` for §13.81.5's reason.
    - **an unreadable role is its own column.** Folding it into either role would let a
      classifier bug read as a composition measurement -- the same defect as a filter that drops
      the turn it cannot classify.
    """

    @staticmethod
    def _report(rows: list[tuple[str, str, int]], **config: object) -> dict:
        """(capability, role, characters) -> a report whose turns carry role prefixes."""
        questions = []
        for index, (capability, role, chars) in enumerate(rows):
            # Padded to an exact total, prefix included: the assertion is about a share of
            # characters, and a prefix that silently adds 31 to one side would make every
            # expected percentage wrong by a few points while still looking plausible.
            prefix = f'[2023/02/15 (Wed) 03:14] {role}: '
            text = prefix + 'x' * max(0, chars - len(prefix))
            questions.append({
                'questionId': f'q{index}',
                'capability': capability,
                'groundTruth': 'x',
                'answer': 'x',
                'correct': False,
                'turns': [{'index': 0, 'text': text}],
            })
        return {
            'memoryArmConfig': {'ask': 'enumerated', **config},
            'baseline': {'metrics': {'accuracy': 0.4}},
            'feature': {'metrics': {'accuracy': 0.6}},
            'ablation': {'delta': 0.2},
            'questions': questions,
        }

    def _run(self, tmp_path: Path, report: dict) -> 'subprocess.CompletedProcess[str]':
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), '--roles', str(path)],
            capture_output=True, text=True, check=False,
        )

    def test_it_splits_the_room_by_role(self, tmp_path: Path) -> None:
        report = self._report([('MR', 'user', 300), ('MR', 'assistant', 100)])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert '75.0%' in r.stdout
        assert '25.0%' in r.stdout

    def test_it_applies_the_cap_the_run_was_configured_with(self, tmp_path: Path) -> None:
        # A 1,000-character assistant turn under a 400-character cap contributes 400, not 1,000:
        # the share is a property of the prompt, and the prompt was capped.
        report = self._report(
            [('MR', 'user', 400), ('MR', 'assistant', 1_000)],
            maxTurnChars=400,
            maxTurnCharsRoutes=['multi-session', 'temporal'],
        )
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert '50.0%' in r.stdout

    def test_a_cap_that_does_not_reach_the_route_is_not_applied(self, tmp_path: Path) -> None:
        # The reach is part of the configuration, so a reader that applied the cap everywhere
        # would recompute a prompt for a route the run never capped.
        report = self._report(
            [('MR', 'user', 400), ('MR', 'assistant', 1_000)],
            maxTurnChars=400,
            maxTurnCharsRoutes=['temporal'],
        )
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert '28.6%' in r.stdout

    def test_an_unreadable_role_is_its_own_column(self, tmp_path: Path) -> None:
        # `tool:` is not a role this reader knows. Summing it into assistant would report a
        # composition the artifact does not support.
        report = self._report([('MR', 'user', 100), ('MR', 'tool', 100)])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'unreadable' in r.stdout.lower()
        assert '50.0%' in r.stdout

    def test_a_report_with_no_turns_refuses(self, tmp_path: Path) -> None:
        report = self._report([])
        r = self._run(tmp_path, report)
        assert r.returncode == 2
        assert 'turns' in r.stderr


class TestTheCoverageTableUnderARoleFilter:
    """The band table reads `total`, so it inherits whatever denominator the record carries.

    §13.84's run had gold in an excluded role counted in `total`, and its MR bands read 63.9% at
    0-50% "coverage" while every question sat below 75%. A reader needs to know which denominator
    the bands were computed against before comparing them to another run's.
    """

    @staticmethod
    def _report(total_all: int | None) -> dict:
        overlap = {'carried': 1, 'total': 2}
        if total_all is not None:
            overlap['totalAll'] = total_all
        return {
            'memoryArmConfig': {'ask': 'enumerated', 'evidenceRoles': ['user']},
            'baseline': {'metrics': {'accuracy': 0.4}},
            'feature': {'metrics': {'accuracy': 0.6}},
            'ablation': {'delta': 0.2},
            'questions': [
                {
                    'questionId': 'q1',
                    'capability': 'MR',
                    'groundTruth': 'x',
                    'answer': 'x',
                    'correct': True,
                    'goldOverlap': overlap,
                }
            ],
        }

    def _run(self, tmp_path: Path, report: dict) -> 'subprocess.CompletedProcess[str]':
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), '--coverage', str(path)],
            capture_output=True, text=True, check=False,
        )

    def test_it_names_a_policy_denominator(self, tmp_path: Path) -> None:
        r = self._run(tmp_path, self._report(4))
        assert r.returncode == 0, r.stderr
        assert 'denominator' in r.stdout
        assert 'totalAll' in r.stdout

    def test_it_says_nothing_when_the_denominator_is_the_dataset(self, tmp_path: Path) -> None:
        r = self._run(tmp_path, self._report(None))
        assert r.returncode == 0, r.stderr
        assert 'denominator' not in r.stdout


class TestThePerCapabilitySpread:
    """The one table that can say whether a capability moved, and by how much of its own noise.

    §13.87's replication changed nothing and moved MR from 90 to 83. The artifact had the spread all
    along -- `featureAggregate` over four repetitions -- but every per-capability count was one
    pass's. `--caps` reads the field §13.88 added, and refuses on an artifact that cannot answer
    rather than printing a single pass and calling it a capability's number.
    """

    @staticmethod
    def _report(spreads: dict | None, totals: dict | None) -> dict:
        ablation = {'delta': 0.2, 'mcnemarPValue': 1e-9}
        if spreads is not None:
            ablation['featureByCapability'] = spreads
        if totals is not None:
            ablation['questionsByCapability'] = totals
        return {
            'memoryArmConfig': {'ask': 'enumerated'},
            'baseline': {'metrics': {'accuracy': 0.4}},
            'feature': {'metrics': {'accuracy': 0.6}},
            'ablation': ablation,
            'questions': [
                {
                    'questionId': 'q1',
                    'capability': 'MR',
                    'groundTruth': 'x',
                    'answer': 'x',
                    'correct': True,
                }
            ],
        }

    def _run(self, tmp_path: Path, report: dict) -> 'subprocess.CompletedProcess[str]':
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), '--caps', str(path)],
            capture_output=True, text=True, check=False,
        )

    def test_it_prints_min_mechanics_mean_and_max_beside_the_denominator(self, tmp_path: Path) -> None:
        report = self._report(
            {'MR': {'min': 83, 'avg': 90.5, 'max': 95}, 'TR': {'min': 95, 'avg': 97, 'max': 98}},
            {'MR': 121, 'TR': 127},
        )
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert '90.5' in r.stdout
        assert '74.8%' in r.stdout  # 90.5 / 121
        assert 'TOTAL' in r.stdout
        assert 'MEAN' in r.stdout

    def test_it_refuses_when_the_artifact_cannot_answer(self, tmp_path: Path) -> None:
        # A single-repetition run omits the field by design; printing the roster's count as if it
        # were the capability's number is the defect that produced two false findings.
        r = self._run(tmp_path, self._report(None, None))
        assert r.returncode == 2
        assert 'one repetition' in r.stderr

    def test_a_half_written_field_refuses_rather_than_guessing(self, tmp_path: Path) -> None:
        # Spreads without denominators cannot be turned into a rate, and a zero denominator would
        # divide by zero. Both are artifacts that cannot answer.
        r = self._run(tmp_path, self._report({'MR': {'min': 1, 'avg': 1, 'max': 1}}, None))
        assert r.returncode == 2


class TestWhatTheCorrectAnswersEndWith:
    """The check that separates a ledger from a transcript, on golds that are numbers.

    §13.92's sweep produced 44-line transcripts as answers and the judge accepted 42 of MR's 60
    correct ones. Auditing only quantity questions -- where `2` against `3` cannot be a paraphrase --
    the same run ends **4 of its 22** correct answers on a different number than the gold, against
    **1 of 31** in the adopted configuration. The check exists because the accuracy column cannot
    show the difference between an answer and a transcript that contains one.
    """

    @staticmethod
    def _report(rows: list[tuple[str, str, str, bool, str]]) -> dict:
        return {
            'memoryArmConfig': {'ask': 'enumerated'},
            'baseline': {'metrics': {'accuracy': 0.4}},
            'feature': {'metrics': {'accuracy': 0.6}},
            'ablation': {'delta': 0.2},
            'questions': [
                {
                    'questionId': qid,
                    'capability': cap,
                    'groundTruth': gold,
                    'answer': 'x',
                    'correct': correct,
                    'rawOutput': raw,
                }
                for qid, cap, gold, correct, raw in rows
            ],
        }

    def _run(self, tmp_path: Path, report: dict) -> 'subprocess.CompletedProcess[str]':
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), '--final', str(path)],
            capture_output=True, text=True, check=False,
        )

    def test_it_counts_and_names_the_disagreements(self, tmp_path: Path) -> None:
        report = self._report(
            [
                ('good', 'MR', '3', True, 'Step 1\n- a\n- b\n- c\nStep 2 — 3'),
                ('bad', 'MR', '3', True, 'Session 1: none\nSession 2: boots\n\n2'),
            ]
        )
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert re.search(r'MR\s+2\s+1\s+1', r.stdout)
        assert 'bad' in r.stdout

    def test_a_prose_closing_line_that_states_the_number_agrees(self, tmp_path: Path) -> None:
        # `The total is 5 days.` states 5. A rule that demanded a *leading* number reported all eight
        # of TR's answers as disagreements on the first draft of this table.
        report = self._report([('prose', 'TR', '5', True, 'Step 1\n- a\nThe total is 5 days.')])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert re.search(r'TR\s+1\s+1\s+0', r.stdout)

    def test_a_prose_gold_is_not_audited(self, tmp_path: Path) -> None:
        # `a yellow dress` against `Yellow dress and a pair of earrings` is a paraphrase, and string
        # comparison cannot decide it. Including those rows produced 124 "disagreements" on the first
        # draft, most of them paraphrases and 29 of them abstentions.
        report = self._report([('prose-gold', 'IE', 'a yellow dress', True, 'Step 1\n- x\nYellow dress')])
        r = self._run(tmp_path, report)
        assert r.returncode == 2
        assert 'no correct record' in r.stderr


class TestWhereTheGoldNumbersAre:
    """Retrieval or reader: the one split that decides which axis can fix a wrong answer.

    For each wrong MR answer whose gold states a number, the table asks whether those digits appear
    anywhere in the turns the prompt carried. Absent is exact -- a digit string that appears nowhere
    was not read -- and present is an upper bound, because a substring test cannot tell a payment from
    a date. The first reading of run `39367801501` put 24 of 31 present and 7 absent.
    """

    @staticmethod
    def _report(turns: str, gold: str, stated: str, correct: bool = False) -> dict:
        return {
            'memoryArmConfig': {'ask': 'enumerated'},
            'baseline': {'metrics': {'accuracy': 0.4}},
            'feature': {'metrics': {'accuracy': 0.6}},
            'ablation': {'delta': 0.2},
            'questions': [
                {
                    'questionId': 'q1',
                    'capability': 'MR',
                    'groundTruth': gold,
                    'answer': stated,
                    'correct': correct,
                    'rawOutput': 'Step 1\n- x\nStep 2 — 1',
                    'turns': [{'index': 0, 'text': turns}],
                }
            ],
        }

    def _run(self, tmp_path: Path, report: dict) -> 'subprocess.CompletedProcess[str]':
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), '--numbers', str(path)],
            capture_output=True, text=True, check=False,
        )

    def test_it_finds_a_number_that_reached_the_window(self, tmp_path: Path) -> None:
        r = self._run(tmp_path, self._report('I paid $720 for the course.', '$720', '700'))
        assert r.returncode == 0, r.stderr
        assert 'in the window 1   absent 0' in r.stdout

    def test_it_reports_a_number_that_did_not(self, tmp_path: Path) -> None:
        r = self._run(tmp_path, self._report('I paid $720 for the course.', '$495', '375'))
        assert r.returncode == 0, r.stderr
        assert 'in the window 0   absent 1' in r.stdout
        assert '495' in r.stdout

    def test_a_decimal_keeps_its_leading_zero(self, tmp_path: Path) -> None:
        # Normalising the whole string with `lstrip('0')` turns `0.5` into `.5`, which then fails to
        # match the `0.5` the evidence states and reports a delivered number as absent. That is the
        # defect the first reading of run 39367801501 hit on two records.
        r = self._run(tmp_path, self._report('I jogged 0.5 hours.', '0.5 hours', '30 minutes'))
        assert r.returncode == 0, r.stderr
        assert 'in the window 1   absent 0' in r.stdout

    def test_a_thousands_separator_is_not_a_different_number(self, tmp_path: Path) -> None:
        # The dataset writes `1,998` in the gold and `1998` in the turn, or the reverse. Treating the
        # comma as part of the number would report a delivery that happened as a retrieval failure.
        r = self._run(tmp_path, self._report('The bill was 1998 dollars.', '1,998', '2000'))
        assert r.returncode == 0, r.stderr
        assert 'in the window 1   absent 0' in r.stdout

    def test_a_correct_answer_is_not_in_the_table(self, tmp_path: Path) -> None:
        r = self._run(tmp_path, self._report('I paid $720.', '$720', '$720', correct=True))
        assert r.returncode == 2
        assert 'no wrong MR record' in r.stderr


class TestTheCountingQuestions:
    """The subset where a list's length can be compared with the gold *number*.

    §13.92's premise had to be corrected once for not making this distinction: of sixteen wrong
    numeric MR answers twelve had a shorter list, but six of those twelve were questions whose gold is
    23, 50, 100 or 856 — amounts and durations, where a two-item list is not an under-enumeration.
    Restricted to counts from 2 to 10 the same artifact gives six of ten. A table that does not
    restrict itself keeps producing the first number, and the first number is wrong.
    """

    @staticmethod
    def _report(ask: str, rows: list[tuple[str, str, str, bool, str]]) -> dict:
        questions = [
            {
                'questionId': qid,
                'capability': 'MR',
                'groundTruth': gold,
                'answer': stated,
                'correct': correct,
                'rawOutput': raw,
            }
            for qid, gold, stated, correct, raw in rows
        ]
        return {
            'memoryArmConfig': {'ask': ask},
            'baseline': {'metrics': {'accuracy': 0.4}},
            'feature': {'metrics': {'accuracy': 0.6}},
            'ablation': {'delta': 0.2},
            'questions': questions,
        }

    def _run(self, tmp_path: Path, report: dict) -> 'subprocess.CompletedProcess[str]':
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), '--counting', str(path)],
            capture_output=True, text=True, check=False,
        )

    def test_it_keeps_counts_and_drops_amounts(self, tmp_path: Path) -> None:
        report = self._report(
            'enumerated',
            [
                ('count-under', '3', '1', False, 'Step 1\n- one item\n- same item again\nStep 2 — 1'),
                ('count-right', '2', '2', True, 'Step 1\n- a\n- b\nStep 2 — 2'),
                # A gold of 856 is a balance. Two bullets is not an under-enumeration, and counting
                # it as one is what made the earlier premise wrong.
                ('amount', '856', '900', False, 'Step 1\n- a\n- b\nStep 2 — 900'),
            ],
        )
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'correct     1' in r.stdout
        assert 'wrong       1' in r.stdout
        assert 'list shorter   1' in r.stdout
        assert 'under-lists' in r.stdout
        # The amount question is dropped rather than counted as an under-enumeration, and the table
        # names the ids a registration can refer to.
        assert 'amount' not in r.stdout
        assert 'count-under' in r.stdout

    def test_it_reads_the_session_shape_of_a_sweep_response(self, tmp_path: Path) -> None:
        # One reader for both asks, because §13.92's second prediction compares them on this axis.
        raw = 'Step 1\nSession 1: a kit\nSession 2: none\nSession 3: another kit\nStep 2 — 2'
        report = self._report('sweep', [('sweep-1', '3', '2', False, raw)])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert "shape read: session lines (ask='sweep')" in r.stdout
        # Two item-bearing lines against a gold of 3 -- under-listed, and the `none` line is not an
        # item.
        assert 'list shorter   1' in r.stdout

    def test_it_flags_arithmetic_when_the_list_is_the_right_length(self, tmp_path: Path) -> None:
        report = self._report(
            'enumerated',
            [('arith', '3', '2', False, 'Step 1\n- a\n- b\n- c\nStep 2 — 2')],
        )
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'counts right' in r.stdout

    def test_it_refuses_when_no_question_carries_a_count(self, tmp_path: Path) -> None:
        report = self._report('enumerated', [('amount', '856', '900', False, '- a\n- b')])
        r = self._run(tmp_path, report)
        assert r.returncode == 2
        assert 'count' in r.stderr


class TestTheSweepCensus:
    """What a `sweep` response's session lines hold, which is the mechanism §13.92 registers.

    The reading that put this ask on the table: `--lists` on run `39367801501` gives a median Step 1
    list of **2.0 items** for right and wrong answers alike, over windows carrying ~174 turns in
    about thirty sessions. A sweep response writes a line per session instead of a list of whatever
    it noticed, so the mechanism is visible as a count -- and before the treatment that count is
    zero, which is why this mode refuses to read an artifact that did not run it.
    """

    @staticmethod
    def _report(
        ask: str,
        responses: list[str],
        golds: list[str] | None = None,
        answers: list[str] | None = None,
    ) -> dict:
        golds = golds or ['3'] * len(responses)
        answers = answers or ['3'] * len(responses)
        questions = [
            {
                'questionId': f'q{index}',
                'capability': 'MR',
                'groundTruth': gold,
                'answer': answer,
                'correct': False,
                'rawOutput': raw,
            }
            for index, (raw, gold, answer) in enumerate(zip(responses, golds, answers))
        ]
        return {
            'memoryArmConfig': {'ask': ask},
            'baseline': {'metrics': {'accuracy': 0.4}},
            'feature': {'metrics': {'accuracy': 0.6}},
            'ablation': {'delta': 0.2},
            'questions': questions,
        }

    def _run(self, tmp_path: Path, report: dict) -> 'subprocess.CompletedProcess[str]':
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), '--sweep', str(path)],
            capture_output=True, text=True, check=False,
        )

    def test_it_counts_the_session_lines_and_the_items_they_name(self, tmp_path: Path) -> None:
        raw = (
            'Step 1 — one line per session.\n'
            'Session 1: a Spitfire kit, stated 2023/02/15\n'
            'Session 2: none\n'
            'Session 3: a Mustang kit, stated 2023/02/16\n'
            'Step 2 — 2'
        )
        r = self._run(tmp_path, self._report('sweep', [raw]))
        assert r.returncode == 0, r.stderr
        # Three session lines, two of which name something: the `none` line is a session the reader
        # looked at, so it counts as a line and not as an item.
        assert 'median session lines 3.0' in r.stdout
        assert 'median item lines 2.0' in r.stdout
        assert 'records with none: 0' in r.stdout

    def test_a_response_that_ignored_the_shape_is_counted_not_smoothed(self, tmp_path: Path) -> None:
        # The ask can reach the prompt and the response can ignore it. Folding those records into
        # the median would report a scan that did not happen.
        report = self._report('sweep', ['Step 1 — I found two kits.\nStep 2 — 2'])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'records with none: 1' in r.stdout
        assert 'ignored its shape' in r.stdout

    def test_it_flags_a_count_that_matches_its_own_lines(self, tmp_path: Path) -> None:
        raw = 'Session 1: a kit\nSession 2: another kit\nStep 2 — 2'
        r = self._run(tmp_path, self._report('sweep', [raw], answers=['2']))
        assert r.returncode == 0, r.stderr
        assert 'counts its item lines' in r.stdout

    def test_it_refuses_an_artifact_that_did_not_run_the_ask(self, tmp_path: Path) -> None:
        # Reading `enumerated` responses with this table would report a median of zero session lines
        # and look like the treatment failed to reach the prompt, which is a different defect.
        r = self._run(tmp_path, self._report('enumerated', ['Step 1 — two kits\nStep 2 — 2']))
        assert r.returncode == 2
        assert "'enumerated'" in r.stderr
        assert '--lists' in r.stderr


class TestThePoolTableUnderARoleFilter:
    """`--pool` is exhaustive only when every turn could reach the prompt.

    §13.82's run is the first with a role filter, and its pool table read as a budget disaster:
    MR's "cut by the budget" rose from 301 to 1,710 gold turns while the budget spent the same
    48,000 characters. None of that increase was the budget -- it was gold in the excluded role,
    which `pool - carried` cannot tell apart from gold the room refused.
    """

    @staticmethod
    def _report(roles: list[str] | None) -> dict:
        question = {
            'questionId': 'q1',
            'capability': 'MR',
            'groundTruth': 'x',
            'answer': None,
            'rawOutput': None,
            'correct': False,
            'goldOverlap': {'carried': 3, 'total': 10, 'pool': 8, 'goldRanks': [0, 1, 2, -1, -1]},
        }
        return {
            'memoryArmConfig': {'ask': 'enumerated', **({} if roles is None else {'evidenceRoles': roles})},
            'baseline': {'metrics': {'accuracy': 0.4}},
            'feature': {'metrics': {'accuracy': 0.6}},
            'ablation': {'delta': 0.2},
            'questions': [question],
        }

    def _run(self, tmp_path: Path, report: dict) -> 'subprocess.CompletedProcess[str]':
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), '--pool', str(path)],
            capture_output=True, text=True, check=False,
        )

    def test_it_says_the_column_mixes_policy_with_budget(self, tmp_path: Path) -> None:
        r = self._run(tmp_path, self._report(['user']))
        assert r.returncode == 0, r.stderr
        assert 'NOTE' in r.stdout
        assert 'user' in r.stdout
        assert 'NOT a budget reading' in r.stdout

    def test_a_policy_denominator_replaces_the_mixing_warning(self, tmp_path: Path) -> None:
        # §13.85 made the denominator follow the policy, so on an artifact made after it the
        # partition IS exhaustive over the gold the policy admits and the old warning would be a
        # false alarm. The two states are distinguished by `totalAll`, which only exists when the
        # policy actually narrowed a question's gold.
        report = self._report(['user'])
        report['questions'][0]['goldOverlap']['totalAll'] = 10
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'totalAll' in r.stdout
        assert 'NOT a budget reading' not in r.stdout

    def test_an_unfiltered_run_says_nothing_about_policy(self, tmp_path: Path) -> None:
        # The note must be a fact about the artifact, not boilerplate: a run that admitted every
        # turn has an exhaustive partition and the reader should be able to trust the column.
        r = self._run(tmp_path, self._report(None))
        assert r.returncode == 0, r.stderr
        assert 'NOTE' not in r.stdout


class TestWhenTheRoomIsWiderThanThePool:
    """The regime §13.68 created and §13.72's run was the first to enter.

    `--pool` was written when the window held ~26 turns against a 64-wide pool, so every delivered
    turn was a candidate and `carried > pool` could only be a caller defect. A 400-character cap
    fits ~68 turns, which is **more than the pool is wide**, so the selection continues past the
    pool into turns the ranking never scored. The artifact then honestly records
    `carried > pool`, and the tool called it a violation.

    It is not a violation, it is a different regime, and the two need different words: below the
    pool width, `pool - carried` is gold the budget refused; above it, `carried - pool` is gold the
    room reached that the ranking never offered. Reporting the second as a negative first would
    describe a budget cut that ran backwards.
    """

    @staticmethod
    def _report(rows: list[tuple[str, int, int, int]]) -> dict:
        questions = []
        for index, (capability, total, carried, pool) in enumerate(rows):
            questions.append({
                'questionId': f'q{index}',
                'capability': capability,
                'groundTruth': 'x',
                'answer': None,
                'rawOutput': None,
                'correct': False,
                'goldOverlap': {'carried': carried, 'total': total, 'pool': pool,
                                'goldRanks': [-1] * total},
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
            [sys.executable, str(TOOL), '--pool', str(path)],
            capture_output=True, text=True, check=False,
        )

    def test_a_delivery_wider_than_the_pool_is_reported_as_beyond_it(self, tmp_path: Path) -> None:
        # 10 gold, 7 surfaced, 9 delivered: two gold turns arrived that the ranking never offered.
        report = self._report([('MR', 10, 9, 7)])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'arrived from outside the pool' in r.stdout
        # And the cut column must not be negative, because a negative cut is not a quantity.
        assert '-2' not in r.stdout

    def test_below_the_pool_width_the_note_is_absent(self, tmp_path: Path) -> None:
        # The regime every run before §13.72 was in. The column exists in the header either way --
        # it is one table -- so what has to be absent is the *note*, which is what a reader uses to
        # know the window overflowed the pool.
        report = self._report([('MR', 10, 4, 7)])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'cut by the budget' in r.stdout
        assert 'arrived from outside the pool' not in r.stdout

    def test_only_a_pool_wider_than_the_gold_is_a_defect(self, tmp_path: Path) -> None:
        # `pool > total` cannot happen: the ranking cannot surface more gold than the dataset
        # names. That is a caller defect and stays one; `carried > pool` is not.
        report = self._report([('MR', 5, 4, 9)])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'pool > total' in r.stdout


class TestWhatTheStepOneListHeld:
    """The measurement that moved MR's next variable from "arithmetic" to "the list".

    §13.76.6 named MR's arithmetic as the next variable, reading the taxonomy —
    `numeric_mismatch 33` of 45 wrong answers. This table says that is the wrong name. The lists
    are 1–6 items deep while the window holds 60–79 turns, and the model's stated number is
    usually **not** its list length: it sums or aggregates a **short** list correctly.

    ## Why the truncation column exists

    The 400-character cap cuts four turns in ten, so "the missing item was cut away" is the first
    competing explanation and it has to be priced before anything else. It comes out *flat*
    (correct 40.8%, mismatch 38.8% of turns truncated), which is what removes it.

    A table that reported only list lengths would leave that explanation standing.
    """

    STEP_ONE = 'Step 1 \\u2014 list every item'
    STEP_TWO = 'Step 2 \\u2014 compute'

    @staticmethod
    def _report(rows: list[tuple[str, bool, str, str, str, list[int]]]) -> dict:
        """(capability, correct, rawOutput, answer, groundTruth, turnLengths) -> a report."""
        questions = []
        for index, (capability, correct, raw, answer, gold, lengths) in enumerate(rows):
            questions.append({
                'questionId': f'q{index}',
                'capability': capability,
                'groundTruth': gold,
                'answer': answer,
                'rawOutput': raw,
                'correct': correct,
                'turns': [{'index': i, 'text': 'x' * length} for i, length in enumerate(lengths)],
                'goldOverlap': {'carried': 1, 'total': 2},
            })
        return {
            'memoryArmConfig': {'ask': 'enumerated', 'maxTurnChars': 400},
            'baseline': {'metrics': {'accuracy': 0.4}},
            'feature': {'metrics': {'accuracy': 0.6}},
            'ablation': {'delta': 0.2, 'questions': None},
            'questions': questions,
        }

    def _run(self, tmp_path: Path, report: dict) -> 'subprocess.CompletedProcess[str]':
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), '--lists', str(path)],
            capture_output=True, text=True, check=False,
        )

    def _raw(self, items: int, statement: str) -> str:
        lines = [self.STEP_ONE, '']
        lines += [f'- item {index}' for index in range(items)]
        lines += ['', self.STEP_TWO, '', statement]
        return '\\n'.join(lines)

    def test_it_reports_the_list_length_beside_the_gold(self, tmp_path: Path) -> None:
        report = self._report([('MR', False, self._raw(2, '2'), '2', '3', [100, 100])])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'list' in r.stdout and 'gold' in r.stdout
        # The row has to carry both numbers, because the finding is their difference.
        assert '2' in r.stdout and '3' in r.stdout

    def test_it_separates_a_list_that_matches_the_statement_from_one_that_does_not(
        self, tmp_path: Path,
    ) -> None:
        # The distinction §13.59 turned on: a stated number equal to the list length is a faithful
        # count of a short list; anything else is an aggregation, which needs a different repair.
        report = self._report([
            ('MR', False, self._raw(2, '2'), '2', '3', [100]),
            ('MR', False, self._raw(4, '70 hours'), '70 hours', '140 hours', [100]),
        ])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'counts its list' in r.stdout

    def test_it_prices_the_cap_by_outcome_so_the_competing_explanation_is_visible(
        self, tmp_path: Path,
    ) -> None:
        # One correct question whose turns are all short, one failing question whose turns are all
        # long. The table must report a different truncation share for the two groups, or the
        # reader cannot rule the cap out (or in).
        report = self._report([
            ('MR', True, self._raw(2, '2'), '2', '2', [100, 100]),
            ('MR', False, self._raw(2, '2'), '2', '3', [900, 900]),
        ])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'truncated' in r.stdout
        assert '0.0%' in r.stdout and '100.0%' in r.stdout


class TestWhereTheUnreachableGoldSits:
    """§13.78's measurement: `-1` is not a distance, and this is the table that makes it one.

    At `k = 64` every gold turn the ranker never surfaced is recorded as `-1`, whether it was rank
    65 — a near miss a wider pool would fix — or rank 900, where the ranker cannot reach its own
    answer and the pool width is irrelevant. `--reach` reads an artifact produced at a wider `k` and
    bands the ranks, so the question "how far away is the gold we cannot reach" has one number
    instead of an argument.
    """

    @staticmethod
    def _report(rows: list[tuple[str, list[int]]]) -> dict:
        """(capability, goldRanks) -> a report with one question per row."""
        questions = [
            {
                'questionId': f'q{index}',
                'capability': capability,
                'groundTruth': 'x',
                'answer': None,
                'rawOutput': None,
                'correct': False,
                'goldOverlap': {
                    'carried': sum(1 for r in ranks if r >= 0),
                    'total': len(ranks),
                    'pool': sum(1 for r in ranks if r >= 0),
                    'goldRanks': ranks,
                },
            }
            for index, (capability, ranks) in enumerate(rows)
        ]
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
            [sys.executable, str(TOOL), '--reach', str(path)],
            capture_output=True, text=True, check=False,
        )

    def test_it_bands_the_ranks_the_way_the_decision_needs(self, tmp_path: Path) -> None:
        # 3 gold inside 64, 1 in 64-127, 1 in 128-255, 1 never surfaced at 256. Four bands, because
        # the repair differs between "just outside the old pool" and "at the edge of the new one".
        report = self._report([('MR', [5, 30, 63, 70, 200, -1])])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert '64' in r.stdout and '128' in r.stdout and '256' in r.stdout

    def test_it_reports_the_median_rank_of_the_gold_beyond_the_old_pool(
        self, tmp_path: Path,
    ) -> None:
        # The number §13.78 registered: median of ranks >= 64. Here 70, 200 -> 135.
        report = self._report([('MR', [5, 30, 63, 70, 200, -1])])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert '135' in r.stdout

    def test_an_artifact_from_the_old_width_reports_the_band_as_unmeasured(
        self, tmp_path: Path,
    ) -> None:
        # At k = 64 every unseen gold is -1, so the bands above 64 are all zero and the median is
        # absent. Saying so is the point: a table that printed `0` would read as "no gold sits
        # there" when the truth is that nothing was scored there.
        report = self._report([('MR', [5, 30, 63, -1, -1])])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'not measured' in r.stdout or 'unmeasured' in r.stdout


class TestTheStabilityFloor:
    """§13.99: one configuration read twice, and how much of the answer layer moves.

    ## Why this is a subcommand and not an inline script

    §13.98.2's noise floor was measured by a script written for that section and not
    committed, which is the defect §13.38 forbade three times over: a registered
    prediction whose input cannot be re-derived by its reader is not a measurement.

    ## The distinction the output has to keep

    A re-worded answer that keeps its score is **stable** for the purpose this number
    exists -- deciding whether an effect of five questions is detectable -- so text
    changes and state changes are counted separately and named separately. Collapsing
    them would make a run that paraphrases look as unstable as one that changes its mind.
    """

    @staticmethod
    def _report(rows: list[tuple[str, str, bool, object]]) -> dict:
        return {
            'memoryArmConfig': {'ask': 'enumerated'},
            'questions': [
                {
                    'questionId': identifier,
                    'capability': capability,
                    'correct': correct,
                    'answer': answer,
                    'rawOutput': answer if isinstance(answer, str) else None,
                    'groundTruth': 'gold',
                }
                for identifier, capability, correct, answer in rows
            ],
        }

    def _run(self, tmp_path: Path, before: dict, after: dict) -> 'subprocess.CompletedProcess[str]':
        first = tmp_path / 'before.json'
        second = tmp_path / 'after.json'
        first.write_text(json.dumps(before), encoding='utf-8')
        second.write_text(json.dumps(after), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), '--stability', str(first), str(second)],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_an_identical_pair_reads_as_no_movement(self, tmp_path: Path) -> None:
        rows = [('m1', 'MR', True, '3'), ('m2', 'MR', False, '4'), ('t1', 'TR', True, 'May')]
        r = self._run(tmp_path, self._report(rows), self._report(rows))
        assert r.returncode == 0, r.stderr
        assert 'answer stability' in r.stdout
        assert '0.0%' in r.stdout
        # Nothing changed state, so the transition block has no arrow in it.
        assert '->' not in r.stdout

    def test_a_rewording_is_a_text_change_and_not_a_state_change(self, tmp_path: Path) -> None:
        before = self._report([('m1', 'MR', True, '3'), ('m2', 'MR', True, 'five')])
        after = self._report([('m1', 'MR', True, 'three'), ('m2', 'MR', True, 'five')])
        r = self._run(tmp_path, before, after)
        assert r.returncode == 0, r.stderr
        # One of two answers re-worded: 50% text, 0% state. The line has to say both.
        assert '50.0%' in r.stdout
        assert '->' not in r.stdout
        assert 're-worded answers' in r.stdout

    def test_a_scored_change_appears_in_the_transition_block(self, tmp_path: Path) -> None:
        before = self._report([('m1', 'MR', True, '3')])
        after = self._report([('m1', 'MR', False, '4')])
        r = self._run(tmp_path, before, after)
        assert r.returncode == 0, r.stderr
        # The state name comes from the shared classifier rather than from this tool, so the
        # assertion is on the transition existing with count 1, not on which word it chose.
        assert 'MR: correct -> ' in r.stdout
        assert re.search(r'MR: correct -> \S+ 1', r.stdout)

    def test_two_rosters_that_name_different_questions_are_refused(self, tmp_path: Path) -> None:
        # The same rule `--paired` enforces: an id on one side only would be counted as
        # movement, and a noise floor inflated by a missing record hides real effects.
        before = self._report([('m1', 'MR', True, '3')])
        after = self._report([('m1', 'MR', True, '3'), ('m9', 'MR', False, '4')])
        r = self._run(tmp_path, before, after)
        assert r.returncode == 2
        assert 'same questions' in r.stderr


class TestTheArithmeticDirection:
    """§13.102.3: where a wrong MR answer is wrong, not merely that it is.

    ## Why a subcommand and not a paragraph of arithmetic

    The direction split (fifteen under-counts, twelve of them off by exactly one) was computed by
    an inline script during §13.102, which is the defect §13.38 recorded three times. It is also the
    quantity §13.103's fourth prediction is stated against, so it has to be re-derivable.

    ## Why the buckets are five and not two

    `under` and `over` are the mechanism; `abstention`, `non-numeric gold` and `no number stated` are
    states in which direction is not defined, and folding them into one of the two would make a run
    that declined more look like a run that counted less.
    """

    @staticmethod
    def _report(rows: list[tuple[str, str, object, object]]) -> dict:
        return {
            'memoryArmConfig': {'ask': 'enumerated'},
            'questions': [
                {
                    'questionId': identifier,
                    'capability': 'MR',
                    'question': 'How many things?',
                    'groundTruth': gold,
                    'answer': answer,
                    'correct': correct == 'right',
                    'rawOutput': answer if isinstance(answer, str) else None,
                }
                for identifier, correct, gold, answer in rows
            ],
        }

    def _run(self, tmp_path: Path, rows: list[tuple[str, str, object, object]]) -> str:
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(self._report(rows)), encoding='utf-8')
        r = subprocess.run(
            [sys.executable, str(TOOL), '--arithmetic', str(path)],
            capture_output=True,
            text=True,
            check=False,
        )
        assert r.returncode == 0, r.stderr
        return r.stdout

    def test_it_separates_the_directions_and_counts_the_off_by_one(self, tmp_path: Path) -> None:
        out = self._run(
            tmp_path,
            [
                ('u1', 'right', '3', '3'),
                ('u2', 'wrong', '3', '2'),  # under by one
                ('u3', 'wrong', '5', '4'),  # under by one
                ('u4', 'wrong', '4', '2'),  # under by two
                ('o1', 'wrong', '2', '3'),  # over by one
                ('a1', 'wrong', '7', None),  # abstention
                ('n1', 'wrong', 'February 1st', 'March'),  # non-numeric gold
                ('n2', 'wrong', '$720', 'I could not tell'),  # no number stated
            ],
        )
        assert 'under' in out
        # Three under-counts, two of them off by exactly one.
        assert 'off by one' in out
        assert '2' in out
        assert 'abstention' in out
        assert 'non-numeric gold' in out
        assert 'no number' in out

    def test_it_ignores_correct_answers_and_other_capabilities(self, tmp_path: Path) -> None:
        report = self._report([('m1', 'right', '3', '3'), ('m2', 'wrong', '3', '2')])
        report['questions'].append(
            {
                'questionId': 'ie1',
                'capability': 'IE',
                'question': 'Where?',
                'groundTruth': 'Lisbon',
                'answer': 'Porto',
                'correct': False,
                'rawOutput': 'Porto',
            }
        )
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report), encoding='utf-8')
        r = subprocess.run(
            [sys.executable, str(TOOL), '--arithmetic', str(path)],
            capture_output=True,
            text=True,
            check=False,
        )
        assert r.returncode == 0, r.stderr
        # One wrong MR question: under. The correct one and the IE one are not in the table.
        assert 'total' in r.stdout
        assert '1' in r.stdout

    def test_a_time_gold_is_not_read_as_a_number(self, tmp_path: Path) -> None:
        # `9:00 AM` contains digits; stripping the colon would compare 9 against 9 and call a wrong
        # answer equal. A clock time is a value whose arithmetic is not the subtraction of its parts.
        out = self._run(tmp_path, [('c1', 'wrong', '9:00 AM', '10:00 AM')])
        assert 'clock' in out

    def test_a_stated_number_equal_to_the_gold_is_its_own_bucket(self, tmp_path: Path) -> None:
        # The answer was scored wrong with the gold's number in it: that is a grading or formatting
        # question, not a counting one, and calling it under or over would hide it.
        out = self._run(tmp_path, [('e1', 'wrong', '3', '3 items')])
        assert 'equal' in out


class TestTheArtefactAudit:
    """§13.106/§13.107: the configuration line is a claim, and a claim can be checked.

    ## Why this exists

    Two defects in two rounds were found by reading an artifact rather than by a test: a
    `vote=0/0/0` census on a run that never voted, and a reach table that disagreed with the
    fallthrough that implemented it. A third was found this round by comparing one artifact's
    census against the 2,000 its roster implies. None of the three was visible to any suite,
    because every one of them is a disagreement **between fields of one artifact**.

    ## What is deliberately not checked

    Anything that is true of a legitimate run as well as of a broken one. `evidenceTurns`
    exceeding `relevanceTopK` looks wrong and is not: the pool is counted in records and a
    record expands to its turns. Turns longer than `maxTurnChars` look wrong and are not: the
    cap is applied when the prompt is rendered, while the roster keeps what was selected. A
    check that fires on a good run is worse than no check, because it teaches a reader to
    ignore the output.
    """

    @staticmethod
    def _artifact(**overrides: object) -> dict:
        questions = [
            {
                'questionId': f'm{index}',
                'capability': 'MR',
                'question': f'How many things {index}?',
                'groundTruth': '3',
                'answer': '3',
                'correct': True,
                'promptChars': 40_000,
                'evidenceTurns': 300,
                'turns': [{'index': 0, 'text': '[2023/02/15 (Wed) 03:14] user: hello'}],
            }
            for index in range(4)
        ]
        questions.append(
            {
                'questionId': 't1',
                'capability': 'TR',
                'question': 'When did I move?',
                'groundTruth': 'May',
                'answer': 'May',
                'correct': True,
                'promptChars': 30_000,
                'evidenceTurns': 10,
                # A user turn, because `temporal` is in `evidenceRolesRoutes` here: real artifacts
                # carry zero assistant turns on the multi-session and temporal routes, and a
                # fixture that carried one would make the consistent-artifact test fail for a reason
                # that has nothing to do with the code under test.
                'turns': [{'index': 0, 'text': '[2023/02/15 (Wed) 03:15] user: I moved in May'}],
            }
        )
        artifact = {
            'questionCount': 5,
            'runs': 1,
            'abstentionReasons': {'empty': 0, 'threshold': 0, 'llm': 0, 'answered': 5},
            'memoryArmConfig': {
                'ask': 'enumerated',
                'askRoutes': ['multi-session', 'flat', 'temporal'],
                'renderingRoutes': ['multi-session', 'flat', 'temporal', 'abstention'],
                'selfConsistency': 'none',
                'queryExpansion': 'none',
                'maxPromptChars': 48_000,
                'maxTurnChars': 400,
                'evidenceRoles': ['user'],
                'evidenceRolesRoutes': ['multi-session', 'temporal'],
            },
            'questions': questions,
        }
        artifact.update(overrides)
        return artifact

    def _audit(self, tmp_path: Path, artifact: dict) -> 'subprocess.CompletedProcess[str]':
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(artifact), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), '--audit', str(path)],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_a_consistent_artifact_passes_with_exit_zero(self, tmp_path: Path) -> None:
        r = self._audit(tmp_path, self._artifact())
        assert r.returncode == 0, r.stdout + r.stderr
        assert 'PASS' in r.stdout
        assert 'FAIL' not in r.stdout

    def test_a_census_that_counts_consultations_fails(self, tmp_path: Path) -> None:
        # §13.107's defect, in the shape it appeared: five questions, a census summing to more.
        artifact = self._artifact(
            abstentionReasons={'empty': 0, 'threshold': 0, 'llm': 6, 'answered': 9}
        )
        r = self._audit(tmp_path, artifact)
        assert r.returncode == 1
        assert 'census-unit' in r.stdout

    def test_a_vote_census_on_a_run_that_did_not_vote_fails(self, tmp_path: Path) -> None:
        # §13.104's `vote=0/0/0`: a mechanism claimed by a field nobody's mechanism produced.
        artifact = self._artifact()
        artifact['memoryArmConfig']['voteCounts'] = {'unanimous': 0, 'majority': 0, 'split': 0}
        r = self._audit(tmp_path, artifact)
        assert r.returncode == 1
        assert 'vote' in r.stdout

    def test_a_voting_run_without_a_census_fails(self, tmp_path: Path) -> None:
        # The other direction: the treatment was dispatched and the artifact cannot say how the
        # votes resolved, so a null result could not be read as a mechanism failure.
        artifact = self._artifact()
        artifact['memoryArmConfig']['selfConsistency'] = '3'
        r = self._audit(tmp_path, artifact)
        assert r.returncode == 1
        assert 'vote' in r.stdout

    def test_a_vote_census_whose_sum_is_not_the_multi_session_count_fails(
        self, tmp_path: Path
    ) -> None:
        artifact = self._artifact()
        artifact['memoryArmConfig']['selfConsistency'] = '3'
        # Four MR questions, one repetition: a sum of five is one too many.
        artifact['memoryArmConfig']['voteCounts'] = {'unanimous': 2, 'majority': 2, 'split': 1}
        r = self._audit(tmp_path, artifact)
        assert r.returncode == 1
        assert 'vote' in r.stdout

    def test_a_prompt_over_the_declared_budget_fails(self, tmp_path: Path) -> None:
        artifact = self._artifact()
        artifact['questions'][0]['promptChars'] = 48_500
        r = self._audit(tmp_path, artifact)
        assert r.returncode == 1
        assert 'budget' in r.stdout

    def test_a_reach_that_names_a_route_the_run_did_not_render_fails(self, tmp_path: Path) -> None:
        artifact = self._artifact()
        artifact['memoryArmConfig']['askRoutes'] = ['multi-session', 'flat']
        artifact['memoryArmConfig']['renderingRoutes'] = ['multi-session']
        r = self._audit(tmp_path, artifact)
        assert r.returncode == 1
        assert 'reach' in r.stdout

    def test_an_assistant_turn_in_a_user_only_route_fails(self, tmp_path: Path) -> None:
        # §13.83's role filter, checked where it claims to apply: the multi-session route must not
        # carry an assistant turn, while the temporal route is not in the roles list here and its
        # assistant turn is legitimate.
        artifact = self._artifact()
        artifact['questions'][0]['turns'] = [
            {'index': 0, 'text': '[2023/02/15 (Wed) 03:15] assistant: noted'}
        ]
        r = self._audit(tmp_path, artifact)
        assert r.returncode == 1
        assert 'roles' in r.stdout

    def test_an_assistant_turn_on_a_route_outside_the_filter_is_legal(self, tmp_path: Path) -> None:
        # §13.83's filter names its routes. Three capabilities keep the assistant's turns on
        # purpose -- ABS's gold is the assistant's own disclosure -- so a check that fired on them
        # would flag every run ever dispatched.
        artifact = self._artifact()
        artifact['questions'].append(
            {
                'questionId': 'ie1',
                'capability': 'IE',
                'question': 'What did you buy?',
                'groundTruth': 'a kit',
                'answer': 'a kit',
                'correct': True,
                'promptChars': 30_000,
                'evidenceTurns': 8,
                'turns': [{'index': 0, 'text': '[2023/02/15 (Wed) 03:16] assistant: a kit'}],
            }
        )
        artifact['questionCount'] = 6
        artifact['abstentionReasons'] = {'empty': 0, 'threshold': 0, 'llm': 0, 'answered': 6}

        r = self._audit(tmp_path, artifact)

        assert r.returncode == 0, r.stdout

    def test_a_roster_that_does_not_match_the_declared_count_fails(self, tmp_path: Path) -> None:
        artifact = self._artifact()
        artifact['questionCount'] = 6
        r = self._audit(tmp_path, artifact)
        assert r.returncode == 1
        assert 'roster' in r.stdout


def _spend_report(
    *,
    calls: int = 4_084,
    unpriced: int = 0,
    prompt: int = 46_900_000,
    completion: int = 210_000,
    cached: int = 32_000_000,
    runs: object = 4,
) -> dict:
    """A report carrying only what the spend readout reads.

    The block is the shape `attachLlmUsage` writes -- `UsageSnapshot` with no field renamed and none
    defaulted -- because the point of these tests is the arithmetic and the band, not the parse.
    """
    report = _synthetic_report()
    report['llmUsage'] = {
        'calls': calls,
        'unpricedCalls': unpriced,
        'promptTokens': prompt,
        'completionTokens': completion,
        'cacheHitPromptTokens': cached,
    }
    if runs is not None:
        report['runs'] = runs
    return report


class TestTheProviderSpend:
    """§13.140 registers the instrument; §13.147.3 registers what its cache share licenses."""

    @staticmethod
    def _run(tmp_path: Path, report: dict) -> 'subprocess.CompletedProcess[str]':
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report), encoding='utf-8')
        return subprocess.run(
            [sys.executable, str(TOOL), str(path), '--spend'],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_it_prints_the_numbers_the_artifact_states(self, tmp_path: Path) -> None:
        r = self._run(tmp_path, _spend_report())
        assert r.returncode == 0, r.stderr
        assert '4,084' in r.stdout
        assert '46,900,000' in r.stdout
        assert '210,000' in r.stdout
        # The share is the one derived quantity: 32 of 46.9 million.
        assert '68.2%' in r.stdout, r.stdout

    def test_it_derives_the_per_pass_call_count_from_the_repetitions(self, tmp_path: Path) -> None:
        # 500 questions over two sides over four repetitions, beside the 4,084 calls recorded --
        # the excess is the retry and judge traffic, and stating both is what makes the excess
        # visible instead of implied.
        r = self._run(tmp_path, _spend_report())
        assert '4,000 answer calls of the 4,084' in r.stdout, r.stdout

    def test_a_report_without_runs_cannot_attribute_the_share(self, tmp_path: Path) -> None:
        r = self._run(tmp_path, _spend_report(runs=None))
        assert r.returncode == 0, r.stderr
        assert 'cannot be attributed' in r.stdout

    @pytest.mark.parametrize(
        ('cached', 'expected'),
        [
            (0, 'under 5%'),
            (4_690_000, '5-20%'),  # 0.10 of the prompt
            (18_760_000, '20-60%'),  # 0.40
            (32_830_000, '60-80%'),  # 0.70
        ],
    )
    def test_the_share_is_read_against_the_registered_bands(
        self, tmp_path: Path, cached: int, expected: str
    ) -> None:
        r = self._run(tmp_path, _spend_report(cached=cached))
        assert r.returncode == 0, r.stderr
        assert expected in r.stdout, r.stdout

    def test_a_missing_block_is_an_absence_and_not_a_free_run(self, tmp_path: Path) -> None:
        report = _synthetic_report()
        r = self._run(tmp_path, report)
        assert r.returncode == 2
        assert 'predates' in r.stderr

    @pytest.mark.parametrize(
        'block',
        [
            # A cache hit is a SUBSET of the prompt by construction, so a sum above it did not come
            # from this adapter.
            {'calls': 1, 'unpricedCalls': 0, 'promptTokens': 10, 'completionTokens': 1,
             'cacheHitPromptTokens': 11},
            # More unpriced calls than calls cannot arise from a counter incremented once per call.
            {'calls': 1, 'unpricedCalls': 2, 'promptTokens': 10, 'completionTokens': 1,
             'cacheHitPromptTokens': 0},
            {'calls': 1, 'unpricedCalls': 0, 'promptTokens': -1, 'completionTokens': 1,
             'cacheHitPromptTokens': 0},
            # Python's bool is an int: a producer that serialised a flag here must not read as a count.
            {'calls': True, 'unpricedCalls': 0, 'promptTokens': 10, 'completionTokens': 1,
             'cacheHitPromptTokens': 0},
        ],
    )
    def test_a_corrupt_block_is_refused_rather_than_printed(self, tmp_path: Path, block: dict) -> None:
        report = _synthetic_report()
        report['llmUsage'] = block
        r = self._run(tmp_path, report)
        assert r.returncode == 2
        assert 'non-negative integer' in r.stderr or 'subset' in r.stderr or 'cannot be' in r.stderr
