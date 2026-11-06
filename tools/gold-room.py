#!/usr/bin/env python3
"""How much of the missing gold a perfect selector could have delivered inside the budget.

## The question this answers, and the one it refuses

`evidence-depth.py` turns `goldRanks` into a coverage-versus-depth curve, so it prices the budget in
**turns**. That is the right unit for a budget decision and the wrong unit for a selector decision: a
ranking that reordered the candidates could not exceed the depth the budget buys, but whether a
particular question's gold *fits* depends on how many characters those turns are, which the curve does
not know. §13.268.3 priced the budget at 2.1x to 6.0x on that curve, and the next axis depends on
knowing whether the shortfall is a matter of *order* or of *room*.

For one question the arithmetic is exact and needs no provider call:

```text
need = sum(len(gold turn)) + (deliveredPromptChars - promptChars)
```

where the second term is the **measured** per-record overhead -- the instruction block, the question
and the section headers, `deliveredPromptChars - promptChars` on that same record -- and the budget is
`memoryArmConfig.maxPromptChars`. If `need <= maxPromptChars` the evidence could have been delivered
had the selector chosen it, and the failure is selection. If `need > maxPromptChars` no ordering helps,
and the failure is room: the fix has to be denser evidence or a summariser, not a ranker.

## Why `goldTurns` and not `turns`

`turns` holds what the reader was shown. A gold turn the budget cut left with the budget, so it is not
in `turns`, and a tool that summed `turns` would measure the delivery it already has. `goldTurns`
carries the text of every gold turn, delivered or not, which is the field §13.267 needed and
§13.268.7 found an absent list of turning into a sum of zero.

So an artifact that lacks the field is refused rather than read. A record with `total > 0` and no
`goldTurns` is not a record whose gold costs nothing; it is a record this tool cannot price.

## The two directions of the character cap

`maxTurnChars` is applied when the prompt is rendered, and `turnText` does not truncate, so
`goldTurns` holds the **uncapped** text while the delivery was **capped**. Summing the uncapped list
therefore over-states the cost, and a question it reports as fitting certainly fits. Both readings are
printed: `uncapped` is the conservative one and `capped` is what the renderer would actually spend. A
question that fits under `uncapped` is resolved; one that fits only under `capped` is a judgement the
report shows and does not decide.

## What it does not claim

Fitting is not answering. A question whose gold fits may still be answered wrongly, and §13.265.6
measured a manipulation on this population that fixed none and broke ten. This tool bounds what any
selector could deliver; the restore counterfactual of §13.267 is what says whether delivering it
helps. It prints a count and refuses to call it a gain.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path


def load(path: Path) -> dict:
    with path.open() as handle:
        return json.load(handle)


def overhead_of(record: dict) -> int | None:
    """The per-record decoration, measured, or `None` when the pair that measures it is absent.

    `deliveredPromptChars - promptChars` is the only subtraction that decomposes a prompt, and the
    artifact's own audit already holds `deliveredPromptChars >= promptChars`. Absent is not zero: a
    record without the pair has an unknown overhead, and pricing the gold alone would understate the
    need by an unbounded amount -- an artifact from before §13.231 would then report every question as
    fitting purely because it never counted the instructions.
    """
    whole = record.get('deliveredPromptChars')
    evidence = record.get('promptChars')
    if not isinstance(whole, int) or not isinstance(evidence, int):
        return None
    return whole - evidence


def classify(record: dict, budget: int, cap: int | None) -> dict | None:
    """One record's verdict, or `None` when the record names no gold."""
    overlap = record.get('goldOverlap')
    if not isinstance(overlap, dict):
        return None
    total = overlap.get('total')
    if not isinstance(total, int) or total <= 0:
        return None
    turns = overlap.get('goldTurns')
    if not isinstance(turns, list) or len(turns) != total:
        return {
            'questionId': record.get('questionId'),
            'capability': record.get('capability'),
            'refused': 'goldTurns',
            'total': total,
        }
    overhead = overhead_of(record)
    if overhead is None:
        return {
            'questionId': record.get('questionId'),
            'capability': record.get('capability'),
            'refused': 'overhead',
            'total': total,
        }
    ranks = overlap.get('goldRanks') or []
    delivered = overlap.get('goldDelivered') or []
    return {
        'questionId': record.get('questionId'),
        'capability': record.get('capability'),
        'total': total,
        'carried': overlap.get('carried'),
        # Every gold turn reached the ranking. When false the selector never had the choice, and a
        # question in that state is a pool question rather than a selection question -- §13.268.1
        # closed that population at k=512, so it should be near empty and is printed when it is not.
        'all_offered': bool(ranks) and all(isinstance(rank, int) and rank >= 0 for rank in ranks),
        'delivered_flags': len(delivered),
        'need_uncapped': sum(len(turn) for turn in turns) + overhead,
        'need_capped': sum(min(len(turn), cap) for turn in turns) + overhead if cap else None,
        'overhead': overhead,
    }


def census(report: dict, budget: int, cap: int | None) -> dict:
    records = report.get('questions') or []
    refused: list[dict] = []
    rows: list[dict] = []
    for record in records:
        verdict = classify(record, budget, cap)
        if verdict is None:
            continue
        if 'refused' in verdict:
            refused.append(verdict)
        else:
            rows.append(verdict)
    return {'rows': rows, 'refused': refused}


def summarise(rows: list[dict], budget: int, cap: int | None) -> dict[str, dict[str, int]]:
    by: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for row in rows:
        bucket = by[row['capability']]
        bucket['n'] += 1
        if row['carried'] is not None and row['carried'] >= row['total']:
            bucket['full'] += 1
            continue
        bucket['partial'] += 1
        if row['all_offered']:
            bucket['partial_all_offered'] += 1
        else:
            bucket['partial_not_offered'] += 1
            continue
        if row['need_uncapped'] <= budget:
            bucket['reachable_uncapped'] += 1
        else:
            # The conservative reading is the one that decides, because it is the only one that
            # cannot be wrong: `goldTurns` holds uncapped text and the render cap can only lower the
            # cost, never raise it. A question it calls room may still fit once capped -- which is
            # what the next column reports -- but a question it calls fitting certainly fits.
            bucket['irreducible'] += 1
        if cap is not None and row['need_capped'] is not None and row['need_capped'] <= budget:
            bucket['reachable_capped'] += 1
    return {capability: dict(bucket) for capability, bucket in sorted(by.items())}


def render(summary: dict[str, dict[str, int]], refused: list[dict], budget: int, cap: int | None) -> str:
    lines = [
        f'room: {budget:,} characters per prompt'
        + (f'; turns rendered at {cap:,} characters' if cap else '; no per-turn cap recorded'),
        '',
        f'{"capability":<20} {"n":>4} {"full":>5} {"partial":>8} {"offered":>8} '
        f'{"fits":>6} {"fits@cap":>9} {"room":>6}',
    ]
    for name, bucket in summary.items():
        lines.append(
            f'{name:<20} {bucket.get("n", 0):>4} {bucket.get("full", 0):>5} '
            f'{bucket.get("partial", 0):>8} {bucket.get("partial_all_offered", 0):>8} '
            f'{bucket.get("reachable_uncapped", 0):>6} {bucket.get("reachable_capped", 0):>9} '
            f'{bucket.get("irreducible", 0):>6}'
        )
    lines.append('')
    lines.append('  `offered`  the ranking surfaced every gold turn, so the selector had the choice')
    lines.append('  `fits`     every gold turn plus the measured overhead is inside the budget (uncapped text)')
    lines.append('  `fits@cap` the same arithmetic with each turn at the render cap; a judgement, not a finding')
    lines.append('  `room`     does not fit: no ordering helps and the fix has to be denser evidence')
    if refused:
        kinds: dict[str, int] = defaultdict(int)
        for row in refused:
            kinds[row['refused']] += 1
        detail = ', '.join(f'{count} for {kind}' for kind, count in sorted(kinds.items()))
        lines.append('')
        lines.append(f'REFUSED: {len(refused)} record(s) name gold this tool cannot price ({detail}).')
        first = refused[0]
        lines.append(
            f'  first: {first.get("questionId")} with total {first.get("total")} -- '
            'an absent list is not a list of zero-length turns (13.268.7)'
        )
    return '\n'.join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('artifact', type=Path, help='a cortex-memory ablation artifact')
    parser.add_argument('--max-chars', type=int, help="override the artifact's maxPromptChars")
    arguments = parser.parse_args(argv)

    report = load(arguments.artifact)
    config = report.get('memoryArmConfig') or {}
    budget = arguments.max_chars or config.get('maxPromptChars')
    if not isinstance(budget, int) or budget <= 0:
        print(
            f'{arguments.artifact}: no maxPromptChars on the artifact and none supplied, so there is '
            'no budget to price the gold against',
            file=sys.stderr,
        )
        return 2
    cap = config.get('maxTurnChars')
    cap = cap if isinstance(cap, int) and cap > 0 else None

    measured = census(report, budget, cap)
    if not measured['rows'] and not measured['refused']:
        print(f'{arguments.artifact}: no record names any gold turn', file=sys.stderr)
        return 2
    if measured['refused']:
        print(render({}, measured['refused'], budget, cap), file=sys.stderr)
        return 2
    print(render(summarise(measured['rows'], budget, cap), [], budget, cap))
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
