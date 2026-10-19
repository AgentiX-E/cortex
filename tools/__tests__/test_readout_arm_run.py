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
        # `carried > pool` cannot happen when the delivery came from the pool, so a record
        # showing it is a caller defect. The table says so instead of clamping.
        report = self._report([('MR', 10, 8, 2)])
        r = self._run(tmp_path, report)
        assert r.returncode == 0, r.stderr
        assert 'violate' in r.stdout or 'impossible' in r.stdout


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
