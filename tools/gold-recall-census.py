#!/usr/bin/env python3
"""Where the evidence went: gold-turn recall by bucket, and who loses at zero.

## The question this answers, and why it is not a benchmark run

`S14` priced the vector channel at 5.60 points. A price is not a direction: it does not say whether
the arm that lost was reading worse or being handed less, and those two have different repairs. The
artifacts already carry the answer -- `questions[].goldOverlap.goldDelivered` is the instrument's own
record of which gold turns reached the final prompt -- so this is arithmetic over two files rather
than another dispatch.

The reading it produces for `S14` (`docs/ANALYSIS-LEXICAL-ZERO-RECALL.md`): one cliff at zero recall
(19.0%) and a plateau from the first gold turn on (82.9 / 91.2 / 89.8), with the vector arm holding
**no** question in the zero bucket. That is what turned "5.60 points" into "18 fixable questions".

## Why buckets rather than a mean

A mean recall of 61% is compatible with two very different systems: one that returns half the gold
turns everywhere, and one that returns everything on most questions and nothing on a few. The first
is a tuning problem; the second is a failure mode with a cliff, and the cliff is where the accuracy
is. Bucketing is what makes the two distinguishable, and the buckets are stated in the output rather
than chosen by the reader.

## The two refusals

1. **An artifact with no `goldOverlap`.** A report that predates the census cannot answer this, and
   an empty table would read as "no question had a gold turn" rather than "this file cannot say".
2. **Two artifacts with different rosters.** A pair is compared question by question; the same corpus
   fingerprint with a different question list is a broken artifact, not a population.

Usage:
  python3 tools/gold-recall-census.py <artifact>
  python3 tools/gold-recall-census.py <artifact> --against <other-artifact>
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

# The buckets, named by their upper bound so the printed table reads the same way the document does.
# The last one is inclusive of 100%, and the first is a single value rather than a range because a
# zero is a different state: it is the absence of an answer rather than a low score.
BUCKETS: tuple[tuple[str, float, float], ...] = (
    ('0%', 0.0, 0.0),
    ('1-33%', 0.0, 1 / 3),
    ('34-66%', 1 / 3, 2 / 3),
    ('67-100%', 2 / 3, 1.0),
)


def verdicts(report: dict) -> dict[str, bool]:
    """The majority verdict per question, which is the aggregation the paired reading uses.

    The same rule as `arm-reading-ledger.py`: a tie is a loss. Two files that disagreed about how to
    turn four repetitions into one verdict would produce two answers to one question.
    """
    bits = (report.get('ablation') or {}).get('featureCorrectByRun')
    questions = report.get('questions') or []
    if not isinstance(bits, list) or not bits:
        raise SystemExit(
            'refusing: the artifact carries no `ablation.featureCorrectByRun`, so there is no verdict '
            'per question and `questions[].correct` would be a one-repetition reading'
        )
    out: dict[str, bool] = {}
    for index, entry in enumerate(questions):
        yes = sum(1 for vector in bits if vector[index] == '1')
        out[str(entry['questionId'])] = yes * 2 > len(bits)
    return out


def recall(question: dict) -> tuple[int, int] | None:
    """`(delivered, total)` gold turns, or `None` when the artifact does not carry the census."""
    block = question.get('goldOverlap')
    if not isinstance(block, dict):
        return None
    delivered = block.get('goldDelivered')
    if not isinstance(delivered, list):
        return None
    return sum(1 for entry in delivered if entry), len(delivered)


def bucket(rate: float) -> str:
    for name, low, high in BUCKETS:
        if name == '0%':
            if rate == 0.0:
                return name
            continue
        if low < rate <= high or (name == '67-100%' and rate >= 1.0):
            return name
    return BUCKETS[-1][0]


def census(report: dict) -> dict:
    """The bucket table, the zero-recall population, and the capability mix inside it."""
    questions = report.get('questions') or []
    graded = verdicts(report)
    counts: dict[str, list[int]] = {name: [0, 0] for name, _, _ in BUCKETS}
    zeros: list[dict] = []
    covered = 0
    unreadable = 0
    rates: list[float] = []
    for entry in questions:
        pair = recall(entry)
        if pair is None:
            unreadable += 1
            continue
        delivered, total = pair
        if total == 0:
            # No gold turns is not zero recall: there was nothing to find. Counting it as a zero
            # would put every abstention question in the failure bucket and make the cliff look
            # twice as steep as it is.
            continue
        covered += 1
        rate = delivered / total
        rates.append(rate)
        name = bucket(rate)
        counts[name][0] += 1
        counts[name][1] += 1 if graded.get(str(entry['questionId'])) else 0
        if delivered == 0:
            zeros.append(
                {
                    'questionId': entry['questionId'],
                    'capability': entry.get('capability'),
                    'route': entry.get('route'),
                    'correct': bool(graded.get(str(entry['questionId']))),
                    'goldTurns': total,
                }
            )
    if covered == 0:
        raise SystemExit(
            'refusing: no question in this artifact carries `goldOverlap.goldDelivered`, so this '
            'file cannot say where the evidence went. An empty table would read as "every question '
            'was covered", which is the opposite of what is true'
        )
    return {
        'questions': len(questions),
        'withGoldTurns': covered,
        'withoutCensus': unreadable,
        'buckets': {
            name: {
                'questions': count,
                'correct': scored,
                'accuracy': (scored / count) if count else None,
            }
            for name, (count, scored) in counts.items()
        },
        'meanRecall': sum(rates) / len(rates),
        'zeroRecall': {
            'questions': len(zeros),
            'correct': sum(1 for entry in zeros if entry['correct']),
            'byCapability': dict(sorted(Counter(str(entry['capability']) for entry in zeros).items())),
            'entries': zeros,
        },
    }


def compare(primary: dict, other: dict, other_name: str) -> dict:
    """The same census for a second artifact, and the four groups the pair produces.

    The groups are the part that separates "this arm sees less everywhere" from "this arm collapses on
    a few questions": a mean cannot tell them apart, and the groups can.
    """
    mine = verdicts(primary)
    theirs = verdicts(other)
    if set(mine) != set(theirs):
        raise SystemExit(
            f'refusing: the two artifacts share {len(set(mine) & set(theirs))} question ids and differ '
            f'on {len(set(mine) ^ set(theirs))}, so they are not the same population'
        )
    groups: Counter[str] = Counter()
    for key in mine:
        groups[
            'both'
            if mine[key] and theirs[key]
            else 'onlyThis'
            if mine[key]
            else 'onlyOther'
            if theirs[key]
            else 'neither'
        ] += 1
    # All four cells, present even at zero. A missing key reads as "not counted" and a present zero
    # reads as "none", and only one of those is a fact about the pair -- the same rule the always-present
    # fields in every evidence file follow.
    return {
        'other': other_name,
        'groups': {name: groups.get(name, 0) for name in ('both', 'onlyThis', 'onlyOther', 'neither')},
        'census': census(other),
    }


def render(result: dict, label: str) -> list[str]:
    lines = [
        f'{label}: {result["questions"]} questions, {result["withGoldTurns"]} with gold turns'
        + (f', {result["withoutCensus"]} without the census' if result['withoutCensus'] else ''),
        f'  mean gold-turn recall {result["meanRecall"] * 100:.2f}%',
        f'  {"bucket":<10}{"questions":>10}{"correct":>9}{"accuracy":>10}',
    ]
    for name, block in result['buckets'].items():
        accuracy = 'n/a' if block['accuracy'] is None else f'{block["accuracy"] * 100:.1f}%'
        lines.append(f'  {name:<10}{block["questions"]:>10}{block["correct"]:>9}{accuracy:>10}')
    zero = result['zeroRecall']
    mixture = ', '.join(f'{name} {count}' for name, count in zero['byCapability'].items()) or 'none'
    lines.append(f'  zero recall: {zero["questions"]} question(s), {zero["correct"]} of them correct ({mixture})')
    return lines


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path, help='a benchmark-cortex-memory-ablation-report.json')
    parser.add_argument('--against', type=Path, help='a second artifact, to read the four groups')
    parser.add_argument('--json', action='store_true', help='print the reading as JSON')
    args = parser.parse_args(argv)

    primary = json.loads(args.report.read_text())
    result = {'census': census(primary)}
    if args.against is not None:
        result['against'] = compare(primary, json.loads(args.against.read_text()), args.against.name)

    if args.json:
        # The per-question list is the evidence, so it stays in the JSON and out of the printed block:
        # a table of 21 rows reads as a list of incidents rather than as a rate.
        print(json.dumps(result, indent=2))
        return 0

    lines = render(result['census'], args.report.name)
    if 'against' in result:
        other = result['against']
        lines.append('')
        lines.extend(render(other['census'], f"{other['other']} (against)"))
        groups = other['groups']
        lines.append(
            f'  pair: both {groups.get("both", 0)}, only this {groups.get("onlyThis", 0)}, '
            f'only other {groups.get("onlyOther", 0)}, neither {groups.get("neither", 0)}'
        )
    print('\n'.join(lines))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
