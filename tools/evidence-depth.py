#!/usr/bin/env python3
"""Derive a per-route evidence room from an ablation artifact.

## The defect this measures

A character budget is converted into a **depth** (how many turns are shown) by each route's own turn
length, and depth is the quantity that decides how much of an answer's evidence arrives. On
`41546569106` one room of 48,000 characters bought 61 turns on `flat` (723 characters each) and 179
on `temporal` (205 each), so the same number is 2.9 times more ranking on one route than the other.
Nothing in the artifact said so; it is arithmetic over two fields the artifact already carries.

## What it reads, and why that is free

`goldOverlap.goldRanks` records, per question, the rank of each gold turn in the run's own relevance
order (`-1` for a gold turn outside the pool). `windowComposition` records the depth delivered and
the characters it took. Coverage -- the share of in-pool gold whose rank is inside the delivered
depth -- is therefore computable for any depth, including depths the run did not use, without a
single provider call. The curve is a property of the **selection**, not of the reader, which is what
makes it legitimate to size a room from it and what this tool exists to print.

## What it will not do

It does not predict accuracy. Coverage explains part of the accuracy on one route and none of it on
another (see `--accuracy`), and a tool that turned the curve into a score would be asserting the
thing the campaign has to measure. It prints the split and leaves the decision to a registration.
"""

from __future__ import annotations

import argparse
import bisect
import json
import statistics
import sys
from pathlib import Path

# Depths the curve is printed at. Dense where artifacts sit (60-200) and sparse past them.
DEFAULT_DEPTHS = (10, 20, 30, 40, 60, 80, 100, 126, 160, 200, 260, 340, 500)


def load(path: Path) -> dict:
    with path.open() as handle:
        return json.load(handle)


def route_of(record: dict) -> str:
    """The route a question answered on.

    The artifact keys questions by **capability** (`IE`, `MR`, ...), and the arm's route for each is
    fixed: `single-session-*` is `flat`, `multi-session` is `multi-session`, and the other four name
    themselves. Mapped here rather than asked for, because an operator who had to supply the mapping
    would be supplying the answer the tool is supposed to derive.
    """
    return {
        'IE': 'flat',
        'MR': 'multi-session',
        'TR': 'temporal',
        'KU': 'knowledge-update',
        'ABS': 'abstention',
    }.get(record.get('capability', ''), str(record.get('capability', '?')))


def in_pool_ranks(record: dict) -> list[int]:
    ranks = (record.get('goldOverlap') or {}).get('goldRanks') or []
    return [rank for rank in ranks if isinstance(rank, int) and rank >= 0]


def delivered_depth(record: dict) -> int:
    """How many turns the prompt actually carried."""
    composition = record.get('windowComposition') or {}
    return int(composition.get('turns') or 0)


def chars_per_turn(record: dict) -> float | None:
    """Characters the delivered turns cost, per turn.

    The density that converts a room into a depth. Taken from `windowComposition` rather than from
    `promptChars`, because the prompt also carries the question and the instruction block and a
    density computed from it would overstate every route by the same constant.
    """
    composition = record.get('windowComposition') or {}
    turns = int(composition.get('turns') or 0)
    chars = composition.get('offeredChars')
    if turns <= 0 or not isinstance(chars, (int, float)):
        return None
    return float(chars) / turns


def coverage_at(records: list[dict], depth: int) -> float:
    """Mean share of in-pool gold delivered at `depth`, over the questions that have any."""
    shares = []
    for record in records:
        ranks = in_pool_ranks(record)
        if not ranks:
            continue
        shares.append(sum(1 for rank in ranks if rank < depth) / len(ranks))
    return 100.0 * statistics.fmean(shares) if shares else float('nan')


def accuracy_split(records: list[dict]) -> tuple[int, int, float, float]:
    """Full-coverage versus partial-coverage accuracy, and the counts each is computed over.

    This is the column that decides **which** route a redistribution should deepen: the same interval
    on two routes can mean "depth converts to accuracy here" and "it does not here", and only the
    split says which.
    """
    full = [r for r in records if in_pool_ranks(r) and _covered(r)]
    part = [r for r in records if in_pool_ranks(r) and not _covered(r)]

    def rate(group: list[dict]) -> float:
        if not group:
            return float('nan')
        return 100.0 * sum(1 for r in group if r.get('correct')) / len(group)

    return len(full), len(part), rate(full), rate(part)


def _covered(record: dict) -> bool:
    ranks = in_pool_ranks(record)
    depth = delivered_depth(record)
    return bool(ranks) and all(rank < depth for rank in ranks)


def room_for(records: list[dict], target: float, max_depth: int | None = None) -> int | None:
    """The smallest room whose depth reaches `target` percent of in-pool gold.

    ## Why the search is over every depth and not over a printed grid

    A room derived from a grid is a room derived from the grid: `coverage_at(records, 40)` can clear a
    target that `coverage_at(records, 31)` would also clear, and the difference is 9 turns of prompt
    that no measurement asked for. So the search walks `1, 2, 3, ...` and stops at the first depth
    that clears the target -- exact, and independent of the depths the curve happens to be printed at.

    The upper bound defaults to one past the deepest in-pool gold, which is the depth at which
    coverage is 100% by construction: past it there is nothing left to deliver.

    Rounded **up** to the next 100 characters, because a room that lands one character short of the
    depth it was derived from is a room that delivers one turn fewer than the curve promised.
    """
    density = [d for d in (chars_per_turn(r) for r in records) if d is not None]
    if not density:
        return None
    per_question = [sorted(ranks) for ranks in (in_pool_ranks(r) for r in records) if ranks]
    if not per_question:
        return None
    limit = max_depth if max_depth is not None else max(max(ranks) for ranks in per_question) + 1

    def room_at(depth: int) -> int:
        return int(-(-(depth * statistics.median(density)) // 100) * 100)

    for depth in range(1, limit + 1):
        share = statistics.fmean(
            bisect.bisect_left(ranks, depth) / len(ranks) for ranks in per_question
        )
        if 100.0 * share >= target:
            return room_at(depth)
    return room_at(limit)


def report(artifact: dict, depths: tuple[int, ...], targets: tuple[float, ...]) -> list[str]:
    records = [r for r in artifact.get('questions') or [] if isinstance(r, dict)]
    if not records:
        raise SystemExit('artifact carries no questions; nothing to derive')

    routes: dict[str, list[dict]] = {}
    for record in records:
        routes.setdefault(route_of(record), []).append(record)

    lines = [
        f"artifact: {len(records)} questions, {len(routes)} routes",
        '',
        f"{'route':18}{'n':>5}{'chars/turn':>12}{'depth':>8}{'cov@depth':>11}"
        f"{'full':>6}{'accFull':>9}{'accPart':>9}",
    ]
    for name in sorted(routes):
        group = routes[name]
        density = [d for d in (chars_per_turn(r) for r in group) if d is not None]
        depth = int(statistics.median([delivered_depth(r) for r in group])) if group else 0
        n_full, n_part, acc_full, acc_part = accuracy_split(group)
        lines.append(
            f'{name:18}{len(group):>5}'
            f'{(statistics.median(density) if density else float("nan")):>12.0f}'
            f'{depth:>8}{coverage_at(group, depth):>10.1f}%'
            f'{n_full:>6}{acc_full:>8.1f}%{acc_part:>8.1f}%'
            + (f'   ({n_part} partial)' if n_part else '')
        )
    lines.append('')

    header = ''.join(f'{d:>8}' for d in depths)
    lines.append(f"{'coverage at depth':18}{header}")
    for name in sorted(routes):
        group = routes[name]
        lines.append(f'{name:18}' + ''.join(f'{coverage_at(group, d):>7.1f}%' for d in depths))
    lines.append('')
    lines.append(f"{'room needed for':18}" + ''.join(f'{t:>10.0f}%' for t in targets))
    for name in sorted(routes):
        group = routes[name]
        rooms = [room_for(group, t) for t in targets]
        lines.append(
            f'{name:18}' + ''.join(f'{(r if r is not None else "n/a"):>11}' for r in rooms)
        )
    return lines


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description='Derive per-route evidence rooms from an artifact.')
    parser.add_argument('artifact', type=Path, help='benchmark-cortex-memory-ablation-report.json')
    parser.add_argument(
        '--depths',
        default=','.join(str(d) for d in DEFAULT_DEPTHS),
        help='depths to print the coverage curve at, comma separated',
    )
    parser.add_argument(
        '--targets',
        default='90,95,99,100',
        help='coverage targets to derive a room for, comma separated',
    )
    parser.add_argument(
        '--map',
        default=None,
        help='derive a dispatchable map for these routes, as a comma-separated list, at --map-target',
    )
    parser.add_argument('--map-target', type=float, default=100.0, help='coverage target for --map')
    args = parser.parse_args(argv)

    depths = tuple(int(part) for part in args.depths.split(',') if part.strip())
    targets = tuple(float(part) for part in args.targets.split(',') if part.strip())
    artifact = load(args.artifact)

    for line in report(artifact, depths, targets):
        print(line)

    if args.map:
        records = [r for r in artifact.get('questions') or [] if isinstance(r, dict)]
        routes: dict[str, list[dict]] = {}
        for record in records:
            routes.setdefault(route_of(record), []).append(record)
        pairs = []
        for name in (part.strip() for part in args.map.split(',')):
            if not name:
                continue
            if name not in routes:
                raise SystemExit(f'--map named {name!r}, which this artifact has no questions for')
            room = room_for(routes[name], args.map_target)
            if room is None:
                raise SystemExit(f'{name} carries no delivered characters; cannot derive a room')
            pairs.append(f'{name}:{room}')
        print()
        print(f'map at {args.map_target:.0f}% coverage: {",".join(pairs)}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
