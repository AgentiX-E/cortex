#!/usr/bin/env python3
"""Is the offline instrument the same path as the dispatched run? Two modes, one arithmetic.

## Why this file exists

`CORTEX_ARM_OFFLINE=1` replaces the reader with a constant so that a change to lexical scoring can
be priced without buying five hundred answers. A cheap measurement is worth nothing unless it is the
*same* measurement, and "the same" is not a property the code can be read for: the delivered evidence
is the product's own output, so the only way to know the instrument reproduces the dispatched run is
to compare the two question by question.

That comparison is this file. The reference is the archived `S14` artifact (run `43829744532`), the
candidate is a fresh instrument report, and the gate is **equality per question** on three fields
that a scoring change must move together:

| field | what it proves |
| --- | --- |
| `total` | the gold annotation is the same population -- a different count is a different dataset |
| `carried` | the same gold turns survived the cut, which is what a scoring change is supposed to move |
| `deliveredDigest` | the reader was shown the same turn *texts*, not merely the same number of them |

A gate on `carried` alone would pass for an instrument that delivered entirely different turns and
happened to carry the same count of gold ones. A gate on the digest alone would pass for one that
delivered the same turns in a different order. Both are checked because they fail differently.

## The two modes

`--write-reference` reads an archived artifact and writes the digest. It exists so the reference is
reproducible rather than hand-maintained: a reader who distrusts `lexical-recall-reference.json` can
regenerate it from the artifact the row names and diff the two files.

The default mode compares a report against that digest and **exits nonzero when the instrument is
not the path**, which is what makes the calibration a gate in CI rather than a table in a log.

## What it refuses

1. **A report with no `offline-instrument.json` beside it.** An ordinary run also carries
   `goldOverlap`, and comparing one against the reference would report "the scoring changed" for a
   run whose scoring is the shipped one. The marker is the run's own statement of what it was.
2. **Two different datasets.** The corpus is served from a moving branch; equality of the fingerprint
   is the difference between "the instrument disagreed" and "the instrument measured another file".
3. **A roster that is not the reference's.** A shard, a filter or a `LIMIT` probe produces a report
   that is internally consistent and answers a different question.

Usage:
  python3 tools/lexical-recall-calibrate.py --report report.json [--marker offline-instrument.json]
  python3 tools/lexical-recall-calibrate.py --report artifact.json --write-reference \\
      --row S14 --run 43829744532
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

REFERENCE = Path(__file__).with_name('lexical-recall-reference.json')

# The bucket edges `docs/ANALYSIS-LEXICAL-ZERO-RECALL.md` tables, restated here rather than imported
# from `gold-recall-census.py`: the two answer different questions (that one describes where the gold
# went, this one decides whether an instrument is the path), and a shared constant would make one
# file's edit silently redefine the other's verdict.
BUCKETS: tuple[tuple[str, float, float], ...] = (
    ('0%', 0.0, 0.0),
    ('1-33%', 0.0, 1 / 3),
    ('34-66%', 1 / 3, 2 / 3),
    ('67-100%', 2 / 3, 1.0),
)


def digest_of(turns: list[str]) -> str:
    """A short digest over the delivered turn texts, in delivery order.

    Short on purpose: sixteen hex characters over five hundred lists is 8 KB, and a collision
    between two of those lists would require a changed delivery whose SHA-256 prefix agrees with the
    original's -- which is not a failure this gate needs to survive, because `carried` is compared
    beside it.
    """
    joined = '\x1f'.join(turns)
    return hashlib.sha256(joined.encode('utf-8')).hexdigest()[:16]


def gold_of(question: dict) -> dict:
    overlap = question.get('goldOverlap')
    if overlap is None:
        raise SystemExit(
            f'question {question.get("questionId")!r} carries no goldOverlap, so this artifact cannot '
            'answer where the gold went. A report without the census is not a candidate for the '
            'calibration -- it is a report from before the census existed, or from a configuration '
            'that measured no gold.'
        )
    turns = question.get('turns') or []
    return {
        'id': question['questionId'],
        'capability': question['capability'],
        'carried': overlap['carried'],
        'total': overlap['total'],
        'delivered': len(turns),
        'deliveredDigest': digest_of([turn['text'] for turn in turns]),
    }


def rows_of(report: dict) -> list[dict]:
    questions = report.get('questions')
    if not questions:
        raise SystemExit(
            'the report carries no questions, so there is nothing to compare. A partial artifact '
            'from a run that died mid-pass has an `reached` count and no roster.'
        )
    return [gold_of(question) for question in questions]


def write_reference(report: dict, row: str, run: str, path: Path) -> None:
    rows = rows_of(report)
    fingerprint = report.get('configurationFingerprint') or (
        report.get('memoryArmConfig') or {}
    ).get('configurationFingerprint')
    payload = {
        '$comment': (
            f'{row}. The per-question gold account of run {run}, as the reference the offline '
            'instrument is calibrated against. Regenerate with --write-reference from the artifact '
            'the row names, and diff: this file is a digest, not a reading, and it carries no '
            'accuracy because accuracy is not what the calibration compares.'
        ),
        'row': row,
        'run': run,
        'datasetFingerprint': report.get('datasetFingerprint'),
        # Omitted rather than null when the report does not carry one: this field is a convenience
        # for a human comparing two references, and `null` would read as "the run had no
        # configuration fingerprint" -- a claim about the run rather than about this digest.
        **({} if fingerprint is None else {'configurationFingerprint': fingerprint}),
        'questions': rows,
    }
    path.write_text(json.dumps(payload, indent=1) + '\n')
    buckets = Counter(bucket_of(row) for row in rows)
    zero = sum(1 for row in rows if row['carried'] == 0)
    print(f'wrote {path} ({len(rows)} questions)')
    print(f'zero-recall: {zero}  buckets: {dict(buckets)}')


def bucket_of(row: dict) -> str:
    if row['total'] == 0:
        return 'no-gold'
    share = row['carried'] / row['total']
    for name, low, high in BUCKETS:
        if name == '0%':
            if share == 0.0:
                return name
            continue
        if low < share <= high:
            return name
    return '67-100%'


def compare(report: dict, reference: dict, marker: dict) -> int:
    """Return an exit code: 0 when the instrument is the path, 1 when it is not."""
    failures: list[str] = []

    if report.get('datasetFingerprint') != reference.get('datasetFingerprint'):
        failures.append(
            'dataset fingerprint differs: the instrument graded '
            f'{report.get("datasetFingerprint")!r} against the reference\'s '
            f'{reference.get("datasetFingerprint")!r}. The corpus is served from a moving branch, so '
            'this is "another file was measured", not "the instrument disagreed".'
        )

    fresh = {row['id']: row for row in rows_of(report)}
    expected = {row['id']: row for row in reference['questions']}
    if set(fresh) != set(expected):
        missing = sorted(set(expected) - set(fresh))
        extra = sorted(set(fresh) - set(expected))
        failures.append(
            f'roster differs: {len(missing)} question(s) absent from the report (e.g. {missing[:5]}), '
            f'{len(extra)} not in the reference (e.g. {extra[:5]}). A shard or a filter answers a '
            'different question and its account cannot be compared with the whole.'
        )

    mismatched_total = [qid for qid in expected if qid in fresh and fresh[qid]['total'] != expected[qid]['total']]
    mismatched_carried = [
        qid for qid in expected if qid in fresh and fresh[qid]['carried'] != expected[qid]['carried']
    ]
    mismatched_digest = [
        qid
        for qid in expected
        if qid in fresh and fresh[qid]['deliveredDigest'] != expected[qid]['deliveredDigest']
    ]

    if mismatched_total:
        failures.append(
            f'{len(mismatched_total)} question(s) report a different gold count, e.g. '
            + ', '.join(
                f'{qid} {expected[qid]["total"]}->{fresh[qid]["total"]}' for qid in mismatched_total[:5]
            )
            + '. The gold annotation is the dataset\'s, so a difference means the two runs read '
            'different instances under the same id.'
        )
    if mismatched_carried:
        failures.append(
            f'{len(mismatched_carried)} question(s) carry a different number of gold turns, e.g. '
            + ', '.join(
                f'{qid} {expected[qid]["carried"]}->{fresh[qid]["carried"]}'
                for qid in mismatched_carried[:5]
            )
            + '. The instrument is then not reproducing the dispatched run\'s delivery, and every '
            'candidate it prices would be priced against a different baseline.'
        )
    if mismatched_digest:
        failures.append(
            f'{len(mismatched_digest)} question(s) delivered different turn texts, e.g. '
            + ', '.join(mismatched_digest[:5])
            + '. The counts agree and the evidence does not: a different corpus slice, a different '
            'room, or a rendering that changed while the gold account stayed put.'
        )

    zero_expected = sorted(qid for qid, row in expected.items() if row['carried'] == 0)
    zero_fresh = sorted(qid for qid, row in fresh.items() if row['carried'] == 0)

    print('=== calibration: offline instrument against S14 ===')
    print(f'reference        : {reference["row"]} / run {reference["run"]}')
    print(f'questions        : {len(fresh)} of {len(expected)}')
    print(f'severity of the reader: {marker.get("readerReply")!r}, verdict {marker.get("judgeVerdict")!r}')
    print(f'indexes built    : {marker.get("indexes")} over {marker.get("questions")} x {marker.get("runs")}')
    print(f'zero-recall      : reference {len(zero_expected)}, instrument {len(zero_fresh)}')
    print(f'buckets (ref)    : {dict(Counter(bucket_of(row) for row in expected.values()))}')
    print(f'buckets (inst)   : {dict(Counter(bucket_of(row) for row in fresh.values()))}')

    if not failures:
        print('VERDICT: the instrument IS the path -- carried, total and delivered texts agree on every question.')
        return 0

    print('VERDICT: the instrument is NOT the path. Each line below is a different way to be wrong.')
    for failure in failures:
        print(f'  FAIL {failure}')
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(add_help=True)
    parser.add_argument('--report', required=True, type=Path)
    parser.add_argument(
        '--marker',
        type=Path,
        default=None,
        help='offline-instrument.json written beside the report (default: that name in its directory)',
    )
    parser.add_argument('--reference', type=Path, default=REFERENCE)
    parser.add_argument('--write-reference', action='store_true')
    parser.add_argument('--row', default='S14')
    parser.add_argument('--run', default='')
    args = parser.parse_args()

    report = json.loads(args.report.read_text())
    if args.write_reference:
        write_reference(report, args.row, args.run, args.reference)
        return 0

    marker = args.marker or args.report.parent / 'offline-instrument.json'
    if not marker.exists():
        raise SystemExit(
            f'{marker} is absent, so this report is not from the offline instrument. An ordinary run '
            'carries goldOverlap too, and comparing it here would report "the scoring moved" for a '
            'run whose scoring is the shipped one.'
        )
    reference = json.loads(args.reference.read_text())
    return compare(report, reference, json.loads(marker.read_text()))


if __name__ == '__main__':
    sys.exit(main())
