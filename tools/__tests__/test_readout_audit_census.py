#!/usr/bin/env python3
"""The audit census has to be checkable against the roster it describes.

## The defect this guards against

§13.260 gave the arm a reader for the product's membership audit: a run-level tally
(`audit.attempted` / `audit.changed`) and a per-question pair on every record. Two fields about one
event can disagree, and a disagreeing pair is the class §13.107 found three times -- a census that
counted consultations where it claimed questions, a reach table that contradicted its own
implementation, a vote tally published on a run that never voted.

The invariant that makes it checkable is an identity inside one artifact: the roster's column must
**sum** to the tally. No control run is needed to decide it, which is the only kind of check `--audit`
is allowed to make.

§13.262 changed that identity's shape. It used to compare the tally against the *number* of records
flagged, and run `42054107910` failed it with `attempted: 469` over `118` flags -- the repetition count,
not a defect: the roster records the first of four passes and the tally counts all four. A flag cannot
satisfy an identity at `runs > 1`; a count can, and a count is what the producer now writes.

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


def _report(
    *,
    review_pass: str = 'audit',
    audit: dict | None = None,
    counts: list[int] | None = None,
    changes: list[int] | None = None,
) -> dict:
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
        if counts is not None:
            record['auditConsultations'] = counts[index]
            record['auditChanges'] = (changes or counts)[index]
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
            _report(audit={'attempted': 4, 'changed': 2}, counts=[1, 1, 1, 1], changes=[1, 1, 0, 0]),
        )

        assert result.returncode == 0, result.stdout + result.stderr
        assert 'PASS  audit' in result.stdout
        assert 'the roster sums to 4 consultations and 2 changes over 4 of 4 records' in result.stdout

    def test_the_column_sums_to_the_tally_at_any_repetition_count(self, tmp_path: Path) -> None:
        # The shape `42054107910` produced: two questions answered four times each, so a count of 2 per
        # record and a tally of 8 is consistent -- while a roster of flags would have said 2 and disagreed
        # with a correct tally by the repetition count. Nothing about this test depends on `runs` being 1.
        result = _run(
            tmp_path,
            _report(audit={'attempted': 8, 'changed': 4}, counts=[2, 2, 2, 2], changes=[1, 1, 1, 1]),
        )

        assert result.returncode == 0, result.stdout + result.stderr
        assert 'PASS  audit' in result.stdout

    def test_a_tally_that_disagrees_with_the_roster_fails(self, tmp_path: Path) -> None:
        # The pass says it ran four times; the roster says twice. One of them is not a measurement.
        result = _run(
            tmp_path,
            _report(audit={'attempted': 4, 'changed': 2}, counts=[1, 1, 0, 0], changes=[1, 1, 0, 0]),
        )

        assert result.returncode == 1
        assert 'FAIL  audit' in result.stdout

    def test_a_review_that_moved_more_answers_than_it_was_shown_fails(self, tmp_path: Path) -> None:
        # `changed` is a subset of `attempted` by construction: the pass only moves an answer it read.
        result = _run(
            tmp_path,
            _report(audit={'attempted': 2, 'changed': 5}, counts=[1, 1, 0, 0], changes=[3, 2, 0, 0]),
        )

        assert result.returncode == 1
        assert 'FAIL  audit' in result.stdout

    def test_a_roster_the_check_cannot_sum_over_fails(self, tmp_path: Path) -> None:
        # A sum is only an identity over the whole roster. A producer that wrote the pair on the questions
        # the pass reached and omitted it on the others would sum to the same tally over a smaller
        # denominator and look self-consistent while describing a filtered population.
        report = _report(audit={'attempted': 4, 'changed': 2}, counts=[1, 1, 1, 1], changes=[1, 1, 0, 0])
        del report['questions'][0]['auditConsultations']

        result = _run(tmp_path, report)

        assert result.returncode == 1
        assert 'FAIL  audit' in result.stdout

    def test_a_bare_run_that_publishes_a_zeroed_census_fails(self, tmp_path: Path) -> None:
        # The absence rule: a zeroed tally on a build without the pass claims a mechanism that never ran.
        result = _run(
            tmp_path,
            _report(review_pass='bare', audit={'attempted': 0, 'changed': 0}, counts=[0] * 4),
        )

        assert result.returncode == 1
        assert 'FAIL  audit' in result.stdout

    def test_a_bare_run_with_neither_field_passes(self, tmp_path: Path) -> None:
        result = _run(tmp_path, _report(review_pass='bare'))

        assert result.returncode == 0, result.stdout + result.stderr
        assert 'PASS  audit' in result.stdout


class TestTheTallyCensusIsCheckedByTheSameIdentity:
    """The second pass that publishes this census, and the field only it can have."""

    def test_a_tally_run_passes_when_the_census_carries_its_three_integers(self, tmp_path: Path) -> None:
        result = _run(
            tmp_path,
            _report(
                review_pass='tally',
                audit={'attempted': 4, 'changed': 2, 'refused': 1},
                counts=[1, 0, 2, 1],
                changes=[0, 0, 1, 1],
            ),
        )
        assert result.returncode == 0, result.stdout

    def test_a_tally_run_without_the_refusal_count_fails(self, tmp_path: Path) -> None:
        # `auditCensus()` emits `refused` under exactly one of the two passes, so an artifact that
        # omitted it under `tally` is not this build -- and the omitted field is the only number that
        # separates "the pass never fired" from "every ledger was unreadable".
        result = _run(
            tmp_path,
            _report(
                review_pass='tally',
                audit={'attempted': 4, 'changed': 2},
                counts=[1, 0, 2, 1],
                changes=[0, 0, 1, 1],
            ),
        )
        assert result.returncode != 0
        assert 'FAIL' in result.stdout

    def test_an_audit_run_that_publishes_a_refusal_count_fails(self, tmp_path: Path) -> None:
        # The mirror image: the audit has no refusal state, so printing a zero for it would report a
        # measurement of a branch that pass cannot enter.
        result = _run(
            tmp_path,
            _report(
                review_pass='audit',
                audit={'attempted': 4, 'changed': 2, 'refused': 0},
                counts=[1, 0, 2, 1],
                changes=[0, 0, 1, 1],
            ),
        )
        assert result.returncode != 0
        assert 'FAIL' in result.stdout

    def test_a_refusal_count_above_the_consultations_fails(self, tmp_path: Path) -> None:
        result = _run(
            tmp_path,
            _report(
                review_pass='tally',
                audit={'attempted': 4, 'changed': 2, 'refused': 5},
                counts=[1, 0, 2, 1],
                changes=[0, 0, 1, 1],
            ),
        )
        assert result.returncode != 0
        assert 'FAIL' in result.stdout

    def test_changes_plus_refusals_cannot_exceed_the_consultations(self, tmp_path: Path) -> None:
        # A consultation either produced a total, agreed with the one it was handed, or was refused, so
        # the two outcomes cannot together exceed the population they are outcomes of.
        result = _run(
            tmp_path,
            _report(
                review_pass='tally',
                audit={'attempted': 4, 'changed': 4, 'refused': 3},
                counts=[1, 0, 2, 1],
                changes=[1, 0, 1, 2],
            ),
        )
        assert result.returncode != 0
        assert 'FAIL' in result.stdout
