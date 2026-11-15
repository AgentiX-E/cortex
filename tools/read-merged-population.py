#!/usr/bin/env python3
"""Read the merged population back into the numbers the rows are registered on.

## Why this is a file and not a heredoc in the workflow

It was a heredoc, and on run `43673528695` it failed a dispatch that had done nothing wrong: the
step required every question id to end in `<marker><windows>` so that it could find the **second**
window, and `S10` is registered on `windows=1` -- one window per corpus, so there is no second one.
The step exited with `refusing: no id ends in #w1, so there is no second window`, the merge job went
red, and the sixteen shards underneath it had all succeeded. The reading was never at risk (the
merged artifact uploads before this step runs), but the run's conclusion said the dispatch failed
when what had failed was a print step that assumed its sibling row's shape.

Inline Python in YAML cannot be tested, and this is what that costs: the shape assumption was
invisible in review, unexercisable in the suite, and paid for by a two-hour dispatch. The logic is
the same logic; it now has a `--windows` / `--pairing` contract and a test file that runs the
`windows=1, pairing=reference` case that broke.

## What it refuses, and what it now declines to refuse

Refused: a merged document whose `population.windows` disagrees with the dispatch's own `windows`
input (the artifact and the dispatch would be describing two experiments), and -- when there really
is a second window -- a roster whose ids do not carry the marker, because the second window is
found by that suffix and a fallback would silently pair the first window with itself.

Declined: the carry reach and the paired delta when the dispatch did not administer them. A
`reference` pairing runs the carry off on both sides by construction, so its `semanticCarry` census
is zeros and `matched < 1` says nothing about the layer; and a one-window population has no second
window to pair against. Both are printed as such rather than warned about, because a `::warning::`
on a dispatch that is behaving exactly as registered is how a real warning stops being read.
"""

from __future__ import annotations

import json
import sys
from math import comb


def mcnemar_exact(b: int, c: int) -> float:
    """Two-sided exact McNemar p, the same formula the analysis scripts use."""
    n = b + c
    if n == 0:
        return 1.0
    tail = sum(comb(n, k) for k in range(0, min(b, c) + 1)) / 2**n
    return min(1.0, 2 * tail)


def per_question_means(vectors: list[str]) -> dict[int, float]:
    """Each position's mean over the repetitions.

    Positional rather than keyed by id: the roster is already checked against every bitstring's
    length below, and a dict keyed by id would let a duplicated id silently overwrite a position.
    """
    return {
        at: sum(1 for bits in vectors if bits[at] == '1') / len(vectors)
        for at in range(len(vectors[0]))
    }


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print(__doc__)
        return 2
    path = argv[0]
    options = {'--windows': None, '--pairing': 'reference'}
    index = 1
    while index < len(argv):
        flag = argv[index]
        if flag not in options:
            raise SystemExit(f'refusing: unknown argument {flag!r}')
        if index + 1 >= len(argv):
            raise SystemExit(f'refusing: {flag} needs a value')
        raw = argv[index + 1]
        options[flag] = int(raw) if flag == '--windows' else raw
        index += 2
    windows_input = options['--windows']
    pairing = options['--pairing']
    if pairing not in ('reference', 'carry'):
        raise SystemExit(f'refusing: --pairing {pairing!r} is neither reference nor carry')

    document = json.load(open(path, encoding='utf-8'))
    windows = document['population']['windows']
    marker = document['population']['marker']
    runs = document['runs']
    if windows_input is not None and windows_input != windows:
        raise SystemExit(
            f'refusing: the dispatch says {windows_input} window(s) and the artifact graded '
            f'{windows}, so the two describe different experiments'
        )

    rows = document['questions']
    ids = [row['questionId'] for row in rows]
    print(
        f"population: {document['population']['corpora']} corpora x {windows} windows "
        f"= {document['questionCount']} questions over {document['merged']['shards']} shards, "
        f'{runs} repetition(s)'
    )

    carry = document.get('semanticCarry')
    if pairing != 'carry':
        # Not a warning: the census is zeros because the dispatch never administered the carry, and
        # `S13` is registered on the `carry` pairing. Reporting "reached no window" here would make
        # every reference dispatch look like a semantic failure.
        print(
            f'carry census (summed): {carry} -- the pairing is {pairing}, so the carry is off on '
            'both sides by construction and S13 is not read from this dispatch'
        )
    else:
        print(f'carry census (summed): {carry}')
        reach = None if carry is None else carry['matched']
        print(f'S13 reach: {reach}  (floor 1)')
        if reach is None or reach < 1:
            print('::warning::the merge reached no window, so S12 stays void rather than pass')

    if windows < 2:
        # `S10`'s shape. Its delta is between two dispatches, not between two windows of one
        # artifact, so this step has nothing to pair -- and saying so is the whole point of the
        # guard, because the alternative is what failed run 43673528695.
        print(
            f'paired delta: not taken -- {windows} window per corpus, so there is no second window '
            'to pair against; S10 is read across its two arms by turn_window_analysis.py'
        )
        return 0

    second = [at for at, question_id in enumerate(ids) if question_id.endswith(f'{marker}{windows}')]
    if not second:
        raise SystemExit(
            f'refusing: no id ends in {marker}{windows} while the artifact graded {windows} '
            'windows, so the roster does not match its own population'
        )
    baseline = document['ablation']['baselineCorrectByRun']
    feature = document['ablation']['featureCorrectByRun']
    for side, vectors in (('baseline', baseline), ('feature', feature)):
        for position, bits in enumerate(vectors):
            if len(bits) != len(ids):
                raise SystemExit(
                    f'refusing: {side} repetition {position} carries {len(bits)} verdicts for '
                    f'{len(ids)} questions, so the bitstring is not aligned with the roster'
                )
    control = per_question_means(baseline)
    treated = per_question_means(feature)
    delta = sum(treated[at] - control[at] for at in second)
    b = sum(1 for at in second if control[at] > treated[at])
    c = sum(1 for at in second if treated[at] > control[at])
    p = mcnemar_exact(b, c)
    print(
        f'second window: n={len(second)}  delta={delta:+.4f} question(s)  '
        f'discordant b={b} c={c}  McNemar p={p:.4f}'
    )
    if pairing == 'carry':
        reach = None if carry is None else carry['matched']
        if reach is not None and reach >= 1:
            if delta < -5:
                print(f'::error::delta {delta:+.1f} is below the -5 floor: S12 fails')
            else:
                print(f'::notice::S12 readable: delta {delta:+.1f} >= -5 with reach {reach}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
