#!/usr/bin/env python3
"""Classify the numeric-gold multi-session residuals into selection, aggregation and contract.

    python3 tools/mr-residual-census.py <report.json> [--capability MR] [--json]

## The question this answers, and why it had been answered by anecdote

§13.262.8 retired a cheap idea — tally the reader's own `Step 1` list deterministically instead of
trusting its arithmetic — after measuring that the tally would break **15** currently correct answers
and fix **1**. The prose there named three failures as if they were the taxonomy: `eeda8a6d` should
have summed (`10 + 5 + 1 + 1 = 17`), `80ec1f4f` should have counted distinct venues, and `6d550036`
excluded every candidate and answered `0` against a gold of `2`.

Three anecdotes over a 500-question artifact is not a distribution, and the next axis depends on
which class dominates: a **deterministic aggregation executor** can only repair answers whose items
are already right, while **event specification** is what repairs a list that never held the event.
This tool separates them on every record, from the artifact, with no model calls.

## The three classes

A wrong answer is classified by comparing three integers the record already contains:

| class | test | what it means |
| --- | --- | --- |
| `contract` | the answer is not an integer | the reply never committed to a count; the format is the fault |
| `selection` | the answer **equals** the number of items it kept, and that number is not the gold | its arithmetic is faithful to its own list, and the list is wrong — either short (`under`) or long (`over`) |
| `aggregation` | the answer does **not** equal the number of items it kept | it applied an operation to its own list: a sum, a distinct count, a subset |

`selection` is split by sign because the two are different defects: `under` is the case the event
specification acts on (an event that should be in the list is absent or was excluded), and `over` is
the case a stricter predicate acts on.

## What counts as an item, and why exclusions are read in two shapes

The `verbatim` ask writes two kinds of line: an item, and an item the reader considered and rejected.
Rejections appear both as a block under an `Excluded` heading and inline (`- Mattress | ordered, not
an exact "buy/assemble/sell/fix" action`). Both are read, because a reader that rejects an event has
already made the selection decision — `6d550036` lists six candidate projects and marks all six
excluded, and a parser that only saw the block shape would count six items against an answer of zero
and call it an aggregation error. That misreading is the reason this tool exists in code rather than
in a paragraph.

## The window

Only golds in `[2, 10]` are classified — `readout-arm-run.py`'s `count_of` range, which §13.92
corrected the campaign to. A gold of `856` is a balance, not a set of items, and a list's length
cannot be compared with it.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# Four separators of "different from what the question asked for". The em dash is what the reader's
# own sentences use, the double hyphen is what a model emits when it is avoiding unicode, the colon
# covers `excluded: ...`, and the pipe covers the table-like shape (`| excluded`) that the same
# responses produce when the item is written as `name | verb | date`.
EXCLUSION_INLINE = re.compile(
    r'(?:\u2014|\u2013|--|:|\(|\|)\s*(?:excluded|rejected|not counted|does not count|no longer counts)',
    re.I,
)
EXCLUSION_HEADER = re.compile(r'^\s*(?:excluded|exclude|exclusions?)\b', re.I)

CONTRACT = 'contract'
SELECTION = 'selection'
AGGREGATION = 'aggregation'


def _readout():  # noqa: ANN202 - the module, loaded by path
    """`tools/readout-arm-run.py` as a module, for `count_of` and the item-line reader.

    One definition of "a count-shaped gold" and one of "a line that names an item" in the repository:
    two copies would answer differently the first time either was corrected, and the difference would
    land precisely on the numbers this census reports.
    """
    path = ROOT / 'tools' / 'readout-arm-run.py'
    spec = importlib.util.spec_from_file_location('readout_arm_run', path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def parse_list(raw: str) -> tuple[int, int]:
    """`(kept, excluded)` — how many item lines the response kept and how many it rejected.

    An item line inside an `Excluded` block is a rejection whatever it says; a line that carries a
    rejection marker inline is one too. Every other item line counts as kept, so a response that
    writes no exclusions reads as `(n, 0)` and a response that writes nothing at all as `(0, 0)`.
    """
    list_item = _readout().LIST_ITEM
    kept = 0
    excluded = 0
    in_exclusion_block = False
    for line in raw.split('\n'):
        stripped = line.strip()
        if EXCLUSION_HEADER.match(stripped):
            in_exclusion_block = True
            continue
        if not list_item.match(line):
            continue
        if in_exclusion_block or EXCLUSION_INLINE.search(stripped):
            excluded += 1
        else:
            kept += 1
    return kept, excluded


def answer_integer(answer: object) -> int | None:
    """The answer as an integer, or `None` when the reply did not commit to one.

    `'2'` and `' 2 '` are the same answer; `'There are 2 items'` is read as `2` because the final
    number is what the judge compares, and a reply that writes prose is still answering a count. A
    reply with no number at all is `None` — the `contract` class, not a zero.
    """
    if not isinstance(answer, str):
        return None
    text = answer.strip()
    if re.fullmatch(r'\d+', text):
        return int(text)
    numbers = re.findall(r'\d+', text)
    return int(numbers[-1]) if numbers else None


def classify(record: dict) -> dict | None:
    """The class of one record, or `None` when it is out of the window or correct.

    `None` for correct answers is not a judgement about them: a correct answer whose answer equals
    its own list length is exactly the `faithful-equal` case, and counting it here would make the
    distribution read as if the reader's arithmetic were the treatment when it is the population.
    """
    gold = _readout().count_of(record.get('groundTruth'))
    if gold is None:
        return None
    kept, excluded = parse_list(record.get('rawOutput') or '')
    answer = answer_integer(record.get('answer'))
    if answer is None:
        return {
            'questionId': record.get('questionId'),
            'gold': gold,
            'answer': None,
            'kept': kept,
            'excluded': excluded,
            'class': CONTRACT,
            'subclass': 'not-a-number',
            'correct': bool(record.get('correct')),
        }
    if answer == kept:
        subclass = 'under' if kept < gold else ('over' if kept > gold else 'equal')
        kind = SELECTION
    else:
        subclass = 'operation'
        kind = AGGREGATION
    return {
        'questionId': record.get('questionId'),
        'gold': gold,
        'answer': answer,
        'kept': kept,
        'excluded': excluded,
        'class': kind,
        'subclass': subclass,
        'correct': bool(record.get('correct')),
    }


def census(report: dict, capability: str = 'MR') -> dict:
    """The distribution over one capability's numeric-gold records."""
    records = [
        record
        for record in report.get('questions', [])
        if isinstance(record, dict) and record.get('capability') == capability
    ]
    classified = [row for row in (classify(record) for record in records) if row is not None]
    wrong = [row for row in classified if not row['correct']]
    right = [row for row in classified if row['correct']]
    # A record with no item lines has no enumeration to classify. On the shipped arm that is a reader
    # that declined to list; on a run whose review rewrites `rawOutput`, it is every record, and the
    # distribution below then describes the review rather than the enumeration. The count exists so
    # the renderer can say which artifact it is holding instead of printing a comparable-looking table.
    without_items = sum(1 for row in wrong if row['kept'] + row['excluded'] == 0)
    return {
        'capability': capability,
        'inWindow': len(classified),
        'correct': len(right),
        'wrong': len(wrong),
        'wrongWithoutItems': without_items,
        'wrongByClass': dict(Counter(row['class'] for row in wrong)),
        'wrongBySubclass': dict(Counter(row['subclass'] for row in wrong)),
        'correctBySubclass': dict(Counter(row['subclass'] for row in right)),
        # The exclusions are the selection decision made visible: a wrong answer that rejected items
        # is one where the predicate, not the arithmetic, removed the gold.
        'wrongWithExclusions': sum(1 for row in wrong if row['excluded'] > 0),
        'wrongExcludedTotal': sum(row['excluded'] for row in wrong),
        'rows': wrong,
    }


def render(summary: dict, source: str) -> str:
    lines = [f'{source}', '']
    lines.append(
        f'  {summary["capability"]}: {summary["inWindow"]} count-shaped golds '
        f'({summary["correct"]} correct, {summary["wrong"]} wrong)'
    )
    lines.append('')
    lines.append('| class | wrong | what it means |')
    lines.append('| --- | ---: | --- |')
    meaning = {
        SELECTION: 'the arithmetic is faithful to its own list and the list is wrong',
        AGGREGATION: 'the answer is not the size of its own list: an operation was applied',
        CONTRACT: 'the reply never committed to a count',
    }
    for name in (SELECTION, AGGREGATION, CONTRACT):
        count = summary['wrongByClass'].get(name, 0)
        lines.append(f'| {name} | {count} | {meaning[name]} |')
    lines.append('')
    subclass_order = ('under', 'over', 'operation', 'not-a-number', 'equal')
    subclasses = [
        f'{name} {summary["wrongBySubclass"][name]}'
        for name in subclass_order
        if summary['wrongBySubclass'].get(name)
    ]
    lines.append(f'  subclass split: {", ".join(subclasses) if subclasses else "none"}')
    lines.append(
        f'  {summary["wrongWithExclusions"]} of {summary["wrong"]} wrong answers rejected at least one '
        f'candidate ({summary["wrongExcludedTotal"]} rejections in total)'
    )
    if summary['wrongWithoutItems']:
        # Said out loud rather than left to the reader: on a run whose review rewrites `rawOutput`
        # every record lands here, and the table below would otherwise read as a measurement of the
        # reader's enumeration when it is a measurement of the review's reply.
        lines.append(
            f'  WARNING: {summary["wrongWithoutItems"]} of {summary["wrong"]} wrong answers carry no '
            'Step 1 list, so their class describes the reply that was graded and not an enumeration '
            'behind it. A run whose review rewrites `rawOutput` reads this way on every record.'
        )
    lines.append('')
    lines.append('| question | gold | answer | kept | excluded | class |')
    lines.append('| --- | ---: | ---: | ---: | ---: | --- |')
    for row in sorted(summary['rows'], key=lambda item: (item['class'], item['questionId'] or '')):
        answer = '-' if row['answer'] is None else str(row['answer'])
        lines.append(
            f'| {row["questionId"]} | {row["gold"]} | {answer} | {row["kept"]} | {row["excluded"]} '
            f'| {row["class"]}/{row["subclass"]} |'
        )
    return '\n'.join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path, help='a benchmark-cortex-memory-ablation-report.json')
    parser.add_argument('--capability', default='MR', help='which capability to census (default MR)')
    parser.add_argument('--json', action='store_true', help='print the census as JSON')
    arguments = parser.parse_args(argv)

    report = json.loads(arguments.report.read_text())
    summary = census(report, arguments.capability)
    if arguments.json:
        print(json.dumps(summary, indent=2))
    else:
        print(render(summary, str(arguments.report)))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
