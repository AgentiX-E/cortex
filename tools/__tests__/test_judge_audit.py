"""Tests for tools/judge-audit.mjs — the half that can be reviewed without a model or a key.

## What this file protects

Every accuracy number this project publishes is a judge's opinion, and the campaign resolves
differences of two or three questions on a 121-question capability. The audit re-submits answers the
judge already accepted, perturbed so that they are wrong by construction, and counts how many it
accepts anyway.

The rate is worth nothing unless the *cases* are right, so these tests hold the parts that do not
need a model: which questions are eligible, which are deliberately excluded, and whether the plan is
reproducible from the artifact alone. The planner's own invariants — every case provably wrong, no
introduced token the model could have read — are asserted in
`packages/cortex-eval/src/__tests__/judge-audit.test.ts`, where they can run on every commit; what is
asserted here is the wiring, because a correct planner fed the wrong questions still produces a
meaningless rate.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'judge-audit.mjs'


def artifact(tmp_path: Path) -> Path:
    """A miniature report with one eligible question per interesting case."""
    questions = [
        {
            'questionId': 'q-mr',
            'question': 'How many days until the trip?',
            'capability': 'MR',
            'groundTruth': '18 days',
            'answer': 'It is 18 days away.',
            'correct': True,
            'turns': [{'index': 0, 'text': 'user: the trip is booked for the eighteenth'}],
        },
        {
            # Rejected by the judge in the artifact, so there is nothing left to falsify: an answer
            # already called wrong cannot produce a false accept.
            'questionId': 'q-wrong',
            'question': 'When does the trip start?',
            'capability': 'MR',
            'groundTruth': 'Monday',
            'answer': 'I do not know.',
            'correct': False,
            'turns': [],
        },
        {
            # Abstention questions are excluded by construction: their template asks whether the
            # model recognised the question as unanswerable, so substituting a name does not make the
            # answer wrong and the case would measure nothing while looking like a rate.
            'questionId': 'q-abs',
            'question': 'What did the user say about the missing invoice?',
            'capability': 'ABS',
            'groundTruth': 'The question cannot be answered from the conversation.',
            'answer': 'INSUFFICIENT_EVIDENCE',
            'correct': True,
            'turns': [],
        },
        {
            'questionId': 'q-ie',
            'question': 'Where did Rachel move?',
            'capability': 'IE',
            'groundTruth': 'Rachel moved to Berlin.',
            'answer': 'Rachel moved to Berlin.',
            'correct': True,
            'turns': [
                {'index': 0, 'text': 'user: Rachel said she was leaving Lisbon for a new job'},
                {'index': 1, 'text': 'assistant: That sounds like a big change'},
            ],
        },
    ]
    path = tmp_path / 'report.json'
    path.write_text(json.dumps({'questions': questions}))
    return path


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(TOOL), *args], cwd=REPO, capture_output=True, text=True, timeout=180
    )


def test_only_accepted_non_abstention_answers_are_audited(tmp_path: Path) -> None:
    result = run('--artifact', str(artifact(tmp_path)), '--plan-only')
    assert result.returncode == 0, result.stdout + result.stderr
    # Two of the four questions: the rejected one has nothing to falsify, the abstention one cannot
    # be falsified by substitution.
    assert 'accepted answers audited   2' in result.stdout, result.stdout


def test_the_plan_is_reproducible_from_the_artifact_alone(tmp_path: Path) -> None:
    # The published rate has to be reconstructible by a reader who has the artifact and nothing else
    # — no seed, no clock, no model. Two runs must print the same case list, byte for byte.
    path = artifact(tmp_path)
    first = run('--artifact', str(path), '--plan-only')
    second = run('--artifact', str(path), '--plan-only')
    assert first.returncode == 0
    assert first.stdout == second.stdout


def test_a_limit_bounds_the_audit_and_is_printed(tmp_path: Path) -> None:
    result = run('--artifact', str(artifact(tmp_path)), '--plan-only', '--limit', '1')
    assert result.returncode == 0
    assert 'accepted answers audited   1' in result.stdout


def test_an_artifact_with_nothing_auditable_fails_rather_than_reporting_zero(tmp_path: Path) -> None:
    # A rate over no cases is the failure this project keeps finding: a zero that reads as a pass.
    path = tmp_path / 'empty.json'
    path.write_text(
        json.dumps(
            {
                'questions': [
                    {
                        'questionId': 'q',
                        'question': 'anything',
                        'capability': 'ABS',
                        'groundTruth': 'cannot be answered',
                        'answer': 'INSUFFICIENT_EVIDENCE',
                        'correct': True,
                        'turns': [],
                    }
                ]
            }
        )
    )
    result = run('--artifact', str(path), '--plan-only')
    assert result.returncode == 1
    assert 'no auditable cases' in result.stderr, result.stderr


def test_the_plan_prints_what_it_introduced(tmp_path: Path) -> None:
    # The reviewable claim. A reader has to be able to see the substitution and judge whether the
    # case is really wrong, without running the judge.
    result = run('--artifact', str(artifact(tmp_path)), '--plan-only')
    assert 'introduced' in result.stdout
    assert 'perturbed' in result.stdout
    assert 'original' in result.stdout


def test_the_committed_reading_recomputes(tmp_path: Path) -> None:
    """The arithmetic has to survive a reader who cannot run the audit.

    31 of 160 is 19.38%, and the Wilson upper bound is 26.19% -- the number the gate failed on. The
    control is 120 of 120, which is what makes the false-accept rate readable at all: a judge that
    rejected everything would also have produced a 0% rate.
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

    reading = json.loads((REPO / 'tools' / 'judge-audit-reading.json').read_text())
    overall = reading['reading']['all']
    assert abs(overall['rate'] - overall['accepted'] / overall['total']) < 5e-4
    assert abs(overall['upper'] - wilson_upper(overall['accepted'], overall['total'])) < 5e-4
    assert reading['verdict'] == 'fails'
    assert overall['upper'] > 0.05

    kinds = reading['reading']['byKind']
    assert sum(kind['total'] for kind in kinds.values()) == overall['total']
    assert sum(kind['accepted'] for kind in kinds.values()) == overall['accepted']
    for kind, bucket in kinds.items():
        assert abs(bucket['upper'] - wilson_upper(bucket['accepted'], bucket['total'])) < 5e-4, kind

    # The control is the reason the rate means anything.
    assert reading['reading']['control']['accepted'] == reading['reading']['control']['total']


def test_the_reading_records_which_prediction_it_falsified() -> None:
    # A reading file that only keeps the numbers invites the next reader to keep only the flattering
    # one. The falsified prediction is the finding: the weak kind is the name, not the number.
    reading = json.loads((REPO / 'tools' / 'judge-audit-reading.json').read_text())
    verdicts = {prediction['name']: prediction['verdict'] for prediction in reading['predictions']}
    assert verdicts['numbers are the weak kind'] == 'falsified'
    assert verdicts['the judge is reproducible'] == 'holds'
    kinds = reading['reading']['byKind']
    assert kinds['entity-swap']['rate'] > kinds['number-swap']['rate']
