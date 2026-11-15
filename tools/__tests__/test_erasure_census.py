#!/usr/bin/env python3
"""Tests for `tools/erasure-census.mjs` -- the check that decides whether an erasure was complete.

## The defect this file is written against

An erasure test that asserts "the row is gone" measures the copy nobody doubted. AfterDeleteBench
(arXiv:2610.31366) recovers a deleted secret in 68% of cases because a *derived* copy survived, and
the same shape is available here: the card holds the sentence and the turns around it, the release
record holds the wording and its digest. `erasure-census.mjs` therefore counts occurrences across
**every row of every table in both stores**, before and after, and the before-reading is a control.

## Why its guards are exercised rather than trusted

A guard that has only been observed passing may be evaluating nothing. The tool accepts two faults, and
this file asserts the exit code of each run:

| Run | Must report |
| --- | --- |
| clean | exit 0, `residualOccurrences == 0`, `controlOccurrences > 0` |
| one erasure skipped | exit 1, `FAILED`, and the artifact says how much survived |
| no vector eraser (the shipped configuration until the round before last) | exit 1, `FAILED`, rows clean and the cache still holding both sentences |
| no transcript eraser (the composition mistake) | exit 1, `FAILED`, rows and read paths clean and the corpus still holding both sentences |

The last two faults are the interesting ones, because neither is a contrivance: both are configurations
this product shipped. In each, the rows are all erased and every enumerated read path is closed, so an
artifact that measured only the tables would report a complete erasure while the sentence was still in a
store it did not enumerate. That is the shape AfterDeleteBench measures at 68%, reproduced here as a
composition rather than as a mistake.

The clean run is executed **last** on purpose: the tool writes the artifact the acceptance matrix
reads, so a test that left a faulted reading in place would fail every later gate in the chain.
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
        assert census['removed']['deferred'] == {
            'facts': 1,
            'cards': 1,
            'releases': 0,
            'vectors': 1,
            'turns': 1,
        }
        assert census['removed']['released'] == {
            'facts': 1,
            'cards': 0,
            'releases': 1,
            'vectors': 1,
            'turns': 1,
        }
        assert census['removed']['total'] == 4
        # The seventh surface, counted separately from the rows because it is not one: one cached vector
        # per sentence, both erased. This is the number that would have read `0` while two vectors were
        # still answering `get(keyOf(text))` before the store had a `delete`.
        assert census['removed']['vectors'] == 2
        # And the eighth: one transcript turn per sentence. Separate from the rows for the same reason --
        # a turn is not a row of a table the boundary owns, it is the sentence again in a store the
        # boundary has to be told about.
        assert census['removed']['turns'] == 2

    def test_reads_eight_surfaces_and_the_key_list_carries_no_wording(self) -> None:
        result = run()
        assert result.returncode == 0, result.stderr
        census = artifact()
        assert census['surfaces'] == 8
        roles = [entry['role'] for entry in census['before']['surfaces']]
        assert roles == [
            'private-facts',
            'shared-facts',
            'cards',
            'releases',
            'erasures',
            'corpus-turns',
            'embedding-keys',
            'embedding-vectors',
        ]
        # A key is a digest, so the wording is absent from the key list *before* the erasure too -- the
        # design, not the deletion. Non-vacuous because entries existed: the guard in the tool refuses a
        # run where the cache was empty, and this asserts the reading it guards.
        assert census['keySurface']['rowsBefore'] == 3
        assert census['keySurface']['wordingBefore'] == 0
        assert census['keySurface']['wordingAfter'] == 0
        # The control on the cache: a sentence that was never erased keeps its vector, so a session that
        # cleared the whole store would not pass.
        assert census['survivor']['cached'] == 1
        # The same control on the transcript: the survivor's turn is still there, so an erasure that
        # emptied the corpus would fail here rather than pass every zero above.
        assert census['survivor']['turns'] == 1
        surfaces = {entry['role']: entry for entry in census['after']['surfaces']}
        assert surfaces['corpus-turns']['secret'] == 0
        assert surfaces['corpus-turns']['health'] == 0

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

    def test_a_session_with_no_eraser_fails_the_run(self) -> None:
        # The most valuable fault in this file, because it is not a contrivance: it is the configuration the
        # product shipped until this round -- two stores, no vector eraser. The rows are all erased and the
        # read paths are all closed, so every other reading in this artifact says the erasure worked.
        result = run('no-vector-forget')
        assert result.returncode != 0, 'the guard did not fire when the cache kept the vectors'
        assert 'FAILED' in result.stderr
        census = artifact()
        assert census['residualOccurrences'] > 0
        assert census['leakingReadPaths'] == 0
        vectors = {entry['role']: entry for entry in census['after']['surfaces']}['embedding-vectors']
        assert vectors['secret'] == 1
        assert vectors['health'] == 1

    def test_a_session_that_was_never_given_the_transcript_fails_the_run(self) -> None:
        # The composition mistake, and the reason this surface exists at all: the corpus is present, the
        # session is built over the same deployment, and the object is not passed across. Every row is gone
        # and every read path the boundary knows about is closed -- so `leakingReadPaths == 0` while two
        # sentences are still readable in the transcript.
        result = run('no-turn-forget')
        assert result.returncode != 0, 'the guard did not fire when the corpus kept the turns'
        assert 'FAILED' in result.stderr
        census = artifact()
        assert census['residualOccurrences'] == 2
        assert census['leakingReadPaths'] == 0
        turns = {entry['role']: entry for entry in census['after']['surfaces']}['corpus-turns']
        assert turns['secret'] == 1
        assert turns['health'] == 1

    def test_the_artifact_is_restored_by_the_next_clean_run(self) -> None:
        assert run('no-forget').returncode != 0
        assert run().returncode == 0
        assert artifact()['residualOccurrences'] == 0
