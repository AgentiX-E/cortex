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

## The three modes

`--write-reference` reads an archived artifact and writes the digest. It exists so the reference is
reproducible rather than hand-maintained: a reader who distrusts `lexical-recall-reference.json` can
regenerate it from the artifact the row names and diff the two files.

The default mode compares a report against that digest and **exits nonzero when the instrument is
not the path**, which is what makes the calibration a gate in CI rather than a table in a log.

`--candidate LABEL` reads a report that is *supposed* to differ -- a scoring change priced offline --
and reports the difference instead of refusing it. The distinction is the whole point: equality is the
claim for a calibration run and the wrong claim for a candidate, and a tool with one mode would either
refuse every candidate or accept every calibration drift. A candidate run still has to be comparable,
so the dataset, the roster and the configuration are checked exactly as they are in the other mode, and
the configuration **difference** is printed field by field -- a candidate that moved three things at
once is visible in its own log rather than in a later post-mortem.

## What it refuses

1. **A report with no `offline-instrument.json` beside it.** An ordinary run also carries
   `goldOverlap`, and comparing one against the reference would report "the scoring changed" for a
   run whose scoring is the shipped one. The marker is the run's own statement of what it was.
2. **Two different datasets.** The corpus is served from a moving branch; equality of the fingerprint
   is the difference between "the instrument disagreed" and "the instrument measured another file".
3. **A roster that is not the reference's.** A shard, a filter or a `LIMIT` probe produces a report
   that is internally consistent and answers a different question.
4. **A movement the reference did not declare.** A repair to the product can legitimately move a
   delivery the reference recorded, and the reference may not be rewritten to agree with new code -- it
   is a record of a dispatched run. `expectedMoved` names the question and the section that moved it, and
   the declaration is checked in both directions: an undeclared movement fails, and a declaration whose
   movement stopped happening fails too, because a gate that outlives its cause is no longer checking it.
   It deliberately cannot cover `total`: the gold annotation is the dataset's.
5. **A candidate that did not say which axis it intends to move.** `--expects-change` is required with
   `--candidate`: `turns` (the whole-turn account: `carried` and the delivered texts), `chars` (the
   delivered length), both, `none` (the delivery stands still -- a testable hypothesis) or `any` (no
   prediction, stated as such). The prediction is compared with the observed movement in both
   directions, because a run that moved an axis nobody named has a cause nobody named: §13.380's clip
   moved 23,503 characters under a candidate that would have declared `turns`.

Usage:
  python3 tools/lexical-recall-calibrate.py --report report.json [--marker offline-instrument.json]
  python3 tools/lexical-recall-calibrate.py --report report.json --candidate idf --expects-change turns,chars
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

# The two axes a delivery can move on. They are separate because a clip moves one and not the other, and
# ordered because a log line that reads `chars,turns` in one run and `turns,chars` in the next is two
# spellings of one reading -- the kind of gratuitous difference a diff-based review learns to ignore.
DELIVERY_AXES: tuple[str, ...] = ('turns', 'chars')


def read_expected_axes(value: str) -> frozenset[str] | None:
    """Parse `--expects-change`, refusing anything it does not recognise **by name**.

    `none` is the empty set and `any` is `None`, and they are not the same value: the first is a
    prediction that the delivery stands still, the second is the refusal to make one. A candidate that
    predicted silence and a candidate that predicted nothing are read differently, and a typo must not
    be able to turn the first into the second.
    """
    wanted = value.strip().lower()
    if wanted == 'any':
        return None
    if wanted == 'none':
        return frozenset()
    named = [part.strip() for part in wanted.split(',') if part.strip()]
    unknown = [part for part in named if part not in DELIVERY_AXES]
    if unknown or not named:
        raise SystemExit(
            f'--expects-change {json.dumps(value)} is not a prediction: '
            f'{", ".join(json.dumps(part) for part in unknown) or "an empty list"} is not one of '
            f'{", ".join(json.dumps(axis) for axis in DELIVERY_AXES)}. The two statements that are not '
            'lists of axes are "none" (the delivery stands still) and "any" (no prediction). A '
            'misspelled axis must not be read as "any".'
        )
    return frozenset(named)


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
    row = {
        'id': question['questionId'],
        'capability': question['capability'],
        'carried': overlap['carried'],
        'total': overlap['total'],
        'delivered': len(turns),
        'deliveredDigest': digest_of([turn['text'] for turn in turns]),
    }
    # The one quantity `carried` and the digest cannot see. Both are whole-turn shaped -- a count of gold
    # turns and a hash over the delivered texts -- so a delivery that is **a clip of one turn** reads as
    # no delivery at all: `carried: 0` and the digest of the empty list. That is not a hypothetical shape;
    # it is the shape the room's floor produces (`§13.380`), and the candidate that carried it printed
    # `0 question(s) delivered different turn texts` while delivering one. `promptChars` is the delivered
    # evidence length, it was in the artifact the whole time, and it is what makes "a clip" and "nothing"
    # two different rows.
    if isinstance(question.get('promptChars'), int):
        row['deliveredChars'] = question['promptChars']
    return row


def rows_of(report: dict) -> list[dict]:
    questions = report.get('questions')
    if not questions:
        raise SystemExit(
            'the report carries no questions, so there is nothing to compare. A partial artifact '
            'from a run that died mid-pass has an `reached` count and no roster.'
        )
    return [gold_of(question) for question in questions]


# The configuration fields that are **census** rather than configuration: they are counts taken after
# the questions were answered, so two runs of one configuration disagree in them and a diff would report
# them as changes. `tools/arm-config-record.py` keeps the same partition for the same reason; the two
# lists are not imported from each other because that module's partition is a claim about the artifact
# schema and this one is a claim about what a *diff* means.
CENSUS_FIELDS = frozenset(
    {'selfIndex', 'admission', 'voteCounts', 'queryExpansionCounts', 'configurationFingerprint'}
)

# Fields whose absence in an archived artifact has exactly one meaning, restated rather than inferred:
# `lexicalWeighting` did not exist before §13.379, and its only other value (`idf`) did not either, so a
# report without the field ranked flat. Normalising it here keeps a candidate's diff to the field it
# moved instead of reporting "absent -> idf" as if the reference had used something else.
DEFAULTS_WHEN_ABSENT = {'lexicalWeighting': 'flat'}


def configuration_of(report: dict) -> dict:
    """The run's configuration, without its censuses, with archived absences normalised."""
    config = dict(report.get('memoryArmConfig') or {})
    for key, default in DEFAULTS_WHEN_ABSENT.items():
        config.setdefault(key, default)
    return {key: value for key, value in config.items() if key not in CENSUS_FIELDS}


def write_reference(report: dict, row: str, run: str, path: Path) -> None:
    rows = rows_of(report)
    existing_moved = {}
    if path.exists():
        existing_moved = json.loads(path.read_text()).get('expectedMoved') or {}
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
        # The whole configuration, so a candidate can be diffed against what produced the reference
        # rather than against a reader's memory of it. `--candidate` is the consumer.
        'configuration': configuration_of(report),
        # Carried over rather than regenerated: a declaration is a fact about why the *current* code
        # differs from this record, and re-deriving the record is exactly the operation that must not
        # silently drop it. Regenerating from another row would be a different file at a different path.
        **({} if not existing_moved else {'expectedMoved': existing_moved}),
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


def comparability_failures(
    report: dict, reference: dict, fresh: dict, expected: dict
) -> list[str]:
    """The checks both modes share: same corpus, same roster.

    Separate from the verdict because the two modes disagree about what a *difference* means and agree
    about what makes a comparison meaningless: a report of another dataset or of a shard is not a
    reading of this mechanism, whichever question the caller asked.
    """
    failures: list[str] = []
    if report.get('datasetFingerprint') != reference.get('datasetFingerprint'):
        failures.append(
            'dataset fingerprint differs: the instrument graded '
            f'{report.get("datasetFingerprint")!r} against the reference\'s '
            f'{reference.get("datasetFingerprint")!r}. The corpus is served from a moving branch, so '
            'this is "another file was measured", not "the instrument disagreed".'
        )
    if set(fresh) != set(expected):
        missing = sorted(set(expected) - set(fresh))
        extra = sorted(set(fresh) - set(expected))
        failures.append(
            f'roster differs: {len(missing)} question(s) absent from the report (e.g. {missing[:5]}), '
            f'{len(extra)} not in the reference (e.g. {extra[:5]}). A shard or a filter answers a '
            'different question and its account cannot be compared with the whole.'
        )
    return failures


def compare(report: dict, reference: dict, marker: dict) -> int:
    """Return an exit code: 0 when the instrument is the path, 1 when it is not."""
    fresh = {row['id']: row for row in rows_of(report)}
    expected = {row['id']: row for row in reference['questions']}
    failures = comparability_failures(report, reference, fresh, expected)

    # §13.379.3. A repair to the product legitimately moves a delivery the reference recorded, and the
    # reference is a record of a dispatched run -- it may not be rewritten to agree with new code. So a
    # question whose delivery moved **on purpose** is declared in the reference with the section that
    # moved it, and the gate checks the declaration in both directions: an undeclared movement fails, and
    # so does a declaration whose movement did not happen. A declaration that outlives its cause is a
    # gate that has stopped checking the thing it named.
    declared = reference.get('expectedMoved') or {}
    mismatched_total = [
        qid for qid in expected if qid in fresh and fresh[qid]['total'] != expected[qid]['total']
    ]
    mismatched_carried = [
        qid
        for qid in expected
        if qid in fresh and fresh[qid]['carried'] != expected[qid]['carried'] and qid not in declared
    ]
    mismatched_digest = [
        qid
        for qid in expected
        if qid in fresh
        and fresh[qid]['deliveredDigest'] != expected[qid]['deliveredDigest']
        and qid not in declared
    ]
    # Only where both records carry the field: a reference written before it existed is not evidence that
    # its run delivered zero characters, and a gate that failed on that would be switched off.
    mismatched_chars = [
        qid
        for qid in expected
        if qid in fresh
        and 'deliveredChars' in expected[qid]
        and 'deliveredChars' in fresh[qid]
        and fresh[qid]['deliveredChars'] != expected[qid]['deliveredChars']
        and qid not in declared
    ]
    # A declaration covers `carried`, the delivered texts and the delivered length, never `total`: the gold
    # annotation is the dataset's, so "this question's gold count changed on purpose" is not a claim any
    # product change can make. It stays fatal above. `deliveredChars` is in the list because a clip moves
    # it and nothing else -- leaving it out would fail a correctly declared repair.
    still_moved = [
        qid
        for qid in declared
        if qid in fresh
        and fresh[qid]['carried'] == expected[qid]['carried']
        and fresh[qid]['deliveredDigest'] == expected[qid]['deliveredDigest']
        and (
            'deliveredChars' not in expected[qid]
            or 'deliveredChars' not in fresh[qid]
            or fresh[qid]['deliveredChars'] == expected[qid]['deliveredChars']
        )
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
    if mismatched_chars:
        failures.append(
            f'{len(mismatched_chars)} question(s) delivered a different number of characters, e.g. '
            + ', '.join(
                f'{qid} {expected[qid]["deliveredChars"]}->{fresh[qid]["deliveredChars"]}'
                for qid in mismatched_chars[:5]
            )
            + '. The turn account cannot see this: a clip of one turn and no delivery at all are both '
            '`carried: 0` with the digest of an empty list, so the two agree on the two fields that '
            'look like the delivery. The character count is the third.'
        )

    if still_moved:
        failures.append(
            f'{len(still_moved)} declared question(s) did not move: {still_moved[:5]}. The reference says '
            'a section changed this delivery and the delivery is the reference\'s -- so either the '
            'section was reverted, or the declaration was written before the change reached the code. '
            'Either way the gate is now vouching for something it is not checking.'
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
    for qid, reason in declared.items():
        if qid not in fresh:
            continue
        # The character count is printed only when it moved, because that is the case the turn account
        # reports as `same` -- a clip is exactly a delivery whose turns and digest agree with a run that
        # delivered nothing.
        chars = ''
        if (
            'deliveredChars' in expected[qid]
            and 'deliveredChars' in fresh[qid]
            and fresh[qid]['deliveredChars'] != expected[qid]['deliveredChars']
        ):
            chars = f', promptChars {expected[qid]["deliveredChars"]}->{fresh[qid]["deliveredChars"]}'
        print(
            f'MOVED (declared) : {qid} carried {expected[qid]["carried"]}->{fresh[qid]["carried"]}, '
            f'digest {"same" if fresh[qid]["deliveredDigest"] == expected[qid]["deliveredDigest"] else "changed"}'
            f'{chars}'
            f' -- {reason}'
        )

    if not failures:
        print(
            'VERDICT: the instrument IS the path -- carried, total and delivered texts agree on every '
            'question' + (', apart from the delivery the reference declares as moved.' if declared else '.')
        )
        return 0

    print('VERDICT: the instrument is NOT the path. Each line below is a different way to be wrong.')
    for failure in failures:
        print(f'  FAIL {failure}')
    return 1


def capability_account(expected: dict, fresh: dict) -> str:
    """One line, one entry per capability, because a registered criterion can be about a subset.

    `PREREGISTRATION-LEXICAL-RECALL.md` registers a criterion on the thirty abstention questions
    (`ABS`) and the whole-corpus line cannot answer it: +190 gold turns overall and -12 on `ABS` are
    the same summary. `capability` was carried in every row and never read; summing it is the whole
    change, and it makes the subset criterion checkable from the gate's own log rather than re-derived
    from the artifact by whoever remembers it exists.

    Alphabetical rather than by size: an order derived from the numbers moves when they do, and a line
    whose field order changes between two runs cannot be diffed.
    """
    entries: list[str] = []
    for capability in sorted({row['capability'] for row in expected.values()}):
        before = sum(row['carried'] for row in expected.values() if row['capability'] == capability)
        after = sum(row['carried'] for row in fresh.values() if row['capability'] == capability)
        if before == after:
            # No marker on a still entry. A reader who subtracts two numbers on all five entries stops
            # reading the line, and the one entry that moved is the one that matters.
            entries.append(f'{capability} {before}->{after}')
        else:
            word = 'up' if after > before else 'down'
            entries.append(f'{capability} {before}->{after} ({word} {abs(after - before)})')
    return ' | '.join(entries)


def compare_candidate(
    report: dict,
    reference: dict,
    marker: dict,
    label: str,
    expects: frozenset[str] | None,
) -> int:
    """Read a deliberately different report: exit 0 when the comparison is valid, 1 when it is not.

    The verdict is about **comparability**, not about the candidate: a treatment that lost gold turns is
    a result, and a tool that failed on it would teach its users to stop running candidates. What it does
    refuse is a difference it cannot attribute -- another corpus, another roster, an axis nobody
    predicted -- and what it always prints is the configuration change, because a candidate that moved
    two things at once is not a candidate for the mechanism it names.
    """
    fresh = {row['id']: row for row in rows_of(report)}
    expected = {row['id']: row for row in reference['questions']}
    failures = comparability_failures(report, reference, fresh, expected)

    print(f'=== candidate: {label} ===')
    print(f'reference        : {reference["row"]} / run {reference["run"]}')
    print(f'questions        : {len(fresh)} of {len(expected)}')
    print(f'indexes built    : {marker.get("indexes")} over {marker.get("questions")} x {marker.get("runs")}')

    before = reference.get('configuration')
    after = configuration_of(report)
    if before is None:
        # A reference written before the configuration was recorded. Said out loud rather than skipped:
        # a candidate whose difference is unattributed is exactly what this line exists to prevent.
        print('configuration    : the reference records none, so the change cannot be attributed here')
    else:
        moved = [
            (key, before.get(key, '<absent>'), after.get(key, '<absent>'))
            for key in sorted(set(before) | set(after))
            if before.get(key, '<absent>') != after.get(key, '<absent>')
        ]
        if not moved:
            print(
                'configuration    : unchanged -- this candidate\'s difference is in code, not in a '
                'setting, which is why the artifact cannot state it for you'
            )
        else:
            print(f'configuration    : {len(moved)} field(s) changed')
            for key, old, new in moved:
                print(f'  {key}: {json.dumps(old)} -> {json.dumps(new)}')

    improved = [qid for qid in expected if qid in fresh and fresh[qid]['carried'] > expected[qid]['carried']]
    regressed = [
        qid for qid in expected if qid in fresh and fresh[qid]['carried'] < expected[qid]['carried']
    ]
    same = [qid for qid in expected if qid in fresh and fresh[qid]['carried'] == expected[qid]['carried']]
    redelivered = [
        qid
        for qid in expected
        if qid in fresh and fresh[qid]['deliveredDigest'] != expected[qid]['deliveredDigest']
    ]
    # The clip detector. `carried` and the digest are whole-turn shaped, so a delivery that is a clip of
    # one turn prints `0 delivered different turn texts` -- which is how a change and a non-change came to
    # read alike in this round's own candidate. A question whose delivery moved in characters while its
    # turn account stood still is a clip, and it is named `CLIP` rather than folded into the count.
    char_moved = [
        qid
        for qid in expected
        if qid in fresh
        and 'deliveredChars' in expected[qid]
        and 'deliveredChars' in fresh[qid]
        and fresh[qid]['deliveredChars'] != expected[qid]['deliveredChars']
    ]
    clips = [qid for qid in char_moved if qid not in redelivered]

    zero_expected = {qid for qid, row in expected.items() if row['carried'] == 0}
    zero_fresh = {qid for qid, row in fresh.items() if row['carried'] == 0}
    left_zero = sorted(zero_expected - zero_fresh)
    entered_zero = sorted(zero_fresh - zero_expected)

    # The prediction, printed before the numbers it is a prediction about. `None` is `any`: a
    # declaration that no axis was named, which is a legitimate statement for an exploratory run and a
    # different one from `none` -- so the two must not share a line.
    observed = [
        axis
        for axis, moved in (
            ('turns', bool(improved or regressed or redelivered)),
            ('chars', bool(char_moved)),
        )
        if moved
    ]
    print(
        'predicts         : '
        + (
            'none (any axis may move, so this delta is attributed by hand)'
            if expects is None
            else ','.join(axis for axis in DELIVERY_AXES if axis in expects) or 'none'
        )
    )
    print(
        'observed         : '
        + (','.join(observed) or 'none')
        + ('' if observed else ' -- the delivery is byte-identical to the reference')
    )

    print(f'gold turns        : {sum(row["carried"] for row in expected.values())} -> '
          f'{sum(row["carried"] for row in fresh.values())}')
    print(f'questions changed : {len(improved)} gained, {len(regressed)} lost, {len(same)} unchanged')
    print(f'evidence changed  : {len(redelivered)} question(s) delivered different turn texts')
    print(f'characters moved  : {len(char_moved)} question(s) delivered a different number of characters'
          + (f' ({len(clips)} of them clipped: turns and digest agree, length does not)' if clips else ''))
    print(f'zero-recall       : {len(zero_expected)} -> {len(zero_fresh)} '
          f'({len(left_zero)} left, {len(entered_zero)} entered)')
    print(f'buckets (ref)     : {dict(Counter(bucket_of(row) for row in expected.values()))}')
    print(f'buckets (cand)    : {dict(Counter(bucket_of(row) for row in fresh.values()))}')
    print(f'by capability    : {capability_account(expected, fresh)}')
    for qid in improved[:12]:
        print(f'  GAIN {qid} {expected[qid]["carried"]}->{fresh[qid]["carried"]} of {expected[qid]["total"]}')
    for qid in regressed[:12]:
        print(f'  LOSS {qid} {expected[qid]["carried"]}->{fresh[qid]["carried"]} of {expected[qid]["total"]}')
    for qid in char_moved[:12]:
        print(
            f'  {"CLIP" if qid in clips else "CHARS"} {qid} '
            f'{expected[qid]["deliveredChars"]}->{fresh[qid]["deliveredChars"]}'
        )
    if left_zero:
        print(f'  LEFT ZERO {", ".join(left_zero[:12])}')
    if entered_zero:
        print(f'  ENTERED ZERO {", ".join(entered_zero[:12])}')

    if failures:
        print('VERDICT: this comparison is not valid. Each line below is a different way to be wrong.')
        for failure in failures:
            print(f'  FAIL {failure}')
        return 1

    # §13.381. The prediction is a contract in both directions. A movement the candidate did not name has
    # a cause the candidate did not name, and a prediction that did not happen means the mechanism either
    # did not run or changed nothing -- which is the `room-floor` shape, and it fails here rather than
    # being read as a null result. `any` is exempt by construction and says so on the line above.
    attribution: list[str] = []
    if expects is not None:
        unclaimed = [axis for axis in observed if axis not in expects]
        unfulfilled = [axis for axis in DELIVERY_AXES if axis in expects and axis not in observed]
        if unclaimed:
            attribution.append(
                f'the delivery moved {", ".join(unclaimed)} and the candidate declared '
                f'{", ".join(axis for axis in DELIVERY_AXES if axis in expects) or "none"}: '
                f'{", ".join(unclaimed)} is not in the prediction, so this delta has a cause the '
                'candidate did not name. Declare that axis, or declare "any" and record in the log that '
                'no axis was predicted.'
            )
        if unfulfilled:
            attribution.append(
                f'the candidate declared {", ".join(unfulfilled)} and that axis did not move on any '
                'question: the mechanism either did not run or changed nothing. A prediction that did '
                'not happen is the shape §13.380 published as "the branch never fires", so it fails here '
                'instead of passing as a null result.'
            )
    if attribution:
        print('VERDICT: the movement is not the one the candidate declared.')
        for line in attribution:
            print(f'  FAIL {line}')
        return 1

    if (redelivered or clips) and not (improved or regressed):
        # The counts agree everywhere and the texts do not. That is not a scoring change, it is another
        # delivery, and reporting it as "no effect" would be the most expensive kind of wrong.
        print(
            'VERDICT: the gold account is unchanged while the evidence moved. This is a different '
            'delivery, not a scoring change -- read `evidence changed` above before reading anything else.'
        )
        return 0

    print(
        f'VERDICT: valid comparison of {label}. Retrieval only -- accuracy, the judge and the pairing '
        'are not measured by this instrument, so no accuracy claim may be drawn from this table.'
    )
    return 0


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
    parser.add_argument(
        '--candidate',
        default=None,
        metavar='LABEL',
        help=(
            'compare as a candidate rather than as a calibration: report the delta instead of refusing '
            'it, and print which configuration fields moved. LABEL names the treatment in the log, so two '
            'candidates cannot be confused for one another'
        ),
    )
    parser.add_argument(
        '--expects-change',
        default=None,
        metavar='AXES',
        help=(
            'required with --candidate: which axis of the delivery this run intends to move. "turns" '
            '(the whole-turn account), "chars" (the delivered length), both, "none" (the delivery '
            'stands still) or "any" (no prediction). The tool compares the prediction with what '
            'happened in both directions'
        ),
    )
    parser.add_argument('--row', default='S14')
    parser.add_argument('--run', default='')
    args = parser.parse_args()

    # Before the report is read: a flag that silently does nothing is worse than one that refuses, and a
    # calibration's claim is equality on every question -- there is no axis for it to predict.
    if args.expects_change is not None and args.candidate is None:
        raise SystemExit(
            '--expects-change belongs to a candidate run: a calibration claims equality on every '
            'question, so there is no axis for it to predict. Pass --candidate <label> as well, or '
            'drop the flag.'
        )

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
    marker_payload = json.loads(marker.read_text())
    if args.candidate is not None:
        if not args.candidate.strip():
            raise SystemExit('--candidate needs a label: an unnamed candidate is a diff nobody can attribute.')
        if args.expects_change is None:
            raise SystemExit(
                '--candidate needs --expects-change: a candidate declares which axis of the delivery it '
                'intends to move ("turns", "chars", "turns,chars", "none" or "any"), and the tool '
                'compares the prediction with what happened in both directions. A candidate that moves '
                'an axis nobody named is how §13.380\'s clip reported "0 question(s) delivered different '
                'turn texts" while delivering 23,503 characters.'
            )
        return compare_candidate(
            report,
            reference,
            marker_payload,
            args.candidate.strip(),
            read_expected_axes(args.expects_change),
        )
    return compare(report, reference, marker_payload)


if __name__ == '__main__':
    sys.exit(main())
