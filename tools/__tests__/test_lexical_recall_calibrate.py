#!/usr/bin/env python3
"""Tests for `tools/lexical-recall-calibrate.py` -- the gate that the instrument is the path.

## What can be wrong without looking wrong

The tool compares a cheap run against an archived one. Every failure mode of *that* is a comparison
that agrees for a reason unrelated to the mechanism:

1. **it could agree vacuously** -- two empty rosters have identical carried counts;
2. **it could check one field and report three** -- `carried` agreeing while the delivered texts
   differ is an instrument that is not the path and a gate that says it is;
3. **it could compare a run to itself** -- the reference generated from the same artifact the
   comparison reads would pass on any artifact at all, including one whose scoring is the shipped
   one.

(1) is answered by the empty-roster test, (2) by the digest test, and (3) by the round trip: the
reference is written from one report and compared against a *different* one, so a tool that ignored
its `--reference` argument would fail.

Each test runs the tool as a subprocess, because the contract is the exit code and the message: a CI
job reads those two and nothing else.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOOL = REPO / 'tools' / 'lexical-recall-calibrate.py'

FINGERPRINT = 'sha256:the-corpus'


def question(
    qid: str,
    *,
    carried: int,
    total: int,
    capability: str = 'IE',
    texts: tuple[str, ...] = ('a turn',),
) -> dict:
    return {
        'questionId': qid,
        'capability': capability,
        'goldOverlap': {'carried': carried, 'total': total},
        'turns': [{'index': i, 'text': text} for i, text in enumerate(texts)],
    }


def report(*questions: dict, fingerprint: str = FINGERPRINT) -> dict:
    return {'datasetFingerprint': fingerprint, 'questions': list(questions)}


def marker(**overrides) -> dict:
    payload = {
        'instrument': 'deterministic-reader',
        'readerReply': 'offline instrument',
        'judgeVerdict': 'incorrect',
        'indexes': 2,
        'questions': 2,
        'runs': 1,
    }
    payload.update(overrides)
    return payload


def run(tmp_path: Path, *, report_payload: dict, reference_payload: dict, write_marker: bool = True):
    report_path = tmp_path / 'report.json'
    report_path.write_text(json.dumps(report_payload))
    reference_path = tmp_path / 'reference.json'
    reference_path.write_text(json.dumps(reference_payload))
    if write_marker:
        (tmp_path / 'offline-instrument.json').write_text(json.dumps(marker()))
    return subprocess.run(
        [
            sys.executable,
            str(TOOL),
            '--report',
            str(report_path),
            '--reference',
            str(reference_path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )


def reference_for(tmp_path: Path, payload: dict) -> dict:
    """Round-trip a report through `--write-reference`, so the digest is the tool's own."""
    report_path = tmp_path / 'source.json'
    report_path.write_text(json.dumps(payload))
    reference_path = tmp_path / 'written-reference.json'
    result = subprocess.run(
        [
            sys.executable,
            str(TOOL),
            '--report',
            str(report_path),
            '--reference',
            str(reference_path),
            '--write-reference',
            '--row',
            'S14',
            '--run',
            '43829744532',
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(reference_path.read_text())


def baseline() -> dict:
    return report(
        question('q1', carried=0, total=2, texts=('alpha', 'beta')),
        question('q2', carried=2, total=3, texts=('gamma',)),
    )


def test_agreement_passes(tmp_path: Path) -> None:
    payload = baseline()
    reference = reference_for(tmp_path, payload)
    result = run(tmp_path, report_payload=payload, reference_payload=reference)
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'the instrument IS the path' in result.stdout
    assert 'zero-recall      : reference 1, instrument 1' in result.stdout


def test_reference_round_trip_carries_the_row_and_run(tmp_path: Path) -> None:
    reference = reference_for(tmp_path, baseline())
    assert reference['row'] == 'S14'
    assert reference['run'] == '43829744532'
    assert reference['datasetFingerprint'] == FINGERPRINT
    # The digest is the field that makes "same turns" a claim rather than a count -- a reference
    # without it would compare the delivered *number* of turns and call it the path.
    assert reference['questions'][0]['deliveredDigest']
    assert reference['questions'][0]['delivered'] == 2


def test_carried_mismatch_fails_and_names_both_numbers(tmp_path: Path) -> None:
    reference = reference_for(tmp_path, baseline())
    changed = report(
        question('q1', carried=1, total=2, texts=('alpha', 'beta')),
        question('q2', carried=2, total=3, texts=('gamma',)),
    )
    result = run(tmp_path, report_payload=changed, reference_payload=reference)
    assert result.returncode == 1
    assert 'carry a different number of gold turns' in result.stdout
    assert 'q1 0->1' in result.stdout


def test_digest_mismatch_fails_even_when_every_count_agrees(tmp_path: Path) -> None:
    # The failure this test exists for: an instrument that delivers two turns of different text, and
    # therefore carries the same count of gold turns by coincidence. A gate that only compared
    # `carried` would publish "the instrument is the path" on a delivery that shares no text with it.
    reference = reference_for(tmp_path, baseline())
    changed = report(
        question('q1', carried=0, total=2, texts=('alpha', 'epsilon')),
        question('q2', carried=2, total=3, texts=('gamma',)),
    )
    result = run(tmp_path, report_payload=changed, reference_payload=reference)
    assert result.returncode == 1
    assert 'delivered different turn texts' in result.stdout
    assert 'q1' in result.stdout


def test_total_mismatch_is_its_own_failure(tmp_path: Path) -> None:
    reference = reference_for(tmp_path, baseline())
    changed = report(
        question('q1', carried=0, total=3, texts=('alpha', 'beta')),
        question('q2', carried=2, total=3, texts=('gamma',)),
    )
    result = run(tmp_path, report_payload=changed, reference_payload=reference)
    assert result.returncode == 1
    # A different denominator means the two runs read different instances under one id, which is a
    # dataset fault and not a scoring one. The message says which.
    assert "gold count" in result.stdout
    assert 'q1 2->3' in result.stdout


def test_roster_mismatch_fails(tmp_path: Path) -> None:
    reference = reference_for(tmp_path, baseline())
    shard = report(question('q1', carried=0, total=2, texts=('alpha', 'beta')))
    result = run(tmp_path, report_payload=shard, reference_payload=reference)
    assert result.returncode == 1
    assert 'roster differs' in result.stdout
    assert 'q2' in result.stdout


def test_dataset_fingerprint_mismatch_fails(tmp_path: Path) -> None:
    reference = reference_for(tmp_path, baseline())
    other = report(
        question('q1', carried=0, total=2, texts=('alpha', 'beta')),
        question('q2', carried=2, total=3, texts=('gamma',)),
        fingerprint='sha256:another-corpus',
    )
    result = run(tmp_path, report_payload=other, reference_payload=reference)
    assert result.returncode == 1
    assert 'dataset fingerprint differs' in result.stdout


def test_missing_marker_refuses_to_compare(tmp_path: Path) -> None:
    payload = baseline()
    reference = reference_for(tmp_path, payload)
    result = run(tmp_path, report_payload=payload, reference_payload=reference, write_marker=False)
    assert result.returncode != 0
    assert 'is not from the offline instrument' in result.stderr


def test_report_without_gold_overlap_is_refused(tmp_path: Path) -> None:
    broken = report({'questionId': 'q1', 'capability': 'IE', 'turns': []})
    reference = reference_for(tmp_path, baseline())
    result = run(tmp_path, report_payload=broken, reference_payload=reference)
    assert result.returncode != 0
    assert 'carries no goldOverlap' in result.stderr


def test_partial_report_with_no_roster_is_refused(tmp_path: Path) -> None:
    # A run that died has a `reached` count and no questions. Without this refusal the comparison
    # would report a total roster mismatch, which reads as "the instrument disagreed" rather than
    # "the run never finished".
    reference = reference_for(tmp_path, baseline())
    result = run(tmp_path, report_payload={'reached': 0, 'total': 2}, reference_payload=reference)
    assert result.returncode != 0
    assert 'carries no questions' in result.stderr


def test_zero_gold_question_is_bucketed_rather_than_divided_by_zero(tmp_path: Path) -> None:
    payload = report(question('q1', carried=0, total=0, texts=('alpha',)))
    reference = reference_for(tmp_path, payload)
    result = run(tmp_path, report_payload=payload, reference_payload=reference)
    assert result.returncode == 0, result.stdout + result.stderr
    assert "'no-gold': 1" in result.stdout
