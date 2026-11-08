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


def preference_artifact(tmp_path: Path) -> Path:
    """Two gradable questions, one of each gold shape.

    The preference gold is a real LongMemEval one: it describes what a good answer should do
    ("The user would prefer responses that ..."), which is a criterion rather than an answer, so it
    can never be matched and always reaches the judge. Separating it is what lets a regrade say
    whether the judge's variance lives in the question type whose verdict is least mechanical.
    """
    questions = [
        {
            'questionId': 'q-pref',
            'question': 'Any tips for keeping my kitchen clean?',
            'capability': 'IE',
            'questionType': None,
            'groundTruth': 'The user would prefer responses that acknowledge their existing efforts.',
            'answer': 'Clean your utensil holder regularly.',
            'correct': True,
        },
        {
            'questionId': 'q-fact',
            'question': 'Where did I put the keys?',
            'capability': 'IE',
            'questionType': 'single-session-user',
            'groundTruth': 'in the drawer',
            'answer': 'In the kitchen drawer.',
            'correct': True,
        },
    ]
    path = tmp_path / 'preference.json'
    path.write_text(json.dumps({'questions': questions}), encoding='utf-8')
    return path


def gradable_count(stdout: str) -> int:
    """The `questions N` line, read rather than pattern-matched, so spacing is not the assertion."""
    for line in stdout.splitlines():
        if line.startswith('questions'):
            return int(line.split()[1])
    raise AssertionError(f'no question count in:\n{stdout}')


def test_preference_only_selects_the_criterion_golds(tmp_path: Path) -> None:
    out = run('--artifact', str(preference_artifact(tmp_path)), '--plan-only', '--preference-only')
    assert out.returncode == 0, out.stderr
    assert gradable_count(out.stdout) == 1


def test_non_preference_only_is_the_complement(tmp_path: Path) -> None:
    """The two filters must partition the list, not merely both be non-empty.

    A filter that overlapped or dropped would make the two readings incomparable while both looked
    plausible, which is the defect shape this file already pins for eligibility.
    """
    artifact_path = str(preference_artifact(tmp_path))
    both = gradable_count(run('--artifact', artifact_path, '--plan-only').stdout)
    preference = gradable_count(run('--artifact', artifact_path, '--plan-only', '--preference-only').stdout)
    rest = gradable_count(
        run('--artifact', artifact_path, '--plan-only', '--non-preference-only').stdout
    )
    assert preference + rest == both


def test_no_filter_flag_keeps_every_gradable_question(tmp_path: Path) -> None:
    out = run('--artifact', str(preference_artifact(tmp_path)), '--plan-only')
    assert gradable_count(out.stdout) == 2


def test_the_majority_verdict_and_its_direction(tmp_path: Path) -> None:
    """A flip rate says the verdict moved; it cannot say which way the artifact was wrong.

    On the M1 preference population this distinction decides a published conclusion: arm B's
    artifact recorded 13 of 29 correct and the re-grade disagreed with 11 of them, while the five
    passes agreed with each other. Without a direction those eleven questions are consistent with
    "the artifact was too strict" (B is really 24/29) and with "the artifact was too lenient"
    (B is really 2/29), and the two readings support opposite conclusions about requirement 12.
    """
    script = """
      import { tally, majority } from './tools/judge-regrade.mjs';
      const rows = [
        // Re-graded true every time, artifact said false: the artifact was strict.
        { questionId: 'a', capability: 'IE', recorded: false, verdicts: [true, true, true] },
        // Re-graded false every time, artifact said true: the artifact was lenient.
        { questionId: 'b', capability: 'IE', recorded: true, verdicts: [false, false, false] },
        // Unstable, majority true.
        { questionId: 'c', capability: 'IE', recorded: false, verdicts: [true, true, false] },
        // Unstable with no majority: a tie is not a verdict.
        { questionId: 'd', capability: 'IE', recorded: true, verdicts: [true, false] },
      ];
      const reading = tally(rows);
      console.log(JSON.stringify({
        regradedCorrect: reading.regradedCorrect,
        artifactOnlyCorrect: reading.artifactOnlyCorrect,
        regradeOnlyCorrect: reading.regradeOnlyCorrect,
        ties: reading.ties,
        tieIsFalse: majority([true, false]),
      }));
    """
    out = subprocess.run(
        ['node', '--input-type=module', '-e', script],
        capture_output=True,
        text=True,
        cwd=REPO,
        timeout=120,
    )
    assert out.returncode == 0, out.stderr
    reading = json.loads(out.stdout)
    # `a` and `c` are correct on the majority; `b` is not; `d` is a tie and a tie is not a verdict.
    assert reading['regradedCorrect'] == 2
    assert reading['artifactOnlyCorrect'] == 1
    assert reading['regradeOnlyCorrect'] == 2
    assert reading['ties'] == 1
    assert reading['tieIsFalse'] is False
