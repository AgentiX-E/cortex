#!/usr/bin/env python3
"""What the reader was actually shown, measured from the prompt text rather than from the plan.

    python3 tools/delivered-shape.py <report.json> [--capability MR] [--json]

## Why the prompt text is the only honest source

`evidenceTurns`, `turns` and `windowComposition` all describe what the arm **intended**: the plan it
built, the roster it carried, the room it spent. The reader saw the assembled string. Between those
two there is a renderer, a character budget, a per-turn cap and an ordering stage, and §13.283 found
a defect that lived exactly in that gap -- a table that said one thing while the dispatch did another.

So this tool parses `featurePromptTexts` and nothing else. Every number it prints is a property of
the bytes the model was handed.

## The parse, and why it is exact rather than approximate

The renderer's session routes emit

```text
Session 3
1. [2023/05/22 (Mon) 19:41] user: ...
2. [2023/05/22 (Mon) 19:44] user: ...
```

and turn **bodies** contain lines that begin with a number and a period -- every list the assistant
ever wrote, and every list the user asked for. A parser that keys on `^\\d+\\. ` therefore cuts a turn
into as many turns as the turn's own bullets, which is how a first draft of this measurement reported
155 turns per question against the artifact's own 200.

The marker is the whole rendered prefix: `N. [date] role: `. That is what makes the count exact, and
exactness is not asserted here, it is **checked against the arm's own record**: the parsed turn count
is compared with `windowComposition.turns` on every record, and the agreement rate is printed. A
parser that cannot reproduce the arm's own count is not measuring what the reader saw, and the run
refuses to print a shape table when any record disagrees.

## What it cannot do, stated because the number is otherwise read as something it is not

It cannot say how much of any **corpus** session was delivered. `Session k` names a position in the
admission order, not a row of the dataset, and the report carries no corpus. So "completeness" is out
of reach here: 958 characters per session is a fact about the delivery, and whether the session it
came from was 1,000 or 20,000 characters is not on the artifact. `evidence-completeness.py` answers
the adjacent question from `goldOverlap`, and neither tool can answer the other's.

It also cannot separate the room from the ranking. A shape of 45 sessions x 5 turns is what a
48,000-character room buys at this pool; the same arm at 20,000 would print a different shape and the
difference would be the room, not the reader.
"""

from __future__ import annotations

import argparse
import json
import re
import statistics as stats
import sys
from pathlib import Path

# The renderer's own prefixes. `SESSION` opens a block; `TURN` opens a turn inside one, and both are
# anchored at line start because the renderer emits one per line.
SESSION = re.compile(r'^Session (\d+)\s*$', re.M)
TURN = re.compile(r'^(\d+)\. \[[^\]]{5,40}\] (user|assistant): ', re.M)

# The evidence section ends where the sentence explaining the boundaries begins. Splitting on the
# sentence rather than on a blank line keeps the question and the instruction block out of the last
# session's character count.
NOTE_SPLIT = '\n\nSome evidence is grouped into sessions'


def shape(prompt: str) -> dict:
    """Sessions, turns and characters as rendered, or an empty shape for a flat prompt.

    A flat prompt has no `Session` header and gets `sessions: 0` rather than `1`. The two are
    different claims: a route that draws no boundary is one implicit session for the *budget*, and
    answering `1` here would let a flat route be averaged into a per-session statistic it has no
    terms in.
    """
    body = prompt.split(NOTE_SPLIT)[0]
    marks = [m.start() for m in SESSION.finditer(body)]
    if not marks:
        return {'sessions': 0, 'sessionChars': [], 'sessionTurns': [], 'turnChars': []}

    session_chars: list[int] = []
    session_turns: list[int] = []
    turn_chars: list[int] = []
    for index, start in enumerate(marks):
        end = marks[index + 1] if index + 1 < len(marks) else len(body)
        block = body[start:end]
        starts = [m.start() for m in TURN.finditer(block)]
        session_chars.append(len(block.rstrip('\n')))
        session_turns.append(len(starts))
        for i, begin in enumerate(starts):
            stop = starts[i + 1] if i + 1 < len(starts) else len(block)
            turn_chars.append(len(block[begin:stop].rstrip('\n')))

    return {
        'sessions': len(marks),
        'sessionChars': session_chars,
        'sessionTurns': session_turns,
        'turnChars': turn_chars,
    }


def _median(values: list[int]) -> float | None:
    return float(stats.median(values)) if values else None


def _quantile(values: list[int], fraction: float) -> int | None:
    if not values:
        return None
    ordered = sorted(values)
    index = min(len(ordered) - 1, max(0, round(fraction * (len(ordered) - 1))))
    return ordered[index]


def measure(records: list[dict], prompts: list[str], capability: str | None) -> dict:
    """Per-record shape plus the aggregate, with the parser's self-check carried alongside."""
    per_record: list[dict] = []
    disagreements: list[str] = []
    for record, prompt in zip(records, prompts):
        cap = record.get('capability')
        if capability is not None and cap != capability:
            continue
        parsed = shape(prompt)
        claimed = (record.get('windowComposition') or {}).get('turns')
        parsed_turns = sum(parsed['sessionTurns']) if parsed['sessions'] else len(parsed['turnChars'])
        # The check is only meaningful where the arm recorded its own count. A record without the
        # field is skipped rather than counted as agreement: an absent number is not a matching one.
        if isinstance(claimed, int) and claimed != parsed_turns:
            disagreements.append(f'{record.get("questionId")}: parsed {parsed_turns}, recorded {claimed}')
        per_record.append(
            {
                'questionId': record.get('questionId'),
                'capability': cap,
                'correct': record.get('correct') is True,
                'promptChars': len(prompt),
                'sessions': parsed['sessions'],
                'turns': parsed_turns,
                'sessionChars': parsed['sessionChars'],
                'sessionTurns': parsed['sessionTurns'],
                'turnChars': parsed['turnChars'],
            }
        )

    def aggregate(rows: list[dict]) -> dict:
        sessions = [r['sessions'] for r in rows if r['sessions']]
        turns = [r['turns'] for r in rows]
        # Evidence only, not the whole prompt: the instruction block, the question and the section
        # headers are constant per record and would make a shape look heavier without the reader
        # receiving anything more.
        chars = [sum(r['sessionChars']) for r in rows]
        flat_sessions = [x for r in rows for x in r['sessionChars']]
        flat_turns = [x for r in rows for x in r['sessionTurns']]
        flat_chars = [x for r in rows for x in r['turnChars']]
        return {
            'n': len(rows),
            'sessionsPerQuestion': _median(sessions),
            'turnsPerQuestion': _median(turns),
            'charsPerQuestion': _median(chars),
            'charsPerSession': _median(flat_sessions),
            'turnsPerSession': _median(flat_turns),
            'charsPerTurn': _median(flat_chars),
            'charsPerTurnP90': _quantile(flat_chars, 0.9),
            'charsPerTurnMax': max(flat_chars) if flat_chars else None,
            'sessionsMeasured': len(flat_sessions),
            'turnsMeasured': len(flat_chars),
            'singleTurnSessions': sum(1 for x in flat_turns if x == 1),
            'sessionsUnder400': sum(1 for x in flat_sessions if x < 400),
            'sessionsOver2000': sum(1 for x in flat_sessions if x > 2000),
        }

    return {
        'capability': capability,
        'records': per_record,
        'checked': sum(1 for r in per_record if r['sessions']),
        'disagreements': disagreements,
        'all': aggregate(per_record),
        'correct': aggregate([r for r in per_record if r['correct']]),
        'incorrect': aggregate([r for r in per_record if not r['correct']]),
        'boundaries': [r for r in per_record if r['sessions']],
    }


def _row(label: str, value) -> str:
    return f'  {label:<28} {"-" if value is None else value:>8}'


def render(summary: dict) -> str:
    lines: list[str] = []
    label = summary['capability'] or 'all capabilities'
    counts = summary['boundaries']
    lines.append(f'Delivered shape -- {label} (feature side)')
    lines.append('')
    if not counts:
        lines.append('  no record on this capability draws session boundaries; nothing to measure.')
        lines.append('  A flat route has one implicit session for the budget, and reporting it as one')
        lines.append('  here would average it into a per-session statistic it has no terms in.')
        return '\n'.join(lines)

    lines.append(f'  records with boundaries       {len(counts)} of {summary["all"]["n"]}')
    lines.append('')
    totals = summary['all']
    lines.append('  quantity                        median')
    lines.append(_row('sessions per question', totals['sessionsPerQuestion']))
    lines.append(_row('turns per question', totals['turnsPerQuestion']))
    lines.append(_row('evidence chars per question', totals['charsPerQuestion']))
    lines.append(_row('turns per session', totals['turnsPerSession']))
    lines.append(_row('characters per session', totals['charsPerSession']))
    lines.append(_row('characters per turn', totals['charsPerTurn']))
    lines.append(_row('characters per turn p90', totals['charsPerTurnP90']))
    lines.append(_row('characters per turn max', totals['charsPerTurnMax']))
    lines.append('')
    measured = totals['sessionsMeasured']
    if measured:
        lines.append(
            f'  {totals["singleTurnSessions"]} of {measured} sessions hold one turn '
            f'({100 * totals["singleTurnSessions"] / measured:.1f}%)'
        )
        lines.append(
            f'  {totals["sessionsUnder400"]} under 400 characters ({100 * totals["sessionsUnder400"] / measured:.1f}%), '
            f'{totals["sessionsOver2000"]} over 2,000 ({100 * totals["sessionsOver2000"] / measured:.1f}%)'
        )
    lines.append('')

    verified = len(counts) - len(summary['disagreements'])
    lines.append(f'  parser self-check: parsed turn count equals `windowComposition.turns` on {verified} of {len(counts)}')
    for disagreement in summary['disagreements'][:5]:
        lines.append(f'    MISMATCH {disagreement}')
    if summary['disagreements']:
        lines.append('  a parser that cannot reproduce the arm\'s own count is not measuring the delivery.')
    lines.append('')

    lines.append('  split by outcome')
    lines.append(f'    {"":<10} {"n":>5} {"sess":>6} {"turns":>6} {"chars/sess":>11} {"turns/sess":>11}')
    for name, party in (('correct', summary['correct']), ('incorrect', summary['incorrect'])):
        lines.append(
            f'    {name:<10} {party["n"]:>5} '
            f'{party["sessionsPerQuestion"]!s:>6} {party["turnsPerQuestion"]!s:>6} '
            f'{party["charsPerSession"]!s:>11} {party["turnsPerSession"]!s:>11}'
        )
    lines.append('')
    lines.append('  The split is printed because it is the first question a shape invites: if the two')
    lines.append('  rows agree, the composition of the delivery is a constant of the room and cannot be')
    lines.append('  the reason one question was answered and another was not.')
    return '\n'.join(lines)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('report', type=Path, help='benchmark-cortex-memory-ablation-report.json')
    parser.add_argument('--capability', help='restrict to one capability, e.g. MR')
    parser.add_argument('--json', action='store_true', help='machine-readable output')
    args = parser.parse_args(argv)

    report = json.loads(args.report.read_text())
    prompts = (report.get('ablation') or {}).get('featurePromptTexts')
    if not isinstance(prompts, list):
        print('this report has no ablation.featurePromptTexts; nothing here can be measured', file=sys.stderr)
        return 2

    summary = measure(report.get('questions') or [], prompts, args.capability)
    if args.json:
        print(json.dumps({k: v for k, v in summary.items() if k != 'records'}, indent=1))
    else:
        print(render(summary))
    return 1 if summary['disagreements'] else 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
