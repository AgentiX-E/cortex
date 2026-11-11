#!/usr/bin/env python3
"""Tabulate the plans the `spec` pass wrote, against what each one did to its question.

    python3 tools/plan-shape-census.py --treatment A.json --control B.json [--capability MR] [--json]

## What this reads, and what it cannot

The `spec` pass asks the reader for a plan -- `scope`, a conjunction of `predicates`, an `operation`
-- and `rawOutput` holds that plan verbatim. So the plan of every graded question is already in the
artifact, and the one thing that is not is the **ledger it ran over**: `support` (the row ids the
answer was computed from) was never persisted, and `retrievedContexts` is not in this report either.
That absence decides what this tool is allowed to claim.

It claims only **shape**: which operation each plan asked for, which fields it filtered on, which
words it filtered for, and how much of the step range its `scope` covered. It does not claim a plan
*selected* anything, because selection is a fact about a ledger this artifact does not carry. The
one place that distinction bites is `span`: `scope` is written in the ledger's own numbering, so a
wide `span` says the plan **asked** to look at a wide range, not that its predicates kept the rows.
Every row below is therefore a statement about what was asked, and the file says so where the number
is printed rather than only here.

## Why shape is worth tabulating before anything is executed

`MEASURE-SPEC-PASS.md` §3 diagnosed the damage as substitution: a syntactically valid plan with a
predicate too wide to be a selection, whose sum then replaced a correct answer. That diagnosis was
made from four questions quoted by hand. A hand-quoted four cannot say whether the other 41 damages
look the same, and a gate fitted to the four would be a gate fitted to a reading rather than to a
population. So the first question this tool answers is descriptive: **do the damages share a shape
the repairs do not**, on all 121 graded `MR` questions rather than on the four that were printed.

## The identity it preserves

`repair` is control wrong and treatment right, `damage` is control right and treatment wrong, and
`neutral` is everything else. The three counts must add up to the number of paired questions, and
the tool fails rather than prints a table whose rows do not add up -- the same reason
`arm-flip-census.py` checks its own identity before it prints a net.

## Why the lexicon is frozen here instead of counted from the ledger

The sharpest shape signal would be the document frequency of a plan's keyword: `text contains
"items"` is a selection only if `items` is rare in the history. That number needs the ledger, which
the artifact does not carry, so the alternative is a **frozen list of kind-nouns** -- words that name
a category rather than an instance (`items`, `things`, `times`, `purchases`). It is a weaker
instrument and it is a hand-written one, which is why it is a named column and not a verdict: a gate
built on it would be built on a lexicon somebody chose after seeing these very questions, and the
only honest use of such a gate is to test it on a population it was not chosen on.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys
from typing import Any

#: Nouns that name a category rather than an instance. Frozen before the census ran.
#:
#: A plan filtering on one of these is not filtering: the history of a question about purchases says
#: "purchases" in most of its turns, which is exactly the predicate `MEASURE-SPEC-PASS.md` §3 quotes
#: from four damages (`items`, `camping`, `doctors`, `attended` -- the last two are not in this list,
#: and the census is what shows whether the category matters or the four were the whole story).
KIND_NOUNS = frozenset(
    {
        'item',
        'items',
        'thing',
        'things',
        'time',
        'times',
        'day',
        'days',
        'week',
        'weeks',
        'month',
        'months',
        'year',
        'years',
        'purchase',
        'purchases',
        'event',
        'events',
        'activity',
        'activities',
        'entry',
        'entries',
        'record',
        'records',
        'task',
        'tasks',
        'note',
        'notes',
        'book',
        'books',
        'movie',
        'movies',
        'show',
        'shows',
        'meeting',
        'meetings',
        'trip',
        'trips',
        'visit',
        'visits',
        'person',
        'people',
        'friend',
        'friends',
        'order',
        'orders',
        'expense',
        'expenses',
    }
)

#: The ledger's own numbering starts at zero, and the arm's `MR` questions carry histories of a few
#: hundred steps, so a span at or above this is "the plan asked for the whole history". It is a
#: threshold on an *ask*, stated as one, and it is here rather than derived so that a later run can
#: disagree with it by name.
WIDE_SPAN = 200


def read_plan(raw: str | None) -> dict[str, Any] | None:
    """The plan inside a response, or `None` when the response is prose.

    Mirrors `parseEventSpec`'s extraction -- a fenced block if there is one, otherwise the outermost
    braces -- and then refuses anything without the three fields a plan must carry. It does **not**
    re-implement the executor's validation: the artifact already holds the answer that validation
    produced, so a second opinion here could only disagree with the product for reasons this tool
    cannot see.
    """
    if not raw:
        return None
    fenced = None
    start = raw.find('```')
    if start != -1:
        closing = raw.find('```', start + 3)
        if closing != -1:
            fenced = raw[start + 3 : closing]
    body = fenced if fenced is not None else raw
    left = body.find('{')
    right = body.rfind('}')
    if left == -1 or right <= left:
        return None
    try:
        parsed = json.loads(body[left : right + 1])
    except json.JSONDecodeError:
        return None
    if not isinstance(parsed, dict):
        return None
    if 'scope' not in parsed or 'predicates' not in parsed or 'operation' not in parsed:
        return None
    return parsed


def shape(plan: dict[str, Any]) -> dict[str, Any]:
    """The plan's shape, as the columns the census tabulates."""
    scope = plan.get('scope')
    span = None
    if isinstance(scope, list) and len(scope) == 2 and all(isinstance(v, (int, float)) for v in scope):
        span = int(scope[1]) - int(scope[0]) + 1
    predicates = plan.get('predicates')
    predicates = predicates if isinstance(predicates, list) else []
    fields = [p.get('field') for p in predicates if isinstance(p, dict)]
    keywords = [
        str(p.get('value', '')).strip().lower()
        for p in predicates
        if isinstance(p, dict) and p.get('field') == 'text'
    ]
    return {
        'operation': plan.get('operation'),
        'span': span,
        'wide': span is not None and span >= WIDE_SPAN,
        'predicates': len(predicates),
        'fields': fields,
        'text_predicates': fields.count('text'),
        'keywords': keywords,
        'kind_noun': any(word in KIND_NOUNS for word in keywords),
        'group_by': plan.get('groupBy'),
    }


def verdict(control: dict[str, Any], treatment: dict[str, Any]) -> str:
    """`repair`, `damage`, or `neutral` for one paired question."""
    before = control.get('correct') is True
    after = treatment.get('correct') is True
    if not before and after:
        return 'repair'
    if before and not after:
        return 'damage'
    return 'neutral'


def census(
    treatment: dict[str, Any], control: dict[str, Any], capability: str | None
) -> dict[str, Any]:
    """The rows, the identity, and the cross-tab of shape against verdict."""
    before = {q['questionId']: q for q in control.get('questions', [])}
    rows: list[dict[str, Any]] = []
    for record in treatment.get('questions', []):
        if capability is not None and record.get('capability') != capability:
            continue
        other = before.get(record['questionId'])
        if other is None:
            continue
        plan = read_plan(record.get('rawOutput'))
        rows.append(
            {
                'questionId': record['questionId'],
                'verdict': verdict(other, record),
                'plan': shape(plan) if plan is not None else None,
                'answer': record.get('answer'),
                'control_answer': other.get('answer'),
                'gold': record.get('groundTruth'),
            }
        )
    counts = {'repair': 0, 'damage': 0, 'neutral': 0}
    for row in rows:
        counts[row['verdict']] += 1
    if sum(counts.values()) != len(rows):
        raise SystemExit('the three verdicts do not add up to the population')

    def cross(column: str) -> dict[str, dict[str, int]]:
        table: dict[str, dict[str, int]] = {}
        for row in rows:
            plan = row['plan']
            value = 'no-plan' if plan is None else str(plan[column])
            bucket = table.setdefault(value, {'repair': 0, 'damage': 0, 'neutral': 0})
            bucket[row['verdict']] += 1
        return dict(sorted(table.items(), key=lambda kv: -(kv[1]['damage'] + kv[1]['repair'])))

    return {
        'population': len(rows),
        'counts': counts,
        'plans': sum(1 for row in rows if row['plan'] is not None),
        'by_operation': cross('operation'),
        'by_text_predicates': cross('text_predicates'),
        'by_wide': cross('wide'),
        'by_kind_noun': cross('kind_noun'),
        'by_field_set': cross('fields'),
        'rows': rows,
    }


#: Candidate authorization gates, each a predicate on a plan's shape that **rejects** the plan.
#:
#: These are named rather than fitted: every one of them is a statement somebody could have written
#: before the census ran, and the census's job is to price them, not to search for one. A gate is
#: priced by what it blocks and what it loses -- `blocked` damages cancelled against `lost` repairs --
#: and the table prints the resulting net against the **control**, because that is the only comparison
#: a later dispatch can move.
#:
#: The list is deliberately short and deliberately redundant. Two gates that reject almost the same
#: plans (`sum` and `span-wide`) are both here because the point of the table is not to pick a winner;
#: it is to show whether *any* property of the ask separates the plans that repaired from the plans
#: that damaged. If the answer is no, it is no for the whole family, and a longer list would only
#: restate the same 'no' in more rows.
GATES: dict[str, Any] = {
    'span-wide': lambda plan: bool(plan['wide']),
    'sum': lambda plan: plan['operation'] == 'sum',
    'count': lambda plan: plan['operation'] == 'count',
    'no-number-predicate': lambda plan: plan['operation'] in ('sum', 'count')
    and 'number' not in plan['fields'],
    'sum-without-number-predicate': lambda plan: plan['operation'] == 'sum'
    and 'number' not in plan['fields'],
    'single-text-predicate': lambda plan: plan['text_predicates'] == 1,
    'kind-noun': lambda plan: bool(plan['kind_noun']),
    'no-text-predicate': lambda plan: plan['text_predicates'] == 0,
}


def gate_table(result: dict[str, Any]) -> list[dict[str, Any]]:
    """What each candidate gate would have cost and saved, against the control.

    A question with no plan counts as **authorized**: the plan never ran, so the pass kept the first
    answer, and refusing it changes nothing. That is also why a gate can never block the variance
    flips -- the five questions that moved without a plan are out of every gate's reach, and the
    table's `unreachable` column says so instead of leaving them to be noticed later.
    """
    counts = result['counts']
    rows: list[dict[str, Any]] = []
    for name, rejects in GATES.items():
        blocked = 0
        lost = 0
        for row in result['rows']:
            plan = row['plan']
            if plan is None or not rejects(plan):
                continue
            if row['verdict'] == 'damage':
                blocked += 1
            elif row['verdict'] == 'repair':
                lost += 1
        rows.append(
            {
                'gate': name,
                'blocked_damage': blocked,
                'lost_repair': lost,
                'net_against_control': counts['repair'] - lost - (counts['damage'] - blocked),
            }
        )
    return rows


def report(result: dict[str, Any]) -> str:
    """A reading, with the caveat printed beside the numbers it applies to."""
    lines: list[str] = []
    counts = result['counts']
    lines.append(
        f"population {result['population']} paired questions; "
        f"repair {counts['repair']}, damage {counts['damage']}, neutral {counts['neutral']}"
    )
    lines.append(
        f"plans recoverable from `rawOutput`: {result['plans']} of {result['population']} "
        f"({result['population'] - result['plans']} responses were prose, or a plan this tool "
        'could not read)'
    )
    lines.append('')
    lines.append('Every column below is a property of what the plan **asked for**.')
    lines.append('`support` was not persisted, so no column says what the plan selected.')
    for column, title in (
        ('by_operation', 'operation'),
        ('by_text_predicates', 'text predicates in the conjunction'),
        ('by_wide', f'scope span >= {WIDE_SPAN} steps'),
        ('by_kind_noun', 'a keyword that names a category'),
        ('by_field_set', 'the predicate fields, in order'),
    ):
        lines.append('')
        lines.append(f'### {title}')
        lines.append('')
        lines.append('| value | repair | damage | neutral |')
        lines.append('| --- | ---: | ---: | ---: |')
        for value, bucket in result[column].items():
            lines.append(
                f"| `{value}` | {bucket['repair']} | {bucket['damage']} | {bucket['neutral']} |"
            )
    lines.append('')
    lines.append('### what each candidate gate would have done, against the control')
    lines.append('')
    lines.append('| gate | damage blocked | repair lost | net questions vs control |')
    lines.append('| --- | ---: | ---: | ---: |')
    for row in gate_table(result):
        lines.append(
            f"| `{row['gate']}` | {row['blocked_damage']} | {row['lost_repair']} | "
            f"{row['net_against_control']:+d} |"
        )
    lines.append('')
    lines.append(
        'A net of `0` reads "this gate returns the arm to the control", and it is the ceiling of the '
        'whole family when the plans that repaired and the plans that damaged share one shape.'
    )
    return '\n'.join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--treatment', required=True, type=pathlib.Path)
    parser.add_argument('--control', required=True, type=pathlib.Path)
    parser.add_argument('--capability', default='MR')
    parser.add_argument('--json', action='store_true')
    arguments = parser.parse_args(argv)
    treatment = json.loads(arguments.treatment.read_text())
    control = json.loads(arguments.control.read_text())
    result = census(treatment, control, arguments.capability)
    print(json.dumps(result, indent=2) if arguments.json else report(result))
    return 0


if __name__ == '__main__':
    sys.exit(main())
