#!/usr/bin/env python3
"""Which side of the gold a capability's failures land on, and how many are not numbers at all.

    python3 tools/mr-error-direction.py <report.json> [--capability MR] [--json]

## Why the direction is the finding and the count is not

§13.289.4 classified `MR`'s twenty-seven failures by hand and found eighteen **below** the gold against
four above. That asymmetry is the whole diagnostic: a reader that *miscalculates* lands on either side,
and a reader that **stops one item early** lands only below. The same classification is what §13.290's
first prediction is stated in, so it has to be reproducible by machine rather than by the hand that
wrote the prediction.

## What it refuses to price

A record is `priced` only when the gold **and** the answer both carry a number. Everything else is
counted under its own name rather than folded into `below`:

- `declined` — the answer is empty, or the run's sentinel. A decline is not a small answer.
- `echo` — the answer is a copy of an evidence turn (`1. [2023/…] user: …`). §13.289 found two of these
  and they are a reply-shape failure, so counting one as `below` would attribute it to the mechanism
  this tool exists to measure.
- `unpriced` — one side has no number the tool can read. Text gold ("Thrive Market") and multi-value
  gold ("5 days. 6 days (including the last day) is also acceptable") both land here, and the second is
  the reason a range cannot be priced: the first number of a range is not the answer.

`equal` is its own bucket and it is the one worth reading twice: a numerically equal answer the judge
scored wrong is either a judge defect or a coincidence, and neither is a counting failure.

## What it cannot do

It reads the **first** number on each side, so a gold of the form "$5,850" and an answer of "$5,250"
price correctly while a gold that names two amounts does not. It also cannot tell an enumeration gap
from a wrong operation: `$5,850 → $5,250` is a missing $600 and `70 → 50` is a missing 20 pounds, but
`99 → 100` is an over-count and `100 → "300 points"` is a different quantity entirely. The tool prints
the pairs so the shape is readable; it does not classify the mechanism.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

# The run's sentinel, restated rather than imported: this tool reads an artifact on disk and must not
# need the product's TypeScript to decode it. The assertion that the two agree lives in the test file.
SENTINEL = 'INSUFFICIENT_EVIDENCE'

NUMBER = re.compile(r'-?\d[\d,]*(?:\.\d+)?')
ECHO = re.compile(r'^\s*\d+\.\s*\[\d{4}/\d{2}/\d{2}')

# Number words, because a gold of "three" is a count and §13.289's twenty-seven are twenty-six counts.
WORDS = {
    word: value
    for value, word in enumerate(
        'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen '
        'fifteen sixteen seventeen eighteen nineteen twenty'.split()
    )
}
WORDS.update({'thirty': 30, 'forty': 40, 'fifty': 50, 'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90})


def first_number(text: str | None) -> float | None:
    """The first figure the text names, digits before words.

    Digits first because a gold like "5 days. 6 days (including the last day)" must price at 5 rather
    than at 6; words second because "three weddings" is a count and a tool that skipped it would report
    five of §13.289's failures as unpriced.
    """
    if not text:
        return None
    match = NUMBER.search(text)
    if match:
        try:
            return float(match.group(0).replace(',', ''))
        except ValueError:
            return None
    for token in re.findall(r"[a-z']+", text.lower()):
        if token in WORDS:
            return float(WORDS[token])
    return None


def classify(record: dict) -> str:
    """One of `below`, `above`, `equal`, `declined`, `echo`, `unpriced`."""
    answer = record.get('answer')
    if not answer or not answer.strip() or SENTINEL in answer:
        return 'declined'
    if ECHO.match(answer):
        return 'echo'
    gold = first_number(record.get('groundTruth'))
    given = first_number(answer)
    if gold is None or given is None:
        return 'unpriced'
    if given < gold:
        return 'below'
    if given > gold:
        return 'above'
    return 'equal'


def census(records: list[dict], capability: str | None) -> dict:
    rows = [r for r in records if capability is None or r.get('capability') == capability]
    failures = [r for r in rows if r.get('correct') is not True]
    buckets: dict[str, list[dict]] = {name: [] for name in ('below', 'above', 'equal', 'declined', 'echo', 'unpriced')}
    for record in failures:
        buckets[classify(record)].append(record)
    return {
        'capability': capability,
        'total': len(rows),
        'correct': sum(1 for r in rows if r.get('correct') is True),
        'failures': len(failures),
        'counts': {name: len(group) for name, group in buckets.items()},
        'priced': len(buckets['below']) + len(buckets['above']) + len(buckets['equal']),
        'examples': {
            name: [
                {
                    'questionId': r.get('questionId'),
                    'groundTruth': r.get('groundTruth'),
                    'answer': (r.get('answer') or '')[:80],
                }
                for r in group
            ]
            for name, group in buckets.items()
        },
    }


def render(summary: dict) -> str:
    lines = [f'Failure direction -- {summary["capability"] or "all capabilities"}', '']
    lines.append(
        f'  {summary["correct"]} of {summary["total"]} correct, {summary["failures"]} failures, '
        f'{summary["priced"]} of them priced against a numeric gold'
    )
    lines.append('')
    labels = {
        'below': 'below the gold -- the signature of a missing item',
        'above': 'above the gold -- the signature of an act that was not there',
        'equal': 'equal to the gold, and scored wrong -- a judge or a coincidence',
        'declined': 'declined, which is not a small answer',
        'echo': 'an evidence turn copied back, which is a reply-shape failure',
        'unpriced': 'not numbers, so direction is undefined',
    }
    for name, label in labels.items():
        lines.append(f'  {summary["counts"][name]:>3}  {label}')
    lines.append('')
    if summary['counts']['below'] or summary['counts']['above']:
        below, above = summary['counts']['below'], summary['counts']['above']
        lines.append(f'  below:above = {below}:{above}')
        lines.append('  A reader that miscalculates lands on both sides. A ratio this lopsided is a')
        lines.append('  reader that stops while the evidence is still speaking.')
    for name in ('below', 'above'):
        if summary['examples'][name]:
            lines.append('')
            lines.append(f'  {name}:')
            for row in summary['examples'][name]:
                lines.append(f'    {row["questionId"]:<12} gt={row["groundTruth"]!r:<26} answered {row["answer"]!r}')
    return '\n'.join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('report', type=Path, help='benchmark-cortex-memory-ablation-report.json')
    parser.add_argument('--capability', help='restrict to one capability, e.g. MR')
    parser.add_argument('--json', action='store_true', help='machine-readable output')
    args = parser.parse_args(argv)

    report = json.loads(args.report.read_text())
    questions = report.get('questions')
    if not isinstance(questions, list):
        print('this report has no questions; nothing here can be measured', file=sys.stderr)
        return 2

    summary = census(questions, args.capability)
    print(json.dumps(summary, indent=1) if args.json else render(summary))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
