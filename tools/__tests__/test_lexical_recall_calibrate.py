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
    delivered_chars: int | None = None,
) -> dict:
    payload = {
        'questionId': qid,
        'capability': capability,
        'goldOverlap': {'carried': carried, 'total': total},
        'turns': [{'index': i, 'text': text} for i, text in enumerate(texts)],
    }
    # Optional because it is: a record from before `promptChars` existed and a record whose delivery
    # carried no whole turn both have `turns: []`, and only one of them had zero characters delivered.
    if delivered_chars is not None:
        payload['promptChars'] = delivered_chars
    return payload


def report(*questions: dict, fingerprint: str = FINGERPRINT, config: dict | None = None) -> dict:
    payload: dict = {'datasetFingerprint': fingerprint, 'questions': list(questions)}
    if config is not None:
        payload['memoryArmConfig'] = config
    return payload


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


def run(
    tmp_path: Path,
    *,
    report_payload: dict,
    reference_payload: dict,
    write_marker: bool = True,
    extra: tuple[str, ...] = (),
):
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
            *extra,
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


# --------------------------------------------------------------------------------------------------
# `--candidate`: a report that is supposed to differ
# --------------------------------------------------------------------------------------------------
#
# The risk this mode carries is the opposite of the calibration's. A calibration gate that is too
# permissive publishes a candidate as if it were the path; a candidate mode that is too permissive
# publishes an *unattributed* difference -- another corpus, another roster, three settings at once --
# as a measurement of one mechanism. So these tests check the two things it must never do: accept a
# comparison it cannot attribute, and print the calibration's verdict.


def test_candidate_reports_the_delta_instead_of_refusing_it(tmp_path: Path) -> None:
    reference = reference_for(tmp_path, baseline())
    candidate = report(
        question('q1', carried=1, total=2, texts=('alpha',)),
        question('q2', carried=1, total=3, texts=('gamma',)),
    )
    result = run(
        tmp_path,
        report_payload=candidate,
        reference_payload=reference,
        extra=('--candidate', 'synthetic'),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '=== candidate: synthetic ===' in result.stdout
    assert 'questions changed : 1 gained, 1 lost, 0 unchanged' in result.stdout
    assert 'gold turns        : 2 -> 2' in result.stdout
    assert 'GAIN q1 0->1 of 2' in result.stdout
    assert 'LOSS q2 2->1 of 3' in result.stdout
    # The calibration's verdict is an equality claim and must never appear on a candidate.
    assert 'IS the path' not in result.stdout


def test_candidate_names_the_configuration_it_moved(tmp_path: Path) -> None:
    # A candidate that moved two settings is not a candidate for either mechanism, and the only place
    # that can be visible is the log of the run itself.
    reference = reference_for(
        tmp_path, report(question('q1', carried=0, total=1), config={'lexicalWeighting': 'flat'})
    )
    candidate = report(
        question('q1', carried=1, total=1),
        config={'lexicalWeighting': 'idf', 'maxTurnChars': 400},
    )
    result = run(
        tmp_path,
        report_payload=candidate,
        reference_payload=reference,
        extra=('--candidate', 'idf'),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'configuration    : 2 field(s) changed' in result.stdout
    assert 'lexicalWeighting: "flat" -> "idf"' in result.stdout
    assert 'maxTurnChars: "<absent>" -> 400' in result.stdout


def test_candidate_states_when_the_difference_is_in_code_rather_than_a_setting(tmp_path: Path) -> None:
    # The room's floor (`§13.379`) is a code change: the configuration is identical and the delivery is
    # not. Saying "unchanged" is what stops the reader from looking for a setting that does not exist.
    reference = reference_for(tmp_path, baseline())
    candidate = report(
        question('q1', carried=0, total=2, texts=('alpha',)),
        question('q2', carried=1, total=3, texts=('gamma',)),
    )
    result = run(
        tmp_path,
        report_payload=candidate,
        reference_payload=reference,
        extra=('--candidate', 'room-floor'),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'unchanged -- this candidate' in result.stdout


def test_candidate_refuses_another_corpus(tmp_path: Path) -> None:
    reference = reference_for(tmp_path, baseline())
    candidate = report(*baseline()['questions'], fingerprint='sha256:another-corpus')
    result = run(
        tmp_path,
        report_payload=candidate,
        reference_payload=reference,
        extra=('--candidate', 'wrong-corpus'),
    )
    assert result.returncode == 1
    assert 'this comparison is not valid' in result.stdout
    assert 'dataset fingerprint differs' in result.stdout


def test_candidate_marks_a_different_delivery_as_such(tmp_path: Path) -> None:
    # Identical gold counts and different texts is not "no effect": it is a different set of turns, and
    # the verdict has to say so rather than let the zero in `questions changed` be read as equality.
    reference = reference_for(tmp_path, baseline())
    candidate = report(
        question('q1', carried=0, total=2, texts=('alpha', 'gamma')),
        question('q2', carried=2, total=3, texts=('gamma',)),
    )
    result = run(
        tmp_path,
        report_payload=candidate,
        reference_payload=reference,
        extra=('--candidate', 'redelivered'),
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'evidence changed  : 1 question(s) delivered different turn texts' in result.stdout
    assert 'This is a different delivery' in result.stdout


def test_candidate_requires_a_label(tmp_path: Path) -> None:
    # An unnamed candidate is a diff nobody can attribute, and the argument is the only place the name
    # can live.
    reference = reference_for(tmp_path, baseline())
    result = run(
        tmp_path,
        report_payload=baseline(),
        reference_payload=reference,
        extra=('--candidate', '   '),
    )
    assert result.returncode != 0
    assert '--candidate needs a label' in result.stderr


def test_reference_records_the_configuration_a_candidate_is_diffed_against(tmp_path: Path) -> None:
    reference = reference_for(
        tmp_path,
        report(question('q1', carried=1, total=1), config={'lexicalWeighting': 'idf', 'selfIndex': {'indexes': 1}}),
    )
    assert reference['configuration']['lexicalWeighting'] == 'idf'
    # Censuses are counts taken after the questions were answered: a diff that included them would report
    # every candidate as having changed something.
    assert 'selfIndex' not in reference['configuration']


# --------------------------------------------------------------------------------------------------
# `expectedMoved`: a declared movement, checked in both directions
# --------------------------------------------------------------------------------------------------
#
# A repair to the product legitimately moves a delivery the reference recorded, and the reference may not
# be rewritten to agree with new code -- it is a record of a dispatched run. The declaration is the middle
# term, and it is only a gate if it fails **both** when something undeclared moves and when a declared
# thing stops moving.


def declared_reference(tmp_path: Path, moved: dict[str, str]) -> dict:
    reference = reference_for(tmp_path, baseline())
    reference['expectedMoved'] = moved
    return reference


def test_a_declared_movement_passes_and_is_printed(tmp_path: Path) -> None:
    reference = declared_reference(tmp_path, {'q1': 'the room floor, section 13.379.3'})
    candidate = report(
        question('q1', carried=0, total=2, texts=('alpha', 'moved')),
        question('q2', carried=2, total=3, texts=('gamma',)),
    )
    result = run(tmp_path, report_payload=candidate, reference_payload=reference)
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'MOVED (declared) : q1 carried 0->0, digest changed' in result.stdout
    assert 'apart from the delivery the reference declares as moved' in result.stdout


def test_an_undeclared_movement_still_fails(tmp_path: Path) -> None:
    # The declaration is per question, not a switch: a second question moving is exactly the event the
    # gate exists to catch.
    reference = declared_reference(tmp_path, {'q1': 'the room floor'})
    candidate = report(
        question('q1', carried=0, total=2, texts=('alpha', 'moved')),
        question('q2', carried=1, total=3, texts=('gamma',)),
    )
    result = run(tmp_path, report_payload=candidate, reference_payload=reference)
    assert result.returncode == 1
    assert '1 question(s) carry a different number of gold turns' in result.stdout


def test_a_declaration_that_stopped_moving_fails(tmp_path: Path) -> None:
    # A declaration outliving its cause is a gate vouching for something it no longer checks, and it is
    # indistinguishable from a correct run unless it is asserted -- so it is.
    reference = declared_reference(tmp_path, {'q1': 'a change that was reverted'})
    result = run(tmp_path, report_payload=baseline(), reference_payload=reference)
    assert result.returncode == 1
    assert 'declared question(s) did not move' in result.stdout


def test_a_declaration_cannot_cover_a_gold_count_change(tmp_path: Path) -> None:
    # `total` is the dataset's annotation. "This question's gold count changed on purpose" is not a claim
    # any product change can make, so the declaration deliberately does not reach it.
    reference = declared_reference(tmp_path, {'q1': 'anything'})
    candidate = report(
        question('q1', carried=0, total=5, texts=('alpha', 'beta')),
        question('q2', carried=2, total=3, texts=('gamma',)),
    )
    result = run(tmp_path, report_payload=candidate, reference_payload=reference)
    assert result.returncode == 1
    assert 'different gold count' in result.stdout


def test_regenerating_the_reference_keeps_its_declarations(tmp_path: Path) -> None:
    # `--write-reference` is the operation that must not silently drop the declaration: it rewrites the
    # file from an artifact, and the artifact knows nothing about why the code now differs.
    reference = declared_reference(tmp_path, {'q1': 'the room floor'})
    reference_path = tmp_path / 'reference.json'
    reference_path.write_text(json.dumps(reference))
    report_path = tmp_path / 'fresh-artifact.json'
    report_path.write_text(json.dumps(baseline()))
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
    assert json.loads(reference_path.read_text())['expectedMoved'] == {'q1': 'the room floor'}


# ## The blind spot these four tests exist for
#
# `carried` counts whole delivered turns and `deliveredDigest` hashes their texts, so a delivery that is
# **a clip of one turn** is indistinguishable from no delivery at all: both are `carried: 0` and the digest
# of the empty list. A gate built on those two fields therefore cannot see the one change the room's floor
# makes, and a run that changes nothing and a run that changed a clip print the same line. `promptChars` is
# the delivered evidence length and was in the artifact the whole time.


def test_a_clip_only_delivery_fails_the_calibration(tmp_path: Path) -> None:
    # Same gold account, same delivered turn texts, and a different delivery: 0 characters against 1,200.
    # This is the shape the room's floor produces, and the two fields the gate used to read agree on it.
    reference = reference_for(
        tmp_path,
        report(
            question('q1', carried=0, total=2, texts=(), delivered_chars=0),
            question('q2', carried=2, total=3, texts=('gamma',), delivered_chars=7),
        ),
    )
    clipped = report(
        question('q1', carried=0, total=2, texts=(), delivered_chars=1200),
        question('q2', carried=2, total=3, texts=('gamma',), delivered_chars=7),
    )
    result = run(tmp_path, report_payload=clipped, reference_payload=reference)
    assert result.returncode == 1, result.stdout + result.stderr
    assert 'delivered a different number of characters' in result.stdout
    assert 'q1' in result.stdout


def test_absent_character_counts_are_not_a_difference(tmp_path: Path) -> None:
    # Both records predate the field, or neither system reported it. Reporting that as a change would
    # make the gate fail on every old artifact, which is a gate that gets switched off.
    payload = baseline()
    reference = reference_for(tmp_path, payload)
    assert 'deliveredChars' not in reference['questions'][0]
    result = run(tmp_path, report_payload=payload, reference_payload=reference)
    assert result.returncode == 0, result.stdout + result.stderr


def test_a_declared_question_that_only_clipped_counts_as_moved(tmp_path: Path) -> None:
    # The declaration's second direction: a question declared as moved must be *seen* to move. A clip
    # moves `promptChars` and nothing else, so a check that read only the turn account would fail a
    # correctly declared repair -- and the next person would delete the declaration to get a green gate.
    reference = reference_for(
        tmp_path,
        report(
            question('q1', carried=0, total=2, texts=(), delivered_chars=0),
            question('q2', carried=2, total=3, texts=('gamma',), delivered_chars=7),
        ),
    )
    reference['expectedMoved'] = {'q1': 'the room floor -- the clip'}
    clipped = report(
        question('q1', carried=0, total=2, texts=(), delivered_chars=1200),
        question('q2', carried=2, total=3, texts=('gamma',), delivered_chars=7),
    )
    result = run(tmp_path, report_payload=clipped, reference_payload=reference)
    assert result.returncode == 0, result.stdout + result.stderr
    assert 'MOVED (declared)' in result.stdout
    assert 'promptChars 0->1200' in result.stdout


def test_a_candidate_reports_a_clip_as_a_character_change(tmp_path: Path) -> None:
    # A candidate's verdict is about comparability, so a clip is a reading rather than a failure -- but it
    # has to be printed, because "0 questions delivered different turn texts" was the line that made a
    # clip read as no change at all.
    reference = reference_for(
        tmp_path,
        report(
            question('q1', carried=0, total=2, texts=(), delivered_chars=0),
            question('q2', carried=2, total=3, texts=('gamma',), delivered_chars=7),
        ),
    )
    clipped = report(
        question('q1', carried=0, total=2, texts=(), delivered_chars=1200),
        question('q2', carried=2, total=3, texts=('gamma',), delivered_chars=7),
    )
    result = run(
        tmp_path, report_payload=clipped, reference_payload=reference, extra=('--candidate', 'room-floor')
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert '1 question(s) delivered a different number of characters' in result.stdout
    assert 'CLIP q1 0->1200' in result.stdout
