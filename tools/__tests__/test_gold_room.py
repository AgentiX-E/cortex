#!/usr/bin/env python3
"""The room calculation has to refuse an unpriceable record rather than price it at zero.

## The defect this file is written against

§13.268.7 records a draft of exactly this arithmetic computed against `42161343457`, an artifact
produced before `goldTurns` existed. `sum(len(t) for t in goldTurns)` over an absent field is zero, the
sum then compared only the measured overhead against the 48,000-character cap, and every partial
question came back **reachable under a perfect selector** — the one direction that matters, because
the budget is the binding constraint §13.268.3 had just measured. A tool that answers "room is ample"
when it never counted the evidence is worse than a tool that fails.

So absence is a refusal here, and the refusal is the first thing this file tests.

## Why every stratum needs a case

The output is a partition of the partial population into "the selector had the choice" and "it did
not", and then into "fits" and "does not". A record can be in the wrong stratum for four independent
reasons — no gold, gold with no text, no overhead pair, gold the ranking never surfaced — and a tool
that collapsed any two of them would report the collapse as a finding. Each has its own fixture.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'gold-room.py'


def _record(
    identifier: str,
    *,
    capability: str = 'MR',
    gold: list[str] | None = None,
    carried: int = 0,
    ranks: list[int] | None = None,
    prompt_chars: int | None = 900,
    delivered_prompt_chars: int | None = 1_000,
) -> dict:
    """One roster record. Defaults describe a delivered-gold record with a 100-character overhead."""
    record: dict = {'questionId': identifier, 'capability': capability, 'correct': False}
    if prompt_chars is not None:
        record['promptChars'] = prompt_chars
    if delivered_prompt_chars is not None:
        record['deliveredPromptChars'] = delivered_prompt_chars
    if gold is not None:
        overlap: dict = {
            'carried': carried,
            'total': len(gold),
            'goldDelivered': [False] * len(gold),
        }
        if ranks is not None:
            overlap['goldRanks'] = ranks
            overlap['pool'] = sum(1 for rank in ranks if rank >= 0)
        overlap['goldTurns'] = gold
        record['goldOverlap'] = overlap
    return record


def _artifact(records: list[dict], *, budget: int | None = 1_000, cap: int | None = None) -> dict:
    config: dict = {}
    if budget is not None:
        config['maxPromptChars'] = budget
    if cap is not None:
        config['maxTurnChars'] = cap
    return {'questions': records, 'memoryArmConfig': config}


def _run(artifact: dict) -> subprocess.CompletedProcess[str]:
    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / 'artifact.json'
        path.write_text(json.dumps(artifact))
        return subprocess.run(
            [sys.executable, str(TOOL), str(path)],
            capture_output=True,
            text=True,
            check=False,
        )


class RefusalTest(unittest.TestCase):
    """An absent field is a refusal, and the refusal is the point of the tool."""

    def test_an_artifact_without_gold_turns_is_refused_and_named(self) -> None:
        record = _record('q1', gold=['a', 'b'], ranks=[0, 1])
        del record['goldOverlap']['goldTurns']
        result = _run(_artifact([record]))
        self.assertEqual(result.returncode, 2)
        self.assertIn('cannot price', result.stderr)
        self.assertIn('q1', result.stderr)

    def test_a_short_gold_list_is_refused_rather_than_summed(self) -> None:
        record = _record('q1', gold=['a', 'b'], ranks=[0, 1])
        record['goldOverlap']['goldTurns'] = ['a']
        result = _run(_artifact([record]))
        self.assertEqual(result.returncode, 2)
        self.assertIn('q1', result.stderr)

    def test_a_record_without_the_overhead_pair_is_refused(self) -> None:
        record = _record('q1', gold=['a'], ranks=[0], prompt_chars=None, delivered_prompt_chars=None)
        result = _run(_artifact([record]))
        self.assertEqual(result.returncode, 2)
        self.assertIn('q1', result.stderr)

    def test_an_artifact_with_no_budget_is_refused(self) -> None:
        # A budget is the denominator of the whole measurement; without it the gold is priced against
        # nothing and every question would be reported as fitting.
        result = _run(_artifact([_record('q1', gold=['a'], ranks=[0])], budget=None))
        self.assertEqual(result.returncode, 2)
        self.assertIn('no budget', result.stderr)

    def test_an_artifact_with_no_gold_at_all_is_refused(self) -> None:
        result = _run(_artifact([_record('q1', gold=None)]))
        self.assertEqual(result.returncode, 2)
        self.assertIn('no record names any gold', result.stderr)


class StratumTest(unittest.TestCase):
    """The four ways a record can land in a stratum other than "fits"."""

    def test_gold_that_fits_is_counted_as_reachable(self) -> None:
        # 100-character overhead plus 400 characters of gold against a 1,000-character budget.
        result = _run(_artifact([_record('q1', gold=['a' * 400], ranks=[0])]))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('MR', result.stdout)
        self.assertRegex(result.stdout, r'MR\s+1\s+0\s+1\s+1\s+1\s+0\s+0')

    def test_gold_that_does_not_fit_is_counted_as_room(self) -> None:
        result = _run(_artifact([_record('q1', gold=['a' * 2_000], ranks=[0])]))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r'MR\s+1\s+0\s+1\s+1\s+0\s+0\s+1')

    def test_gold_the_ranking_never_surfaced_is_its_own_stratum(self) -> None:
        # A selector cannot choose what it was never offered. §13.268.1 closed this population at
        # k=512, so a record here is a pool question and must not be reported as a selector's failure.
        result = _run(_artifact([_record('q1', gold=['a' * 10], ranks=[-1])]))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r'MR\s+1\s+0\s+1\s+0\s+0\s+0\s+0')

    def test_a_fully_delivered_question_is_not_part_of_the_partial_population(self) -> None:
        result = _run(_artifact([_record('q1', gold=['a'], ranks=[0], carried=1)]))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r'MR\s+1\s+1\s+0\s+0\s+0\s+0\s+0')

    def test_the_render_cap_changes_the_second_reading_and_not_the_first(self) -> None:
        # 1,500 characters of gold at a 400-character render cap: the uncapped arithmetic is over the
        # 1,000-character budget, and the capped one is under it. Both are printed; the conservative
        # column decides, and the other is labelled a judgement rather than a finding.
        artifact = _artifact([_record('q1', gold=['a' * 1_500], ranks=[0])], cap=400)
        result = _run(artifact)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertRegex(result.stdout, r'MR\s+1\s+0\s+1\s+1\s+0\s+1\s+1')


if __name__ == '__main__':
    unittest.main()
