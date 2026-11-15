#!/usr/bin/env python3
"""Two judges, one population, and the questions they disagree about.

    python3 tools/judge-agreement.py --a a-verdicts.json --b b-verdicts.json [--write out.json]

## The quantity this exists for, and why a delta is not it

`tools/judge-cross-vendor.mjs` compares two **deltas**: the artifact's judge was 13 questions too
lenient by one measure and 11 by another, so the two judges differ by 2. That 2 is a difference of
differences, and it is the right number for one question -- "is a same-family judge favouring the
reader it shares a family with?" -- but it says nothing about the questions themselves. A gap of 2 is
compatible with two judges that revoke the *same* 11 questions and differ on two, and with two judges
that revoke 11 disjoint questions each. Those are different findings about the artifact.

Here the question is per question:

|  | meaning |
| --- | --- |
| `both` | the artifact accepted it, and **both** judges call it wrong |
| `a_only` / `b_only` | only one judge calls it wrong -- an opinion, not a fact |
| `rescued` | the artifact rejected it and a judge accepts it, which is the *other* direction |

`both` is the part that survives a change of vendor, and it is a **floor** on how much the published
accuracy overstates: those questions are wrong by two independent instruments. The union is the
ceiling at which the harshest single judge put it. Reporting the delta without this table is how a
two-question gap gets read as "the judges disagree about everything".

## Why it refuses what it refuses

A set difference needs two sets over **one** population. Two verdict files with different ids, or
different counts of them, are two populations: pairing them by intersection would silently drop the
questions one arm could not grade, and those are exactly the questions a judge disagreement is most
likely to be about.

## Why `--write` needs both run ids

Same rule as `tools/no-ranking-ledger.py` and `tools/cost-ledger.py`: an evidence file that cannot
state where it came from is a number with no address. Two readings, two runs, both named.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


def majority(verdicts: list[bool]) -> bool:
    """Strict majority, with a tie resolved to `false` -- the same rule `judge-regrade.mjs` uses.

    Reimplemented here rather than imported because the two runtimes cannot share code, and it is
    asserted against the same vectors in the tests: a tie is not a win for either side, and calling a
    1-1 split correct would let a two-pass reading manufacture agreement this table then counts.
    """
    return sum(1 for verdict in verdicts if verdict) * 2 > len(verdicts)


def load(path: Path) -> dict[str, tuple[bool, bool]]:
    """`question id -> (recorded, re-graded majority)`, or a refusal naming the file."""
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        sys.exit(f'no such verdict file: {path}')
    except json.JSONDecodeError as error:
        sys.exit(f'{path} is not JSON: {error}')
    if not isinstance(payload, list):
        sys.exit(f'{path} is not a verdict vector (expected a JSON array)')
    graded: dict[str, tuple[bool, bool]] = {}
    for row in payload:
        if not isinstance(row, dict):
            sys.exit(f'{path} contains a row that is not an object')
        question = row.get('questionId')
        verdicts = row.get('verdicts')
        recorded = row.get('recorded')
        if not isinstance(question, str) or not isinstance(verdicts, list) or not verdicts:
            sys.exit(f'{path} has a row without a question id or a verdict vector')
        if not isinstance(recorded, bool):
            sys.exit(f'{path}: {question} does not record what the artifact said')
        if question in graded:
            # A repeated id means the vector is not one verdict per question, and every count below
            # would then be a count of something else.
            sys.exit(f'{path} names {question} twice')
        graded[question] = (recorded, majority(verdicts))
    return graded


def compare(a: dict[str, tuple[bool, bool]], b: dict[str, tuple[bool, bool]]) -> dict[str, object]:
    """The overlap table, or a refusal when the two vectors are not one population."""
    if set(a) != set(b):
        only_a = sorted(set(a) - set(b))
        only_b = sorted(set(b) - set(a))
        sys.exit(
            'the two vectors are not over the same population: '
            f'{len(a)} vs {len(b)} questions, {len(only_a)} only in A, {len(only_b)} only in B'
            + (f' (e.g. {only_a[0]!r})' if only_a else f' (e.g. {only_b[0]!r})')
        )
    return overlap(a, b)


def overlap(
    a: dict[str, tuple[bool, bool]], b: dict[str, tuple[bool, bool]]
) -> dict[str, object]:
    """Count the four cells, plus agreement, from two verdict maps over one population."""
    judged = len(a)
    recorded = sum(1 for question in a if a[question][0])
    revoked_a = {q for q in a if a[q][0] and not a[q][1]}
    revoked_b = {q for q in b if b[q][0] and not b[q][1]}
    rescued = {q for q in a if (not a[q][0]) and (a[q][1] or b[q][1])}
    disagree = sum(1 for q in a if a[q][1] != b[q][1])
    return {
        'judged': judged,
        'recordedCorrect': recorded,
        # The verdict the two instruments share, which is the only one that is not a matter of taste.
        'both': len(revoked_a & revoked_b),
        'aOnly': len(revoked_a - revoked_b),
        'bOnly': len(revoked_b - revoked_a),
        'union': len(revoked_a | revoked_b),
        'rescued': len(rescued),
        'judgeDisagreement': disagree,
        'judgeAgreementRate': (judged - disagree) / judged if judged else None,
        'bothIds': sorted(revoked_a & revoked_b),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--a', required=True, type=Path, help='verdict vector from the first reading')
    parser.add_argument('--b', required=True, type=Path, help='verdict vector from the second reading')
    parser.add_argument('--write', type=Path, help='where to write the table as JSON')
    parser.add_argument('--run-a', help='run id the first vector came from; required by --write')
    parser.add_argument('--run-b', help='run id the second vector came from; required by --write')
    args = parser.parse_args()

    if args.write and not (args.run_a and args.run_b):
        sys.exit('--write needs --run-a and --run-b: an evidence file has to state where it came from')

    reading = compare(load(args.a), load(args.b))
    percent = lambda value: f'{value * 100:.2f}%'  # noqa: E731 - one expression, used twice

    print(f'judged            {reading["judged"]} questions, {reading["recordedCorrect"]} recorded correct')
    print('')
    print('                      count   share of judged   share of recorded')
    for key, label in (('both', 'both judges'), ('aOnly', 'A only'), ('bOnly', 'B only')):
        count = reading[key]
        print(
            f'  {label:18} {count:5}   {percent(count / reading["judged"]):>15}'
            f'   {percent(count / reading["recordedCorrect"]):>18}'
        )
    print(f'  {"union (ceiling)":18} {reading["union"]:5}   {percent(reading["union"] / reading["judged"]):>15}')
    print(f'  {"rescued":18} {reading["rescued"]:5}')
    print('')
    print(
        f'the two judges agree on {reading["judged"] - reading["judgeDisagreement"]}'
        f'/{reading["judged"]} verdicts = {percent(reading["judgeAgreementRate"])}'
    )

    if args.write:
        payload = {
            'what': 'Two judges over one population: the questions each calls wrong, and the ones both do.',
            'runA': args.run_a,
            'runB': args.run_b,
            'a': str(args.a),
            'b': str(args.b),
            **reading,
        }
        args.write.write_text(json.dumps(payload, indent=2) + '\n', encoding='utf-8')
        print(f'\nwrote {args.write}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
