"""Tests for `tools/arm-delta-decomposition.py`.

## What this tool is for, in one sentence

Two arms of the same dataset differ by N questions; this tool says how much of that N is answer
quality, how much is one arm's answers landing in a different scorer channel, and how much is a
question type where the judge itself is the instrument.

## Why the tool must be able to refuse

It reimplements `metrics.ts`'s four-channel decision in Python. A reimplementation is a second
opinion that can be wrong, so every run re-derives the verdicts it can derive deterministically and
compares them with the `correct` the artifact recorded. Any disagreement means the two graders are
not the same grader, and the tool raises rather than printing a decomposition of a comparison that
did not happen. The tests below pin both halves: the arithmetic when it agrees, and the refusal when
it does not.

## The fixture shape

Real artifacts carry a hundred fields per question. These fixtures carry the six the tool reads, so
a failure names the column that broke rather than a schema.
"""

from __future__ import annotations

import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from importlib import import_module

# The file name carries hyphens like every other tool here, so it is loaded by name rather than
# imported -- the same route `test_cost_ledger.py` takes.
tool = import_module("arm-delta-decomposition")


def question(
    *,
    qid: str,
    text: str,
    gold: object,
    answer: object,
    correct: bool,
    capability: str = 'IE',
) -> dict:
    """One per-question record with the six fields the decomposition reads."""
    return {
        'questionId': qid,
        'question': text,
        'groundTruth': gold,
        'answer': answer,
        'rawOutput': answer,
        'correct': correct,
        'capability': capability,
    }


def report(*, questions: list[dict], path: str = 'fixture.json') -> dict:
    """The smallest artifact the tool accepts: the per-question records and a name."""
    return {
        'dataset': 'fixture',
        'questionCount': len(questions),
        'questions': questions,
        '_path': path,
    }


class TestTheChannelReconstruction:
    """The four channels, re-derived, and the refusal when they disagree."""

    def test_exact_match_is_recognised_without_a_judge(self):
        # `normalizeAnswer` is trim + lower + collapse whitespace, so a difference in case is not a
        # difference in answer and the tool must see the same fact the harness did.
        r = report(
            questions=[
                question(
                    qid='a', text='Q?', gold='Business Administration',
                    answer='  business   ADMINISTRATION ', correct=True,
                )
            ]
        )
        result = tool.reconstruct_channels(r)
        assert result['channels'] == {'structural': 0, 'exact': 1, 'numeric': 0, 'judge': 0}
        assert result['selfCheck'] == 'agrees'

    def test_an_unanswerable_question_is_decided_structurally_in_both_directions(self):
        # `expected === null` is the abstention gold, and the two arms of it are the whole ABS
        # column: declining scores correct, answering scores wrong, and neither consults a judge.
        r = report(
            questions=[
                question(qid='a', text='Q?', gold=None, answer=None, correct=True, capability='ABS'),
                question(qid='b', text='Q?', gold=None, answer='something', correct=False, capability='ABS'),
            ]
        )
        result = tool.reconstruct_channels(r)
        assert result['channels']['structural'] == 2
        assert result['selfCheck'] == 'agrees'

    def test_a_counting_question_with_a_ledger_answer_is_numeric_not_judged(self):
        # `numericAnswerVerdict` compares the gold against every number the answer states, so a
        # ledger whose total is the gold is decided deterministically. This is the rule that lets a
        # multi-session arm be measured at all.
        r = report(
            questions=[
                question(
                    qid='a', text='How many days in total?', gold='17 days',
                    answer='10 days + 7 days = 17 days', correct=True,
                )
            ]
        )
        result = tool.reconstruct_channels(r)
        assert result['channels']['numeric'] == 1

    def test_a_disagreement_with_the_artifact_is_refused_not_reported(self):
        # The artifact says correct; every deterministic channel says wrong. That is not a
        # decomposition, it is two graders disagreeing about the ground truth.
        r = report(
            questions=[question(qid='a', text='How many apples?', gold='5', answer='3', correct=True)]
        )
        with pytest.raises(tool.DecompositionRefused) as caught:
            tool.reconstruct_channels(r)
        assert 'a' in str(caught.value)

    def test_an_artifact_with_no_questions_is_refused(self):
        with pytest.raises(tool.DecompositionRefused):
            tool.reconstruct_channels(report(questions=[]))

    def test_a_judge_verdict_is_taken_from_the_artifact_because_it_cannot_be_derived(self):
        # The one channel whose verdict is not recomputable. Taking it from `correct` is the only
        # option, and the count of how often that happened is what makes the dependence visible.
        r = report(
            questions=[
                question(
                    qid='a', text='Suggest a restaurant.', gold='The user would prefer Thai food',
                    answer='How about a Thai place?', correct=True,
                )
            ]
        )
        result = tool.reconstruct_channels(r)
        assert result['channels']['judge'] == 1
        # Recorded rather than merely used: a decomposition over an arm whose answers mostly reach
        # the judge is a statement about the judge's agreement with the gold, not about the arm.
        assert result['judgeDependence'] == pytest.approx(1.0)


class TestThePairedDecomposition:
    """What moved, on the same questions, in both directions."""

    def _pair(self) -> tuple[dict, dict]:
        # Four questions: one both right, one only A, one only B, one both wrong. The smallest
        # fixture where every cell of the 2x2 is occupied.
        a = report(
            path='a.json',
            questions=[
                question(qid='q1', text='Q1?', gold='x', answer='x', correct=True),
                question(qid='q2', text='Q2?', gold='y', answer='y', correct=True),
                question(qid='q3', text='Q3?', gold='z', answer='not-z', correct=False),
                question(qid='q4', text='Q4?', gold='w', answer='not-w', correct=False),
            ],
        )
        b = report(
            path='b.json',
            questions=[
                question(qid='q1', text='Q1?', gold='x', answer='x', correct=True),
                question(qid='q2', text='Q2?', gold='y', answer='not-y', correct=False),
                question(qid='q3', text='Q3?', gold='z', answer='z', correct=True),
                question(qid='q4', text='Q4?', gold='w', answer='not-w', correct=False),
            ],
        )
        return a, b

    def test_the_four_cells_are_counted_by_question_id_and_not_by_position(self):
        a, b = self._pair()
        result = tool.paired(a, b)
        assert result['matrix'] == {
            'bothRight': 1,
            'onlyA': 1,
            'onlyB': 1,
            'bothWrong': 1,
        }
        assert result['net'] == 0

    def test_a_reordered_artifact_is_the_same_comparison(self):
        # Recording order is not a property of the arm. Pairing by position would turn a resort into
        # a regression, which is why the join is on `questionId`.
        a, b = self._pair()
        shuffled = dict(b)
        shuffled['questions'] = list(reversed(b['questions']))
        assert tool.paired(a, shuffled)['matrix'] == tool.paired(a, b)['matrix']

    def test_two_arms_over_different_question_sets_are_refused(self):
        a, b = self._pair()
        b['questions'] = b['questions'][:3]
        with pytest.raises(tool.DecompositionRefused):
            tool.paired(a, b)

    def test_the_exact_migration_counts_what_the_judge_rescued(self):
        # The measurement `R5` needed and did not have: questions where arm A's answer matched
        # exactly and arm B's did not, and how many of those arm B still got right. A migration the
        # judge rescues is not a loss, and reading the marginal `exact` counts as though it were is
        # the error §13.310 records.
        a, b = self._pair()
        result = tool.paired(a, b)
        assert result['exactMigrated'] == 1
        assert result['exactMigratedStillCorrect'] == 0

    def test_a_migration_the_judge_rescues_is_counted_as_rescued(self):
        a = report(
            path='a.json',
            questions=[question(qid='q1', text='Q?', gold='7', answer='7', correct=True)],
        )
        b = report(
            path='b.json',
            questions=[question(qid='q1', text='Q?', gold='7', answer='7 shirts', correct=True)],
        )
        result = tool.paired(a, b)
        assert result['exactMigrated'] == 1
        assert result['exactMigratedStillCorrect'] == 1


class TestTheCapabilitySlice:
    """The same pairing, restricted to a column, because a net of zero hid two things happening.

    `42533236864` against `43031679630` is `only A 9 / only B 9` and reads as "nothing moved". Inside
    `KU` it is `4 / 5`, and the four it lost are answers that were right before the room grew. A
    dataset-level table cannot show that, and a per-capability table that did not add back up to the
    matrix would be a second opinion rather than a slice -- so the closure is asserted, not trusted.
    """

    def _pair(self) -> tuple[dict, dict]:
        # Six questions over two capabilities: KU buys three and sells two (net +1), IE sells one and
        # buys none (net -1) -- a pair whose overall net is zero and whose two halves are not.
        a = report(
            path='a.json',
            questions=[
                question(qid='k1', text='Q?', gold='the gold', answer='a reply', correct=False, capability='KU'),
                question(qid='k2', text='Q?', gold='the gold', answer='a reply', correct=False, capability='KU'),
                question(qid='k3', text='Q?', gold='the gold', answer='a reply', correct=False, capability='KU'),
                question(qid='k4', text='Q?', gold='the gold', answer='a reply', correct=True, capability='KU'),
                question(qid='k5', text='Q?', gold='the gold', answer='a reply', correct=True, capability='KU'),
                question(qid='i1', text='Q?', gold='the gold', answer='a reply', correct=True, capability='IE'),
            ],
        )
        b = report(
            path='b.json',
            questions=[
                question(qid='k1', text='Q?', gold='the gold', answer='a reply', correct=True, capability='KU'),
                question(qid='k2', text='Q?', gold='the gold', answer='a reply', correct=True, capability='KU'),
                question(qid='k3', text='Q?', gold='the gold', answer='a reply', correct=True, capability='KU'),
                question(qid='k4', text='Q?', gold='the gold', answer='a reply', correct=False, capability='KU'),
                question(qid='k5', text='Q?', gold='the gold', answer='a reply', correct=False, capability='KU'),
                question(qid='i1', text='Q?', gold='the gold', answer='a reply', correct=False, capability='IE'),
            ],
        )
        return a, b

    def test_a_flat_overall_net_can_be_two_opposite_movements(self):
        a, b = self._pair()
        result = tool.paired(a, b)
        assert result['net'] == 0
        assert result['byCapability']['KU']['onlyB'] == 3
        assert result['byCapability']['KU']['onlyA'] == 2
        assert result['byCapability']['IE']['onlyA'] == 1
        assert result['byCapability']['IE']['onlyB'] == 0

    def test_the_columns_sum_to_the_matrix(self):
        # The property that makes the slice a slice: every cell of the 2x2 over all capabilities is
        # the same total as the matrix above it. A record that lost its capability lands in `?`
        # rather than disappearing, which is what keeps this true for a malformed artifact too.
        a, b = self._pair()
        a['questions'][0].pop('capability')
        result = tool.paired(a, b)
        totals = dict.fromkeys(('questions', 'onlyA', 'onlyB', 'bothRight', 'bothWrong'), 0)
        for counts in result['byCapability'].values():
            for key in totals:
                totals[key] += counts[key]
        matrix = result['matrix']
        assert totals['onlyA'] == matrix['onlyA']
        assert totals['onlyB'] == matrix['onlyB']
        assert totals['bothRight'] == matrix['bothRight']
        assert totals['bothWrong'] == matrix['bothWrong']
        assert totals['questions'] == 6
        assert result['byCapability']['?']['questions'] == 1

    def test_the_capability_nets_sum_to_the_overall_net(self):
        a, b = self._pair()
        result = tool.paired(a, b)
        nets = [counts['onlyA'] - counts['onlyB'] for counts in result['byCapability'].values()]
        assert sum(nets) == result['net']

    def test_the_table_is_printed_in_the_dataset_order_and_names_the_net(self):
        a, b = self._pair()
        text = tool.render(tool.paired(a, b))
        assert '| KU |' in text
        assert '| IE |' in text
        # The five known capabilities print in their own order, so two artifacts are comparable as a
        # column; a capability the artifact invented sorts after them.
        assert text.index('| IE |') < text.index('| KU |')

    def test_the_accuracy_columns_are_the_arms_own_counts(self):
        # A acc is `(bothRight + onlyA) / questions`, which is the artifact's own accuracy over the
        # column -- not a second scorer. Reading it any other way would let the table disagree with
        # the report it was built from.
        a, b = self._pair()
        result = tool.paired(a, b)
        counts = result['byCapability']['KU']
        assert (counts['bothRight'] + counts['onlyA']) / counts['questions'] == pytest.approx(2 / 5)
        assert (counts['bothRight'] + counts['onlyB']) / counts['questions'] == pytest.approx(3 / 5)


class TestTheQuestionTypeBreakdown:
    """The decomposition that named the preference column."""

    def test_a_preference_gold_is_recognised_by_its_own_opening(self):
        # LongMemEval's preference golds are written as a description of what a good answer would do
        # ("The user would prefer responses that ..."), which makes the gold a criterion rather than
        # an answer. They are 5.8% of the dataset and, on the M1 pair, 42% of the gap.
        assert tool.is_preference('The user would prefer responses that build upon their ideas.')
        assert not tool.is_preference('Business Administration')
        assert not tool.is_preference(None)

    def test_the_breakdown_separates_preference_from_everything_else(self):
        a = report(
            path='a.json',
            questions=[
                question(
                    qid='p1', text='Suggest something.', gold='The user would prefer Thai food',
                    answer='Thai food', correct=True,
                ),
                question(qid='n1', text='Q?', gold='x', answer='x', correct=True),
            ],
        )
        b = report(
            path='b.json',
            questions=[
                question(
                    qid='p1', text='Suggest something.', gold='The user would prefer Thai food',
                    answer='Thai food', correct=False,
                ),
                question(qid='n1', text='Q?', gold='x', answer='x', correct=True),
            ],
        )
        result = tool.paired(a, b)
        assert result['preference']['questions'] == 1
        assert result['preference']['onlyA'] == 1
        assert result['nonPreference']['onlyA'] == 0


class TestTheRender:
    """Text a reader can check against the two artifacts without re-running the tool."""

    def test_the_render_states_the_self_check_that_licensed_it(self):
        a = report(
            path='a.json',
            questions=[question(qid='q1', text='Q?', gold='x', answer='x', correct=True)],
        )
        b = report(
            path='b.json',
            questions=[question(qid='q1', text='Q?', gold='x', answer='y', correct=False)],
        )
        text = tool.render(tool.paired(a, b))
        assert 'self-check' in text.lower()
        assert 'only a' in text.lower()

    def test_the_render_names_both_artifact_paths(self):
        # The line is only checkable if it says which two files it is about: a decomposition pasted
        # into a report without its inputs is a number nobody can re-derive.
        a = report(
            path='arm-a.json',
            questions=[question(qid='q1', text='Q?', gold='x', answer='x', correct=True)],
        )
        b = report(
            path='arm-b.json',
            questions=[question(qid='q1', text='Q?', gold='x', answer='x', correct=True)],
        )
        text = tool.render(tool.paired(a, b))
        assert 'arm-a.json' in text
        assert 'arm-b.json' in text


class TestTheCommandLine:
    """`main` reads two files and prints the decomposition, or exits non-zero for a refusal."""

    def test_two_paths_produce_a_rendering(self, tmp_path, capsys):
        a = report(
            path='a.json',
            questions=[question(qid='q1', text='Q?', gold='x', answer='x', correct=True)],
        )
        b = report(
            path='b.json',
            questions=[question(qid='q1', text='Q?', gold='x', answer='y', correct=False)],
        )
        pa, pb = tmp_path / 'a.json', tmp_path / 'b.json'
        pa.write_text(json.dumps(a))
        pb.write_text(json.dumps(b))
        assert tool.main([str(pa), str(pb)]) == 0
        assert 'only A' in capsys.readouterr().out

    def test_a_refusal_exits_two_and_says_why(self, tmp_path, capsys):
        broken = [question(qid='q1', text='How many apples?', gold='5', answer='3', correct=True)]
        a = report(path='a.json', questions=broken)
        b = report(path='b.json', questions=broken)
        pa, pb = tmp_path / 'a.json', tmp_path / 'b.json'
        pa.write_text(json.dumps(a))
        pb.write_text(json.dumps(b))
        assert tool.main([str(pa), str(pb)]) == 2
        assert 'refus' in capsys.readouterr().err.lower()

    def test_the_wrong_number_of_arguments_is_usage_error(self, capsys):
        assert tool.main(['only-one.json']) == 1
        assert 'usage' in capsys.readouterr().err.lower()
