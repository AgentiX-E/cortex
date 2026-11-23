"""Tests for tools/competitor-regrade.mjs — the competitor's answers, put through this judge.

## What this file protects

The re-grade exists to answer one question: whether the 4.35-point gap between cortex's 91.25% and
Maximem Synap's 95.6% is a difference between two systems or between two judges. Every way that
question can be answered wrongly is a way this file has a test for:

  * **grading an empty population.** The preparation tool refuses to guess the answer field; a re-grade
    that accepts a file whose `answerField` is `null` would score zero questions and print a rate.
  * **grading through a stricter pipeline than the one that produced 91.25%.** `judgeScorer` decides
    exact matches, missing answers and counting questions without a model. Calling the judge on every
    row would make the competitor's answers face a test our own answers never faced.
  * **turning an absent abstention flag into `false`.** `retrieval.abstention` selects a different
    official template. A file that does not carry it must not be graded as if it said "no".
  * **reporting agreement without direction.** The same agreement rate comes from a re-grade that is
    lenient and from one that is strict, and the two support opposite conclusions.
  * **spending without a ceiling.** The call budget is checked before the first call.
  * **a plan that needs a key.** `--plan-only` computes the call count and the prompt size from the
    same function the call would use, so the estimate is reviewable in a pull request.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'competitor-regrade.mjs'


def run(*args: str, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    base = {'PATH': '/usr/local/bin:/usr/bin:/bin:/root/.nvm/versions/node/v22.13.0/bin'}
    return subprocess.run(
        ['node', str(TOOL), *args],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=180,
        env={**base, **(env or {})},
    )


def export(script: str) -> dict:
    """Run a tiny ES module that imports the tool's exported functions and prints JSON."""
    result = subprocess.run(
        ['node', '--input-type=module', '-e', script],
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


def answers_file(tmp_path: Path, questions, answer_field='response') -> Path:
    tmp_path.mkdir(parents=True, exist_ok=True)
    path = tmp_path / 'records-answers.json'
    path.write_text(
        json.dumps(
            {
                'fieldMap': {'question': 'question', 'gold': 'answer'},
                'answerField': answer_field,
                'verdictField': 'correct',
                'records': len(questions),
                'questions': questions,
            }
        )
    )
    return path


def question(index: int, response: str = 'Paris.', **overrides) -> dict:
    base = {
        'questionId': f'q{index}',
        'questionType': 'single-session-user',
        'question': f'What is the capital? #{index}',
        'gold': 'Paris',
        'response': response,
        'publishedVerdict': True,
        'abstention': False,
    }
    base.update(overrides)
    return base


def test_the_plan_needs_no_key_and_reports_calls_and_prompt_size(tmp_path: Path) -> None:
    # The plan is what makes a dispatch reviewable before it costs anything: the call count, the
    # population, and the prompt size computed by `buildJudgePrompt` itself rather than by a guess.
    path = answers_file(tmp_path, [question(index) for index in range(4)])
    result = run('--answers', str(path), '--out-dir', str(tmp_path / 'out'), '--plan-only')
    assert result.returncode == 0, result.stderr
    plan = json.loads((tmp_path / 'out' / 'regrade-plan.json').read_text())
    assert plan['population'] == 4
    assert plan['cost']['calls'] == 4
    assert plan['cost']['estimatedPromptTokens'] > 0
    assert plan['planOnly'] is True
    assert 'estimatedCny' not in plan['cost']
    assert 'tokens only' in result.stdout


def test_a_price_is_reported_only_when_it_is_given_and_it_says_which_it_is(tmp_path: Path) -> None:
    path = answers_file(tmp_path, [question(index) for index in range(2)])
    result = run(
        '--answers', str(path), '--out-dir', str(tmp_path / 'out'), '--plan-only',
        '--price-cny-per-mtok', '2',
    )
    assert result.returncode == 0, result.stderr
    plan = json.loads((tmp_path / 'out' / 'regrade-plan.json').read_text())
    assert plan['cost']['priceCnyPerMtok'] == 2
    assert plan['cost']['estimatedCny'] == plan['cost']['estimatedPromptTokens'] / 1_000_000 * 2


def test_a_file_without_a_converged_answer_field_is_refused(tmp_path: Path) -> None:
    # The preparation tool refused to guess; grading anyway would score an empty population and print
    # a rate for it.
    path = answers_file(tmp_path, [question(0)], answer_field=None)
    (tmp_path / 'records-answers.json').write_text(
        json.dumps({'answerField': None, 'refused': 'no single record-level string field', 'questions': []})
    )
    result = run('--answers', str(path), '--out-dir', str(tmp_path / 'out'), '--plan-only')
    assert result.returncode != 0
    assert 'no converged answer field' in result.stderr
    assert not (tmp_path / 'out' / 'regrade-plan.json').exists()


def test_the_call_budget_is_checked_before_the_first_call(tmp_path: Path) -> None:
    path = answers_file(tmp_path, [question(index) for index in range(5)])
    result = run('--answers', str(path), '--out-dir', str(tmp_path / 'out'), '--plan-only', '--max-calls', '4')
    assert result.returncode != 0
    assert 'budget is 4' in result.stderr


def test_an_empty_answer_is_skipped_by_cause_not_folded_into_the_total(tmp_path: Path) -> None:
    # "The competitor declined" and "the extraction produced an empty string" look identical in a total
    # and are different findings about the file.
    path = answers_file(tmp_path, [question(0), question(1, response='   '), question(2, gold='')])
    result = run('--answers', str(path), '--out-dir', str(tmp_path / 'out'), '--plan-only')
    assert result.returncode == 0, result.stderr
    plan = json.loads((tmp_path / 'out' / 'regrade-plan.json').read_text())
    assert plan['population'] == 1
    assert plan['skipped'] == {'noQuestion': 0, 'noGold': 1, 'noAnswer': 1}


def test_the_abstention_flag_is_folded_into_the_type_and_an_absent_flag_is_not_invented() -> None:
    # The official abstention template is selected by the `_abs` suffix. `expected` cannot carry the
    # signal because the template needs it as the explanation, so the flag goes into the type -- and a
    # missing flag stays missing, because inventing `false` would make the abstention rate a claim about
    # this tool.
    result = export(
        "import {asQuestion} from './tools/competitor-regrade.mjs';"
        "const base = {questionId:'q', questionType:'single-session-user', question:'q?', gold:'g', response:'r'};"
        "console.log(JSON.stringify({"
        "  abstain: asQuestion({...base, abstention: true}).questionType,"
        "  plain: asQuestion({...base, abstention: false}).questionType,"
        "  unknown: asQuestion({...base, abstention: null}).questionType,"
        "  expected: asQuestion({...base, abstention: true}).expected"
        "}));"
    )
    assert result == {
        'abstain': 'single-session-user_abs',
        'plain': 'single-session-user',
        'unknown': 'single-session-user',
        'expected': 'g',
    }


def test_the_sign_test_is_exact_and_two_sided() -> None:
    # Hand-computed: three discordant pairs all in one direction is 2/2^3 = 0.25; six is 2/2^6 = 0.03125;
    # a symmetric split saturates at 1. The p-value is the paired counterpart of a two-proportion test,
    # so an inexact one understates the evidence for whichever direction the re-grade moved.
    result = export(
        "import {discordantPValue} from './tools/competitor-regrade.mjs';"
        "console.log(JSON.stringify({"
        "  none: discordantPValue(0,0),"
        "  three: discordantPValue(3,0),"
        "  six: discordantPValue(6,0),"
        "  symmetric: discordantPValue(2,2),"
        "  flipped: discordantPValue(0,3)"
        "}));"
    )
    assert result['none'] == 1
    assert result['three'] == 0.25
    assert result['six'] == 0.03125
    assert result['symmetric'] == 1
    assert result['flipped'] == 0.25


def test_agreement_is_reported_with_its_direction() -> None:
    # Four rows: two agree, one is rescued (we accept, they rejected), one is revoked. Agreement 50% on
    # its own would be consistent with the opposite mix, which supports the opposite conclusion.
    result = export(
        "import {readings} from './tools/competitor-regrade.mjs';"
        "const rows = ["
        "  {publishedVerdict: true, ourVerdict: true},"
        "  {publishedVerdict: false, ourVerdict: false},"
        "  {publishedVerdict: false, ourVerdict: true},"
        "  {publishedVerdict: true, ourVerdict: false}"
        "];"
        "console.log(JSON.stringify(readings(rows)));"
    )
    assert result['paired'] == 4
    assert result['ours'] == 2
    assert result['theirs'] == 2
    assert result['rescued'] == 1
    assert result['revoked'] == 1
    assert result['agreement'] == 0.5
    assert result['discordantPValue'] == 1


def test_rows_without_a_published_verdict_are_left_out_of_both_readings() -> None:
    # A paired comparison is over the questions both instruments judged. Counting a missing published
    # verdict as a rejection would credit the re-grade with a question the vendor never scored.
    result = export(
        "import {readings} from './tools/competitor-regrade.mjs';"
        "console.log(JSON.stringify(readings(["
        "  {publishedVerdict: null, ourVerdict: true},"
        "  {publishedVerdict: true, ourVerdict: true},"
        "  {publishedVerdict: false, ourVerdict: true}"
        "])));"
    )
    assert result['paired'] == 2
    assert result['ours'] == 2
    assert result['theirs'] == 1
    assert result['rescued'] == 1
    assert result['revoked'] == 0
