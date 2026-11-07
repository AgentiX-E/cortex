"""Tests for `tools/cost-ledger.py`, the arithmetic behind the `C1` acceptance row.

`C1` says the reader is billed for at most 6,000 prompt tokens per question. That row cannot be
checked without first answering a different question: **which division?** One number
(`usageBySide.feature.promptTokens`) yields three defensible per-question figures, and on the
artifact this tool was written against they are 4.14x apart. A threshold whose denominator is
unstated is a row two readers can disagree about while both are arithmetically right, so the tests
below pin the denominator, the refusal, and the ways a plausible implementation would print a
number that means something else:

  - **per-question is not per-call.** The row and every competitor figure it is measured against are
    written per question; `perCall` is 3.5% smaller because it divides the retries away, and a
    retried call is a cost of answering that question. `perQuestion` (all four repetitions) is what a
    four-pass evaluation spends, and quoting it against a single-pass competitor number would
    overstate our cost by the repetition count -- a property of the harness, not of the product.
  - **the total is not a side.** `llmUsage` sums both arms and the baseline arm is a different
    system with a smaller window. A tool that falls back to the total when the split is absent
    answers a question about two systems with one number, which is worse than refusing.
  - **half-priced is not priced.** If `questionCount`/`runs` are absent, `perCall` is still
    computable. Printing it alone would report a complete-looking ledger for an artifact that can
    only answer one of the three questions.
  - **a reading at the cap is a reading of the cap.** This arm ran under `maxPromptChars: 48000` and
    delivered 4.11 characters per token of it, i.e. it filled the window. That is the difference
    between "our contexts are large because we retrieve a lot" and "our contexts are large because
    the window is set to 48,000", and only the second is cheap to change -- so the tool reports it.
  - **a missing cache counter is not a cold cache.** `None` and `0` are different readings, and only
    one of them is in the file.
  - **a boolean is not a count.** `True` is an `int` in Python and would price a run at 1 token per
    call without raising anything.
  - **an evidence file that does not name its run is not evidence.** `--write` therefore requires
    `--run`: the point of writing the ledger down is that a reader can return to the artifact.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from importlib import import_module

ledger_tool = import_module("cost-ledger")

REPO = pathlib.Path(__file__).resolve().parents[2]
TOOL = REPO / "tools" / "cost-ledger.py"


def report(
    *,
    prompt_tokens: object = 24_209_976,
    calls: object = 2_071,
    questions: object = 500,
    runs: object = 4,
    cache_hit: object = 18_933_570,
    with_side: bool = True,
    total_prompt_tokens: int = 27_069_177,
) -> dict:
    """The shape of `42310779222`, which is the run `C1` was written against.

    Kept as the default because every number in the docstring above is checkable by hand against
    it: 24,209,976 / 2,071 = 11,690, and / 500 = 48,420.
    """
    feature: dict = {'promptTokens': prompt_tokens, 'calls': calls}
    if cache_hit is not None:
        feature['cacheHitPromptTokens'] = cache_hit
    data: dict = {
        'questionCount': questions,
        'runs': runs,
        # Present on purpose: the refusal tests must not be able to pass by accident, i.e. by a
        # report that has nothing left to fall back to.
        'llmUsage': {'promptTokens': total_prompt_tokens, 'calls': 4_805},
    }
    if with_side:
        data['usageBySide'] = {
            'baseline': {'promptTokens': 2_859_201, 'calls': 2_734},
            'feature': feature,
        }
    return data


def report_with_cap(**overrides) -> dict:
    """`42310779222`'s arm, with the window it ran under.

    The cap matters because 24,209,976 prompt tokens over 2,071 calls is 4.11 characters per token of
    the 48,000-character window -- i.e. the delivery filled the window. A reading at the cap is a
    reading of the cap.
    """
    data = report(**overrides)
    data['memoryArmConfig'] = {'maxPromptChars': 48_000, 'ask': 'verbatim'}
    return data


# ------------------------------------------------------------------- the three readings, and why

class TestTheThreeReadings:
    def test_the_shipped_artifact_prices_at_three_different_numbers(self):
        result = ledger_tool.ledger(report())
        assert result['readings']['perCall'] == pytest.approx(11_690.0, abs=1)
        assert result['readings']['perQuestionPerRun'] == pytest.approx(12_104.988, abs=1)
        assert result['readings']['perQuestion'] == pytest.approx(48_419.952, abs=1)

    def test_the_spread_between_the_smallest_and_largest_reading_is_over_four_x(self):
        # The whole reason `C1` shipped as `unrun` instead of carrying a hand-typed figure: a 4x
        # disagreement between two people who are both doing correct arithmetic.
        readings = ledger_tool.ledger(report())['readings']
        assert max(readings.values()) / min(readings.values()) == pytest.approx(4.14, abs=0.01)

    def test_per_question_is_per_call_multiplied_by_the_repetition_count(self):
        # The identity that decides the primary, pinned as arithmetic rather than as prose: with no
        # retries, the two readings differ by exactly `runs`. Any comparison that puts
        # `perQuestion` next to a competitor's single-context figure is off by this factor.
        clean = report(calls=2_000)  # 500 questions x 4 runs, no retries
        readings = ledger_tool.ledger(clean)['readings']
        assert readings['perQuestion'] / readings['perCall'] == pytest.approx(4.0, abs=1e-9)

    def test_the_per_question_reading_is_primary_because_the_row_counts_questions(self):
        # `C1`'s metric and every competitor row it is measured against are written per question. The
        # per-call reading is 3.5% smaller because it divides the retries away, and it is reported
        # beside the primary rather than folded into it.
        result = ledger_tool.ledger(report())
        assert result['primary'] == 'perQuestionPerRun'
        assert result['comparableTo'] == 'prompt tokens delivered for one question, one repetition'
        assert result['readings']['perCall'] < result['readings']['perQuestionPerRun']

    def test_retries_are_reported_rather_than_smoothed_into_the_denominator(self):
        # 2,071 calls for 2,000 question-runs: 71 extra calls. Dividing by the number of calls that
        # actually happened is what the provider billed; dividing by questions x runs would report
        # a context slightly larger than the one delivered.
        result = ledger_tool.ledger(report())
        assert result['retries'] == 71
        assert result['readings']['perCall'] != result['readings']['perQuestionPerRun']

    def test_a_single_run_makes_the_two_smallest_readings_agree(self):
        # Degenerate case, pinned so the identity above cannot be satisfied by a tool that computes
        # one reading twice.
        result = ledger_tool.ledger(report(questions=500, runs=1, calls=500))
        assert result['readings']['perCall'] == result['readings']['perQuestionPerRun']
        assert result['retries'] == 0


# ------------------------------------------------------------------------------- the refusals

class TestTheRefusals:
    def test_an_artifact_without_a_side_split_is_refused_not_totalled(self):
        # `llmUsage` is present and would produce 27,069,177 / 2,000 = 13,535 -- a number that
        # belongs to neither arm.
        with pytest.raises(SystemExit) as raised:
            ledger_tool.ledger(report(with_side=False))
        message = str(raised.value)
        assert 'usageBySide.feature' in message
        assert 'both arms' in message

    def test_a_feature_block_that_is_present_but_empty_is_refused_too(self):
        data = report()
        data['usageBySide']['feature'] = {}
        with pytest.raises(SystemExit):
            ledger_tool.ledger(data)

    def test_a_zero_prompt_token_count_is_a_refusal_rather_than_a_free_run(self):
        # A run that made no calls did not cost zero per call; the ledger is undefined.
        with pytest.raises(SystemExit) as raised:
            ledger_tool.ledger(report(prompt_tokens=0))
        assert 'promptTokens' in str(raised.value)

    @pytest.mark.parametrize('value', [True, '2071', 2_071.0, None])
    def test_a_call_count_that_is_not_an_integer_is_refused(self, value):
        # Including `True`, which `isinstance(True, int)` would have priced at 1 call.
        with pytest.raises(SystemExit):
            ledger_tool.ledger(report(calls=value))

    @pytest.mark.parametrize('field', ['questionCount', 'runs'])
    def test_a_report_that_cannot_be_divided_per_question_is_refused(self, field):
        # perCall is still computable here. Printing it alone would be a ledger that answers one of
        # the three questions and looks like it answered all of them.
        data = report()
        data.pop(field)
        with pytest.raises(SystemExit) as raised:
            ledger_tool.ledger(data)
        assert field in str(raised.value)

    def test_the_refusal_is_an_exit_so_it_cannot_be_defaulted_downstream(self):
        # A sentinel return value would be turned into 0 by the first consumer that wanted a float,
        # and 0 passes an `at-most 6000` threshold.
        with pytest.raises(SystemExit):
            ledger_tool.ledger({})


# ---------------------------------------------------------------------------------- the cache

class TestTheCacheCounter:
    def test_a_missing_cache_counter_reads_as_absent_not_as_cold(self):
        assert ledger_tool.ledger(report(cache_hit=None))['inputs']['cacheHitPromptTokens'] is None

    def test_a_cache_that_never_hit_reads_as_zero(self):
        assert ledger_tool.ledger(report(cache_hit=0))['inputs']['cacheHitPromptTokens'] == 0

    def test_a_boolean_cache_counter_is_refused_as_absent(self):
        assert ledger_tool.ledger(report(cache_hit=True))['inputs']['cacheHitPromptTokens'] is None

    def test_the_cache_counter_does_not_change_the_readings(self):
        # Pinned because the hit count is the tempting explanation for a large prompt count, and an
        # explanation is not a discount: the reader is billed for tokens, cached or not.
        plain = ledger_tool.ledger(report(cache_hit=None))['readings']
        cached = ledger_tool.ledger(report(cache_hit=18_933_570))['readings']
        assert plain == cached


# ---------------------------------------------------------------------------------- the render

class TestTheRender:
    def test_the_first_line_names_the_division_and_the_unit(self):
        lines = ledger_tool.render(ledger_tool.ledger(report())).splitlines()
        assert lines[0] == 'primary: perQuestionPerRun = 12,105 prompt tokens'

    def test_every_reading_is_printed_so_the_spread_is_visible(self):
        text = ledger_tool.render(ledger_tool.ledger(report()))
        assert 'per call (one context)' in text
        assert 'per question per run' in text
        assert 'per question (all runs)' in text
        assert '48,420' in text
        # The one-context figure is still on screen: it is the number a reader reaches for when asking
        # how big the prompt is, and the primary is not that number.
        assert '11,690' in text

    def test_the_spread_is_printed_as_a_multiple(self):
        text = ledger_tool.render(ledger_tool.ledger(report()))
        assert 'spread between readings' in text
        assert '4.14x' in text

    def test_the_inputs_are_printed_so_the_division_can_be_rechecked(self):
        text = ledger_tool.render(ledger_tool.ledger(report()))
        assert '24,209,976' in text
        assert '2,071' in text
        assert '2,000' in text  # questions x runs, the denominator the tool did not use
        assert '71' in text  # and the difference between the two denominators


# -------------------------------------------------------------------------------------- the CLI

class TestTheCommandLine:
    def test_json_and_write_carry_the_same_ledger(self, tmp_path: pathlib.Path):
        source = tmp_path / 'report.json'
        source.write_text(json.dumps(report_with_cap()))
        written = tmp_path / 'out' / 'ledger.json'

        as_json = subprocess.run(
            [sys.executable, str(TOOL), str(source), '--json', '--run', '42310779222'],
            capture_output=True, text=True, check=True,
        )
        as_write = subprocess.run(
            [sys.executable, str(TOOL), str(source), '--write', str(written), '--run', '42310779222'],
            capture_output=True, text=True, check=True,
        )

        assert json.loads(as_json.stdout) == json.loads(written.read_text())
        # An evidence file whose provenance is not in the file is a number nobody can re-derive.
        assert json.loads(written.read_text())['run'] == '42310779222'
        # The render still goes to stdout when writing, so a log records what the file holds.
        assert as_write.stdout.startswith('primary: perQuestionPerRun')

    def test_writing_without_a_run_id_is_refused(self, tmp_path: pathlib.Path):
        source = tmp_path / 'report.json'
        source.write_text(json.dumps(report()))
        written = tmp_path / 'ledger.json'

        completed = subprocess.run(
            [sys.executable, str(TOOL), str(source), '--write', str(written)],
            capture_output=True, text=True,
        )

        assert completed.returncode != 0
        assert 'must name the run' in completed.stderr
        assert not written.exists()

    def test_a_refused_artifact_exits_non_zero_and_writes_nothing(self, tmp_path: pathlib.Path):
        source = tmp_path / 'report.json'
        source.write_text(json.dumps(report(with_side=False)))
        written = tmp_path / 'ledger.json'

        completed = subprocess.run(
            [sys.executable, str(TOOL), str(source), '--write', str(written), '--run', '42310779222'],
            capture_output=True, text=True,
        )

        assert completed.returncode != 0
        assert 'usageBySide.feature' in completed.stderr
        assert not written.exists()


# ------------------------------------------------------- the window: is the reading the cap?

class TestTheWindowCap:
    def test_the_cap_is_read_from_the_arm_config(self):
        cap = ledger_tool.ledger(report_with_cap())['cap']
        assert cap['maxPromptChars'] == 48_000
        assert cap['status'] == 'inferred'

    def test_a_prompt_at_its_character_cap_is_reported_as_the_window(self):
        # 48,000 / 11,690 = 4.11 characters per token, inside the band for English prose. The reading
        # is therefore the size of the window rather than the size of a selection from it, and it will
        # not move when retrieval improves -- which is the whole reason this is printed.
        cap = ledger_tool.ledger(report_with_cap())['cap']
        assert cap['impliedCharsPerToken'] == pytest.approx(4.11, abs=0.01)
        assert cap['reading'] == 'at-cap'

    def test_a_prompt_well_under_its_cap_is_reported_as_a_selection(self):
        # Same 48,000-character window, but only 2,400 tokens per call: 20 characters per token, which
        # no English prose reaches. The arm is capped and not filling the cap.
        cap = ledger_tool.ledger(report_with_cap(prompt_tokens=4_800_000))['cap']
        assert cap['reading'] == 'below-cap'

    def test_an_artifact_without_a_cap_reports_absence_rather_than_freedom(self):
        assert ledger_tool.ledger(report())['cap'] is None

    def test_a_cap_of_zero_is_absence_not_an_infinite_window(self):
        data = report()
        data['memoryArmConfig'] = {'maxPromptChars': 0}
        assert ledger_tool.ledger(data)['cap'] is None

    def test_the_band_is_printed_so_the_inference_can_be_checked(self):
        text = ledger_tool.render(ledger_tool.ledger(report_with_cap()))
        assert 'window fill' in text
        assert 'at-cap' in text
        assert '3.5-4.7 characters per token' in text

    def test_the_cap_does_not_change_any_reading(self):
        # Pinned because the cap is the tempting explanation for a large context, and an explanation is
        # not a discount: the reader was handed those tokens.
        capped = ledger_tool.ledger(report_with_cap())['readings']
        uncapped = ledger_tool.ledger(report())['readings']
        assert capped == uncapped


# ------------------------------------------------------------------ the row this tool serves

class TestTheAcceptanceRowItServes:
    def test_the_primary_reading_is_the_one_compared_against_the_threshold(self):
        # `C1` is `at-most 6000`. On this artifact the primary reading misses by 2.02x while the
        # per-call reading misses by 1.95x -- the same artifact, two deficits, and the 3.5% between
        # them is our retries, which the per-question unit counts.
        primary = ledger_tool.ledger(report())['readings']['perQuestionPerRun']
        assert primary / 6_000 == pytest.approx(2.02, abs=0.01)

    def test_the_competitor_figures_are_per_question_and_the_primary_is_what_they_are_compared_to(self):
        # Zep 4.4K / Mem0 6.8K / Maximem 7.4K are quoted per question in `acceptance.ts`, which is the
        # unit the primary is in. Pinned as a ratio so "we are 2.75x Zep" is attached to the reading it
        # is true of, and so a later change of primary has to move this number on purpose.
        primary = ledger_tool.ledger(report())['readings']['perQuestionPerRun']
        assert primary / 4_400 == pytest.approx(2.75, abs=0.01)
        assert primary / 6_800 == pytest.approx(1.78, abs=0.01)

    def test_the_reading_is_the_window_and_the_row_should_say_so(self):
        # The joint reading of the two blocks: 12,105 tokens per question delivered out of a
        # 48,000-character window that the delivery fills. Section 13.291 measured that bringing every
        # gold turn into the prompt (98 of 121 questions to 120) moved accuracy by exactly zero, so the
        # excess tokens are not what the missing 6 points are made of. `C1.onMiss` carries this.
        result = ledger_tool.ledger(report_with_cap())
        assert result['cap']['reading'] == 'at-cap'
        assert result['readings']['perQuestionPerRun'] > 2 * 6_000


# ------------------------------------------------------------- prompt tokens per correct answer

def report_with_metrics(accuracy: object = 0.92, correct: object = 460) -> dict:
    """`report()` with the arm's metrics block, which is where the correct-answer count lives.

    Separate from `report()` rather than a default, because the artifacts written before the metrics
    block was recorded are still read by this tool and the absence is a state it has to survive.
    """
    data = report()
    data['feature'] = {'name': 'cortex-memory', 'metrics': {'total': 500, 'accuracy': accuracy, 'correct': correct}}
    return data


class TestPromptTokensPerCorrectAnswer:
    """`AlphaDiana` (`arXiv:2610.20675`): a cheaper run that answers fewer right is not cheaper.

    The reading is `perQuestionPerRun / accuracy` -- prompt tokens spent per question, divided by
    the share of questions answered correctly -- because that is the ratio the paper measured moving
    in the opposite direction to per-execution cost. It is kept OUT of `readings`: those three are
    divisions of one number and their spread is what justifies the primary.
    """

    def test_a_measured_accuracy_prices_the_correct_answers(self):
        result = ledger_tool.ledger(report_with_metrics(accuracy=0.92))
        efficiency = result['efficiency']
        assert efficiency['state'] == 'measured'
        assert efficiency['accuracy'] == pytest.approx(0.92)
        assert efficiency['perCorrectAnswerPromptTokens'] == pytest.approx(12_104.988 / 0.92, abs=1)

    def test_the_ratio_is_not_one_of_the_three_readings(self):
        # Folding it in would change `spread`, which is the number that says why `perQuestionPerRun`
        # is primary. A reading that is a ratio of two measurements is not a fourth division.
        result = ledger_tool.ledger(report_with_metrics())
        assert set(result['readings']) == {'perCall', 'perQuestionPerRun', 'perQuestion'}
        assert 'perCorrectAnswer' not in result['readings']

    def test_lower_accuracy_raises_the_cost_of_a_correct_answer(self):
        # The whole point: cutting tokens while losing accuracy can make each correct answer MORE
        # expensive. Two runs 10% apart on cost and 4 points apart on accuracy, where the cheaper one
        # is not cheaper per correct answer.
        lean = ledger_tool.ledger(report_with_metrics(accuracy=0.88))['efficiency']
        rich = ledger_tool.ledger(report_with_metrics(accuracy=0.92))['efficiency']
        assert lean['perCorrectAnswerPromptTokens'] > rich['perCorrectAnswerPromptTokens']

    def test_zero_accuracy_is_undefined_rather_than_enormous(self):
        # An arm that answered nothing right has no cost per right answer. Printing `inf` would be a
        # number; printing nothing would hide that the run happened.
        efficiency = ledger_tool.ledger(report_with_metrics(accuracy=0.0, correct=0))['efficiency']
        assert efficiency['state'] == 'undefined'
        assert 'perCorrectAnswerPromptTokens' not in efficiency
        assert 'infinite' in efficiency['note']

    def test_a_missing_metrics_block_is_absent_rather_than_zero(self):
        efficiency = ledger_tool.ledger(report())['efficiency']
        assert efficiency['state'] == 'absent'
        assert 'perCorrectAnswerPromptTokens' not in efficiency

    def test_a_percentage_accuracy_is_refused_rather_than_divided_by(self):
        # `92` instead of `0.92` would price a correct answer at 132 tokens -- a hundredfold
        # understatement that looks like a triumph.
        efficiency = ledger_tool.ledger(report_with_metrics(accuracy=92))['efficiency']
        assert efficiency['state'] == 'absent'
        assert 'not a fraction' in efficiency['note']

    def test_a_boolean_accuracy_is_refused(self):
        # `True` is an `int` in Python; dividing by it would price a correct answer at exactly the
        # per-question cost and read as a flawless ratio.
        efficiency = ledger_tool.ledger(report_with_metrics(accuracy=True))['efficiency']
        assert efficiency['state'] == 'absent'

    def test_the_rendered_line_says_which_accuracy_it_was_divided_by(self):
        # A ratio of two numbers quoted without both is a claim a reader cannot check.
        text = ledger_tool.render(ledger_tool.ledger(report_with_metrics(accuracy=0.92, correct=460)))
        assert 'per correct answer' in text
        assert '92.00%' in text
        assert '460' in text
