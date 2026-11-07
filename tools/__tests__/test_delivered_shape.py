"""Tests for `tools/delivered-shape.py`: the shape of what the reader was shown.

The tool exists because every field the arm already records describes the **plan** -- `evidenceTurns`,
`turns`, `windowComposition` -- while the reader was handed an assembled string. §13.283's defect
lived in exactly that gap. So the measurement has to come from `featurePromptTexts`, and the only
thing standing between the prompt text and a wrong number is the parser.

That makes the parser the subject of most of these tests, and the one that matters is the first
one: a turn's **body** routinely contains lines beginning with a number and a period, because the
assistant writes numbered lists. A parser keyed on that pattern cuts one turn into ten.
"""

from __future__ import annotations

import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from importlib import import_module

shape_tool = import_module("delivered-shape")

NOTE = '\n\nSome evidence is grouped into sessions'


def session(index: int, *turns: str, stamp: str = '2023/05/22 (Mon) 19:41') -> str:
    body = '\n\n'.join(f'{n}. [{stamp}] user: {text}' for n, text in enumerate(turns, start=1))
    return f'Session {index}\n{body}'


def prompt(*sessions: str, question: str = 'QUESTION: how many items?', instruction: str = 'Answer.') -> str:
    return f'{instruction}\n\nEVIDENCE:\n' + '\n\n'.join(sessions) + f'{NOTE}\n\n{question}\n\nAnswer:'


class TestTheParse:
    def test_a_numbered_line_inside_a_turn_is_not_a_turn(self):
        # The defect that produced a wrong reading first: the assistant answers "here are ten topics"
        # and writes 1..10 at line start. Counting those as turns reported 155 turns per question
        # against the artifact's own 200, and every per-session number was then a fraction of itself.
        body = 'Sure, here are the topics:\n\n1. Introduction\n2. Types\n3. Sources'
        parsed = shape_tool.shape(prompt(session(1, 'list the topics', body)))
        assert parsed['sessions'] == 1
        assert parsed['sessionTurns'] == [2]
        assert parsed['turnChars'][1] == len('2. [2023/05/22 (Mon) 19:41] user: ' + body)

    def test_a_turn_is_the_whole_block_that_follows_its_marker(self):
        long_body = 'a' * 500
        parsed = shape_tool.shape(prompt(session(1, long_body, 'second')))
        assert parsed['sessionTurns'] == [2]
        assert parsed['turnChars'][0] > 500

    def test_a_marker_without_the_rendered_prefix_is_text(self):
        # `1. ` alone names nothing; the prefix the renderer emits is what identifies a turn.
        text = 'EVIDENCE:\nSession 1\n1. not a turn, no timestamp\n\n2. [2023/05/22 (Mon) 19:41] user: real' + NOTE
        parsed = shape_tool.shape(text)
        assert parsed['sessionTurns'] == [1]

    def test_a_flat_prompt_has_no_sessions_rather_than_one(self):
        # A flat route is one implicit session for the budget. Reporting `1` here would let it be
        # averaged into a per-session statistic it has no terms in.
        parsed = shape_tool.shape('Answer.\n\nEVIDENCE:\n1. [2023/05/22 (Mon) 19:41] user: hi\n\nQUESTION: q\n\nAnswer:')
        assert parsed['sessions'] == 0
        assert parsed['sessionChars'] == []

    def test_the_boundary_note_is_not_evidence(self):
        # The note explains the boundaries and is allocated separately by the builder. Counting it
        # into the last session would make the longest session's size depend on the note's wording.
        parsed = shape_tool.shape(prompt(session(1, 'only turn')))
        assert parsed['sessionChars'][0] == len(session(1, 'only turn'))


class TestTheSelfCheck:
    def _measure(self, claimed: int | None, **kwargs):
        record = {'questionId': 'q1', 'capability': 'MR', 'correct': True}
        if claimed is not None:
            record['windowComposition'] = {'turns': claimed}
        summary = shape_tool.measure([record], [prompt(session(1, 'a', 'b'))], kwargs.get('capability'))
        return summary

    def test_a_parser_that_reproduces_the_arms_own_count_reports_no_disagreement(self):
        assert self._measure(2)['disagreements'] == []

    def test_a_parser_that_does_not_is_a_failure_rather_than_a_reading(self):
        summary = self._measure(9)
        assert summary['disagreements'] and 'parsed 2, recorded 9' in summary['disagreements'][0]

    def test_an_absent_count_is_skipped_rather_than_counted_as_agreement(self):
        # An absent number is not a matching one: counting it as agreement would let a run whose
        # records carry no `windowComposition` print a clean self-check it never ran.
        summary = self._measure(None)
        assert summary['disagreements'] == []
        assert summary['boundaries']

    def test_the_exit_code_carries_the_disagreement(self, tmp_path):
        report = {
            'questions': [{'questionId': 'q1', 'capability': 'MR', 'correct': True, 'windowComposition': {'turns': 7}}],
            'ablation': {'featurePromptTexts': [prompt(session(1, 'a'))]},
        }
        path = tmp_path / 'report.json'
        path.write_text(json.dumps(report))
        assert shape_tool.main([str(path), '--capability', 'MR']) == 1

    def test_a_report_without_prompt_texts_is_refused(self, tmp_path):
        path = tmp_path / 'report.json'
        path.write_text(json.dumps({'questions': [], 'ablation': {}}))
        assert shape_tool.main([str(path)]) == 2


class TestTheAggregate:
    def _summary(self, correctness, capability='MR'):
        records = [
            {'questionId': f'q{i}', 'capability': capability, 'correct': ok} for i, ok in enumerate(correctness)
        ]
        prompts = [prompt(session(1, 'a', 'b'), session(2, 'c')) for _ in correctness]
        return shape_tool.measure(records, prompts, capability)

    def test_evidence_characters_exclude_the_instruction_block(self):
        # The instruction block and the question are constant per record; including them would make
        # the shape look heavier without the reader receiving anything more.
        summary = self._summary([True])
        one = session(1, 'a', 'b')
        two = session(2, 'c')
        assert summary['all']['charsPerQuestion'] == len(one) + len(two)

    def test_the_two_outcomes_are_measured_separately(self):
        summary = self._summary([True, True, False])
        assert summary['correct']['n'] == 2
        assert summary['incorrect']['n'] == 1

    def test_an_empty_population_reports_none_rather_than_zero(self):
        # A median of zero would read as "the delivery was empty"; there was no delivery to measure.
        summary = self._summary([True, True])
        assert summary['incorrect']['n'] == 0
        assert summary['incorrect']['charsPerSession'] is None

    def test_another_capability_is_not_measured(self):
        summary = self._summary([True], capability='MR')
        assert summary['all']['n'] == 1
        assert shape_tool.measure(
            [{'questionId': 'q', 'capability': 'IE', 'correct': True}], [prompt(session(1, 'a'))], 'MR'
        )['all']['n'] == 0

    def test_a_capability_with_no_boundaries_says_so(self):
        summary = shape_tool.measure(
            [{'questionId': 'q', 'capability': 'IE', 'correct': True}],
            ['Answer.\n\nEVIDENCE:\n1. [2023/05/22 (Mon) 19:41] user: hi\n\nQUESTION: q\n\nAnswer:'],
            'IE',
        )
        assert 'nothing to measure' in shape_tool.render(summary)


class TestTheReading:
    def test_the_shape_table_prints_the_medians_it_computed(self):
        records = [{'questionId': 'q1', 'capability': 'MR', 'correct': True}]
        summary = shape_tool.measure(records, [prompt(session(1, 'a', 'b'), session(2, 'c'))], 'MR')
        text = shape_tool.render(summary)
        assert 'sessions per question' in text and '2.0' in text
        assert 'turns per session' in text

    @pytest.mark.parametrize('quantity', ['sessionsPerQuestion', 'turnsPerQuestion', 'charsPerSession'])
    def test_every_printed_quantity_exists_on_the_aggregate(self, quantity):
        # The render function and the aggregate are edited in different places; a name that exists on
        # one and not the other is a KeyError at print time, after the measurement has been paid for.
        summary = shape_tool.measure([], [], None)
        assert quantity in summary['all']
