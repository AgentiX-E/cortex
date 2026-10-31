"""Tests for tools/mr-entity-recheck.mjs — the wiring, not the predicate.

## What this file protects

The screen turns the judge audit's 19.38% into a list of accepted answers whose names are disjoint
from their gold's, using an artifact that already exists. The predicate itself — the four relations
and the case-folding — is asserted in a vitest file where it runs on every commit. What is asserted
here is that the tool feeds it the right rows and reports the result in a form that cannot be
misread:

* the **capability filter** works, because screening `IE` while calling it an MR reading is the
  cross-arm defect this project has already published three times;
* the **rejected population is reported separately**, because a screen that fires equally often on
  answers the judge rejected is not detecting wrongness and the candidate count would be worthless;
* a run with **no accepted row exits non-zero**, because "zero candidates" and "the screen did not
  reach" print the same number and mean opposite things.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'mr-entity-recheck.mjs'


def artifact(tmp_path: Path) -> Path:
    """A miniature artifact: one row per interesting relation, in two capabilities."""
    questions = [
        {
            'questionId': 'mr-accepted-disjoint',
            'question': 'Which shelter did the user adopt from?',
            'capability': 'MR',
            'groundTruth': 'The user adopted a Golden Retriever named Max from the Denver shelter.',
            'answer': 'They adopted a Labrador named Biscuit from the Boulder shelter.',
            'correct': True,
        },
        {
            'questionId': 'mr-accepted-shared',
            'question': 'Which shelter did the user adopt from?',
            'capability': 'MR',
            'groundTruth': 'Denver',
            'answer': 'The Denver shelter.',
            'correct': True,
        },
        {
            'questionId': 'mr-accepted-number',
            'question': 'How many pets does the user have?',
            'capability': 'MR',
            'groundTruth': 'Alice has two dogs.',
            'answer': '2',
            'correct': True,
        },
        {
            'questionId': 'mr-rejected-disjoint',
            'question': 'Who moved away?',
            'capability': 'MR',
            'groundTruth': 'Rachel moved to Berlin.',
            'answer': 'Monica moved to Lisbon.',
            'correct': False,
        },
        {
            'questionId': 'tr-accepted-disjoint',
            'question': 'What happened first?',
            'capability': 'TR',
            'groundTruth': 'Rachel moved to Berlin in March.',
            'answer': 'Monica moved to Lisbon in May.',
            'correct': True,
        },
    ]
    path = tmp_path / 'report.json'
    path.write_text(json.dumps({'questions': questions}))
    return path


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(TOOL), *args], cwd=REPO, capture_output=True, text=True, timeout=180
    )


def test_only_rows_in_the_requested_capability_are_screened(tmp_path: Path) -> None:
    result = run('--artifact', str(artifact(tmp_path)))
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'capability        MR' in result.stdout
    # Four MR rows in scope, out of five in the artifact.
    assert '(4 of 5 rows in scope;' in result.stdout, result.stdout


def test_capability_all_screens_every_row(tmp_path: Path) -> None:
    result = run('--artifact', str(artifact(tmp_path)), '--capability', 'all')
    assert result.returncode == 0
    assert '(5 of 5 rows in scope;' in result.stdout, result.stdout


def test_the_candidate_is_printed_with_both_texts(tmp_path: Path) -> None:
    # The number is not the deliverable; the reviewer's ability to check the number is. A candidate
    # line that did not print the gold and the answer could only be trusted, never audited.
    result = run('--artifact', str(artifact(tmp_path)))
    assert 'mr-accepted-disjoint' in result.stdout
    assert 'Labrador' in result.stdout
    assert 'Golden Retriever' in result.stdout
    assert 'gold names' in result.stdout and 'answer names' in result.stdout


def test_a_rejected_answer_is_the_control_and_not_a_candidate(tmp_path: Path) -> None:
    result = run('--artifact', str(artifact(tmp_path)))
    assert 'rejected    1 rows' in result.stdout, result.stdout
    # `mr-rejected-disjoint` has disjoint names too, and must appear in the tally rather than in the
    # list of answers to subtract from an accuracy: the judge already called it wrong.
    head, _, tail = result.stdout.partition('candidates (accepted')
    assert 'mr-rejected-disjoint' not in tail, tail
    assert 'disjoint names    accepted 1/3' in head, head


def test_a_number_answer_is_unnamed_rather_than_clean(tmp_path: Path) -> None:
    # `mr-accepted-number` answers "2" to a gold that names Alice. It is not a candidate and it is not
    # cleared either: it is `answer unnamed`, and the reach line is what keeps that visible.
    result = run('--artifact', str(artifact(tmp_path)))
    assert 'answer unnamed' in result.stdout
    assert 'reach             3 of 3 accepted rows' in result.stdout, result.stdout


def test_no_accepted_row_in_the_capability_fails(tmp_path: Path) -> None:
    # The failure mode this gate exists for: a mistyped capability screens nothing and reports zero
    # candidates, which reads exactly like a clean judge.
    result = run('--artifact', str(artifact(tmp_path)), '--capability', 'IE')
    assert result.returncode == 1, result.stdout + result.stderr
    assert 'GATE FAILS' in result.stdout


def test_the_reading_is_reproducible_byte_for_byte(tmp_path: Path) -> None:
    path = artifact(tmp_path)
    out = tmp_path / 'reading.json'
    first = run('--artifact', str(path), '--out', str(out))
    assert first.returncode == 0
    original = out.read_text()
    second = run('--artifact', str(path), '--out', str(out))
    assert second.returncode == 0
    assert out.read_text() == original


def test_the_written_reading_carries_the_discrimination_ratio(tmp_path: Path) -> None:
    # Accepted 1/3 and rejected 1/1 give a ratio of 0.333, i.e. the screen fires three times more
    # often on answers the judge rejected. A reading that omitted this would publish a count with no
    # evidence that the predicate detects wrongness at all.
    out = tmp_path / 'reading.json'
    result = run('--artifact', str(artifact(tmp_path)), '--out', str(out))
    assert result.returncode == 0
    payload = json.loads(out.read_text())
    assert payload['accepted']['total'] == 3
    assert payload['rejected']['total'] == 1
    assert payload['reachable'] == 3
    assert abs(payload['discrimination']['acceptedRate'] - 1 / 3) < 1e-9
    assert abs(payload['discrimination']['rejectedRate'] - 1.0) < 1e-9
    assert [row['questionId'] for row in payload['candidates']] == ['mr-accepted-disjoint']


def test_a_missing_questions_array_is_refused(tmp_path: Path) -> None:
    path = tmp_path / 'bad.json'
    path.write_text(json.dumps({'notQuestions': []}))
    result = run('--artifact', str(path))
    assert result.returncode != 0
    assert 'no questions array' in result.stderr, result.stderr


def test_the_sample_is_bounded_and_reproducible(tmp_path: Path) -> None:
    """The next instrument has to be designed from golds, so the sample has to be stable.

    `§13.185` came back with 0 candidates and 82 of 84 golds naming nothing: a statement that the screen
    did not reach, not that the answers are clean. Designing a replacement from that number alone would
    be guessing, so the sample prints the golds themselves — in id order, so two runs of the same
    artifact print the same rows and a reading can cite them.
    """
    path = artifact(tmp_path)
    first = run('--artifact', str(path), '--capability', 'all', '--sample', '2')
    second = run('--artifact', str(path), '--capability', 'all', '--sample', '2')
    assert first.returncode == 0, first.stderr
    assert first.stdout == second.stdout
    assert 'sample (2 rows' in first.stdout
    # Both texts, because a gold alone does not say whether the answer is wrong.
    assert 'gold    ' in first.stdout and 'answer  ' in first.stdout
    # Bounded: five rows in the artifact, two printed. Counted inside the sample section, because the
    # word `accepted` also appears in the tallies above it.
    _, _, sample = first.stdout.partition('sample (2 rows')
    assert sample.count(' accepted ') + sample.count(' rejected ') == 2, sample


def test_a_decline_is_screened_rather_than_dropped(tmp_path: Path) -> None:
    """The same silent-denominator defect, in the name screen.

    A decline has no `answer` key. Dropping it shrinks the population without saying so, and the
    population is what the registered prediction was written against (84 of 121, not 84 of 113).
    """
    path = tmp_path / 'decline.json'
    path.write_text(
        json.dumps(
            {
                'questions': [
                    {
                        'questionId': 'mr-answered',
                        'capability': 'MR',
                        'question': 'Who moved?',
                        'groundTruth': 'Rachel',
                        'answer': 'Rachel',
                        'correct': True,
                    },
                    {
                        'questionId': 'mr-declined',
                        'capability': 'MR',
                        'question': 'Who moved?',
                        'groundTruth': 'Rachel',
                        'correct': False,
                    },
                ]
            }
        )
    )
    result = run('--artifact', str(path))
    assert result.returncode == 0, result.stdout + result.stderr
    assert '(2 of 2 rows in scope; 0 of 2 unusable, no verdict)' in result.stdout, result.stdout
    assert 'answer unnamed   1' in result.stdout, result.stdout


def test_the_committed_reading_recomputes() -> None:
    """The name reading's whole content is that it does not reach MR.

    0 candidates out of 84 accepted, with a reach of 2: the screen saw 2 of the 84 golds. A reader with
    the artifact can confirm all three numbers, which is the only reason the falsified prediction is worth
    publishing.
    """
    reading = json.loads((REPO / 'tools' / 'mr-entity-recheck-reading.json').read_text())
    mr = reading['reading']['MR']
    assert mr['candidates'] == 0
    assert mr['reach'] == 2 and mr['reachOf'] == 84
    # The four relations partition the accepted population.
    tally = mr['accepted']
    assert (
        tally['shared-name'] + tally['names-disjoint'] + tally['unnamed-gold'] + tally['unnamed-answer']
        == tally['total']
        == 84
    )
    # 82 of the 84 golds name nothing, which is the explanation rather than the result.
    assert tally['unnamed-gold'] == 82

    # The control: the screen is not simply blind everywhere. On all five capabilities it fires 5 times on
    # 81 rejected answers and 5 times on 419 accepted ones.
    everything = reading['reading']['all']
    assert everything['rejected']['names-disjoint'] == 5
    assert everything['accepted']['names-disjoint'] == 5
    assert everything['reach'] == 119


def test_the_reading_records_the_prediction_it_falsified() -> None:
    reading = json.loads((REPO / 'tools' / 'mr-entity-recheck-reading.json').read_text())
    verdicts = {prediction['name']: prediction['verdict'] for prediction in reading['predictions']}
    assert verdicts['the registered one'] == 'falsified'
    assert reading['verdict'] == 'the screen does not reach MR'
    # The withdrawal of the previous iteration's annotation is in the file rather than in a commit message.
    assert 'judge-limited' in reading['withdrawn']
