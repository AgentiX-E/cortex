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

## Why the runs write to a temporary directory, and what that fixes

They used to write the tracked artifact, one after the other, with the clean run last so the file ended up
correct. That made `pnpm check` a **writer into another repository**: three rounds of commits carried a
re-timing nobody had asked for (0.11 → 0.13), because the gate ran the tool and the tool rewrote a tracked
file whose value depends on machine load. The tool now prints its census and writes only when given
`--out` -- which is what `pnpm corpus:census:write` passes -- so these tests pass `--out` into `tmp_path`
and the suite reads the same numbers without touching the tree.

Two tests are the mechanism that keeps that honest: `TestTheGateIsNotAWriter` runs the bare tool and hashes
the tracked file before and after, and `TestTheCommittedArtifact` holds the committed file to the same
clause -- so a stale artifact fails the build rather than ageing quietly, and the gate still proves what it
is for.

## Why 10^5 turns in a test suite

Because the ratio is the whole point and it is not scale-free: on a ten-turn corpus both arms are
microseconds and the comparison is noise. The suite pays about fifty seconds for the honest size, which is
the same trade `test_erasure_census.py` makes for runtime over a synthetic store.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'corpus-read-census.mjs'
ARTIFACT = REPO.parent / 'cortex-docs' / 'evidence' / 'corpus' / 'read-cost.json'


def run(fault: str | None = None, out: Path | None = None) -> subprocess.CompletedProcess[str]:
    environment = dict(os.environ)
    environment.pop('CORTEX_CORPUS_READ_CENSUS_FAULT', None)
    if fault is not None:
        environment['CORTEX_CORPUS_READ_CENSUS_FAULT'] = fault
    command = ['node', str(TOOL)]
    if out is not None:
        command += ['--out', str(out)]
    return subprocess.run(
        command,
        cwd=REPO,
        capture_output=True,
        text=True,
        env=environment,
        check=False,
    )


def artifact() -> dict:
    return json.loads(ARTIFACT.read_text(encoding='utf-8'))


def digest() -> str | None:
    """The tracked artifact's hash, or `None` when this checkout does not have the other repository.

    `cortex`'s CI checks out `cortex` alone; the evidence lives in `cortex-docs`. The previous version of
    this file could not notice because it only ever **wrote** that path -- `mkdirSync` created the
    directory tree, and `writeFileSync` made a file inside a repository that was not in the runner. So a
    gate "passed" in CI by producing evidence for a checkout nobody could read.
    """
    return None if not ARTIFACT.exists() else hashlib.sha256(ARTIFACT.read_bytes()).hexdigest()


@pytest.fixture(scope='module')
def readings(tmp_path_factory) -> dict[str, dict]:
    """Both runs, taken once each, into a directory of their own.

    A clean run here costs about fifteen seconds -- ten to the five turns in a real file, three times over
    for the estimator -- so a fixture rather than one call per assertion. Neither run touches the tracked
    artifact: the paths are handed to the tool, which is the change these tests were rewritten for.
    """
    directory = tmp_path_factory.mktemp('corpus-census')
    faulted_out = directory / 'faulted.json'
    clean_out = directory / 'clean.json'
    faulted = run('slow-read', faulted_out)
    clean = run(None, clean_out)
    return {
        'faulted': {
            'process': faulted,
            'census': json.loads(faulted_out.read_text(encoding='utf-8')),
        },
        'clean': {
            'process': clean,
            'census': json.loads(clean_out.read_text(encoding='utf-8')),
        },
    }


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

    def test_says_where_it_wrote(self, readings) -> None:
        # The path is printed rather than implied, because "which file did this run produce" is the question
        # the previous form answered wrongly: it produced one nobody had named.
        assert 'wrote ' in readings['clean']['process'].stdout


class TestFaultInjection:
    def test_a_dominating_read_fails_the_clause(self, readings) -> None:
        result = readings['faulted']['process']
        assert result.returncode != 0, 'the clause did not fire on a read that dominated assembly'
        assert 'FAILED' in result.stderr
        census = readings['faulted']['census']
        # The fault is a real cost -- the scan ran twenty-five times -- so the census is a measurement of a
        # slower read and not a number the tool wrote down.
        assert census['fault'] == 'slow-read'
        assert census['ratio'] > 2.0

    def test_the_two_runs_are_different_files(self, readings) -> None:
        # The ordering rule the old fixture needed -- faulted first, clean last -- existed because both runs
        # wrote one path. Two paths means a faulted run cannot leave a faulted reading behind for a gate.
        assert readings['faulted']['census']['fault'] == 'slow-read'
        assert readings['clean']['census']['fault'] is None


class TestTheGateIsNotAWriter:
    def test_a_bare_run_prints_the_census_and_leaves_the_tracked_file_alone(self) -> None:
        # This is the defect the change fixes, asserted as a property rather than described in a comment:
        # `pnpm check` runs the tool, the tool used to rewrite a tracked file in another repository, and the
        # value it wrote depends on what else the machine was doing.
        #
        # Both branches assert the same property. When the sibling repository is checked out the file must be
        # byte-identical afterwards; when it is not -- `cortex`'s CI checks out one repository -- the file
        # must still not exist, which is the stronger statement of the same rule and the one the old tool
        # would have failed by creating it.
        before = digest()
        done = run()
        assert done.returncode == 0, done.stderr
        assert digest() == before, (
            f'{ARTIFACT} changed when the tool was run without --out. A gate that rewrites a tracked '
            'measurement makes every later diff unreliable and attributes a re-timing to whatever commit '
            'happened to be next.'
        )
        # It still measured: the stdout carries the same object the file would have held.
        printed = json.loads(done.stdout[done.stdout.index('{') :])
        assert printed['ratio'] <= 2.0
        assert printed['dataset'].startswith('100000 turns')

    def test_out_refuses_to_run_without_a_path(self) -> None:
        # `--out` with nothing after it must not fall back to the tracked path: an unparsed flag that
        # quietly wrote the old destination would reintroduce exactly the write this change removes.
        done = run(out=Path('--'))
        assert done.returncode != 0
        assert '--out needs a path' in done.stderr


@pytest.mark.skipif(
    not ARTIFACT.exists(),
    reason=(
        'the evidence lives in the sibling `cortex-docs` checkout, and this repository\'s CI checks out '
        '`cortex` alone; a test that required it here would fail for the checkout shape rather than for a '
        'defect'
    ),
)
class TestTheCommittedArtifact:
    def test_the_committed_reading_is_the_clean_one_and_still_inside_the_clause(self) -> None:
        # The evidence a reader cites. Held to the clause here rather than trusted: an artifact recorded
        # months ago is a measurement of an older prompt builder, and this is the cheapest place to notice.
        committed = artifact()
        assert committed['fault'] is None
        assert committed['ratio'] <= 2.0
        assert committed['readMs'] > 0
        assert committed['assembleMs'] > 0
        assert committed['dataset'].startswith('100000 turns')

    def test_the_committed_reading_was_taken_at_the_registered_room(self) -> None:
        assert artifact()['room'] == 48_000
