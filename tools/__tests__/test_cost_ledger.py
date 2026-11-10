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
registration = import_module("registration-attest")

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

CONFIG = {"ask": "verbatim-acts", "maxTurnChars": 400, "reader": {"model": "deepseek-chat", "temperature": 0}}


def registered(tmp_path: pathlib.Path, data: dict, run: str = "42310779222") -> pathlib.Path:
    """A registration record that agrees with `data`.

    `dispatch` is empty on purpose: `matched` is decided by the fingerprint and the difference list only
    diagnoses, which is the property `test_registration_attest.py` pins. A full projection here would be
    a second test of `arm-config-record.py`.
    """
    path = tmp_path / "baseline.json"
    path.write_text(
        json.dumps(
            {
                "run": run,
                "adoptedBy": "13.336",
                "memoryArmConfigFingerprint": registration.fingerprint(data.get("memoryArmConfig")),
                "dispatch": {},
            }
        )
    )
    return path


class TestTheCommandLine:
    def test_json_and_write_carry_the_same_ledger(self, tmp_path: pathlib.Path):
        data = report_with_cap()
        data['memoryArmConfig'] = CONFIG
        source = tmp_path / 'report.json'
        source.write_text(json.dumps(data))
        written = tmp_path / 'out' / 'ledger.json'

        as_json = subprocess.run(
            [sys.executable, str(TOOL), str(source), '--json', '--run', '42310779222'],
            capture_output=True, text=True, check=True,
        )
        as_write = subprocess.run(
            [
                sys.executable, str(TOOL), str(source), '--write', str(written),
                '--run', '42310779222', '--baseline', str(registered(tmp_path, data)),
            ],
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
        data = report(with_side=False)
        data['memoryArmConfig'] = CONFIG
        source = tmp_path / 'report.json'
        source.write_text(json.dumps(data))
        written = tmp_path / 'ledger.json'

        completed = subprocess.run(
            [
                sys.executable, str(TOOL), str(source), '--write', str(written),
                '--run', '42310779222', '--baseline', str(registered(tmp_path, data)),
            ],
            capture_output=True, text=True,
        )

        assert completed.returncode != 0
        assert 'usageBySide.feature' in completed.stderr
        assert not written.exists()

    def test_an_artifact_of_another_configuration_cannot_become_the_ledger(self, tmp_path: pathlib.Path):
        # `C1` read 12,137 for a round in which the registered configuration billed 9,201 -- a correct
        # record of a run, and not a record of the configuration the project ships. The refusal is what
        # makes the difference impossible to publish again.
        data = report_with_cap()
        data['memoryArmConfig'] = CONFIG
        source = tmp_path / 'report.json'
        source.write_text(json.dumps(data))
        written = tmp_path / 'ledger.json'
        other = dict(CONFIG, maxPromptCharsByRoute={'multi-session': 48460})

        completed = subprocess.run(
            [
                sys.executable, str(TOOL), str(source), '--write', str(written),
                '--run', '42355323615', '--baseline', str(registered(tmp_path, {'memoryArmConfig': other})),
            ],
            capture_output=True, text=True,
        )

        assert completed.returncode != 0
        assert 'not a measurement of the registered configuration' in completed.stderr
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


# --------------------------------------------------- §13.308 the denominator and its population

def report_with_spread(*, first_repetition: float, average: float, accuracy_source: dict | None = None) -> dict:
    """The §13.305 pair's shape: `feature.metrics` is ONE repetition, `featureAggregate` is all.

    Both numbers are in the same artifact, which is why the defect needed no new measurement to
    find -- only a reader who asked which population the numerator came from.
    """
    data = report_with_metrics(accuracy=first_repetition)
    data['ablation'] = {'featureAggregate': {'min': 0.9, 'avg': average, 'max': 0.95, 'median': average}}
    if accuracy_source is not None:
        data['costEfficiency'] = accuracy_source
    return data


class TestTheDenominatorMustMatchTheNumerator:
    """§13.308: `perQuestionPerRun` is a sum over every repetition, so the divisor must be too.

    The tool shipped dividing that all-repetition numerator by `feature.metrics.accuracy`, which
    the Markdown labels *"first repetition"*. On the §13.305 pair the baseline's first repetition
    was its worst (91.40% against a 91.95% mean) and the control's was its best (90.80% against
    90.75%), so the shipped division charged the baseline 0.60% too much and the control 0.06% too
    little: a 1.20 pp accuracy gap read as a **0.57%** cost gap where the honest figure is 1.23%.
    Repetition order is arbitrary, so the sign of the error is arbitrary too.
    """

    def test_the_all_runs_mean_is_preferred_when_the_artifact_carries_it(self):
        efficiency = ledger_tool.ledger(
            report_with_spread(first_repetition=0.914, average=0.9195)
        )['efficiency']
        assert efficiency['state'] == 'measured'
        assert efficiency['accuracy'] == pytest.approx(0.9195)
        assert efficiency['accuracySource'] == 'all-runs'

    def test_the_first_repetition_is_used_only_when_there_is_no_spread(self):
        efficiency = ledger_tool.ledger(report_with_metrics(accuracy=0.914))['efficiency']
        assert efficiency['state'] == 'measured'
        assert efficiency['accuracy'] == pytest.approx(0.914)
        assert efficiency['accuracySource'] == 'first-repetition'

    def test_the_reading_does_not_move_when_the_repetition_order_does(self):
        # The invariant: permutation changes `feature.metrics.accuracy` and nothing else. A reader
        # that divides by it returns two prices for one run.
        worst_first = ledger_tool.ledger(
            report_with_spread(first_repetition=0.914, average=0.9195)
        )['efficiency']
        best_first = ledger_tool.ledger(
            report_with_spread(first_repetition=0.932, average=0.9195)
        )['efficiency']
        assert worst_first['perCorrectAnswerPromptTokens'] == pytest.approx(
            best_first['perCorrectAnswerPromptTokens']
        )

    def test_the_shipped_division_overcharges_the_arm_whose_first_run_was_worst(self):
        # A named number rather than a direction, so a regression that reintroduces the old
        # division fails with the size of the error in the message.
        shipped = ledger_tool.ledger(report_with_metrics(accuracy=0.914))['efficiency']
        honest = ledger_tool.ledger(
            report_with_spread(first_repetition=0.914, average=0.9195)
        )['efficiency']
        ratio = shipped['perCorrectAnswerPromptTokens'] / honest['perCorrectAnswerPromptTokens']
        assert ratio == pytest.approx(1.006018, abs=1e-6)

    def test_an_artifact_authored_reading_wins_over_recomputation(self):
        # The run knows both inputs at the moment it writes; a consumer that recomputes can only
        # agree with it or be wrong, so it defers.
        authored = {
            'state': 'measured',
            'accuracy': 0.9195,
            'correct': 459,
            'perCorrectAnswerPromptTokens': 13199.43,
            'accuracySource': 'all-runs',
        }
        efficiency = ledger_tool.ledger(
            report_with_spread(first_repetition=0.914, average=0.9195, accuracy_source=authored)
        )['efficiency']
        assert efficiency['perCorrectAnswerPromptTokens'] == pytest.approx(13199.43)
        assert efficiency['accuracySource'] == 'artifact'

    def test_an_authored_reading_of_the_wrong_shape_is_refused_rather_than_trusted(self):
        # `costEfficiency` is a field a future build could get wrong. A percentage, a boolean or a
        # missing ratio must not be adopted just because it is present.
        for broken in (
            {'state': 'measured', 'accuracy': 92, 'perCorrectAnswerPromptTokens': 100},
            {'state': 'measured', 'accuracy': 0.9, 'perCorrectAnswerPromptTokens': '100'},
            {'state': 'measured', 'accuracy': 0.9},
            {'state': 'absent'},
            'not-a-dict',
        ):
            efficiency = ledger_tool.ledger(
                report_with_spread(first_repetition=0.914, average=0.9195, accuracy_source=broken)
            )['efficiency']
            assert efficiency['state'] == 'measured'
            assert efficiency['accuracy'] == pytest.approx(0.9195), broken
            assert efficiency['accuracySource'] == 'all-runs', broken

    def test_a_zero_accuracy_of_zero_in_the_spread_cannot_be_used(self):
        # The spread is a number in a file like any other. A `0` there is not a denominator.
        efficiency = ledger_tool.ledger(
            report_with_spread(first_repetition=0.914, average=0.0)
        )['efficiency']
        assert efficiency['state'] == 'measured'
        assert efficiency['accuracy'] == pytest.approx(0.914)
        assert efficiency['accuracySource'] == 'first-repetition'

    def test_the_rendered_line_names_the_population_even_when_it_is_the_first_repetition(self):
        text = ledger_tool.render(ledger_tool.ledger(report_with_metrics(accuracy=0.92, correct=460)))
        assert 'first-repetition' in text

    def test_the_rendered_line_names_the_population_when_the_spread_was_used(self):
        text = ledger_tool.render(
            ledger_tool.ledger(report_with_spread(first_repetition=0.914, average=0.9195))
        )
        assert 'all-runs' in text
        assert '91.95%' in text


class TestASplitThatDoesNotCloseCannotPriceAnAnswer:
    """§13.308, second instance: the numerator has to come from a column that adds up.

    `usageBySide` carries two independently accumulated tallies. When they claim more prompt tokens
    than the run reported, the two snapshots did not come from one ledger -- `residualUsage` refuses
    to name a residual, and `report.ts` renders `SPLIT UNAVAILABLE` instead of a per-arm column. A
    ratio computed from that column inherits the doubt, and an absent ratio reads as "not measured"
    while a wrong one reads as a measurement.

    The check is one-sided on purpose: an artifact that carries no total, or a total that is not an
    integer, cannot prove anything either way and must not be refused for the absence of a witness.
    """

    def _pad(self, ) -> dict:
        data = report_with_spread(first_repetition=0.914, average=0.9195)
        # Less than either side alone, so no reading of the total can make the parts fit.
        data['llmUsage'] = {'promptTokens': 1_000_000, 'calls': 4_805}
        return data

    def test_the_reading_is_refused_when_the_parts_exceed_the_whole(self):
        efficiency = ledger_tool.ledger(self._pad())['efficiency']
        assert efficiency['state'] == 'absent'
        assert 'does not close' in efficiency['note']

    def test_a_report_without_a_total_is_not_refused_for_the_absence(self):
        data = report_with_spread(first_repetition=0.914, average=0.9195)
        del data['llmUsage']
        efficiency = ledger_tool.ledger(data)['efficiency']
        assert efficiency['state'] == 'measured'

    def test_a_total_that_is_not_an_integer_is_not_a_witness(self):
        data = report_with_spread(first_repetition=0.914, average=0.9195)
        data['llmUsage']['promptTokens'] = '27069177'
        efficiency = ledger_tool.ledger(data)['efficiency']
        assert efficiency['state'] == 'measured'

    def test_a_side_block_with_no_token_count_is_skipped_rather_than_counted_as_zero(self):
        data = report_with_spread(first_repetition=0.914, average=0.9195)
        del data['usageBySide']['baseline']['promptTokens']
        efficiency = ledger_tool.ledger(data)['efficiency']
        assert efficiency['state'] == 'measured'

    def test_the_refusal_names_what_it_could_not_divide(self):
        text = ledger_tool.render(ledger_tool.ledger(self._pad()))
        assert 'not stated' in text
        assert 'does not close' in text


class TestTheCorrectCountBelongsToOneRepetition:
    """§13.308 on the third field: `correct` and `accuracy` must be the same population too.

    Real artifact `42387911305`: the all-runs mean is 90.75% and `feature.metrics.correct` is 454,
    which is 90.80% of 500 -- the first repetition. Printing `(454 correct, all-runs)` puts two
    populations in one parenthesis and invites a reader to divide them, and the quotient is a
    number that describes no run. The count is therefore withheld when the denominator is a mean
    over repetitions, for the same reason the ratio carries `accuracySource` at all.
    """

    def test_an_all_runs_denominator_does_not_quote_one_runs_count(self):
        efficiency = ledger_tool.ledger(
            report_with_spread(first_repetition=0.914, average=0.9195)
        )['efficiency']
        assert efficiency['accuracySource'] == 'all-runs'
        assert efficiency['correct'] is None

    def test_the_single_repetition_case_still_quotes_its_count(self):
        efficiency = ledger_tool.ledger(report_with_metrics(accuracy=0.92, correct=460))['efficiency']
        assert efficiency['accuracySource'] == 'first-repetition'
        assert efficiency['correct'] == 460

    def test_the_rendered_line_does_not_print_a_count_it_cannot_pair(self):
        text = ledger_tool.render(
            ledger_tool.ledger(report_with_spread(first_repetition=0.914, average=0.9195))
        )
        # 0.914 x 500 = 457, the first repetition's own count. It must not appear beside 91.95%.
        assert '457' not in text
        assert '91.95%' in text
