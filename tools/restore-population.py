#!/usr/bin/env python3
"""Choose the restore counterfactual's population, and its matched control, before any call is made.

## What the counterfactual needs and why the choice is a separate, offline step

§13.267 registers the instrument: reinstate a question's missing gold evidence in the read-time
context, rerun the **same reader**, and classify by what happens. The classification is trivial once
the answers exist. The population is not, and it is the part that can be wrong in a way no result
would reveal:

* a failure whose missing gold was already in the pool and simply ranked low is a **selection**
  question;
* a failure whose missing gold the ranking never surfaced is a **retrieval** question;
* and either of them may be a question the reader would have got wrong with all the evidence in
  front of it, which is the case that makes every evidence axis worthless.

Choosing the population after seeing which questions convert would select on the outcome. So the
list is produced here, from the artifact alone, and written down with the rule that produced it.

## Why a matched control, and what it controls

A failure that converts to a correct answer is evidence that the missing turn mattered. It is not
evidence that the intervention is safe: restoring text into a prompt can also **displace** text, and a
success that flips to wrong under the same intervention is the measurement of that cost. So every
failure is paired with a partial **success** -- a question with the same amount of missing gold that
the reader nevertheless got right -- and the report carries both directions.

## The matching rule, and the number that chose it

Pairs are matched on `missing = total - carried` -- **the size of the intervention**, because that is
what the control has to receive in order to measure the cost of receiving it. `total` is a covariate,
minimised within a `missing` stratum rather than demanded, and ties broken by `questionId` so the list
is reproducible.

The first version of this rule matched on `total` exactly, on the reasoning that a question with one
missing turn out of one and one missing out of twelve are not the same shape. Run against
`42161343457` it produced **3 pairs and 7 unmatched failures**, because gold counts there run from 10
to 30 while partial successes cluster at the small end. A rule that discards seventy per cent of the
population before a single call is not a conservative rule; it is a rule that leaves the instrument
unable to say anything about the questions that failed hardest.

Matching on `missing` produces **8 pairs and 2 unmatched** against the same artifact. The two that
remain are the large interventions -- five and six missing turns -- where no partial success exists,
and they are reported as unpaired rather than quietly paired across intervention sizes.

The yield is a design fact and not an outcome: it was read from the artifact's counts, before any
restore was run, and no question's answer entered the choice. That distinction is what makes it
legitimate to prefer one rule -- but it is written down here rather than left implicit, because a
rule changed after the answers exist would be selection on the outcome.

## What it does not do

It issues no call and it does not read `goldTurns` to build a prompt. It selects; the harness that
reinstates is a separate step, and keeping them apart is what lets this list be reviewed before
anything is spent.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def load(path: Path) -> dict:
    with path.open() as handle:
        return json.load(handle)


def stratum(record: dict) -> dict | None:
    """One record's place in the counterfactual, or `None` when it is not in either stratum.

    A record is a candidate only when it names gold it did not fully deliver. `carried == total` is
    the success side of the evidence question and has nothing to reinstate; `goldOverlap` absent means
    the dataset named no gold at all, which is not a question this instrument can ask.
    """
    overlap = record.get('goldOverlap')
    if not isinstance(overlap, dict):
        return None
    total = overlap.get('total')
    carried = overlap.get('carried')
    if not isinstance(total, int) or not isinstance(carried, int) or total <= 0:
        return None
    if carried >= total:
        return None
    ranks = overlap.get('goldRanks') or []
    delivered = overlap.get('goldDelivered') or []
    turns = overlap.get('goldTurns')
    # The missing turns, by index, so the two sides can be compared on what they would each receive.
    missing = [index for index, flag in enumerate(delivered) if flag is False]
    return {
        'questionId': record.get('questionId'),
        'capability': record.get('capability'),
        'correct': bool(record.get('correct')),
        'total': total,
        'carried': carried,
        'missing': len(missing),
        # Whether every gold turn reached the ranking. False means the selector never had the choice,
        # which is the distinction §13.268.1 closed at k=512 and which this list still records.
        'all_offered': bool(ranks) and all(isinstance(rank, int) and rank >= 0 for rank in ranks),
        'chars_to_add': (
            sum(len(turns[index]) for index in missing)
            if isinstance(turns, list) and len(turns) == total
            else None
        ),
    }


def pair(failures: list[dict], successes: list[dict]) -> tuple[list[dict], list[dict]]:
    """Pair each failure with a success that receives the same intervention. Returns `(pairs, unmatched)`.

    The stratum is `missing` -- how many gold turns the intervention adds -- because that is the
    quantity both sides of a pair must share for the control to price the intervention rather than a
    different one. Within the stratum the nearest `total` wins, so the two questions are as alike in
    dataset shape as the stratum allows.
    """
    by_missing: dict[int, list[dict]] = {}
    for record in successes:
        by_missing.setdefault(record['missing'], []).append(record)
    for bucket in by_missing.values():
        bucket.sort(key=lambda record: record['questionId'] or '')
    used: set[str] = set()
    pairs: list[dict] = []
    unmatched: list[dict] = []
    for failure in sorted(failures, key=lambda record: record['questionId'] or ''):
        candidates = [
            record for record in by_missing.get(failure['missing'], []) if record['questionId'] not in used
        ]
        if not candidates:
            unmatched.append(failure)
            continue
        control = min(candidates, key=lambda record: (abs(record['total'] - failure['total']), record['questionId'] or ''))
        used.add(control['questionId'])
        pairs.append({'failure': failure, 'control': control})
    return pairs, unmatched


def census(report: dict, capability: str) -> dict:
    records = report.get('questions') or []
    failures: list[dict] = []
    successes: list[dict] = []
    for record in records:
        if record.get('capability') != capability:
            continue
        entry = stratum(record)
        if entry is None:
            continue
        if entry['correct']:
            successes.append(entry)
        else:
            failures.append(entry)
    pairs, unmatched = pair(failures, successes)
    return {'failures': failures, 'successes': successes, 'pairs': pairs, 'unmatched': unmatched}


def render(result: dict, capability: str) -> str:
    failures = result['failures']
    successes = result['successes']
    pairs = result['pairs']
    lines = [
        f'{capability}: {len(failures)} partial failures, {len(successes)} partial successes, '
        f'{len(pairs)} pair(s), {len(result["unmatched"])} unmatched failure(s)',
        '',
        f'{"failure":<14} {"missing":>7} {"offered":>7} {"chars":>6}   {"control":<14} '
        f'{"missing":>7} {"offered":>7} {"chars":>6}',
    ]
    for entry in pairs:
        side = entry['failure']
        control = entry['control']
        lines.append(
            f'{side["questionId"]:<14} {side["missing"]:>7} {str(side["all_offered"]):>7} '
            f'{_chars(side["chars_to_add"]):>6}   {control["questionId"]:<14} '
            f'{control["missing"]:>7} {str(control["all_offered"]):>7} {_chars(control["chars_to_add"]):>6}'
        )
    if result['unmatched']:
        lines.append('')
        lines.append('UNMATCHED (no partial success receiving the same number of turns, so no pair is claimed):')
        for entry in result['unmatched']:
            lines.append(
                f'  {entry["questionId"]} with total {entry["total"]} missing {entry["missing"]}'
                f'{" (all gold offered)" if entry["all_offered"] else " (gold never surfaced)"}'
            )
    lines.append('')
    lines.append(
        '  A pair is two questions that would receive the same number of gold turns; the failure says '
        'whether the evidence mattered'
    )
    lines.append('  and the success says what restoring it costs. Neither number is a gain on its own.')
    return '\n'.join(lines)


def _chars(value: int | None) -> str:
    return '?' if value is None else f'{value:,}'


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifact', type=Path, help='a cortex-memory ablation artifact')
    parser.add_argument('--capability', default='MR', help='the capability to pair within (default MR)')
    parser.add_argument('--json', action='store_true', help='print the selection instead of a table')
    arguments = parser.parse_args(argv)

    report = load(arguments.artifact)
    result = census(report, arguments.capability)
    if not result['failures'] and not result['successes']:
        print(
            f'{arguments.artifact}: no {arguments.capability} record names gold it did not fully '
            'deliver, so there is no population to restore into',
            file=sys.stderr,
        )
        return 2
    if arguments.json:
        print(json.dumps({'capability': arguments.capability, **result}, indent=2))
    else:
        print(render(result, arguments.capability))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
