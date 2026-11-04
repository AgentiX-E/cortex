#!/usr/bin/env python3
"""Read a cohort prediction off two artifacts: the registered arm and a replays of a wider pool.

## The defect this exists for

`§13.234` registered four predictions for the `topK=512` dispatch. The run died (`§13.237`) and its two
complete repetitions were regraded (`41741547141`), which answered predictions 1, 3 and 4. Prediction 2
was recorded as **untested**, with the reason "`goldRanks` caps at 255, so 'outside the pool' and 'at
255' are the same value".

That reason is false. `goldRanks` encodes a gold turn the ranking never surfaced as **`-1`**; `254` is
a rank inside a 256-wide pool. The cohort was computable all along and the regrade tool had written
only aggregates.

So this tool is the second half of `§13.241`'s repair: `pairedRows` keeps the rows, and this reads the
cohort off them. It takes the **registered** arm's artifact for the cohort definition, because
"outside the pool" is a statement about the pool that arm had -- a question whose gold sat outside 256
may well sit inside 512, and that is the prediction's whole content.

## What it will not do

It does not pool repetitions. A cohort read across repetitions would have to decide which repetition a
question's verdict comes from, and every way of deciding is an imputation; the caller names one run.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Row:
    """One question, from either arm."""

    id: str
    capability: str
    correct: bool
    outside: bool


def registered_rows(artifact: dict) -> list[Row]:
    """Rows from a live artifact, with cohort membership read off `goldRanks`.

    `outside` is true when **any** gold turn the dataset names was never surfaced by the ranking
    (`-1`). A question with no `goldRanks` at all -- a run that consulted no ranking -- is excluded
    from the cohort rather than counted as outside: it has no ranking to be outside of.
    """
    rows: list[Row] = []
    for record in artifact.get('questions') or []:
        ranks = (record.get('goldOverlap') or {}).get('goldRanks')
        if ranks is None:
            continue
        rows.append(
            Row(
                id=str(record.get('questionId')),
                capability=str(record.get('capability')),
                correct=bool(record.get('correct')),
                outside=any(rank == -1 for rank in ranks),
            )
        )
    return rows


def replayed_rows(regrade: dict, run: int) -> list[Row]:
    """Rows from a regrade, which carries `§13.241`'s projection per repetition."""
    for entry in regrade.get('runs') or []:
        if int(entry.get('run', -1)) != run:
            continue
        questions = entry.get('questions')
        if questions is None:
            raise SystemExit(
                f'run {run} carries no per-question rows. A regrade written before §13.241 has only '
                'aggregates, and a cohort is not recoverable from an aggregate -- re-run the regrade '
                'with the current tool rather than reading a cohort off the summary.',
            )
        return [
            Row(
                id=str(question.get('id')),
                capability=str(question.get('capability')),
                correct=bool(question.get('correct')),
                # Membership comes from the registered arm; the replay only supplies verdicts.
                outside=False,
            )
            for question in questions
        ]
    raise SystemExit(f'the regrade holds no run {run}; it carries {len(regrade.get("runs") or [])}')


def mcnemar_exact(b: int, c: int) -> float:
    """Two-sided exact McNemar p-value for `b` and `c` discordant pairs."""
    import math

    total = b + c
    if total == 0:
        return 1.0
    tail = sum(math.comb(total, k) for k in range(0, min(b, c) + 1)) / 2**total
    return min(1.0, 2 * tail)


def read_cohort(
    registered: list[Row],
    replayed: list[Row],
    expect: int,
    capability: str | None = None,
) -> list[str]:
    """Read the cohort, optionally inside one capability.

    ## Why the capability filter is not a convenience

    The registered prediction names **41 questions**, and 41 is the multi-session route's share of a
    161-question cohort -- every route has some gold the ranking never surfaced (`IE` 32, `MR` 41,
    `TR` 50, `KU` 24, `ABS` 14 on `41546569106`). Reading the prediction over all 161 would answer a
    different question than the one that was registered, and the difference is large enough to change
    the verdict. So the scope is a parameter and the default is the whole set, printed with its size.
    """
    if capability is not None:
        registered = [row for row in registered if row.capability == capability]
        known = {row.id for row in registered}
        replayed = [row for row in replayed if row.id in known]
    by_id = {row.id: row for row in replayed}
    # Pairing is by question id and a missing id is an error rather than a skip: a cohort read over a
    # subset would report a conversion rate for a population nobody defined.
    missing = [row.id for row in registered if row.id not in by_id]
    if missing:
        raise SystemExit(
            f'{len(missing)} registered question(s) have no verdict in the replay, '
            f'starting with {missing[0]!r}. A cohort read over a subset is a rate for a different '
            'population.'
        )

    cohort = [row for row in registered if row.outside]
    rest = [row for row in registered if not row.outside]

    def convert(group: list[Row]) -> tuple[int, int, int]:
        """Wrong in the registered arm, and how many of those the replay answers correctly."""
        wrong = [row for row in group if not row.correct]
        won = [row for row in wrong if by_id[row.id].correct]
        return len(group), len(wrong), len(won)

    def rate(group: list[Row], flag: str) -> float:
        if not group:
            return float('nan')
        if flag == 'registered':
            return 100.0 * sum(1 for row in group if row.correct) / len(group)
        return 100.0 * sum(1 for row in group if by_id[row.id].correct) / len(group)

    def moves(group: list[Row]) -> tuple[int, int, float]:
        """Discordant pairs inside a group, and the exact McNemar p-value for them."""
        won = sum(1 for row in group if not row.correct and by_id[row.id].correct)
        lost = sum(1 for row in group if row.correct and not by_id[row.id].correct)
        return won, lost, mcnemar_exact(lost, won)

    n, wrong, won = convert(cohort)
    n_rest, wrong_rest, won_rest = convert(rest)
    won_c, lost_c, p_c = moves(cohort)
    won_r, lost_r, p_r = moves(rest)

    scope = 'all capabilities' if capability is None else capability
    lines = [
        f'scope: {scope}',
        f'questions: {len(registered)}  cohort (gold outside the pool): {n}  rest: {n_rest}',
        '',
        f"{'cohort':10}{'n':>5}{'wrongThen':>11}{'converted':>11}{'registered':>13}{'replayed':>12}",
        f"{'outside':10}{n:>5}{wrong:>11}{won:>11}{rate(cohort, 'registered'):>12.2f}%"
        f"{rate(cohort, 'replay'):>11.2f}%",
        f"{'rest':10}{n_rest:>5}{wrong_rest:>11}{won_rest:>11}{rate(rest, 'registered'):>12.2f}%"
        f"{rate(rest, 'replay'):>11.2f}%",
        '',
        f'prediction: at least {expect} of the {wrong} wrong-in-cohort question(s) convert',
        f'reading:    {won} converted -> ' + ('MET' if won >= expect else 'NOT MET'),
        '',
        'conversion rate, cohort vs rest (a concentration claim is a comparison, not a count):',
        f'  outside {100.0 * won / wrong if wrong else float("nan"):.1f}%  '
        f'of {wrong} wrong,  rest {100.0 * won_rest / wrong_rest if wrong_rest else float("nan"):.1f}% '
        f'of {wrong_rest} wrong',
        '',
        'did the wider pool move each group, paired (McNemar exact):',
        f'  outside {won_c} gained vs {lost_c} lost  p = {p_c:.4f}',
        f'  rest    {won_r} gained vs {lost_r} lost  p = {p_r:.4f}',
    ]
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description='Read a cohort prediction off a registered artifact and a replay of a wider pool.'
    )
    parser.add_argument('--registered', type=Path, required=True, help='the narrower pool arm artifact')
    parser.add_argument('--regrade', type=Path, required=True, help='the replay of the wider pool arm')
    parser.add_argument('--run', type=int, default=0, help='which repetition of the replay to read')
    parser.add_argument(
        '--capability',
        default=None,
        help='read only this capability; the registered prediction names 41 questions, which is '
        "the multi-session route's share of a 161-question cohort",
    )
    parser.add_argument(
        '--expect',
        type=int,
        default=3,
        help='conversions the registration predicted, kept as a parameter rather than hardcoded',
    )
    args = parser.parse_args(argv)

    registered = registered_rows(json.loads(args.registered.read_text()))
    replayed = replayed_rows(json.loads(args.regrade.read_text()), args.run)
    for line in read_cohort(registered, replayed, args.expect, args.capability):
        print(line)
    return 0


if __name__ == '__main__':
    sys.exit(main())
