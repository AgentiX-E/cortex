"""The window-reach tool, checked on hand-built artifacts.

The tool prices §13.151's time-window reorder before it is dispatched, and the whole point of it is
that three populations which look alike have three different prices:

  - **window-wanting** (`eventLookup` or `relative`) is the reach, and costs nothing to count;
  - **ladder-fired** is the free path -- the deterministic resolver already returns a window;
  - **model-fallback** is what the reference pipeline pays a call for, per question, per run.

A tool that conflated them would report the reference's cost for a mechanism this arm can run
cheaper, and the cost model is the reason the mechanism is registrable at all (§13.151.4).

Two more distinctions are the whole reason the file exists. **Fired is not moved**: a window outside
the delivered span reorders nothing, and counting it as a move would claim an effect the mechanism
cannot have. **Reachable is not converted**: a wrong question whose list the window splits is where
the mechanism can act, and whether it acted is what the paired mode measures.

The refusals matter for the same reason they do in `test_expand_resolution.py`: each replaces a
plausible number with one that is wrong in a direction nobody would notice. A skipped turn entry
shrinks the delivered span, and every window decision is a comparison against that span.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "window-reach.mjs"


def turn(date: str, content: str = "something was said", *, weekday: str | None = None) -> dict:
    """One delivered turn in the shape the arm writes: a date prefix, a role, then content."""
    stamp = f"[{date} ({weekday}) 09:00]" if weekday else f"[{date}]"
    return {"index": 0, "text": f"{stamp} user: {content}"}


def record(
    question_id: str,
    question: str,
    *,
    capability: str = 'TR',
    correct: bool = False,
    turns: list[dict] | None = None,
    question_date: str | None = '2023/02/15',
) -> dict:
    return {
        'questionId': question_id,
        'question': question,
        'capability': capability,
        **({'questionDate': question_date} if question_date is not None else {}),
        'groundTruth': 'blue',
        'answer': 'blue' if correct else None,
        'rawOutput': 'blue',
        'correct': correct,
        'grounded': correct,
        'turns': turns if turns is not None else [turn('2023/02/01', 'the event happened')],
        'promptChars': 100,
    }


def artifact(questions: list[dict]) -> dict:
    return {'dataset': 'longmemeval/s/test', 'questionCount': len(questions), 'questions': questions}


def filler(count: int) -> list[dict]:
    """Questions that carry no temporal reference, so they are outside every population."""
    return [
        record(f'filler-{index}', f'What colour was object number {index}?', capability='IE')
        for index in range(count)
    ]


def run(tmp_path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ['node', str(TOOL), *args],
        capture_output=True,
        text=True,
        cwd=REPO,
        check=False,
    )


def write(tmp_path, name: str, body: dict) -> str:
    path = tmp_path / name
    path.write_text(json.dumps(body), encoding='utf-8')
    return str(path)


def readable(tmp_path, body: dict, name: str = 'control.json') -> str:
    return write(tmp_path, name, body)


def reading(tmp_path, body: dict) -> dict:
    path = readable(tmp_path, body)
    result = run(tmp_path, '--control', path, '--json')
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


# --------------------------------------------------------------------------------------------------
# Usage and refusals
# --------------------------------------------------------------------------------------------------


def test_requires_a_control(tmp_path):
    result = run(tmp_path, '--json')
    assert result.returncode == 2
    assert 'usage' in result.stderr


def test_refuses_two_treatments(tmp_path):
    control = readable(tmp_path, artifact(filler(3)))
    result = run(tmp_path, '--control', control, '--treatment', control, '--treatment', control)
    assert result.returncode == 2
    assert 'usage' in result.stderr


def test_refuses_the_same_file_as_control_and_treatment(tmp_path):
    control = readable(tmp_path, artifact(filler(3)))
    result = run(tmp_path, '--control', control, '--treatment', control)
    assert result.returncode == 2
    assert 'same file' in result.stderr


def test_refuses_unreadable_json(tmp_path):
    path = tmp_path / 'broken.json'
    path.write_text('{not json', encoding='utf-8')
    result = run(tmp_path, '--control', str(path))
    assert result.returncode == 2
    assert 'not readable JSON' in result.stderr


def test_refuses_an_artifact_with_no_questions(tmp_path):
    control = readable(tmp_path, {'dataset': 'x'})
    result = run(tmp_path, '--control', control)
    assert result.returncode == 2
    assert 'no questions array' in result.stderr


def test_refuses_a_record_with_no_question_text(tmp_path):
    control = readable(tmp_path, artifact([{'questionId': 'a', 'turns': []}]))
    result = run(tmp_path, '--control', control)
    assert result.returncode == 2
    assert 'no questionId or no question text' in result.stderr


def test_refuses_a_duplicate_question_id(tmp_path):
    body = [record('dup', 'What did I do two weeks ago?'), record('dup', 'What did I do two weeks ago?')]
    control = readable(tmp_path, artifact(body))
    result = run(tmp_path, '--control', control)
    assert result.returncode == 2
    assert 'appears twice' in result.stderr


def test_refuses_a_record_whose_turns_are_not_a_list(tmp_path):
    body = record('a', 'What did I do two weeks ago?')
    body['turns'] = 'not a list'
    control = readable(tmp_path, artifact([body]))
    result = run(tmp_path, '--control', control)
    assert result.returncode == 2
    assert 'no turns array' in result.stderr


def test_refuses_a_turn_that_is_neither_text_nor_an_object_with_text(tmp_path):
    body = record('a', 'What did I do two weeks ago?')
    body['turns'] = [{'index': 0, 'content': 'wrong key'}]
    control = readable(tmp_path, artifact([body]))
    result = run(tmp_path, '--control', control)
    assert result.returncode == 2
    assert 'neither text nor {text}' in result.stderr


def test_refuses_an_artifact_where_nothing_wants_a_window(tmp_path):
    control = readable(tmp_path, artifact(filler(3)))
    result = run(tmp_path, '--control', control)
    assert result.returncode == 1
    assert 'cannot price the mechanism' in result.stderr


# --------------------------------------------------------------------------------------------------
# The three populations
# --------------------------------------------------------------------------------------------------


def test_counts_the_three_populations_separately(tmp_path):
    # `two weeks ago` is `relative`, so it wants a window and the ladder resolves it: the free path.
    # `What time did I reach ... on Monday?` is `eventLookup` with a weekday, also resolved.
    # A count question with no anchor is outside every population.
    body = [
        record('free', 'What did I do two weeks ago?', turns=[turn('2023/01/10'), turn('2023/02/01')]),
        record('monday', 'What time did I reach the clinic on Monday?', turns=[turn('2023/02/13'), turn('2023/02/14')]),
        record('other', 'How many projects did I lead?', capability='MR'),
    ] + filler(17)
    data = reading(tmp_path, artifact(body))
    assert data['questions'] == 20
    assert data['windowWanting'] == 2
    assert data['ladderFired'] == 2
    assert data['fallback'] == 0
    assert data['ladderMoved'] == 2


def test_puts_a_window_wanting_question_the_ladder_cannot_read_in_the_fallback(tmp_path):
    # "How many weeks ago" states no number the offset parser can read, so it is window-wanting and
    # unresolved: one model call, per run. This is the population the reference pipeline pays for.
    body = [record('unread', 'How many weeks ago did I meet my aunt?')] + filler(4)
    data = reading(tmp_path, artifact(body))
    assert data['windowWanting'] == 1
    assert data['ladderFired'] == 0
    assert data['fallback'] == 1


def test_prices_the_fallback_population_by_how_many_of_it_is_wrong(tmp_path):
    """The paid path's ceiling is the wrong half of the population it would be paid for.

    A fallback question is one the free ladder cannot read, so a model would have to produce a window
    for it. Only the ones the control answers wrong can convert, and even those are an upper bound --
    producing a window is not the same as moving the list. Reporting the fallback's size without its
    wrong count would price the mechanism by the calls it costs and never by what it could buy.
    """
    body = [
        record('wrong-unread', 'How many weeks ago did I meet my aunt?', correct=False),
        record('right-unread', 'How many months ago did I buy the kettle?', correct=True),
    ] + filler(4)
    data = reading(tmp_path, artifact(body))
    assert data['fallback'] == 2
    assert data['fallbackWrong']['total'] == 1
    assert data['fallbackWrong']['byCapability'] == {'TR': {'questions': 2, 'wrong': 1}}


def test_separates_fired_from_moved(tmp_path):
    # The window resolves to January 2023 and the delivered list is entirely in May: the reorder has
    # nothing to move, and a run that counted this as a move would claim an effect it cannot have.
    body = [
        record('inert', 'What did I do two weeks ago?', turns=[turn('2023/05/01'), turn('2023/05/02')]),
        record('moves', 'What did I do two weeks ago?', turns=[turn('2023/01/10'), turn('2023/02/01')]),
    ] + filler(8)
    data = reading(tmp_path, artifact(body))
    assert data['ladderFired'] == 2
    assert data['ladderMoved'] == 1
    assert data['reachableWrong'] == ['moves']


def test_a_correct_question_is_never_reachable_even_when_it_moves(tmp_path):
    body = [
        record('right', 'What did I do two weeks ago?', correct=True, turns=[turn('2023/01/10'), turn('2023/02/01')]),
        record('wrong', 'What did I do two weeks ago?', turns=[turn('2023/01/10'), turn('2023/02/01')]),
    ] + filler(8)
    data = reading(tmp_path, artifact(body))
    assert data['ladderMoved'] == 2
    assert data['reachableWrong'] == ['wrong']


def test_reports_an_artifact_with_no_readable_date_rather_than_reordering_it(tmp_path):
    # A delivered list with no parseable stamp cannot be compared against a window at all. The tool
    # says so instead of treating the question as fired-and-inert, which would read as a mechanism
    # that ran and had no effect.
    body = record('undated', 'What did I do two weeks ago?')
    body['turns'] = ['a turn with no stamp']
    data = reading(tmp_path, artifact([body] + filler(4)))
    assert data['unreadable'] == ['undated']
    assert data['undated'] == ['undated']
    assert data['ladderFired'] == 0


def test_reports_which_questions_carry_an_unreadable_turn(tmp_path):
    body = record('partial', 'What did I do two weeks ago?')
    body['turns'] = [turn('2023/01/10'), 'a truncated turn', turn('2023/02/01')]
    data = reading(tmp_path, artifact([body] + filler(4)))
    # The question is still reachable -- two of its three turns are dated -- but it is named.
    assert data['undated'] == ['partial']
    assert data['ladderFired'] == 1


def test_accepts_a_turn_written_as_a_bare_string(tmp_path):
    body = record('bare', 'What did I do two weeks ago?')
    body['turns'] = ['[2023/01/10] user: one', '[2023/02/01] user: two']
    data = reading(tmp_path, artifact([body] + filler(4)))
    assert data['ladderFired'] == 1
    assert data['ladderMoved'] == 1


# --------------------------------------------------------------------------------------------------
# The reference date
# --------------------------------------------------------------------------------------------------


def test_prefers_the_recorded_question_date(tmp_path):
    body = [record('q', 'What did I do two weeks ago?', turns=[turn('2023/01/10'), turn('2023/02/01')])]
    body += filler(4)
    data = reading(tmp_path, artifact(body))
    assert data['substitutions'] == 0


def test_reports_a_substituted_reference_date_instead_of_making_it_silently(tmp_path):
    # The control run this tool was written against predates the field (§13.152.2), so every window
    # read from it is resolved against the delivered span's last turn. That is a substitution, and a
    # reader has to be able to see how many questions it was made for.
    body = [
        record('q', 'What did I do two weeks ago?', question_date=None, turns=[turn('2023/01/10'), turn('2023/02/01')])
    ]
    body += filler(4)
    data = reading(tmp_path, artifact(body))
    assert data['substitutions'] == 1


# --------------------------------------------------------------------------------------------------
# The registered claims
# --------------------------------------------------------------------------------------------------


def test_criterion_three_is_met_inside_the_band_and_not_met_outside_it(tmp_path):
    # 2 window-wanting questions out of 10 is 20%: the top of the band, inclusive.
    inside = [record('a', 'What did I do two weeks ago?'), record('b', 'What did I do two weeks ago?')]
    inside += filler(8)
    claims = {claim['id']: claim for claim in reading(tmp_path, artifact(inside))['claims']}
    assert claims[3]['verdict'] == 'met'

    outside = [record('a', 'What did I do two weeks ago?')] + filler(19)
    claims = {claim['id']: claim for claim in reading(tmp_path, artifact(outside))['claims']}
    assert claims[3]['verdict'] == 'not met'


def test_criterion_one_is_met_only_when_every_turn_is_dated(tmp_path):
    clean = [record('a', 'What did I do two weeks ago?')] + filler(9)
    claims = {claim['id']: claim for claim in reading(tmp_path, artifact(clean))['claims']}
    assert claims[1]['verdict'] == 'met'

    ragged = record('a', 'What did I do two weeks ago?')
    ragged['turns'] = [turn('2023/01/10'), 'a truncated turn']
    claims = {claim['id']: claim for claim in reading(tmp_path, artifact([ragged] + filler(9)))['claims']}
    assert claims[1]['verdict'] == 'not met'


def test_criterion_four_is_unreachable_when_the_bar_exceeds_the_population(tmp_path):
    # One reachable TR question against a registered bar of four: the dispatch cannot meet the bar
    # whatever it does, and the artifact has to say that rather than let a run be read as a failure.
    body = [record('a', 'What did I do two weeks ago?', turns=[turn('2023/01/10'), turn('2023/02/01')])]
    body += filler(9)
    claims = {claim['id']: claim for claim in reading(tmp_path, artifact(body))['claims']}
    assert claims[4]['verdict'] == 'unreachable'


def test_criterion_four_is_reachable_with_enough_tr_population(tmp_path):
    body = [
        record(f'tr-{index}', 'What did I do two weeks ago?', turns=[turn('2023/01/10'), turn('2023/02/01')])
        for index in range(4)
    ] + filler(6)
    claims = {claim['id']: claim for claim in reading(tmp_path, artifact(body))['claims']}
    assert claims[4]['verdict'] == 'reachable'


# --------------------------------------------------------------------------------------------------
# The paired mode: criteria 2 and 5
# --------------------------------------------------------------------------------------------------


def pair(tmp_path, control: dict, treatment: dict) -> dict:
    control_path = readable(tmp_path, control, 'control.json')
    treatment_path = write(tmp_path, 'treatment.json', treatment)
    result = run(tmp_path, '--control', control_path, '--treatment', treatment_path, '--json')
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_criterion_two_is_met_when_only_the_order_changed(tmp_path):
    # Same multiset, reversed order: a permutation, which is exactly what a reorder may do.
    before = [record('a', 'What did I do two weeks ago?')] + filler(9)
    after = [record('a', 'What did I do two weeks ago?')] + filler(9)
    after[0] = record('a', 'What did I do two weeks ago?', correct=True)
    after[0]['turns'] = list(reversed(before[0]['turns']))
    data = pair(tmp_path, artifact(before), artifact(after))
    claims = {claim['id']: claim for claim in data['claims']}
    assert claims[2]['verdict'] == 'met'
    assert data['pair']['changedSet'] == []


def test_criterion_two_fails_when_a_turn_was_added_or_dropped(tmp_path):
    before = [record('a', 'What did I do two weeks ago?')] + filler(9)
    after = [record('a', 'What did I do two weeks ago?')] + filler(9)
    after[0]['turns'] = before[0]['turns'] + [turn('2023/02/02')]
    data = pair(tmp_path, artifact(before), artifact(after))
    claims = {claim['id']: claim for claim in data['claims']}
    assert claims[2]['verdict'] == 'not met'
    assert data['pair']['changedSet'] == ['a']


def test_criterion_five_measures_flow_only_outside_the_population(tmp_path):
    # One firing question and one that cannot fire. Moving the second one is a change the mechanism
    # did not make, and it has to be reported as the control's own churn.
    before = [
        record('fires', 'What did I do two weeks ago?', turns=[turn('2023/01/10'), turn('2023/02/01')]),
        record('idle', 'How many projects did I lead?', capability='MR'),
    ] + filler(8)
    after = json.loads(json.dumps(before))
    after[1]['correct'] = True
    data = pair(tmp_path, artifact(before), artifact(after))
    assert data['pair']['outside']['count'] == 9
    assert data['pair']['outside']['moved'] == 1
    claims = {claim['id']: claim for claim in data['claims']}
    # 1 of 9 is 11.1%, above the 5.0% floor: the reorder perturbed something it does not reach.
    assert claims[5]['verdict'] == 'not met'


def test_counts_the_conversions_of_the_reachable_population(tmp_path):
    body = [
        record(f'tr-{index}', 'What did I do two weeks ago?', turns=[turn('2023/01/10'), turn('2023/02/01')])
        for index in range(4)
    ] + filler(6)
    after = json.loads(json.dumps(body))
    for row in after[:4]:
        row['correct'] = True
    data = pair(tmp_path, artifact(body), artifact(after))
    assert data['pair']['trConverted'] == 4
    assert data['pair']['bought'] == 4
    claims = {claim['id']: claim for claim in data['claims']}
    assert claims[4]['verdict'] == 'met'


def test_reports_a_question_missing_from_the_treatment(tmp_path):
    before = [record('a', 'What did I do two weeks ago?')] + filler(9)
    after = filler(10)
    data = pair(tmp_path, artifact(before), artifact(after))
    assert data['pair']['missing'] == ['a']


def test_human_output_names_the_three_populations_and_the_claims(tmp_path):
    body = [record('a', 'What did I do two weeks ago?', turns=[turn('2023/01/10'), turn('2023/02/01')])]
    body += filler(9)
    control = readable(tmp_path, artifact(body))
    result = run(tmp_path, '--control', control)
    assert result.returncode == 0
    assert 'window-wanting' in result.stdout
    assert 'ladder-fired' in result.stdout
    assert 'model fallback' in result.stdout
    assert 'Registered claims' in result.stdout
