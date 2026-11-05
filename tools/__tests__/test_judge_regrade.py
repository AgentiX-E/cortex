"""Tests for tools/judge-regrade.mjs — the half that runs without a model or a key.

## What this file protects

`judge-audit.mjs` measures the judge's **bias**: it asks about answers that are wrong by construction.
This tool measures the judge's **variance**: it asks about the same answer twice and counts how often
the verdict moves. §13.255.3 left that split open — two dispatches of one configuration produced
identical bytes and still moved 16 questions — so the number this tool prints is subtracted from the
arm's noise floor rather than added to it.

The rate is worthless if the loop is not actually asking twice, and the failure is silent:
`createLlmJudge` memoises on the prompt, so a two-pass loop without `clearJudgeCache()` returns the
first verdict on every pass and reports a perfect 0.0%. That defect cannot be caught here (it needs a
model), so what is asserted here is the wiring — which questions are gradable, what the plan prints,
and that a single pass is refused — plus the pure counting in `tally` and `signTest`, which are
exported for exactly that reason.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'judge-regrade.mjs'


def artifact(tmp_path: Path) -> Path:
    """A miniature report covering the cases that decide eligibility."""
    questions = [
        {
            'questionId': 'q-ie',
            'question': 'Where did I put the keys?',
            'capability': 'IE',
            'questionType': 'single-session-user',
            'groundTruth': 'in the drawer',
            'answer': 'In the kitchen drawer.',
            'correct': True,
        },
        {
            'questionId': 'q-abs',
            'question': 'What is my sister called?',
            'capability': 'ABS',
            'questionType': 'single-session-user_abs',
            'groundTruth': 'The user never mentioned a sister.',
            'answer': 'You have not mentioned a sister.',
            'correct': True,
        },
        {
            'questionId': 'q-noanswer',
            'question': 'Where did I put the keys?',
            'capability': 'IE',
            'questionType': 'single-session-user',
            'groundTruth': 'in the drawer',
            'answer': '   ',
            'correct': False,
        },
        {
            'questionId': 'q-nogold',
            'question': 'Where did I put the keys?',
            'capability': 'IE',
            'questionType': 'single-session-user',
            'groundTruth': '',
            'answer': 'In the kitchen drawer.',
            'correct': False,
        },
    ]
    path = tmp_path / 'report.json'
    path.write_text(json.dumps({'questions': questions}), encoding='utf-8')
    return path


def run(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ['node', str(TOOL), *args],
        capture_output=True,
        text=True,
        cwd=REPO,
        timeout=120,
    )


def test_plan_lists_only_questions_that_can_be_graded(tmp_path: Path) -> None:
    """A question with no answer, or with no gold, has nothing to re-grade.

    The plan is the reviewable form: it prints what a real run would spend, so an ineligible question
    showing up here would be a question whose verdict could never be compared.
    """
    result = run('--artifact', str(artifact(tmp_path)), '--plan-only')
    assert result.returncode == 0, result.stderr
    assert 'questions       2' in result.stdout
    assert 'q-ie' in result.stdout
    # Abstention is gradable here — nothing is perturbed — which is the opposite of the false-accept
    # audit's rule and the reason the two tools are separate.
    assert 'q-abs' in result.stdout
    assert 'q-noanswer' not in result.stdout


def test_plan_reports_the_recorded_correct_count(tmp_path: Path) -> None:
    """`recorded correct` is what the artifact claimed, and it is the number the flips are read against."""
    result = run('--artifact', str(artifact(tmp_path)), '--plan-only')
    assert 'recorded correct 2 / 2' in result.stdout


def test_a_single_pass_is_refused(tmp_path: Path) -> None:
    """One pass has no second reading, so a flip rate from it would be 0 by construction."""
    result = run('--artifact', str(artifact(tmp_path)), '--passes', '1', '--plan-only')
    assert result.returncode == 2
    assert 'passes must be an integer >= 2' in result.stderr


def test_a_non_integer_pass_count_is_refused(tmp_path: Path) -> None:
    result = run('--artifact', str(artifact(tmp_path)), '--passes', '1.5', '--plan-only')
    assert result.returncode == 2


def test_the_tool_refuses_an_artifact_with_nothing_to_grade(tmp_path: Path) -> None:
    """Zero gradable questions is a refusal rather than a 0.0% reading, which would look like a result."""
    empty = tmp_path / 'empty.json'
    empty.write_text(json.dumps({'questions': []}), encoding='utf-8')
    result = run('--artifact', str(empty), '--plan-only')
    assert result.returncode == 1
    assert 'no gradable questions' in result.stderr


def test_the_tool_refuses_a_file_without_a_questions_array(tmp_path: Path) -> None:
    broken = tmp_path / 'broken.json'
    broken.write_text(json.dumps({'rows': []}), encoding='utf-8')
    result = run('--artifact', str(broken), '--plan-only')
    assert result.returncode != 0
    assert 'no questions array' in result.stderr


def test_the_tool_explains_its_usage_when_given_no_artifact() -> None:
    result = run('--plan-only')
    assert result.returncode == 2
    assert 'usage: judge-regrade.mjs' in result.stderr


def test_the_plan_is_reproducible_from_the_artifact_alone(tmp_path: Path) -> None:
    """No key, no model, no clock: two invocations must print the same plan."""
    first = run('--artifact', str(artifact(tmp_path)), '--plan-only')
    second = run('--artifact', str(artifact(tmp_path)), '--plan-only')
    assert first.stdout == second.stdout


def test_the_pure_counting_is_importable() -> None:
    """`tally` and `signTest` are the halves a model is not needed for, so they are asserted directly.

    Driving them through node's import rather than through the CLI is deliberate: the CLI path needs a
    key, and a rate that is only ever checked by eye is how a counting error survives a campaign.
    """
    script = """
      import { tally, signTest } from './tools/judge-regrade.mjs';
      const rows = [
        { questionId: 'a', capability: 'MR', recorded: true, verdicts: [true, true] },
        { questionId: 'b', capability: 'MR', recorded: true, verdicts: [false, true] },
        { questionId: 'c', capability: 'IE', recorded: false, verdicts: [true, false] },
      ];
      const reading = tally(rows);
      console.log(JSON.stringify({
        flips: reading.flips,
        up: reading.up,
        down: reading.down,
        agrees: reading.agreesWithArtifact,
        p: signTest(1, 1),
        mr: reading.byCapability.MR,
      }));
    """
    result = subprocess.run(
        ['node', '--input-type=module', '-e', script],
        capture_output=True,
        text=True,
        cwd=REPO,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    reading = json.loads(result.stdout)
    assert reading['flips'] == 2
    assert reading['up'] == 1
    assert reading['down'] == 1
    assert reading['agrees'] == 1
    assert reading['p'] == 1.0
    assert reading['mr'] == {'n': 2, 'flips': 1, 'rate': 0.5}
