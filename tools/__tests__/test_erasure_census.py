#!/usr/bin/env python3
"""Tests for `tools/erasure-census.mjs` -- the check that decides whether an erasure was complete.

## The defect this file is written against

An erasure test that asserts "the row is gone" measures the copy nobody doubted. AfterDeleteBench
(arXiv:2610.31366) recovers a deleted secret in 68% of cases because a *derived* copy survived, and
the same shape is available here: the card holds the sentence and the turns around it, the release
record holds the wording and its digest. `erasure-census.mjs` therefore counts occurrences across
**every row of every table in both stores**, before and after, and the before-reading is a control.

## Why its guards are exercised rather than trusted

A guard that has only been observed passing may be evaluating nothing. The tool accepts a fault
(`CORTEX_ERASURE_CENSUS_FAULT=no-forget`) that skips one erasure, and this file asserts the exit
codes of both runs:

| Run | Must report |
| --- | --- |
| clean | exit 0, `residualOccurrences == 0`, `controlOccurrences > 0` |
| one erasure skipped | exit 1, `FAILED`, and the artifact says how much survived |

The clean run is executed **last** on purpose: the tool writes the artifact the acceptance matrix
reads, so a test that left the faulted reading in place would fail every later gate in the chain.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'erasure-census.mjs'
ARTIFACT = REPO.parent / 'cortex-docs' / 'evidence' / 'erasure' / 'census.json'


def run(fault: str | None = None) -> subprocess.CompletedProcess[str]:
    environment = dict(os.environ)
    environment.pop('CORTEX_ERASURE_CENSUS_FAULT', None)
    if fault is not None:
        environment['CORTEX_ERASURE_CENSUS_FAULT'] = fault
    return subprocess.run(
        ['node', str(TOOL)],
        cwd=REPO,
        capture_output=True,
        text=True,
        env=environment,
        check=False,
    )


def artifact() -> dict:
    return json.loads(ARTIFACT.read_text(encoding='utf-8'))


class TestCleanRun:
    def test_reports_zero_residual_with_a_control_that_found_something(self) -> None:
        result = run()
        assert result.returncode == 0, result.stderr
        census = artifact()
        assert census['residualOccurrences'] == 0
        assert census['leakingReadPaths'] == 0
        # The control, which is what separates "erased" from "the search was broken".
        assert census['controlOccurrences'] > 0
        assert census['controlReadPaths'] > 0

    def test_counts_every_row_the_two_erasure_calls_removed(self) -> None:
        result = run()
        assert result.returncode == 0, result.stderr
        census = artifact()
        # One deferred sentence (fact + card) and one released sentence (fact + release record): four
        # rows, and a count that would drop to three if either derived copy were left behind.
        assert census['removed']['deferred'] == {'facts': 1, 'cards': 1, 'releases': 0}
        assert census['removed']['released'] == {'facts': 1, 'cards': 0, 'releases': 1}
        assert census['removed']['total'] == 4

    def test_leaves_a_tombstone_and_a_record_and_nothing_else(self) -> None:
        result = run()
        assert result.returncode == 0, result.stderr
        census = artifact()
        # The card row survives as a tombstone so the export can count it; the two erasure records
        # survive as the deletion log. Neither carries wording, which is what the residual count says.
        assert census['tombstones'] == 1
        assert census['records'] == 2
        surfaces = {entry['role']: entry for entry in census['after']['surfaces']}
        assert surfaces['private-facts']['rows'] == 0
        assert surfaces['shared-facts']['rows'] == 0
        assert surfaces['erasures']['rows'] == 2
        for entry in census['after']['surfaces']:
            assert entry['secret'] == 0
            assert entry['health'] == 0


class TestFaultInjection:
    def test_a_skipped_erasure_fails_the_run(self) -> None:
        result = run('no-forget')
        assert result.returncode != 0, 'the guard did not fire on a skipped erasure'
        assert 'FAILED' in result.stderr
        census = artifact()
        assert census['residualOccurrences'] > 0
        assert census['leakingReadPaths'] > 0

    def test_the_artifact_is_restored_by_the_next_clean_run(self) -> None:
        assert run('no-forget').returncode != 0
        assert run().returncode == 0
        assert artifact()['residualOccurrences'] == 0
