"""Tests for `tools/spec-reachability-groups.py` and the grouped reading it feeds.

The groups exist because `MEASURE-SPEC-CEILING.md` §4 named five questions the grammar cannot reach
and §3 named eight it can. Reading the `spec` dispatch as one `MR` number would average those
populations together, and the average is the one number that cannot say whether a flat result is a
mechanism that does not work or a population that had nothing to gain. The classification therefore
has to be **fixed before the dispatch** -- derived from a measurement of the grammar rather than from
the treatment's own results -- or it is the post-hoc split `arm-flip-census.py` already warns about.
"""

from __future__ import annotations

import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

TOOLS = Path(__file__).resolve().parent.parent

QUESTION_READING = TOOLS / 'readings' / 'spec-ceiling-question.json'
HISTORY_READING = TOOLS / 'readings' / 'spec-ceiling-history.json'
FROZEN = TOOLS / 'spec-reachability-groups.json'


def _load(name: str):  # noqa: ANN202 - a module loaded by path, like the tools do
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), TOOLS / f'{name}.py')
    if spec is None or spec.loader is None:
        raise ImportError(name)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


groups_tool = _load('spec-reachability-groups')


def _reading(path: Path) -> dict:
    return json.loads(path.read_text())


def _write(directory: Path, name: str, payload: dict) -> Path:
    target = directory / name
    target.write_text(json.dumps(payload))
    return target


class DerivationTest(unittest.TestCase):
    """What each group means, and that the memberships follow from the measurement."""

    def setUp(self) -> None:
        self.derived = groups_tool.derive(_reading(QUESTION_READING), _reading(HISTORY_READING))
        self.by_name = {group['name']: group for group in self.derived['groups']}

    def test_the_four_groups_are_the_three_readings_plus_the_unasked_population(self) -> None:
        # Three groups come from the two ceilings; the fourth exists because three of the twenty
        # failures have no numeric gold at all, which makes them unreachable for a reason that is
        # not a defect and must not be counted against the grammar.
        self.assertEqual(
            list(self.by_name),
            ['question-vocabulary', 'history-only', 'unreachable', 'no-numeric-gold'],
        )

    def test_the_group_sizes_are_the_numbers_the_registration_quotes(self) -> None:
        # 8 / 4 / 5 / 3. These are the same 8 and 12 the registration's ceiling table states; the
        # 12 splits into the 8 the table already reaches and 4 that need a word the question does
        # not supply, which is the difference between "the table's wording is too narrow" and "the
        # ledger has the vocabulary but the question does not".
        self.assertEqual(len(self.by_name['question-vocabulary']['ids']), 8)
        self.assertEqual(len(self.by_name['history-only']['ids']), 4)
        self.assertEqual(len(self.by_name['unreachable']['ids']), 5)
        self.assertEqual(len(self.by_name['no-numeric-gold']['ids']), 3)

    def test_the_unreachable_group_is_the_five_the_registration_names(self) -> None:
        # A doc-to-data tie: §13.363 lists these five in prose, and a later reading that disagrees
        # with the list has to change both. `d851d5ba`, `gpt4_731e37d7`, `2b8f3739`, `d6062bb9`,
        # `37f165cf` -- four money sums and one page count.
        self.assertEqual(
            sorted(self.by_name['unreachable']['ids']),
            sorted(['d851d5ba', 'gpt4_731e37d7', '2b8f3739', 'd6062bb9', '37f165cf']),
        )

    def test_membership_follows_the_plan_search_and_not_the_copy_ceiling(self) -> None:
        # `gpt4_2f91af09` carries no row that states its gold (`copyCeiling: false`) and is still
        # reachable, because a plan can *compute* 23 from rows that never say 23. If the groups were
        # derived from the copy test this question would land in `unreachable` and the arm would be
        # charged for a failure the grammar does not have.
        self.assertIn('gpt4_2f91af09', self.by_name['history-only']['ids'])
        history = {row['questionId']: row for row in _reading(HISTORY_READING)['summaries']}
        self.assertFalse(history['gpt4_2f91af09']['copyCeiling'])

    def test_a_question_reachable_from_its_own_words_is_not_also_history_only(self) -> None:
        left = set(self.by_name['question-vocabulary']['ids'])
        right = set(self.by_name['history-only']['ids'])
        self.assertEqual(left & right, set())

    def test_the_groups_cover_every_failure_exactly_once(self) -> None:
        # The population is the twenty multi-session failures the control arm has on record. An
        # ungrouped failure would be silently excluded from the reading, which is the direction
        # that hides a loss.
        everything = [identifier for group in self.derived['groups'] for identifier in group['ids']]
        self.assertEqual(len(everything), len(set(everything)))
        self.assertEqual(len(everything), len(_reading(HISTORY_READING)['summaries']))

    def test_the_rows_are_checked_against_the_readings_own_headline(self) -> None:
        # The reading states `grammar: 8` at the top and eight matching rows at the bottom. If a
        # future edit breaks one of them, the group would silently disagree with the number the
        # registration quotes, so the derivation refuses rather than trusting either side.
        question = _reading(QUESTION_READING)
        question['grammar'] = 9
        with self.assertRaises(ValueError):
            groups_tool.derive(question, _reading(HISTORY_READING))

    def test_the_two_readings_must_describe_the_same_capability(self) -> None:
        history = _reading(HISTORY_READING)
        history['capability'] = 'TR'
        with self.assertRaises(ValueError):
            groups_tool.derive(_reading(QUESTION_READING), history)

    def test_swapped_readings_are_refused_rather_than_read_backwards(self) -> None:
        # Passing the two files in the wrong order would produce 4 and 8 instead of 8 and 4, and
        # both numbers are plausible, so nothing downstream would notice. Each reading states its
        # vocabulary for this reason.
        with self.assertRaises(ValueError):
            groups_tool.derive(_reading(HISTORY_READING), _reading(QUESTION_READING))

    def test_readings_that_disagree_on_a_gold_are_refused(self) -> None:
        # The two readings were produced minutes apart against the same dataset. A gold that moved
        # between them means one of them is about a different corpus, and a group derived from it
        # would be about that corpus too.
        history = copy.deepcopy(_reading(HISTORY_READING))
        history['summaries'][0]['goldNumbers'] = [999]
        with self.assertRaises(ValueError):
            groups_tool.derive(_reading(QUESTION_READING), history)

    def test_readings_with_different_question_sets_are_refused(self) -> None:
        history = copy.deepcopy(_reading(HISTORY_READING))
        history['summaries'] = history['summaries'][1:]
        with self.assertRaises(ValueError):
            groups_tool.derive(_reading(QUESTION_READING), history)


class FrozenFileTest(unittest.TestCase):
    """The committed file has to be a derivation, not something typed by hand."""

    def test_the_committed_file_equals_a_fresh_derivation(self) -> None:
        derived = groups_tool.derive(_reading(QUESTION_READING), _reading(HISTORY_READING))
        self.assertEqual(_reading(FROZEN), json.loads(json.dumps(derived)))

    def test_the_committed_file_records_what_produced_it(self) -> None:
        frozen = _reading(FROZEN)
        self.assertEqual(frozen['source']['capability'], 'MR')
        self.assertEqual(frozen['source']['controlArtifact'], '42533236864')
        self.assertEqual(
            frozen['source']['readings'],
            ['tools/readings/spec-ceiling-question.json', 'tools/readings/spec-ceiling-history.json'],
        )
        # The freeze is the point: a classification derived after the dispatch could be chosen.
        self.assertIn('frozenBefore', frozen['source'])


class CommandLineTest(unittest.TestCase):
    def _run(self, question: Path, history: Path, *extra: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [
                sys.executable,
                str(TOOLS / 'spec-reachability-groups.py'),
                '--question',
                str(question),
                '--history',
                str(history),
                *extra,
            ],
            capture_output=True,
            text=True,
            check=False,
        )

    def test_it_prints_the_groups_and_their_sizes(self) -> None:
        completed = self._run(QUESTION_READING, HISTORY_READING)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        for name in ('question-vocabulary', 'history-only', 'unreachable', 'no-numeric-gold'):
            self.assertIn(name, completed.stdout)
        self.assertIn('8', completed.stdout)

    def test_write_emits_the_bytes_the_committed_file_holds(self) -> None:
        directory = Path(tempfile.mkdtemp(prefix='reach-'))
        target = directory / 'groups.json'
        completed = self._run(QUESTION_READING, HISTORY_READING, '--write', str(target))
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(target.read_text()), _reading(FROZEN))

    def test_a_swapped_pair_exits_non_zero_with_the_reason(self) -> None:
        completed = self._run(HISTORY_READING, QUESTION_READING)
        self.assertEqual(completed.returncode, 1)
        self.assertIn('not (question, history)', completed.stderr)

    def test_a_missing_reading_exits_non_zero_rather_than_reporting_empty_groups(self) -> None:
        directory = Path(tempfile.mkdtemp(prefix='reach-'))
        completed = self._run(QUESTION_READING, directory / 'absent.json')
        self.assertEqual(completed.returncode, 1)
        self.assertIn('absent.json', completed.stderr)


if __name__ == '__main__':
    unittest.main()
