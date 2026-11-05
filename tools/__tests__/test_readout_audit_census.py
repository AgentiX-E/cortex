#!/usr/bin/env python3
"""The audit census has to be checkable against the roster it describes.

## The defect this guards against

§13.260 gave the arm a reader for the product's membership audit: a run-level tally
(`audit.attempted` / `audit.changed`) and a per-question pair on every record. Two fields about one
event can disagree, and a disagreeing pair is the class §13.107 found three times -- a census that
counted consultations where it claimed questions, a reach table that contradicted its own
implementation, a vote tally published on a run that never voted.

The invariant that makes it checkable is an identity inside one artifact: the tally's `attempted`
must equal the number of records that say the pass ran. No control run is needed to decide it, which
is the only kind of check `--audit` is allowed to make.

## Why the negative cases are the point

A check that passes on a good artifact proves nothing. Each case below breaks exactly one field and
requires the tool to say so and exit non-zero, because the tool gates a dispatch: a check that
printed `FAIL` and exited 0 could not stop one.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'readout-arm-run.py'


def _report(*, review_pass: str = 'audit', audit: dict | None = None, flags: list[bool] | None = None) -> dict:
    """A run whose every other field is consistent, so the audit check is the only variable."""
    ids = ['q1', 'q2', 'q3', 'q4']
    records = []
    for index, question_id in enumerate(ids):
        record = {
            'questionId': question_id,
            'capability': 'MR',
            'question': f'How many items {index}?',
            'groundTruth': '3',
            'answer': '3',
            'correct': True,
            'promptChars': 1000,
        }
        if flags is not None:
            record['auditAttempted'] = flags[index]
            record['auditChanged'] = flags[index]
        records.append(record)

    report = {
        'questionCount': len(ids),
        'runs': 1,
        'memoryArmConfig': {
            'ask': 'verbatim',
            'askRoutes': ['multi-session'],
            'renderingRoutes': ['multi-session'],
            'promptContract': 'abstention-evidence-blocks',
            'reviewPass': review_pass,
            'maxPromptChars': 48000,
            'selfConsistency': 'none',
            'queryExpansion': 'none',
        },
        'abstentionReasons': {'empty': 0, 'threshold': 0, 'llm': 0, 'answered': len(ids)},
        'questions': records,
    }
    if audit is not None:
        report['audit'] = audit
    return report


def _run(tmp_path: Path, report: dict) -> subprocess.CompletedProcess[str]:
    path = tmp_path / 'report.json'
    path.write_text(json.dumps(report), encoding='utf-8')
    return subprocess.run(
        [sys.executable, str(TOOL), '--audit', str(path)],
        capture_output=True,
        text=True,
        check=False,
    )


class TestTheAuditCensusIsCheckedAgainstTheRoster:
    def test_a_consistent_run_passes(self, tmp_path: Path) -> None:
        result = _run(
            tmp_path,
            _report(audit={'attempted': 4, 'changed': 2}, flags=[True, True, True, True]),
        )

        assert result.returncode == 0, result.stdout + result.stderr
        assert 'PASS  audit' in result.stdout
        assert '4 of 4 records report the pass fired' in result.stdout

    def test_a_tally_that_disagrees_with_the_roster_fails(self, tmp_path: Path) -> None:
        # The pass says it ran four times; the roster says twice. One of them is not a measurement.
        result = _run(
            tmp_path,
            _report(audit={'attempted': 4, 'changed': 2}, flags=[True, True, False, False]),
        )

        assert result.returncode == 1
        assert 'FAIL  audit' in result.stdout

    def test_a_review_that_moved_more_answers_than_it_was_shown_fails(self, tmp_path: Path) -> None:
        # `changed` is a subset of `attempted` by construction: the pass only moves an answer it read.
        result = _run(
            tmp_path,
            _report(audit={'attempted': 2, 'changed': 5}, flags=[True, True, False, False]),
        )

        assert result.returncode == 1
        assert 'FAIL  audit' in result.stdout

    def test_a_bare_run_that_publishes_a_zeroed_census_fails(self, tmp_path: Path) -> None:
        # The absence rule: a zeroed tally on a build without the pass claims a mechanism that never ran.
        result = _run(
            tmp_path,
            _report(review_pass='bare', audit={'attempted': 0, 'changed': 0}, flags=[False] * 4),
        )

        assert result.returncode == 1
        assert 'FAIL  audit' in result.stdout

    def test_a_bare_run_with_neither_field_passes(self, tmp_path: Path) -> None:
        result = _run(tmp_path, _report(review_pass='bare'))

        assert result.returncode == 0, result.stdout + result.stderr
        assert 'PASS  audit' in result.stdout
