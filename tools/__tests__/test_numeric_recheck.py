"""Tests for tools/numeric-recheck.mjs — the wiring of the judge-free MR reading.

## What this file protects

This is the only reading in the repository whose number does not come from the judge, so the two ways it
could mislead are both mechanical rather than statistical:

* the **capability filter** silently screening another capability, which is the cross-arm defect this
  project has published three times;
* a run where the instrument reads nothing at all printing `0 false accepts`, which is indistinguishable
  from a clean arm and is why the gate exists.

The predicate itself — currency, percentages, units, and the arm's habit of printing its arithmetic
before its answer — is asserted in a vitest file, where it runs on every commit.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'numeric-recheck.mjs'


def artifact(tmp_path: Path) -> Path:
    """A miniature artifact: both judge verdicts, and one gold the instrument cannot read."""
    questions = [
        {
            'questionId': 'mr-ok',
            'capability': 'MR',
            'question': 'How much per mug?',
            'groundTruth': '$12',
            'answer': '$60 / 5 = $12 per mug. 12',
            'correct': True,
        },
        {
            'questionId': 'mr-false-accept',
            'capability': 'MR',
            'question': 'How many events?',
            'groundTruth': '2',
            'answer': 'There were 3 events.',
            'correct': True,
        },
        {
            'questionId': 'mr-false-reject',
            'capability': 'MR',
            'question': 'How many mugs?',
            'groundTruth': '5',
            'answer': '4 + 1 = 5 5',
            'correct': False,
        },
        {
            'questionId': 'mr-blind',
            'capability': 'MR',
            'question': 'How long was the commute?',
            'groundTruth': 'an hour and a half',
            'answer': '90 minutes',
            'correct': True,
        },
        {
            'questionId': 'tr-ok',
            'capability': 'TR',
            'question': 'How many months ago?',
            'groundTruth': '5',
            'answer': '5',
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


def test_only_rows_in_the_capability_are_read(tmp_path: Path) -> None:
    result = run('--artifact', str(artifact(tmp_path)))
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'capability        MR' in result.stdout
    assert '(4 of 5 rows in scope)' in result.stdout, result.stdout


def test_the_reading_reports_a_judge_free_accuracy_over_the_rows_it_can_read(tmp_path: Path) -> None:
    # Three readable MR rows: one agrees, one states a different number, one is a false reject.
    result = run('--artifact', str(artifact(tmp_path)))
    assert 'judge-free accuracy  2/3 (66.7%)' in result.stdout, result.stdout
    assert 'unreachable 1 of 4' in result.stdout, result.stdout


def test_both_directions_are_listed_separately(tmp_path: Path) -> None:
    # A false accept and a false reject are different failures and a single count would conflate them.
    # The false reject is the one the judge audit cannot produce: it only perturbs accepted answers.
    result = run('--artifact', str(artifact(tmp_path)))
    assert 'false accept   mr-false-accept' in result.stdout, result.stdout
    assert 'false reject   mr-false-reject' in result.stdout, result.stdout


def test_an_unreadable_population_fails_rather_than_reporting_clean(tmp_path: Path) -> None:
    # "0 false accepts" and "the instrument read nothing" print the same number. The first name reading
    # shipped that ambiguity for one run.
    path = tmp_path / 'blind.json'
    path.write_text(
        json.dumps(
            {
                'questions': [
                    {
                        'questionId': 'x',
                        'capability': 'MR',
                        'question': 'How long?',
                        'groundTruth': 'an hour and a half',
                        'answer': 'ninety minutes',
                        'correct': True,
                    }
                ]
            }
        )
    )
    result = run('--artifact', str(path))
    assert result.returncode == 1, result.stdout + result.stderr
    assert 'GATE FAILS' in result.stdout


def test_the_written_reading_is_reproducible_and_carries_both_lists(tmp_path: Path) -> None:
    path = artifact(tmp_path)
    out = tmp_path / 'reading.json'
    first = run('--artifact', str(path), '--out', str(out))
    assert first.returncode == 0
    original = out.read_text()
    assert run('--artifact', str(path), '--out', str(out)).returncode == 0
    assert out.read_text() == original

    payload = json.loads(original)
    assert payload['judgeFree'] == {'correct': 2, 'total': 3, 'unreachable': 1}
    assert [row['questionId'] for row in payload['falseAccepts']] == ['mr-false-accept']
    assert [row['questionId'] for row in payload['falseRejects']] == ['mr-false-reject']
    assert payload['falseAccepts'][0]['stated'] == 3
    assert payload['falseAccepts'][0]['goldValues'] == [2]


def test_the_sample_shows_disagreements_rather_than_agreements(tmp_path: Path) -> None:
    # The rows a reader has to adjudicate are the ones that disagree; a sample of agreements would
    # confirm the instrument and teach nothing.
    result = run('--artifact', str(artifact(tmp_path)), '--sample', '3')
    assert result.returncode == 0
    _, _, sample = result.stdout.partition('sample (')
    assert 'mr-ok' not in sample, sample
    assert 'mr-false-accept' in sample, sample
    assert 'mr-blind' in sample, sample


def test_a_missing_questions_array_is_refused(tmp_path: Path) -> None:
    path = tmp_path / 'bad.json'
    path.write_text(json.dumps({'questions': None}))
    result = run('--artifact', str(path))
    assert result.returncode != 0
    assert 'no questions array' in result.stderr, result.stderr
