#!/usr/bin/env python3
"""The state reader's own arithmetic, its buckets, and the four ways it refuses.

## What is being pinned

`tools/state-relation.py` exists because "nine wrong `KU` answers" is not a diagnosis: an answer that repeats a
value the corpus had already replaced, an answer that takes a value stated *after* the gold, and an answer whose
value the window never carried are three different bugs, and the next arm depends on knowing which one it faces.

The instrument has four ways to be wrong that no later reading would catch:

1. **A numeral read out of a date or a list marker.** Answers in this corpus cite evidence as `[2023/04/30]`, and
   assistant turns answer with numbered lists, so `2023`, `4` and `30` -- and `5.` -- arrive as values. The first
   version of this tool put seventeen correct answers in `both` on citations alone, and dated one question's
   current state to a turn about art events because its fifth bullet read `5.`.
2. **A gold located anywhere.** `five`, `20` and `7` occur in unrelated turns, so a gold "located" by any turn
   containing the numeral is dated by the latest coincidence. `f9e8c073` is the case: its gold is never stated in
   the window, but an unrelated `5` on 07/15 made the answer look superseded instead of undelivered.
3. **A positive control that passes by construction.** The check that a correct answer states its own gold is the
   only evidence the classifier reads text at all; if it is measured over the wrong population, or measured on
   `relation == current` so that every hedged answer counts as a failure, it says nothing.
4. **A refusal that is missing.** An artifact whose turns carry no timestamps, or whose numbered correct answers
   are too few to control, produces a tidy distribution about the instrument.

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


states = _load('state-relation')


def turn(stamp: str, text: str, role: str = 'user') -> dict:
    return {'index': 0, 'text': f'[{stamp}] {role}: {text}'}


def record(**fields) -> dict:
    base = {
        'questionId': 'q',
        'capability': 'KU',
        'question': 'How many dozen eggs do we currently have stocked up?',
        'groundTruth': '20',
        'answer': '20',
        'correct': True,
        'turns': [turn('2023/03/15 (Wed) 08:18', 'we have 20 dozen eggs stocked up')],
    }
    base.update(fields)
    return base


def artifact(questions: list[dict], name: str | None = None) -> Path:
    """A one-artifact file with the given questions.

    `name` renames the temporary file to an exact name, which exists because a verdict
    must not depend on where its input happens to live. `NamedTemporaryFile` draws a
    random suffix, and one of the drawn suffixes in this suite was `...c1.json` -- the
    id of a *correct* row -- which made an assertion about the printed TABLE fail on the
    printed PREAMBLE. Naming the file is how a test states that constraint instead of
    hoping the randomiser respects it.
    """
    handle = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8')
    with handle:
        json.dump({'questions': questions}, handle)
    path = Path(handle.name)
    if name is None:
        return path
    renamed = path.with_name(name)
    path.replace(renamed)
    return renamed


def table_rows(printed: str) -> list[str]:
    """The row ids the audit printed, in order.

    ## Why the verdict is read from the table and not from the whole output

    The audit prints its account first -- `artifact  : <path>` among it -- and the table
    after a blank line. Asserting `assertNotIn('c1', printed)` over the whole text
    therefore asserted something about the *path*: when the temporary file was drawn as
    `.../tmp0yp58mc1.json`, the substring `c1` appeared in the preamble and the test went
    red while the audit was correct. Measured, twice: red on the first run, green on the
    second with no code change.

    A table assertion has to be evaluated at the table's own coordinates, and the ids are
    the first field of every indented line. Reading them exactly is also a stronger claim
    than the absence of a substring: it catches a row printed twice and a row printed that
    should not exist.
    """
    return [
        line.split()[0]
        for line in printed.splitlines()
        if line.startswith('  ') and line.strip() and not line.startswith('   ')
    ]


class StampTest(unittest.TestCase):
    def test_a_prefixed_turn_carries_its_timestamp(self):
        self.assertEqual(states.stamp_of('[2023/03/15 (Wed) 08:18] user: hi'), 202303150818)

    def test_a_turn_without_a_prefix_has_no_timestamp(self):
        # Admission order is not time order, so an unstamped turn cannot be placed and must not be guessed at.
        self.assertIsNone(states.stamp_of('user: hi'))

    def test_the_packing_orders_by_time(self):
        early = states.stamp_of('[2023/03/15 (Wed) 08:18] user: hi')
        late = states.stamp_of('[2023/03/15 (Wed) 09:28] user: hi')
        self.assertLess(early, late)


class ValueTest(unittest.TestCase):
    def test_a_cited_date_contributes_no_value(self):
        # The defect this pins: `[2023/04/30]` read as 2023, 4 and 30 put seventeen correct answers in `both`.
        self.assertEqual(states.values_of('you stated on [2023/04/30] that it was 4'), {'N4'})

    def test_a_numbered_list_marker_contributes_no_value(self):
        # `f9e8c073`'s window held a fifth bullet reading `5. Do you have a preferred budget`, and that `5`
        # dated the gold to a turn about art events.
        self.assertEqual(states.values_of('1. What city\n5. Do you have a budget'), set())

    def test_a_numeral_inside_a_longer_numeral_is_not_a_hit(self):
        self.assertEqual(states.values_of('1200 followers'), {'N1200'})

    def test_a_thousands_separator_is_dropped(self):
        self.assertEqual(states.values_of('$1,300'), {'N1300'})

    def test_a_clock_time_is_one_value_and_not_two_numerals(self):
        self.assertEqual(states.values_of('I go at 6:00 pm'), {'T6:00pm'})

    def test_a_record_is_one_value_and_not_two_numerals(self):
        self.assertEqual(states.values_of('our record is 5-2'), {'R5-2'})

    def test_a_number_word_is_the_digit_it_names(self):
        # Half the golds in this corpus are words, and a reader that answers `5` has stated `five`.
        self.assertEqual(states.values_of('five'), states.values_of('5'))


class BucketTest(unittest.TestCase):
    def test_an_answer_that_states_the_gold_is_current(self):
        self.assertEqual(states.relation_of(record())['relation'], 'current')

    def test_an_answer_that_states_the_gold_and_an_older_value_is_both(self):
        question = record(
            answer='It was 30 dozen, now 20 dozen',
            turns=[
                turn('2023/01/11 (Wed) 23:15', 'we have 30 dozen eggs'),
                turn('2023/03/15 (Wed) 08:18', 'we have 20 dozen eggs'),
            ],
        )
        self.assertEqual(states.relation_of(question)['relation'], 'both')

    def test_an_answer_that_only_states_the_replaced_value_is_older(self):
        question = record(
            answer='30 dozen',
            turns=[
                turn('2023/01/11 (Wed) 23:15', 'we have 30 dozen eggs'),
                turn('2023/03/15 (Wed) 08:18', 'we have 20 dozen eggs'),
            ],
        )
        row = states.relation_of(question)
        self.assertEqual(row['relation'], 'older')
        self.assertEqual(row['placed'], {'N30': 'older'})

    def test_an_answer_that_only_states_a_later_value_is_newer(self):
        # The mechanism this bucket exists to catch: a reader that applies "newest wins" where the question
        # asked about an earlier period.
        question = record(
            question='How many eggs do we currently have stocked up?',
            answer='40 dozen',
            turns=[
                turn('2023/03/15 (Wed) 08:18', 'we have 20 dozen eggs'),
                turn('2023/04/02 (Sun) 10:04', 'we now have 40 dozen eggs'),
            ],
        )
        self.assertEqual(states.relation_of(question)['relation'], 'newer')

    def test_a_value_stated_on_both_sides_of_the_gold_is_overlap_rather_than_guessed(self):
        question = record(
            answer='30 dozen',
            turns=[
                turn('2023/01/11 (Wed) 23:15', 'we have 30 dozen eggs'),
                turn('2023/03/15 (Wed) 08:18', 'we have 20 dozen eggs'),
                turn('2023/04/02 (Sun) 10:04', 'the eggs are at 30 dozen again'),
            ],
        )
        self.assertEqual(states.relation_of(question)['relation'], 'overlap')

    def test_values_on_both_sides_are_mixed(self):
        question = record(
            answer='30 dozen and 40 dozen',
            turns=[
                turn('2023/01/11 (Wed) 23:15', 'we have 30 dozen eggs'),
                turn('2023/03/15 (Wed) 08:18', 'we have 20 dozen eggs'),
                turn('2023/04/02 (Sun) 10:04', 'we now have 40 dozen eggs'),
            ],
        )
        self.assertEqual(states.relation_of(question)['relation'], 'mixed')

    def test_a_window_that_never_states_the_gold_is_unanchored(self):
        question = record(answer='37', turns=[turn('2023/05/27 (Sat) 18:09', 'I have 37 coins')])
        self.assertEqual(states.relation_of(question)['relation'], 'gold-not-in-window')

    def test_an_unrelated_turn_cannot_date_the_gold(self):
        # The gold is `20` and it is stated on 03/15. A turn on 04/02 about a subscriber count contains `20` too,
        # and without the attribute condition that turn becomes the latest statement of the current state -- which
        # moves the answer's 30 from *after* the gold to *before* it, i.e. flips `newer` into `older` and hides the
        # one failure mode the buckets exist to separate. Measured on `42533236864`: zero of its 51 numbered rows
        # depend on this condition, so it is a guard against a shape that corpus does not contain, not a filter
        # that shaped the reading.
        question = record(
            answer='30 dozen',
            turns=[
                turn('2023/03/15 (Wed) 08:18', 'we have 20 dozen eggs in the refrigerator'),
                turn('2023/03/20 (Mon) 09:00', 'we bought 30 dozen eggs for the party'),
                turn('2023/04/02 (Sun) 10:04', 'my channel just passed 20 thousand subscribers'),
            ],
        )
        self.assertEqual(states.relation_of(question)['relation'], 'newer')

    def test_an_answer_whose_value_the_window_never_stated_is_only_in_answer(self):
        question = record(answer='27', turns=[turn('2023/03/15 (Wed) 08:18', 'we have 20 dozen eggs')])
        self.assertEqual(states.relation_of(question)['relation'], 'only-in-answer')

    def test_a_phrase_gold_leaves_the_denominator(self):
        # `Paris`, `Yes.`, `in a shoe rack in my closet`: the pool has no current this instrument can name, and
        # forcing them into `neither` would put twenty `KU` questions in a bucket that means nothing.
        question = record(groundTruth='in a shoe rack in my closet', answer='Under my bed')
        self.assertEqual(states.relation_of(question)['relation'], 'unnumbered')

    def test_an_undated_turn_is_counted_rather_than_placed(self):
        question = record(turns=[{'text': 'user: we have 20 dozen eggs'}])
        self.assertEqual(states.relation_of(question)['undatedTurns'], 1)


class RefusalTest(unittest.TestCase):
    def run_cli(self, path: Path) -> tuple[object, str]:
        """`(status, output)`. A refusal raises `SystemExit` with the message as its code, which is how every
        tool in this directory refuses: the message is the whole finding, and a bare exit code would lose it."""
        out = io.StringIO()
        status: object = 0
        with contextlib.redirect_stdout(out):
            try:
                states.main([str(path)])
            except SystemExit as exit_:
                status = exit_.code
        return status, out.getvalue()

    def test_an_artifact_without_a_roster_is_refused(self):
        handle = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False, encoding='utf-8')
        with handle:
            json.dump({'dataset': 'longmemeval'}, handle)
        status, _ = self.run_cli(Path(handle.name))
        self.assertNotEqual(status, 0)

    def test_an_artifact_whose_turns_carry_no_timestamps_is_refused(self):
        # No ordering means no value can be older or newer than another, and a distribution over `older 0` would
        # be a fact about the artifact's capture rather than about the run.
        path = artifact([record(turns=[{'text': 'user: we have 20 dozen eggs'}])])
        status, _ = self.run_cli(path)
        self.assertNotEqual(status, 0)

    def test_an_artifact_with_no_correct_answer_to_control_on_is_refused(self):
        path = artifact([record(correct=False, answer='30 dozen')])
        status, _ = self.run_cli(path)
        self.assertNotEqual(status, 0)

    def test_a_refusal_over_two_populations_names_each_one_s_control(self):
        # `--capability all` mixes populations, and a single number would read as an instrument defect. `TR` is
        # the one that drags it down here: a graded-correct answer that states no clock time at all.
        path = artifact(
            [
                record(questionId='k1', answer='20'),
                record(questionId='k2', answer='20'),
                record(questionId='k3', answer='20'),
                record(questionId='k4', answer='20'),
                record(questionId='t1', capability='TR', groundTruth='7:30 am', answer='started the role'),
                record(questionId='t2', capability='TR', groundTruth='7:30 am', answer='started the role'),
            ]
        )
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            with self.assertRaises(SystemExit) as refusal:
                states.main([str(path), '--capability', 'all'])
        message = str(refusal.exception.code)
        self.assertIn('KU 100.0%', message)
        self.assertIn('TR 0.0%', message)

    def test_an_artifact_whose_control_falls_below_the_floor_is_refused(self):
        # A correct answer states its gold. Three hedged answers that do not are enough to make the split of the
        # wrong answers a fact about the classifier, and the refusal says so with the number.
        path = artifact(
            [
                record(questionId='c1', answer='20'),
                record(questionId='c2', answer='nothing of the sort'),
                record(questionId='c3', answer='nothing of the sort'),
                record(questionId='c4', answer='nothing of the sort'),
                record(questionId='w1', correct=False, answer='30 dozen'),
            ]
        )
        status, _ = self.run_cli(path)
        self.assertNotEqual(status, 0)


class ReportTest(unittest.TestCase):
    def reading(self) -> dict:
        return states.read(
            artifact(
                [
                    record(questionId='c1', answer='20'),
                    record(questionId='c2', answer='20'),
                    record(questionId='c3', answer='20'),
                    record(questionId='c4', answer='20'),
                    record(
                        questionId='w1',
                        correct=False,
                        answer='30 dozen',
                        turns=[
                            turn('2023/01/11 (Wed) 23:15', 'we have 30 dozen eggs'),
                            turn('2023/03/15 (Wed) 08:18', 'we have 20 dozen eggs'),
                        ],
                    ),
                ]
            ),
            'KU',
        )

    def test_the_capability_split_sums_to_the_total(self):
        totals = self.reading()['totals']
        self.assertEqual(totals['numbered'] + totals['unnumbered'], totals['rows'])
        self.assertEqual(sum(totals['all'].values()), totals['rows'])
        self.assertEqual(sum(totals['correct'].values()) + sum(totals['wrong'].values()), totals['rows'])

    def test_the_control_is_reported_beside_the_distribution(self):
        reading = self.reading()
        self.assertEqual(reading['totals']['correctNumbered'], 4)
        self.assertEqual(reading['goldFoundShareOnCorrect'], 1.0)

    def test_a_hedged_answer_counts_as_control_success_rather_than_failure(self):
        # `both` means the answer states the gold beside an older value, which is a hedge and not a miss.
        path = artifact(
            [
                record(
                    answer='It was 30 dozen, now 20 dozen',
                    turns=[
                        turn('2023/01/11 (Wed) 23:15', 'we have 30 dozen eggs'),
                        turn('2023/03/15 (Wed) 08:18', 'we have 20 dozen eggs'),
                    ],
                ),
                record(questionId='c2'),
                record(questionId='c3'),
                record(questionId='c4'),
                record(questionId='w1', correct=False, answer='30 dozen'),
            ]
        )
        reading = states.read(path, 'KU')
        self.assertEqual(reading['totals']['correct']['both'], 1)
        self.assertEqual(reading['goldFoundShareOnCorrect'], 1.0)

    def test_the_capability_filter_selects_one_capability(self):
        path = artifact([record(capability='KU'), record(questionId='m1', capability='MR')])
        self.assertEqual(states.read(path, 'KU')['totals']['rows'], 1)
        self.assertEqual(states.read(path, 'MR')['totals']['rows'], 1)
        self.assertEqual(states.read(path, None)['totals']['rows'], 2)

    def test_json_mode_emits_one_object_per_artifact(self):
        path = artifact([record(), record(questionId='c2'), record(questionId='c3'), record(questionId='c4')])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            states.main([str(path), '--json'])
        lines = [line for line in out.getvalue().splitlines() if line.strip()]
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0])['totals']['rows'], 4)

    def test_audit_prints_the_wrong_rows_and_their_decision(self):
        path = artifact(
            [
                record(questionId='c1'),
                record(questionId='c2'),
                record(questionId='c3'),
                record(questionId='c4'),
                record(
                    questionId='w1',
                    correct=False,
                    answer='30 dozen',
                    turns=[
                        turn('2023/01/11 (Wed) 23:15', 'we have 30 dozen eggs'),
                        turn('2023/03/15 (Wed) 08:18', 'we have 20 dozen eggs'),
                    ],
                ),
            ]
        )
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            states.main([str(path), '--audit'])
        printed = out.getvalue()
        self.assertIn('w1', printed)
        self.assertIn('older', printed)
        self.assertEqual(table_rows(printed), ['w1'], 'the audit printed a row that was correct')

    def test_the_verdict_does_not_depend_on_the_artifact_path(self):
        """A path that contains a row id must not change what the audit says.

        This is the regression the previous assertion would have hidden: it read the whole
        output, so an artifact at `.../c1-c2-w1.json` made the *correct* ids appear in the
        preamble and the test fail against a correct audit. Naming the file moves the
        coincidence from "sometimes, when the randomiser cooperates" to "always", which is
        what makes it a test.
        """
        path = artifact(
            [
                record(questionId='c1'),
                record(questionId='c2'),
                record(
                    questionId='w1',
                    correct=False,
                    answer='30 dozen',
                    turns=[
                        turn('2023/01/11 (Wed) 23:15', 'we have 30 dozen eggs'),
                        turn('2023/03/15 (Wed) 08:18', 'we have 20 dozen eggs'),
                    ],
                ),
            ],
            name='c1-c2-w1-rows.json',
        )
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            states.main([str(path), '--audit'])
        printed = out.getvalue()
        self.assertIn('c1', printed, 'the preamble must still name the file it read')
        self.assertEqual(table_rows(printed), ['w1'])


if __name__ == '__main__':
    unittest.main()
