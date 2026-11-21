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

## The two defects `pairing=clock` found, both of them shapes rather than typos

Run `44891901371` was the boundary clock's first dispatch: four shards green, merge merged, and this
script then exited `1` with `--pairing 'clock' is neither reference nor carry`. Two things were wrong
and only the first was a vocabulary:

1. **The closed set was here, in a second copy.** `arm-pairing.ts` builds the pairings, the dispatcher
   refuses a value outside the same set, and this script had its own two-word list -- so `clock`
   passed the gate written for it and failed the gate that was not. The set is now one constant, and
   `test_the_pairing_vocabulary_is_the_arms_vocabulary` holds it to the union by reading both.
2. **The `windows < 2` guard assumed the pair is across dispatches.** That is true for `reference`,
   where the two sides are two *systems* and `S10` reads its delta across two arms. It is false for a
   pairing that puts one flag between the sides: `pairing=clock` at one window is the experiment, and
   the guard returned `0` -- success -- having printed that there was nothing to pair. A green step
   that measured nothing is worse than the red one, because nobody re-reads it.
"""

from __future__ import annotations

import json
import sys
from math import comb

# The pairings `arm-pairing.ts` can build. One constant, held to that union by
# `test_the_pairing_vocabulary_is_the_arms_vocabulary`, because a closed set copied into a reader is a
# closed set that will fall out of step -- measured, not hypothesised: see this file's header.
PAIRINGS = ('reference', 'carry', 'clock', 'resolution')

# Which `featureConfig` field says the arm built this pairing, for the pairings that put ONE FLAG of the
# same system between their sides.
#
# A table rather than a chain of `if pairing == ...`, and the reason is measured rather than aesthetic:
# the chain was one branch at one flag, two branches plus a mirrored `elif` at two, and each new pairing
# had to remember to extend the mirrored branch as well -- a statement about one run written twice, which
# is the shape this file's header exists to stop. `reference` is absent because it has no flag of its own:
# any pair flag on a reference artifact says the artifact is not this dispatch.
PAIR_FLAGS = {
    'carry': 'carryPair',
    'clock': 'clockPair',
    'resolution': 'resolutionPair',
}

# Derived rather than restated: a second tuple of the same names would be a second place to forget.
# These are the pairings whose delta is the flag's whatever the window count is, which is what the
# `windows < 2` guard below has to know.
ONE_FLAG_PAIRINGS = tuple(PAIR_FLAGS)

# `C7`'s `F3`, as the two clauses it is written with. Restated here rather than read from the
# pre-registration, because the numbers ARE the criterion and a script that looked them up could be made
# to agree with any reading by editing the document it looked them up in.
F3_TURN_FLOOR_PCT = 20.0
F3_CHAR_TOLERANCE_PCT = 2.0

# `C8`'s `G1`, `G2` and `G4`, restated for the same reason. `G1` is registered as "150 of 500", which is
# 30% of the population -- written as the share so a 121-question run is judged by the same criterion
# instead of by a floor it could never reach, and so a 500-question run is not silently held to 150 when
# its own population says otherwise.
#
# `G2` is the pair `C7`'s `F3` forbids: characters DOWN and turns UP. That is the reallocation signature,
# and it is the reason the two families need separate criteria rather than one amended one -- `F3` asked
# for characters unchanged, and the data took the other branch.
G1_FORMED_SHARE = 0.30
G2_CHAR_DROP_PCT = 3.0
G2_TURN_RISE_PCT = 1.0
G4_RECORD_RATIO = 1.5


def _median(values: list[float]) -> float:
    """The median of a non-empty list, as a float so an even count's midpoint is not truncated."""
    ordered = sorted(values)
    count = len(ordered)
    middle = count // 2
    if count % 2:
        return float(ordered[middle])
    return (ordered[middle - 1] + ordered[middle]) / 2


def _number(value: float) -> str:
    """`13` and `40150` rather than `13.0` and `40150.0`, and `19.5` kept as it is."""
    return f'{value:.0f}' if float(value).is_integer() else f'{value:.1f}'


def delivered_medians(document: dict) -> tuple[float, float, float, float]:
    """The four medians `F3` and `C8`'s `G2` both divide: turns and characters, on both sides.

    One extraction with two claims hanging off it, because the two claims disagree about the direction and
    must still be about the same numbers: `F3` requires characters within +-2% while turns rise, `G2`
    requires characters DOWN while turns rise. A reading where each claim computed its own medians could
    publish both verdicts from two slightly different populations and nobody would see why.

    The feature side reads off the roster, the baseline side off the ablation. Not symmetric, and the
    asymmetry is what the artifact already is: `questions` is one row per question for the FEATURE -- it
    carries that side's `roleCensus` and `promptChars` -- while the baseline's two numbers have no row to
    live in and travel as vectors. Reading the feature side out of `ablation` would need a second copy of
    `promptTexts` in the merged document, which is the whole corpus an extra time.
    """
    ablation = document.get('ablation', {}) or {}
    rows = document.get('questions', []) or []
    baseline_censuses = ablation.get('baselineRoleCensuses')
    baseline_chars = ablation.get('baselinePromptChars')
    missing = [
        name
        for name, vector in (
            ('baseline role census', baseline_censuses),
            ('baseline prompt chars', baseline_chars),
        )
        if not vector
    ]
    if missing:
        raise SystemExit(
            f'refusing: no density reading -- the artifact carries no {", ".join(missing)}. C7\'s F3 '
            'divides two medians of one population, and a median over an absent side is not zero.'
        )
    baseline_turns = [c['total'] for c in baseline_censuses if c is not None]
    baseline_lengths = [n for n in baseline_chars if n is not None]
    feature_turns = [
        row['roleCensus']['total'] for row in rows if isinstance(row.get('roleCensus'), dict)
    ]
    feature_lengths = [row['promptChars'] for row in rows if row.get('promptChars') is not None]
    if not baseline_turns or not feature_turns or not baseline_lengths or not feature_lengths:
        raise SystemExit(
            'refusing: no density reading -- one side reported a null for every question, so it exposed no '
            'window to count. A `reference` pairing produces exactly that for its baseline: the reference '
            'pipeline has no classifier, so F3 cannot be read off it.'
        )
    return (
        _median(baseline_turns),
        _median(feature_turns),
        _median(baseline_lengths),
        _median(feature_lengths),
    )


def print_density(document: dict) -> None:
    """`F3`'s two medians: turns delivered against characters of prompt, on both sides of one roster.

    The mechanism under test changes **what a long turn becomes**, so the claim it makes is density --
    the same budget holding more turns -- and the only thing that separates density from a narrower
    prompt is that the character median does not move. Both medians therefore have to come from one
    pass: `§11.13` measured a 0.70-point floor across dispatches, and a ratio whose two halves came
    from two runs would be a ratio of two other differences.

    Nothing is printed when either side reports no census. A median over an empty side is not zero --
    it is no measurement -- and `0` there would read as "the control delivered no turns", which is the
    strongest possible claim from no evidence.
    """
    turns_before, turns_after, chars_before, chars_after = delivered_medians(document)
    turn_change = (turns_after - turns_before) / turns_before * 100 if turns_before else 0.0
    char_change = (chars_after - chars_before) / chars_before * 100 if chars_before else 0.0
    print(
        f'turns median {_number(turns_before)} -> {_number(turns_after)}  ({turn_change:+.1f}%)'
    )
    print(
        f'chars median {_number(chars_before)} -> {_number(chars_after)}  ({char_change:+.1f}%)'
    )
    if turn_change < F3_TURN_FLOOR_PCT:
        print(
            f'F3 fail: turns {turn_change:+.1f}% is below the +{F3_TURN_FLOOR_PCT:.0f}% floor, so the room '
            'did not buy more events and this family closes'
        )
    elif abs(char_change) > F3_CHAR_TOLERANCE_PCT:
        print(
            f'F3 fail: chars {char_change:+.1f}% is outside the +-{F3_CHAR_TOLERANCE_PCT:.0f}% band, which '
            'is a wider or narrower prompt rather than a denser one'
        )
    else:
        print(
            f'F3 pass  (turns {turn_change:+.1f}% >= +{F3_TURN_FLOOR_PCT:.0f}%, chars {char_change:+.1f}% '
            f'within +-{F3_CHAR_TOLERANCE_PCT:.0f}%)'
        )


def record_shares(rows: list[dict]) -> dict[int, float]:
    """Each question's share of delivered turns rendered by the compressing form, keyed by position.

    Keyed by position rather than id for the reason `per_question_means` is: the roster's ids are already
    checked for duplicates at construction, and a dict keyed by id would let a duplicate silently overwrite
    a question.

    Absent rather than `0.0` for a question whose census carries no split. `0` would be a statement -- "no
    turn was compressed" -- and a question that reported `{cut: 0, whole: 4}` never counted a form at all:
    the head cut decides a length rather than choosing between renderings. Folding the two would put
    uncapped questions in the denominator of `G4`'s median as zeros, which drags the comparison toward the
    answer the criterion is testing for.
    """
    shares: dict[int, float] = {}
    for position, row in enumerate(rows):
        census = row.get('turnWindowCensus')
        if not isinstance(census, dict):
            continue
        forms = census.get('forms')
        if not isinstance(forms, dict):
            continue
        total = sum(
            part.get('turns', 0) for part in forms.values() if isinstance(part, dict)
        )
        if total <= 0:
            continue
        record_turns = forms.get('record', {}).get('turns', 0)
        shares[position] = record_turns / total
    return shares


def print_forms(document: dict, control: dict[int, float], treated: dict[int, float]) -> None:
    """`C8`'s three form-shaped criteria: `G1`, `G2` and `G4`.

    ## Why these three and not the accuracy one

    `G3` is the accuracy claim and the delta line above is its reading -- printing it again here would be a
    second number that could drift from the first. `G5` is priced in tokens, which is a conversion this
    artifact does not carry (it carries characters); the token reader does that division. What is left is
    the part that only the **form split per question** can answer, and that is what this function reads.

    ## What each criterion is for, in one line

    | # | claim | failure means |
    | --- | --- | --- |
    | `G1` | the mechanism ran: a form rendered at least one turn on >= 30% of questions | nothing to read, the run is void |
    | `G2` | the reallocation signature: characters DOWN >= 3% while turns UP >= 1% | the direction `C7` predicted did not appear |
    | `G4` | the gain is concentrated where records dominate: median record share among gainers >= 1.5x the population's | the mechanism helps, but not for this reason |

    `G4` divides the gainers' median share by the whole population's, and the denominator is over the
    questions that **reported a split** rather than over all of them: a question the cap never touched has
    no share, and counting it as zero would make any gainer look concentrated.
    """
    rows = document.get('questions', []) or []
    shares = record_shares(rows)
    formed = sum(
        1
        for row in rows
        if isinstance(row.get('turnWindowCensus'), dict)
        and isinstance(row['turnWindowCensus'].get('forms'), dict)
    )
    compressed = sum(
        1
        for row in rows
        if isinstance(row.get('turnWindowCensus'), dict)
        and isinstance(row['turnWindowCensus'].get('forms'), dict)
        and row['turnWindowCensus']['forms'].get('record', {}).get('turns', 0)
        + row['turnWindowCensus']['forms'].get('excerpt', {}).get('turns', 0)
        > 0
    )
    floor = G1_FORMED_SHARE * len(rows)
    print(
        f'forms: {formed}/{len(rows)} questions rendered by a form '
        f'(record or excerpt on {compressed})  -- G1 floor {floor:.0f}'
    )
    if compressed >= floor and floor > 0:
        print(f'G1 pass  {compressed} >= {floor:.0f} (the forms reached the population)')
    else:
        print(
            f'G1 fail: {compressed} of {len(rows)} questions had a compressed or widened turn, below the '
            f'{G1_FORMED_SHARE:.0%} floor. Either `resolution` never reached the renderer or it rendered '
            'every long turn as raw -- and neither is a reading of the mechanism'
        )

    turns_before, turns_after, chars_before, chars_after = delivered_medians(document)
    char_change = (chars_after - chars_before) / chars_before * 100 if chars_before else 0.0
    turn_change = (turns_after - turns_before) / turns_before * 100 if turns_before else 0.0
    if char_change <= -G2_CHAR_DROP_PCT and turn_change >= G2_TURN_RISE_PCT:
        print(
            f'G2 pass  chars {char_change:+.1f}% <= -{G2_CHAR_DROP_PCT:.0f}% with turns '
            f'{turn_change:+.1f}% >= +{G2_TURN_RISE_PCT:.0f}% (the reallocation signature)'
        )
    else:
        print(
            f'G2 fail: chars {char_change:+.1f}% and turns {turn_change:+.1f}% do not show characters '
            f'leaving while turns stay or rise (needs <= -{G2_CHAR_DROP_PCT:.0f}% and >= '
            f'+{G2_TURN_RISE_PCT:.0f}%), so the direction C8 predicts did not appear'
        )

    gainers = [at for at in shares if treated.get(at, 0.0) > control.get(at, 0.0)]
    if not gainers:
        print(
            'G4 not taken: no question improved on this population, so there is no gainer set to '
            'compare a form share against -- and a ratio over an empty numerator is not a reading'
        )
        return
    gainer_median = _median([shares[at] for at in gainers])
    population_median = _median(list(shares.values()))
    ratio = gainer_median / population_median if population_median else float('inf')
    print(
        f'record share median: gainers {gainer_median:.3f} (n={len(gainers)}) vs population '
        f'{population_median:.3f} (n={len(shares)})  ratio {ratio:.2f}'
    )
    if ratio >= G4_RECORD_RATIO:
        print(
            f'G4 pass  gainers {gainer_median:.3f} are >= {G4_RECORD_RATIO:.1f}x the population '
            f'{population_median:.3f} (the gain is concentrated where records dominate)'
        )
    else:
        print(
            f'G4 fail: gainers {gainer_median:.3f} are only {ratio:.2f}x the population '
            f'{population_median:.3f}, below {G4_RECORD_RATIO:.1f}x -- the mechanism helps, but not for '
            'the reason C8 claims'
        )


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
    if pairing not in PAIRINGS:
        raise SystemExit(
            f'refusing: --pairing {pairing!r} is not one of {", ".join(PAIRINGS)}. `reference` is the '
            "registered pair, `carry` is the semantic layer's instrument, `clock` is the boundary "
            "clock's and `resolution` is C7's rendering form. A pairing this reader does not know is a "
            'delta it would print under a name that does not describe it.'
        )

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

    # The dispatch names the pair; the artifact records which pair it built. Two statements about one
    # run, and the numbers below are read as the flag's only if they agree. Refused rather than
    # printed, because the alternative is a delta attributed to a flag the arm never moved.
    feature_config = document.get('featureConfig', {}) or {}
    expected_flag = PAIR_FLAGS.get(pairing)
    # The artifact's own claim first, because that is the sentence that names the disagreement: "the
    # artifact says clockPair while the dispatch says carry" tells a reader which of the two is wrong,
    # where "the artifact does not say carryPair" leaves them to infer it from an absence.
    claimed = sorted(
        name
        for name in PAIR_FLAGS.values()
        if name != expected_flag and feature_config.get(name) is True
    )
    if claimed:
        raise SystemExit(
            f'refusing: the artifact says {", ".join(claimed)} while the dispatch says --pairing '
            f'{pairing}. The delta belongs to whichever pair the run actually built, and the two '
            'statements disagree.'
        )
    if expected_flag is not None and feature_config.get(expected_flag) is not True:
        raise SystemExit(
            f'refusing: the dispatch says --pairing {pairing} and the artifact does not say '
            f'{expected_flag}. Either the arm built another pair (so these numbers are not one flag), '
            'or the artifact predates the field -- and neither can be read as this pairing.'
        )

    if windows < 2 and pairing not in ONE_FLAG_PAIRINGS:
        # `S10`'s shape. Its delta is between two dispatches, not between two windows of one
        # artifact, so this step has nothing to pair -- and saying so is the whole point of the
        # guard, because the alternative is what failed run 43673528695.
        print(
            f'paired delta: not taken -- {windows} window per corpus, so there is no second window '
            'to pair against; S10 is read across its two arms by turn_window_analysis.py'
        )
        return 0

    if windows < 2:
        # A one-flag pair at one window, which is the boundary clock's registered shape: there is no
        # second window to find, and the two sides already differ by the one flag this artifact was
        # dispatched to move. Reading it over the whole population is the reading -- and the scope is
        # said out loud, because "second window" and "whole population" are different denominators
        # and a reader comparing two runs has to know which one a delta came from.
        scope = list(range(len(ids)))
        scope_label = 'whole population'
    else:
        scope = [
            at for at, question_id in enumerate(ids) if question_id.endswith(f'{marker}{windows}')
        ]
        scope_label = 'second window'
        if not scope:
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
    delta = sum(treated[at] - control[at] for at in scope)
    b = sum(1 for at in scope if control[at] > treated[at])
    c = sum(1 for at in scope if treated[at] > control[at])
    p = mcnemar_exact(b, c)
    print(
        f'{scope_label}: n={len(scope)}  delta={delta:+.4f} question(s)  '
        f'discordant b={b} c={c}  McNemar p={p:.4f}'
    )
    if pairing == 'carry':
        reach = None if carry is None else carry['matched']
        if reach is not None and reach >= 1:
            if delta < -5:
                print(f'::error::delta {delta:+.1f} is below the -5 floor: S12 fails')
            else:
                print(f'::notice::S12 readable: delta {delta:+.1f} >= -5 with reach {reach}')
    if pairing == 'resolution':
        # After the accuracy line and deliberately not instead of it: `F3` is a gate that closes a family
        # before accuracy is read, but a run that is already paid for should report both, and reading them
        # in that order is what keeps a `F3 fail` from being argued with by a delta that looks fine.
        #
        # `print_forms` follows `print_density` because `C8` is the hypothesis `C7`'s failure pointed at:
        # the same rendering, a different claim. Both are printed for a `resolution` dispatch, and the two
        # verdicts are allowed to disagree -- `F3 fail` with `G2 pass` is not a contradiction, it is the
        # finding that the mechanism reallocates rather than densifies.
        print_density(document)
        print_forms(document, control, treated)
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
