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


# --------------------------------------------------------------------------
# §13.38: the failure taxonomy behind a registered prediction
# --------------------------------------------------------------------------

FIXTURES = REPO / 'tools' / '__tests__' / 'fixtures'


class TestTheFailureShapes:
    """The taxonomy §13.34.5's prediction 2 is stated in, and it did not exist as code.

    `numeric_mismatch` appeared in the pre-registration document and in no file of
    this repository. The number behind the prediction (`41 of 47`) was produced by
    an ad-hoc script that was never committed, so the prediction could not be
    re-derived -- which is how a registered prediction becomes a claim about a
    script someone once ran.
    """

    def test_every_abstention_shape_is_the_abstention_shape(self) -> None:
        """A decline is the ARM returning nothing, and each raw shape still reads so.

        The four raw shapes are the sentinel classifier's (`classify`), which is what
        the rosters were built from and is still the tool's other report. A decline is
        now recognised from `answer is None` -- see `TestTheShapeIsReadFromTheAnswer`
        for why the field had to move -- and this asserts that the four shapes still
        produce a decline when the arm reports one.
        """
        for raw in (SUM, f'Answer: {SUM}', f'prose\n{SUM}', f'prose\nAnswer: {SUM}'):
            assert _MODULE.failure_shape({'rawOutput': raw, 'groundTruth': '3', 'answer': None}) == 'abstention', raw

    def test_a_plan_output_is_its_own_shape(self) -> None:
        # On all four archived rosters `answer` and `rawOutput` carry the same string,
        # so a plan output is a plan output whichever field is read. Written with both
        # set, which is the shape the taxonomy was calibrated against.
        plan = 'Let me gather all model kits mentioned across sessions:\n\n1. Session 2: ...'
        assert _MODULE.failure_shape({
            'rawOutput': plan, 'groundTruth': 'five', 'answer': plan}) == 'plan_output'

    def test_step_1_is_a_plan_output(self) -> None:
        plan = 'Step 1: enumerate the sessions\n- Session 3: ...'
        assert _MODULE.failure_shape({
            'rawOutput': plan, 'groundTruth': '3', 'answer': plan}) == 'plan_output'

    def test_a_plan_output_outranks_the_numbers_in_its_own_body(self) -> None:
        """The whole of the disagreement between the two published tables.

        Run 38828538851 answered two numeric MR questions with `Let me gather all
        mentions ... **Session 6**`. The gold and that prose both carry numbers, so
        a rule without the plan bucket calls them numeric mismatches -- which is
        how §13.34.4's `41 of 47` was produced. The detailed taxonomy in §13.26.4
        counts them as `plan_output`, and the same run is then `39`.
        """
        record = {'rawOutput': 'Let me gather all mentions of the count:\n\n**Session 6**: three items',
                  'groundTruth': '10 times', 'answer': 'Let me gather all mentions of the count:\n\n**Session 6**: three items'}
        assert _MODULE.failure_shape(record) == 'plan_output'

    def test_a_prose_refusal_is_soft_and_not_an_abstention(self) -> None:
        """§13.26.4: "the model declined in prose, so it is not counted as an abstention"."""
        assert _MODULE.failure_shape({
            'rawOutput': "I'm sorry, but I don't have enough information to determine the total.",
            'groundTruth': '$185', 'answer': "I'm sorry, but I don't have enough information"}) == 'soft_refusal'

    def test_numbers_that_differ_are_a_numeric_mismatch(self) -> None:
        assert _MODULE.failure_shape({'rawOutput': '2', 'groundTruth': '3', 'answer': '2'}) == 'numeric_mismatch'

    def test_a_currency_pair_is_a_mismatch(self) -> None:
        assert _MODULE.failure_shape({'rawOutput': '2300', 'groundTruth': '$2,500', 'answer': '2300'}) == 'numeric_mismatch'

    def test_a_gold_written_in_words_is_not_a_mismatch(self) -> None:
        """`three` is not a number to a digit extractor, and the published taxonomy
        put these three records in `other` rather than in `numeric_mismatch`."""
        assert _MODULE.failure_shape({'rawOutput': '2', 'groundTruth': 'three', 'answer': '2'}) == 'other'

    def test_a_one_sided_number_is_not_a_mismatch(self) -> None:
        assert _MODULE.failure_shape({'rawOutput': 'IKEA bookshelf', 'groundTruth': '4', 'answer': 'IKEA bookshelf'}) == 'other'

    def test_a_long_answer_that_is_not_a_number_is_long_prose(self) -> None:
        assert _MODULE.failure_shape({
            'rawOutput': 'Based on the evidence, ' + 'x' * 300,
            'groundTruth': 'Thrive Market', 'answer': 'Based on the evidence, ' + 'x' * 300}) == 'long_prose'

    def test_a_long_answer_that_is_a_number_is_a_mismatch(self) -> None:
        """Precedence. `numeric_mismatch` is tested before `long_prose`, which is
        what the detailed published table requires: without that order the two
        buckets swap by one record and neither matches."""
        assert _MODULE.failure_shape({
            'rawOutput': '3 ' + 'y' * 300, 'groundTruth': '4', 'answer': '3 ' + 'y' * 300}) == 'numeric_mismatch'

    def test_a_missing_raw_output_is_not_an_abstention(self) -> None:
        """`classify` keeps `undefined` (a capture gap) and `null` (not consulted)
        apart from each other; the taxonomy does not, because neither is a decline.
        What matters here is that neither becomes an abstention, and that a missing
        raw output does not suppress the rules that do not read it."""
        assert _MODULE.failure_shape({'groundTruth': 'Thrive Market', 'answer': 'Walmart'}) == 'other'
        assert _MODULE.failure_shape({'rawOutput': None, 'groundTruth': 'Thrive Market', 'answer': 'Walmart'}) == 'other'
        assert _MODULE.failure_shape({'groundTruth': '3', 'answer': '2'}) == 'numeric_mismatch'

    def test_the_shape_names_are_distinct(self) -> None:
        assert len(set(_MODULE.FAILURE_SHAPES)) == len(_MODULE.FAILURE_SHAPES)


class TestTheTwoReadingsOfTheNumericRule:
    """A word that carried two definitions across two tables of one document."""

    def test_the_two_rules_disagree_on_a_leading_agreement(self) -> None:
        gold, answer = '15 hours for getting to the three destinations (or 30 hours)', '15 hours'
        assert _MODULE.numeric_mismatch(gold, answer) is False
        assert _MODULE.numeric_mismatch_by_multiset(gold, answer) is True

    def test_both_agree_when_the_leading_numbers_differ(self) -> None:
        assert _MODULE.numeric_mismatch('3', '2') is True
        assert _MODULE.numeric_mismatch_by_multiset('3', '2') is True


class TestThePublishedTablesAreReproducible:
    """The calibration, pinned to the two archived rosters.

    These fixtures are the only place the published numbers can be re-derived from
    without the Actions artifact store, and re-deriving them is exactly what the
    prediction needs: §13.34.5 says "41 of 47", and 41 is only reachable if the
    rule that produced it is known.
    """

    @staticmethod
    def _census(run: str) -> 'Counter[str]':
        from collections import Counter

        report = json.loads((FIXTURES / f'mr-roster-{run}.json').read_text(encoding='utf-8'))
        questions = [q for q in report['questions'] if not q['correct']]
        return Counter(_MODULE.failure_shape(q) for q in questions)

    def test_the_detailed_table_of_13_26_4_is_reproduced_exactly(self) -> None:
        """Run 38595325261, whose taxonomy is published as 24/4/2/31/2/7.

        An exact match on all six numbers is what makes the definitions above
        derived rather than invented. Five of the seven readings of "the numbers
        disagree" that were tried give 32 rather than 31 for `numeric_mismatch`,
        so `numeric_mismatch` compares the FIRST number on each side -- and the
        calibration is the evidence for that, not a first-principles argument.
        """
        assert dict(self._census('38595325261')) == {
            'abstention': 24, 'plan_output': 4, 'soft_refusal': 2,
            'numeric_mismatch': 31, 'long_prose': 2, 'other': 7,
        }

    def test_the_coarse_table_of_13_34_4_needs_a_different_rule(self) -> None:
        """Run 38828538851, published as `wrong 47, of which 41 are numeric`.

        Under the taxonomy's own precedence this run is 39, not 41. The 41 is the
        same roster with `plan_output` folded into `numeric_mismatch`. Both numbers
        are correct; they are answers to different questions, and only one of them
        was named in the document.
        """
        census = self._census('38828538851')
        assert census['abstention'] == 22
        assert sum(census.values()) == 69
        answered_wrong = 69 - census['abstention']
        assert answered_wrong == 47
        assert census['numeric_mismatch'] == 39
        assert census['numeric_mismatch'] + census['plan_output'] == 41


class TestTheFailuresReport:
    """The report prints the rules beside the table.

    A table without its definitions is what §13.34.5's prediction was read from, and
    the two published readings of one word differ by two records on the same roster.
    """

    @staticmethod
    def _run(*args: str) -> 'subprocess.CompletedProcess[str]':
        return subprocess.run(
            [sys.executable, str(TOOL), *args],
            capture_output=True, text=True, check=False,
        )

    def test_the_six_shapes_and_the_definitions_are_both_printed(self) -> None:
        r = self._run('--failures', '--capability', 'MR', str(FIXTURES / 'mr-roster-38828538851.json'))
        assert r.returncode == 0, r.stderr
        for shape in _MODULE.FAILURE_SHAPES:
            assert shape in r.stdout, shape
        assert 'definitions' in r.stdout

    def test_both_readings_of_numeric_mismatch_are_printed_and_labelled(self) -> None:
        r = self._run('--failures', '--capability', 'MR', str(FIXTURES / 'mr-roster-38828538851.json'))
        assert 'plan_output folded in' in r.stdout
        assert 'by multiset instead' in r.stdout
        # 41 and 39 are the two published readings of one roster, and a report that
        # printed one of them without the other could not be read against the
        # prediction, which names the folded one.
        assert 'folded in        41' in r.stdout
        assert 'instead        39' in r.stdout

    def test_the_report_is_the_right_population(self) -> None:
        r = self._run('--failures', '--capability', 'MR', str(FIXTURES / 'mr-roster-38828538851.json'))
        assert '121 question(s), 52 correct, 69 non-correct' in r.stdout

    def test_a_missing_file_is_an_error(self, tmp_path: Path) -> None:
        assert self._run('--failures', str(tmp_path / 'nope.json')).returncode == 2


class TestTheShapeIsReadFromTheAnswer:
    """The field the taxonomy reads, and the run that proved it was the wrong one.

    §13.38 fixed *which rules* classify a non-correct answer and left *which field*
    they read unexamined, because on the two rosters it was calibrated against the
    two fields are the same string. Run `38953157688` broke that: under
    `ask: enumerated` the arm's answer was the whole response, so the taxonomy was
    classifying transcripts and reported `plan_output 30 / numeric_mismatch 0` --
    a number that says nothing about the model's arithmetic.
    """

    def test_a_step_headed_transcript_is_classified_by_its_answer(self) -> None:
        """The raw output opens with the contract; the answer is the model's total."""
        record = {
            'rawOutput': 'Step 1 — list every item in the evidence that matches the question…\n'
                         '- [2023/05/21] I am planning a project in Nigeria…\n'
            'Step 2 — compute the answer from that list…\n'
            '3',
            'answer': '3',
            'groundTruth': '5',
        }
        assert _MODULE.failure_shape(record) == 'numeric_mismatch'

    def test_a_step_headed_transcript_with_the_right_answer_is_not_numeric(self) -> None:
        assert _MODULE.failure_shape({
            'rawOutput': 'Step 1 — list the items\n- one\nStep 2 — compute\n3',
            'answer': '3',
            'groundTruth': '3',
        }) == 'other'

    def test_a_null_answer_is_an_abstention_whatever_the_raw_output_said(self) -> None:
        """`parseAnswer` is what decides a decline, and a decline has no answer.

        Reading the sentinel out of the raw output was equivalent for four runs and
        is not equivalent in principle: a raw output that lists evidence and then
        declines is an abstention because the ARM returned null, not because a
        string ended a certain way. The taxonomy should read the decision.
        """
        assert _MODULE.failure_shape({
            'rawOutput': 'Step 1 — list the items\n- one\n- two\nStep 2 — compute\nINSUFFICIENT_EVIDENCE',
            'answer': None,
            'groundTruth': '3',
        }) == 'abstention'

    def test_a_record_without_an_answer_key_is_an_error_rather_than_an_abstention(self) -> None:
        """A schema change must fail loudly, not silently reclassify every question.

        `.get('answer')` returning `None` for a missing key is indistinguishable from
        a record that declined, so a report that stopped emitting the field would
        report a 100% abstention rate and look like a contract working perfectly.
        """
        with pytest.raises(KeyError, match='answer'):
            _MODULE.failure_shape({'rawOutput': '3', 'groundTruth': '3'})

    def test_a_missing_raw_output_does_not_change_the_shape(self) -> None:
        """`rawOutput` is no longer read for any rule, so its absence is not a shape."""
        with_answer = {'answer': '2', 'groundTruth': '3'}
        with_raw = {'answer': '2', 'groundTruth': '3', 'rawOutput': '3'}
        assert _MODULE.failure_shape(with_answer) == _MODULE.failure_shape(with_raw)


class TestTheRostersTheFieldChangeMustNotMove:
    """The three runs whose published tables were produced with the old field.

    On every one of them the answer and the raw output are the same string (or the
    answer is null and the raw output ends in the sentinel), which is the property
    that makes reading the answer a **no-op** for them and a repair for the fourth.
    """

    @staticmethod
    def _census(run: str) -> 'Counter[str]':
        from collections import Counter

        report = json.loads((FIXTURES / f'mr-roster-{run}.json').read_text(encoding='utf-8'))
        return Counter(_MODULE.failure_shape(q) for q in report['questions'] if not q['correct'])

    def test_the_computed_roster_is_unchanged(self) -> None:
        assert dict(self._census('38595325261')) == {
            'abstention': 24, 'plan_output': 4, 'soft_refusal': 2,
            'numeric_mismatch': 31, 'long_prose': 2, 'other': 7,
        }

    def test_the_session_fill_roster_is_unchanged(self) -> None:
        census = self._census('38828538851')
        assert census['abstention'] == 22
        assert census['numeric_mismatch'] == 39
        assert census['numeric_mismatch'] + census['plan_output'] == 41

    def test_the_transcript_scored_roster_is_unchanged(self) -> None:
        """Run `38953157688`, whose answer WAS the transcript: 33 declines, 30 plans."""
        census = self._census('38953157688')
        assert census['abstention'] == 33
        assert census['plan_output'] == 30
        assert census['numeric_mismatch'] == 0
        assert sum(census.values()) == 63

    def test_the_repaired_parser_roster_reads_its_arithmetic(self) -> None:
        """Run `38985220145`: the first roster where the two fields differ.

        `plan_output` falls 57 -> 0 and `numeric_mismatch` rises 0 -> 52, because the
        answer is now the model's total rather than its transcript. The 52 is the
        number §13.41.3 reads, and it is the number this classifier must produce or
        the document and the tool disagree.
        """
        census = self._census('38985220145')
        assert census['abstention'] == 35
        assert census['plan_output'] == 0
        assert census['numeric_mismatch'] == 52
        assert census['long_prose'] == 1
        assert census['other'] == 4
        assert sum(census.values()) == 92


class TestEachReportNamesTheFieldItReads:
    """Two reports in one file, and they classify two different strings.

    `--failures` reads `answer` (§13.42); the default report reads `rawOutput`. On the
    rosters where the two are the same string a reader could not tell them apart, and
    under `ask: enumerated` they disagree about almost every record: run
    `38985220145`'s raw outputs are transcripts, so the default report says
    `bare 2 / prose-then-token 33 / other 86` while the answer-level report says
    `abstention 35 / numeric_mismatch 52`.

    A report that does not say which string it counted invites exactly that
    misreading, so each one names its field in its own output.
    """

    @staticmethod
    def _run(*args: str) -> 'subprocess.CompletedProcess[str]':
        return subprocess.run(
            [sys.executable, str(TOOL), *args], capture_output=True, text=True, check=False,
        )

    def test_the_default_report_says_it_classifies_the_raw_output(self) -> None:
        r = self._run('--capability', 'MR', str(FIXTURES / 'mr-roster-38985220145.json'))
        assert r.returncode == 0, r.stderr
        assert 'field: rawOutput' in r.stdout
        assert '--failures' in r.stdout

    def test_the_failures_report_says_it_classifies_the_answer(self) -> None:
        r = self._run('--failures', '--capability', 'MR', str(FIXTURES / 'mr-roster-38985220145.json'))
        assert r.returncode == 0, r.stderr
        assert 'field: answer' in r.stdout

    def test_the_two_reports_disagree_on_this_roster_and_that_is_the_point(self) -> None:
        """The measurement the labels exist for: same roster, two different tables."""
        import re as _re

        raw = self._run('--capability', 'MR', str(FIXTURES / 'mr-roster-38985220145.json')).stdout
        answer = self._run(
            '--failures', '--capability', 'MR', str(FIXTURES / 'mr-roster-38985220145.json'),
        ).stdout
        # Matched loosely on whitespace: the column widths are the report's business,
        # and a test that pins them would fail on a cosmetic change while the defect it
        # guards -- two reports counting two strings -- stayed invisible.
        assert _re.search(r'^\s+other\s+86\b', raw, _re.MULTILINE), raw
        assert _re.search(r'^\s+numeric_mismatch\s+52\b', answer, _re.MULTILINE), answer
