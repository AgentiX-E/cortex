"""Tests for `tools/cost-floor.mjs`, the instrument that decides whether a cost criterion is reachable.

`C1` asks for at most 6,000 billed prompt tokens per question per repetition. Every previous round treated that
as a target and went looking for a lever, and one of them was recorded as **passing** at 5,623 -- a figure taken
from the *median evidence characters divided by 4.06*, against a threshold written on *mean billed tokens*. The
tool exists because those are three different quantities and only one of them is what the acceptance row reads.

The tests below pin the four decisions the tool makes, in the order they change the verdict:

1. which characters count as delivered (the billed field first, the assembled one only as a fallback);
2. which token count is the bill (`usageBySide.feature`, never the two-arm total, because the total overstates
   one arm by 15.9% on `43140878641`);
3. what the floor is (the heavy routes' characters divided by **every** question, with the other routes at zero);
4. what an adaptive window would bill, capped at what the question actually receives today.

The fourth is the one that turns a refusal into a decision: the floor says the fixed allocation cannot reach the
threshold, and the adaptive figure says what could.
"""

from __future__ import annotations

import json
import pathlib
import subprocess

REPO = pathlib.Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'cost-floor.mjs'


def turn(text: str) -> dict:
    return {'index': 0, 'text': text, 'at': 1_700_000_000_000, 'role': 'user', 'sessionId': 's1'}


def question(
    capability: str,
    delivered: int,
    gold: list[str],
    *,
    carried: int | None = None,
    correct: bool = True,
    assembled: int | None = None,
) -> dict:
    if carried is None:
        carried = len(gold)
    record = {
        'questionId': f'{capability}-{delivered}-{len(gold)}',
        'question': 'What is it?',
        'capability': capability,
        'groundTruth': 'x',
        'answer': 'x',
        'correct': correct,
        'turns': [turn('hello')],
        'deliveredPromptChars': delivered,
        'goldOverlap': {'carried': carried, 'total': len(gold), 'goldTurns': gold},
    }
    if assembled is not None:
        record['promptChars'] = assembled
    return record


def artifact(questions: list[dict], **extra) -> dict:
    payload = {'questionCount': len(questions), 'runs': 4, 'questions': questions}
    payload.update(extra)
    return payload


def run(tmp_path: pathlib.Path, payload: dict, argv: list[str] | None = None) -> subprocess.CompletedProcess:
    path = tmp_path / 'report.json'
    path.write_text(json.dumps(payload), encoding='utf-8')
    return subprocess.run(
        ['node', str(TOOL), str(path), *(argv or [])],
        capture_output=True,
        text=True,
        cwd=REPO,
        check=False,
    )


def read(tmp_path: pathlib.Path, payload: dict, argv: list[str] | None = None) -> dict:
    result = run(tmp_path, payload, ['--json', *(argv or [])])
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout)


# --- decision 1: what counts as delivered ---------------------------------------------------------------


def test_delivered_prompt_chars_is_preferred_over_the_assembled_prompt(tmp_path):
    """A question that assembled 40,000 and delivered 10,000 costs 10,000."""
    payload = artifact([question('MR', 10_000, ['a' * 1000], assembled=40_000)])
    report = read(tmp_path, payload)
    assert report['overall']['meanDeliveredChars'] == 10_000


def test_an_artifact_without_the_delivered_field_falls_back_to_the_assembled_one(tmp_path):
    record = question('MR', 0, ['a' * 1000])
    del record['deliveredPromptChars']
    record['promptChars'] = 7_000
    report = read(tmp_path, artifact([record]))
    assert report['overall']['meanDeliveredChars'] == 7_000


def test_a_question_with_neither_field_contributes_nothing_and_does_not_crash(tmp_path):
    record = question('MR', 0, ['a' * 1000])
    del record['deliveredPromptChars']
    report = read(tmp_path, artifact([record]))
    assert report['overall']['meanDeliveredChars'] == 0
    assert report['floor']['billedTokensPerQuestion'] == 0


# --- decision 2: which token count is the bill ----------------------------------------------------------


def test_the_feature_side_is_the_bill_and_the_two_arm_total_is_not(tmp_path):
    """`llmUsage` sums both arms; pricing one arm with it overstates by the baseline's share."""
    payload = artifact(
        [question('MR', 20_000, ['a' * 1000])],
        usageBySide={'feature': {'promptTokens': 4_000, 'calls': 4}, 'baseline': {'promptTokens': 4_000}},
        llmUsage={'promptTokens': 8_000, 'calls': 8},
    )
    report = read(tmp_path, payload)
    assert report['overall']['billingBasis'] == 'usageBySide.feature.promptTokens'
    assert report['overall']['billedTokensPerQuestion'] == 1_000


def test_the_reported_efficiency_figure_is_used_when_the_side_block_is_absent(tmp_path):
    payload = artifact(
        [question('MR', 20_000, ['a' * 1000])],
        costEfficiency={'promptTokensPerQuestion': 900, 'accuracy': 0.9},
    )
    report = read(tmp_path, payload)
    assert report['overall']['billingBasis'] == 'costEfficiency.promptTokensPerQuestion'
    assert report['overall']['billedTokensPerQuestion'] == 900


def test_with_no_billing_at_all_the_factor_is_one_and_the_reading_is_evidence_only(tmp_path):
    payload = artifact([question('MR', 20_000, ['a' * 1000])])
    report = read(tmp_path, payload)
    assert report['overall']['billingBasis'] == 'none'
    assert report['overall']['billingFactor'] == 1
    assert report['overall']['billedTokensPerQuestion'] is None


def test_calls_per_question_run_is_reported_so_a_retry_heavy_arm_is_visible(tmp_path):
    payload = artifact(
        [question('MR', 20_000, ['a' * 1000])],
        usageBySide={'feature': {'promptTokens': 4_000, 'calls': 8}},
    )
    report = read(tmp_path, payload)
    assert report['overall']['callsPerQuestionRun'] == 2.0


# --- decision 3: the floor ------------------------------------------------------------------------------


def test_the_floor_divides_heavy_characters_by_every_question_not_by_the_heavy_ones(tmp_path):
    """Four heavy questions at 48,000 and one light at 24,000: the floor is 4 x 48,000 / 5, not / 4."""
    payload = artifact(
        [question('MR', 48_000, ['a' * 100]) for _ in range(4)] + [question('IE', 24_000, ['a' * 100])]
    )
    report = read(tmp_path, payload)
    assert report['floor']['heavyQuestions'] == 4
    assert report['floor']['evidenceTokensPerQuestion'] == 48_000 * 4 / 5 / 3.8528


def test_the_floor_excludes_the_light_routes_entirely(tmp_path):
    """Widening a light route must not move the floor; that is the whole point of the bound."""
    narrow = artifact([question('MR', 48_000, ['a' * 100]), question('IE', 1_000, ['a' * 100])])
    wide = artifact([question('MR', 48_000, ['a' * 100]), question('IE', 48_000, ['a' * 100])])
    assert (
        read(tmp_path, narrow)['floor']['evidenceTokensPerQuestion']
        == read(tmp_path, wide)['floor']['evidenceTokensPerQuestion']
    )


def test_a_floor_above_the_threshold_verdicts_blocked(tmp_path):
    payload = artifact([question('MR', 48_000, ['a' * 100]) for _ in range(10)])
    report = read(tmp_path, payload, ['--threshold', '6000'])
    assert report['floor']['verdict'] == 'blocked'
    assert report['floor']['lightBudgetBilled'] < 0


def test_a_floor_below_the_threshold_verdicts_reachable_and_reports_headroom(tmp_path):
    payload = artifact([question('MR', 4_000, ['a' * 100]) for _ in range(10)])
    report = read(tmp_path, payload, ['--threshold', '6000'])
    assert report['floor']['verdict'] == 'reachable'
    assert report['floor']['lightBudgetBilled'] == 6000 - report['floor']['billedTokensPerQuestion']


def test_the_floor_does_not_move_with_the_character_ratio(tmp_path):
    """The bound is a share of the bill, so the density cancels and no assumption enters the verdict.

    `heavy / questions / ratio x (billed / (delivered / questions / ratio))` reduces to
    `(heavy / delivered) x billed`. A tool that reported a floor that moved with the ratio would be resting on
    an inferred constant, and the archive has already been wrong once by dividing a median by 4.06.
    """
    payload = artifact(
        [question('MR', 48_000, ['a' * 100]), question('IE', 24_000, ['a' * 100])],
        usageBySide={'feature': {'promptTokens': 18_000, 'calls': 8}},
    )
    low = read(tmp_path, payload, ['--chars-per-token', '3.5'])
    high = read(tmp_path, payload, ['--chars-per-token', '4.5'])
    assert low['floor']['billedTokensPerQuestion'] == high['floor']['billedTokensPerQuestion']
    assert low['adaptive']['billedTokensPerQuestion'] == high['adaptive']['billedTokensPerQuestion']
    # The informational evidence reading does move, which is why it is not the one with the verdict on it.
    assert low['floor']['evidenceTokensPerQuestion'] > high['floor']['evidenceTokensPerQuestion']


def test_the_floor_is_the_heavy_share_of_delivered_characters_times_the_bill(tmp_path):
    payload = artifact(
        [question('MR', 30_000, ['a' * 100]), question('IE', 10_000, ['a' * 100])],
        usageBySide={'feature': {'promptTokens': 10_000, 'calls': 8}},
    )
    report = read(tmp_path, payload)
    # 10,000 billed over 2 questions and 4 runs is 1,250 per question-run; heavy share 30,000 / 40,000.
    assert report['floor']['shareOfBill'] == 0.75
    assert report['floor']['billedTokensPerQuestion'] == 0.75 * 1_250


def test_the_heavy_set_is_configurable(tmp_path):
    payload = artifact([question('MR', 48_000, ['a' * 100]), question('IE', 24_000, ['a' * 100])])
    report = read(tmp_path, payload, ['--heavy', 'IE'])
    assert report['heavy'] == ['IE']
    assert report['floor']['heavyQuestions'] == 1
    assert report['floor']['evidenceTokensPerQuestion'] == 24_000 / 2 / 3.8528


# --- the gold columns -----------------------------------------------------------------------------------


def test_gold_share_is_unclipped_so_a_question_whose_gold_exceeds_its_window_reads_over_one(tmp_path):
    """`KU` reads 124%: its gold does not fit, and a clipped ratio would hide that."""
    payload = artifact([question('KU', 10_000, ['a' * 12_000])])
    report = read(tmp_path, payload)
    row = report['capabilities'][0]
    assert round(row['goldShare'], 4) == 1.2


def test_all_gold_carried_counts_only_exact_equality(tmp_path):
    payload = artifact(
        [
            question('MR', 10_000, ['a' * 10, 'b' * 10], carried=2),
            question('MR', 10_000, ['a' * 10, 'b' * 10], carried=1),
        ]
    )
    report = read(tmp_path, payload)
    assert report['capabilities'][0]['allGoldCarried'] == 1


def test_a_question_with_no_gold_turns_reports_a_null_ratio_rather_than_zero(tmp_path):
    record = question('MR', 10_000, [])
    record['goldOverlap'] = {'carried': 0, 'total': 0}
    report = read(tmp_path, artifact([record]))
    assert report['capabilities'][0]['goldShare'] == 0.0
    assert report['capabilities'][0]['allGoldCarriedRatio'] == 1.0


# --- decision 4: the adaptive bound ---------------------------------------------------------------------


def test_adaptive_sizes_each_window_from_its_own_gold(tmp_path):
    payload = artifact(
        [question('MR', 48_000, ['a' * 5_000]), question('IE', 24_000, ['a' * 1_000])],
        usageBySide={'feature': {'promptTokens': 4_060, 'calls': 2}},
    )
    report = read(tmp_path, payload)
    # 2 x 5,000 capped at 48,000 is 10,000; 2 x 1,000 is 2,000; mean 6,000 chars.
    assert report['adaptive']['charsPerQuestion'] == 6_000


def test_adaptive_never_delivers_more_than_the_question_already_gets(tmp_path):
    payload = artifact([question('MR', 1_000, ['a' * 48_000])])
    report = read(tmp_path, payload)
    assert report['adaptive']['charsPerQuestion'] == 1_000


def test_slack_is_a_flag_and_moves_the_bound(tmp_path):
    payload = artifact([question('MR', 48_000, ['a' * 5_000])])
    one = read(tmp_path, payload, ['--slack', '1'])
    three = read(tmp_path, payload, ['--slack', '3'])
    assert one['adaptive']['charsPerQuestion'] == 5_000
    assert three['adaptive']['charsPerQuestion'] == 15_000


def test_the_adaptive_bound_can_be_reachable_while_the_fixed_floor_is_blocked(tmp_path):
    """The result this tool exists to produce: the threshold is not the constraint, the fixed room is."""
    payload = artifact([question('MR', 48_000, ['a' * 2_000]) for _ in range(10)])
    report = read(tmp_path, payload, ['--threshold', '6000'])
    assert report['floor']['verdict'] == 'blocked'
    assert report['adaptive']['verdict'] == 'reachable'


# --- accuracy and cost per correct answer ---------------------------------------------------------------


def test_tokens_per_correct_answer_divides_the_whole_bill_by_the_correct_count(tmp_path):
    payload = artifact(
        [
            question('MR', 4_060, ['a' * 100], correct=True),
            question('MR', 4_060, ['a' * 100], correct=False),
            question('MR', 4_060, ['a' * 100], correct=False),
            question('MR', 4_060, ['a' * 100], correct=False),
        ],
        usageBySide={'feature': {'promptTokens': 16_000, 'calls': 16}},
    )
    report = read(tmp_path, payload)
    assert report['accuracy']['correct'] == 1
    assert report['accuracy']['ratio'] == 0.25
    assert report['accuracy']['tokensPerCorrectAnswer'] == 4_000


def test_an_artifact_with_no_correct_answer_reports_a_null_rather_than_dividing_by_zero(tmp_path):
    payload = artifact([question('MR', 4_060, ['a' * 100], correct=False)])
    report = read(tmp_path, payload)
    assert report['accuracy']['tokensPerCorrectAnswer'] is None


# --- the command line -----------------------------------------------------------------------------------


def test_usage_is_exit_two(tmp_path):
    result = subprocess.run(['node', str(TOOL)], capture_output=True, text=True, cwd=REPO, check=False)
    assert result.returncode == 2
    assert 'usage:' in result.stderr


def test_a_non_positive_threshold_is_exit_two(tmp_path):
    result = run(tmp_path, artifact([]), ['--threshold', '0'])
    assert result.returncode == 2
    assert 'positive number' in result.stderr


def test_an_unknown_flag_is_exit_two(tmp_path):
    result = run(tmp_path, artifact([]), ['--nope'])
    assert result.returncode == 2
    assert 'unknown flag' in result.stderr


def test_a_second_positional_argument_is_exit_two(tmp_path):
    result = run(tmp_path, artifact([]), ['other.json'])
    assert result.returncode == 2
    assert 'one artifact' in result.stderr


def test_an_empty_heavy_list_is_exit_two(tmp_path):
    result = run(tmp_path, artifact([]), ['--heavy', ','])
    assert result.returncode == 2
    assert 'at least one' in result.stderr


def test_the_human_reading_prints_the_verdict_and_the_adaptive_line(tmp_path):
    payload = artifact([question('MR', 48_000, ['a' * 100]) for _ in range(4)])
    result = run(tmp_path, payload)
    assert result.returncode == 0, result.stderr
    assert 'verdict' in result.stdout
    assert 'adaptive' in result.stdout
    assert 'blocked' in result.stdout


def test_detail_adds_the_sentence_that_names_the_family_the_bound_applies_to(tmp_path):
    payload = artifact([question('MR', 48_000, ['a' * 100]) for _ in range(4)])
    plain = run(tmp_path, payload)
    detailed = run(tmp_path, payload, ['--detail'])
    assert 'aggregates in code' not in plain.stdout
    assert 'aggregates in code' in detailed.stdout
