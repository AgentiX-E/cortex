#!/usr/bin/env python3
"""Split a capability's failures into the ones a wider window could reach and the ones it could not.

    python3 tools/evidence-completeness.py <report.json> [--capability MR] [--json]

## Why this split decides the next axis

§13.264 classified the numeric-gold residuals into selection and aggregation and concluded the axis
was **event specification**. §13.265 then found the classifier could not tell over-exclusion from
under-listing, because a gold is a count and not a set. This tool asks the question the artifact can
answer instead: **was the gold evidence in the window at all?**

The artifact already records it. `goldOverlap` carries `carried` (gold turns delivered), `total`
(gold turns the dataset names) and `pool` (gold turns the retrieval ever offered). So every wrong
answer falls into one of two populations:

| population | test | what a repair would have to be |
| --- | --- | --- |
| `partial` | `carried < total` | the reader never saw at least one gold turn: a window or retrieval repair |
| `full` | `carried == total` | the reader saw everything and still answered wrong: a reasoning repair |

and `pool < total` refines the `partial` case: those turns were never candidates, so no ordering
inside the pool could have delivered them.

## What the arithmetic says, and why the ceiling is printed

Accuracy inside each population is what a repair of that population could reach. The headroom is
`(accuracy(full) - accuracy(partial)) * count(partial)`, which is the number of questions closing the
partial gap would win **if partial could be lifted to full** — an assumption, and the tool says so.
Printing it is what stops a plan from being written against a gain the population cannot produce;
§13.264.3 did the same arithmetic for the 30 count-shaped golds and §13.9 before it.

## What it cannot do

It cannot say *which* gold turn was missing, because `goldDelivered` is a boolean per gold turn and
the dataset's gold turn ids are not on the record. It also cannot separate "the budget dropped it"
from "the ranking never offered it" beyond `pool < total`, and neither of those names the constraint
that bound — character budget, turn cap, or ranking width. That is a gap in `windowComposition`, and
until it is closed a window experiment cannot be aimed.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

POPULATIONS = ('full', 'partial')


def _overlap(record: dict) -> dict | None:
    """The `goldOverlap` block, or `None` when the record predates it or the dataset had no gold.

    `None` is a population of its own and never folded into `partial`. A record without the block
    cannot testify about delivery at all, and counting it as "the gold was missing" would inflate the
    population a window repair is supposed to reach — the defect §13.11.2 names for fields and
    §13.262.4 paid for when a field name was read as a population.
    """
    block = record.get('goldOverlap')
    if not isinstance(block, dict):
        return None
    carried = block.get('carried')
    total = block.get('total')
    if not isinstance(carried, int) or not isinstance(total, int):
        return None
    pool = block.get('pool')
    return {
        'carried': carried,
        'total': total,
        'pool': pool if isinstance(pool, int) else None,
    }


def classify(record: dict) -> str | None:
    """`full` / `partial` / `unknown` for one record."""
    overlap = _overlap(record)
    if overlap is None:
        return 'unknown'
    if overlap['total'] == 0:
        return 'unknown'
    return 'full' if overlap['carried'] >= overlap['total'] else 'partial'


def _capability(record: dict) -> str:
    value = record.get('capability')
    return value if isinstance(value, str) and value else '?'


def census(records: list[dict]) -> dict:
    """Accuracy and headroom per capability, with the populations kept apart."""
    capabilities: dict[str, dict] = {}
    for record in records:
        capability = _capability(record)
        bucket = capabilities.setdefault(
            capability,
            {
                name: {'n': 0, 'correct': 0} for name in (*POPULATIONS, 'unknown')
            },
        )
        population = classify(record)
        bucket[population]['n'] += 1
        if record.get('correct') is True:
            bucket[population]['correct'] += 1
    # `pool < total` is the sub-case no ordering can repair, so it is counted separately.
    unreachable = sum(
        1
        for record in records
        if classify(record) == 'partial'
        and (overlap := _overlap(record)) is not None
        and overlap['pool'] is not None
        and overlap['pool'] < overlap['total']
    )
    for capability, bucket in capabilities.items():
        for population, counts in bucket.items():
            counts['accuracy'] = counts['correct'] / counts['n'] if counts['n'] else None
        bucket['headroom'] = _headroom(bucket)
        bucket['total'] = sum(counts['n'] for counts in (bucket[p] for p in (*POPULATIONS, 'unknown')))
        bucket['correct'] = sum(counts['correct'] for counts in (bucket[p] for p in (*POPULATIONS, 'unknown')))
    return {'capabilities': capabilities, 'partialUnreachable': unreachable}


def _headroom(bucket: dict) -> float | None:
    """Questions a repair of `partial` would win if it reached the `full` accuracy.

    `None` when either population is empty: a headroom quoted from one population is a statement
    about a comparison that did not happen.
    """
    full, partial = bucket['full'], bucket['partial']
    if not full['n'] or not partial['n'] or full['accuracy'] is None or partial['accuracy'] is None:
        return None
    return (full['accuracy'] - partial['accuracy']) * partial['n']


def render(summary: dict, capability: str | None) -> str:
    lines = ['Evidence completeness', '']
    rows = summary['capabilities']
    if capability is not None:
        rows = {capability: rows[capability]} if capability in rows else {}
    header = (
        f'{"cap":5s} {"n":>4s} | {"full n":>6s} {"acc":>6s} | {"part n":>6s} {"acc":>6s} '
        f'| {"headroom":>8s}'
    )
    lines += [header, '-' * len(header)]
    for name, bucket in sorted(rows.items()):
        lines.append(
            f'{name:5s} {bucket["total"]:4d} | {bucket["full"]["n"]:6d} '
            f'{_pct(bucket["full"]["accuracy"]):>6s} | {bucket["partial"]["n"]:6d} '
            f'{_pct(bucket["partial"]["accuracy"]):>6s} | {_headroom_text(bucket["headroom"]):>8s}'
        )
    unknown = sum(bucket['unknown']['n'] for bucket in summary['capabilities'].values())
    lines += [
        '',
        f'  {summary["partialUnreachable"]} partial questions also had a gold turn the retrieval '
        'never offered (`pool < total`),',
        '  so no ordering inside the pool could have delivered it.',
    ]
    if unknown:
        lines.append(f'  {unknown} records carry no `goldOverlap` and sit in neither population.')
    lines += [
        '',
        'Reading',
        '-------',
        '  headroom is (accuracy(full) - accuracy(partial)) * count(partial): the questions a',
        '  window repair would win if partial could be lifted to full. It is an assumption, not',
        '  a measurement, and it is printed so a plan cannot be written against a larger number.',
    ]
    return '\n'.join(lines)


def _pct(value: float | None) -> str:
    return '—' if value is None else f'{value * 100:.1f}%'


def _headroom_text(value: float | None) -> str:
    return '—' if value is None else f'{value:+.1f}'


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', help='an ablation report with per-question records')
    parser.add_argument('--capability', default=None, help='restrict the table to one capability')
    parser.add_argument('--json', action='store_true', help='the summary as JSON')
    args = parser.parse_args(argv)

    payload = json.loads(Path(args.report).read_text())
    records = payload.get('questions')
    if not isinstance(records, list) or not records:
        print('FAIL the artifact carries no per-question records', file=sys.stderr)
        return 1
    summary = census([r for r in records if isinstance(r, dict)])
    if args.capability is not None and args.capability not in summary['capabilities']:
        print(f'FAIL no questions with capability {args.capability}', file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(summary, indent=1, sort_keys=True))
    else:
        print(render(summary, args.capability))
    return 0


if __name__ == '__main__':
    sys.exit(main())
