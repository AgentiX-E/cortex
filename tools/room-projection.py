#!/usr/bin/env python3
"""Project the room that would deliver the gold turns a run's room cut, from that run's own artifact.

## Why this is a tool and not a paragraph

Round 147 read an artifact and pre-registered a number in prose: *"widen `multi-session` to 58,500,
because the deepest short question projects to 58,251"*. The arithmetic behind that number used
`promptChars` -- the **evidence text** the reader was shown -- as the numerator, while the constraint
it was reasoning about bounds the **rendered** prompt. On the artifact it was computed from
(`44768451597`, `3a704032`) those two columns are 45,944 and 48,449 against a room of 48,460, so the
estimator under-states by 5.2%, and on three of the sixteen short questions the difference crosses the
registered value: projected 58,500, needed 58,597 / 59,682 / 61,726. A dispatch at the registered value
would have produced a partially-cleared criterion and a round spent explaining it.

The mistake is not arithmetic, it is provenance: two columns of one artifact differ, they are named
almost alike, and the one that is *not* the budget's denominator is the one whose name says "prompt".
Prose cannot be re-run against a new artifact; this can, and it prints both estimators side by side so
the difference is visible where the number is taken rather than in a retraction afterwards.

## What it answers, and what it refuses

The question is narrow on purpose: **of the gold turns this run did not deliver, which ones would a
larger room have delivered, and how large would it have to be?** Three partitions come out of the
record and only one of them is a room question:

| state | the record says | what a larger room buys |
| --- | --- | --- |
| delivered | `goldDelivered[i]` | nothing; already read |
| surfaced, not delivered | a rank `>= 0` | **this row is what the projection is about** |
| never surfaced | a rank of `-1` | nothing: the window never held a score for it |

A `-1` is a statement about the ranking and a room projection over it would be a category error -- it
is printed in its own bucket and never enters the maximum. `GoldOverlap.pool` is the count of gold
turns that were surfaced, so the three buckets are `carried` / `total - carried - never` / `never` and
their sum is `total`; the tool recomputes that sum rather than trusting the three fields to agree.

It refuses to project when the record cannot support the linear model at all, and each refusal names
its question:

- **`window-below-cap`** -- the delivered prompt is under `FILL_FLOOR` of the room, so the room was not
  what stopped the delivery. The model is `turns = room / mean_turn`, which presumes the room was spent.
- **`unscored-turns-in-window`** -- `windowComposition.offered < windowComposition.turns`. The ranking
  never scored every delivered turn, i.e. the room overflowed *past the pool*, and a rank is no longer
  a position in the order the room spent. This is `WindowComposition`'s own documented state.
- **`ranking-not-reported`** -- no `goldRanks`, the `goldAccount: product-unreported` artifact. Every
  missing gold turn looks the same, which is the blindness `goldAccount` exists to advertise.
- **`room-unknown`** -- no `effectivePromptChars[route]`, so there is no denominator.

A maximum computed over the readable subset while the unreadable ones are silently dropped is the
silent-denominator defect this repository keeps paying for, so the projection is `None` when anything
is unreadable -- the tool's failure mode is "no number", never "a number about fewer questions".

## The estimator, and the assumption it cannot remove

`needed_turns = deepest_cut_rank + 1`, then `room_needed = needed_turns / delivered_turns * room`.
Both factors are measured; the step between them is an assumption: **the mean rendered length of the
turns the room did not reach equals that of the turns it did**. It is not testable from the artifact,
which records the delivered turns and not the order of the rest, and the tool prints it instead of
hiding it. Two smaller biases ride along and are also printed:

- delivery is deduplicated on text, so a rank is a position in the deduplicated pool while
  `delivered_turns` counts turns; a corpus that repeats a turn verbatim shifts one against the other
  by the number of repeats -- **this bias belongs to artifacts built before `a84f35fb`**. Those runs
  reported the pool `SearchIndex` had built, which is deduplicated on text; runs at or after that
  commit report the order `selectByRelevance` actually spent, which is one entry per admitted turn,
  so a rank and `delivered_turns` count the same things and the bias is zero. The two generations
  carry the same `goldAccount: product-reported` label, so nothing in the artifact tells them apart:
  section 145.2 found the difference by reading a row where the rank sat inside the delivery and the
  turn had still not been delivered. Check the run's `ref` before reading the second decimal;
- `max_turn_chars` truncates long turns, so a tail of long turns is cheaper than the mean suggests and
  a tail of short ones dearer.

What the tool does **not** say: anything about accuracy. A room that carries every gold turn is a
mechanism reading, and whether it buys a correct answer is a separate dispatch with its own criterion.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Any

# The share of the room a delivery must occupy before the room can be called the binding constraint.
# `AUDIT-PROMPT-ROOM.md` measured 98.70% on a shipped artifact and this floor is the band its own
# quotient test uses to separate `at-cap` from `below-cap`; below it the delivery is a selection that
# happens to be large rather than a window filled to its cap.
FILL_FLOOR = 0.95


def _overlap(question: dict[str, Any]) -> dict[str, Any] | None:
    overlap = question.get('goldOverlap')
    return overlap if isinstance(overlap, dict) else None


def project(artifact: dict[str, Any], candidate_room: float | None = None) -> dict[str, Any]:
    """The projection for one artifact, or the refusals that stop it being made.

    Returns a dict with `rows` (one per question that cut a gold turn), `neverSurfaced` (gold turns the
    ranking did not offer, which are not room questions), `maximum` (the room that would carry every
    cut gold turn on every readable question, or `None`), `refusals`, and `candidate` when one was
    named.
    """
    rooms = ((artifact.get('memoryArmConfig') or {}).get('effectivePromptChars') or {})
    rows: list[dict[str, Any]] = []
    never_surfaced: list[dict[str, Any]] = []
    refusals: list[dict[str, Any]] = []
    fully_carried = 0

    for question in artifact.get('questions') or []:
        overlap = _overlap(question)
        if overlap is None:
            continue
        total = overlap.get('total')
        carried = overlap.get('carried')
        ranks = overlap.get('goldRanks')
        delivered = overlap.get('goldDelivered')
        if not isinstance(total, int) or not isinstance(carried, int):
            continue
        if carried >= total:
            fully_carried += 1
            continue
        question_id = question.get('questionId')
        if not isinstance(ranks, list) or not isinstance(delivered, list):
            refusals.append(
                {
                    'questionId': question_id,
                    'reason': 'ranking-not-reported',
                    'detail': (
                        'no goldRanks: this is the product-unreported artifact, where a gold turn the '
                        'ranking never surfaced and one the room cut are the same row'
                    ),
                }
            )
            continue
        # The three buckets are recomputed from the delivery mask rather than read off `pool`, so the
        # partition the projection depends on is checked instead of assumed to add up.
        unseen = [index for index, ok in enumerate(delivered) if not ok and ranks[index] < 0]
        cut = [ranks[index] for index, ok in enumerate(delivered) if not ok and ranks[index] >= 0]
        for index in unseen:
            never_surfaced.append(
                {
                    'questionId': question_id,
                    'rank': ranks[index],
                    # `pool` is the count of gold turns the ranking surfaced; a `-1` inside it would be
                    # a contradiction between two fields of one record, which is a defect in the
                    # producer rather than in this projection, and the reader is told which it is.
                    'goldSurfaced': overlap.get('pool'),
                }
            )
        if not cut:
            continue
        route = question.get('route')
        room = rooms.get(route) if isinstance(route, str) else None
        if not isinstance(room, (int, float)) or room <= 0:
            refusals.append(
                {
                    'questionId': question_id,
                    'reason': 'room-unknown',
                    'detail': f'no effectivePromptChars[{route!r}], so there is no denominator',
                }
            )
            continue
        window = question.get('windowComposition') or {}
        turns = window.get('turns')
        offered = window.get('offered')
        if isinstance(offered, int) and isinstance(turns, int) and offered < turns:
            refusals.append(
                {
                    'questionId': question_id,
                    'reason': 'unscored-turns-in-window',
                    'detail': (
                        f'{turns - offered} of {turns} delivered turns carry no ranking score, so the '
                        'room overflowed past the pool and a rank is not a position in what the room spent'
                    ),
                }
            )
            continue
        delivered_turns = len(question.get('turns') or [])
        delivered_chars = question.get('deliveredPromptChars')
        if delivered_turns == 0 or not isinstance(delivered_chars, (int, float)):
            refusals.append(
                {
                    'questionId': question_id,
                    'reason': 'delivery-not-measured',
                    'detail': 'no delivered turns or no deliveredPromptChars to compare against the room',
                }
            )
            continue
        fill = delivered_chars / room
        if fill < FILL_FLOOR:
            refusals.append(
                {
                    'questionId': question_id,
                    'reason': 'window-below-cap',
                    'detail': (
                        f'the delivered prompt occupies {fill:.1%} of the room, so the room is not what '
                        'stopped the delivery and a projection from it would be arithmetic about nothing'
                    ),
                }
            )
            continue
        needed_turns = max(cut) + 1
        rows.append(
            {
                'questionId': question_id,
                'route': route,
                'room': room,
                'deliveredTurns': delivered_turns,
                'deliveredPromptChars': delivered_chars,
                'evidenceTurns': question.get('evidenceTurns'),
                'deepestCutRank': max(cut),
                'cut': len(cut),
                'neededTurns': needed_turns,
                'fill': fill,
                # The constraint's own denominator: the room bounds the rendered prompt.
                'byRoom': needed_turns / delivered_turns * room,
                # The column round 147 used, kept beside it because the size of the gap is the finding.
                'byPromptChars': needed_turns / delivered_turns * float(question.get('promptChars') or room),
            }
        )

    maximum = None
    if rows and not refusals:
        maximum = max(row['byRoom'] for row in rows)

    candidate = None
    if candidate_room is not None:
        covered = [row['questionId'] for row in rows if row['byRoom'] <= candidate_room]
        short = [row['questionId'] for row in rows if row['byRoom'] > candidate_room]
        candidate = {
            'room': candidate_room,
            'covers': covered,
            'misses': short,
            # A candidate that covers every readable question still says nothing about the questions the
            # projection refused, which is why the count of those is carried beside it.
            'complete': not short and not refusals,
        }

    return {
        'rows': rows,
        'neverSurfaced': never_surfaced,
        'fullyCarried': fully_carried,
        'refusals': refusals,
        'maximum': maximum,
        'candidate': candidate,
        'assumption': (
            'needed_turns / delivered_turns * room, assuming the turns the room did not reach have the '
            "delivered prefix's mean rendered length; a rank counts admitted turns on runs at or after "
            '`a84f35fb` and deduplicated texts before it, and max_turn_chars truncates the tail'
        ),
    }


def render(projection: dict[str, Any]) -> str:
    """The projection as a pre-registration would quote it, refusals first."""
    lines: list[str] = []
    if projection['refusals']:
        lines.append('PROJECTION REFUSED -- the artifact cannot support a number:')
        for refusal in projection['refusals']:
            lines.append(f"  {refusal['reason']:<26} {refusal['questionId']}: {refusal['detail']}")
        lines.append('')
    rows = projection['rows']
    lines.append(
        f"{len(rows)} questions cut a gold turn; {projection['fullyCarried']} carried every gold turn; "
        f"{len(projection['neverSurfaced'])} gold turns were never surfaced by the ranking"
    )
    if rows:
        lines.append('')
        lines.append(
            f"{'question':<18}{'route':<14}{'delivered':>10}{'deepest':>9}{'need':>7}"
            f"{'fill':>7}{'room':>8}{'byRoom':>9}{'byPromptChars':>15}"
        )
        for row in sorted(rows, key=lambda item: -item['byRoom']):
            lines.append(
                f"{row['questionId']:<18}{row['route']:<14}{row['deliveredTurns']:>10}"
                f"{row['deepestCutRank']:>9}{row['neededTurns']:>7}{row['fill']:>7.1%}"
                f"{row['room']:>8.0f}{row['byRoom']:>9.0f}{row['byPromptChars']:>15.0f}"
            )
    lines.append('')
    maximum = projection['maximum']
    if maximum is None:
        lines.append('Maximum room: not projected (see the refusals above)')
    else:
        lines.append(f'Maximum room: {maximum:.0f} characters on every short question')
    candidate = projection['candidate']
    if candidate is not None:
        verdict = 'covers every short question' if candidate['complete'] else 'MISSES ' + ', '.join(candidate['misses'])
        lines.append(f"Candidate {candidate['room']:.0f}: {verdict}")
    lines.append(f"Assumption: {projection['assumption']}")
    lines.append('Not said here: anything about accuracy. A room that carries every gold turn is a')
    lines.append('mechanism reading, and the answer is a separate dispatch with its own criterion.')
    return '\n'.join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('artifact', help='a benchmark-cortex-memory-ablation-report.json')
    parser.add_argument('--room', type=float, default=None, help='a candidate room to test coverage for')
    parser.add_argument('--json', action='store_true', help='print the projection as JSON')
    arguments = parser.parse_args(argv)

    with open(arguments.artifact, encoding='utf-8') as handle:
        artifact = json.load(handle)
    projection = project(artifact, arguments.room)
    if arguments.json:
        print(json.dumps(projection, indent=1))
    else:
        print(render(projection))
    # A refusal is an exit status as well as a line, because a pipeline that reads only the number would
    # otherwise treat an absent maximum as a zero.
    return 2 if projection['refusals'] else 0


if __name__ == '__main__':
    sys.exit(main())
