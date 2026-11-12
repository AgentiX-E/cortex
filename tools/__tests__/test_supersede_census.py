"""Tests for `tools/supersede-census.mjs`, the instrument that prices a text-level supersession rule.

`docs/MEASURE-SUPERSEDE-REACH.md` asks one question before the `'drop'` arm is dispatched: does any function of
surface tokens separate "the corpus changed its value" from "two sentences both mention a number"? The tool
answers it over a whole artifact, and the tests below pin the parts of the answer that are decisions rather
than counts.

Three of them earn the file:

- **the stamp is not evidence.** Every turn opens `[2023/05/20 (Sat) 03:51]`, which contains digits, a weekday
  and a time. A rule that reads the stamp as a value would find a "substitution" in every pair of turns and
  would report a reach of 100%.
- **the containment rule is the one that decides, and it is not free.** `anchor` and `anchor+subject` accept
  the same 309 questions on the control artifact, which is why the curve has a shape rather than a slope: the
  subject test is implied by the anchor test, and only containment buys precision.
- **an absent newer value is not a pair.** Three of the nine `KU` failures have no second statement in the
  window at all. A rule that "reaches" them is not reaching a substitution, and the arm's third clause says so.
"""

from __future__ import annotations

import json
import pathlib
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'supersede-census.mjs'


def turn(text: str) -> dict:
    return {'index': 0, 'text': text, 'at': 1_700_000_000_000, 'role': 'user', 'sessionId': 's1'}


def question(turns: list[str], prompt: str, correct: bool = False, capability: str = 'KU') -> dict:
    return {
        'questionId': 'q1',
        'capability': capability,
        'question': prompt,
        'answer': 'x',
        'groundTruth': 'y',
        'correct': correct,
        'turns': [turn(text) for text in turns],
    }


def run(tmp_path, payload: dict | None = None, args: list[str] | None = None) -> subprocess.CompletedProcess:
    path = tmp_path / 'report.json'
    if payload is not None:
        path.write_text(json.dumps(payload), encoding='utf-8')
    command = ['node', str(TOOL)]
    if payload is not None:
        command.append(str(path))
    command.extend(args or [])
    return subprocess.run(command, capture_output=True, text=True, timeout=120)


def census(tmp_path, records: list[dict]) -> dict:
    result = run(tmp_path, {'questions': records}, ['--json'])
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def test_usage_error_is_exit_two(tmp_path):
    result = run(tmp_path, None, [])
    assert result.returncode == 2
    assert 'usage' in result.stderr


def test_a_substitution_is_reached_by_every_rule(tmp_path):
    payload = census(
        tmp_path,
        [
            question(
                [
                    '[2023/05/01 (Mon) 10:00] user: My pre-approval from Wells Fargo was $350,000.',
                    '[2023/06/01 (Thu) 10:00] user: Remember when I got pre-approved for $400,000 from Wells Fargo?',
                ],
                'What was the amount I was pre-approved for from Wells Fargo?',
            )
        ],
    )
    for rule, row in payload['rules'].items():
        assert row['touched'] == 1, rule
        assert row['dropped'] == 1, rule


def test_the_stamp_is_not_a_value(tmp_path):
    """Two turns whose *bodies* state no value, and whose stamps state a time each."""
    payload = census(
        tmp_path,
        [
            question(
                [
                    '[2023/05/01 (Mon) 03:51] user: I started therapy for my knee last spring.',
                    '[2023/06/01 (Thu) 07:45] user: My knee is much better now, thank you for asking.',
                ],
                'How is my knee doing?',
            )
        ],
    )
    for rule, row in payload['rules'].items():
        assert row['touched'] == 0, rule


def test_a_restatement_is_not_a_substitution(tmp_path):
    payload = census(
        tmp_path,
        [
            question(
                [
                    '[2023/05/01 (Mon) 10:00] user: My rent is $1,800 a month.',
                    '[2023/06/01 (Thu) 10:00] user: As I said, my rent is $1,800 a month.',
                ],
                'How much is my rent?',
            )
        ],
    )
    for rule, row in payload['rules'].items():
        assert row['touched'] == 0, rule


def test_without_the_newer_statement_there_is_no_pair(tmp_path):
    payload = census(
        tmp_path,
        [
            question(
                [
                    '[2023/05/01 (Mon) 10:00] user: My rent is $1,800 a month.',
                    '[2023/06/01 (Thu) 10:00] user: The flat has two bedrooms and a balcony.',
                ],
                'How much is my rent?',
            )
        ],
    )
    for rule, row in payload['rules'].items():
        assert row['touched'] == 0, rule


def test_a_number_that_shares_only_the_question_is_reached_by_the_anchor_rule_only(tmp_path):
    """The pair a word-overlap test invents: a gym day pass and a gym membership, worded apart.

    Two content terms in common out of six is a containment of 0.33, which is the line the rule draws: the
    two sentences mention the same *place* and a price, and nothing says they mention the same *attribute*.
    The subject test alone accepts this pair, which is why the curve has a third column at all.
    """
    payload = census(
        tmp_path,
        [
            question(
                [
                    '[2023/02/11 (Sat) 07:00] user: The gym charged me 20 dollars for a day pass and a towel.',
                    '[2023/05/30 (Tue) 07:52] user: The gym membership is 45 dollars a month, billed annually.',
                ],
                'How much does my gym cost?',
            )
        ],
    )
    assert payload['rules']['anchor']['touched'] == 1
    assert payload['rules']['anchor+subject']['touched'] == 1
    assert payload['rules']['anchor+subject+containment']['touched'] == 0


def test_the_containment_line_is_inclusive_at_one_half(tmp_path):
    """`2 of 4` is 0.50 and is accepted — the boundary is stated rather than rounded."""
    payload = census(
        tmp_path,
        [
            question(
                [
                    '[2023/02/11 (Sat) 07:00] user: The gym charged me 20 dollars for a day pass.',
                    '[2023/05/30 (Tue) 07:52] user: The gym membership is 45 dollars a month.',
                ],
                'How much does my gym cost?',
            )
        ],
    )
    assert payload['rules']['anchor+subject+containment']['touched'] == 1


def test_plural_folding_finds_the_pair_a_literal_rule_loses(tmp_path):
    """`followers` in the question, `follower` in the statement that replaces the value."""
    payload = census(
        tmp_path,
        [
            question(
                [
                    '[2023/05/25 (Thu) 05:26] user: I have 1250 followers on Instagram now.',
                    '[2023/05/25 (Thu) 09:02] user: I keep checking my current follower count and I am close to 1300 now.',
                ],
                'How many followers do I have on Instagram now?',
            )
        ],
    )
    assert payload['rules']['anchor+subject+containment']['touched'] == 1


def test_the_table_separates_wrong_from_right(tmp_path):
    payload = census(
        tmp_path,
        [
            question(
                [
                    '[2023/05/01 (Mon) 10:00] user: My rent is $1,800 a month.',
                    '[2023/06/01 (Thu) 10:00] user: My rent went up to $1,950 a month.',
                ],
                'How much is my rent?',
                correct=False,
            ),
            question(
                [
                    '[2023/05/01 (Mon) 10:00] user: The car cost 20 dollars to wash.',
                    '[2023/06/01 (Thu) 10:00] user: The car cost 25 dollars to wash after the price rise.',
                ],
                'How much does my car cost to wash?',
                correct=True,
            ),
        ],
    )
    row = payload['rules']['anchor']
    assert row['touched'] == 2
    assert row['wrong'] == 1
    assert row['right'] == 1
    assert [r['id'] for r in row['reached']] == ['q1']


def test_json_reports_one_row_per_rule_and_the_question_count(tmp_path):
    payload = census(tmp_path, [question(['[2023/05/01 (Mon) 10:00] user: nothing here.'], 'q?')])
    assert payload['questions'] == 1
    assert set(payload['rules']) == {'anchor', 'anchor+subject', 'anchor+subject+containment'}
    for row in payload['rules'].values():
        assert row['touched'] == 0
        assert row['dropped'] == 0


def test_a_drop_that_removes_the_value_reports_it_removed(tmp_path):
    record = question(
        [
            '[2023/05/01 (Mon) 10:00] user: My rent is $1,800 a month.',
            '[2023/06/01 (Thu) 10:00] user: My rent went up to $1,950 a month.',
        ],
        'How much is my rent?',
    )
    record['answer'] = '$1,800'
    record['groundTruth'] = '$1,950'
    payload = census(tmp_path, [record])
    row = payload['rules']['anchor+subject+containment']
    assert row['touched'] == 1
    assert row['removed'] == 1
    assert row['goldLost'] == 0


def test_a_drop_that_leaves_a_copy_behind_reports_it_kept(tmp_path):
    """The `852ce960` shape: the same value restated in a turn the rule did not select."""
    record = question(
        [
            '[2023/05/01 (Mon) 10:00] user: My pre-approval from Wells Fargo was $350,000.',
            '[2023/05/02 (Tue) 10:00] assistant: With a pre-approval of $350,000 the monthly payment is $2,100.',
            '[2023/06/01 (Thu) 10:00] user: Remember when I got pre-approved for $400,000 from Wells Fargo?',
        ],
        'What was the amount I was pre-approved for from Wells Fargo?',
    )
    record['answer'] = '$350,000'
    record['groundTruth'] = '$400,000'
    payload = census(tmp_path, [record])
    row = payload['rules']['anchor+subject+containment']
    assert row['touched'] == 1
    assert row['removed'] == 0
    assert row['reached'][0]['staleRemoved'] is False


def test_gold_lost_is_counted_even_when_the_question_was_right(tmp_path):
    record = question(
        [
            '[2023/05/01 (Mon) 10:00] user: My rent is $1,800 a month.',
            '[2023/06/01 (Thu) 10:00] user: My rent went up to $1,950 a month.',
        ],
        'How much is my rent?',
        correct=True,
    )
    record['answer'] = '$1,950'
    record['groundTruth'] = 'there is no information about the rent after the move'
    payload = census(tmp_path, [record])
    assert payload['rules']['anchor+subject+containment']['goldLost'] == 1
    assert payload['rules']['anchor+subject+containment']['right'] == 1


def test_detail_prints_every_pair_and_the_verdict(tmp_path):
    record = question(
        [
            '[2023/05/01 (Mon) 10:00] user: My rent is $1,800 a month.',
            '[2023/06/01 (Thu) 10:00] user: My rent went up to $1,950 a month.',
        ],
        'How much is my rent?',
    )
    path = tmp_path / 'report.json'
    path.write_text(json.dumps({'questions': [record]}), encoding='utf-8')
    result = run(tmp_path, {'questions': [record]}, ['--detail', 'q1'])
    assert result.returncode == 0, result.stderr
    assert 'ACCEPT' in result.stdout
    assert 'older=0 newer=1' in result.stdout


def test_detail_on_an_absent_id_is_exit_two(tmp_path):
    result = run(tmp_path, {'questions': []}, ['--detail', 'nope'])
    assert result.returncode == 2
    assert 'no question' in result.stderr
