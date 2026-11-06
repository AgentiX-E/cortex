#!/usr/bin/env python3
"""The verdict has to be computable from the record, and each gate has to be able to fail.

## Why every gate gets a test that fails it

§13.267.3 registered eight conditions before the harness existed. A gate that no fixture can fail is
a gate that will pass on the run it was written for and say nothing -- and the two that matter most
here are the least likely to fire by accident: a control that breaks under restore (gate 2) and a
configuration that moved between the source run and the counterfactual (gate 6). Both produce a
complete, well-formed, entirely standard-looking table.

## Why the majority rule is tested arithmetically

The source run answered every question four times. Reading `questions[].correct` would split the
population on one pass out of four, and `42190193540`'s own artifact already shows 14 questions where
that field and the fourth pass disagree. The fixture below therefore builds both sides the same way
and pins the boundary: two of four is wrong, three of four is right.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'restore-classify.py'

CONFIG = {
    'threshold': 0,
    'retrievalThreshold': 0,
    'relevanceSignal': 'retrieval-anchored',
    'relevanceTopK': 512,
    'maxPromptChars': 48000,
}


def _artifact(ids, bits_per_run, config=None):
    """A minimal artifact: the blocks this tool reads and nothing else."""
    questions = [{'questionId': identifier, 'capability': 'MR'} for identifier in ids]
    return {
        'memoryArmConfig': dict(CONFIG if config is None else config),
        'questions': questions,
        'ablation': {'featureCorrectByRun': bits_per_run},
        'generatedAt': '2026-11-06T00:00:00Z',
    }


def _plan(entries):
    return {
        'source': '42190193540',
        'entries': [
            {
                'questionId': identifier,
                'question': f'question {identifier}?',
                'turns': ['turn'],
                'recordedOutcome': outcome,
            }
            for identifier, outcome in entries
        ],
    }


def _ledger(entries, unmatched=0):
    rows = []
    total = 0
    for identifier, calls, chars in entries:
        rows.append(
            {
                'questionId': identifier,
                'recordedOutcome': 'incorrect',
                'restoredTurns': 1,
                'restoredChars': chars,
                'calls': calls,
                'grewBy': calls * chars,
            }
        )
        total += calls
    return {'source': '42190193540', 'entries': rows, 'calls': total + unmatched, 'unmatchedCalls': unmatched}


class Harness(unittest.TestCase):
    def run_tool(self, source, restore, plan, ledger):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            paths = {}
            for name, payload in (
                ('source', source),
                ('restore', restore),
                ('plan', plan),
                ('ledger', ledger),
            ):
                path = root / f'{name}.json'
                path.write_text(json.dumps(payload))
                paths[name] = str(path)
            return subprocess.run(
                [
                    sys.executable,
                    str(TOOL),
                    '--restore',
                    paths['restore'],
                    '--source',
                    paths['source'],
                    '--plan',
                    paths['plan'],
                    '--ledger',
                    paths['ledger'],
                ],
                capture_output=True,
                text=True,
                check=False,
            )

    def baseline(self, *, restored=None, config=None, unmatched=0, calls=4):
        """Six failures and four controls; every failure converts unless `restored` says otherwise."""
        failure_ids = [f'f{index}' for index in range(6)]
        control_ids = [f'c{index}' for index in range(4)]
        ids = failure_ids + control_ids
        # Source: failures wrong on all four passes, controls right on all four.
        source_bits = ['0' * len(failure_ids) + '1' * len(control_ids)] * 4
        restore_bits = list(source_bits)
        flipping = failure_ids if restored is None else restored
        if flipping:
            base = source_bits[0]
            bits = ''.join(
                '1' if identifier in flipping else base[index]
                for index, identifier in enumerate(ids)
            )
            # Three of four: the majority rule counts this as converted, which is what the arm's own
            # scale does with its repetitions.
            restore_bits[0] = bits
            restore_bits[1] = bits
            restore_bits[2] = bits
        plan = _plan([(identifier, 'incorrect') for identifier in failure_ids] + [(identifier, 'correct') for identifier in control_ids])
        ledger = _ledger([(identifier, calls, 120) for identifier in ids], unmatched=unmatched)
        return (
            _artifact(ids, source_bits),
            _artifact(ids, restore_bits, config=config),
            plan,
            ledger,
        )


class GateTest(Harness):
    def test_a_clean_counterfactual_passes_every_gate(self) -> None:
        result = self.run_tool(*self.baseline())
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('ALL GATES PASS', result.stdout)
        self.assertIn('6 of 6', result.stdout)

    def test_gate_one_fails_when_too_few_failures_convert(self) -> None:
        # Three of six is below the registered floor of four: the missing evidence did not carry the
        # population, and the axis is not worth a mechanism.
        result = self.run_tool(*self.baseline(restored=['f0', 'f1', 'f2']))
        self.assertEqual(result.returncode, 1)
        self.assertIn('GATES FAILED: 1', result.stdout)

    def test_gate_two_fails_when_a_control_breaks(self) -> None:
        source, restore, plan, ledger = self.baseline()
        # Break two controls: right on four passes in the source, wrong on four passes under restore.
        bits = restore['ablation']['featureCorrectByRun'][0]
        for index, identifier in enumerate(['f0', 'f1', 'f2', 'f3', 'f4', 'f5', 'c0', 'c1', 'c2', 'c3']):
            if identifier in ('c0', 'c1'):
                bits = bits[:index] + '0' + bits[index + 1 :]
        restore['ablation']['featureCorrectByRun'] = [bits] * 4
        result = self.run_tool(source, restore, plan, ledger)
        self.assertEqual(result.returncode, 1)
        self.assertIn('GATES FAILED: 2', result.stdout)

    def test_gate_four_fails_when_a_prompt_grew_for_another_reason(self) -> None:
        source, restore, plan, ledger = self.baseline()
        ledger['entries'][0]['grewBy'] += 7
        result = self.run_tool(source, restore, plan, ledger)
        self.assertEqual(result.returncode, 1)
        self.assertIn('GATES FAILED: 4', result.stdout)

    def test_gate_five_fails_past_the_call_ceiling(self) -> None:
        source, restore, plan, ledger = self.baseline(calls=41)
        result = self.run_tool(source, restore, plan, ledger)
        self.assertEqual(result.returncode, 1)
        self.assertIn('GATES FAILED: 5', result.stdout)

    def test_gate_six_names_the_field_that_moved(self) -> None:
        # The check that makes the workflow's hand-written configuration safe. A drifted width is
        # exactly the departure that would make this a counterfactual of a different run.
        drifted = dict(CONFIG)
        drifted['relevanceTopK'] = 256
        result = self.run_tool(*self.baseline(config=drifted))
        self.assertEqual(result.returncode, 1)
        self.assertIn('GATES FAILED: 6', result.stdout)
        self.assertIn('`relevanceTopK`', result.stdout)
        self.assertIn('512', result.stdout)
        self.assertIn('256', result.stdout)

    def test_gate_six_notices_a_field_the_restore_run_added(self) -> None:
        drifted = dict(CONFIG)
        drifted['reviewPass'] = 'audit'
        result = self.run_tool(*self.baseline(config=drifted))
        self.assertEqual(result.returncode, 1)
        self.assertIn('`reviewPass`', result.stdout)

    def test_gate_seven_fails_when_a_planned_question_was_never_asked(self) -> None:
        source, restore, plan, ledger = self.baseline()
        ledger['entries'][0]['calls'] = 0
        ledger['calls'] -= 4
        result = self.run_tool(source, restore, plan, ledger)
        self.assertEqual(result.returncode, 1)
        self.assertIn('GATES FAILED: 7', result.stdout)

    def test_gate_eight_fails_on_a_call_that_matched_no_question(self) -> None:
        result = self.run_tool(*self.baseline(unmatched=2))
        self.assertEqual(result.returncode, 1)
        self.assertIn('GATES FAILED: 8', result.stdout)


class MajorityTest(Harness):
    def test_two_of_four_passes_is_still_wrong(self) -> None:
        source, restore, plan, ledger = self.baseline(restored=[])
        # `f0` right on two passes and wrong on two: below the majority, so it did not convert.
        restore['ablation']['featureCorrectByRun'] = [
            '1' + '0' * 5 + '1' * 4,
            '1' + '0' * 5 + '1' * 4,
            '0' * 10,
            '0' * 10,
        ]
        result = self.run_tool(source, restore, plan, ledger)
        self.assertEqual(result.returncode, 1)
        self.assertIn('0 of 6', result.stdout)

    def test_three_of_four_passes_is_correct(self) -> None:
        source, restore, plan, ledger = self.baseline(restored=[])
        # The same question, right on three: the boundary the choice of rule puts it on.
        restore['ablation']['featureCorrectByRun'] = [
            '1' + '0' * 5 + '1' * 4,
            '1' + '0' * 5 + '1' * 4,
            '1' + '0' * 5 + '1' * 4,
            '0' * 10,
        ]
        result = self.run_tool(source, restore, plan, ledger)
        self.assertEqual(result.returncode, 1)
        self.assertIn('1 of 6', result.stdout)


class RefusalTest(Harness):
    def test_a_recorded_outcome_that_disagrees_with_the_passes_is_reported_not_reconciled(self) -> None:
        source, restore, plan, ledger = self.baseline()
        # The plan says a control was `incorrect`; four passes say it was right. The tool keeps both
        # facts and counts the disagreement.
        plan['entries'][6]['recordedOutcome'] = 'incorrect'
        result = self.run_tool(source, restore, plan, ledger)
        self.assertIn('disagree between the plan', result.stdout)

    def test_a_missing_block_is_refused_rather_than_defaulted(self) -> None:
        source, restore, plan, ledger = self.baseline()
        del restore['ablation']
        result = self.run_tool(source, restore, plan, ledger)
        self.assertEqual(result.returncode, 2)
        self.assertIn('no `ablation` block', result.stderr)

    def test_a_bitstring_of_the_wrong_width_is_refused(self) -> None:
        source, restore, plan, ledger = self.baseline()
        restore['ablation']['featureCorrectByRun'] = ['1'] * 4
        result = self.run_tool(source, restore, plan, ledger)
        self.assertEqual(result.returncode, 2)
        self.assertIn('do not describe one run', result.stderr.replace('does not', 'do not'))

    def test_a_planned_question_absent_from_the_source_is_refused(self) -> None:
        source, restore, plan, ledger = self.baseline()
        plan['entries'].append(
            {'questionId': 'ghost', 'question': 'q?', 'turns': ['t'], 'recordedOutcome': 'incorrect'}
        )
        result = self.run_tool(source, restore, plan, ledger)
        self.assertEqual(result.returncode, 2)
        self.assertIn('ghost', result.stderr)

    def test_a_planned_question_absent_from_the_restore_run_is_refused(self) -> None:
        source, restore, plan, ledger = self.baseline()
        restore['questions'] = restore['questions'][:-1]
        restore['ablation']['featureCorrectByRun'] = ['1' * 9] * 4
        result = self.run_tool(source, restore, plan, ledger)
        self.assertEqual(result.returncode, 2)
        self.assertIn('c3', result.stderr)


if __name__ == '__main__':
    unittest.main()
