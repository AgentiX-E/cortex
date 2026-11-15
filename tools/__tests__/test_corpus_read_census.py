#!/usr/bin/env python3
"""Tests for `tools/corpus-read-census.mjs` -- the reading behind the `askStored` design.

## What is being defended

`Corpus` reads the whole transcript per question, so `askStored()` is O(corpus). The design accepted that on
one argument: `answerSessions` **already** walks every turn it is given, so the scan is a constant factor on
work that was already happening. The registered falsifiable clause is `read / assemble <= 2.0`, and the
fallback if it fails is to withdraw `askStored` and keep `remember` alone.

A reading with no failure path proves nothing, so the tool accepts a fault that makes the scan genuinely
slower (it runs it twenty-five times) rather than multiplying a number. The two runs assert both directions:

| Run | Must report |
| --- | --- |
| clean | exit 0, `ratio <= 2.0`, `turns == 100_000`, a positive read and assembly time |
| slow read | exit 1, `FAILED`, and a ratio above the clause |

The clean run is executed **last**, because the tool writes the artifact the round's report cites.

## Why 10^5 turns in a test suite

Because the ratio is the whole point and it is not scale-free: on a ten-turn corpus both arms are
microseconds and the comparison is noise. The suite pays about fifteen seconds for the honest size, which is
the same trade `test_erasure_census.py` makes for runtime over a synthetic store.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'corpus-read-census.mjs'
ARTIFACT = REPO.parent / 'cortex-docs' / 'evidence' / 'corpus' / 'read-cost.json'


def run(fault: str | None = None) -> subprocess.CompletedProcess[str]:
    environment = dict(os.environ)
    environment.pop('CORTEX_CORPUS_READ_CENSUS_FAULT', None)
    if fault is not None:
        environment['CORTEX_CORPUS_READ_CENSUS_FAULT'] = fault
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


@pytest.fixture(scope='module')
def readings() -> dict[str, dict]:
    """Both runs, taken once each, in the order the artifact has to end up in.

    A clean run here costs about ten seconds -- ten to the five turns in a real file, twice over -- so a
    fixture rather than one call per assertion. The faulted run goes **first** so that the committed artifact
    is the clean one, which is the same ordering rule `test_erasure_census.py` follows and for the same
    reason: a suite that left a faulted reading behind would fail every later gate in the chain.
    """
    faulted = run('slow-read')
    faulted_census = artifact()
    clean = run()
    return {'faulted': {'process': faulted, 'census': faulted_census}, 'clean': {'process': clean, 'census': artifact()}}


class TestCleanRun:
    def test_the_read_is_a_fraction_of_the_work_the_answer_path_already_did(self, readings) -> None:
        result = readings['clean']['process']
        assert result.returncode == 0, result.stderr
        census = readings['clean']['census']
        assert census['fault'] is None
        # The clause. Not "less than" in the abstract: the registered threshold, in the artifact.
        assert census['ratio'] <= 2.0
        # A ratio is only a reading if both halves did work: a zero assembly time would make it infinite and a
        # zero read time would make it zero, and neither would be a measurement.
        assert census['readMs'] > 0
        assert census['assembleMs'] > 0
        # And the stored path is the two together, which is what makes the ratio a decomposition rather than a
        # comparison of three unrelated numbers.
        assert census['storedMs'] >= census['assembleMs']

    def test_measures_the_size_it_claims(self, readings) -> None:
        census = readings['clean']['census']
        assert census['dataset'].startswith('100000 turns')
        assert census['room'] == 48_000

    def test_records_the_ratio_as_read_over_assemble(self, readings) -> None:
        census = readings['clean']['census']
        recomputed = census['readMs'] / census['assembleMs']
        assert abs(recomputed - census['ratio']) < 0.02


class TestFaultInjection:
    def test_a_dominating_read_fails_the_clause(self, readings) -> None:
        result = readings['faulted']['process']
        assert result.returncode != 0, 'the clause did not fire on a read that dominated assembly'
        assert 'FAILED' in result.stderr
        census = readings['faulted']['census']
        # The fault is a real cost -- the scan ran twenty-five times -- so the artifact's ratio is a
        # measurement of a slower read and not a number the tool wrote down.
        assert census['fault'] == 'slow-read'
        assert census['ratio'] > 2.0

    def test_the_artifact_is_restored_by_the_next_clean_run(self, readings) -> None:
        assert readings['faulted']['census']['fault'] == 'slow-read'
        assert readings['clean']['census']['fault'] is None
