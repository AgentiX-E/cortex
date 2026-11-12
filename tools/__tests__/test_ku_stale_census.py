"""Tests for `tools/ku-stale-census.mjs`, the instrument that splits a capability's failures by mechanism.

`MEASURE-KU-STALE.md` reads nine questions and finds that all nine answered with the value the corpus stated
earlier. That is one sentence and two repairs: a question whose **newer** value was also delivered can only be
fixed by changing what the window is, and a question whose newer value never arrived can only be fixed by
retrieval. A tool that printed "9 wrong" would support neither.

The boundary test is the one that earns this file. The first version of the tool flattened the window to a
single string and every row came back `neither`; the second used a substring test and reported `c7dc5443` as a
stale twin because the digits `52` appear somewhere in 22 turns of transcript. Both are the same defect -- a
census that cannot tell a value from its digits will report a mechanism that is not there -- so the tests below
pin the token boundary from both sides: a short gold is not found inside a longer number, and a value the corpus
wrote with a comma is found.
"""

from __future__ import annotations

import json
import pathlib
import re
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'ku-stale-census.mjs'


def turn(text: str) -> dict:
    return {'index': 0, 'text': text, 'at': 1_700_000_000_000, 'role': 'user', 'sessionId': 's1'}


def record(
    question_id: str,
    answer: str,
    gold: str,
    correct: bool,
    turns: list[str],
    capability: str = 'KU',
) -> dict:
    return {
        'questionId': question_id,
        'capability': capability,
        'question': 'q',
        'answer': answer,
        'groundTruth': gold,
        'correct': correct,
        'turns': [turn(text) for text in turns],
    }


def artifact(records: list[dict]) -> dict:
    return {'questions': records}


def run(tmp_path, payload: dict | None = None, args: list[str] | None = None) -> subprocess.CompletedProcess:
    path = tmp_path / 'report.json'
    if payload is not None:
        path.write_text(json.dumps(payload), encoding='utf-8')
    command = ['node', str(TOOL)]
    if payload is not None:
        command.append(str(path))
    command.extend(args or [])
    return subprocess.run(command, capture_output=True, text=True, cwd=REPO, check=False)


def census(tmp_path, payload: dict) -> str:
    result = run(tmp_path, payload)
    assert result.returncode == 0, result.stderr
    return result.stdout


def test_a_stale_twin_is_a_wrong_answer_with_both_values_delivered(tmp_path) -> None:
    """The four of `MEASURE-KU-STALE.md` section 2: newer value delivered, older one returned."""
    payload = artifact(
        [
            record(
                'q1',
                '$350,000',
                '$400,000',
                False,
                ['[2023/05/24] user: pre-approved for $350,000', '[2023/06/02] user: approved for $400,000'],
            ),
            record('q2', '1250', '1300', False, ['[2023/04/01] user: 1250 followers', '[2023/06/01] user: 1300 followers']),
        ]
    )
    out = census(tmp_path, payload)
    assert re.search(r'stale-twin\s+2\b', out), out
    assert 'answered with the superseded value: 2 / 2 (100.0%)' in out


def test_an_undelivered_update_is_a_wrong_answer_with_only_the_old_value(tmp_path) -> None:
    """The five of section 2: the newer value is not in the window, so retrieval owns it."""
    payload = artifact(
        [record('q1', '37', '38', False, ['[2023/05/01] user: I have 37 pre-1920 coins'])],
    )
    out = census(tmp_path, payload)
    assert re.search(r'undelivered\s+1\b', out), out
    assert re.search(r'stale-twin\s+0\b', out), out


def test_a_short_gold_is_not_found_inside_a_longer_number(tmp_path) -> None:
    """`37` inside `1370` is the substring defect that made the first two versions wrong.

    A census that answers "the gold was delivered" from a substring would report every short numeric gold as a
    stale twin, which is the reading that licenses a rendering change for a population retrieval owns.
    """
    payload = artifact(
        [record('q1', '37', '38', False, ['[2023/05/01] user: I ran 1370 metres', '[2023/05/02] user: 1380 next'])],
    )
    out = census(tmp_path, payload)
    # Neither `37` nor `38` appears as a token run, so this is "neither" -- not "stale twin".
    assert re.search(r'neither\s+1\b', out), out
    assert 'answered with the superseded value: 0 / 1 (0.0%)' in out


def test_a_value_written_with_a_thousands_separator_is_still_found(tmp_path) -> None:
    """`$350,000` in the transcript and `350000` in the gold are the same value."""
    payload = artifact([record('q1', '350,000', '400000', False, ['[2023/05/24] user: $350,000 approved'])])
    out = census(tmp_path, payload)
    # `400000` is absent from the window, so the answer is the old value and the new one never arrived -- but the
    # old value was found, which is the half this test is about: the comma did not hide it.
    assert re.search(r'undelivered\s+1\b', out), out
    assert re.search(r'stale-twin\s+0\b', out), out


def test_a_right_answer_is_not_counted_in_the_split(tmp_path) -> None:
    """`right` is printed beside `wrong` because the split is only interpretable against it."""
    payload = artifact(
        [
            record('q1', '$400,000', '$400,000', True, ['[2023/06/02] user: $400,000 approved']),
            record('q2', '$350,000', '$400,000', False, ['[2023/05/24] user: $350,000', '[2023/06/02] user: $400,000']),
        ]
    )
    out = census(tmp_path, payload)
    assert 'capability KU: 1 right, 1 wrong of 2' in out
    assert re.search(r'stale-twin\s+1\b', out), out


def test_the_capability_filter_is_honoured(tmp_path) -> None:
    """`MR` questions are not update questions, so including them would read a gold as a newer value."""
    payload = artifact(
        [
            record('q1', 'a', 'b', False, ['x'], capability='MR'),
            record('q2', 'Four', 'seven', False, ['[2023/05/01] user: four stories']),
        ]
    )
    out = census(tmp_path, payload)
    assert 'capability KU: 0 right, 1 wrong of 1' in out


def test_an_empty_answer_or_an_empty_window_is_neither(tmp_path) -> None:
    """Two degenerate records, both of which must not divide by a length they do not have."""
    payload = artifact(
        [
            record('q1', '', 'seven', False, ['[2023/05/01] user: some text']),
            record('q2', 'Four', 'seven', False, []),
        ]
    )
    out = census(tmp_path, payload)
    assert re.search(r'neither\s+2\b', out), out
    assert 'answered with the superseded value: 0 / 2 (0.0%)' in out


def test_no_questions_at_all_does_not_divide_by_zero(tmp_path) -> None:
    out = census(tmp_path, artifact([]))
    assert 'capability KU: 0 right, 0 wrong of 0' in out
    assert '(0.0%)' in out


def test_more_than_one_artifact_is_read_in_order(tmp_path) -> None:
    """A round compares two runs, so the tool has to accept the control and the arm in one call."""
    first = tmp_path / 'a.json'
    second = tmp_path / 'b.json'
    first.write_text(json.dumps(artifact([record('q1', '37', '38', False, ['37'])])))
    second.write_text(json.dumps(artifact([record('q1', 'Four', 'seven', False, ['four'])])).replace('four', 'Four'))
    result = subprocess.run(
        ['node', str(TOOL), str(first), str(second)],
        capture_output=True,
        text=True,
        cwd=REPO,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout.count('capability KU:') == 2
    assert str(first) in result.stdout and str(second) in result.stdout


def test_the_capability_flag_overrides_the_default(tmp_path) -> None:
    payload = artifact([record('q1', 'a', 'b', False, ['x'], capability='TR')])
    result = run(tmp_path, payload, ['--capability', 'TR'])
    assert result.returncode == 0, result.stderr
    assert 'capability TR: 0 right, 1 wrong of 1' in result.stdout


def test_missing_argument_prints_usage_and_exits_two() -> None:
    result = subprocess.run(['node', str(TOOL)], capture_output=True, text=True, cwd=REPO, check=False)
    assert result.returncode == 2
    assert 'usage:' in result.stderr
