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
    assert '(4 of 5 rows in scope;' in result.stdout, result.stdout


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


def test_a_decline_stays_in_the_denominator(tmp_path: Path) -> None:
    """The silent-denominator defect this tool shipped for one run.

    A decline is written without an `answer` key, and the first version of `sourcesFrom` filtered on
    `typeof question.answer === 'string'` — which dropped every decline. MR lost 8 of its 121 rows and
    nothing anywhere said so: a decline is never correct, so the numerator was untouched and the reading
    looked whole. `§13.186` is the reconciliation; this is the test.
    """
    path = tmp_path / 'decline.json'
    path.write_text(
        json.dumps(
            {
                'questions': [
                    {
                        'questionId': 'mr-answered',
                        'capability': 'MR',
                        'question': 'How many?',
                        'groundTruth': '2',
                        'answer': '2',
                        'correct': True,
                    },
                    # A decline: no `answer` at all, and counted wrong by the judge.
                    {
                        'questionId': 'mr-declined',
                        'capability': 'MR',
                        'question': 'How many?',
                        'groundTruth': '3',
                        'correct': False,
                    },
                ]
            }
        )
    )
    result = run('--artifact', str(path))
    assert result.returncode == 0, result.stdout + result.stderr
    assert '(2 of 2 rows in scope; 0 of 2 unusable, no verdict)' in result.stdout, result.stdout
    # The decline is `answer-unreachable`, which is a relation rather than a silent exclusion.
    assert 'answer-unreachable 1' in result.stdout, result.stdout


def test_the_committed_reading_recomputes() -> None:
    """The arithmetic has to survive a reader who cannot run the benchmark.

    0 of 80 is 0.0%, and the Wilson 95% upper bound is 4.58% -- the number that decides whether MR is
    judge-limited. The audit's own gate fails above 5%, so a bound of 4.6% on the channel MR actually has
    is the reason `§13.186` withdraws the annotation rather than repeating it.
    """
    import math

    def wilson_upper(accepted: int, total: int, z: float = 1.96) -> float:
        if total == 0:
            return 1.0
        p = accepted / total
        denominator = 1 + (z * z) / total
        centre = p + (z * z) / (2 * total)
        margin = z * math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))
        return min(1.0, (centre + margin) / denominator)

    reading = json.loads((REPO / 'tools' / 'numeric-recheck-reading.json').read_text())
    mr = reading['reading']['MR']
    bound = mr['falseAccept']
    assert abs(bound['upper'] - wilson_upper(bound['accepted'], bound['readable'])) < 5e-4
    assert bound['accepted'] == 0 and bound['readable'] == 80
    assert bound['upper'] < 0.05

    # The five relations partition each judge population, so no row can be counted twice or lost.
    for side in ('accepted', 'rejected'):
        tally = mr[side]
        total = tally['agrees'] + tally['agrees-early'] + tally['differs'] + tally['gold-unreachable'] + tally['answer-unreachable']
        assert total == tally['total'], side

    # Rows: accepted + rejected is the capability's whole population, which is the silent-denominator
    # fix stated as arithmetic.
    assert mr['accepted']['total'] + mr['rejected']['total'] == mr['rows'] == 121

    # And the by-capability table has to agree with the per-capability run.
    assert reading['reading']['byCapability']['MR']['falseAccepts'] == bound['accepted']
    assert (
        reading['reading']['byCapability']['all']['falseAccepts']
        == sum(
            bucket['falseAccepts'] for name, bucket in reading['reading']['byCapability'].items() if name != 'all'
        )
    )


def test_the_reading_says_which_registered_prediction_it_falsified() -> None:
    reading = json.loads((REPO / 'tools' / 'numeric-recheck-reading.json').read_text())
    verdicts = {prediction['name']: prediction['verdict'] for prediction in reading['predictions']}
    assert verdicts["the judge's leniency reaches MR"] == 'falsified'
    assert reading['verdict'] == 'MR is not judge-limited'
    # The withdrawal is part of the record, not a silent edit: the previous annotation is quoted in it.
    assert any('23.5' in item for item in reading['whatItChanges'])
