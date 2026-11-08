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
