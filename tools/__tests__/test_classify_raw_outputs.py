"""Tests for `tools/classify-raw-outputs.py`.

## What this file protects

Section 60.2 of `docs/09-progress-and-delivery-report.md` states that three model
behaviours all collapse to a `null` answer:

    INSUFFICIENT_EVIDENCE                      bare
    Answer: INSUFFICIENT_EVIDENCE              labelled
    ...explanation...\\nINSUFFICIENT_EVIDENCE    token after prose

The classifier's whole job is to keep those three apart, because each selects a
different repair. A classifier that merged them would produce a number that looks
like a measurement and cannot choose an intervention -- which is the failure
section 60 records one layer down.

## Why the boundaries are tested and not just the buckets

`parseAnswer` reads the LAST non-empty line and strips an optional `Answer:`
label. Both facts are boundaries: a classifier that read the first line would
call a deliberating model a bare responder, and a classifier that treated
`Answer: X` as prose would lose the exact case `stripLabel` exists for. The tests
below pin both.

## Why the three absent states are tested

`QuestionRecord.rawOutput` is declared `string | null | undefined`, and the three
mean different things: `undefined` is a recording gap, `null` is a model that was
not consulted, a string is what was captured. The first draft of the tool used
`dict.get`, which maps a missing key and a JSON `null` to one value, and the tool
would have reported a capture failure as reader behaviour. That is section 61's
own defect class reappearing in the reader, so it is pinned here.

## Fixtures

Every fixture is an ordinary string with no shell significance, so this file can
be written by any means. Contrast `test_check_shell_interpolation.py`, whose
fixtures must be assembled because they ARE the hazard.
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'classify-raw-outputs.py'


def _load_module():
    spec = importlib.util.spec_from_file_location('classify_raw', TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


_MODULE = _load_module()
classify = _MODULE.classify
MISSING = _MODULE.MISSING
SUM = 'INSUFFICIENT_EVIDENCE'


class TestTheBucketsAreKeptApart:
    """Three behaviours, three names. Merging them is the defect."""

    def test_a_bare_token_is_bare(self) -> None:
        assert classify(SUM) == 'bare'

    def test_a_labelled_token_is_labelled(self) -> None:
        assert classify(f'Answer: {SUM}') == 'labelled'

    def test_a_token_after_prose_is_its_own_bucket(self) -> None:
        """The model deliberated and the harness threw the deliberation away.

        This is the bucket whose existence decides whether the next intervention
        is the instruction text or the parser.
        """
        assert classify(f'I checked the memory and found nothing.\n\n{SUM}') == 'prose-then-token'

    def test_the_three_buckets_are_three_answers(self) -> None:
        """Stated as a single assertion so a future merge fails one obvious test.

        The three inputs have different repairs; if two of them ever classify the
        same way, one of the repairs has been silently dropped.
        """
        assert len({classify(SUM), classify(f'Answer: {SUM}'), classify(f'prose\n{SUM}')}) == 3


class TestTheBoundariesParseAnswerUses:
    """`parseAnswer` reads the LAST line and strips a label. So does this."""

    def test_prose_before_a_labelled_token_keeps_both_facts(self) -> None:
        assert classify(f'why not\nAnswer: {SUM}') == 'prose-labelled'

    def test_the_last_line_decides_not_the_first(self) -> None:
        """A first-line read would call this bare. It is not: the last line is prose."""
        assert classify(f'{SUM}\nActually, let me reconsider.') == 'other'

    def test_trailing_blank_lines_do_not_change_the_bucket(self) -> None:
        assert classify(f'{SUM}\n\n\n') == 'bare'

    def test_leading_blank_lines_do_not_change_the_bucket(self) -> None:
        assert classify(f'\n\n{SUM}') == 'bare'

    @pytest.mark.parametrize(
        'raw',
        [f'answer: {SUM}', f'ANSWER: {SUM}', f'Answer:{SUM}', f'Answer : {SUM}'],
    )
    def test_the_label_is_recognised_the_way_the_parser_recognises_it(self, raw: str) -> None:
        """Case, spacing and absence of a space after the colon are all tolerated.

        `parseAnswer` is case-insensitive and whitespace-tolerant; a classifier
        narrower than the parser would report `other` for text the parser reads
        correctly, and the report would then describe a defect that is not there.
        """
        assert classify(raw) == 'labelled'


class TestTheThreeAbsentStatesAreDistinct:
    """A recording gap, a machine abstention, and an unexpected answer differ.

    `QuestionRecord` declares `rawOutput?: string | null`, and section 61's own
    docstring states the distinction: `undefined` is "nobody captured", `null` is
    "the model was not consulted". Collapsing them is how a capture failure reads
    as a change in model behaviour.
    """

    def test_a_missing_key_is_not_captured(self) -> None:
        assert classify(MISSING) == 'not-captured'

    def test_a_null_is_not_consulted(self) -> None:
        assert classify(None) == 'not-consulted'

    def test_the_two_are_different_buckets(self) -> None:
        assert classify(MISSING) != classify(None)

    def test_an_empty_string_is_its_own_bucket(self) -> None:
        assert classify('') == 'empty'

    def test_a_whitespace_only_text_is_empty(self) -> None:
        assert classify('   \n  \n') == 'empty'

    def test_a_decline_in_other_words_is_other(self) -> None:
        """The model declined, but not with the token. Real, and not a gap."""
        assert classify('No relevant memories were found.') == 'other'

    def test_a_real_answer_is_other_not_absent(self) -> None:
        """A correct answer is `other` -- captured, and not an abstention.

        This matters because the roster holds every question, not only the
        abstentions. A classifier that returned `bare` for a correct answer would
        inflate the abstention count it is supposed to explain.
        """
        assert classify('Answer: Paris') == 'other'

    def test_a_non_string_payload_is_named_rather_than_crashing(self) -> None:
        """A malformed roster should be visible in the table, not a traceback."""
        assert classify(42) == 'not-a-string'


class TestTheRosterIsRead:
    """The tool must read both producer shapes and say so when it finds neither."""

    def _report(self, tmp_path: Path, key: str, questions: list[dict]) -> Path:
        path = tmp_path / 'report.json'
        path.write_text(json.dumps({key: questions}), encoding='utf-8')
        return path

    def _run(self, path: Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(TOOL), str(path), *args],
            capture_output=True,
            text=True,
            timeout=60,
        )

    def test_the_arm_shape_is_read(self, tmp_path: Path) -> None:
        path = self._report(
            tmp_path,
            'questions',
            [{'capability': 'MR', 'questionId': 'q1', 'rawOutput': SUM}],
        )
        r = self._run(path)
        assert r.returncode == 0, r.stderr
        assert 'MR' in r.stdout
        assert 'bare' in r.stdout

    def test_the_alternate_key_is_read(self, tmp_path: Path) -> None:
        """Two producers write this file; reading one key would look like a gap."""
        path = self._report(
            tmp_path,
            'questionRecords',
            [{'capability': 'TR', 'questionId': 'q2', 'rawOutput': None}],
        )
        r = self._run(path)
        assert r.returncode == 0, r.stderr
        assert 'not-consulted' in r.stdout

    def test_a_missing_raw_output_key_is_reported_as_not_captured(self, tmp_path: Path) -> None:
        """This is the assertion the first draft of the tool would have failed.

        `dict.get('rawOutput')` returns `None` for an absent key, so a roster
        whose capture never ran would have reported every question as a machine
        abstention -- a full, plausible table describing a run that did not
        happen.
        """
        path = self._report(
            tmp_path,
            'questions',
            [{'capability': 'MR', 'questionId': 'q3'}],
        )
        r = self._run(path)
        assert r.returncode == 0, r.stderr
        assert 'not-captured' in r.stdout
        assert 'not-consulted' not in r.stdout

    def test_a_report_with_no_roster_is_an_error_not_a_zero(self, tmp_path: Path) -> None:
        """exit 2, never a silent zero: an empty roster and a missing one differ."""
        path = tmp_path / 'report.json'
        path.write_text(json.dumps({'summary': {}}), encoding='utf-8')
        r = self._run(path)
        assert r.returncode == 2
        assert 'no per-question roster' in r.stderr

    def test_the_capability_filter_excludes_the_others(self, tmp_path: Path) -> None:
        path = self._report(
            tmp_path,
            'questions',
            [
                {'capability': 'MR', 'questionId': 'a', 'rawOutput': SUM},
                {'capability': 'CF', 'questionId': 'b', 'rawOutput': SUM},
            ],
        )
        r = self._run(path, '--capability', 'MR')
        assert r.returncode == 0, r.stderr
        assert 'MR: 1 question(s)' in r.stdout
        assert 'CF: 1 question(s)' not in r.stdout

    def test_a_missing_file_is_an_error(self, tmp_path: Path) -> None:
        r = self._run(tmp_path / 'nope.json')
        assert r.returncode == 2

    def test_the_per_question_detail_names_the_question_id(self, tmp_path: Path) -> None:
        """`questionId`, not `id`: a wrong key would print `?` for every row and
        the table would still look complete."""
        path = self._report(
            tmp_path,
            'questions',
            [{'capability': 'MR', 'questionId': '6a1b2c3d', 'rawOutput': SUM}],
        )
        r = self._run(path)
        assert '6a1b2c3d' in r.stdout
