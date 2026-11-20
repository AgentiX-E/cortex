#!/usr/bin/env python3
"""Read the query-expansion dispatch against its control, and say which criteria are readable.

## Why this is a tool and not a paragraph

`docs/PREREGISTRATION-CORTEX-MEMORY-ARM.md` §13.377.4 fixed five criteria before the run:
`E1` the mechanism (MR majority-vote >= 107 of 121), `E2` the bill (<= 8,600 prompt tokens per
question), `E3` the floor (no capability more than 2 questions below the control), `E4` the receipt
(`selfIndex.queries > selfIndex.indexes` on the treatment side, `refused <= 12`) and `E5` the control
side is the control.

Two of those are arithmetic over one artifact and three are comparisons across two, and every one of
them can be **unreadable** rather than failed -- a question that was never judged, a side that reports
no index census, a pair whose question sets differ. The distinction matters more than the verdicts:
`fail` is a reading about the mechanism, `unread` is a reading about the dispatch, and the earlier
attempt at this experiment (`44159514514`) produced only the second kind. A prose summary cannot keep
those apart, and the campaign has already published one number attached to the wrong row because a
reading was taken from an artifact whose population had moved.

## The one estimator this file insists on, and why

`questions[].correct` is the campaign's majority verdict (>= 3 of 4 repetitions, `readout-arm-run.py`
§"the read asks one question of ... three is a majority"), and it is the field the published 84.30%
was counted from. This tool therefore reads that field and **not** `ablation.featureCorrectByRun`:
the bitstrings are in a different order from `questions[]`, and a recomputation over them on `S16`
returns 101 of 121 where the artifact's own verdicts return 102. One question is the whole difference
between "the mechanism bought five" and "the mechanism bought four", so the tool refuses to have a
second estimator at all -- `--selftest` recomputes the control's published MR count from its own
field and prints what it got.

## What it refuses

- a pair whose question sets differ, because a paired comparison over two populations is not one;
- a treatment artifact that does not say `queryExpansion: llm`, because the reading would be about
  the control under the treatment's name -- the defect §13.377.1 found in the first place;
- an `E4` or `E5` verdict computed from a missing census, printed as `unread` and never as a pass.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

# The registered control's own numbers, as the criteria were written against them.
# `S16` = run `44017278305`, the artifact this campaign's 91.25% / 7,448 / 84.30% come from.
CONTROL = {
    'perCapability': {'IE': 137, 'ABS': 30, 'MR': 102, 'TR': 120, 'KU': 67},
    'mr': 102,
    'mrPopulation': 121,
    'promptTokensPerQuestion': 7447.783,
}

# §13.377.4, fixed before the run and not moved after it.
E1_MIN_MR = 107
E2_MAX_TOKENS = 8600.0
E3_MAX_DROP = 2
E4_MAX_REFUSED = 12


class Unreadable(Exception):
    """The artifact cannot answer the criterion. Not the same as a failure."""


def load(path: Path) -> dict:
    with path.open(encoding='utf-8') as handle:
        return json.load(handle)


def by_question(document: dict) -> dict[str, dict]:
    """Questions keyed by id, refusing a roster with duplicates.

    A duplicated id would make the paired comparison silently take one of the two records, and which
    one is an implementation detail of the last write rather than a property of the run.
    """
    out: dict[str, dict] = {}
    for record in document.get('questions', []):
        key = record.get('questionId')
        if key is None:
            raise Unreadable('a question record carries no `questionId`, so nothing can be paired')
        if key in out:
            raise Unreadable(f'`{key}` appears twice in one artifact, so its verdict is ambiguous')
        out[key] = record
    return out


def paired(control: dict, treatment: dict) -> tuple[list[str], list[str]]:
    """The question ids both sides answered, refusing a pair whose rosters differ."""
    left = by_question(control)
    right = by_question(treatment)
    if set(left) != set(right):
        missing = sorted(set(left) - set(right))[:3]
        extra = sorted(set(right) - set(left))[:3]
        raise Unreadable(
            'the two artifacts did not answer the same questions: missing '
            f'{missing or "none"} on the treatment side, extra {extra or "none"}. A paired comparison '
            'over two populations is not a paired comparison.'
        )
    # The treatment's order, because that is the run whose reading is being taken; the pairing itself is
    # by id, so the order only decides how ties in a listing are printed.
    return list(right), list(left)


def exact_mcnemar(b: int, c: int) -> float:
    """Two-sided exact McNemar over the discordant pairs, `b` and `c`.

    Exact rather than the chi-square approximation for the reason the campaign's `stats.ts` gives: at
    `b + c` in the teens the approximation's error is the same size as the effect being read.
    """
    total = b + c
    if total == 0:
        return 1.0
    tail = sum(math.comb(total, k) for k in range(0, min(b, c) + 1))
    return min(1.0, 2 * tail / (2**total))


def capability_counts(records: dict[str, dict], ids: list[str]) -> dict[str, int]:
    counts: dict[str, int] = {}
    specs = set()
    for key in ids:
        record = records[key]
        capability = record.get('capability')
        if capability is None:
            raise Unreadable(f'`{key}` carries no `capability`, so the floor criterion has no cells')
        specs.add(capability)
        if record.get('correct') is True:
            counts[capability] = counts.get(capability, 0) + 1
    for capability in specs:
        counts.setdefault(capability, 0)
    return counts


def population(records: dict[str, dict], ids: list[str]) -> dict[str, int]:
    sizes: dict[str, int] = {}
    for key in ids:
        capability = records[key]['capability']
        sizes[capability] = sizes.get(capability, 0) + 1
    return sizes


def prompt_identity(control: dict, treatment: dict, ids: list[str], skip: str) -> dict:
    """Which prompts moved outside the route the treatment is confined to.

    `E3` is a leak test before it is a floor test: the expansion is routed by
    `expandMultiSessionQueries`'s own rule, so every non-`MR` prompt must be the control's bytes. A
    digest that moved there is a second mechanism, and a delta in that capability is then not the
    expansion's.
    """
    moved = []
    for key in ids:
        left = control[key]
        right = treatment[key]
        if left.get('capability') == skip:
            continue
        if left.get('promptDigest') != right.get('promptDigest'):
            moved.append(
                {
                    'questionId': key,
                    'capability': left.get('capability'),
                    'controlChars': left.get('promptChars'),
                    'treatmentChars': right.get('promptChars'),
                }
            )
    return {'moved': moved, 'checked': len(ids) - population(control, ids).get(skip, 0)}


def receipt(treatment: dict) -> dict:
    """The product's own census: how many queries its index issued against how many it built."""
    config = treatment.get('memoryArmConfig') or {}
    index = config.get('selfIndex') or {}
    counts = config.get('queryExpansionCounts')
    queries = index.get('queries')
    indexes = index.get('indexes')
    out = {
        'declared': config.get('queryExpansion'),
        'queries': queries,
        'indexes': indexes,
        'phrases': None if counts is None else counts.get('phrases'),
        'expandedQuestions': None if counts is None else counts.get('questions'),
        'refused': None if counts is None else counts.get('empty'),
    }
    return out


def bill(document: dict) -> float:
    efficiency = document.get('costEfficiency') or {}
    value = efficiency.get('promptTokensPerQuestion')
    if value is None:
        raise Unreadable('the artifact carries no `costEfficiency.promptTokensPerQuestion`')
    return float(value)


def read(control: dict, treatment: dict) -> dict:
    ids, control_ids = paired(control, treatment)
    left = by_question(control)
    right = by_question(treatment)

    declared = (treatment.get('memoryArmConfig') or {}).get('queryExpansion')
    if declared != 'llm':
        raise Unreadable(
            f"the treatment artifact says `queryExpansion: {declared!r}`, so any delta in it is not the "
            'expansion. §13.377.1 is the record of what that costs: a control reading published under '
            "the treatment's name."
        )

    sizes = population(right, ids)
    control_counts = capability_counts(left, control_ids)
    treatment_counts = capability_counts(right, ids)
    if sizes != population(left, control_ids):
        raise Unreadable('the two artifacts have different per-capability populations')

    # Paired on the majority verdict, which is the field the criteria were written against.
    b = c = 0
    for key in ids:
        was = left[key].get('correct') is True
        now = right[key].get('correct') is True
        if was and not now:
            b += 1
        elif now and not was:
            c += 1

    mr_size = sizes.get('MR')
    mr_control = control_counts.get('MR')
    mr_treatment = treatment_counts.get('MR')
    if mr_size is None or mr_control is None or mr_treatment is None:
        raise Unreadable('the pair has no `MR` cell, which is the population the mechanism targets')

    floor = []
    e3_ok = True
    for capability in sorted(sizes):
        now = treatment_counts[capability]
        was = control_counts[capability]
        delta = now - was
        below = delta < -E3_MAX_DROP
        e3_ok = e3_ok and not below
        floor.append(
            {'capability': capability, 'population': sizes[capability], 'control': was,
             'treatment': now, 'delta': delta, 'belowFloor': below}
        )

    identity = prompt_identity(left, right, ids, skip='MR')
    # A leak and a moved baseline are the same observation until the size is read. The treatment is
    # confined to `MR` by `expandMultiSessionQueries`'s own routing rule, so a handful of moved digests
    # outside it is a leak into another capability; most of them is the two dispatches not sharing a
    # prompt baseline at all, and then the floor deltas are unattributable rather than leaky. The line is
    # at half because the two cases are an order of magnitude apart in practice -- a leak moves the cells
    # a mechanism reached, a drifted table moves every cell.
    drifted = identity['checked'] > 0 and len(identity['moved']) * 2 > identity['checked']
    landed = receipt(treatment)
    treatment_bill = bill(treatment)
    control_bill = bill(control)

    e1 = mr_treatment - mr_control
    e1_pass = mr_treatment >= E1_MIN_MR
    mcnemar = exact_mcnemar(b, c)
    e2_pass = treatment_bill <= E2_MAX_TOKENS
    leak = len(identity['moved'])
    e3_pass = e3_ok and leak == 0

    if landed['queries'] is None or landed['indexes'] is None:
        e4 = 'unread'
        e5 = 'unread'
        # Both details are written on the unreadable path as well: the renderer prints every criterion,
        # and a branch that leaves one undefined turns "this criterion cannot be read" into
        # `UnboundLocalError` -- the tool failing where it was supposed to report. Found by the tests for
        # the very case it was supposed to handle, not by reading it.
        e4_detail = 'the artifact carries no `selfIndex.queries`/`indexes` pair'
        e5_detail = 'the artifact carries no `selfIndex.queries`/`indexes` pair, on either side'
    else:
        e4 = 'pass' if (landed['queries'] > landed['indexes']
                        and (landed['refused'] or 0) <= E4_MAX_REFUSED) else 'fail'
        e4_detail = (f"queries {landed['queries']} vs indexes {landed['indexes']}, "
                     f"refused {landed['refused']}")
        # E5 reads the control side. The registered control is a system that builds no product index --
        # `relevanceSignal` is `self-index` on the arm and the paired baseline does not rank with it -- so
        # a control artifact with no census is the registered shape rather than a missing reading, and the
        # criterion is `unread` with that reason stated instead of being scored as a pass.
        control_index = (control.get('memoryArmConfig') or {}).get('selfIndex') or {}
        if control_index.get('queries') is None:
            e5 = 'unread'
            e5_detail = 'the control side reports no self-index census, so `queries == indexes` cannot be read'
        else:
            e5 = 'pass' if control_index.get('queries') == control_index.get('indexes') else 'fail'
            e5_detail = f"control queries {control_index.get('queries')} vs indexes {control_index.get('indexes')}"

    return {
        'population': sizes,
        'mr': {
            'population': mr_size,
            'control': mr_control,
            'treatment': mr_treatment,
            'delta': e1,
            'threshold': E1_MIN_MR,
            'controlRate': round(mr_control / mr_size, 4),
            'treatmentRate': round(mr_treatment / mr_size, 4),
            'discordant': {'fixed': c, 'broken': b},
            'mcnemarP': round(mcnemar, 6),
        },
        'floor': floor,
        'promptIdentity': identity,
        'bill': {
            'control': round(control_bill, 3),
            'treatment': round(treatment_bill, 3),
            'ceiling': E2_MAX_TOKENS,
            'ratio': round(treatment_bill / control_bill, 4) if control_bill else None,
        },
        'receipt': landed,
        'criteria': {
            'E1': {'verdict': 'pass' if e1_pass else 'fail', 'measured': f'{mr_treatment} of {mr_size}',
                   'threshold': f'>= {E1_MIN_MR}'},
            'E2': {'verdict': 'pass' if e2_pass else 'fail',
                   'measured': f'{treatment_bill:.1f} tokens per question',
                   'threshold': f'<= {E2_MAX_TOKENS:.0f}'},
            'E3': {
                'verdict': 'unread' if drifted else ('pass' if e3_pass else 'fail'),
                'measured': (
                    f'{leak} of {identity["checked"]} non-MR prompts moved, '
                    f'{sum(1 for row in floor if row["belowFloor"])} capability(ies) below floor'
                    + (' -- the two dispatches do not share a prompt baseline, so a floor delta is not '
                       'attributable to the expansion' if drifted else '')
                ),
                'threshold': '0 moved, no capability more than 2 below',
            },
            'E4': {'verdict': e4, 'measured': e4_detail,
                   'threshold': f'queries > indexes, refused <= {E4_MAX_REFUSED}'},
            'E5': {'verdict': e5, 'measured': e5_detail, 'threshold': 'control queries == indexes'},
        },
    }


def render(reading: dict) -> str:
    mr = reading['mr']
    bill_row = reading['bill']
    lines = [
        '## Query expansion on the product ranking (S17)',
        '',
        '| | control | treatment | delta |',
        '| --- | ---: | ---: | ---: |',
        f"| `MR` majority verdicts | {mr['control']} of {mr['population']} "
        f"({mr['controlRate'] * 100:.2f}%) | {mr['treatment']} of {mr['population']} "
        f"({mr['treatmentRate'] * 100:.2f}%) | **{mr['delta']:+d}** |",
        f"| prompt tokens per question | {bill_row['control']:.1f} | {bill_row['treatment']:.1f} | "
        f"{bill_row['ratio']:.3f}x |",
        '',
        f"Discordant on `MR`: fixed {mr['discordant']['fixed']}, broken {mr['discordant']['broken']}, "
        f"exact McNemar p = {mr['mcnemarP']:.4f}.",
        '',
        '| capability | population | control | treatment | delta |',
        '| --- | ---: | ---: | ---: | ---: |',
    ]
    for row in reading['floor']:
        marker = ' **below floor**' if row['belowFloor'] else ''
        lines.append(
            f"| {row['capability']} | {row['population']} | {row['control']} | "
            f"{row['treatment']} | {row['delta']:+d}{marker} |"
        )
    identity = reading['promptIdentity']
    lines.append('')
    lines.append(
        f"Prompt identity outside `MR`: {len(identity['moved'])} of {identity['checked']} digests moved."
    )
    for moved in identity['moved'][:5]:
        lines.append(
            f"  - `{moved['questionId']}` ({moved['capability']}): "
            f"{moved['controlChars']} -> {moved['treatmentChars']} chars"
        )
    lines.append('')
    lines.append('| criterion | verdict | measured | threshold |')
    lines.append('| --- | --- | --- | --- |')
    for name in ('E1', 'E2', 'E3', 'E4', 'E5'):
        row = reading['criteria'][name]
        lines.append(f"| `{name}` | **{row['verdict']}** | {row['measured']} | {row['threshold']} |")
    return '\n'.join(lines) + '\n'


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--control', type=Path, required=True)
    parser.add_argument('--treatment', type=Path, required=True)
    parser.add_argument('--json', action='store_true', help='print the reading as JSON')
    parser.add_argument(
        '--check',
        action='store_true',
        help='exit 1 when a criterion is unreadable; a failed criterion is a reading and exits 0',
    )
    parser.add_argument(
        '--selftest',
        action='store_true',
        help="recompute the control's own MR count from `questions[].correct` and print it",
    )
    args = parser.parse_args(sys.argv[1:] if argv is None else argv)

    try:
        control = load(args.control)
        treatment = load(args.treatment)
        if args.selftest:
            # The estimator's own check, against the number the campaign published. If this ever
            # disagrees, the field it reads is not the field `84.30%` was counted from, and every `E1`
            # reading this tool produces inherits the difference.
            control_ids = list(by_question(control))
            counts = capability_counts(by_question(control), control_ids)
            measured = counts.get('MR')
            print(f"control `questions[].correct` on MR: {measured} "
                  f"(published {CONTROL['mr']} of {CONTROL['mrPopulation']})")
            if measured != CONTROL['mr']:
                print('selftest FAILED: this artifact is not the control the criteria were written against',
                      file=sys.stderr)
                return 1
        reading = read(control, treatment)
    except (Unreadable, OSError) as error:
        print(f'unreadable: {error}', file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(reading, indent=2, ensure_ascii=False))
    else:
        print(render(reading))

    unreadable = [name for name, row in reading['criteria'].items() if row['verdict'] == 'unread']
    if args.check and unreadable:
        print(f'unreadable criteria: {", ".join(unreadable)}', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
