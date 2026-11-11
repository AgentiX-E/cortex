#!/usr/bin/env python3
"""Freeze the reachability groups the `spec` reading is decomposed into, from a measurement of the
grammar rather than from the treatment's results.

    python3 tools/spec-reachability-groups.py \\
        --question tools/readings/spec-ceiling-question.json \\
        --history  tools/readings/spec-ceiling-history.json \\
        [--write tools/spec-reachability-groups.json] [--json]

## Why this is a tool and not a paragraph

`MEASURE-SPEC-CEILING.md` measured, before any dispatch, that the specification grammar can reach 8
of the control arm's 17 numeric multi-session failures from the question's own words, 12 when the
whole history's vocabulary is allowed, and never the remaining 5. Those three readings are three
different propositions about what a `reviewPass: spec` run can possibly show:

| group | what a loss there would mean |
| --- | --- |
| `question-vocabulary` | the plan prompt could reach the gold and the model did not choose it — a contract failure |
| `history-only` | the table's wording is the limit, not the model — a naming failure |
| `unreachable` | the turn grain cannot express the answer — a ledger failure |
| `no-numeric-gold` | the gold is not a number, so the grammar was never the right instrument |

A single `MR` delta averages all four together and can say none of that. But a split chosen after the
artifact exists is a split chosen with knowledge of the outcome, and `tools/arm-flip-census.py`
already prints a warning beside its own post-hoc partition for exactly that reason. The fix is not to
avoid the split; it is to derive it from something measured **before** the run and to freeze the
membership to a file that a later reader can diff against the readings.

## What it refuses

Every refusal here is a state that would produce a plausible-looking group about the wrong thing:

- two readings of different capabilities -- a group that mixes corpora is a group about neither;
- readings passed in the wrong order -- 4 and 8 are both plausible sizes, so nothing downstream
  would notice that the two groups had swapped;
- different question sets, or a gold that moved between the two readings;
- rows that do not sum to the reading's own headline (`grammar: 8` beside eight matching rows is the
  internal agreement this tool exists to require, and a drift in either direction is refused rather
  than resolved by preferring one side).

The check against the headline is the one that would have caught the mistake this campaign keeps
making: a document quoting a number that the data no longer produces.

## Regenerating the frozen file

`--write` emits JSON with a stable key order, not the repository's prettier layout. Run
`npx prettier --write tools/spec-reachability-groups.json` after regenerating: the tests compare
parsed content and will pass either way, while CI's Prettier check compares bytes and will not.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# The control artifact both readings were taken over. Named here rather than passed, because a group
# file about a different artifact would classify the same questions against a different population.
CONTROL_ARTIFACT = '42533236864'

# Where the freeze comes from, in one line, so a reader of the JSON does not have to find this file.
FROZEN_BEFORE = (
    'the round-62 `reviewPass: spec` dispatch: derived from measure-spec-ceiling.ts over '
    f'{CONTROL_ARTIFACT} before the run that reads it, so the split cannot be chosen after the result'
)

GROUPS = (
    (
        'question-vocabulary',
        'a plan built from the question\'s own words reaches the gold; a loss here is the contract',
    ),
    (
        'history-only',
        'no plan from the question\'s words reaches it and one using a word the history uses does; '
        'a loss here is the table\'s wording',
    ),
    (
        'unreachable',
        'no plan in the grammar reaches a numeric gold; a loss here is the ledger\'s grain',
    ),
    (
        'no-numeric-gold',
        'no plan reaches it and the gold is not a number; the grammar was never the instrument',
    ),
)


def _read(path: Path) -> dict:
    """The reading, with the two fields the derivation depends on checked rather than assumed."""
    if not path.exists():
        raise FileNotFoundError(f'{path} does not exist: run bench/measure-spec-ceiling.ts first')
    payload = json.loads(path.read_text())
    for field in ('capability', 'vocabulary', 'grammar', 'summaries'):
        if field not in payload:
            raise ValueError(f'{path} carries no `{field}`: it is not a ceiling reading')
    return payload


def _index(reading: dict) -> dict[str, dict]:
    return {row['questionId']: row for row in reading['summaries']}


def derive(question: dict, history: dict) -> dict:
    """The four groups, plus the source block that says what produced them."""
    if question.get('vocabulary') != 'question' or history.get('vocabulary') != 'history':
        raise ValueError(
            'the two readings are not (question, history): '
            f"got ({question.get('vocabulary')}, {history.get('vocabulary')}). "
            'Swapping them would produce 4 and 8 instead of 8 and 4, and both look plausible'
        )
    if question.get('capability') != history.get('capability'):
        raise ValueError(
            'the readings are of different capabilities '
            f"({question.get('capability')} and {history.get('capability')})"
        )

    narrowed, widened = _index(question), _index(history)
    if set(narrowed) != set(widened):
        missing = sorted(set(narrowed) ^ set(widened))
        raise ValueError(f'the readings disagree on the population: {len(missing)} ids differ, e.g. {missing[:5]}')
    for identifier, row in widened.items():
        twin = narrowed[identifier]
        if row.get('gold') != twin.get('gold') or row.get('goldNumbers') != twin.get('goldNumbers'):
            raise ValueError(
                f'{identifier}: the readings disagree on the gold ({twin.get("gold")!r} against '
                f'{row.get("gold")!r}); one of them is about another corpus'
            )

    buckets: dict[str, list[str]] = {name: [] for name, _ in GROUPS}
    for identifier, row in widened.items():
        if narrowed[identifier].get('grammarCeiling'):
            buckets['question-vocabulary'].append(identifier)
        elif row.get('grammarCeiling'):
            buckets['history-only'].append(identifier)
        elif row.get('goldNumbers'):
            buckets['unreachable'].append(identifier)
        else:
            buckets['no-numeric-gold'].append(identifier)

    # The headline has to agree with the rows it summarises. `grammar` is the number the registration
    # quotes; the rows are what the reading gives the reading. When they part company, one of them is
    # wrong and this tool cannot tell which, so it stops.
    # Two identities, one per reading. The narrowed reading can only reach what the question's own
    # words reach; the widened one reaches that plus what only the history names. Checking the
    # narrowed headline against `history-only` was this tool's first bug -- it compared a reading
    # that does not know about the group to the group, and refused a correct derivation.
    reachable = len(buckets['question-vocabulary']) + len(buckets['history-only'])
    for name, reading, expected in (
        ('question-vocabulary', question, len(buckets['question-vocabulary'])),
        ('history-vocabulary', history, reachable),
    ):
        if reading.get('grammar') != expected:
            raise ValueError(
                f'{name}: the reading headlines {reading.get("grammar")} reachable and its rows '
                f'support {expected}. The headline and the rows must be produced by the same search'
            )

    return {
        'source': {
            'measuredBy': 'packages/cortex-memory/bench/measure-spec-ceiling.ts',
            'readings': [
                'tools/readings/spec-ceiling-question.json',
                'tools/readings/spec-ceiling-history.json',
            ],
            'controlArtifact': CONTROL_ARTIFACT,
            'capability': question['capability'],
            'ceilings': {
                'numericGold': history.get('numeric'),
                'questionVocabulary': question.get('grammar'),
                'historyVocabulary': history.get('grammar'),
                'copy': history.get('copy'),
            },
            'frozenBefore': FROZEN_BEFORE,
        },
        'groups': [
            {'name': name, 'what': what, 'ids': sorted(buckets[name])} for name, what in GROUPS
        ],
    }


def render(derived: dict) -> str:
    source = derived['source']
    ceilings = source['ceilings']
    lines = [
        f'reachability groups over {source["controlArtifact"]} ({source["capability"]}), '
        f'{ceilings["numericGold"]} failures with a numeric gold',
        f'  question vocabulary reaches {ceilings["questionVocabulary"]}, '
        f'history vocabulary {ceilings["historyVocabulary"]}, copy {ceilings["copy"]}',
        '',
        f'{"group":22s} {"n":>3s}  what a loss there would mean',
        '-' * 96,
    ]
    for group in derived['groups']:
        lines.append(f'{group["name"]:22s} {len(group["ids"]):3d}  {group["what"]}')
    lines += ['', 'ids:', '']
    for group in derived['groups']:
        lines.append(f'  {group["name"]}: {", ".join(group["ids"])}')
    return '\n'.join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--question', required=True, help='the reading over the question vocabulary')
    parser.add_argument('--history', required=True, help='the reading over the history vocabulary')
    parser.add_argument('--write', default=None, help='write the derivation here as JSON')
    parser.add_argument('--json', action='store_true', help='print the derivation as JSON')
    args = parser.parse_args(argv)

    try:
        derived = derive(_read(Path(args.question)), _read(Path(args.history)))
    except (FileNotFoundError, ValueError) as error:
        print(f'FAIL {error}', file=sys.stderr)
        return 1

    if args.write:
        Path(args.write).write_text(json.dumps(derived, indent=1, sort_keys=False) + '\n')
    if args.json:
        print(json.dumps(derived, indent=1, sort_keys=False))
    else:
        print(render(derived))
    return 0


if __name__ == '__main__':
    sys.exit(main())
