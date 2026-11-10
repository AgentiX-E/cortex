"""Tests for `tools/evidence-budget.py`, the instrument behind the `C2` acceptance row.

`C2` says the median evidence per question, in tokens, is at most 70% of the registered
configuration's. It sat `unrun` with a reason, and the reason was precise: the only per-question
readings are in **characters**, and `tools/cost-ledger.py` sums tokens per question, which is a total
and not a median over evidence. This tool closes that gap, and the tests below pin the three ways the
closure can go wrong -- all three of which this campaign has hit at least once:

  - **a total is not a median.** `usageBySide.feature.promptTokens / questions` is the mean of a
    heavily skewed distribution; on `42355323615` the evidence offer runs from 53,509 to 531,038
    characters a question, and the mean would report a prompt nobody had.
  - **one repetition is not four.** The first draft of this tool divided the sum of
    `deliveredPromptChars` over 500 records by 24.3M tokens over 2,071 calls and printed **0.98
    characters per token** -- a plausible-looking number that was 4.14x wrong, because the character
    side covered one repetition and the token side covered four. The band refuses it now, and the
    refusal names the cause instead of printing a converted median that is 4x off.
  - **unspent room is not spare room.** `room - deliveredPromptChars` is the room the prompt left; the
    evidence the prompt could still have carried is bounded by it, and `chooseEvidence` takes a
    **prefix** of the relevance order, so a turn larger than the remainder ends the selection. The
    number is reported per capability because it is not uniform, and it is the reason `maxTurnChars`
    reaching two routes out of six is measurable at all.
"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))

from importlib import import_module

budget_tool = import_module('evidence-budget')

REPO = pathlib.Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'evidence-budget.py'


def record(
    *,
    evidence: int = 1_000,
    delivered: int = 1_100,
    turns: int = 10,
    capability: str = 'IE',
) -> dict:
    return {
        'questionId': f'q{evidence}',
        'capability': capability,
        'promptChars': evidence,
        'deliveredPromptChars': delivered,
        'evidenceTurns': turns,
    }


def report(
    *,
    questions: list[dict] | None = None,
    prompt_tokens: int = 11_000,
    calls: int = 40,
    question_count: int | None = None,
    runs: int = 4,
    rooms: dict | None = None,
) -> dict:
    """A report whose arithmetic is checkable by hand.

    Ten questions of 1,000 evidence characters in a 1,100-character prompt, 11,000 prompt tokens over
    40 calls (four repetitions, no retries) -- so 1,100 characters against 275 tokens a call, exactly
    4.0 characters per token, and every reading below is one division from those numbers.
    """
    records = questions if questions is not None else [record() for _ in range(10)]
    payload = {
        'questionCount': len(records) if question_count is None else question_count,
        'runs': runs,
        'questions': records,
        'usageBySide': {'feature': {'promptTokens': prompt_tokens, 'calls': calls}},
    }
    if rooms is not None:
        payload['memoryArmConfig'] = {'effectivePromptChars': rooms}
    return payload


def test_a_plausible_density_carries_every_conversion() -> None:
    # 2,200 characters a call over 550 tokens a call = 4.0, squarely inside the band.
    result = budget_tool.budget(report())
    assert result['density']['charsPerToken'] == pytest.approx(4.0, abs=0.01)
    assert result['density']['status'] == 'measured'
    assert result['readings']['medianEvidenceChars'] == pytest.approx(1_000)
    # 1,000 / 4.0 -- the conversion, applied once, from a measured factor.
    assert result['readings']['medianEvidenceTokensPerQuestion'] == pytest.approx(250)
    assert result['readings']['medianPromptTokensPerQuestion'] == pytest.approx(275)


def test_a_retry_enters_both_means_identically_and_is_only_reported() -> None:
    """A retry re-sends the same prompt, so it is one more call in both means and not a bias.

    The test pins the shape rather than a claim: one extra call with no extra tokens moves the
    per-call token reading down by 1/21, the density up by the same factor, and the converted median
    so a retry that re-sends a 1,100-character prompt with its 275 tokens leaves the ratio where it
    was. The share is printed beside the conversion rather than divided out because it moves nothing,
    and that is the fact worth pinning: 3.4% of `42355323615`'s calls were retries and the density is
    not biased by them.
    """
    one = budget_tool.budget(report())
    two = budget_tool.budget(report(prompt_tokens=11_275, calls=41))
    assert one['density']['retryShare'] == 0
    assert two['density']['retryShare'] == pytest.approx(1 / 41, abs=1e-3)
    assert two['density']['charsPerToken'] == pytest.approx(one['density']['charsPerToken'], rel=1e-3)


def test_a_denominator_that_lost_its_repetitions_is_refused_not_corrected() -> None:
    """The same fixture with four times the tokens per call reads 1.0 characters per token.

    Which is what the first draft printed on a real artifact. Nothing in the number announces
    itself -- 1.0 is a plausible density for a short-token dataset -- so the band is a refusal and
    not a warning.
    """
    with pytest.raises(SystemExit) as refusal:
        budget_tool.budget(report(prompt_tokens=44_000))
    assert 'outside the 2.5-6.0 band' in str(refusal.value)


def test_one_repetition_of_characters_over_four_of_tokens_is_refused() -> None:
    """The mistake the first draft made, reproduced as a refusal.

    500 records of 47,830 characters against 24.3M prompt tokens over 2,071 calls reads 0.98
    characters per token. Nothing about that number is obviously wrong -- it is plausible for a
    dataset of short tokens -- which is why it has to be refused rather than caveated.
    """
    with pytest.raises(SystemExit) as refusal:
        budget_tool.budget(report(prompt_tokens=2_000_000, calls=40))
    message = str(refusal.value)
    assert 'outside the' in message
    assert 'one-repetition' in message
    assert 'Refusing rather than dividing' in message


def test_no_per_question_records_is_refused_by_name() -> None:
    payload = report()
    payload.pop('questions')
    with pytest.raises(SystemExit) as refusal:
        budget_tool.budget(payload)
    assert 'no `questions[]`' in str(refusal.value)
    assert 'median' in str(refusal.value)


def test_a_truncated_record_set_is_refused_rather_than_caveated() -> None:
    # Nine records with a declared count of ten under-reads the median in whichever direction the
    # missing question leans, so there is no honest partial reading.
    with pytest.raises(SystemExit) as refusal:
        budget_tool.budget(report(question_count=10, questions=[record() for _ in range(9)]))
    assert 'holds 9 records' in str(refusal.value)


def test_a_record_without_the_evidence_split_is_refused() -> None:
    broken = record()
    del broken['promptChars']
    with pytest.raises(SystemExit) as refusal:
        budget_tool.budget(report(questions=[record(), broken]))
    assert '1 records carry no `promptChars`' in str(refusal.value)


def test_no_usage_side_is_refused_by_name() -> None:
    payload = report()
    payload.pop('usageBySide')
    with pytest.raises(SystemExit) as refusal:
        budget_tool.budget(payload)
    assert 'usageBySide.feature' in str(refusal.value)


def test_unspent_room_is_the_prompt_leftover_and_is_reported_per_capability() -> None:
    records = [
        record(evidence=1_000, delivered=1_100, capability='MR'),
        record(evidence=1_000, delivered=1_100, capability='MR'),
        record(evidence=900, delivered=1_000, capability='IE'),
    ]
    result = budget_tool.budget(report(questions=records, rooms={'*': 2_000}))
    # 2,000 - 1,100 = 900 on the MR questions, 2,000 - 1,000 = 1,000 on the IE one, medians of one
    # and two respectively -- the grouping is what makes the cap's uneven reach visible.
    assert result['cap']['unspentByCapability']['MR'] == {
        'n': 2,
        'medianUnspentChars': 900,
        'maxUnspentChars': 900,
    }
    assert result['cap']['unspentByCapability']['IE']['medianUnspentChars'] == 1_000


def test_an_unresolved_room_is_marked_unresolved() -> None:
    # A route map is a ceiling, not a measurement, and the tool says so rather than treating the one
    # named route as the room every route used.
    payload = report()
    payload['memoryArmConfig'] = {'maxPromptCharsByRoute': {'multi-session': 2_000}}
    cap = budget_tool.budget(payload)['cap']
    assert cap['resolved'] is False
    assert cap['roomSource'] == 'maxPromptCharsByRoute'


def test_the_ratio_is_one_and_unpaired_when_the_artifact_is_its_own_reference() -> None:
    arm = budget_tool.budget(report())
    ratio = budget_tool.ratio_to_reference(arm, arm)
    assert ratio['ratio'] == pytest.approx(1.0)
    assert ratio['paired'] is False


def test_the_ratio_divides_by_a_reference_it_was_given() -> None:
    arm = budget_tool.budget(report())
    # Same density, twice the evidence: 2,200 characters against 550 tokens a call is still 4.0, so
    # the ratio is the ratio of the evidence and not of the conversion.
    wider = budget_tool.budget(
        report(questions=[record(evidence=2_000, delivered=2_200) for _ in range(10)], prompt_tokens=22_000)
    )
    # The reference carries 2,000 characters of evidence against 1,000, and the density cancels
    # because both sides are converted with their own measured factor.
    ratio = budget_tool.ratio_to_reference(arm, wider)
    assert ratio['ratio'] == pytest.approx(0.5)
    assert ratio['paired'] is True


def test_instruction_share_is_reported_both_ways() -> None:
    # Median of ratios and ratio of medians are different statistics; a fixture where they differ
    # pins that the printed number is the median and the other is beside it, not substituted.
    records = [
        record(evidence=500, delivered=1_000),  # 50%
        record(evidence=900, delivered=1_000),  # 10%
        record(evidence=1_000, delivered=1_100),  # 9.1%
    ]
    readings = budget_tool.budget(report(questions=records))['readings']
    assert readings['medianInstructionShare'] == pytest.approx(0.10, abs=1e-3)
    assert readings['instructionShareOfMedian'] == pytest.approx(1 - 900 / 1_000, abs=1e-3)


def test_write_refuses_an_artifact_of_another_configuration(tmp_path: pathlib.Path) -> None:
    # The same gate as `cost-ledger.py --write`, and for the same reason: this file's readings are prose
    # support for `C1` and `C2`, and a support file naming a superseded room map is how a 24% error gets
    # quoted in a paragraph that no check reads.
    artifact = tmp_path / 'report.json'
    body = report()
    body['memoryArmConfig'] = {'ask': 'verbatim-acts'}
    artifact.write_text(json.dumps(body))
    baseline = tmp_path / 'baseline.json'
    baseline.write_text(
        json.dumps(
            {
                'run': '42355323615',
                'adoptedBy': '13.336',
                'memoryArmConfigFingerprint': 'sha256:' + '0' * 64,
                'dispatch': {},
            }
        )
    )
    completed = subprocess.run(
        [
            sys.executable, str(TOOL), str(artifact), '--write', str(tmp_path / 'out.json'),
            '--run', '42355323615', '--baseline', str(baseline),
        ],
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert 'not a measurement of the registered configuration' in completed.stderr
    assert not (tmp_path / 'out.json').exists()


def test_write_requires_the_run_it_came_from(tmp_path: pathlib.Path) -> None:
    artifact = tmp_path / 'report.json'
    artifact.write_text(json.dumps(report()))
    completed = subprocess.run(
        [sys.executable, str(TOOL), str(artifact), '--write', str(tmp_path / 'out.json')],
        capture_output=True,
        text=True,
    )
    assert completed.returncode != 0
    assert 'must name the run' in completed.stderr
    assert not (tmp_path / 'out.json').exists()
