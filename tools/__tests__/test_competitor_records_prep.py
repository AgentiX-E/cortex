"""Tests for tools/competitor-records-prep.mjs — reading a competitor's record file without guessing.

## What this file protects

The re-grade of Maximem Synap's 500 published answers (§169.5) rests on one fact this tool has to
establish mechanically: **which field holds the model's answer**. Nothing documents it. The failure
mode of getting it wrong is not an exception -- it is a plausible number, because the judge will grade
whatever string it is handed and a context block or an echoed question still produces a verdict.

So each test below is one of the rules that keeps that from happening, and the two that matter most are
the refusals: two answer-shaped fields, and none.

  * a field present in only part of the population would re-grade that part and report it as the whole;
  * the gold answer is called `answer` in these records, the same name LongMemEval uses for the
    expected value, so the field that looks most like the model's answer is the one it never is;
  * a field that echoes the question is an input, and a judge comparing an answer to itself accepts it;
  * a context-sized field measures whether the judge can find the answer in a haystack, not whether the
    competitor found it;
  * and when two fields survive, or none does, the tool writes `null` and the evidence rather than
    choosing -- a refusal costs one reading, a guess costs the campaign.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'competitor-records-prep.mjs'


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(TOOL), *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
    )


def prepare(tmp_path: Path, records, *extra: str):
    """Write the records, run the tool against the file, and read both artifacts back."""
    tmp_path.mkdir(parents=True, exist_ok=True)
    source = tmp_path / 'records.json'
    source.write_text(json.dumps(records))
    out = tmp_path / 'out'
    result = run('--input', str(source), '--out-dir', str(out), *extra)
    assert result.returncode == 0, result.stderr
    census = json.loads((out / 'records-census.json').read_text())
    answers = json.loads((out / 'records-answers.json').read_text())
    return result, census, answers


def record(question: str, gold: str, **fields) -> dict:
    return {'question_id': question, 'question': question, 'answer': gold, **fields}


def test_the_answer_field_is_the_string_field_that_is_not_the_question(tmp_path: Path) -> None:
    _, census, answers = prepare(
        tmp_path,
        [
            record('What is the capital?', 'Paris', response='Paris.', correct=True),
            record('Who wrote it?', 'Ada', response='Ada Lovelace wrote it.', correct=False),
        ],
    )
    assert census['records'] == 2
    assert answers['answerField'] == 'response'
    assert answers['answerFieldSource'] == 'census'
    assert [question['response'] for question in answers['questions']] == ['Paris.', 'Ada Lovelace wrote it.']
    assert [question['gold'] for question in answers['questions']] == ['Paris', 'Ada']
    assert [question['publishedVerdict'] for question in answers['questions']] == [True, False]


def test_the_gold_field_is_never_read_as_the_model_answer(tmp_path: Path) -> None:
    # `answer` holds the gold in these records. It is answer-shaped by every arithmetic test, so the
    # only thing standing between it and a re-grade that scores the competitor's gold against its gold
    # is the name list -- which is why this test exists rather than a comment.
    result, census, answers = prepare(
        tmp_path,
        [record('What is the capital?', 'Paris', correct=True)],
    )
    assert answers['answerField'] is None
    assert 'refused' in answers
    assert answers['questions'] == []
    assert 'refused' in census
    assert answers['fieldMap']['gold'] == 'answer'
    assert 'no single record-level string field' in result.stdout


def test_a_field_echoing_the_question_is_not_the_answer(tmp_path: Path) -> None:
    # The echo is answer-shaped and present everywhere; only `echoOfQuestion` separates it.
    _, census, answers = prepare(
        tmp_path,
        [
            record('What is the capital?', 'Paris', echo='What is the capital?', response='Paris.'),
            record('Who wrote it?', 'Ada', echo='Who wrote it?', response='Ada.'),
            record('Where now?', 'Oslo', echo='Where now?', response='Oslo.'),
        ],
    )
    assert answers['answerField'] == 'response'
    echo = next(row for row in census['columns'] if row['key'] == 'echo')
    assert echo['echoOfQuestion'] == 3
    assert echo['key'] not in [candidate['key'] for candidate in census['answerCandidates']]


def test_a_field_missing_from_some_records_is_not_the_answer(tmp_path: Path) -> None:
    # Half the population carries `response`. Re-grading it would score 2 of 3 and report it as 3.
    records = [
        record('a?', 'x', response='x'),
        record('b?', 'y', response='y'),
        record('c?', 'z'),
    ]
    _, census, answers = prepare(tmp_path, records)
    assert answers['answerField'] is None
    assert 'refused' in answers
    response = next(row for row in census['columns'] if row['key'] == 'response')
    assert response['count'] == 2


def test_a_context_sized_field_is_not_an_answer(tmp_path: Path) -> None:
    _, census, answers = prepare(
        tmp_path,
        [record('a?', 'x', context='word ' * 4000), record('b?', 'y', context='word ' * 4200)],
    )
    assert answers['answerField'] is None
    context = next(row for row in census['columns'] if row['key'] == 'context')
    assert context['lengthMedian'] > 4000


def test_two_answer_shaped_fields_are_refused_rather_than_chosen(tmp_path: Path) -> None:
    # The reading this protects against is the one that looks fine: picking `response` here would
    # produce a number, and nothing in the artifact would say a second field had an equal claim.
    _, census, answers = prepare(
        tmp_path,
        [record('a?', 'x', response='x.', prediction='x'), record('b?', 'y', response='y.', prediction='y')],
    )
    assert answers['answerField'] is None
    assert {candidate['key'] for candidate in census['answerCandidates']} == {'response', 'prediction'}
    assert 'candidates survived' in answers['refused']
    assert answers['questions'] == []


def test_an_override_names_the_field_the_census_could_not_separate(tmp_path: Path) -> None:
    _, census, answers = prepare(
        tmp_path,
        [record('a?', 'x', response='x.', prediction='x'), record('b?', 'y', response='y.', prediction='y')],
        '--answer-field',
        'prediction',
    )
    assert answers['answerField'] == 'prediction'
    assert answers['answerFieldSource'] == 'override'
    assert [question['response'] for question in answers['questions']] == ['x', 'y']
    # The evidence that forced the override is still in the census, so the provenance is checkable.
    assert {candidate['key'] for candidate in census['answerCandidates']} == {'response', 'prediction'}


def test_an_override_of_a_partial_field_is_rejected(tmp_path: Path) -> None:
    records = [record('a?', 'x', response='x'), record('b?', 'y', response='y'), record('c?', 'z')]
    tmp_path.mkdir(parents=True, exist_ok=True)
    source = tmp_path / 'records.json'
    source.write_text(json.dumps(records))
    result = run('--input', str(source), '--out-dir', str(tmp_path / 'out'), '--answer-field', 'response')
    assert result.returncode != 0
    assert 'not carried by every record' in result.stderr
    assert not (tmp_path / 'out' / 'records-answers.json').exists()


def test_the_census_carries_the_digest_of_the_bytes_it_read(tmp_path: Path) -> None:
    # A re-grade is only about the file it names. 23.7 MB behind a moving branch means the answer set
    # can be replaced by re-running the prep; the digest is what makes two readings comparable.
    _, census, _ = prepare(tmp_path, [record('a?', 'x', response='x')])
    assert len(census['source']['sha256']) == 64
    assert census['source']['bytes'] > 0
    assert census['source']['path'].endswith('records.json')


def test_a_bare_array_and_a_wrapped_records_object_are_both_read(tmp_path: Path) -> None:
    records = [record('a?', 'x', response='x'), record('b?', 'y', response='y')]
    _, bare, _ = prepare(tmp_path / 'bare', records)
    _, wrapped, _ = prepare(tmp_path / 'wrapped', {'records': records, 'run': 'gemini-3.8-flash'})
    assert bare['records'] == wrapped['records'] == 2
    assert bare['fieldMap'] == wrapped['fieldMap']


def test_the_real_shape_is_censused_to_two_levels_and_still_refuses_to_choose(tmp_path: Path) -> None:
    # This is the real file's shape: `answer` is the gold, `retrieval`/`answering`/`judge` are objects,
    # the model's answer is `answering.response`, and the judge's note is `judge.rationale`. The
    # top-level-only version of the tool found nothing in it, which was the right answer to the wrong
    # question -- so the census reads two levels. What it still does not do is choose between two
    # high-cardinality text columns: both are answer-shaped, both are unique per question, and the only
    # thing separating them is a name. That is what `--answer-field` is for, and what its provenance
    # field records.
    records = [
        {
            'question_id': 'q1',
            'question_type': 'knowledge-update',
            'question': 'What was my best time?',
            'answer': '25 minutes and 50 seconds',
            'retrieval': {'abstention': False, 'search_query_sent': 'What was my best time?', 'retrieved_context': [{'memory': 'x'}]},
            'answering': {'response': 'Your best time was 27:12, later 25:50.', 'model': 'gemini-3.8-flash'},
            'judge': {'correct': True, 'rationale': 'contains the gold'},
        },
        {
            'question_id': 'q2',
            'question_type': 'single-session-user',
            'question': 'What degree did I graduate with?',
            'answer': 'Business Administration',
            'retrieval': {'abstention': True, 'retrieved_context': []},
            'answering': {'response': 'Business Administration.', 'model': 'gemini-3.8-flash'},
            'judge': {'correct': False, 'rationale': 'nope'},
        },
    ]
    _, census, answers = prepare(tmp_path, records)
    assert answers['answerField'] is None
    assert 'refused' in answers
    # `answering.model` is a string of similar length and is *not* a candidate: it is the same value on
    # both records, and an answer is not.
    assert {candidate['key'] for candidate in census['answerCandidates']} == {
        'answering.response',
        'answering.model',
        'judge.rationale',
    }
    # Ruled out by cardinality rather than by the census never seeing it: the model name is one value.
    assert {candidate['key'] for candidate in census['answerNearUnique']} == {
        'answering.response',
        'judge.rationale',
    }
    keys = {column['key'] for column in census['columns']}
    assert {'retrieval.abstention', 'judge.correct', 'answering.model'} <= keys

    _, census, answers = prepare(
        tmp_path / 'named', records, '--answer-field', 'answering.response'
    )
    assert answers['answerField'] == 'answering.response'
    assert answers['answerFieldSource'] == 'override'
    assert answers['questions'][0]['response'] == 'Your best time was 27:12, later 25:50.'
    assert answers['questions'][0]['gold'] == '25 minutes and 50 seconds'
    assert [question['abstention'] for question in answers['questions']] == [False, True]
    # The verdict is a boolean column and so is `retrieval.abstention`, so it too refuses rather than
    # picking the first boolean it meets.
    assert answers['verdictField'] is None


def test_a_column_that_never_varies_is_not_a_verdict(tmp_path: Path) -> None:
    # On the real file the two `abstention` booleans are `false` on all 500 records -- feature flags --
    # and they look exactly as qualified as the actual verdict beside them, `judge.judge_raw`
    # (`Yes`/`No`). Cardinality is what tells them apart: a verdict takes more than one value.
    records = [
        {
            'question': f'question {index}?',
            'answer': f'gold {index}',
            'answering': {'generated_answer': f'answer number {index}.'},
            'judge': {'judge_raw': 'Yes' if index % 2 == 0 else 'No', 'abstention': False},
            'retrieval': {'abstention': False},
        }
        for index in range(10)
    ]
    _, census, answers = prepare(tmp_path, records)
    assert answers['answerField'] == 'answering.generated_answer'
    assert answers['verdictField'] == 'judge.judge_raw'
    assert census['verdictFieldSource'] == 'census'
    assert [question['publishedVerdict'] for question in answers['questions']][:2] == [True, False]
    assert {candidate['key'] for candidate in census['verdictCandidates']} == {'judge.judge_raw'}


def test_an_override_names_the_verdict_when_two_columns_vary(tmp_path: Path) -> None:
    # Two varying binary columns is a file that has to be read by a person; the override records that
    # one did, and refuses a column that is not carried by every record.
    records = [
        {'question': 'a?', 'answer': 'x', 'response': 'x.', 'correct': True, 'abstained': False},
        {'question': 'b?', 'answer': 'y', 'response': 'y.', 'correct': False, 'abstained': True},
    ]
    _, census, answers = prepare(tmp_path, records)
    assert answers['verdictField'] is None
    assert {candidate['key'] for candidate in census['verdictCandidates']} == {'correct', 'abstained'}
    _, census, answers = prepare(tmp_path / 'named', records, '--verdict-field', 'correct')
    assert answers['verdictField'] == 'correct'
    assert census['verdictFieldSource'] == 'override'
    assert [question['publishedVerdict'] for question in answers['questions']] == [True, False]


def test_a_list_is_not_a_column(tmp_path: Path) -> None:
    # `retrieval.retrieved_context` is an array of evidence blocks: a path into it is a per-record
    # detail, and treating it as a column would put a giant string in the candidate list on every file.
    _, census, _ = prepare(
        tmp_path,
        [{'question': 'q?', 'answer': 'a', 'response': 'a.', 'retrieval': {'retrieved_context': [{'x': 1}]}}],
    )
    keys = {column['key'] for column in census['columns']}
    assert 'retrieval.retrieved_context' not in keys
    assert answers_answer(census) == 'response'


def answers_answer(census) -> str:
    return census['fieldMap']['answer']


def test_the_abstention_flag_is_carried_so_the_judge_template_can_match(tmp_path: Path) -> None:
    # The official protocol grades an abstention question with a different prompt. These records say
    # which ones those are at `retrieval.abstention`, and `null` is kept distinct from `false`: a file
    # that does not say is not a file that says "no".
    records = [
        record('a?', 'x', response='x', retrieval={'abstention': True}),
        record('b?', 'y', response='y', retrieval={'abstention': False}),
        record('c?', 'z', response='z'),
    ]
    _, _, answers = prepare(tmp_path, records)
    assert [question['abstention'] for question in answers['questions']] == [True, False, None]


def test_the_question_type_and_id_are_carried_through_so_the_judge_template_matches(tmp_path: Path) -> None:
    # `judgeScorer` derives its prompt from the raw dataset tag: `_abs` is how LongMemEval marks an
    # abstention question, and grading one with the default template is a different (harsher) test.
    # Losing the tag in this projection would silently change the ruler on 3% of the population.
    records = [
        {**record('a?', 'x', response='x'), 'question_type': 'temporal-reasoning'},
        {**record('b?', 'y', response='y'), 'question_type': 'knowledge-update'},
    ]
    _, census, answers = prepare(tmp_path, records)
    assert answers['fieldMap']['questionType'] == 'question_type'
    assert [question['questionType'] for question in answers['questions']] == ['temporal-reasoning', 'knowledge-update']
    assert all(question['questionId'] for question in answers['questions'])
