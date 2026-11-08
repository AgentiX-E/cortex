"""Tests for `tools/efficiency-frontier.mjs` — the joint reading, off two artifacts.

## What this file protects

`packages/cortex-eval/src/efficiency-frontier.ts` is a library; the tool is its only in-repository
caller, and the caller is where the artifact gets read. The defect worth testing is not arithmetic —
that module has 100% coverage and a test that ties each verdict to a real pair of readings — it is
**what the tool accepts**. Three failures are silent and all three are reachable:

1. **A missing token ledger read as a free arm.** If `usageBySide.feature` is absent and the tool
   defaults the prompt tokens to zero, `profileOf` throws — but only because the library refuses. A
   tool that defaulted to a small number instead would report a 99.9% saving, and the whole reason
   the module exists is that a saving is the easy half of a claim.
2. **Four repetitions priced as one.** `usageBySide.feature.promptTokens` is a total over every
   repetition, so the divisor is `questionCount * runs`. `§13.308` is the record of a reading that
   divided an all-repetitions numerator by a one-repetition denominator and turned a 1.20 pp accuracy
   gap into a 0.57% cost gap, i.e. it made the worse arm look **54% cheaper than it was**. The
   fixture below has `runs: 4` for exactly this reason: with `runs: 1` the test would pass whether or
   not the divisor is right.
3. **An aggregate-only artifact ordered as if it were measured.** The `perCapability` breakdown is
   what blocks the window cut that `A` refused, so an artifact without one has to be refused rather
   than compared on its total.

The fixtures are the two real configurations from the campaign, so the verdicts asserted here are the
verdicts the matrix would print: `window` at 12,137 tokens per question is the registered arm, and
`economy` is a hypothetical twin with the same answers for 30% less — the shape a dominance claim has
to have before one is claimed.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'efficiency-frontier.mjs'

CAPABILITIES = [
    ('IE', 86, 90),
    ('MR', 87, 121),
    ('KU', 50, 72),
    ('TR', 100, 127),
    ('ABS', 29, 30),
]


def metrics(correct: int = 460, total: int = 500, per=CAPABILITIES) -> dict:
    return {
        'accuracy': correct / total,
        'abstentionRate': 0.0,
        'abstentionCorrectRate': 0.0,
        'abstentionAwareAccuracy': correct / total,
        'total': total,
        'correct': correct,
        'perCapability': {
            name: {'correct': c, 'total': t, 'accuracy': c / t} for name, c, t in per
        },
    }


def artifact(
    *,
    name: str = 'window',
    correct: int = 460,
    prompt_tokens: int = 24_274_000,
    cache_hits: int | None = None,
    runs: int = 4,
    question_count: int = 500,
    per=CAPABILITIES,
    drop_metrics: bool = False,
    drop_usage: bool = False,
    bare_metrics: bool = False,
    questions: list | None = None,
    arm_config: dict | None = None,
    masks: list | None = None,
    aggregate: float | None = None,
) -> dict:
    """One ablation report, in the shape `report.ts` actually writes."""
    document: dict = {
        'dataset': 'longmemeval',
        'questionCount': question_count,
        'runs': runs,
        'feature': {'name': name},
    }
    if not drop_metrics:
        document['feature']['metrics'] = metrics(correct, 500, per)
    if bare_metrics:
        document['metrics'] = document['feature'].pop('metrics')
    # The cache share is held at the arm's measured 78.2% unless a test moves it, so that shrinking
    # the prompt spend shrinks the hits with it: a fixed hit count over a smaller total is a share
    # above 1, which `profileOf` refuses and which a real artifact cannot produce.
    hits = int(prompt_tokens * 0.782) if cache_hits is None else cache_hits
    if questions is not None:
        document['questions'] = questions
    if masks is not None:
        document['ablation'] = {'featureCorrectByRun': masks}
        if aggregate is not None:
            document['ablation']['featureAggregate'] = {'avg': aggregate, 'min': 0, 'max': 1}
    elif aggregate is not None:
        document['ablation'] = {'featureAggregate': {'avg': aggregate, 'min': 0, 'max': 1}}
    if arm_config is not None:
        document['memoryArmConfig'] = arm_config
    if not drop_usage:
        document['usageBySide'] = {
            'baseline': {'calls': 0, 'promptTokens': 0, 'cacheHitPromptTokens': 0},
            'feature': {
                'calls': 2071,
                'promptTokens': prompt_tokens,
                'completionTokens': 40_000,
                'cacheHitPromptTokens': hits,
            },
        }
    return document


def run(tmp_path: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ['node', str(TOOL), *args],
        capture_output=True,
        text=True,
        cwd=str(tmp_path),
        timeout=120,
    )


def write(tmp_path: Path, name: str, document: dict) -> Path:
    path = tmp_path / name
    path.write_text(json.dumps(document), encoding='utf-8')
    return path


def test_a_twin_that_answers_the_same_for_less_is_ordered(tmp_path: Path) -> None:
    reference = write(tmp_path, 'window.json', artifact(prompt_tokens=24_274_000))
    # 70% of the prompt spend, identical answers: 8,500 tokens per question against 12,137.
    economy = write(tmp_path, 'economy.json', artifact(name='economy', prompt_tokens=17_000_000))
    result = run(tmp_path, str(reference), str(economy))
    assert result.returncode == 0, result.stderr
    assert 'economy vs window: **dominates**' in result.stdout
    # 17,000,000 / (500 * 4) over 24,274,000 / (500 * 4) = 0.700 on both axes, because the cache
    # share is held: a twin is only cheaper when the bill falls with the context.
    assert 'context 0.700x, billed 0.700x' in result.stdout


def test_the_divisor_is_questions_times_repetitions(tmp_path: Path) -> None:
    """`runs: 4` is not decoration — with `runs: 1` the same file reads four times dearer."""
    reference = write(tmp_path, 'window.json', artifact(prompt_tokens=24_274_000, runs=4))
    economy = write(tmp_path, 'economy.json', artifact(name='economy', prompt_tokens=17_000_000, runs=4))
    result = run(tmp_path, '--json', str(reference), str(economy))
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    window = next(arm for arm in payload['arms'] if arm['arm'] == 'window')
    assert abs(window['promptTokensPerQuestion'] - 24_274_000 / 2000) < 1e-6
    assert abs(window['promptTokensPerQuestion'] - 12_137.0) < 1.0


def test_the_window_cut_is_reported_as_a_trade_off_not_a_win(tmp_path: Path) -> None:
    """The reading this module was written for: 53.7% of the context for 3.20 accuracy points."""
    reference = write(tmp_path, 'window.json', artifact())
    squeezed = write(
        tmp_path,
        'squeezed.json',
        artifact(
            name='squeezed',
            correct=444,
            prompt_tokens=11_246_000,
            per=[
                ('IE', 85, 90),
                ('MR', 79, 121),
                ('KU', 49, 72),
                ('TR', 94, 127),
                ('ABS', 29, 30),
            ],
        ),
    )
    result = run(tmp_path, str(reference), str(squeezed))
    assert result.returncode == 0, result.stderr
    assert 'squeezed vs window: **incomparable**' in result.stdout
    assert 'blocked on overall, MR, TR' in result.stdout


def test_the_bill_is_priced_and_the_context_is_left_alone(tmp_path: Path) -> None:
    reference = write(tmp_path, 'window.json', artifact(cache_hits=18_982_000))
    economy = write(tmp_path, 'economy.json', artifact(name='economy', prompt_tokens=17_000_000))
    result = run(tmp_path, '--json', str(reference), str(economy))
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    window = next(arm for arm in payload['arms'] if arm['arm'] == 'window')
    share = 18_982_000 / 24_274_000
    expected = 12_137.0 * (share * 0.02 + (1 - share))
    assert abs(window['billedPromptTokensPerQuestion'] - expected) < 1.0
    assert window['billedPromptTokensPerQuestion'] < window['promptTokensPerQuestion']


def test_two_artifacts_with_one_name_are_refused(tmp_path: Path) -> None:
    first = write(tmp_path, 'a.json', artifact(name='same'))
    second = write(tmp_path, 'b.json', artifact(name='same'))
    result = run(tmp_path, str(first), str(second))
    assert result.returncode == 2
    # Either refusal is correct and both name the cause: the verdict loop reaches
    # `compareEfficiency` first, so its message is the one that surfaces.
    assert 'both named' in result.stderr or 'needs two arms' in result.stderr


def test_a_missing_token_ledger_is_an_error_and_never_a_zero(tmp_path: Path) -> None:
    reference = write(tmp_path, 'window.json', artifact())
    blind = write(tmp_path, 'blind.json', artifact(name='blind', drop_usage=True))
    result = run(tmp_path, str(reference), str(blind))
    assert result.returncode == 2
    assert 'no token ledger' in result.stderr


def test_a_missing_metric_block_is_an_error(tmp_path: Path) -> None:
    reference = write(tmp_path, 'window.json', artifact())
    blind = write(tmp_path, 'blind.json', artifact(name='blind', drop_metrics=True))
    result = run(tmp_path, str(reference), str(blind))
    assert result.returncode == 2
    assert 'no metrics' in result.stderr


def test_an_artifact_without_a_breakdown_is_refused(tmp_path: Path) -> None:
    """The aggregate is the reading that hid `MR -6.61` behind `-3.20`, so it is not accepted alone."""
    reference = write(tmp_path, 'window.json', artifact())
    bare = write(tmp_path, 'bare.json', artifact(name='bare', per=[]))
    result = run(tmp_path, str(reference), str(bare))
    assert result.returncode == 2
    assert 'no capability breakdown' in result.stderr


def test_a_bare_arm_report_is_read_through_the_root_metrics_field(tmp_path: Path) -> None:
    reference = write(tmp_path, 'window.json', artifact())
    bare = write(tmp_path, 'bare.json', artifact(name='economy', prompt_tokens=17_000_000, bare_metrics=True))
    result = run(tmp_path, str(reference), str(bare))
    assert result.returncode == 0, result.stderr
    assert 'economy vs window: **dominates**' in result.stdout


def test_a_label_falls_back_to_the_position_when_the_artifact_names_nothing(tmp_path: Path) -> None:
    first = artifact()
    del first['feature']['name']
    reference = write(tmp_path, 'window.json', first)
    second = artifact(prompt_tokens=17_000_000)
    del second['feature']['name']
    economy = write(tmp_path, 'economy.json', second)
    result = run(tmp_path, '--json', str(reference), str(economy))
    assert result.returncode == 0, result.stderr
    assert [arm['arm'] for arm in json.loads(result.stdout)['arms']] == ['arm0', 'arm1']


def test_a_policy_is_named_on_the_command_line_and_narrows_the_judgement(tmp_path: Path) -> None:
    """A margin finer than the sample resolves must read `underpowered`, not `dominates`."""
    reference = write(tmp_path, 'window.json', artifact())
    economy = write(tmp_path, 'economy.json', artifact(name='economy', prompt_tokens=17_000_000))
    result = run(tmp_path, '--margin', '0.01', str(reference), str(economy))
    assert result.returncode == 0, result.stderr
    assert 'economy vs window: **underpowered**' in result.stdout
    assert 'policy: margin 0.01 accuracy' in result.stdout


def test_the_four_inputs_that_cannot_produce_a_reading_are_refused(tmp_path: Path) -> None:
    reference = write(tmp_path, 'window.json', artifact())
    economy = write(tmp_path, 'economy.json', artifact(name='economy', prompt_tokens=17_000_000))

    only_one = run(tmp_path, str(reference))
    assert only_one.returncode == 2
    assert 'at least two artifact paths' in only_one.stderr

    bad_margin = run(tmp_path, '--margin', 'wide', str(reference), str(economy))
    assert bad_margin.returncode == 2
    assert '--margin needs a non-negative number' in bad_margin.stderr

    bad_tolerance = run(tmp_path, '--tolerance', '-1', str(reference), str(economy))
    assert bad_tolerance.returncode == 2
    assert '--tolerance needs a non-negative number' in bad_tolerance.stderr

    missing = run(tmp_path, str(reference), str(tmp_path / 'absent.json'))
    assert missing.returncode == 2
    assert 'is not readable JSON' in missing.stderr


def test_a_report_with_no_population_is_refused(tmp_path: Path) -> None:
    reference = write(tmp_path, 'window.json', artifact())
    empty = write(tmp_path, 'empty.json', artifact(name='empty', question_count=0))
    result = run(tmp_path, str(reference), str(empty))
    assert result.returncode == 2
    assert 'no questionCount' in result.stderr


def test_a_token_ledger_with_no_prompt_tokens_is_refused(tmp_path: Path) -> None:
    reference = write(tmp_path, 'window.json', artifact())
    zero = artifact(name='zero', prompt_tokens=0)
    zero['usageBySide']['feature']['promptTokens'] = 0
    path = write(tmp_path, 'zero.json', zero)
    result = run(tmp_path, str(reference), str(path))
    assert result.returncode == 2
    assert 'no prompt token count' in result.stderr


def test_counts_that_are_not_counts_are_refused(tmp_path: Path) -> None:
    reference = write(tmp_path, 'window.json', artifact())
    fractional = artifact(name='fractional')
    fractional['feature']['metrics']['correct'] = 460.5
    path = write(tmp_path, 'fractional.json', fractional)
    result = run(tmp_path, str(reference), str(path))
    assert result.returncode == 2
    assert 'without integer correct/total counts' in result.stderr

    broken = artifact(name='broken')
    broken['feature']['metrics']['perCapability']['MR']['correct'] = 87.5
    path = write(tmp_path, 'broken.json', broken)
    result = run(tmp_path, str(reference), str(path))
    assert result.returncode == 2
    assert 'MR without integer correct/total counts' in result.stderr


def test_the_frontier_names_who_beat_whom(tmp_path: Path) -> None:
    reference = write(tmp_path, 'window.json', artifact())
    economy = write(tmp_path, 'economy.json', artifact(name='economy', prompt_tokens=17_000_000))
    result = run(tmp_path, str(reference), str(economy))
    assert result.returncode == 0, result.stderr
    assert 'frontier: economy' in result.stdout
    assert 'window is dominated by economy' in result.stdout


def test_an_underpowered_frontier_says_a_rerun_will_not_help(tmp_path: Path) -> None:
    reference = write(tmp_path, 'window.json', artifact())
    economy = write(tmp_path, 'economy.json', artifact(name='economy', prompt_tokens=17_000_000))
    result = run(tmp_path, '--margin', '0.01', str(reference), str(economy))
    assert result.returncode == 0, result.stderr
    assert 'underpowered: the margin is finer than the sample resolves' in result.stdout
    # An underpowered pair is not an ordering, so neither arm leaves the front.
    assert 'frontier: window, economy' in result.stdout


def test_the_tool_is_not_a_model_call(tmp_path: Path) -> None:
    """No key, no network: the reading is arithmetic over two files and must run anywhere.

    The keys are removed rather than the whole environment: a stripped `env` picks up whatever `node`
    happens to be first on a bare `PATH`, which on this image is not the one the workspace runs on, and
    a test that fails for that reason teaches nothing about the tool.
    """
    reference = write(tmp_path, 'window.json', artifact())
    economy = write(tmp_path, 'economy.json', artifact(name='economy', prompt_tokens=17_000_000))
    stripped = {
        key: value
        for key, value in os.environ.items()
        if key not in {'DEEPSEEK_API_KEY', 'ZHIPU_LLM_API_KEY', 'DEEPSEEK_BASE_URL'}
    }
    result = subprocess.run(
        ['node', str(TOOL), str(reference), str(economy)],
        capture_output=True,
        text=True,
        cwd=str(tmp_path),
        env=stripped,
        timeout=120,
    )
    assert result.returncode == 0, result.stderr


def questions(wrong: set[int] = frozenset(), capability: str = 'MR', n: int = 500) -> list:
    """Per-question records, in the shape `report.ts` writes them.

    `capability` is uniform because the paired buckets are only formed when the two artifacts agree on
    a question's capability; a fixture that varied it would be testing the join twice.
    """
    return [
        {
            'questionId': f'q{index:03d}',
            'capability': capability,
            'correct': index not in wrong,
        }
        for index in range(n)
    ]


def test_unequal_repetition_counts_exclude_the_bill_and_keep_the_other_two_axes(tmp_path: Path) -> None:
    """Refusing the whole comparison threw away two valid readings to protect one.

    The bill is the only axis `runs` confounds, and `compareEfficiency` already encodes that with
    `billComparable`. The tool's job is to say so, not to exit 2: a 4-vs-2 pair still has an accuracy
    reading and a context reading, and they are the two that decide whether the cut was worth it.
    """
    reference = write(tmp_path, 'window.json', artifact(runs=4))
    squeezed = write(
        tmp_path, 'squeezed.json', artifact(name='squeezed', runs=2, prompt_tokens=6_077_000)
    )
    result = run(tmp_path, str(reference), str(squeezed))
    assert result.returncode == 0, result.stderr
    assert 'the artifacts ran 4 and 2 repetitions' in result.stderr
    assert 'bill NOT comparable' in result.stdout
    # The context ratio survives, which is the axis the refusal used to destroy.
    assert 'context 0.501x' in result.stdout


def test_a_paired_pair_is_read_through_the_question_records(tmp_path: Path) -> None:
    """The instrument the campaign needed and did not have: 27 lost to 11 won is p = 0.0139.

    The fixture is **self-consistent**, and that is the part that has to be got right: a paired test
    whose discordant counts disagree with the marginals is two numbers rather than one measurement.
    The control is wrong on questions 0-39 (40, so 460 correct) and the arm is wrong on 11-39 (the 29
    shared) plus 100-126 (27 it alone lost, against 11 it alone won) — 56 wrong, 444 correct.
    """
    reference = write(tmp_path, 'window.json', artifact(questions=questions(wrong=set(range(40)))))
    squeezed = write(
        tmp_path,
        'squeezed.json',
        artifact(
            name='squeezed',
            correct=444,
            prompt_tokens=6_077_000,
            runs=4,
            questions=questions(wrong=set(range(11, 40)) | set(range(100, 127))),
        ),
    )
    result = run(tmp_path, str(reference), str(squeezed))
    assert result.returncode == 0, result.stderr
    assert '11 won / 27 lost over 38 disagreeing question(s) [mcnemar]' in result.stdout
    assert 'exact p = 0.0139' in result.stdout
    assert '-- resolved' in result.stdout
    assert 'blocked on overall' in result.stdout
    # And the reverse direction is the same pair, so it must be reported with the counts swapped.
    reversed_result = run(tmp_path, str(squeezed), str(reference))
    assert reversed_result.returncode == 0, reversed_result.stderr
    assert '27 won / 11 lost over 38 disagreeing question(s) [mcnemar]' in reversed_result.stdout


def test_an_artifact_without_question_records_still_produces_a_reading(tmp_path: Path) -> None:
    """Degrading to unpaired is honest; degrading to a guessed pairing is not."""
    reference = write(tmp_path, 'window.json', artifact())
    economy = write(tmp_path, 'economy.json', artifact(name='economy', prompt_tokens=17_000_000))
    result = run(tmp_path, str(reference), str(economy))
    assert result.returncode == 0, result.stderr
    assert 'unpaired: no per-question records on both sides' in result.stdout
    assert 'economy vs window: **dominates**' in result.stdout


def test_a_question_record_without_an_id_is_refused(tmp_path: Path) -> None:
    """Without the id the pairing would be positional, which is a claim about question order."""
    anonymous = questions()
    del anonymous[3]['questionId']
    reference = write(tmp_path, 'window.json', artifact(questions=questions()))
    broken = write(tmp_path, 'broken.json', artifact(name='broken', questions=anonymous))
    result = run(tmp_path, str(reference), str(broken))
    assert result.returncode == 2
    assert 'without a questionId' in result.stderr


def test_the_pairing_is_a_join_on_the_id_and_not_on_the_position(tmp_path: Path) -> None:
    """Two runs that ordered their questions differently are still one paired reading."""
    reference = write(tmp_path, 'window.json', artifact(questions=questions()))
    shuffled = questions(wrong={0, 1, 2})
    shuffled.reverse()
    arm = write(
        tmp_path, 'arm.json', artifact(name='arm', correct=457, prompt_tokens=24_274_000, questions=shuffled)
    )
    result = run(tmp_path, str(reference), str(arm))
    assert result.returncode == 0, result.stderr
    # Three questions lost, none won, whatever order the file holds them in.
    assert '0 won / 3 lost over 3 disagreeing question(s) [mcnemar]' in result.stdout


def test_the_cache_alone_cannot_make_one_arm_dominate(tmp_path: Path) -> None:
    """Two dispatches of one system, 78.21% and 98.34% hits: a 0.156x bill on a 1.003x context."""
    reference = write(
        tmp_path, 'plain.json', artifact(name='plain', prompt_tokens=24_209_976, cache_hits=18_933_570)
    )
    cached = write(
        tmp_path,
        'cached.json',
        artifact(
            name='cached',
            correct=462,
            prompt_tokens=24_273_758,
            cache_hits=23_870_370,
            questions=questions(),
        ),
    )
    result = run(tmp_path, str(reference), str(cached))
    assert result.returncode == 0, result.stderr
    assert 'billed 0.156x' in result.stdout
    assert 'cached vs plain: **incomparable**' in result.stdout


ARM_CONFIG = {
    'threshold': 0,
    'ask': 'verbatim',
    'promptContract': 'evidence-blocks-unsourced',
    'renderingRoutes': ['flat'],
    'maxPromptChars': 48000,
    'reader': {'providerId': 'deepseek', 'model': 'deepseek-chat', 'temperature': 0},
}


def test_a_single_variable_pair_is_named_as_one(tmp_path: Path) -> None:
    """The 24,000-character cut against the arm that differs in exactly one field."""
    reference = write(tmp_path, 'window.json', artifact(arm_config=ARM_CONFIG))
    squeezed = write(
        tmp_path,
        'squeezed.json',
        artifact(
            name='squeezed',
            correct=441,
            prompt_tokens=6_077_000,
            arm_config={**ARM_CONFIG, 'maxPromptChars': 24000},
        ),
    )
    result = run(tmp_path, str(reference), str(squeezed))
    assert result.returncode == 0, result.stderr
    assert 'config: single variable -- maxPromptChars' in result.stdout


def test_a_two_variable_pair_is_reported_and_cannot_certify_anything(tmp_path: Path) -> None:
    """`42355323615` against the cut: `ask` moved with the window, and the difference is the pair.

    This is the error the check exists to make impossible. `MR -6.61` was published as the window's
    cost; it belongs to a pair of two variables, and against the one-variable control `MR` is `-0.83`.
    """
    reference = write(tmp_path, 'window.json', artifact(arm_config=ARM_CONFIG))
    arm = write(
        tmp_path,
        'arm.json',
        artifact(
            name='arm',
            correct=444,
            prompt_tokens=6_077_000,
            arm_config={**ARM_CONFIG, 'maxPromptChars': 24000, 'ask': 'verbatim-acts'},
        ),
    )
    result = run(tmp_path, str(reference), str(arm))
    assert result.returncode == 0, result.stderr
    assert 'NOT a single-variable pair, differs on ask, maxPromptChars' in result.stdout
    # The arithmetic still runs and still prints; what it cannot do is promote the arm.
    # `confounded`, not `incomparable`. The two were one word for a round and they call for different work:
    # "the instrument cannot tell these apart" is answered by more repetitions, and "this pair is better but
    # two things moved" is answered by a step that moves one -- which is what the ladder block prints.
    assert 'arm vs window: **confounded**' in result.stdout


def test_a_derived_field_is_not_a_variable(tmp_path: Path) -> None:
    """`renderingRoutes` is computed from `promptContract`; counting it would report one as three."""
    reference = write(tmp_path, 'window.json', artifact(arm_config=ARM_CONFIG))
    same = write(
        tmp_path,
        'same.json',
        artifact(
            name='same',
            correct=470,
            prompt_tokens=17_000_000,
            arm_config={**ARM_CONFIG, 'renderingRoutes': ['flat', 'abstention']},
        ),
    )
    result = run(tmp_path, str(reference), str(same))
    assert result.returncode == 0, result.stderr
    assert 'config: identical, so this pair measures a run and not a variable' in result.stdout
    # And with the configs identical the promotion stands, because nothing else moved.
    assert 'same vs window: **dominates**' in result.stdout


def test_an_artifact_with_no_arm_config_cannot_be_admitted(tmp_path: Path) -> None:
    reference = write(tmp_path, 'window.json', artifact())
    arm = write(tmp_path, 'arm.json', artifact(name='arm', prompt_tokens=17_000_000))
    result = run(tmp_path, str(reference), str(arm))
    assert result.returncode == 0, result.stderr
    assert 'neither artifact records a memoryArmConfig' in result.stdout


def test_accuracy_is_read_from_the_repetition_mean_when_the_artifact_records_one(tmp_path: Path) -> None:
    """The rule `report.ts` already states, applied to the tool that was not applying it.

    `feature.metrics` is the first repetition; `ablation.featureAggregate.avg` is the mean over all of
    them, and it is the right population because every cost ratio's numerator is a sum over every
    repetition. `42310779222` reads 90.20% on its first repetition and **90.85%** averaged over four.
    """
    document = artifact()
    document['ablation'] = {'featureAggregate': {'avg': 0.9085, 'min': 0.902, 'max': 0.92}}
    reference = write(tmp_path, 'window.json', document)
    economy = write(tmp_path, 'economy.json', artifact(name='economy', prompt_tokens=17_000_000))
    result = run(tmp_path, '--json', str(reference), str(economy))
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    window = next(arm for arm in payload['arms'] if arm['arm'] == 'window')
    # 0.9085 x 500 = 454.25, and the reading keeps the quarter: 454 is 90.80% and 454.25 is the 90.85% the
    # artifact's own `featureAggregate` states. Rounding here was a systematic half-question against every
    # even repetition count, so the exact value is asserted rather than a rounded one.
    assert abs(window['overall']['value'] - 0.9085) < 1e-9
    assert window['accuracySource'] == 'repetition-mean'


def test_an_artifact_without_a_repetition_mean_says_which_population_it_used(tmp_path: Path) -> None:
    """`first-repetition` has to be named, because it is the number that looks like the other one."""
    reference = write(tmp_path, 'window.json', artifact())
    economy = write(tmp_path, 'economy.json', artifact(name='economy', prompt_tokens=17_000_000))
    result = run(tmp_path, '--json', str(reference), str(economy))
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert all(arm['accuracySource'] == 'first-repetition' for arm in payload['arms'])


def test_repetition_masks_are_read_as_one_pairing_per_question(tmp_path: Path) -> None:
    """The masks were in every four-repetition artifact and the reader ran on repetition 0.

    `ablation.featureCorrectByRun` has been written since §13.88, so a paired test of the repetition mean
    never needed a new dispatch — it needed a reader that used the field. This fixture is small enough to
    check by hand: three questions, `a` right in 4/4/0 and `b` right in 0/4/4. The differences are +4, 0 and
    −4, so the sign-flip statistic is 0 and the two-sided p is 1 — an exact tie established by looking at
    every repetition, which is a different statement from "no data".
    """
    questions = [
        {'questionId': f'q{index}', 'correct': True, 'capability': 'MR'} for index in range(3)
    ]
    # One mask per repetition, each indexed by question: `'110'` is "questions 0 and 1 right, 2 wrong in
    # this pass". Four of them, because four is what the repetition-mean reading is defined on.
    masks_a = ['110', '110', '110', '110']
    masks_b = ['011', '011', '011', '011']
    a = write(
        tmp_path,
        'a.json',
        artifact(name='a', questions=questions, masks=masks_a, aggregate=2 / 3),
    )
    b = write(
        tmp_path,
        'b.json',
        artifact(name='b', questions=questions, masks=masks_b, aggregate=2 / 3),
    )
    result = run(tmp_path, str(a), str(b))
    assert result.returncode == 0, result.stderr
    assert 'overall: 1 won / 1 lost over 2 disagreeing question(s) [sign-flip]' in result.stdout
    assert 'exact p = 1' in result.stdout
    # Two of the three questions tie exactly (4-4 and 0-0), and they are not counted as evidence.
    assert 'over 3 disagreeing' not in result.stdout
    # `a` is 4/4/0 and `b` is 0/4/4 correct across the four repetitions, so the middle question is a 4-4 tie and the
    # other two cancel: a tie established by looking at every repetition, not an absence of data.
    assert 'p = 1' in result.stdout


def test_the_ladder_names_a_step_that_does_not_run_through_the_reference(tmp_path: Path) -> None:
    """Attribution when the pair in question is not the pair against the reference.

    Three arms, one field apart each: `verbatim` -> `verbatim-acts` -> `verbatim-acts` at a route room. The
    reference is the first, so the third differs from it in two fields and is `confounded`; the second step is
    still a single-variable reading and the ladder is the only place it appears. Without the block, the set
    would have no attribution at all beyond the first step.
    """
    base = {'ask': 'verbatim', 'maxPromptChars': 48000}
    middle = {'ask': 'verbatim-acts', 'maxPromptChars': 48000}
    top = {'ask': 'verbatim-acts', 'maxPromptCharsByRoute': {'multi-session': 48000}}
    reference = write(tmp_path, 'a.json', artifact(name='a', arm_config=base, aggregate=0.9))
    step = write(tmp_path, 'b.json', artifact(name='b', arm_config=middle, aggregate=0.907))
    top_arm = write(tmp_path, 'c.json', artifact(name='c', arm_config=top, aggregate=0.913))
    result = run(tmp_path, '--json', str(reference), str(step), str(top_arm))
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    variables = sorted(entry['variable'] for entry in payload['ladder'])
    assert variables == ['ask', 'maxPromptChars'], variables
    assert payload['summary']['confounded'] == 1
    # The two one-field steps are reported; the two-field pair is not a step.
    assert len(payload['ladder']) == 2


def test_the_shipping_block_carries_the_attestation_the_matrix_reads(tmp_path: Path) -> None:
    """`S1` reads `shipping.accuracy` and checks three fields; this is where they are written."""
    reference = write(tmp_path, 'a.json', artifact(name='a', masks=['111', '111', '111'], aggregate=1.0))
    shipped = write(tmp_path, 'b.json', artifact(name='shipped', masks=['111', '111', '111'], aggregate=1.0))
    result = run(tmp_path, '--json', '--label', 'a', '--label', 'shipped', '--ship', 'shipped', str(reference), str(shipped))
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload['shipping']['arm'] == 'shipped'
    assert payload['shipping']['accuracySource'] == 'repetition-mean'
    assert payload['shipping']['runs'] == 4


def test_a_ship_label_that_is_not_an_arm_is_refused(tmp_path: Path) -> None:
    reference = write(tmp_path, 'a.json', artifact(name='a'))
    other = write(tmp_path, 'b.json', artifact(name='b'))
    result = run(tmp_path, '--json', '--ship', 'shipped', str(reference), str(other))
    assert result.returncode == 2
    assert 'which is not one of --label' in result.stderr
