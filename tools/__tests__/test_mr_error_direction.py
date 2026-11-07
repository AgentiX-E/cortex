"""Tests for `tools/mr-error-direction.py`, the arithmetic §13.290's first prediction is stated in.

The tool exists because §13.289.4's classification — eighteen below the gold against four above — was
done by hand, and a prediction written in a hand-counted quantity cannot be checked by machine when the
next artifact arrives. The tests below are written the way the classification is argued: every bucket
is a claim about what the failure *is*, so most of them are about a record that could plausibly have
landed in the wrong one.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from importlib import import_module

direction = import_module("mr-error-direction")

REPO = pathlib.Path(__file__).resolve().parents[2]


def record(*, gold='4', answer='2', correct=False, capability='MR', qid='q1') -> dict:
    return {
        'questionId': qid,
        'capability': capability,
        'correct': correct,
        'groundTruth': gold,
        'answer': answer,
    }


class TestReadingANumber:
    def test_digits_win_over_words(self):
        # A gold that names two figures has to price at the first, otherwise a range reads as its
        # upper bound and a correct answer beneath it looks like an omission.
        assert direction.first_number('5 days. 6 days (including the last day) is also acceptable.') == 5
        assert direction.first_number('$5,850') == 5850
        assert direction.first_number('70 pounds') == 70

    def test_a_number_word_is_a_count(self):
        # Five of §13.289's failures have a gold in words. A tool that skipped them would report five
        # counting questions as unpriceable and the below:above ratio would be computed on 22 of 27.
        assert direction.first_number('three') == 3
        assert direction.first_number('I attended four movie festivals.') == 4
        assert direction.first_number('I replaced or fixed five items: the faucet, the mat') == 5

    def test_no_figure_at_all(self):
        assert direction.first_number('') is None
        assert direction.first_number(None) is None
        assert direction.first_number('Thrive Market') is None


class TestTheBuckets:
    def test_below_and_above(self):
        assert direction.classify(record(gold='23', answer='22')) == 'below'
        assert direction.classify(record(gold='99', answer='100')) == 'above'

    def test_equal_is_its_own_bucket(self):
        # A numerically equal answer the judge scored wrong is a judge question, not a counting one.
        # Folding it into either side would attribute it to the mechanism this tool measures.
        assert direction.classify(record(gold='$495', answer='495 dollars')) == 'equal'

    def test_a_decline_is_not_a_small_answer(self):
        for answer in (None, '', '   ', direction.SENTINEL):
            assert direction.classify(record(answer=answer)) == 'declined'

    def test_an_evidence_echo_is_not_below(self):
        # The echo starts with a figure, so a tool that priced before it looked would report it as
        # `below` — and the two records in `42310779222` that do this are reply-shape failures whose
        # replies go on to decline in prose.
        echo = '1. [2023/05/27 (Sat) 03:55] user: Mentions a new release originally priced at $30.'
        assert direction.classify(record(gold='20%', answer=echo)) == 'echo'

    def test_a_text_gold_is_unpriced_rather_than_wrong(self):
        assert direction.classify(record(gold='Thrive Market', answer='Walmart')) == 'unpriced'
        assert direction.classify(record(gold='5 days. 6 days', answer='Cannot determine from the context.')) == 'unpriced'


class TestTheCensus:
    def test_only_failures_are_counted(self):
        summary = direction.census([record(correct=True), record(correct=False)], 'MR')
        assert summary['correct'] == 1
        assert summary['failures'] == 1
        assert summary['counts']['below'] == 1

    def test_priced_is_the_sum_of_the_three_numeric_buckets(self):
        records = [
            record(gold='4', answer='2'),
            record(gold='4', answer='9'),
            record(gold='4', answer='4'),
            record(gold='4', answer='Thrive Market'),
            record(gold='4', answer=''),
        ]
        summary = direction.census(records, 'MR')
        assert summary['priced'] == 3
        assert summary['priced'] == sum(summary['counts'][k] for k in ('below', 'above', 'equal'))

    def test_another_capability_is_not_counted(self):
        summary = direction.census([record(capability='IE')], 'MR')
        assert summary['failures'] == 0


class TestTheReading:
    def test_the_ratio_is_printed_and_the_buckets_are_named(self):
        summary = direction.census([record(gold='4', answer='2'), record(gold='4', answer='9')], 'MR')
        text = direction.render(summary)
        assert 'below:above = 1:1' in text
        assert 'an evidence turn copied back' in text

    def test_the_ratio_is_omitted_when_nothing_is_priced(self):
        text = direction.render(direction.census([record(answer='')], 'MR'))
        assert 'below:above' not in text

    def test_a_report_without_questions_is_refused(self, tmp_path):
        path = tmp_path / 'report.json'
        path.write_text(json.dumps({'questions': None}))
        assert direction.main([str(path)]) == 2


class TestTheSentinel:
    def test_the_copy_matches_the_product(self):
        # The tool reads an artifact on disk and restates the sentinel rather than importing it; a
        # restatement that drifts silently would classify every decline as an answer, which is the one
        # bucket whose count changes the reading.
        source = (REPO / 'packages' / 'cortex-memory' / 'src' / 'parse.ts').read_text()
        found = re.search(r"ABSTAIN_TOKEN\s*=\s*'([^']+)'", source)
        assert found, 'ABSTAIN_TOKEN is no longer a plain string literal in parse.ts'
        assert found.group(1) == direction.SENTINEL


@pytest.mark.parametrize(('gold', 'answer', 'expected'), [
    ('2', '0', 'below'),
    ('0.5 hours', '0 hours', 'below'),
    ('1,998', '1,456', 'below'),
    ('three', '1', 'below'),
    ('$5,850', '$5,250', 'below'),
])
def test_the_five_shapes_of_a_below_gold_failure(gold, answer, expected):
    # §13.289.4's table, as an executable statement: an integer count, a duration, a thousands-separated
    # figure, a number word and a currency amount all price the same way.
    assert direction.classify(record(gold=gold, answer=answer)) == expected
