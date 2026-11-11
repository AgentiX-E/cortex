#!/usr/bin/env python3
"""The rewrite reader's own arithmetic and refusals, on synthetic artifacts.

## What is being pinned

`tools/supersede-rewrites.py` exists because `replaced 18` was unreadable, and a tool that reports a direction
has three ways to be wrong that no later reading would catch:

1. **A containment rule that is too loose.** `20` occurs inside `1200`; a substring rule would score a
   substitution about a follower count as a conversion on a question about eggs, and the error is invisible in
   the total because it moves both sides of the same column.
2. **A denominator that is the wrong population.** The pairs and the declared count are written from the same
   counter on the same call, so a sum that disagrees is an instrument defect. Reporting a rate over the pairs
   anyway is the "no measurement read as zero" defect this repository has paid for three times.
3. **An absent field read as zero substitutions.** Every artifact before `43001135439`'s successor is in that
   state. `0 damages` over an absent measurement is a number about the tool, not about the run.

Each has a test below that fails if the corresponding guard is removed.
"""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parents[1]


def _load(name: str):
    """Load a tool by path, because its filename is not a Python module name."""
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), TOOLS / f"{name}.py")
    if spec is None or spec.loader is None:  # pragma: no cover - a broken checkout, not a defect
        raise ImportError(name)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


rewrites = _load('supersede-rewrites')


def artifact(questions: list[dict]) -> Path:
    handle = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8')
    with handle:
        json.dump({'questions': questions}, handle)
    return Path(handle.name)


def record(**fields) -> dict:
    base = {
        'questionId': 'q',
        'capability': 'KU',
        'groundTruth': 'Paris',
        'supersessionConsultations': 1,
        'supersessionReplacements': 1,
        'supersessionRewrites': [{'first': 'Hawaii', 'final': 'Paris'}],
    }
    base.update(fields)
    return base


class Containment(unittest.TestCase):
    def test_a_numeral_inside_a_longer_numeral_is_not_a_hit(self):
        # The defect this pins: `20` is a substring of `1200`, and a follower-count answer would classify as a
        # conversion on a question whose gold is a number of eggs.
        self.assertFalse(rewrites.contains_gold('1250 followers', '20'))
        self.assertTrue(rewrites.contains_gold('20 dozen', '20'))

    def test_thousands_separators_do_not_split_a_value(self):
        self.assertTrue(rewrites.contains_gold('about 1,300 followers', '1300'))

    def test_a_non_numeric_gold_is_matched_case_insensitively(self):
        self.assertTrue(rewrites.contains_gold('the answer is PARIS', 'Paris'))

    def test_an_absent_side_is_not_a_hit(self):
        self.assertFalse(rewrites.contains_gold(None, 'Paris'))
        self.assertFalse(rewrites.contains_gold('Paris', '   '))


class Classification(unittest.TestCase):
    def test_gold_arriving_in_the_final_is_a_conversion(self):
        self.assertEqual(rewrites.classify('Hawaii', 'Paris', 'Paris'), 'conversion')

    def test_gold_leaving_in_the_final_is_a_damage(self):
        self.assertEqual(rewrites.classify('Paris', 'Hawaii', 'Paris'), 'damage')

    def test_gold_on_both_sides_is_neutral(self):
        # `a1eacc2a`'s shape: the substitution rewrote a string that already carried the gold, and the grader is
        # what decided the question. Containment cannot price it, and calling it a conversion would inflate the net.
        self.assertEqual(rewrites.classify('Paris in May', 'Paris, in May', 'Paris'), 'neutral')

    def test_a_question_with_no_gold_is_unscorable_rather_than_neutral(self):
        self.assertEqual(rewrites.classify('a', 'b', None), 'unscorable')


class Refusals(unittest.TestCase):
    def test_an_artifact_without_the_field_is_not_scored(self):
        # Every earlier run is in this state, and `0 damages` over it would be a number about the tool.
        path = artifact([record(supersessionRewrites=None)])
        with self.assertRaises(SystemExit) as raised:
            rewrites.read(path)
        self.assertIn('not scorable', str(raised.exception))

    def test_a_pair_count_that_disagrees_with_the_declared_count_is_refused(self):
        path = artifact([record(supersessionReplacements=4)])
        with self.assertRaises(SystemExit) as raised:
            rewrites.read(path)
        self.assertIn('defect in the instrument', str(raised.exception))

    def test_half_a_measurement_is_refused(self):
        path = artifact([record(supersessionReplacements=None)])
        with self.assertRaises(SystemExit) as raised:
            rewrites.read(path)
        self.assertIn('half a measurement', str(raised.exception))

    def test_an_artifact_with_no_roster_is_refused(self):
        path = artifact([])
        with self.assertRaises(SystemExit) as raised:
            rewrites.read(path)
        self.assertIn('no per-question roster', str(raised.exception))


class Census(unittest.TestCase):
    def test_the_capability_split_sums_to_the_total(self):
        path = artifact(
            [
                record(capability='KU', supersessionRewrites=[{'first': 'Hawaii', 'final': 'Paris'}]),
                record(
                    questionId='r',
                    capability='MR',
                    groundTruth='Friday',
                    supersessionRewrites=[{'first': 'Friday', 'final': 'Thursday'}],
                ),
            ]
        )
        reading = rewrites.read(path)
        self.assertEqual(reading['totals'], {
            'pairs': 2,
            'conversion': 1,
            'damage': 1,
            'neutral': 0,
            'unscorable': 0,
        })
        self.assertEqual(
            {name: row['pairs'] for name, row in reading['perCapability'].items()},
            {'KU': 1, 'MR': 1},
        )
        # Two substitutions that cancel, which is exactly the reading a bare count could not have produced.
        self.assertEqual(reading['netLowerBound'], 0)

    def test_a_record_with_no_pairs_contributes_to_nothing(self):
        # The denominator is the pairs, not the roster: a run that consulted often and substituted never is not
        # a run whose rate is undefined, it is a run with no substitutions to classify.
        path = artifact([record(supersessionReplacements=0, supersessionRewrites=[])])
        with self.assertRaises(SystemExit) as raised:
            rewrites.read(path)
        self.assertIn('not scorable', str(raised.exception))


class Output(unittest.TestCase):
    def test_the_report_names_both_directions_and_an_excerpt(self):
        path = artifact(
            [
                record(supersessionRewrites=[{'first': 'Hawaii', 'final': 'Paris'}]),
                record(
                    questionId='r',
                    groundTruth='Friday',
                    supersessionRewrites=[{'first': 'Friday', 'final': 'Thursday'}],
                ),
            ]
        )
        text = rewrites.report(rewrites.read(path), shown=5)
        self.assertIn('conversion', text)
        self.assertIn('damage', text)
        self.assertIn('net (lower bound)', text)
        self.assertIn('Hawaii', text)

    def test_json_mode_emits_one_object_per_artifact(self):
        path = artifact([record()])
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            code = rewrites.main([str(path), '--json'])
        self.assertEqual(code, 0)
        payload = json.loads(buffer.getvalue())
        self.assertEqual(payload['totals']['conversion'], 1)

    def test_show_zero_suppresses_the_table_without_changing_the_totals(self):
        path = artifact([record()])
        reading = rewrites.read(path)
        self.assertNotIn('decided a question', rewrites.report(reading, shown=0))
        self.assertEqual(reading['totals']['conversion'], 1)


if __name__ == '__main__':
    unittest.main()
