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
import math
import sys
from math import comb

# The pairings `arm-pairing.ts` can build. One constant, held to that union by
# `test_the_pairing_vocabulary_is_the_arms_vocabulary`, because a closed set copied into a reader is a
# closed set that will fall out of step -- measured, not hypothesised: see this file's header.
PAIRINGS = ('reference', 'carry', 'clock', 'resolution', 'ask', 'units', 'reader', 'superseded')

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
    'ask': 'askPair',
    # `PREREG-TURN-FILL.md`'s instrument. The one flag whose control is a NAMED value (`turn`) rather than an
    # absent key, so the flag is doing more work here than anywhere above: `relevanceUnits=turn-fill` on the
    # artifact says the treatment ran, and only `unitsPair` says what it ran against.
    'units': 'unitsPair',
    # `PREREGISTRATION-MULTI-STEP.md` §3.2's instrument. `readerSearch: true` names the treatment; only this
    # flag says the control was the same system with the stage off, in the same job -- and it is what makes
    # the product's bill readable as one side's work (`censusSourcesOf` answers the feature instances).
    'reader': 'readerPair',
    # §18's `I6`. The same shape as `reader`'s, one axis over and with a named control: `supersededRendering`
    # is on every artifact (`off` on all of them so far), so only this flag says the delta compares one
    # rendering rather than two systems -- and without it an `I6` reading would be filed as a measurement of
    # the registered pair, which is the error `PAIR_FLAGS` exists to make impossible.
    'superseded': 'supersededPair',
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

# `G3`, the accuracy clause: `>= +1.5 points AND up-down >= +5`. Both halves are restated here for the
# reason every other criterion is, and the pair is why the criterion cannot be read from the point
# estimate alone -- `+1.5 points` on a population where forty questions moved both ways is a different
# claim from the same delta with six.
#
# Until this constant existed, `G3` was decided **by hand**. `44915923906`'s evidence file carries
# `{"G3": {"verdict": "pass", "reason": "+2.40 points >= +1.5 and up-down +12 >= +5"}}`, and so does
# the document that quotes it; the script that produced every other number in that table printed the
# delta line and stopped. Two criteria were reproducible and two were testimony, inside one table.
G3_POINT_FLOOR = 1.5
G3_UP_DOWN_FLOOR = 5

# The third `resolution` replication's own criteria, registered in
# `docs/PREREGISTRATION-RESOLUTION-REPLICATION.md` **before** that dispatch ran. They are here rather
# than in the document because the document is where they were argued and this is where they are
# evaluated: a criterion a human evaluates is a criterion that can be reported as passed by whoever
# wants it passed, which is the defect `G3` and `G5` were fixed for one round ago.
R3_BILL_CEILING_PCT = 1.0

# The price weights that turn a usage census into a ratio, as `(cache-miss input, cache-hit input,
# output)` in units of the cheapest term. DeepSeek's published schedule is 10:1:15 for
# `deepseek-chat`, and writing the *ratio* rather than the prices means this instrument cannot go
# stale when the schedule is repriced -- but it does mean the number it prints is a price index rather
# than a bill. The distinction is load-bearing: `R3`'s clause is a **token** ratio, and a mechanism
# that keeps the token count flat while moving prompt text out of the cache passes it while costing
# 1.55x. That is exactly what this dispatch did, which is why both readings print.
PRICE_UNITS = (10, 1, 15)


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
    """The four medians `F3` divides: turns and characters, per question, on both sides.

    `F3` is registered on **medians** -- "the same room carrying more turns" is a statement about a typical
    question, and a sum would let one enormous corpus decide the verdict. `C8`'s `G2` is registered on
    **totals** instead, and the two live in separate functions for that reason (see
    {@link delivered_totals}): one function returning both would invite a claim to be evaluated on the wrong
    one, which is the error this pair of functions exists to make impossible.

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


def delivered_totals(document: dict) -> tuple[int, int, int, int]:
    """The four **totals** `C8`'s `G2` divides: turns and characters, summed over the population.

    Registered as totals rather than medians because the claim is about the **bill**: reallocation pays if
    the population as a whole spends fewer characters for the same questions, and a median answers "what did
    a typical question spend", which a mechanism that compresses most long turns and widens a few can leave
    untouched while the total falls. `C7`'s `F3` is the opposite choice for the opposite reason, and having
    both here is not redundancy -- it is the two criteria being read on the quantity each was written on.

    Summed over **paired positions only**: a question whose baseline reported nothing is left out of both
    sides, because a total that counted one side's question and not the other's would make the ratio a
    statement about coverage rather than about characters.

    Integers, not floats: these are counts of UTF-16 units and of turns, and `_number` prints them as such.
    """
    ablation = document.get('ablation', {}) or {}
    rows = document.get('questions', []) or []
    baseline_censuses = ablation.get('baselineRoleCensuses') or []
    baseline_chars = ablation.get('baselinePromptChars') or []
    if not baseline_censuses or not baseline_chars:
        raise SystemExit(
            'refusing: no reallocation reading -- the artifact carries no baseline role census or no '
            "baseline prompt characters, so G2's two ratios would each have a side that does not exist."
        )
    turns_before = turns_after = 0
    for position, row in enumerate(rows):
        baseline_census = baseline_censuses[position] if position < len(baseline_censuses) else None
        feature_census = row.get('roleCensus')
        if not isinstance(baseline_census, dict) or not isinstance(feature_census, dict):
            continue
        turns_before += baseline_census['total']
        turns_after += feature_census['total']
    chars_before = chars_after = 0
    for position, row in enumerate(rows):
        baseline_length = baseline_chars[position] if position < len(baseline_chars) else None
        feature_length = row.get('promptChars')
        if baseline_length is None or feature_length is None:
            continue
        chars_before += baseline_length
        chars_after += feature_length
    return turns_before, turns_after, chars_before, chars_after


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


def criterion_verdicts(
    document: dict,
    control: dict[int, float],
    treated: dict[int, float],
    delta: float,
    population: int,
    discordant: tuple[int, int],
) -> list[dict[str, str]]:
    """`C8`'s five criteria, each as a verdict and the sentence that decided it.

    ## Why one list rather than five print calls

    The block this replaced printed `G1`, `G2` and `G4` and left `G3` and `G5` to whoever wrote the
    evidence file. That split was invisible until two artifacts were compared: `44915923906`'s
    `criteria` block carries a hand-written `G3: pass` and a hand-written `G5: fail`, and nothing in
    this repository could have caught either one being wrong. The two machine-judged criteria were
    reproducible and the two hand-judged ones were testimony, in one table that reads as one kind of
    thing.

    `G3` and `G5` are both decidable from the artifact: `G3` from the delta line this script already
    computes and `G5` from the paired token ratio the artifact already carries. So they are decided
    here, beside the three that were, and the printed block and the `--criteria-json` block are the
    **same** verdicts formatted twice rather than two implementations that agree until one is edited.

    ## Why the sentences are returned rather than printed

    Every message below is byte-identical to what this script printed before the change, including the
    two-space separator after `pass` and the colon after every other verdict. Keeping them as data lets
    the JSON reader emit the same words under `reason:` without a second expression of them; a caller
    that printed from here and serialized from somewhere else would be the defect this function exists
    to remove.

    ## The two informational lines

    `forms:` and `record share median:` are not criteria -- they are the counts the criteria divide,
    printed so a failing verdict can be read without a second command. They travel in the same list
    with an empty `ident`, which is what tells the printer to emit them as they are.
    """
    rows = document.get('questions', []) or []
    shares = record_shares(rows)
    verdicts: list[dict[str, str]] = []
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
    verdicts.append(
        {
            'ident': '',
            'verdict': '',
            'canonical': '',
            'text': (
                f'forms: {formed}/{len(rows)} questions rendered by a form '
                f'(record or excerpt on {compressed})  -- G1 floor {floor:.0f}'
            ),
        }
    )
    if compressed >= floor and floor > 0:
        verdicts.append(
            {
                'ident': 'G1',
                'verdict': 'pass',
                'canonical': 'pass',
                'text': f'{compressed} >= {floor:.0f} (the forms reached the population)',
            }
        )
    else:
        verdicts.append(
            {
                'ident': 'G1',
                'verdict': 'fail',
                'canonical': 'fail',
                'text': (
                    f'{compressed} of {len(rows)} questions had a compressed or widened turn, below '
                    f'the {G1_FORMED_SHARE:.0%} floor. Either `resolution` never reached the renderer '
                    'or it rendered every long turn as raw -- and neither is a reading of the mechanism'
                ),
            }
        )

    # Totals, because `G2` is registered on the bill: "characters leave while turns stay or rise" is a claim
    # about the population's spend, and a median can hold still while the total falls.
    turns_before, turns_after, chars_before, chars_after = delivered_totals(document)
    char_change = (chars_after - chars_before) / chars_before * 100 if chars_before else 0.0
    turn_change = (turns_after - turns_before) / turns_before * 100 if turns_before else 0.0
    if char_change <= -G2_CHAR_DROP_PCT and turn_change >= G2_TURN_RISE_PCT:
        verdicts.append(
            {
                'ident': 'G2',
                'verdict': 'pass',
                'canonical': 'pass',
                'text': (
                    f'chars {char_change:+.1f}% <= -{G2_CHAR_DROP_PCT:.0f}% with turns '
                    f'{turn_change:+.1f}% >= +{G2_TURN_RISE_PCT:.0f}% (the reallocation signature)'
                ),
            }
        )
    elif turn_change >= G2_TURN_RISE_PCT and char_change < 0:
        # The direction without the magnitude, which is a different finding from "the hypothesis is wrong"
        # and run `44915923906` produced it: characters fell 2.8% while turns rose 3.7%. A message that said
        # "the direction did not appear" over that would send the next round after the mechanism when the
        # mechanism did exactly what it claimed -- it just did 0.2 points less of it than the floor asked.
        verdicts.append(
            {
                'ident': 'G2',
                'verdict': 'fail on magnitude',
                'canonical': 'fail',
                'text': (
                    f'the direction appeared (chars {char_change:+.1f}% with turns '
                    f'{turn_change:+.1f}%), but characters fell less than the '
                    f'{G2_CHAR_DROP_PCT:.0f}% floor. The clause is the floor, not the direction, so '
                    'what closes is the size of the saving'
                ),
            }
        )
    else:
        verdicts.append(
            {
                'ident': 'G2',
                'verdict': 'fail',
                'canonical': 'fail',
                'text': (
                    f'chars {char_change:+.1f}% and turns {turn_change:+.1f}% do not show characters '
                    f'leaving while turns stay or rise (needs <= -{G2_CHAR_DROP_PCT:.0f}% and >= '
                    f'+{G2_TURN_RISE_PCT:.0f}%), so the direction C8 predicts did not appear'
                ),
            }
        )

    verdicts.append(_g3_verdict(delta, population, discordant))

    # The two empty states are different findings and were printed as one until run `44915923906` produced
    # the first of them: that run's mechanism shortened 3,710 turns, the product's accessor dropped the split,
    # and the reader said "no question improved" over a population where 27 had. A message that names the
    # wrong absence sends the next round after the mechanism instead of after the instrument.
    if not shares:
        verdicts.append(
            {
                'ident': 'G4',
                'verdict': 'unread',
                'canonical': 'unread',
                'text': (
                    'no question carries a form split, so there is no share to compare -- G1 already '
                    'says why, and the repair is the instrument rather than the mechanism'
                ),
            }
        )
    else:
        gainers = [at for at in shares if treated.get(at, 0.0) > control.get(at, 0.0)]
        if not gainers:
            verdicts.append(
                {
                    'ident': 'G4',
                    'verdict': 'not taken',
                    'canonical': 'not-taken',
                    'text': (
                        'no question improved on this population, so there is no gainer set to '
                        'compare a form share against -- and a ratio over an empty numerator is not '
                        'a reading'
                    ),
                }
            )
        else:
            gainer_median = _median([shares[at] for at in gainers])
            population_median = _median(list(shares.values()))
            # A zero denominator is not an infinite ratio. Before this guard the script printed `ratio inf`
            # and `G4 pass  gainers 0.000 are >= 1.5x the population 0.000` on a population where no question
            # compressed anything -- the criterion passing itself, which is the one failure mode a criterion
            # must not have. A median of zero means there is no share to compare, and `G1` has already said
            # why.
            if population_median <= 0:
                verdicts.append(
                    {
                        'ident': 'G4',
                        'verdict': 'unread',
                        'canonical': 'unread',
                        'text': (
                            'the population median record share is 0.000, so no question compressed a '
                            'turn and there is no ratio to take -- G1 already says why, and a zero '
                            'denominator is not an infinite effect'
                        ),
                    }
                )
            else:
                ratio = gainer_median / population_median
                verdicts.append(
                    {
                        'ident': '',
                        'verdict': '',
                        'canonical': '',
                        'text': (
                            f'record share median: gainers {gainer_median:.3f} (n={len(gainers)}) vs '
                            f'population {population_median:.3f} (n={len(shares)})  ratio {ratio:.2f}'
                        ),
                    }
                )
                if ratio >= G4_RECORD_RATIO:
                    verdicts.append(
                        {
                            'ident': 'G4',
                            'verdict': 'pass',
                            'canonical': 'pass',
                            'text': (
                                f'gainers {gainer_median:.3f} are >= {G4_RECORD_RATIO:.1f}x the '
                                f'population {population_median:.3f} (the gain is concentrated where '
                                'records dominate)'
                            ),
                        }
                    )
                else:
                    verdicts.append(
                        {
                            'ident': 'G4',
                            'verdict': 'fail',
                            'canonical': 'fail',
                            'text': (
                                f'gainers {gainer_median:.3f} are only {ratio:.2f}x the population '
                                f'{population_median:.3f}, below {G4_RECORD_RATIO:.1f}x -- the '
                                'mechanism helps, but not for the reason C8 claims'
                            ),
                        }
                    )

    verdicts.append(_g5_verdict(document))
    return verdicts


def _g3_verdict(delta: float, population: int, discordant: tuple[int, int]) -> dict[str, str]:
    """The accuracy clause, decided from the delta line the caller already printed.

    `G3` is `>= +1.5 points AND up-down >= +5`, and both halves come from the same two numbers the
    delta line states: the point estimate and the discordant pair. The verdict names no absolute count
    of correct answers, because that number is a property of the population and the criterion is not.

    ## Why this is not a second reading of the delta

    The point estimate appears once more below, and that is deliberate rather than tolerated: a pass
    or fail with no number beside it cannot be checked, and the alternative -- printing only
    `G3 pass` -- is the shape that let a hand-written verdict stand for four months. What is *not*
    duplicated is the arithmetic; `delta / population` is computed here from the same arguments the
    delta line was computed from, so the two cannot disagree about the input.
    """
    up = discordant[1]
    down = discordant[0]
    points = delta / population * 100 if population else 0.0
    if points >= G3_POINT_FLOOR and up - down >= G3_UP_DOWN_FLOOR:
        return {
            'ident': 'G3',
            'verdict': 'pass',
            'canonical': 'pass',
            'text': (
                f'the delta line above clears {G3_POINT_FLOOR:+.1f} points and the '
                f'{G3_UP_DOWN_FLOOR:+d} up-down floor (up-down {up - down:+d})'
            ),
        }
    return {
        'ident': 'G3',
        'verdict': 'fail',
        'canonical': 'fail',
        'text': (
            f'the delta line above gives {points:+.2f} points and up-down {up - down:+d}, against '
            f'{G3_POINT_FLOOR:+.1f} and {G3_UP_DOWN_FLOOR:+d}'
        ),
    }


def _g5_verdict(document: dict) -> dict[str, str]:
    """The bill clause, read off the paired prompt-token ratio the artifact carries.

    ## Why the ratio and not the absolute number

    `G5` is registered as `<= 7,416 prompt tokens per question`, and that number was written for a
    dispatch whose two sides were the reference pipeline and this one. A `resolution` pair runs **this
    system on both sides**, so the absolute value describes neither side's claim; what the clause is
    about -- "a mechanism whose other half is a cost has lost its reason when the bill rises" -- is the
    paired ratio, and that is what is read.

    An artifact with no paired token block is `unread`, not `pass`. The distinction matters here more
    than elsewhere: the two hand-written `G5` verdicts in `cortex-docs` both read `fail`, and a script
    that defaulted a missing block to `pass` would have agreed with them by accident.
    """
    tokens = document.get('tokens') or {}
    paired = tokens.get('prompt_per_answer') or {}
    delta_pct = paired.get('delta_pct')
    if not isinstance(delta_pct, (int, float)):
        return {
            'ident': 'G5',
            'verdict': 'unread',
            'canonical': 'unread',
            'text': (
                'the artifact carries no paired prompt-token ratio, so the bill half of the clause '
                'has no reading -- and the absolute threshold belongs to the reference arm'
            ),
        }
    if delta_pct <= 0:
        return {
            'ident': 'G5',
            'verdict': 'pass',
            'canonical': 'pass',
            # `abs` rather than the signed value: "the bill fell -1.20%" is a double negative that reads
            # as an increase to anyone skimming, and this is the one line where the sign is already
            # carried by the verb.
            'text': f'the paired bill fell {abs(delta_pct):.2f}%',
        }
    return {
        'ident': 'G5',
        'verdict': 'fail',
        'canonical': 'fail',
        'text': (
            f'the paired bill rose {delta_pct:.2f}%; the absolute threshold belongs to the '
            'reference arm'
        ),
    }


def print_forms(
    document: dict,
    control: dict[int, float],
    treated: dict[int, float],
    delta: float,
    population: int,
    discordant: tuple[int, int],
) -> None:
    """Print `C8`'s five criteria, in id order, in the words the three old ones have always printed in.

    The separator is the one observable difference between a pass and everything else: `G1 pass  ...`
    with two spaces, `G1 fail: ...` with a colon. That asymmetry predates this function and is kept
    because two archived evidence files quote the text, so moving it would put this script's output and
    the documents that cite it one punctuation mark apart for no gain.

    `G1`, `G2`, `G4` print byte for byte what they printed before `G3` and `G5` were decided here. The
    two new lines take their id's position instead of being appended at the end -- `G3` between `G2` and
    `G4`, `G5` last -- because a block that read `G1 G2 G4 G5 G3` would put the accuracy clause after the
    bill, which is the order the evidence tables have been written in and not the order the criteria are
    numbered in.
    """
    for verdict in criterion_verdicts(document, control, treated, delta, population, discordant):
        if verdict['ident'] == '':
            print(verdict['text'])
        else:
            separator = '  ' if verdict['verdict'] == 'pass' else ': '
            print(f"{verdict['ident']} {verdict['verdict']}{separator}{verdict['text']}")


def criterion_report(
    document: dict,
    control: dict[int, float],
    treated: dict[int, float],
    delta: float,
    population: int,
    discordant: tuple[int, int],
) -> dict[str, dict[str, str]]:
    """The same verdicts, keyed by criterion id, for a caller that wants them as data.

    `verdict` is the canonical three-state -- `pass`, `fail`, `unread` -- plus `not-taken` for the one
    state `G4` can be in when the population offers no gainer at all. The qualifier a criterion carries
    in its printed form (`G2 fail on magnitude`) is deliberately **not** folded into this field: a
    consumer filtering on `verdict == 'fail'` must see the magnitude case, because the mechanism worked
    and the floor was not reached, and a fourth enum value would let that distinction escape into the
    prose again.
    """
    report: dict[str, dict[str, str]] = {}
    for verdict in criterion_verdicts(document, control, treated, delta, population, discordant):
        if verdict['ident'] == '':
            continue
        report[verdict['ident']] = {'verdict': verdict['canonical'], 'reason': verdict['text']}
    return report


def bill_readings(document: dict) -> dict | None:
    """The paired bill, as a token ratio and as a price index, or `None` when neither is readable.

    ## Why two numbers and not one

    `R3`'s clause -- registered before the dispatch -- is `prompt_per_answer.delta_pct <= +1.0`, a
    **token** ratio. Run `45543010618` passed it at `+0.08%` and would have cost **1.55x** in money:
    the mechanism moves prompt text out of the provider's prefix cache, so the token count stays flat
    while the share billed at the cache-miss rate goes from 3% to 29%. An instrument that prints only
    the ratio it was asked for would have reported this mechanism as free.

    So both are computed from the same census and printed together. The price index uses
    `PRICE_UNITS`, a ratio rather than a schedule, so a repricing does not make this file wrong; what
    it does mean is that the index is a proportion and the token ratio is still the registered clause.

    ## Where the census comes from

    `usageBySide` is on every artifact, single-dispatch or merged -- `tools/merge-ablation.mjs` sums
    it, because a sum of tokens is a sum of tokens. `tokens.prompt_per_answer` is only written by the
    unsharded arm, which is why `G5` reads `unread` on every real dispatch: `S12`'s registered shape
    is 500 questions split across jobs, and the merge deliberately does not recompute a field it
    cannot recompute honestly. Falling back to the census is not a second statistic -- a ratio of two
    sums over the same number of answers is one division -- and the provenance is printed so a reader
    knows which of the two they are holding.
    """
    usage = document.get('usageBySide') or {}
    baseline = usage.get('baseline') or {}
    feature = usage.get('feature') or {}
    recorded = ((document.get('tokens') or {}).get('prompt_per_answer') or {}).get('delta_pct')
    if baseline.get('calls') and feature.get('calls'):
        per_answer = (feature.get('promptTokens', 0) / feature['calls']) / (
            baseline.get('promptTokens', 0) / baseline['calls']
        )
        miss = (max(0, baseline.get('promptTokens', 0) - baseline.get('cacheHitPromptTokens', 0)),
                max(0, feature.get('promptTokens', 0) - feature.get('cacheHitPromptTokens', 0)))
        hit = (baseline.get('cacheHitPromptTokens', 0), feature.get('cacheHitPromptTokens', 0))
        out = (baseline.get('completionTokens', 0), feature.get('completionTokens', 0))
        weights = PRICE_UNITS
        priced = [
            miss[side] * weights[0] + hit[side] * weights[1] + out[side] * weights[2]
            for side in (0, 1)
        ]
        return {
            'source': 'usageBySide',
            'perAnswerPct': (per_answer - 1) * 100,
            'priceRatio': (priced[1] / priced[0]) if priced[0] else None,
            'miss': miss,
            'hit': hit,
            'out': out,
            'recordedPct': recorded,
        }
    if recorded is not None:
        # A single-dispatch artifact states the ratio itself; the census may still be there for the
        # price index, and when it is not, only the ratio is readable.
        return {'source': 'tokens.prompt_per_answer', 'perAnswerPct': recorded, 'priceRatio': None}
    return None


def fisher_combine(first: float, second: float) -> float:
    """Two independent p-values as one, by Fisher's method, with the df-4 closed form.

    `chi2 = -2 (ln p1 + ln p2)` on four degrees of freedom, and `P(X > x) = e^(-x/2) (1 + x/2)` for
    that df -- exact, so no gamma function and no dependency for one formula.

    ## What this assumes, said out loud

    Fisher's method assumes the two tests are independent. These two are not: they are the same 500
    questions answered twice. Under a true null two positively correlated p-values combine to
    something the method *undercounts*, so the number below is optimistic and the honest reading of a
    combined `0.0452` is "clears the registered rule", not "the effect is established". The
    preregistration chose the combination before the data existed, and the caveat is printed with the
    verdict rather than filed here.
    """
    floor = 1e-12
    values = [max(floor, value) for value in (first, second)]
    chi2 = -2 * sum(math.log(value) for value in values)
    return math.exp(-chi2 / 2) * (1 + chi2 / 2)


def print_resolution_criteria(
    document: dict,
    discordant: tuple[int, int],
    capability: str,
    capability_discordant: tuple[int, int] | None,
    prior: tuple[int, int] | None,
    prior_name: str | None,
) -> list[dict[str, str]]:
    """`R1`-`R4`, the four criteria registered before the third replication was dispatched.

    Printed for a `resolution` dispatch and only for one: `G1`-`G5` belong to `C8` (the carry arm) and
    are what the resolution arm's rendering hypothesis is tested *with*, not what it is accepted by.
    Putting the two blocks in one output is deliberate -- they answer different questions about one
    population, and a reader who sees `G4 fail` beside `R4 fired` is seeing the truth rather than a
    contradiction: the mechanism works, and not through the record share `C8` predicted.

    `R2` needs the earlier dispatch's discordant pair, which this file cannot know; it is passed on
    the command line so the provenance of the combination is in the log that quotes the result
    (`--prior-discordant 15,27 --prior-name 44915923906`). `R2` prints `unread` when it is absent,
    because a combination nobody named is a number attributed to a run it did not come from.
    """
    down, up = discordant
    verdicts: list[dict[str, str]] = []

    if capability_discordant is None:
        # An artifact whose question rows carry no capability cannot answer `R1`, and an up-down of
        # zero computed over an empty subset is the reading a mechanism that moved nothing produces.
        # `unread` is the third state, and it is the honest one.
        verdicts.append(
            {
                'ident': 'R1',
                'verdict': 'unread',
                'text': (
                    f'the population carries no capability on its question rows, so the {capability} '
                    'up-down has no reading; --capability names the arm whose replication this is, '
                    'and an untagged population cannot say whether it moved'
                ),
            }
        )
    else:
        cap_down, cap_up = capability_discordant
        verdicts.append(
            {
                'ident': 'R1',
                'verdict': 'pass' if cap_up - cap_down > 0 else 'fail',
                'text': (
                    f'the {capability} up-down is {cap_up - cap_down:+d} (b={cap_down} c={cap_up}), so '
                    'the sign replicated'
                    if cap_up - cap_down > 0
                    else f'the {capability} up-down is {cap_up - cap_down:+d} (b={cap_down} '
                    f'c={cap_up}), so this replication points the other way and the axis retires'
                ),
            }
        )

    own = mcnemar_exact(down, up)
    if prior is None:
        verdicts.append(
            {
                'ident': 'R2',
                'verdict': 'unread',
                'text': (
                    f'this population alone gives p={own:.4f}, and `R2` is a combination with an '
                    'earlier dispatch that was not named on the command line (--prior-discordant '
                    'b,c), so the clause has no reading'
                ),
            }
        )
        combined = None
    else:
        earlier = mcnemar_exact(prior[0], prior[1])
        combined = fisher_combine(own, earlier)
        verdicts.append(
            {
                'ident': 'R2',
                'verdict': 'pass' if combined < 0.05 else 'fail',
                'text': (
                    f'Fisher with {prior_name or "the earlier dispatch"}: p={combined:.4f} from '
                    f'{own:.4f} and {earlier:.4f}, on the independence assumption this method makes '
                    'and two overlapping question sets do not'
                ),
            }
        )

    bill = bill_readings(document)
    if bill is None:
        verdicts.append(
            {
                'ident': 'R3',
                'verdict': 'unread',
                'text': (
                    'the artifact carries neither a `tokens.prompt_per_answer` block nor a '
                    '`usageBySide` census, so the bill half of the clause has no reading'
                ),
            }
        )
        bill_ok = None
    else:
        bill_ok = bill['perAnswerPct'] <= R3_BILL_CEILING_PCT
        verdicts.append(
            {
                'ident': 'R3',
                'verdict': 'pass' if bill_ok else 'fail',
                'text': (
                    f'the paired prompt bill moved {bill["perAnswerPct"]:+.2f}% of '
                    f'{R3_BILL_CEILING_PCT:+.2f}% allowed [{bill["source"]}]'
                ),
            }
        )

    # A conjunction with one false conjunct is false, whether or not the other has been read. Reporting
    # `unread` for a clause that `R3` has already refused would send the next round after the missing
    # number instead of after the mechanism, which is the wrong absence named -- the defect `G4`'s two
    # empty states were split for.
    if (combined is not None and combined >= 0.05) or bill_ok is False:
        verdicts.append(
            {
                'ident': 'R4',
                'verdict': 'not-taken',
                'text': '`R2` or `R3` did not clear, so the mechanism is recorded as tested and not adopted',
            }
        )
    elif combined is None or bill_ok is None:
        verdicts.append(
            {
                'ident': 'R4',
                'verdict': 'unread',
                'text': 'R4 is `R2` and `R3`, and one of them has no reading',
            }
        )
    else:
        extra = ''
        if bill and bill.get('priceRatio') and bill['priceRatio'] > 1.1:
            # The registered clause does not cover this, and saying so is the point: a rule that was
            # written before the data does not get to be quietly widened after it, and it also does
            # not get to be quoted as "free".
            extra = (
                f' -- but the cache-adjusted price is {bill["priceRatio"]:.2f}x the baseline '
                f'(miss {bill["miss"][1]:,} against {bill["miss"][0]:,} tokens), which the registered '
                'clause is a token ratio and does not see'
            )
        verdicts.append(
            {
                'ident': 'R4',
                'verdict': 'fired',
                'text': '`R2` and `R3` both cleared, so the registered rule accepts the mechanism' + extra,
            }
        )
    for entry in verdicts:
        separator = '  ' if entry['verdict'] in ('pass', 'fired') else ': '
        print(f'{entry["ident"]} {entry["verdict"]}{separator}{entry["text"]}')
    # Returned as well as printed, so the evidence file a round archives is this function's output
    # rather than a transcription of it. The `G` block has worked that way since `criterion_report`;
    # the replication's four criteria are the ones a decision is actually argued from, so they are the
    # ones that most need to be reproducible.
    return verdicts


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
    options = {
        '--windows': None,
        '--pairing': 'reference',
        '--criteria-json': '0',
        '--prior-discordant': None,
        '--prior-name': None,
        '--capability': 'MR',
    }
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
    prior: tuple[int, int] | None = None
    if options['--prior-discordant'] is not None:
        raw_prior = options['--prior-discordant'].split(',')
        if len(raw_prior) != 2 or not all(part.strip().isdigit() for part in raw_prior):
            raise SystemExit(
                f'refusing: --prior-discordant {options["--prior-discordant"]!r} is not two whole '
                'numbers `b,c`. A combination against a pair this reader cannot parse is a p-value '
                'attributed to a run it did not come from.'
            )
        prior = (int(raw_prior[0]), int(raw_prior[1]))
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
        print_forms(document, control, treated, delta, len(scope), (b, c))
        # The replication's own criteria, after `C8`'s. Different question about one population: `G1`-`G5`
        # say whether the mechanism worked the way `C8` predicted, `R1`-`R4` say whether it is adopted.
        capability = options['--capability']
        rows = document['questions']
        tagged = any('capability' in row for row in rows)
        cap_scope = [at for at in scope if rows[at].get('capability') == capability]
        if tagged and not cap_scope:
            raise SystemExit(
                f'refusing: --capability {capability!r} matches no question in this population, so '
                '`R1` would be read off an empty subset and printed as an up-down of zero -- which is '
                'what a mechanism that moved nothing and a flag that names nothing look like.'
            )
        replication = print_resolution_criteria(
            document,
            (b, c),
            capability,
            None
            if not tagged
            else (
                sum(1 for at in cap_scope if control[at] > treated[at]),
                sum(1 for at in cap_scope if treated[at] > control[at]),
            ),
            prior,
            options['--prior-name'],
        )
        # The same five verdicts as data, for a caller that writes the evidence file rather than reading
        # the log. `1` rather than a flag with no value because this parser's whole contract is
        # `--name value`, and a second parsing style for one option is the shape that made `--alpha` in
        # `paired-test.mjs` documented and unreachable for a round.
        if options['--criteria-json'] == '1':
            print(
                json.dumps(
                    {
                        'criteria': criterion_report(
                            document, control, treated, delta, len(scope), (b, c)
                        ),
                        'replication': {entry['ident']: entry for entry in replication},
                        'bill': bill_readings(document),
                    },
                    indent=1,
                    sort_keys=True,
                )
            )
    return 0


if __name__ == '__main__':
    raise SystemExit(main(sys.argv[1:]))
