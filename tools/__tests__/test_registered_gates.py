#!/usr/bin/env python3
"""The registered gates are decided from the artifact, and the registration is the only threshold.

## The defect this file is written against

§13.262.1's gate 6 read `FAIL` on run `42054107910` because the *check* was wrong, not the run: it
compared a flag count against a tally accumulated over four repetitions. That is §13.107's class --
a census that counts one thing where it claims another -- and it survived because the check was a
sentence in a document read by a person holding the number. §13.69 is the neighbour: the
registration and the dispatch each believed their own copy of one adopted value, and the copies
agreed with themselves and disagreed with each other.

So the gates are data (`tools/gates/13.262.7.json`) and this file holds two things at once:

- **each kind, computed**: every gate type is exercised on a fixture whose answer is arithmetic, not
  opinion, including the negative case -- a check that passes on a good artifact proves nothing;
- **the registration against the table**: §13.262.7's markdown rows are parsed out of the document
  and compared with the spec, cell for cell. An edit to either side alone fails here, which is what
  makes the order "thresholds before the number" survive a later reader.

## Why `UNEVALUABLE` has its own tests

The cases below that matter most are the ones where a field is *absent*. §13.11.2's rule -- a
missing measurement is not a zero one -- is what stops a run that never reported `bareRetry` from
being read as a run whose ladder was fine, and the tool must exit non-zero for it rather than
printing `PASS` beside an empty reading.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'registered-gates.py'
SPEC = REPO / 'tools' / 'gates' / '13.262.7.json'
PREREGISTRATION = REPO / 'docs' / 'PREREGISTRATION-CORTEX-MEMORY-ARM.md'


def _report(
    capabilities: dict[str, tuple[int, int]] | None = None,
    *,
    digests: str | None = None,
    audit: tuple[int, int] | None = None,
    bare_retry: int | None = None,
    calls: int | None = None,
    sides: dict[str, int] | None = None,
    offset: int = 0,
) -> dict:
    """A report whose every block is explicit, so no gate can be decided by a default.

    `capabilities` maps a capability to `(correct, total)` and the correct ones are the block of
    `correct` questions starting at `offset`. The offset exists so two fixtures can be discordant in
    both directions: with both blocks starting at zero, a treatment that gains two points only ever
    wins, and a McNemar test on wins-only cannot exercise the clause a neutral pass depends on.
    """
    questions: list[dict] = []
    for capability, (correct, total) in (capabilities or {}).items():
        for index in range(total):
            record = {
                'questionId': f'{capability}-{index:04d}',
                'capability': capability,
                'correct': offset <= index < offset + correct,
                'answer': 'x',
            }
            if digests is not None:
                record['promptDigest'] = f'{digests}-{capability}-{index:04d}'
            if audit is not None:
                record['auditConsultations'] = audit[0] // total if total else 0
                record['auditChanges'] = 0
            questions.append(record)
    report: dict = {'questions': questions}
    if audit is not None:
        report['audit'] = {'attempted': audit[0], 'changed': audit[1]}
    if bare_retry is not None:
        report['bareRetry'] = {'attempted': bare_retry, 'answered': bare_retry}
    if calls is not None:
        report['llmUsage'] = {'calls': calls}
    if sides is not None:
        report['usageBySide'] = {name: {'calls': value} for name, value in sides.items()}
    return report


def _write(directory: Path, name: str, report: dict) -> Path:
    path = directory / name
    path.write_text(json.dumps(report))
    return path


def _run(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(TOOL), *arguments],
        capture_output=True,
        text=True,
        check=False,
    )


class GateTest(unittest.TestCase):
    """A fixture per gate, and the arithmetic the verdict has to reproduce."""

    def setUp(self) -> None:
        import tempfile

        self.directory = Path(tempfile.mkdtemp(prefix='gates-'))

    def _verdicts(self, treatment: dict, reference: dict | None = None, prior: dict | None = None) -> dict[int, dict]:
        treatment_path = _write(self.directory, 'treatment.json', treatment)
        arguments = [str(SPEC), '--treatment', str(treatment_path), '--json']
        if reference is not None:
            arguments += ['--reference', str(_write(self.directory, 'reference.json', reference))]
        if prior is not None:
            arguments += ['--prior', str(_write(self.directory, 'prior.json', prior))]
        completed = _run(*arguments)
        self.assertEqual(completed.returncode in (0, 1), True, completed.stderr)
        payload = json.loads(completed.stdout)
        # Keyed by the string form so a failed lookup names the gate the test asked about rather
        # than raising `KeyError: 1`, which reads as a broken fixture instead of a broken verdict.
        return {str(result['id']): result for result in payload['results']}

    def test_gate_one_asks_whether_the_pass_is_worse_than_no_pass(self) -> None:
        reference = _report({'MR': (6, 10)})
        # Shifted by two so the two blocks are discordant in both directions: four questions the
        # control got wrong and the treatment got right, two the other way.
        treatment = _report({'MR': (8, 10)}, offset=2)
        gate = self._verdicts(treatment, reference)['1']
        self.assertEqual(gate['verdict'], 'PASS')
        self.assertAlmostEqual(gate['detail']['delta_points'], 20.0)
        # 4 won, 2 lost on ten questions is not a direction; the gate's second clause is why this
        # passes on a positive delta *and* on a p-value that refuses to call it one.
        self.assertEqual((gate['detail']['wins'], gate['detail']['losses']), (4, 2))
        self.assertGreater(gate['detail']['p_value'], 0.05)

    def test_gate_one_fails_on_a_loss_even_when_the_split_is_noise(self) -> None:
        reference = _report({'MR': (6, 10)})
        treatment = _report({'MR': (4, 10)})
        self.assertEqual(self._verdicts(treatment, reference)['1']['verdict'], 'FAIL')

    def test_gate_one_fails_when_a_gain_is_significant(self) -> None:
        """Neutrality is the pass condition: ten wins and no losses is not neutral."""
        reference = _report({'MR': (0, 10)})
        treatment = _report({'MR': (10, 10)})
        gate = self._verdicts(treatment, reference)['1']
        self.assertEqual(gate['verdict'], 'FAIL')
        self.assertLess(gate['detail']['p_value'], 0.05)

    def test_gate_two_measures_the_recovery_against_the_prior_audit(self) -> None:
        # Twenty questions so the bar can be approached from both sides: fourteen against twelve is
        # exactly +10, thirteen is +5.
        prior = _report({'MR': (12, 20)})
        self.assertEqual(self._verdicts(_report({'MR': (14, 20)}, offset=3), None, prior)['2']['verdict'], 'PASS')
        self.assertEqual(self._verdicts(_report({'MR': (13, 20)}, offset=3), None, prior)['2']['verdict'], 'FAIL')

    def test_gate_two_reports_unevaluable_without_the_prior_artifact(self) -> None:
        gate = self._verdicts(_report({'MR': (8, 10)}))['2']
        self.assertEqual(gate['verdict'], 'UNEVALUABLE')

    def test_gate_three_holds_every_other_capability_to_three_points(self) -> None:
        reference = _report({'MR': (6, 10), 'IE': (100, 200), 'TR': (100, 200)})
        # Five questions of two hundred is 2.5 points: inside the bar.
        self.assertEqual(self._verdicts(_report({'MR': (9, 10), 'IE': (95, 200), 'TR': (100, 200)}), reference)['3']['verdict'], 'PASS')
        # Seven is 3.5: outside it.
        self.assertEqual(self._verdicts(_report({'MR': (9, 10), 'IE': (93, 200), 'TR': (100, 200)}), reference)['3']['verdict'], 'FAIL')

    def test_gate_three_does_not_judge_the_capability_gates_one_and_two_own(self) -> None:
        reference = _report({'MR': (10, 10), 'IE': (100, 200)})
        treatment = _report({'MR': (0, 10), 'IE': (100, 200)})
        gate = self._verdicts(treatment, reference)['3']
        self.assertEqual(gate['verdict'], 'PASS')
        self.assertNotIn('MR', gate['reading'])

    def test_gate_three_is_unevaluable_when_a_capability_vanished(self) -> None:
        reference = _report({'MR': (6, 10), 'IE': (100, 200), 'KU': (50, 100)})
        gate = self._verdicts(_report({'MR': (6, 10), 'IE': (100, 200)}), reference)['3']
        self.assertEqual(gate['verdict'], 'UNEVALUABLE')
        self.assertIn('KU', gate['reading'])

    def test_delta_is_computed_on_the_shared_questions_only(self) -> None:
        """A control that measured fewer questions cannot contribute to a delta it did not measure."""
        reference = _report({'MR': (6, 10)})
        reference['questions'] = reference['questions'][:8]
        gate = self._verdicts(_report({'MR': (8, 10)}), reference)['1']
        self.assertEqual(gate['detail']['shared'], 8)
        self.assertIn('over 8', gate['reading'])

    def test_gate_four_and_five_read_a_field_and_refuse_an_absent_one(self) -> None:
        present = self._verdicts(_report({'MR': (1, 1)}, bare_retry=71, calls=5_000))
        self.assertEqual(present['4']['verdict'], 'PASS')
        self.assertEqual(present['5']['verdict'], 'PASS')
        absent = self._verdicts(_report({'MR': (1, 1)}))
        self.assertEqual(absent['4']['verdict'], 'UNEVALUABLE')
        self.assertEqual(absent['5']['verdict'], 'UNEVALUABLE')

    def test_gate_five_fails_above_the_registered_ceiling(self) -> None:
        self.assertEqual(self._verdicts(_report({'MR': (1, 1)}, calls=6_401))['5']['verdict'], 'FAIL')

    def test_gate_six_requires_the_column_to_sum_to_the_tally(self) -> None:
        # Ten questions, four repetitions each: the tally is 40 and the column must sum to it.
        report = _report({'MR': (1, 10)}, audit=(40, 12))
        gate = self._verdicts(report)['6']
        self.assertEqual(gate['verdict'], 'PASS')
        self.assertEqual(gate['detail']['column'], 40)

    def test_gate_six_fails_when_the_tally_is_four_times_the_column(self) -> None:
        """The §13.262.5 defect, reproduced: a column that records one pass against a tally of four."""
        report = _report({'MR': (1, 10)}, audit=(40, 12))
        for record in report['questions']:
            record['auditConsultations'] = 1
        gate = self._verdicts(report)['6']
        self.assertEqual(gate['verdict'], 'FAIL')
        self.assertIn('10 against a tally of 40', gate['reading'])

    def test_gate_six_is_unevaluable_when_one_record_did_not_write_the_column(self) -> None:
        report = _report({'MR': (1, 10)}, audit=(40, 12))
        del report['questions'][3]['auditConsultations']
        gate = self._verdicts(report)['6']
        self.assertEqual(gate['verdict'], 'UNEVALUABLE')
        self.assertIn('MR-0003', gate['reading'])

    def test_gate_seven_holds_each_side_under_the_total(self) -> None:
        passing = self._verdicts(_report({'MR': (1, 1)}, calls=6_000, sides={'baseline': 2_900, 'feature': 3_100}))
        self.assertEqual(passing['7']['verdict'], 'PASS')
        failing = self._verdicts(_report({'MR': (1, 1)}, calls=6_000, sides={'baseline': 2_900, 'feature': 6_100}))
        self.assertEqual(failing['7']['verdict'], 'FAIL')

    def test_gate_eight_requires_every_digest_to_agree(self) -> None:
        reference = _report({'MR': (1, 500)}, digests='a')
        self.assertEqual(self._verdicts(_report({'MR': (1, 500)}, digests='a'), reference)['8']['verdict'], 'PASS')
        self.assertEqual(self._verdicts(_report({'MR': (1, 500)}, digests='b'), reference)['8']['verdict'], 'FAIL')

    def test_gate_eight_is_unevaluable_below_the_registered_denominator(self) -> None:
        """`499/499` is not `500/500`, and a run that measured fewer questions cannot claim it."""
        reference = _report({'MR': (1, 500)}, digests='a')
        treatment = _report({'MR': (1, 500)}, digests='a')
        del treatment['questions'][0]['promptDigest']
        gate = self._verdicts(treatment, reference)['8']
        self.assertEqual(gate['verdict'], 'UNEVALUABLE')
        self.assertIn('499 of 500', gate['reading'])


class ExitCodeTest(unittest.TestCase):
    """The tool gates a dispatch, so a `FAIL` that exits 0 could not stop one."""

    def test_a_failing_gate_exits_non_zero_and_says_which(self) -> None:
        import tempfile

        directory = Path(tempfile.mkdtemp(prefix='gates-exit-'))
        treatment = _write(directory, 'treatment.json', _report({'MR': (0, 10)}, bare_retry=0, calls=9_999))
        reference = _write(directory, 'reference.json', _report({'MR': (10, 10)}))
        completed = _run(str(SPEC), '--treatment', str(treatment), '--reference', str(reference))
        self.assertEqual(completed.returncode, 1, completed.stdout)
        self.assertIn('FAILED: gates', completed.stdout)

    def test_an_unevaluable_gate_also_exits_non_zero(self) -> None:
        import tempfile

        directory = Path(tempfile.mkdtemp(prefix='gates-exit-'))
        treatment = _write(directory, 'treatment.json', _report({'MR': (1, 1)}))
        completed = _run(str(SPEC), '--treatment', str(treatment))
        self.assertEqual(completed.returncode, 1)
        self.assertIn('UNEVALUABLE: gates', completed.stdout)
        self.assertIn('an absent field is not a pass', completed.stdout)

    def test_the_table_names_the_artifact_each_control_is(self) -> None:
        import tempfile

        directory = Path(tempfile.mkdtemp(prefix='gates-exit-'))
        treatment = _write(directory, 'treatment.json', _report({'MR': (1, 1)}))
        completed = _run(str(SPEC), '--treatment', str(treatment))
        self.assertIn('run 42013256884', completed.stdout)


class RegistrationAgreementTest(unittest.TestCase):
    """§13.262.7's table and the spec are one threshold, not two copies.

    Read out of the document rather than restated here, for the reason §10.3's test gives: a test
    that hard-coded `10` would be a third copy, updated in whichever file the person editing it
    opened first -- so the test would pass while the registration and the evaluation drifted apart.
    """

    @staticmethod
    def _rows() -> dict[int, tuple[str, str]]:
        text = PREREGISTRATION.read_text()
        start = text.index('### 13.262.7')
        end = text.index('### 13.262.8', start)
        rows: dict[int, tuple[str, str]] = {}
        for line in text[start:end].splitlines():
            if not re.match(r'^\|\s*\d+\s*\|', line):
                continue
            cells = [cell.strip() for cell in line.strip().strip('|').split('|')]
            if len(cells) < 3:
                continue
            rows[int(cells[0])] = (cells[1], cells[2])
        return rows

    def test_the_spec_and_the_document_list_the_same_gates(self) -> None:
        spec = json.loads(SPEC.read_text())
        self.assertEqual([gate['id'] for gate in spec['gates']], sorted(self._rows()))

    def test_every_gate_matches_its_row_cell_for_cell(self) -> None:
        spec = json.loads(SPEC.read_text())
        rows = self._rows()
        for gate in spec['gates']:
            with self.subTest(gate=gate['id']):
                quantity, threshold = rows[gate['id']]
                self.assertEqual(gate['quantity'], quantity)
                self.assertEqual(gate['threshold'], threshold)

    def test_the_spec_reads_a_document_that_exists(self) -> None:
        spec = json.loads(SPEC.read_text())
        self.assertEqual(spec['registration'], '13.262.7')
        self.assertTrue((REPO / spec['document']).is_file())

    def test_each_control_artifact_the_spec_names_is_a_run(self) -> None:
        spec = json.loads(SPEC.read_text())
        named = {gate['control'] for gate in spec['gates'] if 'control' in gate}
        self.assertEqual(named, set(spec['controls']))
        for name in named:
            self.assertIsInstance(spec['controls'][name]['run'], int)


class ThresholdUnitTest(unittest.TestCase):
    """Points, not fractions, because the registration wrote points."""

    def test_a_one_question_delta_on_two_hundred_is_not_three_points(self) -> None:
        import tempfile

        directory = Path(tempfile.mkdtemp(prefix='gates-points-'))
        reference = _write(directory, 'reference.json', _report({'MR': (1, 1), 'IE': (100, 200)}))
        treatment = _write(directory, 'treatment.json', _report({'MR': (1, 1), 'IE': (99, 200)}))
        completed = _run(str(SPEC), '--treatment', str(treatment), '--reference', str(reference))
        self.assertIn('worst -0.50 points', completed.stdout)


if __name__ == '__main__':
    unittest.main()
